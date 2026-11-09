#!/usr/bin/env node
/**
 * 模块导入冒烟审计（module-import-audit）—— 盲区②「时序/竞态」之外补的
 * 「加载期」护栏：node --check 只验语法，**不解析 import 链**。 Wrong specifier /
 * 循环导入 / 顶层运行时错误，都要到 DSH 加载插件时才爆 → 表现为「插件整个消失」
 * （2026-11-09 事故：preset-sync.js/mjs 扩展名不一致，桌宠+设置面板全没）。
 *
 * 本脚本用 Node 的动态 import 实际加载插件全部核心模块，任何一个失败即失败。
 * 带超时护栏：模块若在顶层挂起（不该发生），10 秒判失败。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MODULES = [
  'backend/lib/index.js',
  'backend/lib/preset-sync.mjs',
  'backend/lib/qq-direct.js',
  'backend/lib/scheduler.js',
  'backend/lib/memory-card.js',
  'backend/lib/dfy-raw-chat.js',
  'backend/lib/pet-chat.js',
  'backend/lib/douyin-im.js',
  'backend/lib/astrbot-api.js',
  'backend/qq-tool-restrict.mjs',
  'src/bridge.js',
  'src/voice-routes.mjs',
  'src/redact-paths.mjs',
  'src/memory-recall.mjs',
  'src/token-guard.js',
  'src/persona-layers.js',
  'src/dsh-client.js',
  'packages/dsh-dfy-core/backend/lib/store.js',
  'packages/dsh-dfy-core/src/memory-card.js',
];

let failed = 0;
for (const rel of MODULES) {
  const url = `file://${path.join(ROOT, rel).replace(/\\/g, '/')}`;
  const result = await Promise.race([
    import(url).then(() => 'ok', (e) => `error: ${String(e?.message ?? e).slice(0, 140)}`),
    new Promise((resolve) => setTimeout(() => resolve('timeout: 顶层挂起（>10s）'), 10_000)),
  ]);
  if (result === 'ok') {
    console.log(`  ok   ${rel}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${rel} → ${result}`);
  }
}

if (failed) {
  console.error(`\n模块导入冒烟失败：${failed} 个模块加载出错——DSH 加载插件时会整包失败（桌宠/设置面板全消失）。`);
  process.exit(1);
}
console.log(`\n✔ 模块导入冒烟通过：${MODULES.length} 个核心模块全部可加载。`);
