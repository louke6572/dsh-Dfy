#!/usr/bin/env node
/**
 * 人格分层组合审计（persona-layers-audit）—— 防两类 token 浪费回归：
 *   1) 层间重复：模板/迁移常把 persona.md 原样复制进 persona.tone.md，
 *      full 模式会把同一份人格+语料整段注入两遍（2026-11-09 实测浪费约一半）；
 *   2) 作者注释泄漏：卡文件里的「## 用法说明」（温度/用法建议）是写给改卡人看的，
 *      不该进模型上下文。
 * 另外钉住既有行为：legacy 单核心无标题、tone 模式省核心、预算截断。
 */
import { composePersonaLayers } from '../../src/persona-layers.js';

const failures = [];
const fail = (m) => failures.push(m);
const okc = (cond, m) => { if (cond) ; else fail(m); };

const CORE = '你是 DeepSeek，也叫小鲸鱼。\n\n话短。懒。有态度。\n\n## 用法说明\n\n1. 温度 0.9–1.1。\n2. 优先加语料，别加描述。\n';
const TONE_SAME = CORE; // 模板复制出来的同内容语气层
const TONE_DIFF = '语气：更凶一点，骂人不带脏字。\n';
const DAILY = '今天去了趟地铁。';
const IDENTITY = '你的主人是主人。';

// 1) core+tone 内容相同 → 语气层去重，作者注释剥掉，内容只出现一次
{
  const r = composePersonaLayers({ core: CORE, tone: TONE_SAME, identity: IDENTITY, personaMode: 'full', mode: 'v1', maxChars: 0 });
  okc(!r.text.includes('人格语气'), '相同内容的语气层应被去重（不应出现【人格语气】）');
  okc(!r.text.includes('用法说明'), '作者注释「## 用法说明」不应注入');
  okc((r.text.match(/话短。懒。有态度。/g) || []).length === 1, '人格正文应只出现一次');
  okc(r.text.includes('身份底座'), '身份底座应保留');
  okc(!r.text.includes('温度 0.9'), '作者注释正文（温度建议）不应注入');
}

// 2) core 与 tone 内容不同 → 两层都保留
{
  const r = composePersonaLayers({ core: CORE, tone: TONE_DIFF, identity: IDENTITY, personaMode: 'full', mode: 'v1', maxChars: 0 });
  okc(r.text.includes('人格核心'), '不同的语气层：核心应保留');
  okc(r.text.includes('人格语气'), '不同的语气层：语气应保留');
  okc(r.text.includes('更凶一点'), '语气正文应注入');
}

// 3) legacy：只有核心 → 不加层标题（旧行为）
{
  const r = composePersonaLayers({ core: CORE, personaMode: 'full', mode: 'v1', maxChars: 0 });
  okc(r.text.startsWith('你是 DeepSeek'), '单核心应无层标题（旧行为）');
  okc(!r.text.includes('用法说明'), '单核心也应剥作者注释');
}

// 4) tone 模式且写了语气 → 不带核心
{
  const r = composePersonaLayers({ core: CORE, tone: TONE_DIFF, identity: IDENTITY, personaMode: 'tone', mode: 'v1', maxChars: 0 });
  okc(!r.text.includes('人格核心'), 'tone 模式不应带核心');
  okc(r.text.includes('更凶一点'), 'tone 模式应带语气');
}

// 5) 预算截断仍然生效
{
  const r = composePersonaLayers({ core: 'A'.repeat(3000), tone: '', personaMode: 'full', mode: 'v1', maxChars: 1000 });
  if (r.chars > 1000) fail(`预算截断失效：输出 ${r.chars} > 1000`);
  if (r.text.includes('用法说明')) fail('截断路径仍泄漏作者注释');
}

for (const f of failures) console.error(`  ✗ ${f}`);
if (failures.length) { console.error(`\n人格分层审计失败（${failures.length} 条）`); process.exit(1); }
console.log('✔ 人格分层审计通过：重复层去重、作者注释剥离、legacy/tone/预算行为不变。');
