/**
 * AstrBot 进程守护：打开 DSH 自动拉起，用户不需要手动启动（对标 SnowLuma 的 allowLaunch）。
 *
 *   · 健康 = WebUI 端口 HTTP 可达（任何状态码都算活着，鉴权页面也返回 401/200）；
 *   · 不健康且 enabled → spawn `astrbot run`（detached：DSH 退出它继续跑；DSH 重启时
 *     发现端口已在跑就不重复拉）；
 *   · 巡检 30s，两次拉起至少隔 90s（端口没就绪时不反复 spawn）；
 *   · 不主动杀进程；「重启」= 按端口找 PID 结束，交给巡检重拉。
 *
 * 配置（unified.astrbot）：{ enabled, cwd, exe, port }，cwd/exe 留空走默认发现。
 * 另提供 saveProviderKey()：把 DeepSeek key 写进 AstrBot 自己的 cmd_config.json
 * （utf-8-sig，provider[] 模板照抄 AstrBot default.py 的 DeepSeek 条目）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readUnified } from './store.js';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT = 1500;
const WATCH_INTERVAL = 30_000;
const SPAWN_MIN_GAP = 90_000;

function homeResolve(...parts) {
  return path.join(os.homedir(), ...parts);
}

/** 默认发现：数据目录 ~/astrbot（astrbot init 的位置）、exe ~/.local/bin/astrbot.exe。 */
function resolveCwd(cfg) {
  if (cfg.cwd) return cfg.cwd;
  const candidate = homeResolve('astrbot');
  try { if (fs.existsSync(path.join(candidate, 'data'))) return candidate; } catch {}
  return candidate;
}

function resolveExe(cfg) {
  if (cfg.exe) return cfg.exe;
  const candidate = homeResolve('.local', 'bin', 'astrbot.exe');
  try { if (fs.existsSync(candidate)) return candidate; } catch {}
  return 'astrbot'; // 交给 PATH
}

function astrbotConfig() {
  return readUnified().config.astrbot ?? { enabled: true, cwd: '', exe: '', port: 6185 };
}

async function probePort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    });
    return { ok: true, httpStatus: res.status };
  } catch (error) {
    return { ok: false, error: String(error?.cause?.code ?? error?.message ?? error) };
  }
}

/** 按端口找监听进程 PID（netstat），重启用。找不到返回 null。 */
async function pidByPort(port) {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { timeout: 8000 });
    const line = stdout.split(/\r?\n/).find((l) => l.includes(`:${port} `) && /LISTENING/i.test(l));
    if (!line) return null;
    const pid = Number(line.trim().split(/\s+/).pop());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function createAstrbotSupervisor({ log = () => {} } = {}) {
  let timer = null;
  let lastSpawnAt = 0;
  let lastError = '';
  let spawnedByUs = false;

  function cfg() {
    return astrbotConfig();
  }

  async function status() {
    const c = cfg();
    const probe = c.enabled ? await probePort(c.port) : { ok: false, error: 'disabled' };
    const cwd = resolveCwd(c);
    const initialized = fs.existsSync(path.join(cwd, 'data', 'cmd_config.json'));
    return {
      enabled: c.enabled,
      running: Boolean(probe.ok),
      port: c.port,
      exe: resolveExe(c),
      cwd,
      initialized,
      spawnedByUs,
      lastSpawnAt: lastSpawnAt || null,
      lastError,
      probe: probe.ok ? { httpStatus: probe.httpStatus } : { error: probe.error },
      hint: !c.enabled
        ? 'AstrBot 网关已停用（配置 unified.astrbot.enabled）'
        : (!initialized ? '还没初始化：跑一次 astrbot init（或点「初始化」）' : ''),
    };
  }

  async function ensureRunning({ manual = false } = {}) {
    const c = cfg();
    if (!c.enabled) return { ok: false, error: 'disabled' };
    const probe = await probePort(c.port);
    if (probe.ok) return { ok: true, already: true };
    const now = Date.now();
    if (!manual && now - lastSpawnAt < SPAWN_MIN_GAP) {
      return { ok: false, error: 'cooldown', retryInMs: SPAWN_MIN_GAP - (now - lastSpawnAt) };
    }
    const cwd = resolveCwd(c);
    const exe = resolveExe(c);
    if (!fs.existsSync(path.join(cwd, 'data'))) {
      lastError = `数据目录不存在：${cwd}（先 astrbot init）`;
      log('[astrbot] ', lastError);
      return { ok: false, error: lastError };
    }
    try {
      const child = spawn(exe, ['run'], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      spawnedByUs = true;
      lastSpawnAt = now;
      lastError = '';
      log(`[astrbot] 已拉起（pid ${child.pid ?? '?'}，cwd ${cwd}）`);
      return { ok: true, spawned: true, pid: child.pid ?? null };
    } catch (error) {
      lastError = String(error?.message ?? error);
      log('[astrbot] 拉起失败：', lastError);
      return { ok: false, error: lastError };
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      const c = cfg();
      if (!c.enabled) return;
      void ensureRunning().catch(() => {});
    }, WATCH_INTERVAL);
    // 启动即查一次（异步，不阻塞 apply）
    void ensureRunning().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** 重启：按端口找 PID 结束（我们拉起的才动手），巡检会在下个周期自动重拉。 */
  async function restart() {
    const c = cfg();
    const probe = await probePort(c.port);
    if (!probe.ok) return ensureRunning({ manual: true });
    const pid = await pidByPort(c.port);
    if (!pid) return { ok: false, error: `端口 ${c.port} 没找到监听进程，无法重启` };
    if (!spawnedByUs) {
      return { ok: false, error: `这个 AstrBot（pid ${pid}）不是 dsh-Dfy 拉起的，请自己在它的窗口重启` };
    }
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/F'], { timeout: 8000 });
      log(`[astrbot] 已结束 pid ${pid}，等待巡检重拉`);
      return { ok: true, killed: pid };
    } catch (error) {
      return { ok: false, error: `taskkill 失败：${String(error?.message ?? error)}` };
    }
  }

  /**
   * 把 DeepSeek key 写进 AstrBot 的 cmd_config.json（provider[] 里的 deepseek 条目）。
   * 返回是否需要重启（AstrBot 不热读该文件，改动后要重启进程）。
   */
  async function saveProviderKey(apiKey) {
    const c = cfg();
    const key = String(apiKey ?? '').trim();
    if (!key) return { ok: false, error: 'key 不能为空' };
    const cwd = resolveCwd(c);
    const file = path.join(cwd, 'data', 'cmd_config.json');
    if (!fs.existsSync(file)) return { ok: false, error: `找不到 AstrBot 配置：${file}` };
    let conf;
    try {
      conf = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return { ok: false, error: `AstrBot 配置解析失败：${String(error?.message ?? error)}` };
    }
    const entry = {
      id: 'deepseek',
      provider: 'deepseek',
      type: 'openai_chat_completion',
      provider_type: 'chat_completion',
      enable: true,
      key: [key],
      api_base: 'https://api.deepseek.com/v1',
      timeout: 120,
      proxy: '',
      custom_headers: {},
    };
    const list = Array.isArray(conf.provider) ? conf.provider : [];
    const idx = list.findIndex((p) => p && p.id === 'deepseek');
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    conf.provider = list;
    conf.provider_settings = { ...(conf.provider_settings ?? {}), enable: true };
    fs.writeFileSync(file, JSON.stringify(conf, null, 2), 'utf8');
    log('[astrbot] DeepSeek provider 已写入 cmd_config.json');
    return { ok: true, needRestart: true };
  }

  return { status, ensureRunning, start, stop, restart, saveProviderKey };
}
