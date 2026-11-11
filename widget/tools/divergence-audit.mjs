#!/usr/bin/env node
/**
 * 跨模块口径审计（divergence audit）。
 *
 * 为什么需要：
 *   2026-11-11 用户原话——「不光是这一个地方，别的功能模块都要查清楚，
 *   不然这些问题随时随地的爆出来，然后陷入死循环打补丁的流程」。
 *
 *   真正反复爆的根因不是某个正则写错，而是**同一个概念在多个模块里各算一遍**：
 *     · 数据目录：一半代码尊重 DSH_HOME，一半写死 ~/.dsh
 *       → 改过 DSH_HOME 的机器上「明明登录了却说没凭据」
 *     · 「今天」：一半用本机时区、一半用北京时间
 *       → 非 UTC+8 的机器「没用多少却额度已满」
 *     · 出站清洗：每个发送入口一份（已由 outbound-reply.mjs 收口）
 *
 *   这里把「同一概念只能有一个实现」变成可执行的检查，而不是靠人记得。
 *
 * 0 依赖，CI 直接跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_DIRS = ['src', 'backend', 'packages/dsh-dfy-core'].map((d) => path.join(ROOT, d));
// 不参与运行时口径检查的目录：
//   · backend/tools、*/backend/tools —— 开发者命令行脚本（手动跑，不影响插件行为）
//   · backend/vendor/douyin        —— 第三方 vendor 代码（另一个口径，见下方 DAYKEY_ALLOW）
const EXCLUDE_DIRS = ['backend/tools', 'backend/vendor', 'packages/dsh-dfy-core/backend/tools'];
const failures = [];
const notes = [];
const ok = (m) => notes.push(m);
const fail = (m) => failures.push(m);

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(full);
  }
  return out;
}

const excluded = (file) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  return EXCLUDE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
};

const files = SOURCE_DIRS.flatMap((d) => walk(d)).filter((f) => !excluded(f));
const readAll = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

// ── 1) 数据目录必须尊重 DSH_HOME ───────────────────────────────────────
// 违规写法：path.join(<home>, '.dsh', ...) 且同一行/同一个小函数里没有 DSH_HOME。
const HOME_DH_RE = /path\.join\(\s*(?:os\.homedir\(\)|home|HOME)\s*,\s*['"]\.dsh['"]/;
const ALLOW = new Set([
  // 共享口径的实现本身
  'src/character-persona.js',
  'src/dsh-client.js',
  'src/meme-wiki.js',
  'src/web-search.js',
  'src/token-budget.js',
  'src/day-key.mjs',
  // 抖音浏览器层：vendor 固定写 ~/.dsh/douyin-browser（不受 DSH_HOME 影响），
  // 这里必须跟它算同一份路径，否则插件和 vendor 会各看一个目录 → 读不到浏览器状态。
  // 两边内部一致，不构成分叉；改口径要连 vendor 一起改。
  'backend/lib/douyin.js',
]);
const offenders = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (ALLOW.has(rel)) continue;
  const text = readAll(file);
  const lines = text.split(/\r?\n/);
  let hasDshHome = /process\.env\.DSH_HOME/.test(text);
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (!HOME_DH_RE.test(line)) return;
    // 同一行里已经写了 DSH_HOME 兜底（`process.env.DSH_HOME || path.join(...)`）是合法写法
    if (/DSH_HOME/.test(line)) return;
    // 文件里根本没有 DSH_HOME 概念 → 一定写死了；文件里有但这一行没有 → 也可能是兜底分支，标出来人工看
    offenders.push({ rel, line: i + 1, text: line.trim().slice(0, 100), hasDshHome });
  });
}
const hardWired = offenders.filter((o) => !o.hasDshHome);
const suspicious = offenders.filter((o) => o.hasDshHome);
if (hardWired.length) {
  for (const o of hardWired) fail(`[数据目录] ${o.rel}:${o.line} 写死 ~/.dsh（不尊重 DSH_HOME）：${o.text}`);
} else ok('没有模块写死 ~/.dsh（数据目录统一尊重 DSH_HOME）');
if (suspicious.length) {
  for (const o of suspicious) fail(`[数据目录] ${o.rel}:${o.line} 这一行绕过了 DSH_HOME，请改成共享口径：${o.text}`);
}

