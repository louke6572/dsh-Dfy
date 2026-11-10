#!/usr/bin/env node
/**
 * 出站安全不变式审计（outbound-safety-audit）
 *
 * 为什么需要它：2026-11 真实事故 —— 表情工具把本机绝对路径写进 Markdown 图片行，
 * 群聊多段回复走 sendBurstToQQ 时该行没被解析、被当作文字发进群，公开了
 * 「盘符:\Users\用户名\…」。当时的体检脚本只校验「路由是否安全 / 配置键是否被消费 /
 * 层级是否登记」，没有任何一条检查「发出去的文字里有没有本机路径」。
 *
 * 本脚本把这条防线固化下来，检查四件事：
 *   1. 所有发文本到 OneBot 的入口都收敛在已知函数里（新增旁路会失败）；
 *   2. 每个文本入口都调用 redactLocalPaths（群聊路径脱敏）；
 *   3. 每个可能承载模型输出的入口都调用 splitMarkdownImages（图片行必须被剥离）；
 *   4. 源码里不允许再把本地文件路径直接拼进 Markdown 图片（表情工具只能用 dshsticker: 引用）。
 *
 * 0 依赖，`npm install` 之前也能跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactLocalPaths } from '../../src/redact-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRIDGE = path.join(ROOT, 'src', 'bridge.js');

const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => notes.push(msg);

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/** 找某一行所属的函数名（向上找最近的 `function NAME(` / `async function NAME(`）。 */
function enclosingFunction(lines, index) {
  for (let i = index; i >= 0; i -= 1) {
    const m = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
    if (m) return m[1];
  }
  return '';
}

const src = read(BRIDGE);
if (!src) {
  console.error('找不到 src/bridge.js');
  process.exit(1);
}
const lines = src.split(/\r?\n/);

// ── 1) 文本发送入口收敛 ────────────────────────────────────────────────
const TEXT_SEND_ALLOWED = new Set([
  'sendToQQ', 'sendBurstToQQ', 'sendGroupWithAt', 'onebotSend', 'onebotSendSegments', 'sendMarkdownImage',
]);
const sendPatterns = [
  /bot\.sendPrivateMessage\(/,
  /bot\.sendGroupMessage\(/,
  /\/send_group_msg`/,
  /\/send_private_msg`/,
];
const sendHits = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!sendPatterns.some((re) => re.test(lines[i]))) continue;
  const fn = enclosingFunction(lines, i);
  sendHits.push({ line: i + 1, fn });
  if (!TEXT_SEND_ALLOWED.has(fn)) fail(`[旁路发送] src/bridge.js:${i + 1} 在 ${fn || '(未知函数)'} 里直接发 OneBot 消息；文本发送必须走 sendToQQ/sendBurstToQQ/sendGroupWithAt/onebotSend`);
}
if (sendHits.length) ok(`文本发送点 ${sendHits.length} 处，全部位于白名单函数`);

// ── 2) 每个文本入口必须做本机路径脱敏 ──────────────────────────────────
const REDACT_REQUIRED = ['sendToQQ', 'sendBurstToQQ', 'sendGroupWithAt', 'onebotSend'];
for (const fn of REDACT_REQUIRED) {
  const start = lines.findIndex((l) => new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`).test(l));
  if (start < 0) { fail(`找不到函数 ${fn}`); continue; }
  // 取函数体：向下到下一个顶层 function 声明或文件末尾（足够覆盖本函数）
  let end = lines.length - 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{0,4}(?:async\s+)?function\s+[A-Za-z_$]/.test(lines[i])) { end = i - 1; break; }
  }
  const body = lines.slice(start, end + 1).join('\n');
  if (!body.includes('redactLocalPaths(')) fail(`[路径脱敏缺失] ${fn} 没有调用 redactLocalPaths()`);
  else ok(`${fn} 已做本机路径脱敏`);
}

// ── 3) 承载模型输出的入口必须剥离 Markdown 图片 ────────────────────────
const IMAGE_STRIP_REQUIRED = ['sendToQQ', 'sendBurstToQQ', 'sendGroupWithAt', 'sendMessagesV2'];
for (const fn of IMAGE_STRIP_REQUIRED) {
  const start = lines.findIndex((l) => new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`).test(l));
  if (start < 0) continue;
  let end = lines.length - 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{0,4}(?:async\s+)?function\s+[A-Za-z_$]/.test(lines[i])) { end = i - 1; break; }
  }
  const body = lines.slice(start, end + 1).join('\n');
  if (!body.includes('splitMarkdownImages(')) fail(`[图片未剥离] ${fn} 没有调用 splitMarkdownImages()：Markdown 图片行可能被当文字发出去`);
  else ok(`${fn} 已剥离 Markdown 图片行`);
}

