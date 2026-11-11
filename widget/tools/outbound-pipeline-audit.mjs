#!/usr/bin/env node
/**
 * 出站管道回归测试（outbound pipeline）。
 *
 * 为什么有这个文件：
 *   2026-11-11 用户原话——「为什么现在变成穷举问题了？修复也是穷举，爆一个打一次补丁？」
 *   根因是每个发送入口各写一份清洗。收口到 src/outbound-reply.mjs 之后，
 *   这里把**每一个真实报过的问题**固化成一条用例：以后换模型 / 改正则，
 *   跑一次就知道有没有回归，不用再靠人一条一条撞出来。
 *
 * 结构：
 *   A. 行为用例：输入模型原文 → 断言管道输出（含 images / stickerRefs / silent）
 *   B. 结构断言：所有出站模块必须走同一个管道，不许再自带一份清洗正则
 *
 * 0 依赖，`npm install` 之前也能跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareReply, capText, hasMarkdownImage, hasStickerTag, takeMarkdownImages, takeStickerTags } from '../../src/outbound-reply.mjs';
import { humanizeReplyText, looksLikeSilenceDecision } from '../../src/reply-cleanup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];
const notes = [];

function ok(msg) { notes.push(msg); }
function fail(msg) { failures.push(msg); }
function eq(actual, expected, label) {
  if (actual === expected) ok(label);
  else fail(`${label}\n     期望：${JSON.stringify(expected)}\n     实际：${JSON.stringify(actual)}`);
}
function truthy(value, label) {
  if (value) ok(label);
  else fail(label);
}

// ── A. 行为用例（都来自真实报障）────────────────────────────────────────

// A1. 车轱辘话：模型在工具回合先写一句、最终回复再写同一句。这是 collector 的问题，
//     管道只需保证不把同一句拼两遍（这里守「原样只出现一次」）。
{
  const out = prepareReply('刚忙完就来找我，那我岂不是很幸运', { platform: 'qq' }).text;
  const hits = out.split('刚忙完就来找我').length - 1;
  eq(hits, 1, 'A1 同一句不会在出站时被拼成两遍');
}

// A2. [sticker:xx] 文字漏进聊天（外部插件约定，桥接不认）
{
  const r = prepareReply('好的[sticker:开心]走吧', { platform: 'qq' });
  eq(r.text.includes('[sticker'), false, 'A2 [sticker:] 标记不会进正文');
  eq(r.stickerRefs.join(','), '开心', 'A2 [sticker:] 被抽成表情引用');
}
{
  const r = prepareReply('好呀[表情：委屈]', { platform: 'qq' });
  eq(r.text, '好呀', 'A2 [表情：] 全角冒号同样被抽走');
  eq(r.stickerRefs.join(','), '委屈', 'A2 [表情：] 抽成引用');
}

// A3. 空行分段（一句话、空一行、再一句）
{
  const out = humanizeReplyText('第一句\n\n第二句');
  eq(out, '第一句\n第二句', 'A3 空行被压成一个换行');
}

// A4. 句号：人格卡要求不用句号收尾
{
  eq(humanizeReplyText('今天挺累的。'), '今天挺累的', 'A4 句末句号被去掉');
  eq(humanizeReplyText('甲。乙。'), '甲，乙', 'A4 句中句号换成逗号');
}

// A5. AI 味自我点评：「这个梗我能接住 / 我 get 到了」
{
  eq(humanizeReplyText('行吧，这个我能接住'), '行吧', 'A5 句尾「我能接住」被清掉');
  eq(humanizeReplyText('这个梗我能接住'), '？', 'A5 整条只有自我点评时换成「？」');
  eq(humanizeReplyText('球我接住了'), '球我接住了', 'A5 真实语义的「接住」不被误伤');
}

// A6. 固定附和开场：「确实 / 就是 / 对 / 嗯」开头
{
  eq(humanizeReplyText('确实，现在年轻人干不下来那个的太多了'), '现在年轻人干不下来那个的太多了', 'A6 「确实，」开场被去掉');
  eq(humanizeReplyText('嗯'), '嗯', 'A6 单字「嗯」保留');
  eq(humanizeReplyText('对'), '对', 'A6 单字「对」保留');
}

// A7. 客服腔
{
  const off = humanizeReplyText('作为一个AI，希望对你有所帮助', { cleanClutter: false });
  truthy(/作为一个AI/.test(off), 'A7 cleanClutter=false 时保留客服腔（设置开关生效）');
  const on = humanizeReplyText('作为一个AI，希望对你有所帮助', { cleanClutter: true });
  eq(/作为一个AI|希望对你有所帮助/.test(on), false, 'A7 客服腔被清掉');
}

// A8. GLM 全角 Markdown 图片 → 表情乱码
{
  const r = prepareReply('噫！[噫]（dshsticker:11N03%E5%99%AB.gif）', { platform: 'qq' });
  eq(r.images[0], 'dshsticker:11N03%E5%99%AB.gif', 'A8 全角 Markdown 被归一成图片引用');
  eq(r.text.includes('dshsticker'), false, 'A8 正文里不再残留 dshsticker 语法');
}
{
  hasMarkdownImage('![噫]（dshsticker:x.gif）') === true
    ? ok('A8 hasMarkdownImage 认全角写法（自动补表情会让位）')
    : fail('A8 hasMarkdownImage 不认全角写法，会和模型自己发的图撞两张');
}

// A9. 群聊甩小作文（≤80 字）
{
  const long = '这个事吧'.repeat(40);
  const out = prepareReply(long, { platform: 'qq', group: true, maxChars: 80 }).text;
  truthy(out.length <= 81, `A9 群聊回复被限长（实际 ${out.length} 字）`);
  eq(out.includes('\n'), false, 'A9 群聊限长后压成单行');
}
{
  // 短文本不该被截断
  const short = '排到马路就有点夸张了';
  eq(capText(short, 80), short, 'A9 短回复不受限长影响');
  // 优先在标点处截断，不切半个词
  const cut = capText('一二三四五六七八九十，后面还有很长的内容需要被截掉才行哦'.repeat(3), 30);
  truthy(cut.length <= 31, `A9 长句按标点截断（${cut.length} 字）`);
}

// A10. 群里回「没叫我，不接」
{
  const r = prepareReply('群里没叫我，不接话', { platform: 'qq', group: true, allowSilence: true });
  eq(r.silent, true, 'A10 群聊「没叫我，不接」被判定为沉默');
  const p = prepareReply('群里没叫我，不接话', { platform: 'qq', group: false, allowSilence: true });
  eq(p.silent, false, 'A10 私聊不做沉默判定');
  const keep = prepareReply('没叫我啊', { platform: 'qq', group: true, allowSilence: true });
  eq(keep.silent, false, 'A10 「没叫我啊」这种正常接话不被误杀');
}

// A11. 抖音去 Markdown
{
  const r = prepareReply('**真的**好啊 # 标签 ```code```', { platform: 'douyin' });
  eq(/[*#`]/.test(r.text), false, 'A11 抖音输出不含 Markdown 字符');
}

// A12. AstrBot 只收纯文本：图片引用必须丢弃，不能漏成文字
{
  const r = prepareReply('给你 ![噫](dshsticker:x.gif) 看图', { platform: 'astrbot' });
  eq(r.images.length, 0, 'A12 astrbot 不返回图片（发不了）');
  eq(r.text.includes('dshsticker'), false, 'A12 astrbot 正文不残留图片语法');
}

// A13. 本机路径脱敏
{
  const r = prepareReply('文件在 C:\\Users\\someone\\secret.txt', { platform: 'qq', group: true, stripPaths: true });
  eq(/C:\\\\Users|C:\\Users/.test(r.text), false, 'A13 群聊出站不含本机路径');
}

// A14. 幂等：管道跑两遍结果不变（避免二次清洗把内容吃掉）
{
  const once = prepareReply('确实，今天真累。', { platform: 'qq' }).text;
  const twice = prepareReply(once, { platform: 'qq' }).text;
  eq(twice, once, 'A14 管道幂等');
}

// A15. 工具函数边界
{
  eq(takeMarkdownImages('无图').images.length, 0, 'A15 无图返回空数组');
  eq(takeStickerTags('无标记').refs.length, 0, 'A15 无标记返回空数组');
  eq(hasStickerTag('[表情:委屈]'), true, 'A15 hasStickerTag 认全角冒号');
  eq(hasStickerTag('普通文字'), false, 'A15 hasStickerTag 不误判普通文字');
  eq(looksLikeSilenceDecision('（沉默）'), true, 'A15 括注式沉默被识别');
  eq(looksLikeSilenceDecision('确实，那我也不接了'), false, 'A15 有内容的「不接」不误判');
}

// ── B. 结构断言：所有出站模块必须走同一个管道 ─────────────────────────

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; }
}

// B1. 管道本身必须存在且导出关键函数
{
  const src = read('src/outbound-reply.mjs');
  for (const name of ['prepareReply', 'capText', 'takeStickerTags', 'takeMarkdownImages', 'hasMarkdownImage', 'hasStickerTag']) {
    src.includes(`export function ${name}`) || src.includes(`export const ${name}`)
      ? ok(`B1 outbound-reply 导出 ${name}`)
      : fail(`B1 outbound-reply 缺少导出 ${name}`);
  }
}

// B2. 每个「模型输出直发聊天」的模块必须 import prepareReply
const PIPELINE_CONSUMERS = [
  { file: 'src/bridge.js', label: 'QQ 桥接（4 条发送路径）' },
  { file: 'backend/lib/douyin-im.js', label: '抖音 IM' },
  { file: 'backend/lib/dfy-raw-chat.js', label: 'AstrBot 旁路' },
  { file: 'backend/lib/qq-direct.js', label: '直连 QQ（路线 B 兜底）' },
  { file: 'backend/lib/pet-chat.js', label: '桌宠对话' },
];
for (const { file, label } of PIPELINE_CONSUMERS) {
  const src = read(file);
  if (!src) { fail(`B2 找不到 ${file}`); continue; }
  src.includes('outbound-reply.mjs')
    ? ok(`B2 ${label} 走统一出站管道`)
    : fail(`B2 ${label} 没有 import outbound-reply.mjs（又会各自写一份清洗）`);
}

// B3. 不允许在出站模块里再手写 Markdown 图片正则（必须用共享的）
{
  const offenders = [];
  for (const { file, label } of PIPELINE_CONSUMERS) {
    const src = read(file);
    if (!src) continue;
    // 允许注释里提到；只有真的写正则才算违规
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/!\\\[\[|!\[\\?\]\*\?/.test(line) === false) return;
      if (/const MD_IMAGE_RE/.test(line)) return;
      offenders.push(`${label}:${i + 1}`);
    });
  }
  offenders.length === 0
    ? ok('B3 出站模块没有自写 Markdown 图片正则')
    : fail(`B3 出站模块仍有自写正则：${offenders.join(', ')}`);
}

// B4. 群聊限长必须只作用于模型回复（系统提示/错误通知不能被截）
{
  const src = read('src/bridge.js');
  const groupCapCalls = (src.match(/groupCap: true/g) || []).length;
  groupCapCalls >= 2
    ? ok(`B4 群聊限长由调用方按「模型回复」显式开启（${groupCapCalls} 处）`)
    : fail('B4 群聊限长没有按调用方区分，可能把系统提示也截断');
}

// B5. 抖音 / AstrBot 的沉默判定必须共用同一份（不能各写各的）
{
  const dy = read('backend/lib/douyin-im.js');
  dy.includes('allowSilence: true')
    ? ok('B5 抖音沉默判定走管道')
    : fail('B5 抖音没有启用管道里的沉默判定');
}

// ── 结果 ──────────────────────────────────────────────────────────────

for (const n of notes) console.log(`  ok   ${n}`);
if (failures.length) {
  console.error('\n出站管道回归失败：');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\n✔ 出站管道回归通过（${notes.length} 条）。`);
