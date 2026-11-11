/**
 * 模型回复的**唯一出站管道**（QQ / 抖音 / AstrBot 旁路 / 直连 QQ 共用）。
 *
 * 为什么要有这个文件：
 *   以前每个发送入口各写一份清洗：sendToQQ、sendBurstToQQ、sendMessagesV2、
 *   sendGroupWithAt、douyin-im、dfy-raw-chat…… 结果同一个模型输出问题（全角 Markdown、
 *   [sticker:] 标记、空行、句号、客服腔、「没叫我，不接」）要在每个入口各修一次，
 *   修了 QQ 漏了抖音，就成了「爆一个打一次补丁」。
 *
 * 收口后：
 *   · 所有平台只调 prepareReply()，不再自己写正则；
 *   · 新增一个问题 → 在 reply-cleanup / 本文件修一次 + 在
 *     widget/tools/outbound-pipeline-audit.mjs 加一条用例；
 *   · 发送入口只负责「怎么发」（文本段 / 图片 / 表情），不再负责「发什么」。
 */
import { humanizeReplyText, looksLikeSilenceDecision, normalizeFullWidthMarkdown } from './reply-cleanup.mjs';
import { redactLocalPaths } from './redact-paths.mjs';

/** 模型自写的假表情标记：[sticker:开心] / [表情:委屈] */
const STICKER_TAG_RE = /\[(?:sticker|表情)[:：]\s*([^\]\n]{1,40})\]/gi;
/** Markdown 图片行：允许 ] 和 ( 之间有空格（GLM 等模型常这么写）。 */
const MD_IMAGE_RE = /!\[[^\]]*\]\s*\(([^)]+)\)/g;

export function takeStickerTags(input) {
  const refs = [];
  const text = String(input ?? '').replace(STICKER_TAG_RE, (_match, ref) => {
    const value = String(ref ?? '').trim();
    if (value) refs.push(value);
    return '';
  });
  return { text, refs };
}

/**
 * 回复里是否已经有 Markdown 图片（含全角/空格写法）。
 * 「自动补表情」用它判断是否让位，避免和模型自己发的图撞两张。
 * 注意：这里必须先归一全角——模型写 `！[x]（dshsticker:…）` 时，
 * 只认半角会让自动补发以为「没图」再补一张（2026-11-11 回归测试抓到的）。
 */
export function hasMarkdownImage(input) {
  const normalized = normalizeFullWidthMarkdown(input);
  MD_IMAGE_RE.lastIndex = 0;
  const hit = MD_IMAGE_RE.test(normalized);
  MD_IMAGE_RE.lastIndex = 0;
  return hit;
}

/** 回复里是否已经有 [sticker:名字] 标记（同样兼容全角冒号）。 */
export function hasStickerTag(input) {
  STICKER_TAG_RE.lastIndex = 0;
  const hit = STICKER_TAG_RE.test(String(input ?? ''));
  STICKER_TAG_RE.lastIndex = 0;
  return hit;
}

export function takeMarkdownImages(input) {
  const images = [];
  const text = String(input ?? '').replace(MD_IMAGE_RE, (_match, url) => {
    const value = String(url ?? '').trim();
    if (value) images.push(value);
    return '';
  });
  return { text, images };
}

/**
 * 按标点截断到 max 字。优先在标点处断；找不到合适断点才硬切。
 * @param {string} input
 * @param {number} max
 * @param {{collapseLines?:boolean}} [opts]
 */
export function capText(input, max, { collapseLines = false } = {}) {
  let text = String(input ?? '');
  if (collapseLines) text = text.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ');
  text = text.trim();
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  const head = text.slice(0, limit);
  const at = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('；'), head.lastIndexOf('，'), head.lastIndexOf(' '),
  );
  if (at >= Math.min(24, Math.floor(limit * 0.3))) return head.slice(0, at + 1).trim();
  return `${head.slice(0, limit - 1).trim()}…`;
}

/**
 * 统一处理模型回复。
 *
 * @param {string} input 模型原始输出
 * @param {object} [opts]
 * @param {'qq'|'douyin'|'astrbot'} [opts.platform] 平台差异（抖音去 Markdown、AstrBot 不发图）
 * @param {boolean} [opts.group] 是否群聊（影响沉默判定与默认限长）
 * @param {boolean} [opts.cleanClutter] 是否清客服腔（对应设置里的「活人感」）
 * @param {number} [opts.maxChars] 0/不传 = 不限；群聊一般 80
 * @param {boolean} [opts.stripPaths] 是否做本机路径脱敏（群聊/公开场合必须开）
 * @param {boolean} [opts.allowSilence] 是否允许「不接」判定（只对模型回复开）
 * @param {(text:string)=>string} [opts.transform] 平台自己的额外处理（如 token 脱敏）
 * @returns {{text:string, images:string[], stickerRefs:string[], silent:boolean}}
 */
export function prepareReply(input, {
  platform = 'qq',
  group = false,
  cleanClutter = true,
  maxChars = 0,
  stripPaths = false,
  allowSilence = false,
  transform = null,
} = {}) {
  // 1) 假表情标记必须先抽走，humanize 会把它们删掉，删掉就拿不到名字补真图了。
  const sticker = takeStickerTags(input);
  let text = sticker.text;
  // 2) 平台自己的预处理（桥接的 token 脱敏要在 humanize 前做）。
  if (typeof transform === 'function') text = transform(text);
  // 3) 通用清洗：全角 Markdown 归一、客服腔、句号、空行、AI 味、附和开场。
  text = humanizeReplyText(text, { cleanClutter });
  // 4) 抖音不接受 Markdown 格式字符。
  if (platform === 'douyin') {
    text = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*#`>_~]/g, '')
      .replace(/\r/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }
  // 5) 抽图片行（AstrBot 只支持纯文本，抽出来直接丢弃）。
  const md = takeMarkdownImages(text);
  text = md.text;
  // 6) 限长：群聊默认 80 字，单行显示；私聊/讲解按调用方传。
  if (maxChars > 0) text = capText(text, maxChars, { collapseLines: group });
  // 7) 公开场合脱敏。
  if (stripPaths) text = redactLocalPaths(text);
  // 8) 只对模型回复判定沉默：决定文本不能发到群里（私聊不判）。
  const silent = allowSilence && group && looksLikeSilenceDecision(text);
  return {
    text,
    images: platform === 'astrbot' ? [] : md.images,
    stickerRefs: sticker.refs,
    silent,
  };
}