// ── 4) 不允许把本地路径拼进 Markdown 图片 ─────────────────────────────
const SOURCE_DIRS = ['src', 'backend', 'packages/dsh-dfy-core'].map((d) => path.join(ROOT, d));
// 桥接之外的三个「模型输出直发外部聊天」旁路也必须脱敏（2026-11-09 补查实装）：
//   qq-direct（路线 B 兜底直发 QQ）、douyin-im（抖音回复）、dfy-raw-chat（回复经 AstrBot 发 QQ）
const BYPASS_FILES = [
  { file: path.join(ROOT, 'backend', 'lib', 'qq-direct.js'), label: 'qq-direct（直发 QQ）' },
  { file: path.join(ROOT, 'backend', 'lib', 'douyin-im.js'), label: 'douyin-im（抖音回复）' },
  { file: path.join(ROOT, 'backend', 'lib', 'dfy-raw-chat.js'), label: 'dfy-raw-chat（经 AstrBot 发 QQ）' },
];
for (const { file, label } of BYPASS_FILES) {
  const text = read(file);
  if (!text.includes('redactLocalPaths(')) fail(`[旁路脱敏缺失] ${label} 没有调用 redactLocalPaths()：模型输出直发外部聊天，可能带本机路径`);
  else ok(`${label} 已做本机路径脱敏`);
}
const HUMANIZE_FILES = [
  { file: path.join(ROOT, 'backend', 'lib', 'douyin-im.js'), label: 'douyin-im（抖音回复）' },
  { file: path.join(ROOT, 'backend', 'lib', 'dfy-raw-chat.js'), label: 'dfy-raw-chat（经 AstrBot 发 QQ）' },
];
for (const { file, label } of HUMANIZE_FILES) {
  const text = read(file);
  // 这些是模型输出直发外部聊天：必须过 humanize（表情标记/空行/客服腔），
  // 否则 AstrBot / 抖音会把 [sticker:…] 或空行原样发出去。
  if (!text.includes('humanizeReplyText(')) fail(`[旁路清洗缺失] ${label} 没有调用 humanizeReplyText()`);
  else ok(`${label} 已过 humanizeReplyText`);
}
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
const sourceFiles = SOURCE_DIRS.flatMap((d) => walk(d));
// Markdown 图片语法里直接插值「看起来像文件路径」的变量 → 危险
const RISKY_MD = /!\[[^\]]*\]\(\$\{[^}]*\b(?:file|path|abs|fullPath|localPath)\b[^}]*\}\)/i;
for (const file of sourceFiles) {
  const text = read(file);
  if (!text) continue;
  const rel = path.relative(ROOT, file);
  text.split(/\r?\n/).forEach((line, i) => {
    if (RISKY_MD.test(line)) fail(`[路径进 Markdown] ${rel}:${i + 1} 把文件路径直接拼进 Markdown 图片：${line.trim().slice(0, 120)}`);
  });
}
// 表情工具必须使用 dshsticker 引用
const pluginIndex = read(path.join(ROOT, 'backend', 'lib', 'index.js'));
const stickerBlock = (() => {
  const m = /name:\s*'sticker_send'[\s\S]{0,1200}?return\s*\{\s*text:\s*`([^`]*)`/.exec(pluginIndex);
  return m ? m[1] : '';
})();
if (!stickerBlock) fail('找不到 sticker_send 的返回值');
else if (!stickerBlock.includes('dshsticker:')) fail(`sticker_send 返回的 Markdown 不含 dshsticker: 引用（可能把本机路径写进消息）：${stickerBlock}`);
else ok('sticker_send 使用 dshsticker: 引用（不含本机路径）');

// 桥接必须能解析 dshsticker 引用
if (!/dshsticker:/.test(src)) fail('src/bridge.js 没有解析 dshsticker: 引用');
else ok('src/bridge.js 能解析 dshsticker: 引用');

// ── 5) 行为级：路径脱敏真实用例（防止正则改坏 / 误伤正常网址）────────────
const REDACT_CASES = [
  ['盘符路径', '文件在 C:\\Documents\\app\\config.json 里面', '文件在 [本机路径已隐藏] 里面'],
  ['小写盘符', 'd:\\data\\x.txt', '[本机路径已隐藏]'],
  ['正斜杠', 'C:/Documents/a.gif', '[本机路径已隐藏]'],
  ['file URL', 'file:///C:/Documents/a.gif', '[本机路径已隐藏]'],
  ['UNC', '\\\\server\\share\\x.txt', '[本机路径已隐藏]'],
  ['http 不误伤', '看这个 https://example.com/a?b=1 和 http://127.0.0.1:3000/x', '看这个 https://example.com/a?b=1 和 http://127.0.0.1:3000/x'],
  ['普通文本', '你好呀，今天吃了吗？', '你好呀，今天吃了吗？'],
];
for (const [name, input, expect] of REDACT_CASES) {
  const got = redactLocalPaths(input);
  if (got !== expect) fail(`[路径脱敏行为] ${name}: 期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(got)}`);
}
ok(`路径脱敏行为用例 ${REDACT_CASES.length} 条`);

// ── 6) 工具注册 × 桥接白名单对账：插件注册的每个模型侧工具必须在
//      qq-tool-restrict 的 SAFE_EXACT 白名单里，否则 guard 会把它拦死——
//      2026-11-09 事故：sticker_search/sticker_send 注册后没进白名单，
//      表情包功能全天「被拦下来」。
{
  const restrictSrc = read(path.join(ROOT, 'backend', 'qq-tool-restrict.mjs'));
  const exactBlock = /const SAFE_EXACT = new Set\(\[([\s\S]*?)\]\)/.exec(restrictSrc);
  const whitelist = new Set(
    exactBlock
      ? [...exactBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
      : []
  );
  if (!whitelist.size) fail('解析 qq-tool-restrict.mjs 的 SAFE_EXACT 白名单失败');
  const pluginIndexSrc = read(path.join(ROOT, 'backend', 'lib', 'index.js'));
  const registered = [...pluginIndexSrc.matchAll(/scope\.tools\.register\(\s*\{\s*name:\s*'([^']+)'/g)].map((m) => m[1]);
  if (!registered.length) fail('backend/lib/index.js 里找不到 scope.tools.register（插件工具注册被移走？对账逻辑要跟着改）');
  for (const name of registered) {
    if (!whitelist.has(name)) fail(`[工具未进白名单] 插件注册了 "${name}" 但 qq-tool-restrict SAFE_EXACT 没有 → 运行时会被 guard 拦死`);
    else ok(`工具 ${name} 已在桥接白名单`);
  }
}

// ── 7) 表情限额：所有发表情入口必须查同一份限额 ───────────────────────
//     2026-11-10 事故：限额只在「自动补发」里查，sticker_send / [sticker:] / 抖音
//     全部绕过；QQ 和抖音还各用一份 state.json，等于两边各算一份额度。
{
  const nekoSrc = read(path.join(ROOT, 'src', 'nekowhale-stickers.mjs'));
  if (!/return\s*\{[^}]*canSend/.test(nekoSrc)) fail('[表情限额] nekowhale-stickers.mjs 没有导出 canSend');
  else ok('nekowhale-stickers.mjs 导出 canSend');
  if (!/return\s*\{[^}]*markSent/.test(nekoSrc)) fail('[表情限额] nekowhale-stickers.mjs 没有导出 markSent');
  else ok('nekowhale-stickers.mjs 导出 markSent');
  const afterReplyBody = /async function afterReply[\s\S]*?\n  \}/.exec(nekoSrc)?.[0] ?? '';
  if (!/canSend\(/.test(afterReplyBody) || !/markSent\(/.test(afterReplyBody)) {
    fail('[表情限额] afterReply 没有走 canSend/markSent（自动补发会绕过限额）');
  } else ok('afterReply 走 canSend/markSent');

  const refBody = /async function sendStickerRef[\s\S]*?\n  \}/.exec(src)?.[0] ?? '';
  if (!refBody) fail('[表情限额] 找不到 sendStickerRef');
  else if (!/canSend\(/.test(refBody) || !/markSent\(/.test(refBody)) {
    fail('[表情限额] sendStickerRef（[sticker:] 兜底）没有走 canSend/markSent');
  } else ok('sendStickerRef 走 canSend/markSent');

  const stickerImageBody = /else if \(\/\^dshsticker:[\s\S]*?bytes = fs\.readFileSync\(found\);/.exec(src)?.[0] ?? '';
  if (!stickerImageBody) fail('[表情限额] 找不到 sendMarkdownImage 的 dshsticker 分支');
  else if (!/canSend\(/.test(stickerImageBody)) {
    fail('[表情限额] sendMarkdownImage 发 dshsticker 前没有查 canSend（sticker_send 会绕过限额）');
  } else ok('sticker_send 的图片发送走 canSend');

  if (!/nekoStickers\.afterReply\(/.test(src)) fail('[表情限额] QQ 自动补发没有调用 afterReply');
  else ok('QQ 自动补发走 afterReply');

  const douyinSrc = read(path.join(ROOT, 'backend', 'lib', 'douyin-im.js'));
  if (!/neko\.afterReply\(/.test(douyinSrc)) fail('[表情限额] 抖音补发没有调用 afterReply');
  else ok('抖音补发走 afterReply');
  if (!/'qq',\s*'state',\s*'nekowhale-cache'/.test(douyinSrc)) {
    fail('[表情限额] 抖音没有和 QQ 共用 state 目录（额度会被分成两份）');
  } else ok('抖音与 QQ 共用表情 state 目录');
}

// ── 8) 活人感开关：设置页写了必须有消费方 ──────────────────────────────
//     2026-11-10 审计发现 humanize.cleanReply 只写不读（开关形同虚设），
//     burstBrake 也只覆盖了 sendToQQ 一条路径。
{
  if (!/humanize\?\.cleanReply\s*!==\s*false/.test(src)) {
    fail('[活人感] humanize.cleanReply 没有被消费（设置页开关会失效）');
  } else ok('humanize.cleanReply 已被消费');
  const douyinSrc = read(path.join(ROOT, 'backend', 'lib', 'douyin-im.js'));
  if (!/cleanReply\s*!==\s*false/.test(douyinSrc)) {
    fail('[活人感] 抖音没有消费 cleanReply（和 QQ 的开关会不一致）');
  } else ok('抖音也消费 cleanReply');
  const brakePaths = ['sendToQQ', 'sendBurstToQQ', 'sendMessagesV2'];
  for (const fn of brakePaths) {
    const start = lines.findIndex((l) => new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`).test(l));
    if (start < 0) continue;
    let end = lines.length - 1;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s{0,4}(?:async\s+)?function\s+[A-Za-z_$]/.test(lines[i])) { end = i - 1; break; }
    }
    const body = lines.slice(start, end + 1).join('\n');
    if (!/humanize\?\.burstBrake\s*!==\s*false/.test(body)) fail(`[活人感] ${fn} 没有消费 burstBrake（分段刹车只覆盖部分发送路径）`);
    else ok(`${fn} 已消费 burstBrake`);
  }
}

// ── 结果 ──────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  ok   ${n}`);
if (failures.length) {
  console.error('\n出站安全审计失败：');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\n✔ 出站安全审计通过：发送入口收敛、路径脱敏、图片剥离、表情引用均符合不变式。');
