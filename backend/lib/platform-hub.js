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
import { spawn } from 'node:child_process';
import { DSH_HOME, QQBOT_ROOT } from './paths.js';
import { readUnified } from './store.js';
import { isModuleEnabled } from './modules.js';

const HUB_TTL = 5_000;
const PROBE_TIMEOUT = 2_500;
const INSTALL_TIMEOUT = 180_000;
const SHARED_PLUGINS_DIR = path.join(DSH_HOME, 'shared', 'plugins');
// 平台插件推荐清单（随插件分发，位于聚合包仓库根 market/）：点名的 id 视为平台插件，
// 和 dfy.platform 清单并列。PLUGIN_ROOT 指向 <仓库根>/backend，所以用 QQBOT_ROOT（仓库根）。
const RECOMMENDATIONS_FILE = path.join(QQBOT_ROOT, 'market', 'recommendations.json');

/**
 * 平台子页注册表：「设置 → dsh-Dfy → 平台」里每个子页由谁提供。
 *   builtin = dsh-Dfy 自带实现（走 modules.<id> 开关）；
 *   plugins = 能接管这个平台的社区插件（候选，装了就在子页里显示状态/接管入口，
 *             一个都没装且内置也没启用 → 子页显示「未安装 + 一键安装」）。
 */
const PLATFORM_TABS = [
  { id: 'bili', label: '养鱼（B站）', module: 'bili', builtin: true, plugins: [] },
  {
    id: 'douyin', label: '抖音', module: 'douyin', builtin: true,
    plugins: [{ id: 'dsh-douyin-watch', repo: 'github:miqian-nomad/dsh-douyin-watch', covers: '抖音私信/评论自动化（新私信叫醒、回私信、发评论、回楼中楼）' }],
  },
  {
    id: 'tieba', label: '贴吧', module: '', builtin: false,
    plugins: [{ id: 'dsh-tieba-dive', repo: 'github:Nekomeow114/dsh-tieba-dive', covers: '贴吧整套：读帖/日报/签到/可选回帖，自带人设与风格库' }],
  },
  {
    id: 'qq', label: 'QQ', module: 'qq', builtin: true,
    plugins: [{ id: 'dsh-dot', repo: 'github:Kevinwu901113/dsh-dot', covers: '聚合养鱼套件：QQ（SnowLuma/NapCat）+ 安卓模拟器刷 B站/微博/小红书 + 人设/记忆/日记' }],
  },
];

