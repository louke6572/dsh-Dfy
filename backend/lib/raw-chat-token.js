/**
 * 路线 B 的本地路口令牌（AstrBot ↔ DSH）。
 *
 * 为什么需要：`/dsh-surfcore/v1/*` 与 `/dsh-surfcore/v1/qq-bridge/ask` 是给 AstrBot
 * （及其 Python 桥接插件）调的本机接口，对方不带 DSH 浏览器 Cookie。插件路由统一过
 * `connection.requestRejection`，匿名回环请求会被 401——所以这两个路口自己守：
 * 只收本机回环 + `Authorization: Bearer <令牌>`。
 *
 * 2026-11 安全审查后拆成两把令牌（最小权限）：
 *   · raw-chat-token —— 给 AstrBot 的「OpenAI 兼容」provider 调 /v1/chat/completions
 *     （持有者能驱动一台 DSH 会话）；
 *   · bridge-token    —— 给 AstrBot 的 dsh_bridge 插件调 /v1/qq-bridge/ask
 *     （持有者能按 QQ 会话建会话，但拿不到 provider 那把）。
 * 两把都只在 state 目录与 AstrBot 配置/发现文件里出现，不写日志、不回显。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.js';

const TOKEN_DIR = path.join(STATE_DIR, 'astrbot');
const RAW_TOKEN_FILE = path.join(TOKEN_DIR, 'raw-chat-token');
const BRIDGE_TOKEN_FILE = path.join(TOKEN_DIR, 'bridge-token');

function readTokenFile(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return /^[A-Za-z0-9_-]{16,}$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

function ensureTokenFile(file) {
  const existing = readTokenFile(file);
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // 写不了盘就退回内存值：本次进程内仍可用，重启后重新生成（AstrBot 侧需重新写一次）。
  }
  return token;
}

/** 读令牌；没有就生成一个落盘（幂等）。 */
export function ensureRawChatToken() {
  return ensureTokenFile(RAW_TOKEN_FILE);
}

/** 桥接插件专用令牌（与 provider 令牌分权）。 */
export function ensureBridgeToken() {
  return ensureTokenFile(BRIDGE_TOKEN_FILE);
}

function matches(file, candidate) {
  const expected = readTokenFile(file);
  const got = String(candidate ?? '').trim();
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 定长比较，避免时序侧信道；值不对/长度不对一律 false。 */
export function rawChatTokenMatches(candidate) {
  return matches(RAW_TOKEN_FILE, candidate);
}

export function bridgeTokenMatches(candidate) {
  return matches(BRIDGE_TOKEN_FILE, candidate);
}

/** 从 `Authorization` 头里取 Bearer 值（大小写不敏感）。 */
export function bearerFromHeader(value) {
  const match = /^\s*bearer\s+(.+)$/i.exec(String(value ?? ''));
  return match ? match[1].trim() : '';
}
