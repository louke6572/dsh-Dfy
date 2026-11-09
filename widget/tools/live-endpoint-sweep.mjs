#!/usr/bin/env node
/**
 * 运行中服务的全端点真实巡检（live-endpoint-sweep）—— 盲区①「真实交互」的可达部分。
 *
 * 静态审计（ci-audit）保证「前端引用的每条路由后端都有」；本脚本进一步保证
 * 「这些路由在**当前运行的服务**上真的能出 200」——能抓到静态查不到的：
 * 服务进程是旧代码、运行期配置导致 handler 抛 500、宿主版本差异等。
 *
 * 用法：node widget/tools/live-endpoint-sweep.mjs [baseUrl]
 *   baseUrl 缺省时按常见端口自动探测。鉴权复用 NodeApiClient 的 token→cookie 通道。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, discoverDshLaunchToken } from '../../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const explicit = process.argv[2] || '';
const cfgFile = path.join(os.homedir(), '.dsh', 'surfcore', 'qq', 'config.json');
let dsh = {};
try { dsh = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')).dsh ?? {}; } catch {}

// 1) 提取全部注册路由（与 ci-audit 同源的 38 条）
const hostSrc = fs.readFileSync(path.join(ROOT, 'widget', 'lib', 'index.js'), 'utf8');
const paths = [...hostSrc.matchAll(/path:\s*'(\/dsh-whale\/[^'?]+)'/g)].map((m) => m[1]);
const uniq = [...new Set(paths)];
if (!uniq.length) { console.error('未提取到任何路由'); process.exit(1); }

// 2) 探测 base
//   以前是四个**写死的旧端口**（56159/58058/60839/3080）——DSH 端口是随机挑的，
//   于是这个脚本在绝大多数机器上只会打印「探测不到可用的 DSH 服务」然后退出 0：
//   看着"跑过了"，其实一条路由都没测（验证部署变成了空转）。
//   现在按「现役来源」优先探测：显式参数 → 环境变量 → 桌宠 host.json（插件自己写的 baseUrl，
//   最准）→ 设置里的 dsh.baseUrl → 最后才是旧端口兜底。
function readPetBaseUrl() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.dsh', 'surfcore', 'qq', 'pet', 'host.json'), 'utf8');
    const j = JSON.parse(raw);
    return String(j?.baseUrl || '').trim();
  } catch { return ''; }
}
const candidates = [...new Set([
  explicit,
  process.env.DSH_WEB_URL || '',
  readPetBaseUrl(),
  dsh.baseUrl || '',
  'http://127.0.0.1:56159', 'http://127.0.0.1:58058', 'http://127.0.0.1:60839', 'http://127.0.0.1:3080',
].map((s) => String(s || '').trim().replace(/\/+$/, '')).filter(Boolean))];
let client = null;
let base = '';
for (const b of candidates) {
  try {
    const c = new NodeApiClient(b, undefined, {
      token: dsh.authToken || discoverDshLaunchToken(),
      tokenExplicit: dsh.authTokenExplicit === true,
      header: dsh.authHeader,
      prefix: dsh.authPrefix,
      allowRemote: dsh.allowRemote === true,
    });
    const r = await c._doFetchWithAuth(`${b}/dsh-whale/balance.json`, { headers: { accept: 'application/json' } });
    await r.body?.cancel();
    if (r.status < 500) { client = c; base = b; break; }
  } catch { /* 下一个候选 */ }
}
if (!client) { console.error('探测不到可用的 DSH 服务（试过：' + candidates.join(', ') + '）'); process.exit(1); }
console.log(`目标：${base}　注册路由：${uniq.length} 条\n`);

// 3) 逐条 GET
const results = [];
for (const p of uniq) {
  let status = 0;
  let error = '';
  try {
    const r = await client._doFetchWithAuth(base + p, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    status = r.status;
    await r.body?.cancel().catch(() => {});
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 80);
  }
  results.push({ path: p, status, error });
}

let pass = 0, warn = 0, failCount = 0;
for (const { path: p, status, error } of results) {
  if (status === 200) { pass += 1; continue; }
  if (status === 404 && /\.(png|gif|mp3|wav)$/.test(p)) { warn += 1; console.log(`  ~ ${status} ${p}（素材/参数型路由，空参 404 可接受）`); continue; }
  if (status >= 500 || status === 0) { failCount += 1; console.log(`  ✗ ${status || 'ERR'} ${p}${error ? ' — ' + error : ''}`); continue; }
  warn += 1;
  console.log(`  ~ ${status} ${p}`);
}
console.log(`\n结果：200 通过 ${pass}；可接受 ${warn}；异常 ${failCount}`);
process.exit(failCount ? 1 : 0);
