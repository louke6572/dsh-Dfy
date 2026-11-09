/**
 * 语音合成「六音源」唯一实现。
 *
 * 以前 src/bridge.js（QQ 语音条 / 设置页试听）和 backend/lib/pet-chat.js（桌宠朗读 /
 * 消息卡片朗读）各自抄了一份六路 if-else，已经漂移：错误分类、超时口径、音色回退
 * 都不一致 → 用户切换音源后「时好时坏」。这里收敛成一份，两边都只传配置进来。
 *
 * 输入 tts 的形状（两份配置都已对齐）：{ route, timeoutMs, cacheVersion, dir,
 *   edgeVoice, localBaseUrl, localVoice, cloudBaseUrl, cloudVoice,
 *   onlineDesc, onlineLanguage, doubaoApiKey, doubaoResourceId, doubaoAppId,
 *   doubaoToken, doubaoVoice, doubaoEncoding, qwenApiKey, qwenVoice, qwenModel, qwenLanguage }
 *
 * 返回 { path, route, contentType, durationMs, format, cached? }。
 */
import { synthesizeEdgeToFile, DEFAULT_EDGE_VOICE } from './voice-edge-tts.js';
import { synthesizeToFile as synthesizeVoxdToFile } from './voice-tts.js';
import { synthesizeOnlineToFile, DEFAULT_ONLINE_DESC, DEFAULT_ONLINE_LANGUAGE } from './voice-online-tts.js';
import { synthesizeDoubaoToFile } from './voice-doubao-tts.js';
import { synthesizeQwenToFile } from './voice-qwen-tts.js';

export const VOICE_ROUTES = ['edge', 'local', 'cloud', 'online', 'doubao', 'qwen'];

export function normalizeVoiceRoute(route) {
  return VOICE_ROUTES.includes(String(route)) ? String(route) : 'edge';
}

export async function synthesizeToFileByRoute({
  text,
  voice = '',
  rate = '+0%',
  pitch = '+0Hz',
  route = '',
  tts = {},
  timeoutMs,
  outDir,
} = {}) {
  const effective = normalizeVoiceRoute(route || tts.route);
  const timeout = Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : (Number(tts.timeoutMs) > 0 ? Number(tts.timeoutMs) : 60000);
  const cacheVersion = tts.cacheVersion ?? null;
  const dir = outDir ?? tts.dir;
  const base = { route: effective, cacheVersion, outDir: dir };

  if (effective === 'doubao') {
    const r = await synthesizeDoubaoToFile({
      text,
      apiKey: tts.doubaoApiKey,
      resourceId: tts.doubaoResourceId,
      appId: tts.doubaoAppId,
      accessToken: tts.doubaoToken,
      voice: voice || tts.doubaoVoice,
      encoding: tts.doubaoEncoding,
      timeoutMs: timeout,
      ...base,
    });
    return {
      path: r.path,
      cached: r.cached,
      durationMs: r.durationMs,
      route: effective,
      format: r.format,
      contentType: r.format === 'ogg_opus' ? 'audio/ogg' : (r.format === 'wav' ? 'audio/wav' : 'audio/mpeg'),
    };
  }

  if (effective === 'qwen') {
    const r = await synthesizeQwenToFile({
      text,
      apiKey: tts.qwenApiKey,
      voice: voice || tts.qwenVoice,
      model: tts.qwenModel,
      language: tts.qwenLanguage,
      timeoutMs: timeout,
      ...base,
    });
    return { path: r.path, cached: r.cached, durationMs: r.durationMs, route: effective, format: 'wav', contentType: 'audio/wav' };
  }

  if (effective === 'online') {
    // 免费在线模型：不需要音色 id，声音由「声音描述」决定。队列慢，最低给 120s。
    const r = await synthesizeOnlineToFile({
      text,
      description: tts.onlineDesc || DEFAULT_ONLINE_DESC,
      language: tts.onlineLanguage || DEFAULT_ONLINE_LANGUAGE,
      timeoutMs: Math.max(timeout, 120000),
      ...base,
    });
    return { path: r.path, cached: r.cached, durationMs: 0, route: 'online', format: 'wav', contentType: 'audio/wav' };
  }

  if (effective === 'local' || effective === 'cloud') {
    const baseUrl = effective === 'local' ? tts.localBaseUrl : tts.cloudBaseUrl;
    const character = String(
      voice
      || (effective === 'local' ? tts.localVoice : tts.cloudVoice)
      || tts.character
      || ''
    ).trim();
    const r = await synthesizeVoxdToFile({
      text,
      character,
      voice: character,
      baseUrl,
      timeoutMs: timeout,
      ...base,
    });
    return { path: r.path, cached: r.cached, durationMs: r.durationMs, route: effective, format: 'wav', contentType: 'audio/wav' };
  }

  const r = await synthesizeEdgeToFile({
    text,
    voice: voice || tts.edgeVoice || DEFAULT_EDGE_VOICE,
    rate,
    pitch,
    timeoutMs: timeout,
    ...base,
  });
  return { path: r.path, cached: r.cached, durationMs: r.durationMs, route: 'edge', format: 'mp3', contentType: 'audio/mpeg' };
}
