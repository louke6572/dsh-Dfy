/**
 * 大肥鱼表情包（kiriyuki.com nekowhale kit）——内置桥的原生实现。
 *
 * 只做三件事：
 *   1) 拉清单（/api/kit/nekowhale）和标注（/meme/kit/nekowhale.json），本地缓存；
 *   2) 按回复文本挑一张（情绪 + 标签 + 用法关键词打分，零模型调用）；
 *   3) 下载 GIF（校验 sha1 前 12 位）并用 SnowLuma OneBot 发图片段。
 *
 * 素材版权归作者（可以叫我云大人），只运行时拉取、不镜像、不二次分发。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

const SITE = 'https://kiriyuki.com';
const MANIFEST_URL = `${SITE}/api/kit/nekowhale`;
const META_URL = `${SITE}/meme/kit/nekowhale.json`;
const USER_AGENT = 'dsh-dfy-nekowhale/1.0 (+https://kiriyuki.com)';
const MANIFEST_TTL = 24 * 3600_000;
const META_TTL = 7 * 24 * 3600_000;
const MAX_BYTES = 6 * 1024 * 1024;

function sha1prefix(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error('表情太大');
  return buffer;
}

const EMOTION_HINTS = [
  ['开心', ['笑', '哈哈', '开心', '好耶', '太棒', '舒服', '喜欢']],
  ['兴奋', ['激动', '期待', '冲', '哇', '来了', '好爽']],
  ['难过', ['难过', '伤心', '想哭', '委屈', '呜']],
  ['疲惫', ['累', '困', '摆烂', '躺', '不想动', '睡了']],
  ['生气', ['生气', '气死', '烦', '怒', '哼']],
  ['惊讶', ['啊', '竟然', '居然', '真的', '卧槽', '震惊']],
  ['无语', ['无语', '算了', '随便', '呵呵', '行吧']],
  ['害羞', ['害羞', '脸红', '不好意思', '羞涩']],
  ['嘲讽', ['就这', '菜', '笑死', '不会吧', '阴阳']],
  ['安慰', ['没事', '别难过', '抱抱', '会好的']],
];

/**
 * @param {{dir: string, log?: Function}} options
 */
