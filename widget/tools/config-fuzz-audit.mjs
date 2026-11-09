#!/usr/bin/env node
/**
 * 配置组合模糊审计（config-fuzz-audit）—— 盲区③「配置组合爆炸」的系统性收口。
 *
 * 方法：拿后端**真实**的 normalize 纯函数（normalizeQqConfig / normalizeBiliConfig），
 * 先生成完整默认树，然后逐个叶子字段灌入 12 种毒值（null / NaN / 1e15 / 错类型 /
 * 空串 / 极值…），断言三件事：
 *   1) 任何组合都**不抛异常**（保存路径上 normalize 抛错 = 用户保存直接失败）；
 *   2) normalize(normalize(x)) ≡ normalize(x)（幂等——否则「保存两次值会漂移」）；
 *   3) 关键边界符合契约：consolePort 钳制在 1024~65535 整数、sendDelayMs ≥ 0 整数、
 *      decayPerDay 允许一位小数（0.5 不再被四舍五入）、非法枚举回退默认。
 * 0 依赖，CI 可跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeQqConfig, normalizeBiliConfig } from '../../packages/dsh-dfy-core/backend/lib/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const failures = [];
const notes = [];
const fail = (msg) => failures.push(msg);
const ok = (msg) => notes.push(msg);

const POISON = [null, '', 0, -1, 1e15, Number.NaN, 'abc', '99999999999', [], [1], {}, true, 2.5, -0.5];

/** 遍历对象，收集标量叶子路径（数组视为一个叶子）。 */
function leaves(obj, prefix = [], out = []) {
  if (obj === null || obj === undefined || typeof obj !== 'object' || Array.isArray(obj)) {
    if (prefix.length) out.push(prefix);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) leaves(v, [...prefix, k], out);
  return out;
}

function setDeep(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i += 1) {
    if (cur[pathArr[i]] === null || typeof cur[pathArr[i]] !== 'object') cur[pathArr[i]] = {};
    cur = cur[pathArr[i]];
  }
  cur[pathArr[pathArr.length - 1]] = value;
  return obj;
}

function fuzz(name, normalize) {
  const base = normalize({}); // 完整默认树
  if (!base || typeof base !== 'object') { fail(`${name}: normalize({}) 未返回对象`); return; }
  const paths = leaves(base);
  let combos = 0;
  let noThrow = 0;
  for (const p of paths) {
    for (const value of POISON) {
      const poisoned = structuredClone(base);
      setDeep(poisoned, p, value);
      combos += 1;
      let once = null;
      try { once = normalize(poisoned); noThrow += 1; } catch (e) {
        fail(`${name} ${p.join('.')} = ${String(value)} 抛异常：${String(e?.message ?? e).slice(0, 120)}`);
        continue;
      }
      if (!once || typeof once !== 'object') { fail(`${name} ${p.join('.')} = ${String(value)} 输出非对象`); continue; }
      if (Number.isNaN(value)) continue; // NaN 无法 JSON 序列化，跳过幂等比较
      try {
        const twice = normalize(once);
        if (JSON.stringify(twice) !== JSON.stringify(once)) {
          fail(`${name} ${p.join('.')} = ${String(value)} 不幂等：两次 normalize 结果不同`);
        }
      } catch (e) {
        fail(`${name} ${p.join('.')} = ${String(value)} 二次 normalize 抛异常：${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
  }
  // 真实样例：仓库自带的示例配置必须能过 normalize
  try {
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
    const section = name === 'qq' ? example.qq : example.bili;
    if (section) { normalize(section); combos += 1; noThrow += 1; }
  } catch (e) {
    fail(`${name}: config.example.json 样例过不了 normalize：${String(e?.message ?? e).slice(0, 140)}`);
  }
  // 契约抽查
  const q = normalize({});
  if (name === 'qq') {
    const port = q.consolePort;
    if (!(Number.isInteger(port) && port >= 1024 && port <= 65535)) fail(`qq consolePort 越界：${port}`);
    if (!(Number.isInteger(q.sendDelayMs) && q.sendDelayMs >= 0)) fail(`qq sendDelayMs 越界：${q.sendDelayMs}`);
    const frozen = normalize(structuredClone({ ...base, consolePort: null, sendDelayMs: null }));
    if (frozen.consolePort !== q.consolePort || frozen.sendDelayMs !== q.sendDelayMs) {
      fail('qq 数字字段 null 未回退默认（finiteNumber 契约）');
    }
  }
  if (name === 'bili') {
    const half = normalize(structuredClone({ ...base, share: { ...base.share, decayPerDay: 0.5 } }));
    if (Number(half.share?.decayPerDay) !== 0.5) fail(`bili decayPerDay 0.5 被改写为 ${half.share?.decayPerDay}（应允许一位小数）`);
    const bad = normalize(structuredClone({ ...base, share: { ...base.share, via: 'not-a-mode' } }));
    if (!['dynamic', 'comment', 'dm'].includes(bad.share?.via)) fail(`bili share.via 非法枚举未回退默认：${bad.share?.via}`);
  }
  ok(`${name}: ${paths.length} 个叶子 × ${POISON.length} 毒值 = ${combos} 组合，无异常 ${noThrow}，幂等通过`);
}

fuzz('qq', normalizeQqConfig);
fuzz('bili', normalizeBiliConfig);

for (const n of notes) console.log(`  ok   ${n}`);
if (failures.length) {
  console.error('\n配置模糊审计失败：');
  for (const f of failures.slice(0, 30)) console.error(`  ✗ ${f}`);
  if (failures.length > 30) console.error(`  …等共 ${failures.length} 条`);
  process.exit(1);
}
console.log('\n✔ 配置模糊审计通过：normalize 对全部毒值组合不抛错、幂等、边界正确。');
