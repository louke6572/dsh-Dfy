/**
 * 梗百科（内置版）。
 *
 * 把 dsh-memewiki（MIT，作者 thawline）的「本地词库 + 接梗规则」搬进 dsh-Dfy：
 *   · 词库：data/memewiki/memes.db（6792 条，SQLite，只读；也认已装的 dsh-memewiki 插件库）
 *   · 判断：只对「像在问梗」的消息触发，没命中就什么都不加
 *   · 注入：命中只塞那一条词条进这一轮提示，不让模型念词条
 *
 * 和原插件的差别：内置版直接在 QQ / 抖音拼提示词的地方调用，不依赖 DSH 的
 * systemPrompt 钩子，也不受消息外面包的上下文影响，所以两端都能稳定命中。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch { /* 老 Node 没有 node:sqlite：只有匹配逻辑，查不到词条 */ }

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const QQ_CONFIG = path.join(DSH_HOME, 'surfcore', 'qq', 'config.json');

const DB_CANDIDATES = [
  process.env.DSH_DFY_MEMEWIKI_DB || '',
  path.join(DSH_HOME, 'plugins', 'dsh-memewiki', 'data', 'memes.db'),
  path.join(DSH_HOME, 'surfcore', 'memewiki', 'memes.db'),
  fileURLToPath(new URL('../data/memewiki/memes.db', import.meta.url)),
];

const DEFAULTS = { enabled: true, maxChars: 360 };

const 问梗尾巴 = /(?:是)?(?:什么梗|啥梗|什么来头|什么来历|什么出处|什么意思|啥意思|怎么用|怎么接|怎么玩|如何用)(?:啊|呀|呢|的|这是)?[？?。！!~～]*$/;
const 裸词 = /^[\u4e00-\u9fa5A-Za-z0-9·]{2,10}$/;
const 句子成分 = /怎么样|怎么|多少|为什么|能不能|是不是|什么|了吗|了没|一下|你说|要不要|有没有/;

const 无语义 = new Set(['这', '那', '它', '他', '她', '这个', '那个', '你', '这句话', '那句话', '上面', '刚才', '下文', '前面']);
const 停用词 = new Set(['在吗', '在不在', '哈哈', '哈哈哈', '笑死', '好的', '好吧', '晚安', '早安', '睡觉', '吃饭', '干嘛', '没事', '收到', '谢谢', '好耶', '草', '典', '乐']);
const 唤醒词 = ['小鲸鱼', '大鲸鱼', '大肥鲸', '小肥鲸', '大肥鱼', '奶鱼', '鲸鱼', 'deepseek'];

const 行前缀 = [
  /^\[[^\]]{0,30}\]\s*/,
  /^【[^】]{0,20}】\s*/,
  /^\([^)]{0,30}\)\s*/,
  /^@\S+\s*/,
  /^[\w\u4e00-\u9fa5·.-]{1,20}[：:]\s*(?=\S)/,
];

const clip = (text, n) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : `${s.slice(0, n)}…`;
};

function 去前缀(line) {
  let t = String(line ?? '').trim();
  // 桥接有时会拼好几层标签（【当前消息】【管理员】名字(QQ)：…），一层层剥
  for (let pass = 0; pass < 4; pass += 1) {
    const before = t;
    for (const re of 行前缀) t = t.replace(re, '').trim();
    if (t === before) break;
  }
  for (const w of 唤醒词) {
    if (t.startsWith(w)) {
      t = t.slice(w.length).trim().replace(/^[，,。.！!？?:：]+|[，,。.！!？?:：]+$/g, '');
      break;
    }
  }
  return t;
}

/** 取一行里最后一个冒号后面的部分（「名字(QQ)：消息」的正文）。 */
function 冒号后(line) {
  const raw = String(line ?? '');
  const cut = Math.max(raw.lastIndexOf('：'), raw.lastIndexOf(':'));
  return cut >= 0 ? raw.slice(cut + 1).trim() : '';
}

/** 从一行的尾巴里抠出被问的梗；不是问梗返回空串。 */
function 从问句抠(line) {
  const m = 问梗尾巴.exec(line);
  if (!m) return '';
  let head = line.slice(0, m.index).trim();
  head = head.replace(/[。.！!？?]+$/g, '').trim();
  head = head.replace(/(这个梗|那个梗|这梗|那梗|这个|那个|到底|究竟)$/, '').trim();
  // 「…，这是什么梗」先去掉尾巴上的「这是」，再取最后一个分句 / 词
  head = head.replace(/(这是|那是|是)$/, '').trim().replace(/[，,、；;]+$/g, '');
  // 「刚看到有人说 X，这是…」：末尾的「这/那」只是指代，往前再取一个分句
  const 段 = head.split(/[，,、；;\s]+/).filter(Boolean);
  while (段.length && 无语义.has(String(段[段.length - 1]).replace(/^[是]+/, ''))) 段.pop();
  head = 段.pop() || '';
  head = head.replace(/^[是]+/, '').replace(/[：:]+$/, '').trim();
  if (!head || 无语义.has(head)) return '';
  if (head.length > 12) return '';
  return head;
}

// 「【管理员·温柔】鱼鱼」这种只有称呼的行，别当裸词去查
const 只有称呼 = /^[【[][^】\]]{0,20}[】\]]\s*[^：:\s]{1,20}$/;