/** 推荐清单里点名的平台插件 id 集合（读不到就当空，不阻断发现）。 */
function recommendedPlatformIds() {
  const data = readJsonSafe(RECOMMENDATIONS_FILE);
  const list = Array.isArray(data?.recommendations) ? data.recommendations : [];
  return new Set(list.map((item) => normalizeName(item?.id)).filter(Boolean));
}

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
    const recommended = recommendedPlatformIds();
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
      platform: recommended.has(normalizeName(pkg.name)),
      installed: true,
      stale: false,
    }));
    for (const p of plugins) byKey.set(normalizeName(p.name), p);

    for (const [key, manifest] of listSharedManifests()) {
      const hit = byKey.get(key);
      if (hit) {
        // 清单给已装包补充运行态探针与能力声明；声明了 dfy.platform 就是平台插件
        hit.source = 'manifest';
        hit.provides = manifest.provides;
        hit.statusPath = manifest.statusPath;
        hit.platform = hit.platform || manifest.provides.includes('dfy.platform');
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
          platform: manifest.provides.includes('dfy.platform'),
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

  /** 平台子页载荷：每个子页由内置还是插件提供、候选插件装没装。 */
  function tabs() {
    const installed = scan();
    return PLATFORM_TABS.map((tab) => ({
      id: tab.id,
      label: tab.label,
      module: tab.module,
      builtin: Boolean(tab.builtin),
      builtinEnabled: tab.module ? isModuleEnabled(readUnified().config, tab.module) : false,
      plugins: (tab.plugins ?? []).map((cand) => {
        const hit = installed.find((p) => p.installed && normalizeName(p.name) === normalizeName(cand.id));
        return {
          id: cand.id,
          repo: cand.repo,
          covers: cand.covers ?? '',
          installed: Boolean(hit),
          statusPath: hit?.statusPath ?? '',
          summary: hit?.summary ?? '',
        };
      }),
    }));
  }

  /** 识别本插件跑在哪个 profile：哪个 profile 的 node_modules 里 dsh-dfy 指向本仓库，就是它。 */
  function detectProfile() {
    let selfReal = '';
    try { selfReal = fs.realpathSync(QQBOT_ROOT); } catch { return ''; }
    const profilesDir = path.join(DSH_HOME, 'profiles');
    let entries = [];
    try { entries = fs.readdirSync(profilesDir, { withFileTypes: true }); } catch { return ''; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const link = path.join(profilesDir, entry.name, 'node_modules', selfName);
        const real = fs.realpathSync(link);
        if (real === selfReal) return entry.name;
      } catch { continue; }
    }
    return '';
  }

  /** 装完把插件名写进 profile 的 dsh.profile.bundles（CLI add 不自动启用，setup-dsh.mjs 同款做法）。 */
  function enableInProfile(profile, pluginName) {
    try {
      const file = path.join(DSH_HOME, 'profiles', profile, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bundles = pkg?.dsh?.profile?.bundles;
      if (!Array.isArray(bundles)) return false;
      if (!bundles.includes(pluginName)) bundles.push(pluginName);
      pkg.dsh.profile.bundles = bundles;
      fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
      return true;
    } catch (error) {
      log('[platform-hub] 写入 bundles 失败：', String(error?.message ?? error));
      return false;
    }
  }

  /** 一键安装：后台 spawn `dsh plugin --profile <p> add <repo>`，成功后补写 bundles。 */
  async function install(id) {
    const cand = PLATFORM_TABS
      .flatMap((tab) => (tab.plugins ?? []).map((p) => ({ ...p, tabId: tab.id })))
      .find((p) => normalizeName(p.id) === normalizeName(String(id)));
    if (!cand) return { ok: false, error: `没有为「${id}」配置推荐插件` };
    const profile = detectProfile();
    if (!profile) {
      return { ok: false, error: `没识别出当前 profile，请手动执行：dsh plugin --profile <profile> add ${cand.repo}` };
    }
    // 安全审查（2026-11）：这里走 shell:true，参数必须严格校验，防止配置/清单被篡改后注入命令。
    const repo = String(cand.repo ?? '');
    if (!/^github:[\w.-]+\/[\w.-]+$/i.test(repo)) {
      return { ok: false, error: '推荐插件地址格式不合法（只接受 github:用户/仓库）' };
    }
    if (!/^[\w.-]+$/.test(String(profile))) {
      return { ok: false, error: 'profile 名称不合法' };
    }
    log(`[platform-hub] 安装 ${cand.id} → profile ${profile}`);
    const out = await new Promise((resolve, reject) => {
      const child = spawn('dsh', ['plugin', '--profile', profile, 'add', repo], { shell: true, env: process.env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('安装超时（180s），网络或源太慢，可改为手动安装')); }, INSTALL_TIMEOUT);
      child.stdout.on('data', (d) => { stdout += String(d); });
      child.stderr.on('data', (d) => { stderr += String(d); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    if (out.code !== 0) {
      return { ok: false, error: `安装命令退出码 ${out.code}`, detail: (out.stdout + '\n' + out.stderr).slice(-1500) };
    }
    const enabled = enableInProfile(profile, cand.id);
    return {
      ok: true,
      message: `已安装 ${cand.id}${enabled ? ' 并加入启用列表' : ''}；等 DSH 装完依赖后刷新页面即可使用`,
      profile,
      detail: out.stdout.slice(-800),
    };
  }

  return {
    /** 全量快照：清单 + 安装状态 + 环回探测结果 + 平台子页载荷。host 传请求的 Host 头。 */
    async snapshot(host = '') {
      const plugins = scan().map((p) => ({ ...p }));
      for (const p of plugins) {
        if (p.installed && p.statusPath) p.status = await probe(p.statusPath, host);
        else p.status = null;
      }
      return { plugins, tabs: tabs(), scannedAt: new Date().toISOString() };
    },
    install,
  };
}
