/**
 * 路线 B 的「直接发 QQ」通道。
 *
 * 背景（2026-11 实测）：路线 B 把 QQ 交给 AstrBot 后，内置桥（:3100）按设计停着。
 * 但桌宠/消息卡片的发送按钮以前是经桥接 `/api/pet/owner-message` 走的 →
 * 桥停了就只剩一句 `fetch failed`。发一条 QQ 消息本来不需要桥：
 * SnowLuma 的 OneBot HTTP API（:3000）就能直接 send_private_msg。
 *
 * 这里只做「把一段文本以她的 QQ 号私聊发给主人」这一件事，token 用现成的
 * snowluma-conn 自发现（换号/换 token 不用改配置）。
 */
import { discoverSnowLumaConnection } from '../../src/snowluma-conn.js';
import { readQqConfig } from './store.js';

/** @returns {Promise<{ok:boolean, error?:string, data?:any}>} */
export async function sendQqPrivate({ uin, text } = {}) {
  const target = String(uin ?? '').trim();
  const message = String(text ?? '').trim();
  if (!/^\d{5,15}$/.test(target)) return { ok: false, error: '主人 QQ 号无效（先在人格/身份里配置主人）' };
  if (!message) return { ok: false, error: '消息为空' };
  const cfg = (() => {
    try { return readQqConfig().config?.snowluma ?? null; } catch { return null; }
  })();
  const conn = await discoverSnowLumaConnection({ cfg }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  if (!conn?.ok) return { ok: false, error: conn?.error || '找不到可用的 SnowLuma OneBot 连接' };
  try {
    const res = await fetch(`${String(conn.baseUrl).replace(/\/+$/, '')}/send_private_msg`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}),
      },
      body: JSON.stringify({ user_id: Number(target), message: [{ type: 'text', data: { text: message } }] }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && (data?.retcode === undefined || data?.retcode === 0) && (data?.status === undefined || data.status === 'ok');
    if (!ok) {
      return {
        ok: false,
        error: `OneBot 拒绝（HTTP ${res.status} · retcode ${data?.retcode ?? '?'}）：${data?.wording || data?.message || ''}`.trim(),
      };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: `发送失败：${String(error?.message ?? error)}` };
  }
}
