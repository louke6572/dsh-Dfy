/**
 * 跨平台近况摘要：把各平台最近的事件从统一 inbox 里读出来，注入到每个平台的人设提示里。
 *
 * 为什么需要：记忆卡要等整理器把 inbox 合并进卡，才有跨平台内容；整理器默认关闭时
 * （省 token），QQ 和抖音就会「各聊各的」，记忆卡里也看不到刚发生的事。
 * 这里直接读 inbox 的最近 N 条做一份短摘要，保证四个平台立刻能看到彼此最近说过什么。
 *
 * 隐私：公开平台（抖音群聊 / B站 / 贴吧）只带公开事件，QQ 私聊细节不出现；
 * 管理员自己的 QQ 私聊才给全量。
 */
import fs from 'node:fs';

const DEFAULT_SINCE_MS = 12 * 3600_000;
const MAX_BYTES = 256 * 1024;

function labelOf(conversationKey = '') {
  const key = String(conversationKey);
  if (key.startsWith('douyin:')) return '抖音';
  if (key.startsWith('pet')) return '桌宠';
  if (key.startsWith('bili') || key.startsWith('group:bili')) return 'B站';
  if (key.startsWith('private:') || key.startsWith('group:')) return 'QQ';
  return '';
}

function hhmm(iso) {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

/**
 * @param {{inboxFile: string, limit?: number, includePrivate?: boolean, excludePlatform?: string,
 *          sinceMs?: number, maxChars?: number, now?: number, maxAgeHours?: number}} options
 */
export function recentCrossPlatformDigest({
  inboxFile,
  limit = 12,
  includePrivate = false,
  excludePlatform = '',
  sinceMs = DEFAULT_SINCE_MS,
  maxChars = 1600,
  now = Date.now(),
  maxAgeHours = 0,
} = {}) {
  try {
    if (!inboxFile || !fs.existsSync(inboxFile)) return '';
    const stat = fs.statSync(inboxFile);
    const readBytes = Math.min(stat.size, MAX_BYTES);
    const buffer = Buffer.alloc(readBytes);
    const fd = fs.openSync(inboxFile, 'r');
    try { fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes); } finally { fs.closeSync(fd); }
    const lines = buffer.toString('utf8').split(String.fromCharCode(10)).filter(Boolean);
    if (stat.size > readBytes) lines.shift(); // 第一行可能被截断
    const cutoff = now - Math.max(sinceMs, maxAgeHours ? maxAgeHours * 3600_000 : 0);
    const events = [];
    for (const line of lines) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const at = Date.parse(item.at ?? '');
      if (!Number.isFinite(at) || at < cutoff || at > now + 60_000) continue;
      const platform = labelOf(item.conversationKey || item.platform || '');
      if (!platform || (excludePlatform && platform === excludePlatform)) continue;
      const isPrivate = item.private === true || String(item.conversationKey || '').startsWith('private:');
      if (!includePrivate && isPrivate) continue;
      const who = item.isSelf ? '她' : String(item.sender || '?').slice(0, 20);
      const text = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!text) continue;
      // 过滤抖音卡片/JSON 载荷这类没有阅读价值的原始内容
      if (/^[\[{]/.test(text) || /"(?:aweType|activity_schema|author_id)"/.test(text)) continue;
      events.push({ at, platform, who, text, isSelf: item.isSelf === true });
    }
    if (!events.length) return '';
    const tail = events.slice(-Math.max(1, limit));
    const body = tail.map((event) => `[${hhmm(new Date(event.at).toISOString())}] ${event.platform} ${event.who}：${event.text}`).join('\n');
    const header = includePrivate
      ? '【跨平台近况（QQ/抖音/桌宠/B站 最近发生的事，直接当你的记忆用）】'
      : '【跨平台近况（公开平台最近发生的事：抖音群聊/B站/桌宠）】';
    return `${header}\n${body}`.slice(0, maxChars);
  } catch {
    return '';
  }
}
