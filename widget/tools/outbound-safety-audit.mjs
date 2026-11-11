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

// ── 2) 每个文本入口必须走统一出站管道 ──────────────────────────────────
//     2026-11-11 收口：清洗不再各写一份，统一在 src/outbound-reply.mjs 的 prepareReply()。
//     这里只守「入口有没有接管道」；管道内部的行为由 outbound-pipeline-audit.mjs 逐条回归。
const PIPELINE_ENTRIES = ['sendToQQ', 'sendBurstToQQ', 'sendGroupWithAt', 'sendMessagesV2'];
for (const fn of PIPELINE_ENTRIES) {
  const start = lines.findIndex((l) => new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`).test(l));
  if (start < 0) { fail(`找不到函数 ${fn}`); continue; }
  let end = lines.length - 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{0,4}(?:async\s+)?function\s+[A-Za-z_$]/.test(lines[i])) { end = i - 1; break; }
  }
  const body = lines.slice(start, end + 1).join('\n');
  if (!body.includes('prepareReply(')) {
    fail(`[未接管] ${fn} 没有走 prepareReply()：又会各自写一份清洗，问题只在部分平台修好`);
  } else ok(`${fn} 走统一出站管道`);
}

// ── 3) 不允许把本地路径拼进 Markdown 图片 ─────────────────────────────
const SOURCE_DIRS = ['src', 'backend', 'packages/dsh-dfy-core'].map((d) => path.join(ROOT, d));
// 桥接之外的三个「模型输出直发外部聊天」旁路也必须接管道（脱敏在管道里做）：
//   qq-direct（路线 B 兜底直发 QQ）、douyin-im（抖音回复）、dfy-raw-chat（回复经 AstrBot 发 QQ）
const BYPASS_FILES = [
  { file: path.join(ROOT, 'backend', 'lib', 'qq-direct.js'), label: 'qq-direct（直发 QQ）' },
  { file: path.join(ROOT, 'backend', 'lib', 'douyin-im.js'), label: 'douyin-im（抖音回复）' },
  { file: path.join(ROOT, 'backend', 'lib', 'dfy-raw-chat.js'), label: 'dfy-raw-chat（经 AstrBot 发 QQ）' },
  { file: path.join(ROOT, 'backend', 'lib', 'pet-chat.js'), label: 'pet-chat（桌宠气泡）' },
];
for (const { file, label } of BYPASS_FILES) {
  const text = read(file);
  if (!text.includes('outbound-reply.mjs') || !text.includes('prepareReply(')) {
    fail(`[旁路未接管] ${label} 没有走 prepareReply()：脱敏/去 AI 味会再次漏在这条路上`);
  } else ok(`${label} 走统一出站管道`);
}
// 管道自己的承诺：脱敏开关必须真的调用 redactLocalPaths。
{
  const pipe = read(path.join(ROOT, 'src', 'outbound-reply.mjs'));
  if (!/stripPaths[\s\S]{0,200}redactLocalPaths\(/.test(pipe)) {
    fail('[管道脱敏] outbound-reply 的 stripPaths 没有调用 redactLocalPaths()');
  } else ok('管道的 stripPaths 会做本机路径脱敏');
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

// ── 9) 回合文本：只保留最后一段，避免跨 step 车轱辘话 ─────────────────
//     工具回合里模型常在 tool-call 那步先说一句，拿到结果后又把同一句写进最终回复；
//     collector 若按 step 累加，QQ 上就会收到「同一句话两遍」。
{
  const clientSrc = read(path.join(ROOT, 'src', 'dsh-client.js'));
  const body = /export function createTurnCollector[\s\S]*?\n\}/.exec(clientSrc)?.[0] ?? '';
  if (!body) fail('[回合文本] 找不到 createTurnCollector');
  else if (/t\.text\s*\+=/.test(body)) {
    fail('[回合文本] createTurnCollector 又在跨 step 累加文本（会出现车轱辘话）');
  } else ok('createTurnCollector 只保留最后一段文本');
}

// ── 10) 抖音人格：跟 preset 的 system prompt 走，不进对话正文 ───────────
//     人格已烘焙进 douyin-chat preset；人格版本变了（或老会话没有记录）时
//     直接换新会话，而不是每轮把整段身份卡塞进用户消息。
{
  const douyinSrc = read(path.join(ROOT, 'backend', 'lib', 'douyin-im.js'));
  if (!/persona-seen\.json/.test(douyinSrc)) {
    fail('[人格注入] 抖音没有 persona-seen 记录（无法判断会话人格版本）');
  } else if (/douyinPersonaBlock|personaCore/.test(douyinSrc)) {
    fail('[人格注入] 抖音又往对话正文里注入人格（输入会越滚越大）');
  } else if (!/readPersonaSeen\(\)\[key\] !== personaVersion/.test(douyinSrc)) {
    fail('[人格注入] 人格版本变了没有换新会话（新人格不会生效）');
  } else ok('抖音人格跟 preset 走，版本变了直接换新会话');
}

// ── 11) 抖音图片 / QQ 离线消息 / AI 味旁白 ─────────────────────────────
//     2026-11-11 用户反馈：
//       · 抖音发图/表情机器人没反应（textOf 返回空串，整条消息被丢掉）；
//       · DSH 退出后 QQ 私聊/群聊消息丢失（队列只在内存、没有离线补课）；
//       · 回复出现「这个我能接住」这类自我点评（提示词没有约束、出站也没清洗）。
{
  const douyinSrc = read(path.join(ROOT, 'backend', 'lib', 'douyin-im.js'));
  if (!/content\.kind === 'image'/.test(douyinSrc)) {
    fail('[抖音图片] textOf 没有处理 image 类型（图片消息会被当成空消息丢掉）');
  } else if (!/collectDouyinMedia\(batch\)/.test(douyinSrc)) {
    fail('[抖音图片] 回复前没有调用 collectDouyinMedia（图不会交给看图模型）');
  } else if (!/decryptDouyinImage\(/.test(douyinSrc)) {
    fail('[抖音图片] 缺少图片解密（抖音图片是 AES-GCM 加密的）');
  } else ok('抖音图片/表情会下载解密并交给看图模型');

  if (!/pending-prompts\.json/.test(src) || !/loadQueued\(\)/.test(src) || !/saveQueued\(\)/.test(src)) {
    fail('[离线消息] QQ 待投递队列没有落盘（DSH 退出时排队消息会丢）');
  } else if (!/chat-history-cursor\.json/.test(src) || !/runChatHistoryCatchUp\(/.test(src)) {
    fail('[离线消息] 内置版没有离线历史补课（DSH 关闭期间的消息不会补回来）');
  } else ok('QQ 待投递队列落盘 + 内置版离线历史补课');

  const cleanupSrc = read(path.join(ROOT, 'src', 'reply-cleanup.mjs'));
  if (!/metaTail/.test(cleanupSrc)) {
    fail('[AI 味] reply-cleanup 没有清理「我能接住 / 我 get 到了」这类自我点评');
  } else if (!/agreeOpen/.test(cleanupSrc)) {
    fail('[AI 味] reply-cleanup 没有清理「确实 / 就是 / 对 / 嗯」这类固定附和开场');
  } else ok('回复会清掉「我能接住」类自我点评与固定附和开场');

  // 群聊啰嗦：模型回复必须限长，且只对 agent 回复生效（系统提示不能被截断）。
  if (!/capGroupReply|capText/.test(src)) {
    fail('[群聊啰嗦] 缺少群聊限长（群聊小作文会原样发出去）');
  } else if (!/groupCap: true/.test(src)) {
    fail('[群聊啰嗦] 普通回复没有启用 groupCap');
  } else ok('群聊模型回复会限长（≤80 字，按标点截断）');

  // 抖音群聊：要有和 QQ 同源的接话意愿/攒一攒，以及群聊短回复。
  if (!/createHumanizeGate/.test(douyinSrc)) {
    fail('[抖音群聊] 没有接入 humanize 接话意愿（关掉「只被叫才回」后会每条都回）');
  } else if (!/groupMentionOnly === false/.test(douyinSrc) || !/gatherDelayMs\(/.test(douyinSrc)) {
    fail('[抖音群聊] 缺少群聊接话意愿或攒一攒');
  } else if (!/maxChars: conversation\.isGroup \? 80/.test(douyinSrc)) {
    fail('[抖音群聊] 群聊回复没有单独限长');
  } else ok('抖音群聊有接话意愿/攒一攒，群聊回复更短');

  // 设置页必须能关掉温柔模式（否则用户只能在 config.json 里改）。
  const qqPage = read(path.join(ROOT, 'lib', 'ui', 'pages', '90-qq.js'));
  if (!/admin", "gentle"/.test(qqPage)) {
    fail('[设置页] QQ 页没有「温柔模式」开关（用户找不到，也关不掉）');
  } else ok('QQ 页有「温柔模式」开关');

  // 模型把「不接」的内心决定当话说出来时，必须拦在群聊出站之前。
  if (!/export function looksLikeSilenceDecision/.test(cleanupSrc)) {
    fail('[沉默判定] reply-cleanup 没有 looksLikeSilenceDecision');
  } else if (!/isSilenceDecision\(plain\)/.test(src)) {
    fail('[沉默判定] QQ 群聊没有拦「没叫我，不接」这类决定文本');
  } else if (!/allowSilence: true/.test(douyinSrc) || !/prepared\.silent/.test(douyinSrc)) {
    fail('[沉默判定] 抖音群聊没有拦「没叫我，不接」这类决定文本');
  } else ok('群聊会拦「没叫我，不接」这类决定文本');

  // 表情引用：模型可能写全角 Markdown，抖音也必须把 dshsticker 变成真图而不是文字。
  if (!/normalizeFullWidthMarkdown/.test(cleanupSrc)) {
    fail('[表情引用] reply-cleanup 没有归一全角 Markdown 图片（GLM 会把 ![..]（..） 当文字发出去）');
  } else if (!/sendDouyinImages\(/.test(douyinSrc) || !/prepared\.images/.test(douyinSrc)) {
    fail('[表情引用] 抖音没有把 dshsticker Markdown 抽出来发真图');
  } else ok('全角 Markdown 会归一，抖音的 dshsticker 引用会发真图');
}

// ── 结果 ──────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  ok   ${n}`);
if (failures.length) {
  console.error('\n出站安全审计失败：');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\n✔ 出站安全审计通过：发送入口收敛、路径脱敏、图片剥离、表情引用均符合不变式。');
