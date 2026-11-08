/**
 * QQ 桥接插件 → DSH 会话（「两边都要」方案的一半）。
 *
 * 为什么不用「OpenAI provider」那条路：OpenAI 兼容协议只传 messages，**没有
 * 「这条消息来自哪个 QQ 会话」的身份**，所以只能把所有 QQ 对话塞进一个固定会话。
 * 而 AstrBot 的插件能拿到 `unified_msg_origin`（platform:消息类型:号码/群号），
 * 于是换一条路：AstrBot 里装一个插件，把 (umo, 文本) POST 到这里，
 * 这里**按 QQ 会话建/复用 DSH 会话**，回复再交回 AstrBot 发送。
 *
 * 这样：
 *   · DSH 里每段对话一个真实会话（侧栏可见、可切模型、能看思考/上下文）；
 *   · AstrBot 的插件链仍然生效（消息先过 AstrBot）。
 *
 * 会话命名：`qq-private-1913962426` / `qq-group-123456`，工作目录 `<state>/agents`
 * （和旧桥一致，侧栏里就是熟悉的 agents 工作区）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, createTurnCollector, discoverDshLaunchToken } from '../../src/dsh-client.js';
import { STATE_DIR } from './paths.js';

const DEFAULT_TIMEOUT_MS = 180_000;
const PREFERRED_PRESETS = ['qq-chat', 'qq-chat-v2'];
/** 并发上限：群里被刷屏时不要同时开一堆模型回合（安全审查 M4）。 */
const MAX_CONCURRENT = 3;
const MAX_QUEUE = 20;

/** umo / 各种 key 写法 → `private:<id>` / `group:<id>`。 */
export function normalizeQqKey(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const umo = /^([^:]+):(FriendMessage|GroupMessage):(.+)$/i.exec(value);
  if (umo) {
    const id = umo[3].trim();
    return umo[2].toLowerCase().startsWith('group') ? `group:${id}` : `private:${id}`;
  }
  if (/^(private|group):/i.test(value)) {
    const [kind, ...rest] = value.split(':');
    const id = rest.join(':').trim();
    return id ? `${kind.toLowerCase()}:${id}` : '';
  }
  // 裸号码当私聊（兼容旧桥的 key 形状）
  if (/^\d{5,15}$/.test(value)) return `private:${value}`;
  // 设置页自测等本机用途：任意短标识 → local:<标识>，会得到一个独立的 DSH 会话
  if (/^[a-z0-9][a-z0-9_-]{1,40}$/i.test(value)) return `local:${value.toLowerCase()}`;
  return '';
}

