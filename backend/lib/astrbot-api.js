/**
 * AstrBot 面板 API 客户端：dsh-Dfy 后端直接调 AstrBot dashboard 的 /api/v1/*。
 *
 * 鉴权不用密码：dashboard 的 HS256 jwt_secret 就存在它自己的 cmd_config.json
 * （dashboard.jwt_secret），签一个带 username claim 的令牌即可（实测 200）。
 * 这里只暴露「减法面板」需要的几个端点，完整配置仍归 AstrBot WebUI：
 *   GET  /api/v1/plugins                     列表（activated/reserved/desc/version）
 *   PATCH /api/v1/plugins/enabled            {plugin_id, enabled}
 *   DELETE /api/v1/plugins/by-id?plugin_id=  卸载
 *   POST /api/v1/plugins/install/url         {url}（github 仓库）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUnified } from './store.js';

const CALL_TIMEOUT = 120_000;

function readAstrbotConfig(cfg) {
  const cwd = cfg.cwd || path.join(os.homedir(), 'astrbot');
  const file = path.join(cwd, 'data', 'cmd_config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** 签 dashboard JWT：HS256，claims 只要求 username（auth.py 只校验它）。 */
function signDashboardToken(dashboardConf) {
  const secret = String(dashboardConf.jwt_secret ?? '');
  if (!secret) throw new Error('AstrBot 配置里没有 dashboard.jwt_secret');
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ username: String(dashboardConf.username ?? 'astrbot'), exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

async function callApi(cfg, method, apiPath, body) {
  const conf = readAstrbotConfig(cfg);
  const token = signDashboardToken(conf.dashboard ?? {});
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}/api/v1${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });
  } catch (error) {
    throw new Error(`AstrBot 不可达（${String(error?.cause?.code ?? error?.message ?? error)}）：先确认它在运行`);
  }
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* 非 JSON 按原文报错 */ }
  if (!res.ok) {
    const detail = Array.isArray(data?.detail)
      ? data.detail.map((d) => d?.msg ?? JSON.stringify(d)).join('；')
      : (data?.detail ?? data?.message ?? text.slice(0, 200));
    throw new Error(`AstrBot API ${res.status}：${detail}`);
  }
  if (data?.status && data.status !== 'ok') throw new Error(data?.message || `AstrBot API 返回 ${data.status}`);
  return data?.data ?? data;
}

export function createAstrbotApi({ log = () => {} } = {}) {
  function cfg() {
    return readUnified().config.astrbot ?? { enabled: true, cwd: '', exe: '', port: 6185 };
  }

  return {
    /** 已装插件列表（过滤内部保留插件），字段归一成面板要用的形状。 */
    async listPlugins() {
      const rows = await callApi(cfg(), 'GET', '/plugins');
      const list = Array.isArray(rows) ? rows : [];
      return list
        .filter((p) => p && p.reserved !== true)
        .map((p) => ({
          name: String(p.name ?? ''),
          version: String(p.version ?? ''),
          desc: String(p.desc ?? ''),
          author: String(p.author ?? ''),
          repo: String(p.repo ?? ''),
          enabled: p.activated === true,
        }));
    },

    /** 从 github 仓库装插件（url 形如 https://github.com/user/repo）。 */
    async installPlugin(url) {
      const repo = String(url ?? '').trim();
      if (!repo) throw new Error('仓库地址不能为空');
      const full = /^https?:\/\//.test(repo) ? repo : `https://github.com/${repo.replace(/^\/+/, '')}`;
      log(`[astrbot] 安装插件：${full}`);
      return callApi(cfg(), 'POST', '/plugins/install/url', { url: full });
    },

    async setPluginEnabled(name, enabled) {
      return callApi(cfg(), 'PATCH', '/plugins/enabled', { plugin_id: String(name), enabled: Boolean(enabled) });
    },

    async uninstallPlugin(name) {
      return callApi(cfg(), 'DELETE', `/plugins/by-id?plugin_id=${encodeURIComponent(String(name))}`);
    },
  };
}
