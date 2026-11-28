/**
 * surfcore —— 宿主半边（设置窗口的唯一后端）。
 *
 * 它把原来两个插件的能力装进一个进程：
 *   · QQ 侧：读/写 <surfcore>/config.json、桥接探活/启停/重启、模式与 ownerQQ、
 *            白名单、social/socialV2/chat/slang/webSearch 等全部参数；
 *   · B站侧：读/写 ~/.dsh/surfcore/bili.config.json、cookie 写入、依赖体检、
 *            待审回复、通知测试、生物钟（scheduler.js）；
 *   · 合体层：统一人设卡、QQ→B站 脱敏记忆、身份对齐、扩展接口、平台适配器
 *            （qq/bili 内置）。
 *
 * 安全：
 *   · 所有路由只接受本机回环 + DSH connection.requestRejection；
 *   · 写操作要求 application/json，且 Origin（若有）必须同源；
 *   · 读配置脱敏（********），保存时 ******** 表示保持原值；
 *   · 每次写文件前备份到 ~/.dsh/surfcore/backups/。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ALIGN_FILE, BACKUP_DIR, BILI_AI_DIR, BILI_ALIGNMENT_FILE, BILI_CONFIG, BILI_CRED, BILI_DIR, BILI_MJS,
  BILI_TOOLS_DIR, DATA_ROOT, DSH_HOME, MEMORY_DIR, PET_DATA_DIR, PLUGIN_ROOT, PLUGIN_LOG, QQ_ALIGNMENT_BRIEF,
  QQ_CONFIG, QQBOT_ROOT, STATE_DIR, UNIFIED_FILE, ensureDirs, findNodeExe, maskPath,
} from './paths.js';
import { resolvePersonaFile } from './persona.js';
import { discoverSnowLumaConnection, ensureAstrbotWsClient } from '../../src/snowluma-conn.js';
import { bearerFromHeader, bridgeTokenMatches, ensureBridgeToken, ensureRawChatToken, rawChatTokenMatches } from './raw-chat-token.js';
import { normalizeSnowLumaInstall, snowLumaMissingReport } from './snowluma-install.js';
import { buildInstallChecks, installOk, planDoctorFix } from './doctor.js';
import {
  autoSnapshot, beforeSwitchSnapshot, characterDetail, characterOverview, createCharacterFromPayload,
  deleteCharacter, manualSnapshot, migrateIfNeeded, restoreCharacterSnapshot, switchToCharacter,
  updateCharacterFromPayload,
} from './characters.js';
import { tiebaStatus, saveTiebaCookieLogin, markTiebaVerified, verifyStoredTiebaCredentials, readTiebaViewHistory, tiebaAction, clearTiebaCredentials } from './tieba.js';
import { startTiebaQrLogin, pollTiebaQrLogin, cancelTiebaQrLogin } from './tieba-qr-login.mjs';
import { activeMemoryPaths, activePersonaLayers, activePlatformStateDir, readCurrentCharacter, touchCharacter } from '../../src/character-persona.js';
import { automationSnapshot } from './automation.js';
import { createPlatformHub } from './platform-hub.js';
import { createAstrbotSupervisor, unsafeDirReason } from './astrbot-supervisor.js';
import { createAstrbotApi } from './astrbot-api.js';
import { sendQqPrivate } from './qq-direct.js';
import { createRawChat, openAiCompletion, openAiStreamChunks } from './dfy-raw-chat.js';
import { checkBridgeAccess, createQqBridgeChat } from './qq-bridge-chat.js';
import { readAsrSettings, transcribeQqVoice } from './qq-voice-asr.js';
import { notifyOwner } from './owner-alert.js';
import { httpRequest } from '../../src/voice-core.js';
import {
  configureDouyinChatModel, configureDouyinLog, disposeDouyin, douyinAutoTick, douyinChatConfigure,
  douyinChatContacts, douyinChatEnable, douyinChatMinimize, douyinChatModels, douyinChatRead, douyinChatRecover, douyinChatResume, douyinChatSetModel, douyinChatSetup, douyinChatStart, douyinChatStatus, douyinChatStop,
  douyinComments, douyinCurrent, douyinDebrief, douyinNext, douyinNotices,
  douyinOpen,
  douyinSearch, douyinStart, douyinStatus, douyinStop, douyinSummary, douyinSyncPolicy,
  readDouyinHistory,
} from './douyin.js';
import {
  configureDouyinIm, configureDouyinImLog, disposeDouyinIm, douyinImContacts,
  douyinImLoginQr, douyinImLoginSms, douyinImLogout, douyinImSaveConfig, douyinImSelftest, douyinImStart, douyinImStatus,
  douyinImStop, douyinImSubmitSms, scheduleDouyinImResume, scheduleDouyinImSelftest,
} from './douyin-im.js';
import {
  backupFile, configDefaults, listBackups, pathSummary,
  readAll, readBiliConfig, readJson, readQqConfig, readUnified,
  saveBiliConfig, saveQqConfig, saveUnified, writeFileAtomic, writeJsonAtomic, writeTextAtomic,
} from './store.js';
import {
  PRIVACY_POLICY_VERSION, explainText, scanText,
} from './privacy.js';
import {
  addLink, approveCandidate, exportAlignments, importAlignments, listCandidates,
  listLinks, rejectCandidate, removeLink, stats as alignStats,
  updateLink, writeAlignmentBriefs,
} from './align.js';
import {
  auditTail, biliToQqStatus, memoryStatus, previewQqForBili, rebuildAllPrompts,
  refreshBiliToQq, scanBiliFeedForCandidates, scanQqFeedForCandidates,
  syncQqToBili,
} from './memory.js';
import {
  bridgeLogTail, callBridge, restart as restartBridge, start as startBridge,
  status as bridgeStatus, stop as stopBridge,
  consoleBase, consoleToken } from './bridge.js';
import { PlatformRegistry } from './platforms.js';
import { contentTypeRejection, isLoopbackReq, json, readBody, readJsonBody, sameOrigin } from './http-guard.js';
import { startScheduler } from './scheduler.js';
import { createTokenBudgetService } from './token-budget.js';
import { createCapabilityRegistry } from './capability-registry.js';
import { CAPABILITY_MODULE, isModuleEnabled, isPetOnly, isPetOnlyBlockedPath, moduleForPath, moduleList } from './modules.js';
import { synthesizeEdgeToFile } from '../../src/voice-edge-tts.js';
import { scanPluginCompatibility } from './compat.js';
import { createGateEventStore } from '../../src/gate-events.js';
import { normalizeAllowlist } from '../../src/allowlist.js';
import { createNekoStickers } from '../../src/nekowhale-stickers.mjs';
import { hardenFile } from '../../src/state-acl.mjs';
import { createPetService } from './pet.js';
import { createPetChatService } from './pet-chat.js';
import { createPetPurposeService } from './pet-purpose.js';
import { createPetApiService } from './pet-api.js';
import { createUpdatesService, resumePendingApply, sanitizeComponentId } from './updates.js';
import { registerMemoryTools, registerStickerTools } from './tool-registrations.js';
import {
  adminFromSources, adminSummary, normalizeAdmin, projectAdminSave,
} from '../../src/admin-identity.js';
import {
  applyMemoryCardAction, compactMemoryCardNow, fullMemoryCardSnapshot, memoryCardIdle, memoryCardSnapshot,
  memoryCardStatusNow, notifyOwnerIfNeeded, restoreMemoryCardBackup, runMemoryCardMaintenance,
  startMemoryCardTimer,
} from './memory-card.js';
import { closeAllQrLogins, cancelQrLogin, pollQrLogin, readFishAccount, readOwnerAccount, startQrLogin, verifyStoredCredentials } from './bili-qr-login.mjs';
import { applySessionPermission } from './scheduler.js';
import { fileStamp, isStale } from '../../src/config-stamps.js';
import { readWatchHistory } from '../tools/lib/watch-history.mjs';
import { enrichWatchHistory } from '../tools/lib/watch-actions.mjs';
import { scanPreferences } from '../tools/lib/pref-scan.mjs';
import { fishGuardStateSummary } from '../tools/lib/fish-guard.mjs';
import { summarizeQqFishGuard } from './qq-fish-guard.js';
import { biliCookieHeader } from '../../src/bili-api.js';
import { createContextTelemetry } from '../../src/context-telemetry.js';
import { createBillingService } from './billing.js';
import { createPersonaClassifier } from './persona-classify.js';
import { personaSnapshot, setPersonaMood, setPersonaQuirks } from '../../src/persona-state.js';
import { setQqRuntimeServices } from '../../src/qq-runtime-services.js';
import { createLearningLoop } from './learning-loop.js';
import { createMemoryOrganizer } from './memory-organize.js';
import { syncPersonaSystemPreset, personaPresetStatus } from './preset-sync.mjs';
import { rollbackAutoPersona } from '../../src/learning-profile.js';
// 路由功能族（组件化迁移 #11）：工厂 + 显式注入，路由分发仍留在本文件。
import { createPersonaRoutes } from './routes/persona.js';
import { createLearningRoutes } from './routes/learning.js';
import { createBridgeProxyRoutes } from './routes/bridge-proxy.js';
import { createPetPurposeRoutes } from './routes/pet-purpose.js';
import { createDouyinRoutes } from './routes/douyin.js';
import { createConfigRoutes } from './routes/config.js';
import { createCharacterRoutes } from './routes/characters.js';
import { createMemoryRoutes } from './routes/memory.js';
import { createDiagnosticsRoutes } from './routes/diagnostics.js';
import { createSnowLumaRoutes } from './routes/snowluma.js';
import { createBridgeActions } from './routes/bridge-actions.js';
import { createConsoleExtrasRoutes } from './routes/console-extras.js';
import { createBiliTiebaRoutes } from './routes/bili-tieba.js';
import { createPlatformRoutes } from './routes/platforms.js';
import { createModuleRoutes } from './routes/modules.js';
import { createAuditLogRoutes } from './routes/audit-logs.js';

// 版本号对外只有一个来源：合并后的 dsh-Dfy 主包（plugins/surfcore-next/package.json）。
// surfcore 现在只是被 dsh-Dfy 复用的后端库，它自己的 package.json 版本不再对外展示；
// 读不到 dsh-Dfy 时才回落到仓库根 package.json（离线/拆包场景）。
function readOwnVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // backend/lib（单仓库布局）
    // 合并后版本号以 dsh-Dfy 主包为准（surfcore 只是被复用的后端库）。
    // 旧布局的 `plugins/surfcore-next/package.json` 已并入单仓库，保留一级旧路径兜底；
    // 读不到时回落到仓库根 package.json（离线 / 拆包场景）。
    const candidates = [
      path.resolve(here, '../../surfcore-next/package.json'),
      path.resolve(here, '../../package.json'),
    ];
    for (const rootPkg of candidates) {
      try {
        const v = JSON.parse(fs.readFileSync(rootPkg, 'utf8')).version;
        if (v) return v;
      } catch {}
    }
  } catch {}
  return '0.0.0-dev';
}

const VERSION = readOwnVersion();
const API_PREFIX = '/dsh-surfcore/api';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const pluginLog = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // 2026-10-22 审计：只 append 不轮转会无限增长。超过 2MB 就滚一份 .1（保留一代）。
    try {
      const stat = fs.statSync(PLUGIN_LOG);
      if (stat.size > 2 * 1024 * 1024) fs.renameSync(PLUGIN_LOG, `${PLUGIN_LOG}.1`);
    } catch {}
    fs.appendFileSync(PLUGIN_LOG, line);
  } catch {}
  try { console.log(`[surfcore] ${args.join(' ')}`); } catch {}
};

function safeBackupName(name) {
  const base = path.basename(String(name ?? ''));
  if (!base || base !== String(name)) return '';
  return base;
}

// ── 组件更新目录的「预期范围」────────────────────────────────────────────────
// 内建组件（surfcore 本体）与随插件安装的东西都在 DSH_HOME / 插件目录 / 仓库根下；
// 用户自定义组件的 dir 允许任意路径（产品设定），但自动更新会往那个目录 robocopy 覆盖，
// 所以要**告警一次**让人看见，而不是静默写入。（2026-11 收尾审计 P3）
const UPDATE_DIR_EXPECTED_ROOTS = [DSH_HOME, PLUGIN_ROOT, path.resolve(PLUGIN_ROOT, '..')];
const updateDirWarned = new Set();
function updateDirInExpectedRoots(dir) {
  let abs = '';
  try { abs = path.resolve(String(dir ?? '')); } catch { return false; }
  const norm = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const target = norm(abs);
  return UPDATE_DIR_EXPECTED_ROOTS.some((root) => {
    let resolved = '';
    try { resolved = path.resolve(root); } catch { return false; }
    const base = norm(resolved);
    return target === base || target.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
  });
}

function readTextFile(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

/** 只读文件尾部（默认 512KB）：日志接口不能因为日志变大就一次读进内存。 */
function readTextTail(file, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function mtimeIso(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

function fileInfo(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: true, bytes: stat.size, mtime: stat.mtime.toISOString() };
  } catch {
    return { exists: false, bytes: 0, mtime: null };
  }
}

function parseModeState() {
  const local = readJson(path.join(QQ_STATE_DIR(), 'mode.json'), {}) ?? {};
  return { localMode: local.mode ?? null, localRole: local.role ?? null };
}

function QQ_STATE_DIR() {
  return path.join(path.dirname(QQ_CONFIG), 'state');
}

export const name = 'surfcore';
export const inject = ['webServer', 'connection', 'sessionController'];