export function createNekoStickers({ dir, log = () => {} } = {}) {
  const cacheDir = path.join(dir, 'nekowhale');
  const manifestFile = path.join(cacheDir, 'manifest.json');
  const metaFile = path.join(cacheDir, 'meta.json');
  const gifDir = path.join(cacheDir, 'gif');
  const stateFile = path.join(cacheDir, 'state.json');
  fs.mkdirSync(gifDir, { recursive: true });

  let kit = null;
  let kitAt = 0;

  async function loadKit() {
    if (kit && Date.now() - kitAt < META_TTL) return kit;
    let manifest = readJson(manifestFile);
    let meta = readJson(metaFile);
    const fresh = (file) => {
      try { return Date.now() - fs.statSync(file).mtimeMs < MANIFEST_TTL; } catch { return false; }
    };
    if (!manifest || !fresh(manifestFile)) {
      try {
        manifest = JSON.parse(await fetchText(MANIFEST_URL));
        writeFileAtomic(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
      } catch (error) {
        if (!manifest) throw error;
        log(`[neko] 清单更新失败，用缓存：${error?.message ?? error}`);
      }
    }
    if (!meta || !fresh(metaFile)) {
      try {
        meta = JSON.parse(await fetchText(META_URL));
        writeFileAtomic(metaFile, JSON.stringify(meta), { mode: 0o600 });
      } catch (error) {
        if (!meta) throw error;
        log(`[neko] 标注更新失败，用缓存：${error?.message ?? error}`);
      }
    }
    const byId = new Map();
    for (const item of Array.isArray(manifest?.items) ? manifest.items : []) byId.set(item.id, { ...item });
    for (const ann of Array.isArray(meta?.stickers) ? meta.stickers : []) {
      const hit = byId.get(ann.id);
      if (hit) Object.assign(hit, { emotion: ann.emotion || '', tags: ann.tags || [], use: ann.use || '', desc: ann.desc || '', meme: ann.meme || '' });
    }
    kit = {
      items: [...byId.values()].map((item) => ({
        ...item,
        text: `${item.name || ''} ${item.emotion || ''} ${(item.tags || []).join(' ')} ${item.use || ''} ${item.desc || ''}`,
      })),
      gifBase: manifest?.gif_base || '/media/gif',
    };
    kitAt = Date.now();
    log(`[neko] 表情库就绪：${kit.items.length} 张`);
    return kit;
  }

  function loadState() {
    const st = readJson(stateFile) || {};
    return { recent: Array.isArray(st.recent) ? st.recent.slice(0, 30) : [], sentAt: Array.isArray(st.sentAt) ? st.sentAt : [] };
  }

  function saveState(st) {
    try { writeFileAtomic(stateFile, JSON.stringify({ ...st, updatedAt: new Date().toISOString() }), { mode: 0o600 }); } catch { /* ignore */ }
  }

  /** 按回复文本挑一张；返回 item 或 null。零模型调用。 */
  async function pick(text, { excludeEmotions = [], minScore = 2 } = {}) {
    const { items } = await loadKit();
    const state = loadState();
    const recent = new Set(state.recent);
    const lower = String(text ?? '').toLowerCase();
    const emotionWanted = EMOTION_HINTS.filter(([, words]) => words.some((w) => lower.includes(w))).map(([emotion]) => emotion);
    const exclude = new Set(excludeEmotions.filter(Boolean));
    const scored = [];
    for (const item of items) {
      if (exclude.has(item.emotion)) continue;
      if (recent.has(item.id)) continue;
      let score = 0;
      if (item.emotion && emotionWanted.includes(item.emotion)) score += 3;
      for (const tag of item.tags || []) {
        if (!tag) continue;
        if (lower.includes(String(tag).toLowerCase())) score += 2;
      }
      for (const word of String(item.name || '').split(/[\s_、，,]+/).filter(Boolean)) {
        if (word.length >= 2 && lower.includes(word.toLowerCase())) score += 1;
      }
      if (item.pack === '大肥鱼和GPT娘') score -= 1;
      if (score > 0) scored.push({ item, score: score + Math.random() });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < minScore) return null;
    state.recent = [best.item.id, ...state.recent].slice(0, 30);
    saveState(state);
    return best.item;
  }

  async function download(item) {
    const { gifBase } = await loadKit();
    const file = path.join(gifDir, item.file);
    try {
      const stat = fs.statSync(file);
      if (stat.size > 0) return file;
    } catch { /* 没缓存 */ }
    const url = `${SITE}${gifBase}/${encodeURIComponent(item.pack)}/${encodeURIComponent(item.file)}?h=${encodeURIComponent(item.hash)}`;
    const buffer = await fetchBuffer(url);
    if (sha1prefix(buffer) !== item.hash) throw new Error('表情哈希校验失败');
    const part = `${file}.part`;
    fs.writeFileSync(part, buffer);
    fs.renameSync(part, file);
    return file;
  }

  /** 发一张表情到当前 QQ 会话（key = private:uin / group:gid）。 */
  async function send({ httpUrl, token, key, item }) {
    const [kind, id] = String(key ?? '').split(':');
    if (!/^(private|group)$/.test(kind) || !/^\d{5,15}$/.test(String(id ?? ''))) throw new Error('未知会话 key');
    const file = await download(item);
    const base = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const message = [{ type: 'image', data: { file: `file:///${file.replace(/\\/g, '/')}` } }];
    const params = kind === 'private' ? { user_id: Number(id), message } : { group_id: Number(id), message };
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) throw new Error(`OneBot ${action} 失败：${body.wording || body.retcode || res.status}`);
    return { ok: true, id: item.id, name: item.name, emotion: item.emotion || '' };
  }

  function limitsOf(config) {
    const cfg = config ?? {};
    return {
      enabled: cfg.enabled !== false,
      minGap: Math.max(0, Number(cfg.minGapSec ?? 60)) * 1000,
      maxPerHour: Math.max(1, Number(cfg.maxPerHour ?? 6)),
      excludeEmotions: Array.isArray(cfg.excludeEmotions) ? cfg.excludeEmotions : [],
      minScore: Number(cfg.minScore ?? 2),
    };
  }

  function recentSentAt(now) {
    return loadState().sentAt.filter((t) => now - t < 3600_000);
  }

  /**
   * 还能不能再发一张。所有发表情的地方（自动补发、模型主动 sticker_send、
   * [sticker:名字] 兜底、抖音补发）都查这一份 state，设置里的「最小间隔 / 每小时最多」
   * 才是真的总量上限，而不是每条链路各算各的。
   */
  function canSend(config, now = Date.now()) {
    const { enabled, minGap, maxPerHour } = limitsOf(config);
    if (!enabled) return false;
    const sentAt = recentSentAt(now);
    if (!sentAt.length) return true;
    if (now - sentAt[sentAt.length - 1] < minGap) return false;
    return sentAt.length < maxPerHour;
  }

  /** 真正发出去之后记账。 */
  function markSent(now = Date.now()) {
    const state = loadState();
    state.sentAt = [...recentSentAt(now), now].slice(-50);
    saveState(state);
  }

  /** 记下最近发过的图，自动挑图时尽量不重复。 */
  function markRecent(id) {
    if (!id) return;
    const state = loadState();
    state.recent = [id, ...state.recent.filter((one) => one !== id)].slice(0, 30);
    saveState(state);
  }

  /** 回复后自动补一张（受配置的开关/间隔/排除情绪约束）。 */
  async function afterReply({ key, text, httpUrl, token, config = {}, now = Date.now(), transport = null }) {
    const cfg = limitsOf(config);
    if (!cfg.enabled) return null;   // 默认开；面板关掉才不发
    if (!canSend(config, now)) return null;
    const item = await pick(text, { excludeEmotions: cfg.excludeEmotions, minScore: cfg.minScore });
    if (!item) return null;
    // transport：别的平台（抖音）自己发图；没给就走 SnowLuma（QQ）
    const result = transport ? await transport(item) : await send({ httpUrl, token, key, item });
    markSent(now);
    markRecent(item.id);
    return result;
  }

  return { loadKit, pick, download, send, afterReply, canSend, markSent, markRecent };
}
