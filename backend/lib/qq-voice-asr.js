// QQ 语音条 → 文字（DeepSeek ASR）。
//
// 为什么放 backend：语音条从 AstrBot 插件只带一个"QQ 侧缓存文件名"过来（插件不解析
// 音频），而 SILK 解码、ffmpeg、DeepSeek 凭据都在 DSH 这边——转写完整链路收在这里，
// 插件只负责转发标识。
//
// 链路：
//   record.file（QQ 语音缓存名）→ SnowLuma 网关 get_record(out_format:'mp3')
//   → 本地 ffmpeg 转 16kHz mono 16bit WAV（ASR 只收 16 位 PCM WAV / Ogg Opus）
//   → POST https://api.deepseek.com/v1/tools/asr（multipart，file 字段）
//   → { text, duration_ms }
//
// 约束（https://api.deepseek.com/zh-cn/guides/asr）：≤120 秒（多截少不报错，-t 兜底）、
// ≤8 MiB、非流式。计费 0.39 元/小时（限时五折），按秒精确。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveFfmpeg } from '../../src/voice-core.js';
import { resolveSearchApiKey } from '../../src/web-search.js';

const ASR_ENDPOINT = 'https://api.deepseek.com/v1/tools/asr';
const MAX_SECONDS = 120;          // ASR 单次上限，超了只转前 120 秒
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;  // ASR 上传上限
const GATEWAY_TIMEOUT_MS = 120000;         // 网关 SILK→mp3 转码按 60s+ 预算
const ASR_TIMEOUT_MS = 60000;

const noopLog = () => {};

/**
 * 读取 ASR 相关设置（enabled / 解析好的 key / 网关地址 / ffmpeg）。
 * key 链：socialV2.voice.asr.deepseekApiKey → socialV2.voice.tts.deepseekApiKey
 *   → 联网搜索那把 DeepSeek key（webSearch.apiKey → DEEPSEEK_API_KEY → DSH 凭据）。
 *   设置页只给一个总开关，key 与 DeepSeek 语音合成共用，不单独再填。
 */
export function readAsrSettings(cfg) {
  const voice = cfg?.socialV2?.voice ?? {};
  const asr = voice.asr ?? {};
  const literalKey = String(asr.deepseekApiKey || voice.tts?.deepseekApiKey || '').trim();
  const search = resolveSearchApiKey(cfg?.webSearch);
  return {
    enabled: asr.enabled === true,
    apiKey: literalKey || search.key,
    keySource: literalKey ? 'config' : search.source,
    snowlumaHttpUrl: String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    snowlumaToken: String(cfg?.snowluma?.accessToken || '').trim(),
    ffmpegPath: process.env.FFMPEG_PATH || voice.ffmpegPath || null,
  };
}

function spawnFfmpeg(ffmpeg, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg 启动失败：${error?.message ?? error}` });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: 'ffmpeg 转码超时' }); }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: e.code === 'ENOENT'
          ? '找不到 ffmpeg（请设置 FFMPEG_PATH 或在 config.json 里指定 socialV2.voice.ffmpegPath）'
          : `ffmpeg 不可用：${e.message}`,
      });
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0 }); });
  });
}

/** 网关把 QQ 收到的语音缓存转成 mp3（SILK 解码在网关侧，仓库不做任何预转码）。 */
async function fetchMp3FromGateway({ httpUrl, token, file, log }) {
  const res = await fetch(`${httpUrl}/get_record`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ file, out_format: 'mp3' }),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`网关 get_record 失败（HTTP ${res.status}）`);
  const data = await res.json().catch(() => null);
  const raw = String(data?.base64 ?? data?.file ?? '').trim();
  // 个别实现会把字段写成 base64:// 前缀，剥掉；纯路径（不含 base64 字符集特征）不认。
  const b64 = raw.startsWith('base64://') ? raw.slice('base64://'.length) : raw;
  if (!b64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(b64.slice(0, 256))) throw new Error('网关没有返回可用的语音数据');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('网关返回了空音频');
  log(`[qq-voice-asr] 网关转码 mp3 ${(buf.length / 1024).toFixed(1)}KB`);
  return buf;
}

async function fetchMp3FromUrl(url, log) {
  const res = await fetch(url, { signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`下载语音失败（HTTP ${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('语音下载为空');
  log(`[qq-voice-asr] 直链下载 ${(buf.length / 1024).toFixed(1)}KB`);
  return buf;
}

/**
 * 转写一条 QQ 语音。成功返回 { text, durationMs }；任何一步失败都返回 null
 * （调用方据此回退占位文案），错误细节只进日志，不进聊天。
 *
 * @param {object} p
 * @param {string} p.recordFile QQ 语音缓存文件名（record 段 data.file）
 * @param {string} [p.recordUrl] record 段自带的直链（网关转码失败时的退路）
 * @param {object} p.settings readAsrSettings() 的结果
 * @param {(msg:string)=>void} [p.log]
 */
export async function transcribeQqVoice({ recordFile = '', recordUrl = '', settings, log = noopLog } = {}) {
  if (!settings?.apiKey) { log('[qq-voice-asr] 没有 DeepSeek key，跳过转写'); return null; }
  if (!recordFile && !recordUrl) return null;
  const tmpDir = path.join(os.tmpdir(), 'qq-voice-asr');
  const mp3Path = path.join(tmpDir, `asr-${process.pid}-${Date.now()}.mp3`);
  const wavPath = mp3Path.replace(/\.mp3$/, '.wav');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    const mp3 = recordFile
      ? await fetchMp3FromGateway({ httpUrl: settings.snowlumaHttpUrl, token: settings.snowlumaToken, file: recordFile, log })
      : await fetchMp3FromUrl(recordUrl, log);
    if (mp3.length > 20 * 1024 * 1024) throw new Error('语音数据过大，拒绝处理');
    fs.writeFileSync(mp3Path, mp3);

    // 16kHz mono 16bit：ASR 明确支持，且 120s 也只有 ~3.8MB，稳在 8MiB 之内
    const conv = await spawnFfmpeg(settings.ffmpegPath ? settings.ffmpegPath : 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', mp3Path,
      '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le',
      '-t', String(MAX_SECONDS),
      wavPath,
    ], 30000);
    if (!conv.ok) throw new Error(conv.error || 'ffmpeg 转 WAV 失败');
    const wav = fs.readFileSync(wavPath);
    if (wav.length <= 44 || wav.length > MAX_UPLOAD_BYTES) throw new Error(`转出的 WAV 尺寸异常（${wav.length}B）`);

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'voice.wav');
    const res = await fetch(ASR_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = String(data?.error?.message ?? `HTTP ${res.status}`).slice(0, 200);
      throw new Error(res.status === 401 ? 'DeepSeek 鉴权失败（检查 API Key）'
        : res.status === 402 ? 'DeepSeek 余额不足'
        : `DeepSeek 语音识别失败：${message}`);
    }
    const text = String(data?.text ?? '').trim();
    if (!text) throw new Error('转写结果是空的（可能整段都是静音）');
    log(`[qq-voice-asr] 转写成功 ${text.length} 字 / ${Number(data?.duration_ms) || 0}ms`);
    return { text, durationMs: Number(data?.duration_ms) || 0 };
  } catch (error) {
    log(`[qq-voice-asr] 转写失败：${String(error?.message ?? error).slice(0, 300)}`);
    return null;
  } finally {
    for (const f of [mp3Path, wavPath]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
}
