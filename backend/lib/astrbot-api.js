/**
 * AstrBot 面板 API 客户端：dsh-Dfy 后端直接调 AstrBot dashboard 的 /api/v1/*。
 *
 * 鉴权不用密码：dashboard 的 HS256 jwt_secret 就存在它自己的 cmd_config.json
 * （dashboard.jwt_secret），签一个带 username claim 的令牌即可（实测 200）。
 * 这里只暴露「减法面板」需要的几个端点，完整配置仍归 AstrBot WebUI：
 *   GET  /api/v1/plugins                     列表（activated/reserved/desc/version）
 *   PATCH /api/v1/plugins/enabled            {plugin_id, enabled}
 *   DELETE /api/v1/plugins/by-id?plugin_id=  卸载
 *   POST /api/v1/plugins/install/url         {url}（github 仓库）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readUnified } from './store.js';
import { STATE_DIR } from './paths.js';

const execFileAsync = promisify(execFile);
const CALL_TIMEOUT = 120_000;
const CHAT_TIMEOUT = 120_000;

function readAstrbotConfig(cfg) {
  const cwd = cfg.cwd || path.join(os.homedir(), 'astrbot');
  const file = path.join(cwd, 'data', 'cmd_config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** 签 dashboard JWT：HS256，claims 只要求 username（auth.py 只校验它）。 */
function signDashboardToken(dashboardConf) {
  const secret = String(dashboardConf.jwt_secret ?? '');
  if (!secret) throw new Error('AstrBot 配置里没有 dashboard.jwt_secret');
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ username: String(dashboardConf.username ?? 'astrbot'), exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

async function callApi(cfg, method, apiPath, body, prefix = '/api/v1') {
  const conf = readAstrbotConfig(cfg);
  const token = signDashboardToken(conf.dashboard ?? {});
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}${prefix}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });
  } catch (error) {
    throw new Error(`AstrBot 不可达（${String(error?.cause?.code ?? error?.message ?? error)}）：先确认它在运行`);
  }
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* 非 JSON 按原文报错 */ }
  if (!res.ok) {
    const detail = Array.isArray(data?.detail)
      ? data.detail.map((d) => d?.msg ?? JSON.stringify(d)).join('；')
      : (data?.detail ?? data?.message ?? text.slice(0, 200));
    throw new Error(`AstrBot API ${res.status}：${detail}`);
  }
  if (data?.status && data.status !== 'ok') throw new Error(data?.message || `AstrBot API 返回 ${data.status}`);
  return data?.data ?? data;
}

export function createAstrbotApi({ log = () => {} } = {}) {
  const chatState = { sessionId: '' };
  function cfg() {
    return readUnified().config.astrbot ?? { enabled: true, cwd: '', exe: '', port: 6185 };
  }

  return {
    /** 已装插件列表（过滤内部保留插件），字段归一成面板要用的形状。 */
    async listPlugins() {
      const rows = await callApi(cfg(), 'GET', '/plugins');
      const list = Array.isArray(rows) ? rows : [];
      return list
        .filter((p) => p && p.reserved !== true)
        .map((p) => ({
          name: String(p.name ?? ''),
          version: String(p.version ?? ''),
          desc: String(p.desc ?? ''),
          author: String(p.author ?? ''),
          repo: String(p.repo ?? ''),
          enabled: p.activated === true,
        }));
    },

    /** 从 github 仓库装插件（url 形如 https://github.com/user/repo）。 */
    async installPlugin(url) {
      const repo = String(url ?? '').trim();
      if (!repo) throw new Error('仓库地址不能为空');
      const full = /^https?:\/\//.test(repo) ? repo : `https://github.com/${repo.replace(/^\/+/, '')}`;
      log(`[astrbot] 安装插件：${full}`);
      return callApi(cfg(), 'POST', '/plugins/install/url', { url: full });
    },

    async setPluginEnabled(name, enabled) {
      return callApi(cfg(), 'PATCH', '/plugins/enabled', { plugin_id: String(name), enabled: Boolean(enabled) });
    },

    async uninstallPlugin(name) {
      return callApi(cfg(), 'DELETE', `/plugins/by-id?plugin_id=${encodeURIComponent(String(name))}`);
    },

    /** 人格列表（= 老版的「角色卡」）：[{id, prompt}]。 */
    async listPersonas() {
      const rows = await callApi(cfg(), 'GET', '/personas');
      const list = Array.isArray(rows) ? rows : [];
      return list.map((p) => ({
        id: String(p.persona_id ?? ''),
        prompt: String(p.system_prompt ?? ''),
      }));
    },

    async createPersona(id, prompt) {
      return callApi(cfg(), 'POST', '/personas', { persona_id: String(id), system_prompt: String(prompt ?? '') });
    },

    async updatePersona(id, prompt) {
      return callApi(cfg(), 'PUT', '/personas/by-id', { persona_id: String(id), system_prompt: String(prompt ?? '') });
    },

    async deletePersona(id) {
      return callApi(cfg(), 'DELETE', `/personas/by-id?persona_id=${encodeURIComponent(String(id))}`);
    },

    /** 当前使用的人格 id（读它自己的 cmd_config.json，agent_runner.config.persona.persona_id）。 */
    getActivePersonaId(cfgOverride) {
      try {
        const conf = readAstrbotConfig(cfgOverride ?? cfg());
        const id = conf?.agent_runner?.config?.persona?.persona_id;
        return String(id ?? '');
      } catch {
        return '';
      }
    },

    /** 切换当前人格：写配置文件，需要重启 AstrBot 生效（返回 needRestart）。 */
    setActivePersonaId(id) {
      return setActivePersonaIdImpl(cfg(), id);
    },

    /**
     * 一次性迁移：把老架构的角色卡（persona.md）+ 记忆卡压缩版（memory-card-prompt-qq.md）
     * 合成一个 AstrBot 人格（以角色名命名），并设为当前。做过的用标记文件防重复。
     * 只创建人格和写配置（人格内容即时生效）；「设为当前」由调用方触发重启。
     */
    async migrateOldCharacterPersona() {
      const c = cfg();
      const cwd = c.cwd || path.join(os.homedir(), 'astrbot');
      const marker = path.join(cwd, 'data', '.dfy-persona-migrated');
      if (fs.existsSync(marker)) return { ok: false, reason: 'already' };
      try { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, new Date().toISOString()); } catch {}
      // 读老角色：characters/current.json → {name, dir}
      let character = null;
      try {
        character = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'characters', 'current.json'), 'utf8').replace(/^\uFEFF/, ''));
      } catch { return { ok: false, reason: 'no-old-character' }; }
      const dir = String(character?.dir ?? '');
      const name = String(character?.name ?? '').trim();
      if (!dir || !name) return { ok: false, reason: 'no-old-character' };
      const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
      const base = read(path.join(dir, 'persona.md')).trim();
      if (!base) return { ok: false, reason: 'no-persona-file' };
      const memory = read(path.join(dir, 'memory', 'memory-card-prompt-qq.md')).trim();
      const prompt = memory
        ? `${base}\n\n# 与主人的共同记忆（长期记忆卡的压缩版，会过期，后续由记忆插件接管）\n\n${memory}`
        : base;
      // 已有同名人格就更新，避免重复创建
      const existing = await this.listPersonas();
      if (existing.some((p) => p.id === name)) await this.updatePersona(name, prompt);
      else await this.createPersona(name, prompt);
      setActivePersonaIdImpl(c, name);
      log(`[astrbot] 老角色卡已迁移：${name}（${prompt.length} 字符）`);
      return { ok: true, name, chars: prompt.length };
    },

    /**
     * QQ 是否真的连上了大脑：看本机 6199 端口有没有 ESTABLISHED 连接
     * （SnowLuma 的 wsClients 连入）。比任何配置都诚实。
     */
    async isQqConnected() {
      try {
        const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { timeout: 8000 });
        return stdout.split(/\r?\n/).some((l) => l.includes(':6199 ') && /ESTABLISHED/i.test(l));
      } catch {
        return false;
      }
    },

    /** 傻瓜式对话测试：发一句话，聚合流式回复返回纯文本。 */
    async chatTest(text) {
      return chatTestImpl(cfg(), text, chatState, log);
    },
  };
}