// ── 2) 「今天」必须只有一个实现 ─────────────────────────────────────────
const DAYKEY_FILE = 'packages/dsh-dfy-core/src/day-key.js';
const dayKeyImpl = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel === DAYKEY_FILE) return false;
  const t = readAll(f);
  return /Intl\.DateTimeFormat\(\s*['"]en-CA['"][\s\S]{0,80}Asia\/Shanghai/.test(t);
});
if (dayKeyImpl.length) {
  for (const f of dayKeyImpl) {
    fail(`[今天口径] ${path.relative(ROOT, f)} 又自己算了一遍北京时间日期；请 import { dayKey } from 'day-key.js'`);
  }
} else ok('「今天」只有 day-key.js 一个实现');
// 用本机时区算日期的写法（getFullYear + getMonth + getDate 拼日期）同样属于分叉。
// 极少数的「展示用本地时间戳」（日期+时刻+星期）可以显式豁免：在上一行写 day-key-allow 并说明原因。
const localDayOffenders = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel === DAYKEY_FILE) continue;
  const lines = readAll(f).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/getFullYear\s*\(\).*getDate\s*\(\)/.test(line)) return;
    if (/day-key-allow/.test(line) || /day-key-allow/.test(lines[i - 1] ?? '')) return;
    localDayOffenders.push(`${rel}:${i + 1}`);
  });
}
if (localDayOffenders.length) {
  for (const o of localDayOffenders) fail(`[今天口径] ${o} 用本机时区拼日期（非 UTC+8 的机器会和额度文件对不上）`);
} else ok('没有模块用本机时区拼「今天」');
// `toLocaleDateString('sv-SE')` 看起来是 ISO 日期，但它是**本机时区**的日期。
// 运行时模块里出现过 10+ 处，和北京时间的额度/日报口径错开一天。
const svSeOffenders = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel === DAYKEY_FILE) return false;
  return /toLocaleDateString\(\s*['"]sv-SE['"]\s*\)/.test(readAll(f));
});
if (svSeOffenders.length) {
  for (const f of svSeOffenders) fail(`[今天口径] ${path.relative(ROOT, f)} 用 toLocaleDateString('sv-SE') 算日期（本机时区）；请改用 dayKey()`);
} else ok('没有模块用 sv-SE 本地日期算「今天」');

// ── 3) 出站清洗只有一处实现 ────────────────────────────────────────────
// 任何模块再写一份「抽 [sticker:] / 剥 Markdown 图片」都算分叉。
const stickerImpl = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  // reply-cleanup 是共享实现本体（outbound-reply 复用它），不是分叉。
  if (rel === 'src/outbound-reply.mjs' || rel === 'src/reply-cleanup.mjs') return false;
  const t = readAll(f);
  return /\\\[\(\?:sticker\|表情\)|\[sticker\[:：\]/.test(t);
});
if (stickerImpl.length) {
  for (const f of stickerImpl) fail(`[出站清洗] ${path.relative(ROOT, f)} 自己写了 [sticker:] 正则；请用 outbound-reply.mjs`);
} else ok('没有模块自写 [sticker:] 清洗');

// ── 4) 配置路径只有一处实现 ────────────────────────────────────────────
// QQ 配置固定是 <DSH_HOME>/surfcore/qq/config.json；散着拼容易漏层级（历史事故）。
const qqConfigImpl = files.filter((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const t = readAll(f);
  return /['"]surfcore['"]\s*,\s*['"]qq['"]\s*,\s*['"]config\.json['"]/.test(t);
});
if (qqConfigImpl.length > 4) {
  fail(`[配置路径] 有 ${qqConfigImpl.length} 处自己拼 QQ 配置路径（${qqConfigImpl.map((f) => path.relative(ROOT, f)).join(', ')}）：漏一层目录就会读不到配置`);
} else ok(`QQ 配置路径拼接集中在 ${qqConfigImpl.length} 处（可接受）`);

// ── 结果 ──────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  ok   ${n}`);
if (failures.length) {
  console.error('\n跨模块口径审计失败：');
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('\n修复方向：把分叉的实现统一到共享模块，而不是各修各的。');
  process.exit(1);
}
console.log('\n✔ 跨模块口径审计通过：数据目录 / 今天 / 出站清洗 / 配置路径都只有一个实现。');
