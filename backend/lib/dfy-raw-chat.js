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
import { createTurnCollector, NodeApiClient, discoverDshLaunchToken } from '../../src/dsh-client.js';
import { discoverDshBaseUrl, probeDshBaseUrl } from '../../src/dsh-port.js';
import { effectiveQqConfigFile } from '../../src/config-locate.js';
import { STATE_DIR } from './paths.js';
import { readUnified } from './store.js';

const REPLY_TIMEOUT_MS = 180_000;

export function createRawChat({ ctx, log = () => {} } = {}) {
  const SESSION_ID = 'dfy-astrbot';
  /** sessionId -> Set<{collector, resolve, reject, timer}> */
  const pending = new Map();
  /** 会话级串行锁：同一会话并发灌消息会互相抢 turn，排队逐条来 */
  const locks = new Map();
  let subscribed = false;
  /** 桥接同款的 DSH Web API 客户端：prompt 走 HTTP（进程内调用的事件序列化有坑） */
  let apiClient = null;
  /** qq config 里的 dsh.baseUrl 常是旧实例的残值：探测优先，连不上再发现，兜底 3080。 */
  async function resolveBaseUrl(dsh) {
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
  function ask(text, { timeoutMs = REPLY_TIMEOUT_MS } = {}) {
    const prev = locks.get(SESSION_ID) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => doAsk(text, timeoutMs));
    locks.set(SESSION_ID, run);
    return run;
  }

  /** 会话存在性：inspect 不到就建（带 qq-chat 预设 = 鱼的人设来源）。 */
  async function ensureSession() {
    try {
      await ctx.sessionController.inspect(SESSION_ID);
      return true;
    } catch { /* 不存在，走创建 */ }
    try {
      const cwd = path.join(STATE_DIR, 'dfy-astrbot');
      fs.mkdirSync(cwd, { recursive: true });
      await ctx.sessionController.create({ sessionId: SESSION_ID, cwd, agentPreset: 'qq-chat' });
      log(`[raw-chat] 会话 ${SESSION_ID} 已创建（preset qq-chat）`);
      // 新会话没有模型会被 prompt rejected：把 DSH 全局模型设给它（HTTP RPC）
      try {
        const m = readUnified().config.model ?? {};
        if (m.provider && m.model) {
          await api().callUnary('session/selectModel', { sessionId: SESSION_ID, provider: m.provider, model: m.model });
          log(`[raw-chat] 已设模型 ${m.provider}/${m.model}`);
        }
      } catch (error) {
        log('[raw-chat] 设模型失败：', String(error?.message ?? error).slice(0, 160));
      }
      return true;
    } catch (error) {
      log('[raw-chat] 建会话失败：', String(error?.message ?? error));
      return false;
    }
  }

  async function doAsk(text, timeoutMs) {
    ensureSubscribed();
    await ensureSession();
    const content = String(text ?? '').trim();
    if (!content) throw new Error('消息为空');
    const collector = createTurnCollector();
    const w = {
      sessionId: SESSION_ID,
      collector,
      resolve: () => {},
      reject: () => {},
      timer: null,
    };
    const promise = new Promise((resolve, reject) => {
      w.resolve = resolve;
      w.reject = reject;
    });
    if (!pending.has(SESSION_ID)) pending.set(SESSION_ID, new Set());
    pending.get(SESSION_ID).add(w);
    w.timer = setTimeout(() => {
      settle(w, { ok: false, error: `等回复超时（${Math.round(timeoutMs / 1000)}s）：她可能在忙别的回合` });
    }, timeoutMs);
    try {
      // prompt 走桥接同款 HTTP RPC（进程内直调会让 inbox 事件带上不可序列化对象，session 落盘直接抛错）
      await api().sessions.prompt({ sessionId: SESSION_ID, mode: 'queue', content: [{ type: 'text', text: content }] });
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

  return { ask, lastUserText, SESSION_ID };
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
