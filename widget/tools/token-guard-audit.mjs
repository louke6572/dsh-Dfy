#!/usr/bin/env node
/**
 * Token 守卫边界/竞态审计（token-guard-audit）—— 盲区②「时序与竞态」里
 * 可机器验证的部分：守卫是纯函数 + 同步先占额度，这一层的不变式值得钉死：
 *   1) evaluateOutbound 边界：第 max 条放行、第 max+1 条必拦、disabled 直通、
 *      NaN/负数/非整数输入不炸且走安全分支；
 *   2) 竞态不变式：共享计数器上连续 N 次「先查后占」 claim，放行总数 ≤ max
 *      （守卫为同步纯函数，进程内不存在 TOCTOU；此断言防未来改成异步后回归）；
 *   3) evaluateWakeBudget：当日零点边界、direct 绕过日限/间隔、花费阈值、
 *      maxDay=0 视为不限、retryAfterMs 永远为正。
 */
import { evaluateOutbound, evaluateWakeBudget, localDayStart, msUntilNextLocalDay, DEFAULT_TOKEN_GUARD } from '../../src/token-guard.js';

const failures = [];
const fail = (m) => failures.push(m);
const eq = (a, b, m) => { if (a !== b) fail(`${m}：期望 ${b}，实际 ${a}`); };

// ── 1) evaluateOutbound 边界 ──
const max = DEFAULT_TOKEN_GUARD.maxOutboundPerTurn; // 8
for (let used = 0; used <= max; used += 1) {
  const r = evaluateOutbound({ used, count: 1 });
  // 契约：used + count > max 才拦（第 max 条本身放行，第 max+1 条必拦）
  if (used < max && r.blocked) fail(`outbound used=${used}(<max) 不应拦截`);
  if (used === max && !r.blocked) fail(`outbound used=${used}(=max) 再发 1 条必须拦截`);
}
const over = evaluateOutbound({ used: max, count: 1 });
if (!over.blocked) fail('outbound used=max 再发 1 条必须拦截');
eq(over.next, max + 1, 'outbound 拦截时 next 仍应记账');
const batch = evaluateOutbound({ used: max - 2, count: 3 });
if (!batch.blocked) fail('outbound 一次 count=3 跨过上限必须整批拦截');
if (evaluateOutbound({ used: 0, count: max }).blocked) fail('outbound 恰好 max 条应放行');
if (!evaluateOutbound({ used: 0, count: max + 1 }).blocked) fail('outbound max+1 条应拦截');
if (evaluateOutbound({ used: 5, count: 1, guard: { ...DEFAULT_TOKEN_GUARD, enabled: false } }).blocked) fail('guard disabled 不应拦截');
// 垃圾输入不炸
for (const bad of [NaN, -3, 1.5, '7', null, undefined]) {
  const r = evaluateOutbound({ used: bad, count: 1 });
  if (typeof r?.blocked !== 'boolean') fail(`outbound used=${String(bad)} 输出异常`);
}

// ── 2) 竞态不变式：共享计数器连续 claim ──
{
  let counter = 0;
  let allowed = 0;
  const claims = 50;
  for (let i = 0; i < claims; i += 1) {
    const r = evaluateOutbound({ used: counter, count: 1 });
    if (!r.blocked) { allowed += 1; counter = r.next; }
  }
  if (allowed !== max) fail(`竞态不变式：连续 claim ${claims} 次应恰好放行 ${max} 条，实际 ${allowed}`);
}

// ── 3) evaluateWakeBudget ──
{
  const now = Date.now();
  const g = DEFAULT_TOKEN_GUARD;
  // 当日计数：今天 3 次 + 昨天 5 次 → dayCount=3
  const times = [now - 3600_000, now - 7200_000, now - 10800_000, localDayStart(now) - 1000, localDayStart(now) - 86_400_000];
  const r = evaluateWakeBudget({ key: 'group:123', wakeTimes: times, now, guard: g });
  if (r.blocked) fail('日内 3 次（<max 20）不应拦截');
  eq(r.dayCount, 3, 'dayCount 只数今天');
  // 拉满到上限 → 拦截 + retryAfterMs 指向明天零点
  const full = Array.from({ length: g.maxWakesPerDay }, (_, i) => now - i * 1000);
  const blocked = evaluateWakeBudget({ key: 'group:123', wakeTimes: full, now, guard: g });
  if (!blocked.blocked || blocked.reason !== 'day') fail('当日次数拉满必须按 day 拦截');
  if (!(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= msUntilNextLocalDay(now))) fail('day 拦截的 retryAfterMs 应 ≤ 距明天零点');
  // direct 绕过日限
  const bypass = evaluateWakeBudget({ key: 'group:123', wakeTimes: full, now, guard: g, direct: true });
  if (bypass.blocked) fail('direct=true 应绕过每日上限');
  // 私聊日限独立（更小）
  const priv = evaluateWakeBudget({ key: 'private:456', wakeTimes: Array.from({ length: g.privateMaxWakesPerDay }, (_, i) => now - i * 1000), now, guard: g });
  if (!priv.blocked || priv.reason !== 'day') fail('私聊达到 privateMaxWakesPerDay 必须拦截');
  // 花费阈值
  const cost = evaluateWakeBudget({ key: 'group:123', wakeTimes: [], now, guard: g, cost: g.maxDailyCostCNY });
  if (!cost.blocked || cost.reason !== 'cost') fail('花费 ≥ 上限必须按 cost 拦截');
  // minWakeGap
  const gap = evaluateWakeBudget({ key: 'group:123', wakeTimes: [now - 30_000], now, guard: g });
  if (!gap.blocked || gap.reason !== 'gap') fail('距上次唤醒小于 minWakeGapMs 应按 gap 拦截');
  if (!(gap.retryAfterMs > 0)) fail('gap 拦截的 retryAfterMs 应为正');
  // maxDay=0 = 不限次（direct=true 同时绕过 gap，隔离出「日限」这一个变量）
  const unlimited = evaluateWakeBudget({ key: 'group:123', wakeTimes: Array.from({ length: 99 }, (_, i) => now - i * 1000), now, guard: { ...g, maxWakesPerDay: 0, privateMaxWakesPerDay: 0 }, direct: true });
  if (unlimited.blocked) fail(`maxDay=0 应视为不限次（实际按 ${unlimited.reason ?? '?'} 拦截）`);
}

for (const f of failures) console.error(`  ✗ ${f}`);
if (failures.length) { console.error(`\nToken 守卫审计失败（${failures.length} 条）`); process.exit(1); }
console.log('✔ Token 守卫审计通过：出站边界/竞态不变式/唤醒预算全部符合契约。');
