#!/usr/bin/env node
/**
 * install-simulation.mjs —— 安装模拟闸门：按用户的安装方式把包真实装一遍。
 *
 * 为什么需要（2026-11-16 真事故）：
 *   「装上插件后整个 DSH 启动失败」这类故障**不在代码逻辑里，在安装环境里**：
 *     · 插件声明了宿主也自带的 @deepseek-ai/dsh-*，npm/pnpm 把旧副本提升进 profile
 *       顶层 node_modules，盖掉宿主 0.2.x → required plugins did not activate；
 *     · 打包白名单漏了 packages/ → 装出来的包 import 'dsh-dfy-core/...' 直接
 *       ERR_MODULE_NOT_FOUND → 插件激活失败；
 *     · postinstall 一失败，npm install 整体红掉，插件半装。
 *   静态读代码永远碰不到这些 —— ci-audit 的 pack 模式只核对 4 个固定文件在不在
 *   tarball 里，不验「装完之后 import 能不能解析」。本脚本把用户路径真实走一遍：
 *
 *     npm pack → 解压到干净目录 → npm install（含 postinstall）→
 *     遍历包内每个 import 验证可解析 → 依赖树扫描（宿主遮蔽）→ 关键运行文件校验
 *
 * 任何一步失败都 exit 1。CI 与发布流程都挂这一道；本机想单独跑：
 *   npm run audit:install
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const problems = [];
const notes = [];

const HOST_PROVIDED_ALLOW = new Set([
  // 运行时由宿主环境提供、插件**不再自带**的包。这些名字绝不允许出现在
  // dependencies 里（见下面的宿主遮蔽扫描）；代码里 import 它们是合法的
  // （import 处必须自带降级：找不到时走宿主解析或优雅报错，不得在模块加载期抛）：
  //   · @deepseek-ai/schemastery：宿主 node_modules 自带（backend/lib/qq-mode.js 运行时解析）；
  //   · playwright-core：宿主自带，desktop 1.63-alpha / web 1.64-alpha，与插件曾钉的
  //     ^1.65 互不满足——声明即版本冲突遮蔽（src/voice-doubao-web.js、
  //     backend/vendor/douyin/playwright-runtime.mjs 运行时解析）；
  //   · react：设置页 bundle（lib/client.js）跑在 DSH 的 React 网页应用里，
  //     由宿主的浏览器模块图提供。
  '@deepseek-ai/schemastery',
  'playwright-core',
  'react',
]);

// 刻意允许缺失的相对导入（文件被移除、脚本内已有优雅降级并给用户明确指引）：
const OPTIONAL_RELATIVE = new Set([
  // scripts/clean-dead-workspaces.mjs --apply 依赖的探针已从仓库移除；
  // dry-run 正常、--apply 时 catch 住并打印恢复办法（见该文件 2026-11-11 注释）。
  './probe-auth.mjs',
]);

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

function npmArgs(args, cwd) {
  return process.platform === 'win32'
    ? spawnSync(`npm ${args.join(' ')}`, { shell: true, encoding: 'utf8', cwd })
    : spawnSync('npm', args, { encoding: 'utf8', cwd });
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

function fail(msg) { problems.push(msg); console.log(`  ✗ ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function note(msg) { notes.push(msg); console.log(`  · ${msg}`); }

// ── 1. npm pack（按发布白名单取磁盘文件，与 CI/发布产物完全同源）────────────
section('1. npm pack');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdfy-install-sim-'));
const packDir = path.join(tmp, 'pack');
fs.mkdirSync(packDir, { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let tarball = '';
{
  const r = npmArgs(['pack', '--ignore-scripts', '--pack-destination', packDir], ROOT);
  if (r.status !== 0) {
    fail(`npm pack 失败（exit ${r.status}）：${String(r.stderr || r.stdout || '').slice(-400)}`);
    finish();
  }
  const tgz = fs.readdirSync(packDir).filter((f) => f.endsWith('.tgz')).sort().pop();
  if (!tgz) { fail('npm pack 没有产出 .tgz'); finish(); }
  tarball = path.join(packDir, tgz);
  ok(`产物 ${tgz}（${Math.round(fs.statSync(tarball).size / 1024)} KB）`);
}

// ── 2. 解压 ─────────────────────────────────────────────────────────────────
section('2. 解压到干净目录');
const extractDir = path.join(tmp, 'pkg');
fs.mkdirSync(extractDir, { recursive: true });
try {
  // 只给 tar 裸文件名（绝对路径会被 GNU tar 当成远程主机、bsdtar 又不认 --force-local，
  // 见 ci-audit.mjs 里的同款注释）；解压目标用 -C 绝对路径是安全的。
  execFileSync('tar', ['-xzf', path.basename(tarball), '-C', extractDir],
    { cwd: path.dirname(tarball), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ok('解压完成');
} catch (err) {
  fail(`tar 解压失败：${String(err?.message ?? err).slice(0, 300)}`);
  finish();
}
// npm pack 的 tarball 统一带 package/ 前缀：安装根要落到前缀里面。
const installDir = path.join(extractDir, 'package');
if (!fs.existsSync(path.join(installDir, 'package.json'))) {
  fail(`解压后没有 package.json（${installDir}）；tar 布局与预期不符`);
  finish();
}

// ── 3. 干净安装（含 postinstall，模拟用户机器）──────────────────────────────
section('3. npm install（含 postinstall）');
{
  const r = npmArgs(['install', '--no-audit', '--no-fund', '--loglevel=error'], installDir);
  if (r.status !== 0) {
    // postinstall 失败会阻塞安装 —— 09bd7d1 修过「失败不阻塞」，这条护栏保证它不再回归。
    fail(`npm install 失败（exit ${r.status}）—— 用户机器上就是「装不上」：${String(r.stderr || r.stdout || '').slice(-500)}`);
    finish();
  }
  ok(`依赖安装完成（node_modules ${fs.readdirSync(path.join(installDir, 'node_modules')).length} 项）`);
  // postinstall 的两个产物必须真的生成：
  const coreDir = path.join(installDir, 'node_modules', 'dsh-dfy-core');
  if (!fs.existsSync(path.join(coreDir, 'backend', 'lib', 'store.js'))) {
    fail('node_modules/dsh-dfy-core 没有被安装（file:/workspace 依赖没物化）—— 插件激活会 ERR_MODULE_NOT_FOUND');
  } else ok('dsh-dfy-core 已物化');
  for (const preset of ['qq-chat', 'qq-chat-v2', 'douyin-chat']) {
    const file = path.join(installDir, 'presets', `${preset}.patch.yml`);
    if (!fs.existsSync(file)) fail(`postinstall 没有生成 presets/${preset}.patch.yml`);
  }
  if (fs.existsSync(path.join(installDir, 'presets', 'qq-chat.patch.yml'))) ok('postinstall 产物（3 个 preset patch）齐全');
}

// ── 4. import 可解析性遍历（插件激活失败的直接原因）──────────────────────────
section('4. 包内 import 可解析性');
{
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 子目录自带 package.json = 独立插件包边界（如 widget/plugins/volc-usage 是
        // 另一个 DSH 插件 dsh-volc-usage 的源码）：它的依赖规则归它自己的
        // package.json 管，不参与本包的 import 图。
        if (fs.existsSync(path.join(full, 'package.json'))) continue;
        walk(full);
      } else if (/\.(js|mjs|cjs)$/.test(entry.name)) files.push(full);
    }
  };
  walk(installDir);
  // optionalDependencies 也要算「声明过」：QQ 集成（@snowluma/sdk / douyin-im）是可选的，
  // 只桌宠模式允许不装；代码侧已全部改成动态 import + 失败兜底，不是裸静态依赖。
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  // 可选依赖（QQ 集成）只能在运行时动态 import：静态 import 会让「没装可选依赖」
  // 在插件加载阶段直接 ERR_MODULE_NOT_FOUND，桌宠也起不来。
  // scripts/ 下是 QQ 诊断脚本，允许静态 import（不会被插件进程加载）。
  const optionalDeps = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  const selfName = String(pkg.name ?? '');
  const relCandidates = (base, spec) => {
    const resolved = path.resolve(base, spec);
    const tries = [resolved,
      `${resolved}.js`, `${resolved}.mjs`, `${resolved}.cjs`, `${resolved}.json`,
      path.join(resolved, 'index.js'), path.join(resolved, 'index.mjs'), path.join(resolved, 'index.cjs'),
      path.join(resolved, 'package.json'),
    ];
    return tries.find((t) => fs.existsSync(t) && fs.statSync(t).isFile());
  };
  const IMPORT_RE = /(?:\bimport\s+[\w*{}\s$,]*\bfrom\s*|\bimport\s*|\bexport\s+[\w*{}\s$,]*\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]*)['"]/g;
  let checked = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(installDir, file).replace(/\\/g, '/');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      // 模块说明符永远不含空白/换行：带空白的「捕获」是字符串字面量或注释里的
      // "import" 字样（whale-widget.js 这类打包产物里很多），直接跳过。
      if (!spec || /\s/.test(spec)) continue;
      checked += 1;
      if (spec.startsWith('node:') || NODE_BUILTINS.has(spec)) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        // 剥掉缓存击穿后缀（backend/vendor/douyin 用 ./x.mjs?v=NN 绕模块缓存）：
        // 磁盘上没有带 ? 的文件，解析必须按裸路径来。
        const bare = spec.replace(/[?#].*$/, '');
        if (OPTIONAL_RELATIVE.has(bare) || OPTIONAL_RELATIVE.has(bare.replace(/\\/g, '/'))) continue;
        const hit = relCandidates(path.dirname(file), bare);
        if (!hit) fail(`${rel}：相对导入解析不到 —— ${spec}`);
        else if (!path.resolve(hit).startsWith(path.resolve(installDir))) fail(`${rel}：相对导入越出包边界 —— ${spec}`);
        continue;
      }
      const scoped = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (optionalDeps.has(scoped) || optionalDeps.has(spec)) {
        const dynamic = /import\s*\(\s*['"][^'"]*['"]$/.test(m[0]);
        if (!dynamic && !rel.startsWith('scripts/')) {
          fail(`${rel}：可选依赖「${spec}」必须用动态 import —— 未安装时静态 import 会让插件加载直接失败`);
        }
      }
      if (deps.has(scoped) || deps.has(spec)) continue;
      if (scoped === selfName || spec === selfName) continue; // 自引用（Node exports self-name）
      if (HOST_PROVIDED_ALLOW.has(scoped)) continue; // 宿主自带、运行时从宿主解析
      fail(`${rel}：裸导入「${spec}」既不在 dependencies、也不在宿主兜底清单 —— 装出来的包解析不到（pnpm 严格模式下必炸）`);
    }
  }
  if (!problems.some((p) => p.includes('裸导入') || p.includes('相对导入'))) {
    ok(`${files.length} 个文件 / ${checked} 条 import 全部可解析`);
  }
}

// ── 5. 宿主遮蔽扫描（昨天 DSH 整体起不来的根因类）────────────────────────────
// 扫**完整安装树**而不是只扫直接依赖：插件依赖的包自己又依赖了宿主同款包时，
// 同样会被提升进 profile 顶层 node_modules 遮蔽宿主（npm 扁平安装把传递依赖
// 都放在顶层 node_modules，扫一层就是全量）。
// 危险名单 = 本机 DSH profile 顶层 node_modules 观察到的宿主自带包
// （2026-11-17 观察；宿主升级新增自带包时同步补这里）。
section('5. 宿主遮蔽扫描');
const HOST_BUNDLED_SCOPES = [
  '@deepseek-ai', '@dsh-ops', '@electron', '@electron-internal', '@anthropic-ai',
  '@babel', '@openai', '@opentelemetry', '@playwright', '@stablelib', '@standard-schema',
];
const HOST_BUNDLED_NAMES = ['electron', 'playwright', 'playwright-core', 'cosmokit', 'schemastery'];
{
  const bad = Object.keys(pkg.dependencies ?? {}).filter((name) => /^@deepseek-ai\//.test(name));
  if (bad.length) {
    fail(`dependencies 里声明了宿主自带作用域的包：${bad.join('、')} —— 安装时会被提升进 profile 顶层 node_modules 遮蔽宿主副本（安装顺序决定谁生效），请改为运行时从宿主解析（参照 src/host-module.mjs）或移除`);
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (HOST_PROVIDED_ALLOW.has(name)) fail(`「${name}」在宿主兜底清单里却出现在 dependencies —— 会形成第二份副本`);
  }
  // 完整安装树（npm 扁平安装：顶层 node_modules 即全部已装包，含传递依赖）。
  const nmDir = path.join(installDir, 'node_modules');
  const shadowed = [];
  try {
    for (const entry of fs.readdirSync(nmDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        if (HOST_BUNDLED_SCOPES.includes(entry.name)) {
          for (const sub of fs.readdirSync(path.join(nmDir, entry.name))) {
            shadowed.push(`${entry.name}/${sub}`);
          }
        }
        continue;
      }
      if (HOST_BUNDLED_NAMES.includes(entry.name)) shadowed.push(entry.name);
    }
  } catch { void 0; }
  if (shadowed.length) {
    fail(`安装树里出现了宿主自带的包（含传递依赖）：${shadowed.join('、')} —— 装进 profile 后会遮蔽宿主副本，可能导致 DSH 整体启动失败；请移除引入它的依赖或改为运行时从宿主解析`);
  } else {
    ok('完整安装树无宿主同款包（直接依赖与传递依赖都不遮蔽宿主）');
  }
}

// ── 6. 关键运行文件校验 ─────────────────────────────────────────────────────
section('6. 关键运行文件');
{
  const mustHave = [
    'lib/index.js', 'lib/client.js',
    'backend/lib/index.js', 'backend/lib/qq-mode.js', 'backend/tools/bili.mjs',
    'src/bridge.js', 'src/gate-events.js',
    'shims/qq-mode/lib/qq-mode.js', 'shims/qq-mode/package.json',
    'cordis.patch.yml', 'config.example.json',
    'presets/qq-chat.patch.yml', 'presets/qq-chat-v2.patch.yml', 'presets/douyin-chat.patch.yml',
    'dsh/agent-presets/qq-chat/preset.yml', 'dsh/agent-presets/qq-chat/agent.cordis.yml',
    'locale/zh.json', 'locale/en.json',
    'astrbot-plugins/astrbot_plugin_dsh_bridge/main.py',
    'packages/dsh-dfy-core/backend/lib/store.js',
    'scripts/setup-dsh.mjs', 'icon.png', 'package.json',
  ];
  const missing = mustHave.filter((rel) => !fs.existsSync(path.join(installDir, rel)));
  if (missing.length) fail(`发布包里缺少运行期关键文件：${missing.join('、')}`);
  else ok(`${mustHave.length} 个关键文件齐全`);
}

// ── 7. 插件激活冒烟（装完能不能真的跑起来 / DSH 升级少了服务会不会炸）──────────
// 静态 import 遍历只能证明「文件找得到」，证明不了 apply() 跑得完：
// 2026-11-17 就是在这里抓到 TDZ（const 声明晚于使用）让整个 surfcore 半边
// 被 try/catch 静默吞掉的。两档能力都跑：当前 DSH + 老版本 DSH。
section('7. 插件激活冒烟');
{
  const runner = path.join(installDir, 'scripts', 'lib', 'activation-smoke.mjs');
  if (!fs.existsSync(runner)) {
    fail('发布包缺少 scripts/lib/activation-smoke.mjs —— 激活冒烟无法运行（打包白名单漏了 scripts/lib？）');
  } else {
    for (const profile of ['full', 'legacy']) {
      const result = spawnSync(process.execPath, [runner, installDir, profile], {
        encoding: 'utf8',
        timeout: 90_000,
        env: { ...process.env, DSH_HOME: path.join(tmp, `home-${profile}`) },
      });
      if (result.status !== 0) {
        fail(`激活冒烟失败（${profile}，exit ${result.status}）：${String(result.stdout || result.stderr || '').slice(-800)}`);
      } else {
        ok(`激活冒烟通过（${profile}）`);
      }
    }
  }
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
function finish() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { void 0; }
  console.log('\n========================================');
  if (problems.length) {
    console.log(`✗ 安装模拟未通过：${problems.length} 个问题（见上）。`);
    process.exit(1);
  }
  console.log(`✓ 安装模拟通过${notes.length ? `（${notes.length} 条备注）` : ''}：pack → 干净安装 → postinstall → import 全解析 → 无宿主遮蔽 → 关键文件齐全。`);
  process.exit(0);
}
finish();
