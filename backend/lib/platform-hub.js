/**
 * 平台插件发现（platform hub）。
 *
 * dsh-Dfy 的定位是壳：QQ/B站/贴吧这些平台能力来自装进 DSH 的独立插件
 * （dsh-tieba-dive、dsh-dot 这类），装了就显示、卸了就消失，本模块负责发现它们。
 *
 * 两层发现（并集，按归一化包名去重）：
 *   ① 养鱼系插件清单：$DSH_HOME/shared/plugins/ 下的 *.json，provides 含
 *      'dfy.platform'（约定沿用 dsh-tieba-dive：apply 时写入、ctx.effect 清理时删除）。
 *      带 statusPath 的清单可由调用方用请求同源 Host 环回探测运行态。
 *   ② 任意 DSH 插件：$DSH_HOME/plugins/ 各目录，以及
 *      $DSH_HOME/profiles/〈profile〉/node_modules/ 下 package.json 带 "dsh"
 *      字段的包——它们不一定接清单约定，但只要装了就该出现在列表里
 *      （用户视角：装了什么，这里就有什么）。
 *
 * 状态探测只对「已安装 + 有 statusPath」的插件做，且 Host 必须是本机回环
 * （该值来自请求头，不能拿去探测任意地址）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DSH_HOME } from './paths.js';

const HUB_TTL = 5_000;
const PROBE_TIMEOUT = 2_500;
const SHARED_PLUGINS_DIR = path.join(DSH_HOME, 'shared', 'plugins');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function normalizeName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isLoopbackHost(host) {
  const bare = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}

/** ① 共享清单：只认 provides 含 'dfy.platform' 的，别的文件不看。 */
function listSharedManifests(dir = SHARED_PLUGINS_DIR) {
  const out = new Map();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const manifest = readJsonSafe(path.join(dir, entry.name));
    if (!manifest || typeof manifest !== 'object') continue;
    const provides = Array.isArray(manifest.provides) ? manifest.provides.map(String) : [];
    if (!provides.includes('dfy.platform')) continue;
    const key = normalizeName(manifest.name) || normalizeName(entry.name.replace(/\.json$/, ''));
    if (!key) continue;
    out.set(key, {
      name: String(manifest.name ?? entry.name.replace(/\.json$/, '')),
      version: String(manifest.version ?? ''),
      summary: String(manifest.note ?? manifest.description ?? ''),
      provides,
      statusPath: typeof manifest.statusPath === 'string' && manifest.statusPath.startsWith('/') ? manifest.statusPath : '',
    });
  }
  return out;
}

/** ② 已安装的 DSH 插件包：两个位置扫，statSync 跟随符号链接/junction。 */
function listInstalledPackages({ selfName }) {
  const roots = [
    path.join(DSH_HOME, 'plugins'),
    path.join(DSH_HOME, 'profiles'),
  ];
  const found = new Map();
  const consider = (pkgDir) => {
    const pkg = readJsonSafe(path.join(pkgDir, 'package.json'));
    if (!pkg || typeof pkg !== 'object' || !pkg.name || !pkg.dsh) return;
    const name = String(pkg.name);
    if (name === selfName || found.has(name)) return;
    const desc = pkg.description ?? {};
    found.set(name, {
      name,
      version: String(pkg.version ?? ''),
      summary: typeof desc === 'string' ? desc : String(desc.zh ?? desc.en ?? ''),
    });
  };
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(root, entry.name);
      let stat = null;
      try { stat = fs.statSync(entryPath); } catch { continue; }
      if (!stat.isDirectory()) continue;
      if (root.endsWith('profiles')) {
        // profiles/<profile>/node_modules/<pkg>（pnpm 会用 symlink 指进 .pnpm，statSync 已跟随）
        const nm = path.join(entryPath, 'node_modules');
        let pkgs = [];
        try { pkgs = fs.readdirSync(nm, { withFileTypes: true }); } catch { continue; }
        for (const p of pkgs) {
          if (p.name.startsWith('.')) continue;
          const pkgDir = path.join(nm, p.name);
          let pstat = null;
          try { pstat = fs.statSync(pkgDir); } catch { continue; }
          if (!pstat.isDirectory()) continue;
          if (p.name.startsWith('@')) {
            // scope 目录：再进一层
            let scoped = [];
            try { scoped = fs.readdirSync(pkgDir, { withFileTypes: true }); } catch { continue; }
            for (const s of scoped) {
              if (s.name.startsWith('.')) continue;
              consider(path.join(pkgDir, s.name));
            }
          } else {
            consider(pkgDir);
          }
        }
      } else {
        consider(entryPath);
      }
    }
  }
  return [...found.values()];
}

/**
 * 创建平台发现器。probeHost 传请求的 Host 头（如 127.0.0.1:端口），
 * 只用于同源环回探测，非回环直接跳过探测。
 */
export function createPlatformHub({ selfName = 'dsh-dfy', log = () => {} } = {}) {
  let cache = null;
  let cacheAt = 0;

  function scan() {
    const now = Date.now();
    if (cache && now - cacheAt < HUB_TTL) return cache;
    const packages = listInstalledPackages({ selfName });
    const byKey = new Map();
    const plugins = packages.map((pkg) => ({
      id: pkg.name,
      name: pkg.name,
      version: pkg.version,
      summary: pkg.summary,
      source: 'package',
      provides: [],
      statusPath: '',
      installed: true,
      stale: false,
    }));
    for (const p of plugins) byKey.set(normalizeName(p.name), p);

    for (const [key, manifest] of listSharedManifests()) {
      const hit = byKey.get(key);
      if (hit) {
        // 清单给已装包补充运行态探针与能力声明
        hit.source = 'manifest';
        hit.provides = manifest.provides;
        hit.statusPath = manifest.statusPath;
        if (manifest.summary && !hit.summary) hit.summary = manifest.summary;
      } else {
        // 清单在、包没了：插件被卸载但清单残留（提醒用户可手动删）
        plugins.push({
          id: manifest.name,
          name: manifest.name,
          version: manifest.version,
          summary: manifest.summary,
          source: 'manifest',
          provides: manifest.provides,
          statusPath: manifest.statusPath,
          installed: false,
          stale: true,
        });
      }
    }
    plugins.sort((a, b) => Number(b.source === 'manifest') - Number(a.source === 'manifest') || a.name.localeCompare(b.name));
    cache = plugins;
    cacheAt = now;
    return plugins;
  }

  async function probe(statusPath, host) {
    if (!statusPath || !isLoopbackHost(host)) return null;
    try {
      const res = await fetch(`http://${host}${statusPath}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });
      return { ok: res.ok, httpStatus: res.status };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  return {
    /** 全量快照：清单 + 安装状态 + 环回探测结果。host 传请求的 Host 头。 */
    async snapshot(host = '') {
      const plugins = scan().map((p) => ({ ...p }));
      for (const p of plugins) {
        if (p.installed && p.statusPath) p.status = await probe(p.statusPath, host);
        else p.status = null;
      }
      return { plugins, scannedAt: new Date().toISOString() };
    },
  };
}
