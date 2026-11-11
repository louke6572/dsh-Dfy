/**
 * 「今天」的唯一口径（北京时间）—— 全项目唯一实现。
 *
 * 为什么单独一个文件：这个项目里「今天」曾被至少十处各自实现：
 *   · token-budget / humanize-gate / 抖音        —— Intl 北京时间
 *   · memory-card / tieba / automation / scheduler —— 本机时区
 *   · bili-memory / bili-share-scheduler          —— 本机时区
 * 只要用户时区不是 UTC+8（出差、系统时区没设对、云主机），
 * 「额度按今天重置」和「读今天的用量」就会落到不同的日期上，
 * 表现为「明明没用多少却额度已满」「日报里今天的数据对不上」这类说不清的问题。
 *
 * 统一成北京时间：插件所有「按天」的东西（额度、限额、日报、记账、记忆衰减）都用它。
 */
const BEIJING_OFFSET_MS = 8 * 3600_000;

/** @param {number|Date} [now] @returns {string} YYYY-MM-DD（北京时间） */
export function dayKey(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  if (Number.isNaN(date.getTime())) return dayKey(Date.now());
  // 直接按 UTC+8 平移再取 UTC 日期：不依赖运行环境时区，也不用 Intl（更便宜）。
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 北京时间当天 00:00 的时间戳（毫秒）。 */
export function dayStartMs(now = Date.now()) {
  const date = now instanceof Date ? now : new Date(Number(now));
  const [y, m, d] = dayKey(date).split('-').map(Number);
  // 北京 00:00 = 前一日 UTC 16:00
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0) - BEIJING_OFFSET_MS;
}