/**
 * 从一整段（可能是桥接拼好的长提示）里找最新的一个梗查询。
 * 只扫最后 60 行：越靠后越新，命中一条就停。
 */
export function extractMemeQuery(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim()).slice(-60);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i];
    if (只有称呼.test(raw.trim())) continue;
    const candidates = [冒号后(raw), 去前缀(raw)].filter((one, at, all) => one && all.indexOf(one) === at);
    for (const candidate of candidates) {
      const asked = 从问句抠(candidate);
      if (asked) return { query: asked, mode: 'ask' };
      if (裸词.test(candidate) && !停用词.has(candidate) && !句子成分.test(candidate)) {
        // 纯数字长串（QQ 号、会话号）不当梗查
        if (/^\d+$/.test(candidate) && candidate.length > 4) continue;
        return { query: candidate, mode: 'bare' };
      }
    }
  }
  return null;
}

let db = null;
let dbFile = '';
let dbTried = false;
const rowCache = new Map();

function 开词库() {
  if (dbTried) return db;
  dbTried = true;
  if (!DatabaseSync) return null;
  for (const file of DB_CANDIDATES) {
    if (!file) continue;
    try {
      if (!fs.existsSync(file)) continue;
      db = new DatabaseSync(file, { readOnly: true });
      dbFile = file;
      return db;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/** 词条匹配：完全一样 → 别名 → 标题前缀 → 查询里含标题 → 标题里含查询，和原插件同口径。 */
function 查词库(query) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  if (rowCache.has(q)) return rowCache.get(q);
  const conn = 开词库();
  let row = null;
  if (conn) {
    try {
      row = conn.prepare('SELECT * FROM memes WHERE title = ?').get(q)
        || conn.prepare("SELECT * FROM memes WHERE aliases IS NOT NULL AND instr(',' || lower(aliases) || ',', ',' || lower(?) || ',') > 0 LIMIT 1").get(q)
        || conn.prepare("SELECT * FROM memes WHERE lower(title) LIKE lower(?) || '%' ORDER BY length(title) ASC LIMIT 1").get(q)
        || conn.prepare('SELECT * FROM memes WHERE length(title) >= 2 AND instr(?, title) > 0 ORDER BY length(title) DESC LIMIT 1').get(q)
        || ((q.length >= 3 || (q.length >= 2 && /^[0-9a-z]+$/i.test(q)))
          ? conn.prepare('SELECT * FROM memes WHERE instr(title, ?) > 0 ORDER BY length(title) ASC LIMIT 1').get(q)
          : null);
    } catch { row = null; }
  }
  if (rowCache.size > 300) rowCache.clear();
  rowCache.set(q, row || null);
  return row || null;
}

let configCache = null;
let configAt = 0;

export function memeWikiConfig() {
  const now = Date.now();
  if (configCache && now - configAt < 3000) return configCache;
  let cfg = { ...DEFAULTS };
  try {
    const data = JSON.parse(fs.readFileSync(QQ_CONFIG, 'utf8').replace(/^﻿/, ''));
    const section = data?.memeWiki;
    if (section && typeof section === 'object') cfg = { ...cfg, ...section };
  } catch { /* 没配置就用默认 */ }
  configCache = {
    enabled: cfg.enabled !== false,
    maxChars: Math.max(160, Math.min(1200, Number(cfg.maxChars) || DEFAULTS.maxChars)),
  };
  configAt = now;
  return configCache;
}

function 词条文本(row, maxChars) {
  const title = String(row.title || '');
  const usageLen = Math.max(120, Math.min(400, Math.floor(maxChars * 0.55)));
  const meaningLen = Math.max(60, Math.min(240, Math.floor(maxChars * 0.3)));
  const usage = clip(row.usage, usageLen);
  const meaning = clip(row.summary || row.origin || '', meaningLen);
  const lines = [`[梗百科] 这轮有人提到「${title}」，词库里查到了：照下面的用法接一句，像本来就会；别科普、别念词条、别把这段照搬。`];
  if (usage) lines.push(`怎么接：${usage}`);
  if (meaning) lines.push(`意思：${meaning}`);
  return lines.join('\n');
}

/**
 * 给这一轮拼一段梗百科。没命中、开关关了、词库没有，都返回空串。
 * 可以在长提示里调用：内部只扫最后 60 行。
 */
export function memeWikiPromptBlock(text) {
  try {
    const cfg = memeWikiConfig();
    if (!cfg.enabled) return '';
    const hit = extractMemeQuery(text);
    if (!hit) return '';
    const row = 查词库(hit.query);
    if (!row) return '';
    return 词条文本(row, cfg.maxChars);
  } catch { return ''; }
}

export function memeWikiStatus() {
  const conn = 开词库();
  let total = 0;
  try { total = conn ? Number(conn.prepare('SELECT COUNT(*) AS n FROM memes').get()?.n) || 0 : 0; } catch { total = 0; }
  return { ...memeWikiConfig(), file: dbFile, total };
}

/** 测试用：清掉数据库 / 配置 / 查询缓存。 */
export function resetMemeWikiCache() {
  try { db?.close?.(); } catch { /* ignore */ }
  db = null;
  dbFile = '';
  dbTried = false;
  configCache = null;
  configAt = 0;
  rowCache.clear();
}