/** 对话测试实现：webchat 会话 + /api/v1/send（JSON 或 SSE 都兜住），聚合纯文本回复。 */
async function chatTestImpl(cfg, text, state, log) {
  const message = String(text ?? '').trim();
  if (!message) throw new Error('先输入一句话');
  if (!state.sessionId) {
    // 旧版会话路由挂在 /api/chat（不是 /api/v1）
    const r = await callApi(cfg, 'GET', '/new_session?platform_id=webchat', undefined, '/api/chat');
    state.sessionId = String(r?.session_id ?? r?.data?.session_id ?? '');
    if (!state.sessionId) throw new Error('拿不到会话 id（AstrBot 版本变了？）');
    log(`[astrbot] 对话测试会话：${state.sessionId}`);
  }
  const res = await fetch(`http://127.0.0.1:${cfg.port}/api/chat/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signDashboardToken(readAstrbotConfig(cfg).dashboard ?? {})}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message, session_id: state.sessionId }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT),
  });
  const raw = await res.text();
  if (!res.ok) {
    let msg = raw.slice(0, 300);
    try { msg = JSON.parse(raw)?.message ?? msg; } catch {}
    throw new Error(`发送失败（HTTP ${res.status}）：${msg}`);
  }
  // 响应是 SSE 帧：回复文本在 type:"plain" 的 data 里（实测帧型 session_id/user_message_saved/run_started/plain/message_saved/end）。
  let reply = '';
  if (contentType.includes('event-stream') || raw.startsWith('data:') || raw.includes('\ndata:')) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        if (j?.type === 'plain' && typeof j.data === 'string') reply += j.data;
      } catch { /* 非 JSON 帧忽略 */ }
    }
  } else {
    try {
      const j = JSON.parse(raw);
      const d = j?.data ?? j;
      reply = typeof (d?.message_chain ?? d?.reply ?? d?.text) === 'string' ? (d.message_chain ?? d.reply ?? d.text) : '';
    } catch { /* 保持空 */ }
  }
  reply = reply.trim();
  if (!reply) throw new Error('大脑没回话——多半是模型 key 还没配（机器人配置里保存一次就好）');
  return { reply };
}

/** 当前人格落盘：agent_runner.config.persona.persona_id（重启后生效）。 */
function setActivePersonaIdImpl(cfg, id) {
  const file = path.join(cfg.cwd || path.join(os.homedir(), 'astrbot'), 'data', 'cmd_config.json');
  const conf = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  conf.agent_runner = conf.agent_runner ?? {};
  conf.agent_runner.config = conf.agent_runner.config ?? {};
  conf.agent_runner.config.persona = { ...(conf.agent_runner.config.persona ?? {}), persona_id: String(id) };
  fs.writeFileSync(file, JSON.stringify(conf, null, 2), 'utf8');
  return { ok: true, needRestart: true };
}

