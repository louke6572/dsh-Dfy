// 给主人的限频告警（QQ 私聊）。
//
// 为什么要有这个：全仓的失败埋点几乎都在日志/控制台里，主人不开设置页就等价于
// 「几天后才发现」——DeepSeek key 失效静默降级就是实例（2026-11-14 体检）。
// 这里做成唯一入口：按类别限频（默认 10 分钟一条），失败只写日志不抛，
// 绝不影响主链路。所有"悄悄降级"的现场都应该顺手调一下它。
import { sendQqPrivate } from './qq-direct.js';
import { readQqConfig } from './store.js';

const lastSentAt = new Map(); // category -> ts
const DEFAULT_COOLDOWN_MS = 10 * 60_000;

function ownerUin() {
  try {
    const cfg = readQqConfig().config ?? {};
    return String(cfg.ownerQQ ?? '').trim();
  } catch { return ''; }
}

/**
 * 给主人发一条限频告警。
 * @param {object} p
 * @param {string} p.category 告警类别（限频键，如 'qq-bridge-error'）
 * @param {string} p.text 内容（一两句话说清"什么坏了、去哪看"）
 * @param {number} [p.cooldownMs] 限频窗口，默认 10 分钟
 * @param {(msg:string)=>void} [p.log]
 * @returns {Promise<{ok:boolean, reason?:string}>} reason: no-owner / throttled / send-failed
 */
export async function notifyOwner({ category, text, cooldownMs = DEFAULT_COOLDOWN_MS, log = () => {} } = {}) {
  const cat = String(category ?? '').trim() || 'default';
  const uin = ownerUin();
  if (!/^\d{5,15}$/.test(uin)) return { ok: false, reason: 'no-owner' };
  const now = Date.now();
  const last = lastSentAt.get(cat) ?? 0;
  if (now - last < cooldownMs) return { ok: false, reason: 'throttled' };
  lastSentAt.set(cat, now);
  try {
    const res = await sendQqPrivate({ uin, text: `⚠️ dsh-Dfy：${String(text ?? '').slice(0, 300)}` });
    if (!res?.ok) {
      // 发送失败回退限频窗口（下次还能立刻重试），不留死状态
      lastSentAt.set(cat, last);
      log(`[owner-alert] 发送失败：${String(res?.error ?? res).slice(0, 160)}`);
      return { ok: false, reason: 'send-failed' };
    }
    return { ok: true };
  } catch (error) {
    lastSentAt.set(cat, last);
    log(`[owner-alert] 异常：${String(error?.message ?? error).slice(0, 160)}`);
    return { ok: false, reason: 'send-failed' };
  }
}
