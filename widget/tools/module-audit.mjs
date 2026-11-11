#!/usr/bin/env node
/**
 * 功能模块审计（module audit）—— 出站管道之外的「同一件事多处实现」。
 *
 * 为什么需要：
 *   2026-11-11 用户原话——
 *     「做，不光是这一个地方，别的功能模块都要查清楚，不然这些问题随时随地的爆出来，
 *       然后陷入死循环打补丁的流程」
 *     「不对啊，你就只查了对话流程的，别的都没有查过」
 *
 *   上一轮把「模型回复」收口到了 outbound-reply.mjs，但其它模块仍在各自造轮子：
 *     · 状态文件：有人用 tmp+rename，有人直接 writeFileSync（写一半被读 → 读侧 catch
 *       静默回落默认值 → 表现为「配置被重置 / 登录没了 / 记忆丢了」）；
 *     · 网络请求：有人带 AbortSignal.timeout，有人裸 fetch（断网/服务卡死时永久挂起，
 *       表现为「点了没反应」「扫码一直转圈」「更新卡在检查中」）；
 *     · 原子写实现本身被复制了 6 份，临时名/失败清理还不一样。
 *
 *   这里把这三类问题变成可执行的检查，而不是靠人记得。
 *
 * 0 依赖，CI 直接跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_DIRS = ['src', 'backend', 'packages/dsh-dfy-core'].map((d) => path.join(ROOT, d));
// 不参与运行时检查的目录：
//   · */tools   —— 开发者命令行脚本（手动跑）
//   · vendor    —— 第三方 vendor 代码
const EXCLUDE_DIRS = ['backend/tools', 'backend/vendor', 'packages/dsh-dfy-core/backend/tools'];

const failures = [];
const notes = [];
const ok = (m) => notes.push(m);
const fail = (m) => failures.push(m);

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
const isExcluded = (file) => {
  const r = rel(file);
  return EXCLUDE_DIRS.some((d) => r === d || r.startsWith(`${d}/`));
};

const files = SOURCE_DIRS.flatMap((d) => walk(d)).filter((f) => !isExcluded(f));
const readAll = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

