/**
 * 人格 → Agent 预设 同步（preset-sync）。
 *
 * 设计（2026-11-09 用户定）：人格的**稳定部分**（身份底座 / 人格核心 / 语气）
 * 不再靠每轮注入对话——它们被烘焙进 Agent 预设的 system prompt（persona 前缀）：
 *   · 不进对话记录（会话窗口干净，不再出现上万字的「输入」）；
 *   · system prompt 是稳定前缀 → 模型缓存每轮命中，token 成本与延迟大幅下降；
 *   · DSH 的上下文压缩永远压不掉 system prompt。
 *
 * 同步时机：插件启动自检（变了就重建并提示重启）、保存人格分层、切换角色。
 * 生效时机：Agent 预设在 DSH 启动时加载 → 改完人格需要重启 DSH 一次。
 *
 * 快照文件 dsh/agent-presets/persona.system.md 是运行期数据（.gitignore），
 * 不存在时（CI / 全新 clone）构建脚本按基础版（安全规则）产出，行为不变。
 */
import fs from 'node:fs';
import { buildPatches, patchFileFor, PRESETS, PERSONA_SNAPSHOT_FILE } from '../../scripts/build-agent-preset-patches.mjs';
import { composePersonaLayers } from '../../src/persona-layers.js';
import { activePersonaFile, readCurrentCharacter, readPersonaLayerText } from '../../src/character-persona.js';
import { buildPersonaIdentity, personaNameFromCard } from '../../src/persona-identity.js';

/** 组装「烘进 system prompt 的稳定人格」。易变内容（近况/心情/记忆卡）不在这里。 */
export function composePersonaSystemPrompt({ ownerName = '主人', maxChars = 12000 } = {}) {
  const cur = (() => { try { return readCurrentCharacter(); } catch { return null; } })();
  let personaCore = '';
  try {
    const file = activePersonaFile();
    personaCore = file ? fs.readFileSync(file, 'utf8') : '';
  } catch { /* 读不到按没人格处理 */ }
  if (!String(personaCore).trim()) return { text: '', chars: 0, name: cur?.name || '' };

  const identity = buildPersonaIdentity({
    name: personaNameFromCard(personaCore, cur?.name || '这个角色'),
    owner: ownerName,
  });
  const composed = composePersonaLayers({
    core: personaCore,
    tone: readPersonaLayerText('tone'),
    examples: readPersonaLayerText('examples'),
    identity,
    personaMode: 'full',
    mode: 'v1',
    maxChars,
  });
  const name = String(cur?.name || '').trim() || '小鲸鱼';
  const text = `【人格 · 主人自定义角色卡（system 级设定，不是对话内容）】\n${composed.text}`.trim();
  return { text, chars: text.length, name };
}

/**
 * 人格 → 预设 的同步状态（只读，给设置页展示）。
 * UI 要回答一个问题：「我现在改的人格，到底进没进 Agent 预设、要不要重启」。
 */
export function personaPresetStatus() {
  const { text } = composePersonaSystemPrompt({});
  let snapshot = '';
  let snapshotMtime = 0;
  try {
    snapshot = fs.readFileSync(PERSONA_SNAPSHOT_FILE, 'utf8');
    snapshotMtime = fs.statSync(PERSONA_SNAPSHOT_FILE).mtimeMs;
  } catch { /* 还没同步过 */ }
  const presets = PRESETS.map((name) => {
    let exists = false;
    try { exists = fs.existsSync(patchFileFor(name)); } catch { /* 路径算不出来按未生成 */ }
    return { name, exists };
  });
  const synced = Boolean(text) && snapshot === text;
  return {
    ok: Boolean(text),
    // 当前人格（身份底座 + 核心 + 语气）烧进 system prompt 后的字数。
    chars: text.length,
    snapshotChars: snapshot.length,
    snapshotMtime,
    synced,
    // 快照与当前人格不一致 = 改过但还没重启，DSH 里跑的仍是旧预设。
    restartRequired: Boolean(text) && !synced,
    presets,
  };
}

/**
 * 把当前稳定人格同步进 Agent 预设（写快照 + 重建 patch 文件）。
 * 内容没变化时不写不动。返回 { ok, changed, chars?, error? }。
 */
export function syncPersonaSystemPreset({ log = () => {}, ownerName = '主人' } = {}) {
  try {
    const { text, name } = composePersonaSystemPrompt({ ownerName });
    if (!text) return { ok: false, changed: false, error: '没有可用的人格卡' };
    let prev = '';
    try { prev = fs.readFileSync(PERSONA_SNAPSHOT_FILE, 'utf8'); } catch { /* 首次同步 */ }
    if (prev === text) return { ok: true, changed: false };
    fs.writeFileSync(PERSONA_SNAPSHOT_FILE, text, 'utf8');
    buildPatches({ log: (line) => log(`[preset-sync] ${line}`) });
    log(`人格已同步到 Agent 预设（${name}，${text.length} 字）；重启 DSH 后对会话生效。`);
    return { ok: true, changed: true };
  } catch (error) {
    log(`人格同步到 Agent 预设失败：${String(error?.message ?? error).slice(0, 160)}`);
    return { ok: false, changed: false, error: String(error?.message ?? error) };
  }
}
