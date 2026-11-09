/**
 * 路线 B 路口：把 DSH 会话暴露成 OpenAI 兼容的对话端点。
 *
 * AstrBot 用「OpenAI API 兼容」provider 指到这里（api_base=http://127.0.0.1:3080/dsh-surfcore/v1），
 * 它组装好人格/记忆后把消息发过来，我们灌进 DSH 会话，鱼的回复以 OpenAI 格式返回——
 * 对话在 DSH 会话里全程可见（思考过程、模型、上下文都在 DSH 调），AstrBot 只管接入和插件。
 *
 * 会话策略（v1）：AstrBot 侧的对话统一进专用会话 `dfy-astrbot`（宿主缺省自动创建），
 * 一条连续的记忆线。v1 只传最终用户消息，人设/记忆由该会话的 agent preset 承载；
 * 桥接时代的逐条记忆块注入后续按需补回。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTurnCollector, NodeApiClient, discoverDshLaunchToken } from '../../src/dsh-client.js';
import { discoverDshBaseUrl, probeDshBaseUrl } from '../../src/dsh-port.js';
import { effectiveQqConfigFile } from '../../src/config-locate.js';
import { STATE_DIR } from './paths.js';
import { readUnified } from './store.js';

const REPLY_TIMEOUT_MS = 180_000;

export function createRawChat({ ctx, log = () => {}, resolveModel = null } = {}) {
  // 默认会话（无会话身份时的兜底，例如设置页自测）。有身份时按身份派生独立会话，
  // 不再把所有 QQ 对话挤进同一个窗口。
  const BASE_SESSION_ID = 'dfy-astrbot';

  /** 会话身份 → DSH sessionId。空身份 = 默认会话。 */
  function sessionIdFor(key) {
    const raw = String(key ?? '').trim();
    if (!raw) return BASE_SESSION_ID;
    // 身份可能含 QQ 号/群号/平台 ID：只取哈希，避免把账号写进 sessionId（侧栏可见）。
    return `${BASE_SESSION_ID}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10)}`;
  }
  /** DSH 插件服务：ctx.sessionController 不是属性，必须走 ctx.get(name)（2026-11 实测）。 */
  function service(name) {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
    } catch { return undefined; }
  }
  /** 每个会话最近一次成功写入的模型（Map: sessionId → key），避免每条消息都打日志。 */
  const appliedModelBySession = new Map();
  /** sessionController 的 Remote 方法签名是 (request, signal)，缺 signal 会 TypeError。 */
  const CONTROLLER_SIGNAL = new AbortController().signal;
  /** sessionId -> Set<{collector, resolve, reject, timer}> */
  const pending = new Map();
  /** 会话级串行锁：同一会话并发灌消息会互相抢 turn，排队逐条来 */
  const locks = new Map();
  let subscribed = false;
  /** 桥接同款的 DSH Web API 客户端：prompt 走 HTTP（进程内调用的事件序列化有坑） */
  let apiClient = null;
  /** 当前 DSH 的 web 服务地址（插件自己就挂在这个服务里，最可靠，不靠端口猜测）。 */
  function localBaseUrl() {
    try {
      const ws = typeof ctx?.get === 'function' ? ctx.get('webServer') : null;
      if (ws?.port) return `${ws.protocol || 'http:'}//127.0.0.1:${ws.port}`;
    } catch { /* 忽略 */ }
    return '';
  }

  /** qq config 里的 dsh.baseUrl 常是旧实例的残值：先信插件自己的 webServer，再探测，兜底 3080。 */
  async function resolveBaseUrl(dsh) {
    // 2026-11 实测坑：qq config 里 dsh.baseUrl=http://127.0.0.1:8326，那是本机另一个
    // OpenAI 网关（也回 401），probeDshBaseUrl 把 401 当成「DSH 在」→ 选错地址 →
    // session/prompt 全部 401。插件自己就在 DSH 的 webServer 里，直接用它。
    const local = localBaseUrl();
    if (local) return local;
    const stored = String(dsh.baseUrl ?? '');
    if (stored && await probeDshBaseUrl(stored)) return stored;
    if (await probeDshBaseUrl('http://127.0.0.1:3080')) return 'http://127.0.0.1:3080';
    return (await discoverDshBaseUrl()) || stored || 'http://127.0.0.1:3080';
  }
  async function api() {
    if (apiClient) return apiClient;
    let dsh = {};
    try {
      dsh = JSON.parse(fs.readFileSync(effectiveQqConfigFile(), 'utf8').replace(/^\uFEFF/, '')).dsh ?? {};
    } catch { /* 配置读不到就靠 token 发现兜底 */ }
    const baseUrl = await resolveBaseUrl(dsh);
    apiClient = new NodeApiClient(baseUrl, undefined, {
      token: dsh.authToken || discoverDshLaunchToken(),
      tokenExplicit: dsh.authTokenExplicit === true,
      header: dsh.authHeader,
      prefix: dsh.authPrefix,
      allowRemote: dsh.allowRemote === true,
    });
    log(`[raw-chat] DSH API：${baseUrl}`);
    return apiClient;
  }

  function ensureSubscribed() {
    if (subscribed || typeof ctx.on !== 'function') return;
    subscribed = true;
    ctx.on('session/event', (session, event) => {
      try {
        const sid = String(session?.id ?? session ?? '');
        const waiters = pending.get(sid);
        if (!waiters?.size) return;
        for (const w of waiters) {
          const done = w.collector.push(event);
          if (done && typeof done?.text === 'string') {
            settle(w, { ok: true, text: done.text });
          }
        }
      } catch (error) {
        log('[raw-chat] 事件处理失败：', String(error?.message ?? error));
      }
    });
  }

  function settle(w, result) {
    const waiters = pending.get(w.sessionId);
    if (waiters) {
      waiters.delete(w);
      if (!waiters.size) pending.delete(w.sessionId);
    }
    if (w.timer) clearTimeout(w.timer);
    if (result.ok) w.resolve(String(result.text ?? '').trim());
    else w.reject(new Error(result.error ?? '回复失败'));
  }

  /** 灌一条消息进会话，等这条 turn 的最终回复文本（同会话串行）。 */
  function ask(text, { key = '', timeoutMs = REPLY_TIMEOUT_MS } = {}) {
    const sessionId = sessionIdFor(key);
    const prev = locks.get(sessionId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => doAsk(text, timeoutMs, sessionId));
    locks.set(sessionId, run);
    return run;
  }

  /**
   * 会话模型：**跟 DSH 当前默认模型走**，不是 dsh-Dfy 自己那份全局模型选择。
   *
   * 2026-11 实测原因：以前用 readUnified().config.model（zipu/glm-5.3-flash）给会话设模型，
   * 而用户主会话用的是 deepseek-account/deepseek-flash —— 于是 QQ 里那条鱼听起来
   * 「不像 DSH 里的她」。resolveModel() 由 index.js 注入（读 agentDefaultModel）。
   */
  async function applySessionModel(controller, sessionId) {
    try {
      const preferred = (() => { try { return resolveModel?.() ?? null; } catch { return null; } })();
      const fallback = readUnified().config.model ?? {};
      const provider = String(preferred?.provider ?? fallback.provider ?? '');
      const model = String(preferred?.model ?? fallback.model ?? '');
      if (!provider || !model) return;
      const effort = String(preferred?.reasoningEffort ?? fallback.reasoningEffort ?? '');
      const key = `${provider}/${model}${effort ? `@${effort}` : ''}`;
      if (appliedModelBySession.get(sessionId) === key) return;
      const payload = { sessionId, provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
      if (controller && typeof controller.selectModel === 'function') {
        await controller.selectModel(payload);
      } else {
        const client = await api();
        await client.callUnary('session/selectModel', payload);
      }
      appliedModelBySession.set(sessionId, key);
      log(`[raw-chat] 会话模型 → ${key}（${sessionId}，跟 DSH 默认模型）`);
    } catch (error) {
      log('[raw-chat] 设模型失败：', String(error?.message ?? error).slice(0, 160));
    }
  }

  /**
   * 会话存在性：用 sessionController 的 state/create（正确方法）。
   *
   * 2026-11 实测坑：以前写 `ctx.sessionController.inspect(...)` —— ctx 上根本没有这个属性，
   * 于是每条消息都走 create() 建出**一个空的随机会话**（侧栏里堆了一串 blank 会话），
   * 而真正的 dfy-astrbot 会话要靠 HTTP prompt 才被建出来。现在：
   *   · controller.state 探盘上会话；没有才 create（带 qq-chat 预设 = 鱼的人设来源）；
   *   · 不依赖 inspect（Remote 没暴露它）。
   */
  async function ensureSession(sessionId = BASE_SESSION_ID) {
    const controller = service('sessionController');
    if (controller && typeof controller.state === 'function' && typeof controller.create === 'function') {
      try {
        await controller.state({ sessionId });
      } catch {
        const cwd = sessionId === BASE_SESSION_ID
          ? path.join(STATE_DIR, BASE_SESSION_ID)
          : path.join(STATE_DIR, BASE_SESSION_ID, sessionId.slice(BASE_SESSION_ID.length + 1));
        try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* 目录失败不影响会话 */ }
        try {
          await controller.create({ sessionId, cwd, agentPreset: 'qq-chat' });
          log(`[raw-chat] 会话 ${sessionId} 已创建（preset qq-chat）`);
        } catch (error) {
          // 已存在但 state 读不到：再探一次，仍然不行才报错。
          try { await controller.state({ sessionId }); }
          catch { log('[raw-chat] 建会话失败：', String(error?.message ?? error)); return false; }
        }
      }
      await applySessionModel(controller, sessionId);
      return true;
    }
    // 兜底：老版本 DSH 没有 sessionController 时，只能靠 HTTP RPC 设模型。
    await applySessionModel(null, sessionId);
    return true;
  }

  async function doAsk(text, timeoutMs, sessionId = BASE_SESSION_ID) {
    ensureSubscribed();
    await ensureSession(sessionId);
    const content = String(text ?? '').trim();
    if (!content) throw new Error('消息为空');
    const collector = createTurnCollector();
    const w = {
      sessionId,
      collector,
      resolve: () => {},
      reject: () => {},
      timer: null,
    };
    const promise = new Promise((resolve, reject) => {
      w.resolve = resolve;
      w.reject = reject;
    });
    if (!pending.has(sessionId)) pending.set(sessionId, new Set());
    pending.get(sessionId).add(w);
    w.timer = setTimeout(() => {
      settle(w, { ok: false, error: `等回复超时（${Math.round(timeoutMs / 1000)}s）：她可能在忙别的回合` });
    }, timeoutMs);
    try {
      // prompt 走桥接同款 HTTP RPC（进程内直调会让 inbox 事件带上不可序列化对象，session 落盘直接抛错）
      // api() 是 async：先 await 拿到客户端，再取 .sessions（漏 await 会报
      // "Cannot read properties of undefined (reading 'prompt')"）。
      const client = await api();
      await client.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: content }] });
    } catch (error) {
      const reason = String(error?.details?.reason ?? error?.message ?? error);
      settle(w, { ok: false, error: `灌消息失败：${reason.slice(0, 260)}` });
    }
    const reply = await promise;
    return reply;
  }

  /** OpenAI 兼容解析：取最后一条用户消息的纯文本。 */
  function lastUserText(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m || m.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        const text = m.content
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n');
        if (text.trim()) return text;
      }
    }
    return '';
  }

  return { ask, lastUserText, sessionIdFor, BASE_SESSION_ID };
}

/** 组 OpenAI 非流式响应。 */
export function openAiCompletion(id, model, content) {
  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 组 OpenAI 流式响应（单块 delta + DONE）。 */
export function openAiStreamChunks(id, model, content) {
  const base = { id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const chunk = (delta, finish = null) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    `data: ${JSON.stringify(chunk({ role: 'assistant' }))}\n\n`,
    `data: ${JSON.stringify(chunk({ content }))}\n\n`,
    `data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`,
    'data: [DONE]\n\n',
  ];
}