// 行内注释/块注释行不参与判断（文档里会举出 `fs.writeFileSync(STATE, …)` 这种反例）。
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** 从 `openIndex`（指向 `(`）开始找配对的 `)`，返回结束下标；找不到返回 -1。 */
function matchingParen(text, openIndex) {
  let depth = 0;
  let quote = '';
  for (let i = openIndex; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const lineOf = (text, index) => text.slice(0, index).split(/\r?\n/).length;

// ── 1) 状态文件必须原子写 ────────────────────────────────────────────────
// 判据：只要不是「临时文件 / wx 原子创建 / 显式截断 / 后随 rename」，就视为非原子写。
// 允许清单：只放「规则识别不了、但人工确认安全」的极少数例外。
// 每条都要有理由，不要为了过审计随手加。
const ATOMIC_ALLOW = new Set([]);

const atomicOffenders = [];
for (const file of files) {
  const text = readAll(file);
  const lines = text.split(/\r?\n/);
  const re = /fs\.writeFileSync\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const line = lineOf(text, m.index);
    const sourceLine = lines[line - 1] ?? '';
    if (isCommentLine(sourceLine)) continue;
    const open = text.indexOf('(', m.index);
    const close = matchingParen(text, open);
    const call = close > 0 ? text.slice(m.index, close + 1) : sourceLine;

    // 独立临时文件（os.tmpdir / *.tmp / tmpXxx / temporary / part / quarantine / probe / .vbs）
    // 本身就是过渡产物，不是最终状态文件。临时名可能在上几行赋值，所以要带上上下文。
    const ctx = `${lines.slice(Math.max(0, line - 3), line).join('\n')}\n${call}`;
    if (/os\.tmpdir\s*\(|tmpdir\s*\(|\btmp\w*\b|temporary|quarantine|\.vbs|\bpart\b/i.test(ctx)) continue;
    // 显式截断成空串（清空日志/账本）不会产生半截 JSON。
    if (/writeFileSync\s*\([^,]+,\s*(?:''|""|``|\s*\))/.test(call)) continue;
    // 原子创建（wx）本身就是原子的。
    if (/flag\s*:\s*['"]wx['"]/.test(call)) continue;

    const target = (call.slice(call.indexOf('(') + 1).split(',')[0] ?? '').trim();
    // 文件描述符（fs.openSync 拿到的 fd）不是路径，写入位置由 open 决定。
    if (/^(?:descriptor|fd|output|handle|stream)\b/i.test(target) && /openSync\s*\(/.test(text)) continue;

    // 同目录临时文件 + rename：后面 8 行内出现 renameSync 视为原子写。
    const after = lines.slice(line - 1, line + 8).join('\n');
    if (/renameSync\s*\(/.test(after)) continue;

    const key = `${rel(file)}:${line}`;
    if (ATOMIC_ALLOW.has(key)) continue;

    atomicOffenders.push({ file: rel(file), line, target: target.slice(0, 80) });
  }
}
if (atomicOffenders.length) {
  for (const o of atomicOffenders) {
    fail(`[原子写] ${o.file}:${o.line} 直接写状态文件（写到一半被读会得到半截 JSON）：${o.target}；请用 writeFileAtomic / writeJsonAtomic`);
  }
} else ok('所有状态/配置/凭据写入都是原子写（tmp + rename）');

// ── 2) 原子写实现不得再复制 ──────────────────────────────────────────────
// 允许「薄封装」（函数体里调用共享实现），但不允许自己再写一遍 tmp+rename。
const SHARED_ATOMIC = 'packages/dsh-dfy-core/src/atomic-write.js';
const atomicImpls = [];
for (const file of files) {
  const r = rel(file);
  if (r === SHARED_ATOMIC) continue;
  const text = readAll(file);
  const re = /function\s+(write\w*Atomic\w*)\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('(', m.index);
    const close = matchingParen(text, open);
    const body = close > 0 ? text.slice(open, Math.min(text.length, close + 400)) : '';
    if (/writeFileAtomic|writeJsonFileAtomic|writeTextAtomic|writeJsonAtomic/.test(body)) continue;
    atomicImpls.push({ file: r, line: lineOf(text, m.index), name: m[1] });
  }
}
if (atomicImpls.length) {
  for (const item of atomicImpls) {
    fail(`[原子写] ${item.file}:${item.line} 又实现了一遍 ${item.name}()；请调用 atomic-write.js 的 writeFileAtomic / writeJsonFileAtomic`);
  }
} else ok('原子写只有 atomic-write.js 一份实现，其它都是薄封装');

// ── 3) 网络请求必须有超时 ────────────────────────────────────────────────
// 断网 / 对端不响应时，裸 fetch 会永久挂起：扫码一直转圈、更新卡在「检查中」、
// 点保存没反应。每个出口都必须带可取消的超时。
const FETCH_ALLOW = new Map([
  // 本机 DSH RPC：signal 由调用方传入（init.signal），且部分接口是长连接/流式，
  // 不能在这里强加固定超时（会把正常的长时间回合切断）。
  ['src/dsh-client.js', 'caller-provided signal；流式 RPC 由调用方控制超时'],
]);
const fetchOffenders = [];
for (const file of files) {
  const text = readAll(file);
  const re = /(?<![\w$.])fetch\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const index = m.index;
    // 跳过字符串/模板字符串里出现的 fetch（例如 Runtime.evaluate 的页面脚本）。
    let j = index - 1;
    while (j >= 0 && /\s/.test(text[j])) j -= 1;
    if (j >= 0 && (text[j] === '\'' || text[j] === '"' || text[j] === '`')) continue;

    const open = text.indexOf('(', index);
    const close = matchingParen(text, open);
    const call = close > 0 ? text.slice(index, close + 1) : '';
    if (/signal\s*:|AbortSignal|AbortController/.test(call)) continue;
    const r = rel(file);
    if (FETCH_ALLOW.has(r)) continue;
    fetchOffenders.push({ file: r, line: lineOf(text, index) });
  }
}
if (fetchOffenders.length) {
  for (const o of fetchOffenders) {
    fail(`[网络超时] ${o.file}:${o.line} fetch 没有超时（对端不响应时会永久挂起）；请加 signal: AbortSignal.timeout(ms)`);
  }
} else ok('所有 fetch 都带超时或由调用方传入 signal');

// ── 4) 记忆平台可见性：失败关闭 ──────────────────────────────────────────
// 记忆卡/记忆召回都必须「只有明确传 qq 才给私聊全量」，其余一律公开块。
// 否则将来新平台调用时漏传参数，会把私聊记忆注入群聊提示词。
const memCard = readAll(path.join(ROOT, 'backend/lib/memory-card.js'));
if (!/platform\s*===\s*['"]qq['"]\s*\?\s*paths\.promptQq\s*:\s*paths\.promptBili/.test(memCard)) {
  fail('[记忆可见性] backend/lib/memory-card.js 的平台判定不再「失败关闭」：只有显式 qq 才应给私聊块');
} else ok('记忆卡注入：只有显式 qq 才给私聊全量');
const memRecall = readAll(path.join(ROOT, 'src/memory-recall.mjs'));
if (!/platform\s*=\s*['"]bili['"]/.test(memRecall)) {
  fail('[记忆可见性] src/memory-recall.mjs 的 promptBlock 默认平台不是 bili（漏传参数会泄漏私聊记忆）');
} else ok('记忆召回：默认按公开场合（失败关闭）');

// ── 5) 无限循环必须有显式出口 ────────────────────────────────────────────
// `while (true)` / `for (;;)` 本身不是错，但每一条都必须能说清「什么时候退出」。
// 允许在上一行写 `loop-allow: <原因>` 显式登记；没登记的一律视为死循环风险。
const loopOffenders = [];
for (const file of files) {
  const lines = readAll(file).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    if (!/while\s*\(\s*(?:true|1)\s*\)|for\s*\(\s*;\s*;\s*\)/.test(line)) return;
    const ctx = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
    if (/loop-allow:/.test(ctx)) return;
    loopOffenders.push({ file: rel(file), line: i + 1 });
  });
}
if (loopOffenders.length) {
  for (const o of loopOffenders) {
    fail(`[死循环] ${o.file}:${o.line} 无条件循环没有登记出口；请改成有界循环，或在上一行写 loop-allow: <退出条件>`);
  }
} else ok('所有 while(true)/for(;;) 都登记了退出条件');

// ── 6) 正则 exec 循环必须有零长度兜底 ────────────────────────────────────
// `while ((m = re.exec(text)))` 遇到「能匹配空串」的正则时 lastIndex 不前进 → 死循环。
// 这不是理论问题：改一条正则（比如加个 `|`）就可能让线上卡死。
const execOffenders = [];
for (const file of files) {
  const lines = readAll(file).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/while\s*\(\s*\(?\s*[A-Za-z_$][\w$]*\s*=\s*[^)]*\.exec\s*\(/.test(line)) return;
    if (/while\s*\(\s*(?:true|1)\s*\)/.test(line)) return;
    const win = lines.slice(i, i + 8).join('\n');
    if (/\.length\s*===\s*0|\.length\s*<\s*1|!\s*[A-Za-z_$][\w$]*\[0\]/.test(win)) return;
    execOffenders.push({ file: rel(file), line: i + 1 });
  });
}
if (execOffenders.length) {
  for (const o of execOffenders) {
    fail(`[死循环] ${o.file}:${o.line} 正则 exec 循环没有零长度兜底；请加 if (match[0].length === 0) break;`);
  }
} else ok('所有正则 exec 循环都有零长度兜底');

// ── 7) 模块 id 清单不得分叉 ──────────────────────────────────────────────
// store 保存时按 MODULE_IDS 裁剪键；modules.js 决定设置页与接口 410。
// 两边不一致的后果：设置页有开关、保存后被裁掉 → 用户以为改了、其实没生效。
const moduleIds = (() => {
  const t = readAll(path.join(ROOT, 'packages/dsh-dfy-core/src/module-ids.js'));
  const m = /MODULE_IDS\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]/.exec(t);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
})();
const registryIds = (() => {
  const t = readAll(path.join(ROOT, 'backend/lib/modules.js'));
  return [...t.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((x) => x[1]);
})();
if (!moduleIds.length || !registryIds.length) {
  fail('[模块清单] 读不到 MODULE_IDS 或 modules.js 的 MODULES（清单结构被改坏了）');
} else if (moduleIds.join(',') !== registryIds.join(',')) {
  fail(`[模块清单] core MODULE_IDS = [${moduleIds.join(', ')}]，modules.js = [${registryIds.join(', ')}]；两边必须一致`);
} else ok(`模块 id 清单一致（${moduleIds.length} 个）`);

// ── 8) B站 Cookie 头只有一处拼装 ─────────────────────────────────────────
// 读写接口 / 扫码校验 / 手填 SESSDATA 后的 nav 校验曾经各拼一份；
// B站 改字段时漏改一处就表现为「明明登录了却说没凭据」。
const biliCookieOffenders = files
  .filter((f) => rel(f) !== 'src/bili-api.js')
  .filter((f) => /SESSDATA=\$\{/.test(readAll(f)))
  .map((f) => rel(f));
if (biliCookieOffenders.length) {
  for (const f of biliCookieOffenders) fail(`[B站凭据] ${f} 自己拼了 Cookie 头；请用 bili-api.js 的 biliCookieHeader()`);
} else ok('B站 Cookie 头只有 bili-api.js 一份拼装');

// ── 结果 ────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  ok   ${n}`);
if (failures.length) {
  console.error('\n功能模块审计失败：');
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('\n修复方向：把状态写/网络超时/循环出口统一到共享实现，而不是各模块各写一份。');
  process.exit(1);
}
console.log('\n✔ 功能模块审计通过：原子写 / 网络超时 / 循环出口 / 记忆可见性 / 模块清单都只有一份口径。');
