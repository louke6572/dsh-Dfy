// DeepSeek 官方语音合成（2026-11 开放的"全家桶应用 API"独立 TTS 接口）。
//
// 为什么接它：豆包/千问要单独申请 key，Edge 是微软非官方端点（靠逆向签名撑着，
// 随时可能挂）；DeepSeek 这个是官方稳定接口，而且项目里多半已有 DeepSeek key
// （联网搜索 / DEEPSEEK_API_KEY / DSH 凭据），留空即可复用，不用再配一遍。
//
// 协议（https://api.deepseek.com/zh-cn/guides/tts）：
//   POST https://api.deepseek.com/v1/tools/tts
//   headers: Authorization: Bearer <DEEPSEEK_API_KEY>
//   body: { text, voice_id, format: 'wav' }   —— voice_id 只有 stella(默认)/tide
//   响应: 音频边合成边流式返回（wav，24kHz，chunked；RIFF 长度字段=0xFFFFFFFF 表示未知），
//   单次最多 30 分钟 / 1 万计费字符。官方文档明确"音频开始返回后合成失败会中途断开"，
//   这种断开在 chunked 流上表现为 fetch 抛错，由调用处兜住；WAV 头校验只挡非 WAV 垃圾。
//
// 计费：每 1 万字符 1.5 元（限时五折，刊例 3 元）；汉字算 2 个字符。不支持调语速。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { httpRequest, pruneAudioCache, writeAudioAtomic } from './voice-core.js';

const ENDPOINT = 'https://api.deepseek.com/v1/tools/tts';
// 服务端上限是 1 万个"计费字符"（汉字×2），按原文字符数留 1 万的安全余量即可，
// 请求体远小于 64 KiB 上限；正常调用前 synthesizeVoiceText 的 maxChars 已截过一轮。
const MAX_TEXT = 10000;

export const DEEPSEEK_DEFAULT_VOICE = 'stella';
export const DEEPSEEK_VOICES = ['stella', 'tide'];

function cacheKey(input) {
  return crypto.createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 32);
}

/**
 * 校验返回的确实是完整 WAV。
 * DeepSeek 是流式合成：RIFF/data 块的长度字段写 0xFFFFFFFF（未知），2026-11-14 实测，
 * 整段合成的老假设（声明长度==实际长度）会把每一句都误判成"中断"。
 * 真正的中途断开由 chunked 传输层兜底：流被掐断时 fetch 会直接抛错，走不到这里。
 */
function looksLikeWholeWav(buf) {
  if (!buf || buf.length <= 1000) return false; // 1 秒 24kHz/16bit/mono ≈ 48KB，太小必是坏的
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return false;
  const declared = buf.readUInt32LE(4);
  return declared === 0xFFFFFFFF || declared === buf.length - 8;
}

/** 把 HTTP 状态码翻译成用户能照着处理的中文。 */
function describeHttpError(status, message) {
  if (status === 401) return `DeepSeek 鉴权失败：${message}（检查 API Key 是否有效）`;
  if (status === 402) return `DeepSeek 余额不足：${message}（去开放平台充值后重试）`;
  if (status === 400 && /content exists risk/i.test(message)) {
    return `DeepSeek 拒绝朗读这段文字（未通过内容审核），换一段试试`;
  }
  if (status === 400) return `DeepSeek 语音参数有误：${message}`;
  if (status === 429) return `DeepSeek 语音太忙（并发到上限），稍后再试：${message}`;
  if (status === 503) return `DeepSeek 语音服务繁忙，稍后再试：${message}`;
  if (status === 504) return `DeepSeek 语音合成超时：${message}`;
  return `DeepSeek 合成失败：${message}`;
}

/**
 * @returns {Promise<{path:string,durationMs:number,cached:boolean,format:string}>}
 */
export async function synthesizeDeepseekToFile({
  text,
  apiKey,
  voice = '',
  timeoutMs = 90000,
  cacheVersion = null,
  outDir,
  requestImpl = httpRequest, // 测试可注入；生产走 node:https 直连（见 voice-core.httpRequest 注释）
} = {}) {
  const say = String(text ?? '').trim().slice(0, MAX_TEXT);
  if (!say) throw new Error('要合成的内容是空的');
  if (!apiKey) throw new Error('DeepSeek 语音还没配置：读不到 DeepSeek API Key（检查 DSH 凭据/联网搜索配置）');
  if (!outDir) throw new Error('缺少 outDir（TTS 缓存目录）');
  const voiceId = DEEPSEEK_VOICES.includes(String(voice).trim()) ? String(voice).trim() : DEEPSEEK_DEFAULT_VOICE;
  fs.mkdirSync(outDir, { recursive: true });

  const file = path.join(outDir, `deepseek-${cacheKey({ say, voiceId, cacheVersion })}.wav`);
  if (fs.existsSync(file)) {
    try {
      if (fs.statSync(file).size > 44) return { path: file, durationMs: 0, cached: true, format: 'wav' };
    } catch { /* 缓存坏了就重合成 */ }
  }

  let res;
  try {
    res = await requestImpl({
      url: ENDPOINT,
      method: 'POST',
      headers: {
        authorization: `Bearer ${String(apiKey)}`,
        'content-type': 'application/json',
        accept: 'application/json, audio/wav',
      },
      body: JSON.stringify({ text: say, voice_id: voiceId, format: 'wav' }),
      timeoutMs,
    });
  } catch (err) {
    const message = String(err?.message ?? err);
    const proxyHint = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|超时/.test(message) ? '（多为代理节点不稳，稍后重试通常可恢复）' : '';
    throw new Error(`连不上 DeepSeek 语音：${message.slice(0, 200)}${proxyHint}`);
  }
  if (res.truncated) throw new Error('DeepSeek 音频过大被中止，请缩短文本后重试');

  // 出错时返回的是 JSON（OpenAI 兼容错误体），音频正常时是 wav 流
  const contentType = String(res.headers?.['content-type'] ?? '');
  if (res.status < 200 || res.status >= 300 || /json/i.test(contentType)) {
    const raw = res.body.toString('utf8');
    let message = `HTTP ${res.status}`;
    try { message = String(JSON.parse(raw)?.error?.message ?? raw ?? message).slice(0, 200); } catch { /* 原样用状态码 */ }
    throw new Error(describeHttpError(res.status, message));
  }

  const buf = res.body;
  if (!looksLikeWholeWav(buf)) throw new Error('DeepSeek 返回的音频不完整（可能中途断开），请重试');

  writeAudioAtomic(file, buf);
  pruneAudioCache(outDir, { exts: ['.wav'] });
  return { path: file, durationMs: 0, cached: false, format: 'wav' };
}