export function sessionIdForKey(key) {
  return `qq-${String(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

export function createQqBridgeChat({ ctx, log = () => {}, getBaseUrl, resolveModel = null } = {}) {
  /** sessionId -> Set<waiter> */
  const pending = new Map();
  /** sessionId -> Promise（同会话串行） */
  const locks = new Map();
  /** 已经处理过「建会话 + 设模型」的会话（进程内） */
  const ready = new Map();
  let subscribed = false;
  // 简单信号量：running 与排队队列；超队列直接拒绝，避免把 DSH 打满
  let running = 0;
  const queue = [];
  async function acquireSlot() {
    if (running < MAX_CONCURRENT) { running += 1; return; }
    if (queue.length >= MAX_QUEUE) throw new Error('消息太多，她忙不过来：稍后再试');
    await new Promise((resolve) => queue.push(resolve));
    running += 1;
  }
  function releaseSlot() {
    running -= 1;
    const next = queue.shift();
    if (next) next();
  }
  let apiClient = null;
  let apiBase = '';

  function service(name) {
    try { return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]; } catch { return undefined; }
  }

  async function api() {
    const base = String(getBaseUrl?.() ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('DSH 地址还没就绪（webServer 端口未起来）');
    if (apiClient && apiBase === base) return apiClient;
    apiBase = base;
    apiClient = new NodeApiClient(base, undefined, { token: discoverDshLaunchToken() });
    return apiClient;
  }

  function ensureSubscribed() {
    if (subscribed || typeof ctx?.on !== 'function') return;
    subscribed = true;
    ctx.on('session/event', (session, event) => {
      try {
        const sid = String(session?.id ?? session ?? '');
        const waiters = pending.get(sid);
        if (!waiters?.size) return;
        for (const waiter of waiters) {
          const done = waiter.collector.push(event);
          if (done && typeof done?.text === 'string') settle(waiter, done.text);
        }
      } catch (error) {
        log('[qq-bridge] 事件处理失败：', String(error?.message ?? error));
      }
    });
  }

  function settle(waiter, text) {
    const waiters = pending.get(waiter.sessionId);
    if (waiters) {
      waiters.delete(waiter);
      if (!waiters.size) pending.delete(waiter.sessionId);
    }
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(String(text ?? '').trim());
  }

  async function createSessionWithController(controller, sessionId, cwd) {
    // 会话必须挂进一个**已注册的 workspace**，否则 DSH 侧栏里看不到它（实测：只给 cwd
    // 建的会话不会出现在侧栏工作区里）。优先用注册表里那个熟悉的 agents 工作区。
    const workspaceId = resolveWorkspaceId();
    let lastError = null;
    for (const preset of PREFERRED_PRESETS) {
      try {
        const payload = workspaceId
          ? { sessionId, workspaceId, ...(preset ? { agentPreset: preset } : {}) }
          : { sessionId, cwd, ...(preset ? { agentPreset: preset } : {}) };
        await controller.create(payload);
        log(`[qq-bridge] 会话 ${sessionId} 已创建（preset ${preset || '默认'}${workspaceId ? '，已挂到 agents 工作区' : '，未找到已注册工作区'}）`);
        return preset;
      } catch (error) {
        const msg = String(error?.message ?? error);
        lastError = error;
        // 同名会话已存在：直接算成功
        if (/exist|already|duplicate|冲突/i.test(msg)) return preset;
        // preset 不存在 → 试下一个
        if (/preset|not found|unknown/i.test(msg)) continue;
        throw error;
      }
    }
    throw lastError ?? new Error('建会话失败');
  }

  /** 从 DSH 的工作区注册表里找出「agents」工作区 id（让 QQ 分会话出现在侧栏里）。 */
  function resolveWorkspaceId() {
    const registryFile = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
    try {
      const doc = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      const workspaces = doc?.tables?.workspaces ?? {};
      const entries = Object.entries(workspaces);
      // 优先标题/路径含 agents 的（旧桥时代的工作区，用户熟悉）
      const hit = entries.find(([, v]) => /agents/i.test(String(v?.path ?? '')) || /^agents$/i.test(String(v?.title ?? '')))
        ?? entries.find(([, v]) => /state[\\/]agents/i.test(String(v?.path ?? '')));
      if (hit) return hit[0];
      // 退而求其次：任何已注册工作区（至少能出现在侧栏）
      return entries[0]?.[0] ?? '';
    } catch {
      return '';
    }
  }

  /** 建/复用会话；只在新会话上设一次模型（之后用户在 GUI 里手切的模型不会被覆盖）。 */
  async function ensureSession(key) {
    const sessionId = sessionIdForKey(key);
    const controller = service('sessionController');
    const cwd = path.join(STATE_DIR, 'agents');
    if (ready.has(sessionId)) return sessionId;
    if (!controller || typeof controller.state !== 'function' || typeof controller.create !== 'function') {
      // 没有 controller（老 DSH）：交给 HTTP prompt 自动建会话，模型下面用 RPC 设。
      ready.set(sessionId, false);
      return sessionId;
    }
    let created = false;
    try {
      await controller.state({ sessionId });
    } catch {
      await createSessionWithController(controller, sessionId, cwd);
      created = true;
    }
    if (created) {
      try {
        const selected = (() => { try { return resolveModel?.() ?? null; } catch { return null; } })();
        if (selected?.provider && selected?.model) {
          await controller.selectModel({
            sessionId,
            provider: String(selected.provider),
            model: String(selected.model),
            ...(selected.reasoningEffort ? { reasoningEffort: String(selected.reasoningEffort) } : {}),
          });
          log(`[qq-bridge] 会话 ${sessionId} 模型 → ${selected.provider}/${selected.model}`);
        }
      } catch (error) {
        log('[qq-bridge] 设模型失败：', String(error?.message ?? error).slice(0, 160));
      }
    }
    ready.set(sessionId, true);
    return sessionId;
  }

  async function doAsk(sessionId, text, timeoutMs) {
    const client = await api();
    const waiter = {
      sessionId,
      collector: createTurnCollector(),
      resolve: () => {},
      reject: () => {},
      timer: null,
    };
    const promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    if (!pending.has(sessionId)) pending.set(sessionId, new Set());
    pending.get(sessionId).add(waiter);
    waiter.timer = setTimeout(() => {
      const waiters = pending.get(sessionId);
      if (waiters) {
        waiters.delete(waiter);
        if (!waiters.size) pending.delete(sessionId);
      }
      waiter.reject(new Error(`等回复超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    try {
      await client.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      });
    } catch (error) {
      if (waiter.timer) clearTimeout(waiter.timer);
      const waiters = pending.get(sessionId);
      if (waiters) {
        waiters.delete(waiter);
        if (!waiters.size) pending.delete(sessionId);
      }
      throw new Error(`灌消息失败：${String(error?.details?.reason ?? error?.message ?? error).slice(0, 240)}`);
    }
    return promise;
  }

  /** 每条会话当前已注入的人格指纹（人格变了才再注入一次，避免每轮都灌一遍长文本）。 */
  const personaStateFile = path.join(STATE_DIR, 'astrbot', 'qq-persona.json');
  let personaHashes = {};
  try {
    const raw = JSON.parse(fs.readFileSync(personaStateFile, 'utf8'));
    if (raw && typeof raw === 'object') personaHashes = raw;
  } catch { /* 首次运行没有这个文件 */ }
  function savePersonaHashes() {
    try {
      fs.mkdirSync(path.dirname(personaStateFile), { recursive: true });
      fs.writeFileSync(personaStateFile, `${JSON.stringify(personaHashes, null, 1)}\n`, 'utf8');
    } catch { /* 写不了就只影响下次是否重复注入 */ }
  }

  /** AstrBot 人格页的当前人格：会话首次/人格改动后随消息注入一次，让「人格与语气」页继续生效。 */
  function withPersona(sessionId, text, persona, personaHash) {
    const prompt = String(persona ?? '').trim();
    if (!prompt) return text;
    const hash = String(personaHash ?? '').slice(0, 64);
    if (hash && personaHashes[sessionId] === hash) return text;
    personaHashes[sessionId] = hash;
    savePersonaHashes();
    log(`[qq-bridge] 会话 ${sessionId} 注入人格（${prompt.length} 字）`);
    return `【人格设定（来自 AstrBot「人格与语气」页；按这份设定说话，覆盖预设里的泛化人设）】\n${prompt.slice(0, 8000)}\n\n【本轮用户消息】\n${text}`;
  }

  /** @returns {Promise<{key:string, sessionId:string, reply:string}>} */
  async function ask({ key: rawKey, text, timeoutMs = DEFAULT_TIMEOUT_MS, persona = '', personaHash = '' } = {}) {
    ensureSubscribed();
    const key = normalizeQqKey(rawKey);
    if (!key) throw new Error(`无法识别的 QQ 会话标识：${String(rawKey ?? '').slice(0, 80)}`);
    const content = String(text ?? '').trim();
    if (!content) throw new Error('消息为空');
    const sessionId = await ensureSession(key);
    const composed = withPersona(sessionId, content, persona, personaHash);
    const prev = locks.get(sessionId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      await acquireSlot();
      try { return await doAsk(sessionId, composed, timeoutMs); }
      finally { releaseSlot(); }
    });
    locks.set(sessionId, run.catch(() => {}));
    const reply = await run;
    return { key, sessionId, reply };
  }

  return { ask, normalizeQqKey, sessionIdForKey };
}