export function apply(ctx) {
  ensureDirs();

  /**
   * 只桌宠模式总闸（unified.petOnly）。
   *
   * 每次用的时候现读配置：设置页开关一保存就生效，不用重启插件。
   * 读不到配置时按关闭处理（fail-open 只影响「省资源」，不影响桌宠本身）。
   */
  function petOnlyOn() {
    try { return isPetOnly(readUnified().config); } catch { return false; }
  }

  registerStickerTools({ ctx, stateDir: STATE_DIR, log: pluginLog });
  registerMemoryTools({ ctx, log: pluginLog });

  // 上次的"退出后应用"可能没跑起来（Electron 宿主没带 ELECTRON_RUN_AS_NODE）：
  // 这里重新排队，用户下次退出 DSH 就会应用（2026-10-28 反馈：点几次都还是旧版本）。
  try { resumePendingApply({ stateDir: STATE_DIR, pluginLog }); } catch (error) { pluginLog('[updates] 启动重试失败：', String(error?.message ?? error)); }

  // 2026-10-22 起：`surface_core` 迁移期的一次性逻辑**已整段删除**。
  // 原因：当年为了把旧工作区改名，留了「有 .legacy-workspace 标记就删/移旧目录」的代码；
  // 这类「启动时按标记动用户目录」的代码风险远大于收益（误删不可逆），迁移也早已完成。
  // 现在的约定：插件**不碰**任何工作区目录；清理旧目录一律由人工或用脚本先备份再动。
  // 相关事故与处置见 docs/PITFALLS.md #1/#3。

  const platforms = new PlatformRegistry();
  // 平台插件发现：装进 DSH 的独立平台插件（tieba-dive / dsh-dot 这类），装了就显示、卸了就消失。
  const platformHub = createPlatformHub({ selfName: 'dsh-dfy', log: pluginLog });
  // AstrBot 网关守护：打开 DSH 自动拉起，不用手动启动。
  const astrbotSupervisor = createAstrbotSupervisor({ log: pluginLog });
  // 内置版默认不拉起 AstrBot（省内存）；切到 AstrBot 版时再启动。
  // 只桌宠模式不启动任何 QQ 侧服务。
  if (!petOnlyOn() && readQqRuntimeMode() === 'astrbot') astrbotSupervisor.start();
  // AstrBot 面板 API（减法版）：插件列表/启停/安装/卸载，JWT 用它自己配置里的 secret 签。
  const astrbotApi = createAstrbotApi({ log: pluginLog });
  // 路线 B 路口：把 DSH 会话暴露成 OpenAI 兼容对话端点，AstrBot 的「OpenAI API 兼容」provider 指到这里。
  // resolveModel：QQ 里那条鱼的模型要跟 DSH 的**默认模型**走（用户主会话用什么，她就用什么），
  // 而不是 dsh-Dfy 自己那份全局模型选择（以前是 zipu/glm-5.3-flash → 听起来不像 DSH 里的她）。
  const rawChat = createRawChat({
    ctx,
    log: pluginLog,
    resolveModel: () => {
      try {
        const selection = defaultModelService?.currentSelection?.() ?? {};
        return selection?.provider && selection?.model
          ? { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
          : null;
      } catch { return null; }
    },
  });
  // QQ 桥接插件通道：AstrBot 插件把 (umo, 文本) POST 过来，这里按 QQ 会话建/复用 DSH 会话。
  // 和「OpenAI provider」那条路的区别：这条路带得动会话身份，所以每段 QQ 对话能有自己的
  // DSH 会话窗口（侧栏可见、可切模型、能看思考/上下文）。
  const qqBridgeChat = createQqBridgeChat({
    ctx,
    log: pluginLog,
    getBaseUrl: () => currentDshUrl(),
    resolveModel: () => {
      try {
        const selection = defaultModelService?.currentSelection?.() ?? {};
        return selection?.provider && selection?.model
          ? { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
          : null;
      } catch { return null; }
    },
  });
  // 给 AstrBot 插件的发现文件：端口漂移/令牌轮换都靠它（每 60 秒重写一次）。
  function writeQqBridgeHostFile() {
    try {
      const dir = path.join(STATE_DIR, 'astrbot');
      fs.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(path.join(dir, 'dsh-bridge.json'), {
        version: 1,
        baseUrl: String(currentDshUrl() || '').replace(/\/+$/, ''),
        token: ensureBridgeToken(),
        path: '/dsh-surfcore/v1/qq-bridge/ask',
        // 插件据此决定语音条要不要转文字（socialV2.voice.asr.enabled 的镜像，
        // 插件自己不存配置，发现文件是它唯一的配置通道）
        voiceAsrEnabled: readQqConfig().config?.socialV2?.voice?.asr?.enabled === true,
        updatedAt: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      pluginLog('[qq-bridge] 写 dsh-bridge.json 失败：', String(error?.message ?? error));
      return false;
    }
  }
  platforms.setStatus('qq', () => bridgeStatus());
  platforms.setStatus('bili', () => biliToQqStatus());
  platforms.setStatus('tieba', () => tiebaStatus());
  // 抖音：只把「总开关 / 现在能不能刷 / 窗口在不在」带回概览，详细状态在设置页读。
  configureDouyinLog((message) => pluginLog(message));
  let llmService = null;
  let defaultModelService = null;
  try {
    const getService = (name) => { try { return ctx.get?.(name); } catch { return undefined; } };
    llmService = getService('llm');
    defaultModelService = getService('agentDefaultModel');
    // 内嵌 QQ 桥接拿不到 ctx：把看图懂梗要用的 llm / attachments 共享过去。
    setQqRuntimeServices({ llm: llmService, attachments: getService('attachments') });
    configureDouyinChatModel({
      llm: llmService,
      attachments: getService('attachments'),
      getSelection: () => {
        try { return defaultModelService?.currentSelection?.() ?? {}; } catch { return {}; }
      },
      // 抖音回复走 DSH 会话（和 QQ 一样，侧栏能看到思考）；服务缺失时自动退回直连模型。
      sessionController: getService('sessionController'),
    });
  } catch { /* 模型服务缺失时只保留只读能力 */ }
  // 抖音私信：douyin-im 长连接（不需要浏览器），回复同样走 DSH 会话。
  configureDouyinImLog((message) => pluginLog(message));
  try {
    // getBaseUrl：抖音会话要注册成「抖音聊天」工作区，DSH 侧栏才看得到（和 QQ 一样）。
    configureDouyinIm({ ctx, getBaseUrl: () => currentDshUrl() });
  } catch (error) { pluginLog('[抖音IM] 插件上下文注入失败：', String(error?.message ?? error).slice(0, 160)); }
  platforms.setStatus('douyin', async () => {
    const status = await douyinStatus();
    return {
      ok: status.ok,
      enabled: status.config.enabled,
      allowed: status.policy?.allowed ?? false,
      reason: status.policy?.reason ?? status.policyError ?? '',
      watching: status.watching,
      browser: status.browser?.running ? 'running' : 'stopped',
    };
  });

  let scheduler = null;
  let schedulerStatus = { running: false, startedAt: null, lastError: null, lastTickAt: null };
  let syncTimer = null;
  let memoryCardTimer = null;
  let memoryOrganizeTimer = null;
  let characterTimer = null;

  // ── 每日 token 额度 / 用量采集（2026-10-23 用户要求）────────────────────
  // 插件是唯一能同时看到 QQ、B站、黑话学习会话的地方：用 session/event 实时累计，
  // 设置页展示、B站 调度器拦截、QQ 桥接（读 daily 快照）都共用这一份。
  const tokenBudget = createTokenBudgetService({
    ctx,
    dshHome: DSH_HOME,
    qqStateDir: QQ_STATE_DIR(),
    getQqConfig: () => readQqConfig().config,
    log: (message) => pluginLog(message),
  });
  // 闸门事件中心：桥接负责写，插件负责展示/确认；同一份文件、同一套分级。
  const gateEvents = createGateEventStore({ dir: STATE_DIR, log: (message) => pluginLog(message) });
  // ── 桌宠载体：只探测 dsh-Dfy 插件是否装着/在用 ─────
  const petService = createPetService({ stateDir: STATE_DIR });
  // 桌宠对话与「目的机制」的桌宠载体：和 QQ / B站 共用当前角色的人格卡、记忆卡、目的状态。
  // Phase 0A：旁路遥测（只读事件，不改 prompt/工具/会话行为）。
  const contextTelemetry = createContextTelemetry({
    file: path.join(STATE_DIR, 'context-telemetry-plugin.jsonl'),
    source: 'plugin',
    log: (message) => pluginLog(message),
  });
  // A+B 账单：每 10 分钟刷新到 ~/.dsh/surfcore/billing；只读，不调用模型。
  const personaClassifier = createPersonaClassifier({ ctx, log: (message) => pluginLog(message), tokenBudget });

  const billing = createBillingService({
    stateDir: STATE_DIR,
    // 账单读的是 QQ 桥接的 state/token-usage.jsonl 与遥测：数据根（不是代码根）。
    qqRoot: DATA_ROOT,
    readCurrentCharacter,
    log: (message) => pluginLog(message),
  });
  billing.start();

  const petChat = createPetChatService({ ctx, stateDir: STATE_DIR, pluginLog, tokenBudget });
  const petPurpose = createPetPurposeService({ chat: petChat, tokenBudget, pluginLog, callBridge });
  // 自我学习：贴吧 / B站 / 抖音 的观看记录 → 经历 + 近况（定时跑，也可以在设置页手动触发）。
  const learningLoop = createLearningLoop({ ctx, log: pluginLog, tokenBudget, shouldRun: () => !petOnlyOn() });
  // 记忆整理：把聊天流水合并/去噪成干净的事实（一键手动 + 每日自动）。
  const memoryOrganizer = createMemoryOrganizer({ ctx, log: pluginLog, tokenBudget });
  const petApi = createPetApiService({
    chat: petChat,
    purpose: petPurpose,
    petService,
    stateDir: STATE_DIR,
    currentDshUrl,
    pluginLog,
    version: VERSION,
    // 路线 B：内置桥按设计停着，但「桌宠消息卡片」还得能说话——它改走
    //   qq/send → 同一个大脑（DSH 会话 dfy-astrbot）→ SnowLuma OneBot 直发主人 QQ。
    // astrbotApi / rawChat 在本函数后面才创建，用闭包延迟取值（请求发生时早已就绪）。
    routeBOn: () => {
      try { return astrbotApi.getRouteB().on === true; } catch { return false; }
    },
    askBrain: (text, key) => rawChat.ask(text, { key }),
    sendQq: (args) => sendQqPrivate(args),
  });

  // ── 路由功能族（组件化）：依赖显式注入，分发仍在 handleHttp 里 ─────────────
  const { handlePersona, handlePersonaClassify, handlePersonaState } = createPersonaRoutes({
    API_PREFIX,
    activePersonaLayers, resolvePersonaFile,
    readTextFile, listBackups, mtimeIso, safeBackupName,
    personaPresetStatus, syncPersonaSystemPreset,
    BACKUP_DIR, backupFile, writeTextAtomic,
    readCurrentCharacter, touchCharacter,
    readUnified, readQqConfig, adminSummary,
    personaClassifier, scanText,
    personaSnapshot, setPersonaQuirks, setPersonaMood,
    readJsonBody, json, pluginLog,
  });
  const { handleLearning } = createLearningRoutes({
    API_PREFIX, learningLoop, rollbackAutoPersona, saveUnified, readJsonBody, json,
  });
  const { handleGroupPolicy, handleLimitMute } = createBridgeProxyRoutes({
    callBridge, readJsonBody, json,
  });
  const { handlePet, handlePurpose, petChatTest } = createPetPurposeRoutes({
    API_PREFIX, readQqConfig, readJsonBody, json,
    petService, petChat, petPurpose, bridgeStatus, callBridge,
  });
  const { handleDouyin } = createDouyinRoutes({
    readJsonBody, json, pluginLog, douyinSyncPolicy, readDouyinHistory,
    douyinStatus, douyinOpen, douyinCurrent, douyinNext, douyinSearch, douyinStart, douyinStop,
    douyinSummary, douyinComments, douyinNotices, douyinDebrief,
    douyinChatStatus, douyinChatContacts, douyinChatConfigure, douyinChatStart, douyinChatStop,
    douyinChatRead, douyinChatMinimize, douyinChatModels, douyinChatSetModel, douyinChatSetup,
    douyinChatEnable, douyinChatRecover,
    douyinImStatus, douyinImLoginQr, douyinImLoginSms, douyinImSubmitSms, douyinImLogout,
    douyinImContacts, douyinImSaveConfig, douyinImStart, douyinImStop, douyinImSelftest,
  });
  const { handleConfig } = createConfigRoutes({
    STATE_DIR, QQ_CONFIG, BILI_CONFIG,
    readAll, configDefaults, pathSummary, listBackups, fileStamp, isStale,
    readQqConfig, readBiliConfig, readUnified,
    adminFromSources, projectAdminSave, normalizeAllowlist,
    saveQqConfig, saveBiliConfig, saveUnified,
    writeAlignmentBriefs, douyinSyncPolicy, douyinChatResume, startSyncTimer,
    runMemoryCardMaintenance, syncQqToBili,
    platformStartState, platformStartEnabled,
    invalidateScheduler: () => { scheduler?.invalidate?.(); },
    retireScheduler: async () => { await scheduler?.retire?.(); scheduler = null; },
    resetSchedulerIdle: (reason) => { schedulerStatus = idleSchedulerStatus(reason); return schedulerStatus; },
    startSchedulerNow,
    stopBridge, startBridge, restartBridge, currentDshUrl,
    readJsonBody, json, petOnlyOn,
  });
  const { handleCharacters } = createCharacterRoutes({
    characterDetail, characterOverview, getCharacterMigration: () => characterMigration,
    readCurrentCharacter, createCharacterFromPayload, switchCharacterEverywhere,
    updateCharacterFromPayload, manualSnapshot, autoSnapshot, restoreCharacterSnapshot,
    writeCharacterRolePointer, archiveBridgeRuntimeState, ensureCharacterSystem, deleteCharacter,
    bridgeStatus, memoryCardIdle, stopAllBridgeSessions, stopBridge, startBridge, currentDshUrl,
    runMemoryCardMaintenance,
    prepareSchedulerForRestore: async (skipPlatform) => {
      if (!skipPlatform && scheduler?.retire) await scheduler.retire();
      scheduler = null;
    },
    resetSchedulerIdleForRestore: () => {
      schedulerStatus = { running: false, startedAt: null, lastError: null, lastTickAt: null };
      return schedulerStatus;
    },
    getSchedulerStatus: () => schedulerStatus,
    startSchedulerNow,
    readJsonBody, json, pluginLog,
  });
  const { handleMemory, handleMemoryCard, handleMemoryCardFull, handleAlign } = createMemoryRoutes({
    PRIVACY_POLICY_VERSION,
    readJsonBody, json,
    readUnified, saveUnified,
    maskPath, backupFile,
    QQ_STATE_DIR, activeMemoryPaths, readTextFile,
    QQ_ALIGNMENT_BRIEF, BILI_ALIGNMENT_FILE,
    platforms, memoryOrganizer, callBridge,
    memoryStatus, previewQqForBili, biliToQqStatus, auditTail,
    syncQqToBili, refreshBiliToQq, scanQqFeedForCandidates, scanBiliFeedForCandidates, rebuildAllPrompts,
    memoryCardSnapshot, fullMemoryCardSnapshot, applyMemoryCardAction, runMemoryCardMaintenance,
    compactMemoryCardNow, restoreMemoryCardBackup, notifyOwnerIfNeeded,
    listLinks, listCandidates, addLink, updateLink, removeLink,
    approveCandidate, rejectCandidate, importAlignments, exportAlignments, alignStats,
  });
  const { handleMode, handleDiagnostics } = createDiagnosticsRoutes({
    getSettings: () => ctx.get('settings'), parseModeState,
    readJsonBody, json, pluginLog,
    readJson, writeJsonAtomic,
    QQ_STATE_DIR, readQqConfig, saveQqConfig, readUnified, saveUnified, readAll, callBridge,
    pathSummary, backupFile, safeBackupName, maskPath, resolvePersonaFile, activeMemoryPaths,
    STATE_DIR, QQBOT_ROOT, DSH_HOME, UNIFIED_FILE, BILI_MJS, BILI_CONFIG, BILI_CRED,
    QQ_CONFIG, ALIGN_FILE, QQ_ALIGNMENT_BRIEF, BILI_ALIGNMENT_FILE, BACKUP_DIR,
    bridgeStatus, astrbotSupervisor, astrbotApi,
    portOpen: (...args) => portOpen(...args), currentDshUrl,
    discoverSnowLumaConnection, diagnoseSnowLuma: (...args) => diagnoseSnowLuma(...args),
    buildInstallChecks, installOk, planDoctorFix,
    normalizeAllowlist, startBridge,
  });
  const {
    handleSnowLuma, mergedPluginInfo, portOpen, findSnowLumaInstall, resolveSnowLumaLauncher,
    snowLumaWebui, snowlumaWebuiClient, openLocalUrl, diagnoseSnowLuma, enableSnowLumaAutoHook,
    launchSnowLuma, watchStartupCompletion,
  } = createSnowLumaRoutes({
    readQqConfig, saveQqConfig, readUnified, readJsonBody, json, pluginLog,
    QQBOT_ROOT, STATE_DIR, writeFileAtomic, writeJsonAtomic,
    bridgeStatus, currentDshUrl,
    getSchedulerRunning: () => Boolean(scheduler && schedulerStatus.running),
  });
  const { handleBrowse, handleVoicePreview, handleVoiceDoubaoWeb, handleDeepseekStatus } = createConsoleExtrasRoutes({
    json, readJsonBody, readQqConfig, readAsrSettings, httpRequest,
    consoleBase, consoleToken,
  });
  const {
    handleQqFishGuard, handleWatchHistory, handlePreferenceScan, handleBili, handleTieba,
  } = createBiliTiebaRoutes({
    getCtx: () => ctx,
    getScheduler: () => scheduler,
    isSchedulerRunning: () => Boolean(scheduler && schedulerStatus.running),
    readJson, readJsonBody, json, pluginLog, maskPath, writeJsonAtomic,
    readQqConfig, QQ_STATE_DIR, readBiliConfig, saveBiliConfig,
    BILI_MJS, BILI_TOOLS_DIR, BILI_CRED, BILI_AI_DIR, BILI_DIR, BACKUP_DIR, ALIGN_FILE,
    activePlatformStateDir, readCurrentCharacter,
    readWatchHistory, enrichWatchHistory, scanPreferences,
    fishGuardStateSummary, summarizeQqFishGuard, automationSnapshot,
    callBridge, findNodeExe, applySessionPermission, biliCookieHeader,
    readFishAccount, readOwnerAccount, pollQrLogin, startQrLogin, cancelQrLogin, verifyStoredCredentials,
    saveTiebaCookieLogin, markTiebaVerified, verifyStoredTiebaCredentials, readTiebaViewHistory, tiebaStatus, tiebaAction,
    clearTiebaCredentials,
    startTiebaQrLogin, pollTiebaQrLogin, cancelTiebaQrLogin,
  });

  // ── 能力槽（capability slot）─────────────────────────────────────────────
  // 每项能力只跑一个主实现；第三方插件注册同契约实现后，可在「模块中心」一键换上去。
  // 这里先注册两个内置能力：douyin.feed（切/读当前视频）与 voice.speak（语音合成）。
  const capabilityRegistry = createCapabilityRegistry({ log: pluginLog });
  capabilityRegistry.register({
    id: 'dsh-dfy-douyin',
    name: '内置抖音网页版',
    builtin: true,
    risk: 'medium',
    provides: ['douyin.feed'],
    async invoke(input) {
      const action = input.action === 'next' ? 'next' : 'status';
      if (action === 'next') {
        const result = await douyinNext();
        return { ok: true, action, page: result.page };
      }
      const result = await douyinStatus();
      return { ok: true, action, page: result.page, watching: result.watching, policy: result.policy };
    },
  });
  capabilityRegistry.register({
    id: 'dsh-dfy-voice',
    name: '跟随语音设置',
    builtin: true,
    risk: 'low',
    provides: ['voice.speak'],
    async invoke(input) {
      const result = await petChat.synthesize(String(input.text ?? ''), {
        mode: input.mode === 'speak' ? 'speak' : 'voice',
        voice: String(input.voice ?? ''),
      });
      if (!result?.ok) throw new Error(result?.error || '语音合成失败');
      return { ok: true, key: String(result.key ?? ''), durationMs: Number(result.durationMs) || 0, text: String(result.text ?? '') };
    },
  });
  capabilityRegistry.register({
    id: 'dsh-dfy-voice-edge',
    name: 'Edge TTS（独立音源）',
    builtin: true,
    risk: 'low',
    provides: ['voice.speak'],
    async invoke(input) {
      const text = String(input.text ?? '').trim();
      if (!text) throw new Error('要合成的内容是空的');
      const result = await synthesizeEdgeToFile({
        text,
        voice: String(input.voice ?? '').trim() || 'zh-CN-XiaoxiaoNeural',
        outDir: path.join(PET_DATA_DIR, 'voice'),
      });
      return {
        ok: true,
        key: path.basename(result.path, path.extname(result.path)),
        durationMs: Number(result.durationMs) || 0,
        text,
      };
    },
  });

  const { handleCapabilities, handleModules } = createModuleRoutes({
    capabilityRegistry, moduleList, readUnified, saveUnified,
    readJsonBody, json, douyinStop, stopBridge, pluginLog,
    isPetOnly, stopSchedulerNow, startSchedulerNow, douyinImStop,
    astrbotStop: () => astrbotSupervisor.stop(),
  });

  // ── 组件更新（2026-10-26 用户要求）──────────────────────────────────────
  // 检查 SurfCore 本体 + 用户登记的组件：只读 git fetch，更新只允许 --ff-only。
  // 组件清单每次动态解析：换路径 / 新装包都不用重启插件。
  const updates = createUpdatesService({
    stateDir: STATE_DIR,
    pluginLog,
    githubToken: () => String(readUnified().config?.updates?.githubToken ?? ''),
    components: () => {
      const list = [];
      try {
        const updCfg = readUnified().config?.updates ?? {};
        // 1) SurfCore 本体：源码树，走 git
        list.push({ id: 'surfcore', name: 'dsh-Dfy 源码', dir: QQBOT_ROOT, kind: 'git', branch: 'main', versionRepo: 'louke6572/dsh-Dfy' });
        // 2) 2026-11 精简：语音包/桌宠组件不再登记（各自的后端已下线，留着只会每次都报 missing）。
        // 3) 用户登记的组件：unified config 的 updates.components[]
        const custom = updCfg.components;
        if (Array.isArray(custom)) {
          for (const item of custom) {
            if (!item || typeof item !== 'object' || !item.id || !item.dir) continue;
            // id 会被拼进暂存目录名并进 PowerShell 命令：非法 id 直接丢弃，
            // 不要让它以"只是个名字"的身份一路流到解压/清理那一步。
            const safeId = sanitizeComponentId(item.id);
            if (!safeId) {
              pluginLog(`[updates] 忽略 id 不合规的组件（只允许字母/数字/点/下划线/短横线）：${String(item.id).slice(0, 60)}`);
              continue;
            }
            // P3：自定义目录不阻断，但要告警一次——自动更新会向这个目录覆盖写文件。
            if (!updateDirInExpectedRoots(item.dir) && !updateDirWarned.has(safeId)) {
              updateDirWarned.add(safeId);
              pluginLog(`[updates] 组件 ${safeId} 的目录不在 DSH_HOME/插件目录/仓库根下（${maskPath(String(item.dir))}）：自动更新会向该目录覆盖写文件，请确认这是你要的目录`);
            }
            list.push({
              id: safeId,
              name: String(item.name ?? item.id).slice(0, 80),
              dir: String(item.dir),
              kind: ['git', 'release', 'auto'].includes(item.kind) ? item.kind : 'auto',
              branch: item.branch ? String(item.branch).slice(0, 60) : undefined,
              versionUrl: item.versionUrl ? String(item.versionUrl) : '',
            });
          }
        }
      } catch {}
      // 去重（同 id 只留第一个）
      const seen = new Set();
      return list.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
    },
  });

  const {
    handlePlatforms, handlePlatformHub, handleModels, handleUpdates, handleTokenBudget,
  } = createPlatformRoutes({
    platforms, platformHub, astrbotSupervisor,
    getLlmService: () => llmService,
    getDefaultModelService: () => defaultModelService,
    readUnified, saveUnified, readQqConfig, saveQqConfig,
    readJsonBody, json, pluginLog, updates, tokenBudget, backupFile,
  });

  let sessionEventOff = null;
  try {
    if (typeof ctx.on === 'function') {
      sessionEventOff = ctx.on('session/event', (session, event) => {
        try { tokenBudget.ingestEvent(session, event); }
        catch (error) { pluginLog('token 用量采集失败：', String(error?.message ?? error).slice(0, 160)); }
        try {
          if (tokenBudget.isTrackedSession(session)) contextTelemetry.ingestEvent(session, event);
        } catch (error) { pluginLog('上下文遥测失败：', String(error?.message ?? error).slice(0, 160)); }
      });
    }
  } catch (error) {
    pluginLog('token 用量采集监听注册失败：', String(error?.message ?? error));
  }

  // 启动时先重建身份对齐提示块（bridge 与 B站调度器都读它）。
  try { writeAlignmentBriefs(); } catch (error) { pluginLog('启动时写对齐简报失败：', error?.message ?? error); }
  // 人格 → Agent 预设 同步自检：人格稳定部分（身份/核心/语气）烘焙进预设的
  // system prompt（不进对话记录、缓存友好、压缩压不掉）。内容有变化时重建
  // patch 并提示重启；没变化时不写不动。
  try {
    const presetSync = syncPersonaSystemPreset({ log: pluginLog });
    if (presetSync.changed) pluginLog('⚠️ Agent 预设人格有更新：重启 DSH 后对新会话生效。');
  } catch (error) { pluginLog('启动时同步人格到 Agent 预设失败：', error?.message ?? error); }

  // ── 平台启动开关（2026-10-24 用户要求：不是所有用户都想同时开 QQ / B站）──
  // 唯一真相在合体层 config.json 的 platforms.start.{qq,bili}；旧 bridge.autoStart
  // 只在 readUnified() 里做一次迁移。开关关掉 = 不自动启动、不被「一键启动」带上，
  // 保存配置时宿主会把正在跑的那一边停掉（save/restart 流程见 handleConfig）。
  function platformStartState() {
    const start = readUnified().config.platforms?.start ?? {};
    return { qq: start.qq !== false, bili: start.bili !== false };
  }
  function platformStartEnabled(id) {
    // 只桌宠模式：所有平台都不自动启动（同样不改用户的 platforms.start 偏好，
    // 关掉总闸后按原设置恢复）。
    if (petOnlyOn()) return false;
    // 模块中心停用的平台不自动启动；但**不改用户的 platforms.start 偏好**，
    // 这样重新启用模块后会自动恢复（以前停用模块会写 start=false，而启用只写
    // modules=true，导致 QQ 永久不再自动启动、界面里也没有入口恢复）。
    try {
      if (readUnified().config?.modules?.[id] === false) return false;
    } catch { /* 读不到模块配置就按启动开关判断 */ }
    return platformStartState()[id] !== false;
  }
  function idleSchedulerStatus(reason = 'disabled') {
    return {
      running: false,
      disabled: !platformStartEnabled('bili'),
      reason,
      startedAt: null,
      lastError: null,
      lastTickAt: null,
      sessionId: schedulerStatus.sessionId ?? null,
    };
  }
  // B站生物钟：合体后由本插件接管（旧 dsh-bili-whale 会被停用）。
  // 抽成函数给「一键启动」复用：DSH 重启后插件加载时按平台开关决定是否自动启动，
  // 失败后也能手动拉起。
  function startSchedulerNow() {
    if (scheduler && schedulerStatus.running) return schedulerStatus;
    if (!platformStartEnabled('bili')) {
      schedulerStatus = idleSchedulerStatus('disabled');
      pluginLog('生物钟未启动：B站 启动开关关闭（设置 → B站 → 启动 B站）');
      return schedulerStatus;
    }
    // 没登录过 B站 就不要自动起会话：新用户第一次装完，60s 一次的 tick 只会空烧 token。
    // （凭据由扫码登录写入 BILI_CRED；用户登录后会自然启动。）
    if (!fs.existsSync(BILI_CRED)) {
      schedulerStatus = idleSchedulerStatus('not-logged-in');
      pluginLog('生物钟未启动：B站 还没登录（设置 → B站 → 扫码登录），避免空转消耗 token');
      return schedulerStatus;
    }
    try {
      const character = readCurrentCharacter();
      const sessionId = character ? `bili-whale-${character.id}` : 'bili-whale';
      scheduler = startScheduler(ctx, {
        dshHome: DSH_HOME,
        biliMjs: BILI_MJS,
        cwd: os.homedir(),
        sessionId,
        tokenBudget,
        log: (message) => pluginLog(message),
      });
      schedulerStatus = { running: true, disabled: false, reason: '', startedAt: new Date().toISOString(), lastError: null, lastTickAt: null, sessionId };
      pluginLog(`生物钟已启动（会话 ${sessionId}）`);
    } catch (error) {
      schedulerStatus.lastError = String(error?.message ?? error);
      pluginLog('生物钟启动失败：', schedulerStatus.lastError);
    }
    return schedulerStatus;
  }
  function stopSchedulerNow() {
    const wasRunning = Boolean(scheduler && schedulerStatus.running);
    try { scheduler?.stop?.(); } catch (error) {
      pluginLog('生物钟停止失败：', String(error?.message ?? error));
    }
    scheduler = null;
    schedulerStatus = { running: false, startedAt: null, lastError: null, lastTickAt: null };
    if (wasRunning) pluginLog('生物钟已停止');
    return { ok: true, wasRunning, scheduler: schedulerStatus };
  }
  startSchedulerNow();

  // 管理员称呼的存量修复：v0.7.2 及以前只把 ownerQQ 投影到 QQ config.json，
  // displayName/biliName/gentle 留在 unified，桥接独立进程读不到 → 叫“管理员”。
  // 启动时补一次投影（有变化才写），桥接在跑就重启让它重新读配置。
  function ensureAdminProjection() {
    try {
      const qqState = readQqConfig();
      const unifiedState = readUnified();
      const biliState = readBiliConfig();
      const unifiedAdmin = unifiedState.hasAdmin ? unifiedState.config?.admin : undefined;
      const sourceAdmin = unifiedAdmin ?? qqState.config?.admin;
      const current = adminFromSources({
        unified: { admin: sourceAdmin },
        qq: qqState.config,
        bili: biliState.config,
      });
      if (!current.qq && !current.biliMid) return;
      const next = normalizeAdmin(current);
      const prev = normalizeAdmin(qqState.config?.admin);
      if (JSON.stringify(prev) === JSON.stringify(next)) return;
      const planned = projectAdminSave({ current: next, qq: qqState.config });
      if (!planned.qq) return;
      saveQqConfig(planned.qq);
      pluginLog('管理员称呼已补齐到 QQ config.json（桥接重启后生效）');
      setTimeout(() => {
        if (petOnlyOn()) return;
        void bridgeStatus().then((st) => {
          if (!st.running) return;
          return restartBridge({ dshWebUrl: currentDshUrl() });
        }).catch(() => {});
      }, 1500).unref?.();
    } catch (error) {
      pluginLog('管理员称呼投影失败（继续使用现有配置）：', error?.message ?? error);
    }
  }

  ensureAdminProjection();

  // ── 角色人格：启动迁移 + 切换编排 ───────────────────────────────────────
  // 迁移只做一次：有旧记忆/旧 B站 账本才建第一个角色；旧目录原样保留作冷备份。
  function ensureCharacterSystem() {
    if (process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION === '1') return { ok: true, skipped: true, reason: 'disabled' };
    try {
      const result = migrateIfNeeded({
        personaFile: resolvePersonaFile(),
        memoryDir: MEMORY_DIR,
        biliDir: BILI_DIR,
        stateDir: QQ_STATE_DIR(),
      });
      if (result.migrated) {
        pluginLog(`角色系统：已从旧数据迁移出「${result.character?.name ?? result.current?.name}」（备份 ${maskPath(result.backupDir)}）`);
        writeCharacterRolePointer();
        // 桥接可能已经在跑旧路径：给它一次重启，让它读新角色目录。
        setTimeout(() => {
          if (petOnlyOn()) return;
          void bridgeStatus().then((st) => { if (st.running) return restartBridge({ dshWebUrl: currentDshUrl() }); }).catch(() => {});
        }, 1500).unref?.();
      }
      return result;
    } catch (error) {
      pluginLog('角色系统迁移失败（继续用旧布局）：', error?.message ?? error);
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  function writeCharacterRolePointer() {
    const cur = readCurrentCharacter();
    if (!cur) return;
    const file = path.join(QQ_STATE_DIR(), 'current-role.json');
    const old = readJson(file, {}) ?? {};
    try {
      writeJsonAtomic(file, { role: cur.name, mode: old.mode === 'silent' ? 'silent' : 'active' });
    } catch (error) {
      pluginLog('写 current-role.json 失败：', error?.message ?? error);
    }
  }

  /** 先让桥接停掉全部旧会话（v1 + v2），再停进程；否则旧 DSH 回合可能带着旧人格继续发消息。 */
  async function stopAllBridgeSessions() {
    try {
      const listed = await callBridge('/api/sessions', { timeoutMs: 8000 });
      const sessions = Array.isArray(listed?.data?.sessions) ? listed.data.sessions : [];
      for (const item of sessions) {
        if (!item?.key) continue;
        await callBridge('/api/session/reset', { method: 'POST', body: { key: item.key }, timeoutMs: 15000 }).catch(() => {});
      }
      await callBridge('/api/socialV2/reset', { method: 'POST', timeoutMs: 20000 }).catch(() => {});
    } catch (error) {
      pluginLog('切换角色：停止旧桥接会话失败（继续停进程）：', error?.message ?? error);
    }
  }

  /** 切换角色前把桥接的会话映射挪走：新角色必须从空会话开始，不能带旧人格上下文。 */
  function archiveBridgeRuntimeState() {    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(BACKUP_DIR, `character-switch-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    const files = ['sessions.json', 'social-v2.json'];
    const moved = [];
    for (const name of files) {
      const src = path.join(QQ_STATE_DIR(), name);
      try {
        if (!fs.existsSync(src)) continue;
        fs.renameSync(src, path.join(dir, name));
        moved.push(name);
      } catch (error) {
        pluginLog(`切换角色：归档 ${name} 失败：`, error?.message ?? error);
      }
    }
    return { dir, moved };
  }

  async function switchCharacterEverywhere(id) {
    const current = readCurrentCharacter();
    if (current && current.id === id) return { ok: true, already: true, current };
    const target = characterDetail(id).character;
    const skipPlatform = process.env.SURFCORE_DISABLE_PLATFORM_RESTART === '1';
    await memoryCardIdle();
    const wasRunning = skipPlatform ? false : (await bridgeStatus()).running;
    let schedulerWasRunning = !skipPlatform && Boolean(scheduler && schedulerStatus.running);
    try {
      if (schedulerWasRunning) {
        try { await scheduler?.retire?.(); } catch (error) { pluginLog('切换角色：停 B站 会话失败：', error?.message ?? error); }
        scheduler = null;
        schedulerStatus = { running: false, startedAt: null, lastError: null, lastTickAt: null };
      }
      if (wasRunning) {
        await stopAllBridgeSessions();
        const stopped = await stopBridge();
        if (!stopped.ok) {
          schedulerWasRunning = true;
          startSchedulerNow();
          throw new Error(`切换失败：QQ 桥接没停下来（${stopped.error || stopped.message || '未知原因'}）`);
        }
      }
      // 到这里两个平台都停了：给旧角色拍切换前存档，然后原子换指针。
      if (current) beforeSwitchSnapshot(current.id);
      const switched = switchToCharacter(id);
      writeCharacterRolePointer();
      const archived = archiveBridgeRuntimeState();
      // 先把新角色的记忆卡 prompt 生成好，再启动桥接/调度器，避免开头几条提示词读不到记忆。
      await runMemoryCardMaintenance({}).catch((error) => pluginLog('切换角色后整理记忆卡失败：', error?.message ?? error));
      // 新角色的人格稳定部分同步进 Agent 预设（system prompt）；桥接随后重启会带上。
      syncPersonaSystemPreset({ log: pluginLog });
      if (wasRunning) {
        const started = await startBridge({ dshWebUrl: currentDshUrl() });
        if (!started.ok) pluginLog('切换角色：桥接重启失败（角色已切换，平台保持停止）：', started.error || started.message);
      }
      if (!skipPlatform) startSchedulerNow();
      pluginLog(`角色已切换：${current?.name ?? '（无）'} → ${target.name}（epoch ${switched.current?.epoch}）`);
      return {
        ok: true,
        current: switched.current,
        previous: current,
        bridgeRestarted: wasRunning,
        archived,
        scheduler: schedulerStatus,
      };
    } catch (error) {
      pluginLog('角色切换失败：', error?.message ?? error);
      if (schedulerWasRunning && (!scheduler || !schedulerStatus.running)) startSchedulerNow();
      throw error;
    }
  }

  const characterMigration = ensureCharacterSystem();
  // 迁移发生在 scheduler 启动之后：用新角色重启一次，换掉旧会话 id 与旧状态路径。
  if (characterMigration?.migrated) {
    try { scheduler?.stop?.(); } catch {}
    scheduler = null;
    schedulerStatus = { running: false, startedAt: null, lastError: null, lastTickAt: null };
    startSchedulerNow();
  }


  // 记忆卡：插件宿主是唯一维护者。启动 8 秒后整理一次（摄取桥接 inbox + B站记忆），
  // 之后每 10 分钟一次；每日衰减由 memory-card 自己按 dailyHour 判断。
  // 只桌宠模式：这两个维护任务会读 QQ/B站/桌宠记忆、必要时调模型，
  // 交给 shouldRun 在每个 tick 自行跳过；关掉总闸后自动恢复。
  memoryCardTimer = startMemoryCardTimer({ log: pluginLog, callBridge, shouldRun: () => !petOnlyOn() });
  // 自我学习：启动 10 分钟后第一次，之后按 learning.intervalHours（默认 6 小时）。
  learningLoop.start();
  // 记忆整理：每小时检查一次；只有「开关开 + 距上次 20h + 记录够多」才真正调模型。
  memoryOrganizeTimer = setInterval(() => {
    if (petOnlyOn()) return;
    void (async () => {
      try {
        const cfg = readUnified().config?.memoryCard ?? {};
        const result = await memoryOrganizer.autoOrganize({ config: cfg });
        if (result?.ok) {
          const merge = result.merge;
          if (merge) {
            saveUnified({ memoryCard: { organize: { lastRunAt: Date.now(), lastMerged: merge.merged || 0, lastDropped: merge.dropped || 0 } } });
          }
          pluginLog(`[memory-organize] 自动：日记 ${result.diary?.date ?? '—'}（归档 ${result.diary?.removed ?? 0} 条） / 合并 ${merge?.merged ?? 0} 组、删除 ${merge?.dropped ?? 0} 条`);
        }
      } catch (error) {
        pluginLog('[memory-organize] 自动整理失败：', String(error?.message ?? error).slice(0, 120));
      }
    })();
  }, 60 * 60 * 1000);
  memoryOrganizeTimer.unref?.();

  // 角色自动存档：启动 10 秒后跑一次，之后每 6 小时检查（每天最多一份 + 11 个年龄档轮换）。
  const runCharacterAutoSave = () => {
    if (petOnlyOn()) return;
    const cur = readCurrentCharacter();
    if (!cur) return;
    try {
      const result = autoSnapshot(cur.id);
      if (result.pruned?.length) pluginLog(`角色自动存档：${cur.name} 清理 ${result.pruned.length} 个旧档`);
    } catch (error) {
      pluginLog('角色自动存档失败：', error?.message ?? error);
    }
  };
  const characterInitial = setTimeout(runCharacterAutoSave, 10_000);
  characterInitial.unref?.();
  characterTimer = setInterval(runCharacterAutoSave, 6 * 60 * 60 * 1000);
  characterTimer.unref?.();

  // QQ → B站 定时同步（默认关闭；开启后每 30 分钟一次，启动 20 秒后先跑一次）。
  // 必须是 function 声明而不是 const：它在上面 createConfigRoutes 的注入参数里就被读取
  // （第 ~478 行），const 在那一刻还处于 TDZ —— 会把整个 surfcore apply 抛成
  // 「Cannot access 'startSyncTimer' before initialization」，插件看起来装好了却完全不工作。
  function startSyncTimer() {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
    if (petOnlyOn()) return;
    const unified = readUnified().config;
    if (unified.memory?.qqToBili?.enabled !== true) return;
    setTimeout(() => {
      if (petOnlyOn()) return;
      try { syncQqToBili(); } catch (error) { pluginLog('首次 QQ→B站 同步失败：', error?.message ?? error); }
    }, 20_000).unref?.();
    syncTimer = setInterval(() => {
      if (petOnlyOn()) return;
      try { syncQqToBili(); } catch (error) { pluginLog('定时 QQ→B站 同步失败：', error?.message ?? error); }
    }, Math.max(5 * 60_000, Number(unified.memory?.qqToBili?.intervalMs) || 30 * 60_000));
  }

  // 扩展框架已移除（2026-11-03）：没有扩展包，也没有 UI 入口。
  function currentDshUrl() {
    try {
      const ws = ctx.get('webServer');
      if (ws?.port) return `${ws.protocol || 'http:'}//127.0.0.1:${ws.port}`;
    } catch {}
    return String(process.env.DSH_WEB_URL ?? '').trim();
  }

  // 桥接是否还是“上一轮 DSH 的”：旧版本不报 root/dshBaseUrl，或者端口已经变了。
  // 多实例（桌面 + web）共用 ~/.dsh 时，桥接只会被其中一个实例持有 ——
  // 另一个实例看到「桥接连着别的端口」不能直接抢：只要那个 DSH 还活着，它就是对的。
  // 否则两边每 10 分钟互相重启一次，QQ 回复反复断线（用户看到的就是「一直重启」）。
  async function bridgeStaleReason(status) {
    if (!status?.running) return '';
    const runningRoot = status.root ? path.resolve(String(status.root)) : '';
    if (!runningRoot || runningRoot !== path.resolve(QQBOT_ROOT)) {
      return `桥接还在旧目录（root=${status.root ?? '未知'}）`;
    }
    const expected = currentDshUrl().replace(/\/+$/, '');
    const actual = String(status.dshBaseUrl ?? '').trim().replace(/\/+$/, '');
    if (!actual) return '桥接是旧版本，无法报告 DSH 地址';
    if (expected && actual !== expected) {
      if (await dshUrlAlive(actual)) return '';
      return `桥接还连着旧 DSH（${actual} ≠ ${expected}）`;
    }
    return '';
  }

  /** 桥接记录的 DSH 地址是否还有进程在监听（活着就不算旧）。 */
  async function dshUrlAlive(url) {
    try {
      const u = new URL(url);
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      return await portOpen(port);
    } catch {
      return false;
    }
  }

  // 2026-11 用户反馈：「已经配置过的，每次重开还要手动点一键开始」。
  // 这里把「一键开始」的前半段（拉起 SnowLuma → 等 OneBot → 发现并写入地址/令牌）
  // 挂到 DSH 启动时自动执行一次；失败了 5 分钟内不再重试，避免反复拉起。
  let snowBootBusy = false;
  let snowBootFailAt = 0;
  const ensureSnowLumaReady = async () => {
    if (snowBootBusy) return { ok: true, skipped: 'busy' };
    if (process.env.SURFCORE_SKIP_AUTOSTART === '1') return { ok: true, skipped: 'skip-autostart' };
    const cfg = readQqConfig().config?.snowluma ?? {};
    // 直连模式：不接管 SnowLuma（用户自备 OneBot 实现，如 NapCat），这里什么都不做。
    if (cfg.managed === false) return { ok: true, skipped: 'direct-mode' };
    if (cfg.allowLaunch !== true) return { ok: true, skipped: 'allowLaunch=false' };
    if (Date.now() - snowBootFailAt < 5 * 60_000) return { ok: false, skipped: 'cooldown' };
    snowBootBusy = true;
    try {
      const launched = await launchSnowLuma().catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      // 首次使用（还没扫码登录）不自动折腾，交给用户在面板里走一次向导
      if (launched?.needsLogin) return { ok: false, error: '首次使用：需要先扫码登录一次' };
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if ((await portOpen(3000)) || (await portOpen(3001))) break;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      const found = await discoverSnowLumaConnection({ cfg: readQqConfig().config ?? {}, timeoutMs: 5000 }).catch(() => null);
      if (found?.ok) {
        const next = { httpUrl: found.baseUrl };
        if (found.wsUrl) next.wsUrl = found.wsUrl;
        if (found.token) next.accessToken = found.token;
        if (found.wsToken) next.wsToken = found.wsToken;
        // 配置已经一致就别每次都写盘
        const same = cfg.accessToken === next.accessToken && cfg.wsToken === next.wsToken && cfg.httpUrl === next.httpUrl;
        if (!same) saveQqConfig({ snowluma: next });
        pluginLog('[boot] SnowLuma 已就绪：', `${found.self?.nickname ?? ''}（${found.self?.user_id ?? ''}）`);
        return { ok: true, account: String(found.self?.nickname ?? '') };
      }
      snowBootFailAt = Date.now();
      return { ok: false, error: launched?.message || '还没连上 OneBot（确认电脑上的 QQ 已登录）' };
    } finally {
      snowBootBusy = false;
    }
  };

  // 自动拉起桥接（默认关；用户可在设置里开）。
  // 2026-10-22：除了启动时检查一次，再加一个 2 分钟自愈轮询 ——
  // DSH 重启后端口会变，桥接如果还连着旧端口，下一次轮询会自动重启它（而不是等用户发现）。
  let bridgeRepairBusy = false;
  let bridgeRepairTimer = null;
  // 多实例（桌面 + web）同时挂这个插件时会抢同一个桥接：重启失败就冷却 10 分钟，
  // 避免每 2 分钟刷一次「停止脚本跑完了，但端口仍在监听」并把对面实例的桥接打断。
  let bridgeRepairCooldownUntil = 0;
  const maybeAutoStartBridge = async () => {
    if (bridgeRepairBusy) return;
    if (petOnlyOn()) return;
    bridgeRepairBusy = true;
    try {
      if (process.env.SURFCORE_SKIP_AUTOSTART === '1') return;
      // 新开关是唯一真相；旧 bridge.autoStart 已由 readUnified() 迁移，不再直接读。
      if (!platformStartEnabled('qq')) return;
      // 先把 SnowLuma 拉起来并写好连接配置，再判断桥接 —— 否则桥接会连到空端口
      const snow = await ensureSnowLumaReady();
      if (!snow.ok && !snow.skipped) pluginLog('autoStart 预热 SnowLuma 未完成：', snow.error || '');
      const status = await bridgeStatus();
      if (status.running) {
        const stale = await bridgeStaleReason(status);
        if (stale && Date.now() >= bridgeRepairCooldownUntil) {
          pluginLog(`autoStartBridge：${stale}，自动重启`);
          const restarted = await restartBridge({ dshWebUrl: currentDshUrl() });
          pluginLog('autoStartBridge 重启结果：', restarted.message || restarted.error || '');
          if (!restarted.ok) {
            bridgeRepairCooldownUntil = Date.now() + 10 * 60 * 1000;
            pluginLog('autoStartBridge：重启失败（可能另一端实例仍占着桥接），10 分钟内不再重试');
          }
        }
        return;
      }
      pluginLog('autoStartBridge：桥接未运行，尝试启动');
      const result = await startBridge({ dshWebUrl: currentDshUrl() });
      pluginLog('autoStartBridge 结果：', result.message || result.error || '');
    } catch (error) {
      pluginLog('autoStartBridge 失败：', error?.message ?? error);
    } finally {
      bridgeRepairBusy = false;
    }
  };

  const disposers = [];
  // 本机凭据文件收紧 ACL（Windows 默认给 Users/Authenticated Users 读权限）。
  // 只处理少数关键文件，避免 /T 全盘扫描拖慢启动；失败不阻塞（诊断页会提示）。
  function hardenCredentialFiles() {
    const targets = [
      path.join(STATE_DIR, 'qq', 'config.json'),
      path.join(STATE_DIR, 'config.json'),
      path.join(STATE_DIR, 'pet', 'host.json'),
      path.join(STATE_DIR, 'astrbot', 'raw-chat-token'),
      path.join(STATE_DIR, 'astrbot', 'bridge-token'),
      path.join(STATE_DIR, 'astrbot', 'dsh-bridge.json'),
    ];
    for (const target of targets) {
      try {
        if (!fs.existsSync(target)) continue;
        const result = hardenFile(target);
        if (!result.ok) pluginLog('[acl] 凭据文件收紧失败：', `${target} — ${result.detail}`);
      } catch (error) {
        pluginLog('[acl] 凭据文件收紧异常：', `${target} — ${String(error?.message ?? error)}`);
      }
    }
  }
  /** 鉴权服务缺失只告警一次，避免刷日志。 */
  let connMissingWarned = false;
  function route(kind, pathname, handler) {
    disposers.push(ctx.webServer.register({
      kind,
      path: pathname,
      handler: async (req, res) => {
        if (!isLoopbackReq(req)) { json(res, 403, { ok: false, error: '只接受本机回环访问' }); return; }
        if (req.method !== 'GET' && !sameOrigin(req)) { json(res, 403, { ok: false, error: '跨站请求被拒绝' }); return; }
        // Content-Type 只对**浏览器**写请求强制（判据=http-guard.isBrowserRequest）；
        // curl / 本机脚本 / 桌宠进程不带 Content-Type 也放行，body 交给 readJsonBody 解析。
        const ctRejection = contentTypeRejection(req);
        if (ctRejection) {
          json(res, 415, { ok: false, code: 'CONTENT_TYPE', error: ctRejection });
          return;
        }
        try {
          const conn = ctx.get('connection');
          // fail-closed：拿不到 DSH 的鉴权服务（升级改名/被停用）时，绝不能静默降级成
          // 「本机免登录管理面」——这个 API 能 spawn 进程、装插件、写配置。
          if (!conn || typeof conn.requestRejection !== 'function') {
            if (!connMissingWarned) {
              connMissingWarned = true;
              pluginLog('[api] connection.requestRejection 不可用：设置页管理接口已 fail-closed（503）');
            }
            json(res, 503, { ok: false, code: 'AUTH_UNAVAILABLE', error: 'DSH 鉴权服务不可用，已拒绝所有管理接口（fail-closed）。重启 DSH 或检查 DSH 版本。' });
            return;
          }
          const code = conn.requestRejection(req);
          if (code !== undefined && code !== null && code !== false) {
            res.statusCode = typeof code === 'number' ? code : 403;
            res.end();
            return;
          }
          await handler(req, res);
        } catch (error) {
          pluginLog('API 失败：', `${req.method} ${req.url} — ${error?.message ?? error}`);
          // 400/413 这类「客户端请求有问题」的错误要按自己的状态码回，别一律 500：
          // readJsonBody 把非法 JSON 标成 400、readBody 把超限标成 413。
          const status = Number(error?.statusCode);
          const code = status >= 400 && status < 600 ? status : 500;
          try { json(res, code, { ok: false, code: String(error?.code ?? ''), error: String(error?.message ?? error) }); } catch {}
        }
      },
    }));
  }

  /**
   * 「本机服务间」专用路由：给 AstrBot 之类的本机进程调，不经过 DSH 的浏览器会话鉴权。
   *
   * 背景（实测）：插件路由统一过 `connection.requestRejection`，AstrBot 没有浏览器
   * Cookie，带 `Authorization: Bearer dfy-local` 也一样 401。所以这类路口自己守：
   *   · 只收本机回环（非回环 403）；
   *   · 必须带 `Authorization: Bearer <rawChatToken>`（令牌由 dsh-Dfy 写进 AstrBot provider 的 key）；
   *   · 401 响应沿用 OpenAI 错误体，AstrBot 的 provider 测试能直接看懂。
   */
  function localRoute(kind, pathname, handler, { tokenKind = 'raw' } = {}) {
    disposers.push(ctx.webServer.register({
      kind,
      path: pathname,
      handler: async (req, res) => {
        if (!isLoopbackReq(req)) {
          json(res, 403, { error: { message: '只接受本机回环访问', type: 'local_only' } });
          return;
        }
        const presented = bearerFromHeader(req.headers?.authorization);
        const authorized = tokenKind === 'bridge' ? bridgeTokenMatches(presented) : rawChatTokenMatches(presented);
        if (!authorized) {
          json(res, 401, { error: { message: '本地路口令牌无效：设置 → 维护 → 「桥接发现文件」会自动重写，或重载一次 dsh-Dfy 插件', type: 'invalid_api_key', code: 'invalid_api_key' } });
          return;
        }
        try {
          await handler(req, res);
        } catch (error) {
          pluginLog('本地路口失败：', `${req.method} ${req.url} — ${error?.message ?? error}`);
          const status = Number(error?.statusCode);
          const code = status >= 400 && status < 600 ? status : 500;
          try { json(res, code, { error: { message: String(error?.message ?? error), type: 'local_route_error' } }); } catch {}
        }
      },
    }));
  }


  // ── QQ 运行方式：内置版 / AstrBot 版（完全二选一）──────────────────────
  // 内置版：dsh-Dfy 自己的 bridge 直连 SnowLuma OneBot（3001），AstrBot 不接 QQ；
  // AstrBot 版：SnowLuma 通过 wsClients 把事件送进 AstrBot（6199），bridge 停用。
  // 两边的开关、wsClients、进程都由此切换，避免双大脑抢消息。
  function readQqRuntimeMode() {
    try {
      const mode = String(readUnified().config.qqRuntime ?? '').trim();
      if (mode === 'builtin' || mode === 'astrbot') return mode;
    } catch { /* 读不到用默认 */ }
    return 'builtin';
  }

  function execQuiet(command, args, options = {}) {
    return new Promise((resolve) => {
      execFile(command, args, { timeout: options.timeout ?? 10_000, windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error: error ?? null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function listSnowLumaPids() {
    // 用端口归属找 SnowLuma（3000/3001 = OneBot HTTP/WS，5099 = 控制台），
    // 比按命令行匹配稳（Windows 上 Get-CimInstance 可能拿不到 CommandLine）。
    const { stdout } = await execQuiet('netstat', ['-ano', '-p', 'tcp'], { timeout: 12_000 });
    const pids = new Set();
    for (const line of stdout.split(String.fromCharCode(10))) {
      const cols = line.trim().split(" ").filter((x) => x.length > 0);
      const local = cols[1] || "";
      const state = cols[3] || "";
      const pid = cols[4] || "";
      const port = local.slice(local.lastIndexOf(":") + 1);
      if (state === "LISTENING" && ["3000", "3001", "5099", "5199"].includes(port) && /^[0-9]+$/.test(pid)) pids.add(pid);
    }
    return [...pids];
  }

  /** 改完 SnowLuma 的 wsClients 后必须重启它才生效；顺带等 OneBot 端口回来。 */
  async function restartSnowLuma() {
    const pids = await listSnowLumaPids();
    for (const pid of pids) await execQuiet('taskkill', ['/PID', pid, '/F'], { timeout: 8_000 });
    for (let i = 0; i < 30; i += 1) {
      if (!(await portOpen(3000)) && !(await portOpen(3001))) break;
      await sleep(300);
    }
    let launched = { ok: false };
    try { launched = await launchSnowLuma(); } catch (error) { launched = { ok: false, error: String(error?.message ?? error) }; }
    let online = false;
    for (let i = 0; i < 40; i += 1) {
      if (await portOpen(3000)) { online = true; break; }
      await sleep(500);
    }
    return { ok: Boolean(online), pids, launched, online };
  }

  async function setQqRuntimeMode(mode) {
    const target = mode === 'builtin' ? 'builtin' : 'astrbot';
    // 已经在这个模式：只补齐组件，不要为了幂等操作再重启一遍 SnowLuma。
    if (readQqRuntimeMode() === target) {
      try {
        if (target === 'builtin') {
          const st = await bridgeStatus();
          if (!st.running) await startBridge({ dshWebUrl: currentDshUrl() });
        } else {
          const st = await astrbotSupervisor.status();
          if (!st.running) await astrbotSupervisor.start();
        }
      } catch { /* 补组件失败不影响返回 */ }
      return { ok: true, mode: target, unchanged: true };
    }
    saveUnified({ qqRuntime: target });
    if (target === 'builtin') {
      saveUnified({ modules: { qq: true }, platforms: { start: { qq: true } } });
      try { ensureAstrbotWsClient({ cfg: readQqConfig().config ?? {}, url: 'ws://127.0.0.1:6199/ws', enabled: false }); } catch { /* ignore */ }
      try { await stopBridge(); } catch { /* ignore */ }
      try { astrbotSupervisor.stop(); } catch { /* 不是 dsh-Dfy 拉起的会拒绝，忽略 */ }
      let started = { ok: false };
      try { started = await startBridge({ dshWebUrl: currentDshUrl() }); } catch (error) { started = { ok: false, error: String(error?.message ?? error) }; }
      const restart = await restartSnowLuma().catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      return { ok: true, mode: target, bridge: started, restart };
    }
    saveUnified({ modules: { qq: false }, platforms: { start: { qq: false } } });
    try { await stopBridge(); } catch { /* ignore */ }
    try { ensureAstrbotWsClient({ cfg: readQqConfig().config ?? {}, url: 'ws://127.0.0.1:6199/ws', enabled: true }); } catch { /* ignore */ }
    let astrbot = { ok: false };
    try { astrbot = await astrbotSupervisor.start(); } catch (error) { astrbot = { ok: false, error: String(error?.message ?? error) }; }
    const restart = await restartSnowLuma().catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
    return { ok: true, mode: target, astrbot, restart };
  }

  // ── Agent 工具：让鱼能直接列能力 / 调能力 ───────────────────────────────
  // 能力槽不只是一块设置界面的装饰：这里把同一套槽位暴露成 DSH 工具，
  // 鱼在会话里就能通过「当前主实现」调用 douyin.feed / voice.speak，
  // 用户换掉实现后不用改提示词，工具入口保持不变。
  function registerCapabilityTools(capabilityToolService) {
    if (!capabilityToolService || typeof capabilityToolService.register !== 'function') return;
    const renderToolValue = (_args, value) => [{ type: 'text', text: JSON.stringify(value?.result ?? value ?? {}, null, 2) }];
    const toolOutput = {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: { type: 'string' },
          result: { type: 'object', additionalProperties: true },
          images: { type: 'array', items: { type: 'object', additionalProperties: true } },
          imageStatus: { type: 'string' },
        },
        required: ['tool', 'result', 'images', 'imageStatus'],
      },
      render: renderToolValue,
    };
    try {
      disposers.push(capabilityToolService.register({
        name: 'dsh_capability_list',
        description: '列出 dsh-Dfy 的能力槽：当前由哪个实现负责、是否停用、健康状况与可切换的实现。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        timeoutMs: 30000,
        output: toolOutput,
        async execute() {
          return { tool: 'dsh_capability_list', result: capabilityRegistry.snapshot(), images: [], imageStatus: '' };
        },
      }));
      disposers.push(capabilityToolService.register({
        name: 'dsh_capability_call',
        description: '调用 dsh-Dfy 的一项能力（走当前主实现）。可用能力见 dsh_capability_list；不要绕过能力槽直接拼内部接口。',
        parameters: {
          type: 'object',
          properties: {
            capability: { type: 'string', description: '能力 id，例如 douyin.feed 或 voice.speak' },
            input: { type: 'object', additionalProperties: true, description: '能力输入，需符合对应能力契约' },
          },
          required: ['capability'],
          additionalProperties: false,
        },
        timeoutMs: 120000,
        output: toolOutput,
        async execute(args) {
          const capability = String(args?.capability ?? '').trim();
          const capModule = CAPABILITY_MODULE[capability];
          if (capModule && !isModuleEnabled(readUnified().config, capModule)) {
            const result = { ok: false, capability, disabled: true, error: `模块「${capModule}」已停用，这项能力暂不可用。` };
            return { tool: 'dsh_capability_call', result, images: [], imageStatus: '' };
          }
          const input = args?.input && typeof args.input === 'object' && !Array.isArray(args.input) ? args.input : {};
          const result = await capabilityRegistry.invoke(capability, input);
          return { tool: 'dsh_capability_call', result, images: [], imageStatus: '' };
        },
      }));
    } catch (error) {
      pluginLog('[capability] 注册 Agent 工具失败：', String(error?.message ?? error));
    }
  }
  // tools 服务可能比本插件晚就绪：优先直接用，拿不到就等依赖作用域注入后再注册。
  const toolsNow = ctx.get('tools');
  if (toolsNow?.register) registerCapabilityTools(toolsNow);
  else if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (toolCtx) => registerCapabilityTools(toolCtx.get('tools') ?? toolCtx.tools));
    } catch (error) {
      pluginLog('[capability] 等待 tools 服务失败：', String(error?.message ?? error));
    }
  }

  // ── 概览 ────────────────────────────────────────────────────────────────
  /** AstrBot 插件清单缓存（30 秒）：overview 每 10 秒轮询，别每次打 AstrBot API。 */
  let astrbotPluginsCache = { at: 0, value: null };
  async function astrbotPluginsCached() {
    const now = Date.now();
    if (astrbotPluginsCache.value !== null && now - astrbotPluginsCache.at < 30_000) return astrbotPluginsCache.value;
    let value = null;
    try { value = await astrbotApi.listPlugins(); } catch { value = null; }
    astrbotPluginsCache = { at: now, value };
    return value;
  }

  async function overview() {
    const all = readAll();
    const snow = readQqConfig().config?.snowluma ?? {};
    const [bridge, bili, memory] = await Promise.all([
      bridgeStatus().catch((error) => ({ ok: false, error: String(error?.message ?? error) })),
      Promise.resolve(biliToQqStatus()),
      Promise.resolve(memoryStatus()),
    ]);
    // 抖音的运行状态也带回概览，避免只有 QQ / B站 两张卡。
    const douyinOverview = await douyinStatus().catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
    // SnowLuma 只报「未连接」没用：这里给出可执行的诊断（没启动 / 在登录页 / token 不对）。
    const snowDiag = await diagnoseSnowLuma(bridge?.snowluma ?? {}).catch(() => ({ state: 'unknown', hint: '' }));
    const personaText = readTextFile(resolvePersonaFile());
    const mode = parseModeState();
    let dshMode = null;
    try {
      const settings = ctx.get('settings');
      if (settings?.describe) {
        const rows = settings.describe({ redactSecrets: true });
        const row = rows.find((item) => item.ns === 'qq-mode');
        dshMode = row?.value?.mode ?? null;
      }
    } catch {}
    // 路线 B（AstrBot 接管 QQ、大脑在 DSH）时，概览顶部状态点和「QQ 桥接」卡都要换说法：
    // 内置桥「未运行」在那条路线下是正确状态，不是故障。qqConnected 看 6199 有没有连接。
    // 路线状态：插件桥接（bridgePlugin=true）才是当前推荐架构；provider 路线只作回退。
    // 概览/顶栏/向导都靠 mode 判断，避免「同一状态两页说法相反」。
    let routeB = { on: false, apiBase: '', qqConnected: false, bridgePlugin: false, mode: 'off', astrbot: null };
    try {
      const [rb, plugins, supervisor] = await Promise.all([
        Promise.resolve(astrbotApi.getRouteB()),
        astrbotPluginsCached(),
        astrbotSupervisor.status().catch(() => null),
      ]);
      const bridgePlugin = Array.isArray(plugins)
        && plugins.some((plugin) => plugin && plugin.name === 'astrbot_plugin_dsh_bridge' && plugin.enabled === true);
      routeB = {
        ...rb,
        qqConnected: await astrbotApi.isQqConnected().catch(() => false),
        bridgePlugin,
        mode: bridgePlugin ? 'plugin' : (rb.on ? 'provider' : 'off'),
        qqRuntime: readQqRuntimeMode(),
        astrbot: {
          running: supervisor?.running === true,
          port: supervisor?.port ?? null,
          plugins: Array.isArray(plugins) ? plugins.length : 0,
          initialized: supervisor?.initialized !== false,
        },
      };
    } catch (error) {
      pluginLog('[overview] 读取路线 B 状态失败：', error?.message ?? error);
    }
    return {
      ok: true,
      version: VERSION,
      // 合并后设置页显示的「产品名 + 版本」= 小鲸鱼挂件的名字和版本。
      merged: mergedPluginInfo(),
      privacyPolicyVersion: PRIVACY_POLICY_VERSION,
      bridge,
      bili,
      memory,
      douyin: douyinOverview,
      memoryCard: memoryCardStatusNow(),
      admin: adminSummary(all.unified?.admin),
      alignment: alignStats(),
      platforms: platforms.list(),
      // 平台启动开关：设置页顶部状态点、概览三按钮的可用性都读它。
      platformStart: platformStartState(),
      // 路线 B 状态：接管中时顶部/概览要换成「QQ 由 AstrBot 管」，内置桥未运行是正常态。
      routeB,
      // QQ 运行方式（内置版 / AstrBot 版）：导航与设置页按它切换整套 UI。
      qqRuntime: readQqRuntimeMode(),
      // 组件更新：概览「更新」卡与启动弹窗都读它（检查结果是缓存的，不在这里触发网络）。
      updates: updates.status(),
      scheduler: schedulerStatus,
      launch: await launchStatus(),
      snowluma: {
        launcherPath: String(snow.launcherPath ?? ''),
        allowLaunch: snow.allowLaunch === true,
        // SnowLuma 仓库已转私有，不再提供公开下载地址；安装包由用户自行准备。
        downloadUrl: String(snow.downloadUrl ?? ''),
        detected: findSnowLumaInstall().ok,
        everConnected: bridge?.snowluma?.everConnected === true,
        diagnosis: snowDiag,
        // 控制台地址（扫码登录 / 加账号都在这里）；up 只代表端口在听，不代表已登录。
        webui: { ...snowLumaWebui(), up: await portOpen(snowLumaWebui().port) },
        // SnowLuma 自己的 OneBot 服务（3000 HTTP / 3001 WS）在不在听——「进程在跑」的硬指标。
        runtime: {
          onebotUp: (await portOpen(3000)) || (await portOpen(3001)),
        },
      },
      mode: {
        local: mode.localMode,
        dsh: dshMode,
        effective: dshMode || mode.localMode,
        role: mode.localRole,
        ownerQQ: all.qq?.ownerQQ ?? null,
        allowGroups: all.qq?.allow?.groups?.length ?? 0,
        allowPrivate: all.qq?.allow?.private?.length ?? 0,
      },
      persona: {
        path: resolvePersonaFile(),
        exists: Boolean(personaText),
        chars: personaText.length,
        mtime: mtimeIso(resolvePersonaFile()),
      },
      character: (() => {
        const cur = readCurrentCharacter();
        return cur ? { id: cur.id, name: cur.name, epoch: cur.epoch, switchedAt: cur.switchedAt } : null;
      })(),
      paths: { ...pathSummary(), ...memory.paths, backupDir: BACKUP_DIR },
      files: {
        pluginLog: fileInfo(PLUGIN_LOG),
        qqConfig: fileInfo(QQ_CONFIG),
        biliConfig: fileInfo(BILI_CONFIG),
        alignment: fileInfo(ALIGN_FILE),
        qqForBili: fileInfo(activeMemoryPaths().qqForBili),
      },
    };
  }


  // ── 一键启动 / 停止（概览、QQ、B站共用同一份状态）────────────
  // 2026-11 精简：语音包与桌宠都不是可启动组件了（语音包后端已删，桌宠由挂件提供）。
  const LAUNCH_IDS = ['qq', 'bili'];
  const LAUNCH_LABELS = { qq: 'QQ（含 SnowLuma）', bili: 'B站' };

  function normalizeLaunchComponents(input) {
    const list = Array.isArray(input) ? input : [];
    const picked = list.map((x) => String(x)).filter((x) => LAUNCH_IDS.includes(x));
    return [...new Set(picked)];
  }

  async function launchStatus() {
    const bridge = await bridgeStatus().catch((error) => ({ running: false, error: String(error?.message ?? error) }));
    return {
      qq: {
        running: Boolean(bridge.running),
        ok: Boolean(bridge.running && bridge.ok !== false),
        port: bridge.port ?? null,
        pid: bridge.pid ?? bridge.lockPid ?? null,
        snowluma: bridge.snowluma ?? null,
        lastError: bridge.error ?? null,
      },
      bili: {
        running: Boolean(scheduler && schedulerStatus.running),
        lastError: schedulerStatus.lastError ?? null,
        reason: schedulerStatus.reason ?? '',
      },
    };
  }

  function launchItem(id, ok, extra = {}) {
    return { id, label: LAUNCH_LABELS[id] || id, ok: ok !== false, ...extra };
  }

  async function startComponent(id, opts = {}) {
    try {
      if (id === 'qq') {
        if (!platformStartEnabled('qq')) {
          return launchItem(id, false, { code: 'PLATFORM_DISABLED', error: 'QQ 启动开关已关闭', hint: '去「QQ」页打开「随插件自动启动 QQ」并保存' });
        }
        const status = await bridgeStatus();
        const stale = await bridgeStaleReason(status);
        const bridge = stale ? await restartBridge({ dshWebUrl: currentDshUrl() }) : await startBridge({ dshWebUrl: currentDshUrl() });
        const snowluma = await launchSnowLuma().catch((error) => ({ ok: false, error: String(error?.message ?? error), hint: '检查 SnowLuma 安装目录/允许插件打开设置' }));
        const bridgeOk = bridge?.ok !== false;
        const snowOk = snowluma?.ok !== false || snowluma?.skipped === true || snowluma?.already === true;
        return launchItem(id, bridgeOk && snowOk, {
          message: [bridge?.message, snowluma?.message || snowluma?.error].filter(Boolean).join('；'),
          code: bridgeOk && snowOk ? '' : 'QQ_START_PARTIAL',
          error: bridgeOk ? (snowOk ? '' : `QQ 桥接已启动，但 SnowLuma 未打开：${snowluma?.error || '未知原因'}`) : (bridge?.error || bridge?.message || 'QQ 桥接启动失败'),
          hint: bridgeOk ? (snowOk ? '' : (snowluma?.hint || '启动 SnowLuma（launcher.bat）并确认端口 3000/3001')) : '检查桥接日志/端口；必要时重启 DSH',
          detail: { bridge, snowluma },
        });
      }
      if (id === 'bili') {
        if (!platformStartEnabled('bili')) {
          return launchItem(id, false, { code: 'PLATFORM_DISABLED', error: 'B站 启动开关已关闭', hint: '去「养鱼（B站）」页打开「随插件自动启动 B站」并保存' });
        }
        const state = startSchedulerNow();
        return launchItem(id, state.running === true, {
          code: state.running ? '' : 'BILI_START_FAILED',
          error: state.running ? '' : `B站生物钟未启动：${state.reason || state.lastError || '未登录或配置缺失'}`,
          hint: state.running ? '' : '先在「B站」页完成扫码登录；仍失败看插件日志',
          detail: state,
        });
      }
      return launchItem(id, false, { code: 'UNKNOWN_COMPONENT', error: `未知启动项：${id}` });
    } catch (error) {
      return launchItem(id, false, {
        code: `${String(id).toUpperCase()}_START_FAILED`,
        error: `${LAUNCH_LABELS[id] || id} 启动失败：${String(error?.message ?? error).slice(0, 300)}`,
        hint: '看设置页状态/日志；修复后重试',
      });
    }
  }

  async function stopComponent(id, opts = {}) {
    try {
      if (id === 'qq') {
        const r = await stopBridge();
        return launchItem(id, r?.ok !== false, {
          message: 'QQ 桥接已停止（SnowLuma 本体不会被本程序关闭）',
          code: r?.ok === false ? 'QQ_STOP_FAILED' : '',
          error: r?.ok === false ? (r.error || 'QQ 桥接停止失败') : '',
          hint: r?.ok === false ? '看桥接日志/手动结束残留进程' : '',
          detail: r,
        });
      }
      if (id === 'bili') {
        const r = stopSchedulerNow();
        return launchItem(id, true, { message: r.wasRunning ? 'B站生物钟已停止' : 'B站生物钟本来就没在跑', detail: r });
      }
      return launchItem(id, false, { code: 'UNKNOWN_COMPONENT', error: `未知停止项：${id}` });
    } catch (error) {
      return launchItem(id, false, {
        code: `${String(id).toUpperCase()}_STOP_FAILED`,
        error: `${LAUNCH_LABELS[id] || id} 停止失败：${String(error?.message ?? error).slice(0, 300)}`,
        hint: '看设置页状态/日志；必要时手动结束进程',
      });
    }
  }

  async function runLaunchAction(action, body) {
    const ids = normalizeLaunchComponents(body.components);
    if (!ids.length) {
      return { ok: false, code: 'NO_COMPONENTS', error: '没有选择要启动/停止的项目', hint: '至少勾选一项', items: [], status: await launchStatus() };
    }
    const items = [];
    // 停止时先停队列里的子进程，最后停桥接，避免留下孤儿进程（2026-11 起只剩 QQ / B站）。
    const ordered = action === 'stop' ? ['qq', 'bili'].filter((id) => ids.includes(id)) : ids;
    for (const id of ordered) {
      items.push(action === 'stop' ? await stopComponent(id, body) : await startComponent(id, body));
    }
    const status = await launchStatus();
    return { ok: items.every((x) => x.ok), items, status };
  }

  // 桥接动作（组件化迁移 #11b）：/bridge 全部分支已搬到 routes/bridge-actions.js。
  const { handleBridge } = createBridgeActions({
    json, readJsonBody, bridgeStatus, startBridge, restartBridge, stopBridge,
    currentDshUrl, launchSnowLuma, platformStartEnabled, platformStartState,
    bridgeStaleReason, idleSchedulerStatus, startSchedulerNow,
    getScheduler: () => scheduler,
    getSchedulerStatus: () => schedulerStatus,
    runLaunchAction, startComponent, watchStartupCompletion,
    snowLumaWebui, portOpen, openLocalUrl,
    readQqConfig, saveQqConfig, findSnowLumaInstall, enableSnowLumaAutoHook,
    discoverSnowLumaConnection, normalizeSnowLumaInstall, snowLumaMissingReport,
    callBridge, refreshBiliToQq,
  });

  // ── 日志 ────────────────────────────────────────────────────────────────
  /** 日志里可能混进令牌/Key：回给设置页前先按已知秘密值做替换（安全审查 2026-11）。 */
  function redactLogText(text) {
    let out = String(text ?? '');
    const secrets = new Set();
    try {
      const snow = readQqConfig().config?.snowluma ?? {};
      for (const value of [snow.accessToken, snow.wsToken, snow.webuiPassword]) {
        const s = String(value ?? '').trim();
        if (s.length >= 8) secrets.add(s);
      }
    } catch { /* 配置读不到就不加 */ }
    try { secrets.add(ensureRawChatToken()); } catch { /* 忽略 */ }
    try { secrets.add(ensureBridgeToken()); } catch { /* 忽略 */ }
    try {
      let cwd = '';
      try { cwd = String(readUnified().config.astrbot?.cwd || '').trim(); } catch { cwd = ''; }
      if (!cwd) cwd = path.join(os.homedir(), 'astrbot');
      const conf = JSON.parse(fs.readFileSync(path.join(cwd, 'data', 'cmd_config.json'), 'utf8').replace(/^\uFEFF/, ''));
      const secret = String(conf?.dashboard?.jwt_secret ?? '');
      if (secret.length >= 8) secrets.add(secret);
      for (const source of (Array.isArray(conf?.provider_sources) ? conf.provider_sources : [])) {
        for (const key of (Array.isArray(source?.key) ? source.key : [])) {
          const s = String(key ?? '').trim();
          if (s.length >= 12) secrets.add(s);
        }
      }
    } catch { /* AstrBot 没装/没初始化时没有这些秘密 */ }
    for (const s of secrets) { if (s) out = out.split(s).join('***'); }
    return out.replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***');
  }

  // 日志与主人审计（组件化迁移 #11c）：/logs、/owner-audit 已搬到 routes/audit-logs.js。
  const { handleLogs, handleOwnerAudit } = createAuditLogRoutes({
    json, readTextTail, bridgeLogTail, redactLogText, PLUGIN_LOG, QQ_STATE_DIR,
    readJsonBody, callBridge, DATA_ROOT,
  });

  // ── 路由：API 前缀 ──────────────────────────────────────────────────────
  route('prefix', API_PREFIX, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname === `${API_PREFIX}/overview`) { json(res, 200, await overview()); return; }
    // /config 与 /modules 永远可达：只桌宠模式必须留一个入口把自己关掉。
    if (pathname === `${API_PREFIX}/config`) { await handleConfig(req, res); return; }
    // 模块闸门：被停用的模块，它的接口前缀一律 410（核心接口不在映射表里，永远放行）。
    const gatedModule = moduleForPath(pathname, API_PREFIX);
    if (petOnlyOn() && isPetOnlyBlockedPath(pathname, API_PREFIX)) {
      json(res, 410, {
        ok: false, code: 'PET_ONLY', module: gatedModule || '',
        error: '只桌宠模式已开启：QQ / B站 / 贴吧 / 抖音等集成服务已关闭。可在 维护 → 模块与能力 关闭「只桌宠模式」。',
      });
      return;
    }
    if (gatedModule && !isModuleEnabled(readUnified().config, gatedModule)) {
      json(res, 410, { ok: false, code: 'MODULE_DISABLED', module: gatedModule, error: `模块「${gatedModule}」已停用，可在 维护 → 模块与能力 启用。` });
      return;
    }
    if (pathname === `${API_PREFIX}/qq-runtime`) {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, mode: readQqRuntimeMode(), bridge: await bridgeStatus().catch(() => ({})), astrbot: await astrbotSupervisor.status().catch(() => ({})) });
        return;
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 GET / POST' }); return; }
      const runtimeBody = await readJsonBody(req);
      const result = await setQqRuntimeMode(runtimeBody.mode);
      json(res, 200, result);
      return;
    }
    if (pathname === `${API_PREFIX}/characters`) { await handleCharacters(req, res, url); return; }
    if (pathname === `${API_PREFIX}/persona`) { await handlePersona(req, res); return; }
    if (pathname === `${API_PREFIX}/limit-mute`) { await handleLimitMute(req, res); return; }
    if (pathname === `${API_PREFIX}/persona/classify`) { await handlePersonaClassify(req, res); return; }
    if (pathname === `${API_PREFIX}/group-policy`) { await handleGroupPolicy(req, res); return; }
    if (pathname === `${API_PREFIX}/memory`) { await handleMemory(req, res, url); return; }
    if (pathname === `${API_PREFIX}/watch-history`) { handleWatchHistory(res, url); return; }
    if (pathname === `${API_PREFIX}/preferences/scan`) {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: '只支持 GET' }); return; }
      await handlePreferenceScan(res, url);
      return;
    }
    if (pathname === `${API_PREFIX}/fish-guard/qq`) { handleQqFishGuard(res); return; }
    if (pathname === `${API_PREFIX}/memory-card/full`) { await handleMemoryCardFull(req, res, url); return; }
    if (pathname === `${API_PREFIX}/memory-card`) { await handleMemoryCard(req, res, url); return; }
    if (pathname === `${API_PREFIX}/align`) { await handleAlign(req, res); return; }
    if (pathname === `${API_PREFIX}/mode`) { await handleMode(req, res); return; }
    if (pathname === `${API_PREFIX}/platforms`) { await handlePlatforms(req, res); return; }
    if (pathname === `${API_PREFIX}/platform-hub`) { await handlePlatformHub(req, res); return; }
    if (pathname === `${API_PREFIX}/platform-hub/install`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      json(res, 200, await platformHub.install(body.id));
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/config`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      const pasted = String(body.apiKey ?? '').trim();
      const key = pasted || String(process.env.DEEPSEEK_API_KEY ?? '').trim();
      if (!key) { json(res, 200, { ok: false, error: '没有可用的 key：粘贴一个，或在环境变量设置 DEEPSEEK_API_KEY' }); return; }
      const r = await astrbotSupervisor.saveProviderKey(key);
      if (r.ok && r.needRestart) await astrbotSupervisor.restart();
      json(res, 200, { ...r, auto: !pasted });
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/action`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      if (body.action === 'start') { json(res, 200, await astrbotSupervisor.ensureRunning({ manual: true })); return; }
      if (body.action === 'restart') { json(res, 200, await astrbotSupervisor.restart()); return; }
      json(res, 400, { ok: false, error: 'action 只支持 start / restart' });
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/panel`) {
      try {
        const [plugins, qqConnected] = await Promise.all([astrbotApi.listPlugins(), astrbotApi.isQqConnected()]);
        // 路线 B 指向是否漂移：DSH 重启端口会变，写死的 api_base 就打到空端口上（2026-11 实际踩过：3080 失效）。
        const routeB = astrbotApi.getRouteB();
        const current = currentDshUrl();
        const expectedApiBase = current ? `${current}/dsh-surfcore/v1` : '';
        const normUrl = (value) => String(value ?? '').trim().replace(/\/+$/, '');
        routeB.stale = Boolean(routeB.on && expectedApiBase && normUrl(routeB.apiBase) !== normUrl(expectedApiBase));
        routeB.expectedApiBase = expectedApiBase;
        routeB.tokenReady = Boolean(ensureRawChatToken());
        // 「插件桥接模式」：AstrBot 里装了 dsh_bridge 插件时，QQ 消息走插件 → DSH 分会话，
        // 不再依赖 dfy-fish provider。这时 api_base 漂移只影响面板自测，不该当故障报警。
        routeB.bridgePlugin = plugins.some((p) => p && p.name === 'astrbot_plugin_dsh_bridge' && p.enabled === true);
        routeB.mode = routeB.bridgePlugin ? 'plugin' : (routeB.on ? 'provider' : 'off');
        // SnowLuma → AstrBot 的出站客户端以前是手工配置（不写就会「插件装了用不了」）；这里自愈，只增补缺失项。
        // 内置版（qqRuntime=builtin）时绝对不能补：那会让 AstrBot 重新抢走 QQ 事件。
        const qqRuntimeNow = readQqRuntimeMode();
        const snowlumaManaged = readQqConfig().config?.snowluma?.managed !== false;
        let snowlumaClient = { ok: false, changed: false };
        if (qqRuntimeNow === 'astrbot' && snowlumaManaged) {
          try {
            snowlumaClient = ensureAstrbotWsClient({ cfg: readQqConfig().config ?? {}, url: 'ws://127.0.0.1:6199/ws' });
          } catch (error) {
            snowlumaClient = { ok: false, changed: false, reason: String(error?.message ?? error) };
          }
        }
        json(res, 200, {
          ok: true, plugins, qqConnected, routeB, qqRuntime: qqRuntimeNow, snowlumaManaged,
          snowlumaClient: { ...snowlumaClient, needRestart: snowlumaClient.changed === true && qqConnected !== true },
        });
      } catch (error) {
        json(res, 200, { ok: false, error: String(error?.message ?? error), plugins: [], qqConnected: false, routeB: { on: false, apiBase: '' }, snowlumaClient: { ok: false, changed: false } });
      }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/access-mode`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      try {
        const managed = body.managed !== false;
        saveQqConfig({ snowluma: { managed } });
        pluginLog(`[astrbot] 接入方式 → ${managed ? '插件接管 SnowLuma' : '直连（不接管 SnowLuma）'}`);
        json(res, 200, { ok: true, managed });
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/route-b`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      try {
        // api_base 必须跟着当前 DSH 的真实端口走：硬编码 3080 在 DSH 换端口后必然 404/拒连。
        const current = currentDshUrl();
        const apiBase = String(body.apiBase ?? '').trim() || (current ? `${current}/dsh-surfcore/v1` : '');
        if (body.on === true && !apiBase) throw new Error('不知道当前 DSH 的地址（webServer 端口还没就绪，稍后重试）');
        const token = ensureRawChatToken();
        const r = astrbotApi.setRouteB(body.on === true, apiBase, token);
        let snowlumaClient = { ok: false, changed: false };
        try {
          snowlumaClient = ensureAstrbotWsClient({ cfg: readQqConfig().config ?? {}, url: 'ws://127.0.0.1:6199/ws' });
        } catch (error) {
          snowlumaClient = { ok: false, changed: false, reason: String(error?.message ?? error) };
        }
        // 重启可能被拒绝：supervisor 只肯重启「自己拉起的」AstrBot（用户手动跑的不动手）。
        // 以前这里吞掉返回值 → 面板显示「已切换」，实际运行中的 AstrBot 还是旧 provider。
        const restart = r.needRestart
          ? await astrbotSupervisor.restart().catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
          : null;
        const message = [
          body.on === true ? '已切到路线 B：对话回 DSH 会话（AstrBot 重启约 30 秒）' : '已切回路线 A：AstrBot 直连模型',
          snowlumaClient.changed ? 'SnowLuma 接入配置已写入：重启一次 SnowLuma 生效' : '',
          restart && restart.ok === false ? `但 AstrBot 没重启成功（${restart.error ?? '未知原因'}）：请手动重启它，配置才会生效` : '',
        ].filter(Boolean).join('；');
        json(res, 200, { ok: true, message, apiBase, snowlumaClient, restart });
      } catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/chat-test`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      try { json(res, 200, { ok: true, ...(await astrbotApi.chatTest(body.text)) }); }
      catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    // 插件桥接模式的自测：直接走 DSH 会话（和 QQ 消息同一条 DSH 路径，只是不经过 QQ/AstrBot 发送）
    if (pathname === `${API_PREFIX}/astrbot/qq-bridge-test`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      const text = String(body.text ?? '').trim();
      if (!text) { json(res, 200, { ok: false, error: '先输入一句话' }); return; }
      try {
        const r = await qqBridgeChat.ask({ key: 'panel-test', text });
        json(res, 200, { ok: true, reply: r.reply, sessionId: r.sessionId });
      } catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/plugins/install`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      try { json(res, 200, { ok: true, ...(await astrbotApi.installPlugin(body.url)) }); }
      catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/plugins/enabled`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      try { json(res, 200, { ok: true, ...(await astrbotApi.setPluginEnabled(body.name, body.enabled === true)) }); }
      catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/plugins/uninstall`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      try { json(res, 200, { ok: true, ...(await astrbotApi.uninstallPlugin(body.name)) }); }
      catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/personas`) {
      let migrated = null;
      // 首次进入人格页：自动把老角色卡（+记忆卡压缩版）迁成 AstrBot 人格并设为当前
      try {
        const mig = await astrbotApi.migrateOldCharacterPersona();
        if (mig?.ok) migrated = mig;
      } catch (error) { pluginLog('[astrbot] 老角色迁移失败：', String(error?.message ?? error)); }
      try {
        const personas = await astrbotApi.listPersonas();
        json(res, 200, { ok: true, personas, active: astrbotApi.getActivePersonaId(), migrated });
        // 迁移过才需要重启让「设为当前」生效
        if (migrated) await astrbotSupervisor.restart();
      } catch (error) {
        json(res, 200, { ok: false, error: String(error?.message ?? error), personas: [], active: '', migrated });
        if (migrated) await astrbotSupervisor.restart();
      }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/personas/save`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      const id = String(body.id ?? '').trim();
      const prompt = String(body.prompt ?? '');
      if (!id) { json(res, 200, { ok: false, error: '人格 id 不能为空' }); return; }
      try {
        const existing = await astrbotApi.listPersonas();
        if (existing.some((p) => p.id === id)) await astrbotApi.updatePersona(id, prompt);
        else await astrbotApi.createPersona(id, prompt);
        json(res, 200, { ok: true, live: true });
      } catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/market`) {
      const url = new URL(req.url, 'http://127.0.0.1');
      try { json(res, 200, { ok: true, items: await astrbotApi.searchMarket(url.searchParams.get('keyword') ?? '') }); }
      catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error), items: [] }); }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/old-roles`) {
      try { json(res, 200, { ok: true, roles: await astrbotApi.listOldRoles() }); }
      catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error), roles: [] }); }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/old-roles/import`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      try { json(res, 200, await astrbotApi.importOldRole(body.key)); }
      catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/personas/activate`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      try {
        const r = astrbotApi.setActivePersonaId(body.id);
        if (r.needRestart) await astrbotSupervisor.restart();
        json(res, 200, { ok: true, message: '已切换当前人格并重启 AstrBot（约 30 秒生效）' });
      } catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (pathname === `${API_PREFIX}/astrbot/personas/delete`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      const body = await readJsonBody(req);
      try { json(res, 200, { ok: true, ...(await astrbotApi.deletePersona(body.id)) }); }
      catch (error) { json(res, 200, { ok: false, error: String(error?.message ?? error) }); }
      return;
    }
    if (pathname === `${API_PREFIX}/models`) { await handleModels(req, res); return; }
    if (pathname === `${API_PREFIX}/capabilities`) { await handleCapabilities(req, res); return; }
    if (pathname === `${API_PREFIX}/modules`) { await handleModules(req, res); return; }
    if (pathname.startsWith(`${API_PREFIX}/douyin`)) { await handleDouyin(req, res, url); return; }
    if (pathname.startsWith(`${API_PREFIX}/tieba`)) { await handleTieba(req, res, url); return; }
    if (pathname === `${API_PREFIX}/sticker/test`) {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }
      try {
        const body = await readJsonBody(req);
        const qqCfg = readQqConfig().config ?? {};
        const stickers = qqCfg.stickers ?? {};
        const adminQQ = String(readUnified().config.admin?.qq ?? qqCfg.ownerQQ ?? '').trim();
        if (!/^\d{5,15}$/.test(adminQQ)) throw new Error('还没设置管理员 QQ（设置 → 平台 → QQ），测试表情需要发到你的私聊');
        const neko = createNekoStickers({ dir: path.join(STATE_DIR, 'nekowhale-cache'), log: pluginLog });
        const text = String(body.text ?? '测试一下表情').trim().slice(0, 200);
        const item = await neko.pick(text, { excludeEmotions: stickers.excludeEmotions ?? [], minScore: 1 });
        if (!item) throw new Error('没有匹配到表情（换个说法，或先用「/表情自检」检查清单）');
        const result = await neko.send({ httpUrl: qqCfg.snowluma?.httpUrl, token: qqCfg.snowluma?.accessToken, key: `private:${adminQQ}`, item });
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === `${API_PREFIX}/compat/scan`) {
      try {
        let version = '';
        try { version = String(JSON.parse(fs.readFileSync(path.join(QQBOT_ROOT, 'package.json'), 'utf8')).version ?? ''); } catch {}
        const report = scanPluginCompatibility({ surfcoreVersion: version });
        // 体检结果进闸门事件中心：只记 blocker/high，unknown/info 留在体检报告里，避免噪音。
        for (const issue of report.issues ?? []) {
          if (issue.severity !== 'blocker' && issue.severity !== 'high') continue;
          gateEvents.record({
            gate: 'plugin-compat',
            kind: 'compat',
            event: issue.code,
            action: 'blocked',
            subject: { bundle: issue.evidence?.bundle ?? '', profile: report.profile?.name ?? '' },
            reason: { code: issue.code, message: issue.title },
            impact: issue.impact,
            recommendation: issue.recommendation,
            confidence: issue.confidence,
            dedupeKey: `compat:${issue.code}:${issue.evidence?.bundle ?? ''}`,
            evidence: issue.evidence ?? {},
          });
        }
        json(res, 200, report);
      } catch (error) {
        json(res, 500, {
          ok: false,
          code: 'COMPAT_SCAN_FAILED',
          error: `插件体检失败：${String(error?.message ?? error)}`,
          hint: '先确认 DSH_HOME/profiles 可读；如果刚升级过 DSH，重启 DSH 后再试。',
        });
      }
      return;
    }
    if (pathname === `${API_PREFIX}/gate-events`) {
      if (req.method === 'GET') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const level = String(url.searchParams.get('level') ?? '').trim();
        const includeAcked = url.searchParams.get('includeAcked') !== '0';
        const snapshot = gateEvents.list({ limit, level, includeAcked });
        // 「永久不再显示」：桥接侧 POST /api/socialV2/limit-mute 写入的限流 code，
        // 在这里从事件流里过滤掉。以前只有写入没有读取，按钮点了等于没生效。
        try {
          const mutes = readJson(path.join(QQ_STATE_DIR, 'limit-mutes.json'), {}) ?? {};
          const muted = new Set(Object.keys(mutes?.muted ?? {}));
          if (muted.size) {
            snapshot.events = (snapshot.events ?? []).filter(
              (ev) => !(ev.gate === 'limit' && muted.has(String(ev.reason?.code ?? ''))),
            );
          }
        } catch { /* 静音文件坏了不影响展示 */ }
        json(res, 200, { ok: true, ...snapshot, gateEvents: true });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const acked = gateEvents.ack(Array.isArray(body.ids) ? body.ids : [], body.action === 'ack-all' || body.all === true);
        json(res, 200, { ok: true, ...acked, ...gateEvents.list({ limit: 50, includeAcked: false }) });
        return;
      }
      json(res, 405, { ok: false, code: 'GATE_EVENTS_METHOD', error: '只支持 GET / POST', hint: '刷新页面后重试' });
      return;
    }
    if (pathname === `${API_PREFIX}/diagnostics`) { await handleDiagnostics(req, res); return; }
    if (pathname === `${API_PREFIX}/bridge`) { await handleBridge(req, res); return; }
    if (pathname.startsWith(`${API_PREFIX}/purpose`)) { await handlePurpose(req, res, url); return; }
    if (pathname.startsWith(`${API_PREFIX}/persona`)) { await handlePersonaState(req, res, url); return; }
    if (pathname.startsWith(`${API_PREFIX}/learning`)) { await handleLearning(req, res, url); return; }
    if (pathname === `${API_PREFIX}/voice/preview`) { await handleVoicePreview(req, res, url); return; }
    if (pathname.startsWith(`${API_PREFIX}/voice/doubao-web/`)) { await handleVoiceDoubaoWeb(req, res, url); return; }
    // DeepSeek key 状态体检：语音（TTS/ASR）和联网搜索共用这把 key，失效时全部静默降级，
    // 现在设置页能直接看见（2026-11-14 体检；余额接口免费，结果缓存 10 分钟）。
    if (pathname === `${API_PREFIX}/deepseek-status`) { await handleDeepseekStatus(req, res); return; }
    if (pathname === `${API_PREFIX}/snowluma`) { await handleSnowLuma(req, res); return; }
    // 其余语音包管理路由（/voice/packs、/voice/tts-*）已随语音包子系统下线（2026-11 精简）。
    if (pathname.startsWith(`${API_PREFIX}/pet`)) { await handlePet(req, res, url); return; }

    if (pathname === `${API_PREFIX}/token-budget`) { await handleTokenBudget(req, res, url); return; }
    if (pathname === `${API_PREFIX}/updates`) { await handleUpdates(req, res); return; }
    if (pathname.startsWith(`${API_PREFIX}/bili/`)) { await handleBili(req, res, url); return; }
    if (pathname === `${API_PREFIX}/logs`) { handleLogs(res, url); return; }
    // /owner-audit/open 是设置页「打开所在文件夹」按钮用的路径，别只匹配到 /owner-audit（否则按钮 404）。
    if (pathname === `${API_PREFIX}/owner-audit` || pathname === `${API_PREFIX}/owner-audit/open`) { await handleOwnerAudit(req, res, url); return; }
    if (pathname === `${API_PREFIX}/browse`) { await handleBrowse(req, res, url); return; }
    if (pathname === `${API_PREFIX}/privacy/explain`) {
      const body = req.method === 'POST' ? await readJsonBody(req) : { text: url.searchParams.get('text') ?? '' };
      json(res, 200, { ok: true, ...explainText(String(body.text ?? '')) });
      return;
    }
    json(res, 404, { ok: false, error: `未知接口：${pathname}` });
  });

  // 扩展自定义路由已移除（2026-11-03）。

  // 桌宠专用本地接口：独立前缀 + 自己的回环/令牌校验。
  // 不能塞进 /dsh-surfcore/api：那里有 DSH 的 connection.requestRejection（桌宠进程没有会话 Cookie，会 401）。
  // ── 路线 B 路口：OpenAI 兼容端点（AstrBot 的「OpenAI API 兼容」provider 指到这里）──
  // AstrBot 组装好人格/记忆后把消息发过来，我们灌进 DSH 会话 dfy-astrbot，鱼的回复以 OpenAI 格式返回。
  // 对话全程在 DSH 会话里可见（思考过程/模型/上下文都在 DSH 调）。
  // 鉴权：本机回环 + localRoute 自己的 Bearer 令牌（AstrBot 没有 DSH 浏览器 Cookie，过不了 requestRejection）。
  localRoute('exact', '/dsh-surfcore/v1/chat/completions', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { error: { message: '只支持 POST' } }); return; }
    const body = await readJsonBody(req);
    const text = rawChat.lastUserText(body.messages);
    if (!text.trim()) { json(res, 400, { error: { message: 'messages 里没有用户消息' } }); return; }
    const model = String(body.model ?? 'dfy-fish');
    const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // 会话身份：AstrBot 的 OpenAI provider 本身只传 messages，但如果调用方愿意带上
    // 会话标识（自定义 header / OpenAI 规范里的 user / 扩展字段 metadata），就按身份建
    // 独立 DSH 会话；没带则退回默认会话（设置页自测、旧调用方）。
    const conversationKey = String(
      req.headers['x-dsh-conversation']
      ?? req.headers['x-dsh-umo']
      ?? body.user
      ?? body?.metadata?.conversation
      ?? body?.metadata?.umo
      ?? ''
    ).trim();
    // 路线 B 下 QQ 消息只到这里，不再经过桥接镜像——顺手把它投进桌宠消息卡片，
    // 否则卡片看不到 QQ 对话（以前靠桥接 POST /qq/incoming）。
    try { petApi.mirror?.({ role: 'user', sender: '主人', text }); } catch { /* 卡片镜像失败不影响回复 */ }
    try {
      const reply = await rawChat.ask(text, { key: conversationKey });
      try { petApi.mirror?.({ role: 'assistant', text: reply }); } catch { /* 同上 */ }
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for (const chunk of openAiStreamChunks(id, model, reply)) res.write(chunk);
        res.end();
      } else {
        json(res, 200, openAiCompletion(id, model, reply));
      }
    } catch (error) {
      json(res, 500, { error: { message: String(error?.message ?? error), type: 'dfy_raw_chat_error' } });
    }
  });
  localRoute('exact', '/dsh-surfcore/v1/models', async (req, res) => {
    if (req.method !== 'GET') { json(res, 405, { error: { message: '只支持 GET' } }); return; }
    json(res, 200, { object: 'list', data: [{ id: 'dfy-fish', object: 'model', owned_by: 'dsh-dfy' }] });
  });
  // ── QQ 桥接插件通道（AstrBot 插件 → DSH）──
  // 入参 { key: "aiocqhttp:FriendMessage:1913962426" | "private:1913962426", text, timeoutMs,
  //        voiceFile?/voiceUrl? —— 语音条只带标识，音频转写在这边做 }
  // 出参 { ok, key, sessionId, reply }
  localRoute('exact', '/dsh-surfcore/v1/qq-bridge/ask', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { error: { message: '只支持 POST' } }); return; }
    const body = await readJsonBody(req);
    // AstrBot 路径的名单闸：QQ 页白名单/黑名单写的是合体层，只有这里能执行
    //（2026-11-14 体检：此前插件不查名单，整层失效）。被拒时插件侧静默跳过。
    const accessVerdict = checkBridgeAccess({
      key: body.key ?? body.umo ?? '',
      senderId: String(body.senderId ?? '').trim(),
      access: readUnified().config ?? {},
    });
    if (!accessVerdict.allowed) {
      pluginLog(`[qq-bridge] 已按名单拦截 ${body.key ?? body.umo}：${accessVerdict.reason}`);
      json(res, 403, { ok: false, error: 'blocked-by-allowlist', detail: accessVerdict.reason });
      return;
    }
    const text = String(body.text ?? '').trim();
    const voiceFile = String(body.voiceFile ?? '').trim();
    const voiceUrl = String(body.voiceUrl ?? '').trim();
    if (!text && !voiceFile && !voiceUrl) { json(res, 400, { error: { message: 'text 不能为空' } }); return; }
    // 语音条 → 转写 → 当普通消息走对话（前缀让模型知道用户在说话，语气才会接得住）。
    // 开关没开 / 转写失败都回 400，插件收到后回退成原来的占位文案。
    let finalText = text;
    if (!finalText && (voiceFile || voiceUrl)) {
      const asr = readAsrSettings(readQqConfig().config);
      if (!asr.enabled) { json(res, 400, { error: { message: 'voice-asr-disabled' } }); return; }
      const heard = await transcribeQqVoice({
        recordFile: voiceFile,
        recordUrl: voiceUrl,
        settings: asr,
        log: (m) => pluginLog(m),
      });
      if (!heard?.text) {
        // 连续失败要让主人知道（限频），不然用户那边只看到"先用文字跟我说一句吧"，
        // 根因（key 失效/网关挂了）藏在这一行日志里几天都没人看（2026-11-14 体检）。
        void notifyOwner({
          category: 'voice-asr-failed',
          text: 'QQ 语音条转写失败了。原因看日志 qq-voice-asr；常见是 DeepSeek key 失效或 SnowLuma 网关没起。语音设置页现在能直接看 key 状态。',
        }).catch(() => {});
        json(res, 400, { error: { message: 'voice-asr-failed' } });
        return;
      }
      finalText = `（语音）${heard.text}`;
    }
    if (!finalText) { json(res, 400, { error: { message: 'text 不能为空' } }); return; }
    const timeoutMs = Number(body.timeoutMs) > 0 ? Math.min(Number(body.timeoutMs), 300_000) : undefined;
    try {
      const result = await qqBridgeChat.ask({
        key: body.key ?? body.umo ?? '',
        text: finalText,
        timeoutMs,
        persona: body.persona ?? '',
        personaHash: body.personaHash ?? '',
      });
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      // 主人侧限频告警：以前这条链路任何失败（DSH 忙/回合报错）都只进日志，
      // QQ 端表现为"已读不回"，一坏几天（2026-11-14 体检）。
      void notifyOwner({
        category: 'qq-bridge-ask',
        text: `QQ 消息处理失败：${String(error?.message ?? error).slice(0, 160)}。用户那边表现为没回复；详情在插件日志 qq-bridge。`,
      }).catch(() => {});
      json(res, 502, { ok: false, error: String(error?.message ?? error), key: String(body.key ?? '') });
    }
  }, { tokenKind: 'bridge' });
  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: petApi.prefix,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        await petApi.handle(req, res, url);
      } catch (error) {
        pluginLog('[pet-api] 请求失败：', String(error?.message ?? error));
        // 和设置页 API 同口径：readBody 的超限(413) / readJsonBody 的坏 JSON(400) 按自己的码回。
        const status = Number(error?.statusCode);
        const code = status >= 400 && status < 600 ? status : 500;
        try { json(res, code, { ok: false, code: String(error?.code ?? ''), error: String(error?.message ?? error) }); } catch {}
      }
    },
  }));

  route('exact', '/dsh-surfcore/health', async (req, res) => {
    json(res, 200, { ok: true, name, version: VERSION, privacyPolicyVersion: PRIVACY_POLICY_VERSION });
  });

  // 桌宠发现文件（端口漂移 / 令牌轮换都由它兜底）：启动写一次，之后每 2 分钟对一次。
  try { petApi.writeHostFile(true); } catch (error) { pluginLog('[pet-api] 启动写 host.json 失败：', String(error?.message ?? error)); }
  const petHostTimer = setInterval(() => { try { petApi.writeHostFile(false); } catch {} }, 120_000);
  petHostTimer.unref?.();
  // QQ 桥接插件的发现文件（端口漂移/令牌轮换）：启动写一次，之后每分钟对一次。
  writeQqBridgeHostFile();
  setTimeout(() => { try { hardenCredentialFiles(); } catch {} }, 3000).unref?.();
  // DSH 换端口后，AstrBot 里那条 dfy-fish provider 的 api_base 会指向旧端口（面板会报「指向漂移」）。
  // QQ 走桥接插件时用不到它，但面板自测/切回 provider 模式要用——启动时静默跟随一次。
  try {
    const routeB = astrbotApi.getRouteB();
    const current = String(currentDshUrl() || '').replace(/\/+$/, '');
    if (routeB.on && current) {
      const expected = `${current}/dsh-surfcore/v1`;
      if (String(routeB.apiBase ?? '').replace(/\/+$/, '') !== expected) {
        astrbotApi.setRouteB(true, expected, ensureRawChatToken());
        pluginLog(`[astrbot] 路线 B 的 api_base 已跟随 DSH 端口：${expected}（AstrBot 重启后生效）`);
      }
    }
  } catch (error) {
    pluginLog('[astrbot] 启动时校正路线 B 指向失败：', String(error?.message ?? error));
  }

  /**
   * 把包内自带的 AstrBot 桥接插件（astrbot-plugins/astrbot_plugin_dsh_bridge）装进 AstrBot。
   * 首次安装/升级时自动完成，用户不需要手动拷贝；幂等（内容相同就直接返回）。
   */
  function ensureAstrbotBridgePluginFiles() {
    try {
      // PLUGIN_ROOT 指向包内的 backend/；包根的 astrbot-plugins/ 在上一级
      const srcDir = path.join(PLUGIN_ROOT, '..', 'astrbot-plugins', 'astrbot_plugin_dsh_bridge');
      const srcMain = path.join(srcDir, 'main.py');
      if (!fs.existsSync(srcMain)) return { ok: false, reason: 'bundled-missing' };
      let cwd = '';
      try { cwd = String(readUnified().config.astrbot?.cwd || '').trim(); } catch { /* 读不到就按默认目录 */ }
      if (!cwd) cwd = path.join(os.homedir(), 'astrbot');
      const unsafe = unsafeDirReason(cwd);
      if (unsafe) return { ok: false, reason: 'unsafe-cwd', error: unsafe };
      // AstrBot 没初始化时别瞎建目录：先跑 astrbot init / 或者等守护进程拉起来
      if (!fs.existsSync(path.join(cwd, 'data', 'cmd_config.json'))) return { ok: false, reason: 'astrbot-not-initialized' };
      const dstDir = path.join(cwd, 'data', 'plugins', 'astrbot_plugin_dsh_bridge');
      const dstMain = path.join(dstDir, 'main.py');
      let same = false;
      try { same = fs.readFileSync(dstMain, 'utf8') === fs.readFileSync(srcMain, 'utf8'); } catch { same = false; }
      if (same && fs.existsSync(path.join(dstDir, 'metadata.yaml'))) return { ok: true, changed: false, dir: dstDir };
      fs.mkdirSync(dstDir, { recursive: true });
      fs.copyFileSync(srcMain, dstMain);
      const srcMeta = path.join(srcDir, 'metadata.yaml');
      if (fs.existsSync(srcMeta)) fs.copyFileSync(srcMeta, path.join(dstDir, 'metadata.yaml'));
      // 清旧字节码，避免 AstrBot 载入缓存的旧版本
      try { fs.rmSync(path.join(dstDir, '__pycache__'), { recursive: true, force: true }); } catch { /* 忽略 */ }
      return { ok: true, changed: true, dir: dstDir };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 插件桥接模式的「自愈巡检」（每 2 分钟）：DSH 重启后这几个东西最容易掉，全部自动补。
   *
   *   1. SnowLuma 的 wsClients 配置（它只在账号会话启动时读一次，配置丢了不会自己回来）；
   *   2. SnowLuma 进程（它是 QQ 登录层，没它 AstrBot 就没有 QQ 输入）；
   *   3. AstrBot 里 dfy-fish 的 api_base（DSH 端口漂移后要跟随）。
   *
   * AstrBot 进程本身由 astrbotSupervisor 每 30 秒巡检，不在这里重复。
   */
  let bridgeHealthBusy = false;
  async function ensureBridgePluginHealth() {
    if (petOnlyOn()) return;
    if (bridgeHealthBusy) return;
    bridgeHealthBusy = true;
    try {
      if (readQqRuntimeMode() === 'builtin') {
        // 内置版：AstrBot 不参与 QQ，只看管内置桥有没有挂着。
        // 必须先看「随插件自动启动 QQ」开关：用户明确关掉（或 handleConfig 刚把桥停掉）
        // 后，这条 2 分钟巡检不能把它偷偷拉起来 —— 否则开关变成摆设、QQ 永远关不干净。
        // （2026-11-17 体检：只有另一条自愈路径 maybeAutoStartBridge 有这个判断，这里漏了。）
        if (!platformStartEnabled('qq')) return;
        try {
          const builtinStatus = await bridgeStatus();
          if (!builtinStatus.running) await startBridge({ dshWebUrl: currentDshUrl() });
        } catch (error) {
          pluginLog('[qq-builtin] 内置桥自愈失败：', String(error?.message ?? error));
        }
        return;
      }
      let plugins = null;
      try { plugins = await astrbotApi.listPlugins(); } catch { plugins = null; }
      let astrbotStatus = null;
      try { astrbotStatus = await astrbotSupervisor.status(); } catch { astrbotStatus = null; }
      const bridgePlugin = Array.isArray(plugins)
        && plugins.some((p) => p && p.name === 'astrbot_plugin_dsh_bridge' && p.enabled === true);

      // 0) 首次安装/升级：把包里自带的 AstrBot 桥接插件自动装进去（用户不需要手动拷贝文件）。
      //    注意要在「没装就 return」之前执行，否则新机器永远装不上。
      try {
        const installed = ensureAstrbotBridgePluginFiles();
        if (installed.ok && installed.changed) {
          pluginLog(`[qq-bridge] 已自动安装/更新 AstrBot 桥接插件：${installed.dir}`);
          if (astrbotStatus?.running && astrbotStatus?.spawnedByUs) {
            void astrbotSupervisor.restart().catch(() => {});
            pluginLog('[qq-bridge] 已请求重启 AstrBot 以加载桥接插件（约 30 秒）');
          } else if (astrbotStatus?.running) {
            pluginLog('[qq-bridge] AstrBot 不是 dsh-Dfy 拉起的：请手动重启一次 AstrBot，桥接插件才会加载');
          }
        } else if (!installed.ok && installed.reason && installed.reason !== 'bundled-missing') {
          pluginLog(`[qq-bridge] 自动安装桥接插件跳过：${installed.reason}`);
        }
      } catch (error) {
        pluginLog('[qq-bridge] 自动安装桥接插件失败：', String(error?.message ?? error));
      }
      if (!bridgePlugin) return;

      // 插件桥接一旦生效，内置 QQ 桥必须保持停止，否则两个大脑会双回复。
      // 新用户默认 platforms.start.qq=true，这里自动迁移成 false 并停桥（一次，幂等）。
      if (platformStartEnabled('qq')) {
        try {
          saveUnified({ platforms: { start: { qq: false } } });
          const stopped = await stopBridge();
          pluginLog(`[qq-bridge] 已自动停用内置 QQ 桥（插件桥接模式，避免双回复）：${stopped?.ok ? '已停' : (stopped?.error ?? '')}`);
        } catch (error) {
          pluginLog('[qq-bridge] 自动停用内置桥失败：', String(error?.message ?? error));
        }
      }
      // 0) 首装自动化：没配过 SnowLuma 位置就自动识别写入；开启自动注入（否则要人手点「注入」）；
      //    控制台密码存过就静默登录一次（账号列表/加号退号都不用用户再操作）。
      try {
        const snowCfg = readQqConfig().config?.snowluma ?? {};
        if (!String(snowCfg.launcherPath ?? '').trim()) {
          const found = findSnowLumaInstall();
          if (found.ok) {
            saveQqConfig({ snowluma: { launcherPath: found.root, allowLaunch: true } });
            pluginLog(`[qq-bridge] 已自动识别 SnowLuma：${found.root}`);
          }
        }
        enableSnowLumaAutoHook(String(readQqConfig().config?.snowluma?.launcherPath ?? ''));
        if (snowlumaWebuiClient.hasPassword() && (await portOpen(snowLumaWebui().port))) {
          void snowlumaWebuiClient.accounts().catch(() => {}); // 触发一次静默登录（存过密码才会成功）
        }
      } catch (error) {
        pluginLog('[qq-bridge] 首装自动化失败：', String(error?.message ?? error));
      }
      // 1) SnowLuma 接入配置（只增补，不动用户其它网络配置）
      try {
        const client = ensureAstrbotWsClient({ cfg: readQqConfig().config ?? {}, url: 'ws://127.0.0.1:6199/ws' });
        if (client.changed) pluginLog('[qq-bridge] SnowLuma wsClients 配置缺失，已自动补上（重启 SnowLuma 生效）');
      } catch (error) {
        pluginLog('[qq-bridge] 校验 SnowLuma 接入配置失败：', String(error?.message ?? error));
      }
      // 2) SnowLuma 进程看门狗
      const snowlumaUp = (await portOpen(3000)) || (await portOpen(3001));
      if (!snowlumaUp) {
        const launched = await launchSnowLuma().catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
        if (launched?.ok) pluginLog(`[qq-bridge] SnowLuma 不在运行，已自动拉起：${launched.message ?? launched.error ?? ''}`);
        else pluginLog('[qq-bridge] SnowLuma 自动拉起未成功：', String(launched?.error ?? ''));
      }
      // 3) dfy-fish api_base 跟随当前 DSH 端口
      const routeB = astrbotApi.getRouteB();
      const current = String(currentDshUrl() || '').replace(/\/+$/, '');
      if (routeB.on && current) {
        const expected = `${current}/dsh-surfcore/v1`;
        if (String(routeB.apiBase ?? '').replace(/\/+$/, '') !== expected) {
          astrbotApi.setRouteB(true, expected, ensureRawChatToken());
          pluginLog(`[astrbot] 路线 B api_base 跟随 DSH 端口：${expected}`);
        }
      }
    } catch (error) {
      pluginLog('[qq-bridge] 自愈巡检失败：', String(error?.message ?? error));
    } finally {
      bridgeHealthBusy = false;
    }
  }

  void ensureBridgePluginHealth();
  const bridgeHealthTimer = setInterval(() => { void ensureBridgePluginHealth(); }, 120_000);
  bridgeHealthTimer.unref?.();
  const qqBridgeHostTimer = setInterval(() => {
    if (petOnlyOn()) return;
    writeQqBridgeHostFile();
  }, 60_000);
  qqBridgeHostTimer.unref?.();
  // 目的机制（桌宠载体）：carrier=pet 时由这里每 60 秒 tick；carrier=qq 时它自己会退出。
  try { petPurpose.start(); } catch (error) { pluginLog('[pet-purpose] 启动失败：', String(error?.message ?? error)); }

  // 启动后异步做的事（不阻塞插件激活）
  void maybeAutoStartBridge();
  // 组件更新检查已下线（2026-11-03）：设置页不再有更新面板，代码更新改为手动 git pull。
  // 这里不再启动定时 GitHub 请求，避免无意义的后台网络与「查不到/已阻止」噪音。
  // 端口漂移自愈：每 2 分钟检查一次（内部会判断 autoStart 是否开启、是否有并发）。
  bridgeRepairTimer = setInterval(() => { void maybeAutoStartBridge(); }, 120_000);
  bridgeRepairTimer.unref?.();
  startSyncTimer();

  // 抖音的自动轮次跟 B站 生物钟分开：B站 没登录时生物钟不启动，
  // 但抖音是独立的第四个平台，必须按自己的时段走。
  const douyinTimer = setInterval(() => {
    if (petOnlyOn()) return;
    douyinAutoTick().catch(() => {});
  }, 60_000);
  douyinTimer.unref?.();
  const douyinStartupTimer = setTimeout(() => {
    if (petOnlyOn()) return;
    douyinAutoTick().catch(() => {});
  }, 25_000);
  douyinStartupTimer.unref?.();
  // 旧的浏览器私信方案已退役：只有显式打开 legacyBrowser 时才继续跑（默认走 douyin-im）。
  const legacyBrowserChat = !petOnlyOn() && readUnified().config?.douyin?.chat?.legacyBrowser === true;
  const douyinChatTimer = legacyBrowserChat ? setTimeout(() => { douyinChatResume().catch(() => {}); }, 35_000) : null;
  douyinChatTimer?.unref?.();
  // 旧的群聊守护：同样只在 legacyBrowser 模式下工作，避免和 douyin-im 重复回复。
  const douyinChatWatchdog = legacyBrowserChat ? setInterval(async () => {
    try {
      if (readUnified().config?.douyin?.chat?.enabled !== true) return;
      const chatState = await douyinChatStatus();
      if (chatState?.running || chatState?.starting) return;
      pluginLog('[抖音] 自动回复未在运行：自动准备专用窗口并恢复');
      const result = await douyinChatResume();
      if (result?.ok === false) pluginLog(`[抖音] 自动恢复失败：${String(result.error ?? '').slice(0, 160)}`);
    } catch (error) {
      pluginLog(`[抖音] 自动恢复失败：${String(error?.message ?? error).slice(0, 160)}`);
    }
  }, 60_000) : null;
  douyinChatWatchdog?.unref?.();
  // 新方案：douyin-im 长连接（不用浏览器）。开关开着且登录过就自动恢复。
  // 只桌宠模式下不恢复任何抖音连接。
  if (!petOnlyOn()) {
    scheduleDouyinImResume();
    // 调试用：IM 目录里有 selftest.flag 时，启动后自动验证一次「消息 → DSH 会话 → 回复」。
    scheduleDouyinImSelftest();
  }

  // 保存设置后如果开启了“随插件自动启动”，这里也覆盖一次。
  ctx.effect(() => () => {
    try { scheduler?.stop?.(); } catch {}
    try { void disposeDouyin(); } catch {}
    try { astrbotSupervisor.stop(); } catch {}
    try { updates.dispose(); } catch {}
    try { petPurpose.stop?.(); } catch {}
    if (petHostTimer) clearInterval(petHostTimer);
    if (qqBridgeHostTimer) clearInterval(qqBridgeHostTimer);
    if (bridgeHealthTimer) clearInterval(bridgeHealthTimer);
    if (typeof douyinChatWatchdog !== 'undefined') clearInterval(douyinChatWatchdog);
    try { disposeDouyinIm(); } catch {}
    try { sessionEventOff?.(); } catch {}
    try { billing.dispose(); } catch {}
    try { tokenBudget.dispose(); } catch {}
    try { memoryCardTimer?.stop?.(); } catch {}
    try { learningLoop.stop(); } catch {}
    try { capabilityRegistry.dispose(); } catch {}
    if (memoryOrganizeTimer) clearInterval(memoryOrganizeTimer);
    try { closeAllQrLogins(); } catch {}
    if (characterTimer) clearInterval(characterTimer);
    if (syncTimer) clearInterval(syncTimer);
    if (bridgeRepairTimer) clearInterval(bridgeRepairTimer);
    clearInterval(douyinTimer); clearTimeout(douyinStartupTimer); clearTimeout(douyinChatTimer);
    // 桥接现在跑在本进程里：插件卸载时必须把它一起停掉，否则端口/QQ 连接会挂到 DSH 退出。
    try { void stopBridge(); } catch {}
    for (const dispose of disposers) { try { dispose(); } catch {} }
  });

  // 诊断日志：证明插件真的被装配，且知道它读的是哪一份配置。
  pluginLog(`已激活 v${VERSION}；qqConfig=${maskPath(QQ_CONFIG)}；qqData=${maskPath(DATA_ROOT)}；biliTools=${maskPath(BILI_MJS)}；privacy=v${PRIVACY_POLICY_VERSION}`);
}

export default { name, inject, apply };
