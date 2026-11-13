/**
 * 对话语料回流（chat-corpus）。
 *
 * 背景：人格的 few-shot 语料只有一份手写的静态对句（persona.examples.md），
 * 结构清一色是「他一句 / 她一两个字」，模型只能照着这个分布演，于是永远像接话工具。
 * 她本人在 QQ 里的真实回复从来没有回流成语料 —— 所以不会「越聊越像人」。
 *
 * 做法（确定性、零 token、不调模型）：
 *   1. noteIncoming：入站记下每个会话最近一条消息；
 *   2. recordReply：出站把「他：… / 你：…」成对落盘（原始流水 + 通过筛选的语料）；
 *   3. readAutoExamples：给 preset-sync 拼进语料层，和手写语料并存、互不覆盖。
 *
 * 两条刻意的克制：
 *   · 不用模型做筛选。用同一个模型判断「像不像人」，只会把它的偏好再固化一遍。
 *   · 不即时生效。自动语料只在下次同步/重启预设后进 system prompt，
 *     否则她刚说的一句口头禅会被立刻强化，形成回音室。
 */
import fs from 'node:fs';
import { characterPaths, readCurrentCharacter } from './character-persona.js';
import { writeFileAtomic } from './atomic-write.mjs';

/** 一条入站只配一条出站；超过这个窗口的回复不算这一轮的。 */
const PAIR_WINDOW_MS = 5 * 60_000;
/** 原始流水上限（行）。 */
const RAW_MAX = 400;
/** 自动语料上限（组）。超了丢最旧的。 */
const AUTO_MAX = 60;

const lastIncoming = new Map(); // key -> { text, at }

/** 纯附和：几个字只表态不提供信息，静态语料里已经够多了，回流时不再重复。 */
const FILLER_ONLY = /^[嗯恩哦噢对对啊是是的行好可以可可草6牛哦额啊这那没看了哈嘿呀呢吧嘛]{1,6}$/;
/** 客服腔 / 自曝 AI：这些句子学进去只会把 AI 味带回来。 */
const AI_SMELL = /(作为(一个)?(AI|人工智能|助手)|希望(对你|能帮)|有什么可以帮|我理解你的(感受|心情)|抱歉|无法(提供|帮助)|我是(一个)?AI|有什么其他)/;

function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function corpusPaths() {
  let cur;
  try { cur = readCurrentCharacter(); } catch { return null; }
  if (!cur) return null;
  const p = characterPaths(cur.id);
  return { raw: p.chatCorpusRaw, auto: p.personaExamplesAuto };
}

/** 入站：记下这个会话最近一条用户消息，供出站配对。
 *
 * eligible 标记这条消息「值不值得学」：群聊里只有主人说的、或直接对她说的才算；
 * 群友闲聊也要记（否则她回了 B，却会错配上更早的 A），但标记为不学，配对时直接丢弃。
 */
export function noteIncoming(key, text, { eligible = true } = {}) {
  const t = clean(text);
  if (!t) return;
  lastIncoming.set(String(key), { text: t.slice(0, 300), at: Date.now(), eligible: !!eligible });
}

/** 这条回复值不值得学。全部是确定性规则，宁可少收。 */
function acceptPair(userText, replyText) {
  const u = clean(userText);
  const r = clean(replyText);
  if (!u || !r) return false;
  if (u.length < 2 || u.length > 120) return false; // 太短没有上下文，太长是粘贴的报错/长文
  if (r.length < 2 || r.length > 100) return false; // 短到无信息 / 长到像小作文
  if (u.startsWith('/')) return false; // 管理命令
  if (/^(⚠️|⏺|〔|\[)/.test(r)) return false; // 系统通知 / 标记
  if (AI_SMELL.test(r)) return false;
  if (FILLER_ONLY.test(r)) return false;
  if (!/[\u4e00-\u9fa5]/.test(r)) return false; // 纯符号/纯英文
  return true;
}

function appendRaw(file, row) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch { /* 第一次写 */ }
  lines.push(JSON.stringify(row));
  writeFileAtomic(file, `${lines.slice(-RAW_MAX).join('\n')}\n`, { mode: 0o600 });
}

/** 从 auto 语料文件里解析出成对样例（格式固定为「他：… / 你：…」）。 */
function parseAuto(text) {
  const pairs = [];
  let pending = '';
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim();
    const isUser = s.startsWith('他：') || s.startsWith('他:');
    const isBot = s.startsWith('你：') || s.startsWith('你:');
    if (isUser) { pending = s.slice(2).trim(); continue; }
    if (isBot && pending) { pairs.push({ u: pending, r: s.slice(2).trim() }); pending = ''; }
  }
  return pairs;
}

function writeAuto(file, pairs) {
  const body = pairs.map((p) => `他：${p.u}\n你：${p.r}`).join('\n\n');
  const text = `<!-- 自动回流，勿手改；来自真实 QQ 对话，最多保留最近 ${AUTO_MAX} 组 -->\n${body}\n`;
  writeFileAtomic(file, body ? text : '<!-- 自动回流语料为空 -->\n', { mode: 0o600 });
}

/** 出站：与最近一条入站配对。返回是否进了自动语料（只用于日志/测试）。 */
export function recordReply(key, replyText) {
  const k = String(key);
  const prev = lastIncoming.get(k);
  if (!prev) return false;
  lastIncoming.delete(k); // 一条入站只配一次，防止分段发送重复计入
  if (!prev.eligible) return false;
  if (Date.now() - prev.at > PAIR_WINDOW_MS) return false;
  const reply = clean(replyText);
  if (!reply) return false;
  const p = corpusPaths();
  if (!p) return false;
  try {
    appendRaw(p.raw, { at: Date.now(), key: k, user: prev.text, reply });
  } catch { /* 流水写失败不影响回复 */ }
  if (!acceptPair(prev.text, reply)) return false;
  let pairs = [];
  try { pairs = parseAuto(fs.readFileSync(p.auto, 'utf8')); } catch { /* 第一次写 */ }
  // 同一句回复只学一次，避免口头禅被高频重复放大。
  if (pairs.some((x) => x.r === reply)) return false;
  pairs.push({ u: prev.text, r: reply });
  try { writeAuto(p.auto, pairs.slice(-AUTO_MAX)); } catch { return false; }
  return true;
}

/** 给 preset-sync 用：自动语料的正文（带小节标题，方便和手写语料区分）。 */
export function readAutoExamples() {
  const p = corpusPaths();
  if (!p) return '';
  let pairs = [];
  try { pairs = parseAuto(fs.readFileSync(p.auto, 'utf8')); } catch { return ''; }
  if (!pairs.length) return '';
  return `## 真实对话（从实际聊天里回流，不是编的）\n\n${pairs.map((x) => `他：${x.u}\n你：${x.r}`).join('\n\n')}`;
}
