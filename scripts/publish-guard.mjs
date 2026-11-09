#!/usr/bin/env node
// publish-guard.mjs — 发布守卫：本地 `npm publish` 前，拦住「把主人人设发到公网」。
//
// 为什么需要（真事，不是假想）：
//   · presets/*.patch.yml 与 dsh/agent-presets/persona.system.md 是**构建期生成物**；
//   · 它们的内容来自主人本机的角色卡（人格正文逐字烘焙进 patch 的 persona config.prefix）；
//   · 它们在 .gitignore 里（不进 git，避免人设进仓库历史），但**在本机磁盘上存在**；
//   · npm pack 的 `files` 白名单是按**磁盘**取文件的 —— 于是从本机直接 `npm publish`
//     会把人设快照打进 tarball 发到 npm registry。这是「隐私默认泄漏」，不报错、看不见。
//   正常发版走 CI（.github/workflows/publish.yml，干净 clone ⇒ 生成物不存在 ⇒ 包里没有）。
//   这条守卫只做一件事：本地发布时把这条路堵死，并说清怎么合规发。
//
// 用法：
//   node scripts/publish-guard.mjs          # 发布前检查（被 package.json 的 prepublishOnly 调用）
//   DSH_DFY_ALLOW_PERSONA_SNAPSHOT=1 node scripts/publish-guard.mjs   # 明知故犯时的显式放行（只警告）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SNAPSHOT = path.join(ROOT, 'dsh', 'agent-presets', 'persona.system.md');
const PRESETS_DIR = path.join(ROOT, 'presets');

/** 生成物里出现这些字样，说明本地人设已经烘焙进去了。 */
const PERSONA_MARKERS = ['【人格 · 主人自定义角色卡', '【人格 · ', '## 人格核心', '## 人格语气'];

const problems = [];

if (fs.existsSync(SNAPSHOT)) {
  const size = fs.statSync(SNAPSHOT).size;
  problems.push(`dsh/agent-presets/persona.system.md 存在（${size} 字节）—— 会被 npm pack 打进包里`);
}

if (fs.existsSync(PRESETS_DIR)) {
  for (const name of fs.readdirSync(PRESETS_DIR)) {
    if (!name.endsWith('.patch.yml')) continue;
    const file = path.join(PRESETS_DIR, name);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const hit = PERSONA_MARKERS.find((m) => text.includes(m));
    if (hit) problems.push(`presets/${name} 里烘焙了人格正文（命中「${hit}」）—— 会被打进包里`);
  }
}

if (!problems.length) {
  console.log('[publish-guard] ✅ 未发现本机人设生成物，可以发布。');
  process.exit(0);
}

const allow = process.env.DSH_DFY_ALLOW_PERSONA_SNAPSHOT === '1';
console.log(`[publish-guard]${allow ? ' ⚠️ 已显式放行' : ' ❌ 阻止发布'}：本地工作区里有「主人人设」生成物，直接发布会把它们发到 npm。`);
for (const p of problems) console.log(`  · ${p}`);
if (allow) {
  console.log('[publish-guard] 你设置了 DSH_DFY_ALLOW_PERSONA_SNAPSHOT=1，继续（确认这是你要的结果）。');
  process.exit(0);
}
console.log(`[publish-guard] 合规做法（推荐）：用 CI 发版 —— 打 tag 触发 .github/workflows/publish.yml`);
console.log(`[publish-guard]   git tag v<package.json 版本> && git push origin v<版本>`);
console.log(`[publish-guard] 非要在本机发：先移走生成物、重新生成「无人格」版本，发完再恢复：`);
console.log(`[publish-guard]   mv dsh/agent-presets/persona.system.md /tmp/persona.system.md.bak`);
console.log(`[publish-guard]   node scripts/build-agent-preset-patches.mjs   # 生成不含人格的 patch`);
console.log(`[publish-guard]   npm publish   # 随后把快照移回并重新生成，恢复本机插件的功能`);
process.exit(1);
