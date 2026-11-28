// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import util from 'node:util';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { presetPromptBlockers, presetPromptWarnings } from './preset-prompt.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import {
  DSH_HOME as SHARED_DSH_HOME,
  QQ_DATA_ROOT,
  QQ_PET_DIR,
  QQ_ROLES_DIR,
  QQ_STATE_DIR,
  effectiveQqConfigFile,
  migrateLegacyQqData,
} from './config-locate.js';
// @snowluma/sdk 是可选依赖（只桌宠模式不安装 QQ 集成）。
// 这里不能静态 import：没装 SDK 时本文件一加载就抛 ERR_MODULE_NOT_FOUND，
// 连带桌宠侧也起不来。改成第一次真正要连 QQ 时再加载。
let SnowLumaWebSocketClient = null;
let sdkText = null;
async function loadSnowLumaSdk() {
  if (SnowLumaWebSocketClient && sdkText) return;
  const mod = await import('@snowluma/sdk');
  SnowLumaWebSocketClient = mod.SnowLumaWebSocketClient;
  sdkText = mod.text;
}
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE, ILLEGAL_CONTENT_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { compactModelMessage } from './qq-model-view.js';
import {
  historyWatermark, normalizeHistoryConfig,
  selectMissedHistory, summarizeHistoryCatchup,
} from './history-catchup.js';
import { safeFetchBuffer } from './safe-fetch.js';
import { createNekoStickers } from './nekowhale-stickers.mjs';
import { createHumanizeGate } from './humanize-gate.mjs';
import { humanizeReplyText, looksLikeSilenceDecision } from './reply-cleanup.mjs';
import { prepareReply, capText, takeStickerTags, hasMarkdownImage, hasStickerTag } from './outbound-reply.mjs';
import {
  singleLineForQQ, splitLongSegment, planSocialTimeline,
  convertExampleSpacesToComma, findCjkSpaceWarning, findSplitBoundaryWarning,
  clampGapV2, computeGapsV2,
} from './reply-plan.js';
import {
  mimeFromBuffer, mimeFromUrl, getImageDimensions, base64FromMaybe,
  isSafeLocalMediaPath as isSafeLocalMediaPathImpl,
  isProbablySafeImageFileRef, emojiCdnCandidates, emojiIdFromFileName,
  acceptImageBuffer as acceptImageBufferImpl, resolveMediaLimits,
} from './media-inspect.js';
import { writeJsonFileAtomic as writeJsonFileAtomicSync } from './atomic-write.mjs';
import { createMemoryRecall } from './memory-recall.mjs';
import { noteIncoming, recordReply } from './chat-corpus.js';
import { readAsrSettings, transcribeQqVoice } from './voice-asr.js';
import { recentCrossPlatformDigest } from './cross-platform-digest.mjs';
import { discoverDshBaseUrl, isLoopbackBaseUrl, probeDshBaseUrl } from './dsh-port.js';
import { describeAudio, inspectAudio, listAudioFiles } from './send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { createSeeMeme } from './see-meme.js';
import { memeWikiPromptBlock } from './meme-wiki.js';
import { getQqRuntimeServices } from './qq-runtime-services.js';
import { redactLocalPaths } from './redact-paths.mjs';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { buildProvenanceBlock, buildSelfIdentityBlock, selfIdentityPath } from './self-identity.js';
import { resolvePriceTable, normalizeUsage } from './model-prices.js';
import {
  DEFAULT_QQ_FISH_GUARD, appendFishGuardTrigger, assessFishDensity, fishGuardPromptLine, fishGuardReasonText,
  isFishName, normalizeQqFishGuard,
} from './fish-guard.js';
import {
  assessConversationClosure, classifyMessage, closeGate, closurePromptBlock, closureStatus,
  closureSuppressesWake, makeClosureRecord, normalizeClosureConfig,
  normalizeClosureRecord, reopenClosure,
} from './conversation-closure.js';
import {
  adminFromQqConfig, adminMarker, adminPromptBlock,
} from './admin-identity.js';
import { isOwnerOnlyFrame, canConsumePending, buildQuestionAnswers } from './question-answers.js';
import { createOwnerAudit } from './owner-audit.js';
import { createCoalescingWriter } from './save-scheduler.js';
import { createTokenLedger, usageOfEvent } from './token-ledger.js';
import { createTurnGuard } from './turn-guard.js';
import { createGateEventStore } from './gate-events.js';
import { normalizeAllowlist, pickBacklogSessions } from './allowlist.js';
import { notePersonaActivity, personaPromptBlock } from './persona-state.js';
import { learningPromptBlock } from './learning-profile.js';
import { pickPeerAlias, buildPeerAliasTag } from './callname.js';
import { evaluateWakeBudget, evaluateOutbound, localDayStart } from './token-guard.js';
import {
  blockMessage, evaluateBudget, localDayKey, readBudget, readDailyUsage,
} from './token-budget.js';
import {
  appendMemoryInboxEvent, looksNoteworthyMessage, resolveMemoryCardPaths,
} from './memory-card.js';
import {
  activeMemoryPaths, activePersonaFile, activePlatformStateDir, characterPaths, readCurrentCharacter,
} from './character-persona.js';
import { isHardDirectWakeReason, hasStrictDirectUnread } from './wake-policy.js';
import { DEFAULT_GROUP_POLICY, normalizeGroupPolicy, groupTier, shouldSkipTriggerForTier } from './group-policy.js';
import { planClose } from './action-planner.js';
import { dedupeSessionMappings } from './session-map.js';
import { checkProfileMcp, presetMismatch } from './dsh-health.js';
import { createContextTelemetry } from './context-telemetry.js';
import { createBiliCardSender, normalizeCardMode } from './bili-card.js';
import { fetchVideoInfo } from './bili-api.js';
import { readJsonSafe, readConfigObject, renameWithRetry, atomicWriteJson, atomicWriteText, loadOrCreateConsoleToken } from './qq/json-io.js';
import { loadConfig as loadConfigFrom, normalizeOwnerQQ, normalizeReasoningEffort, REASONING_EFFORT_OPTIONS, REASONING_EFFORT_DEFAULT } from './qq/config.js';
import { MODE_INPUT_ALIASES, VALID_MODES, normalizeModeInput, settingFromDshNamespace, SILENT_MARKER, isSilentMarker, isSilenceDecision, SEND_TOOL_RE, isSendToolName, SPACE_SPLIT_HINT, DIRECTION_HINT, allowed, senderBlocked, canonicalV2Key, APPROVE_WORDS, REJECT_WORDS } from './qq/policy.js';
import { createLogging } from './qq/logging.js';
import { createRegistry } from './qq/core/registry.js';
import { createCoreContext } from './qq/core/context.js';
import { createMorningGreetingComponent } from './qq/features/morning-greeting.js';
import { createStickerComponent } from './qq/features/stickers.js';
import { createSlangComponent } from './qq/features/slang.js';
import { createPurposeComponent } from './qq/features/purpose.js';
import { createBilibiliComponent } from './qq/features/bilibili.js';
import { createVoiceComponent } from './qq/features/voice.js';
import { createTokenComponent } from './qq/features/tokens.js';
import { createRoleConsoleComponent } from './qq/features/role-console.js';
import { createSocialConsoleComponent } from './qq/features/social-console.js';
import { createSocialToolsComponent } from './qq/features/social-tools.js';
import { createProtocolRoutes } from './qq/features/protocol-routes.js';
import { createSocialLegacyRoutes } from './qq/features/social-legacy.js';
import { createConsoleAdminRoutes } from './qq/features/console-admin.js';
import { createV2AdminRoutes } from './qq/features/v2-admin.js';
import { createSocialV2Store } from './qq/features/social-v2-store.js';
import { createConsoleCoreRoutes } from './qq/features/console-core-routes.js';
import { escapeCqText, unquoteJsonString, withTimeout, sanitizeMediaSummary } from './qq/text.js';
import { createLock } from './qq/lock.js';
import { createEmbeddedRejectionGuard } from './embedded-rejection-guard.js';
import { isDshProtocolMismatch } from './dsh-protocol.js';
import { createRoles } from './qq/roles.js';
import { KNOWN_AGENT_TOKENS, CONVERSATION_TOKENS, rememberAgentToken, forgetAgentToken, redactSensitiveText } from './qq/redaction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * JSON 配置的原子写（临时文件 + rename）。
 *
 * 为什么：config.json 同时被本进程、DSH 宿主/设置页、用户手工编辑写入。裸
 * `fs.writeFileSync` 写到一半被读（或断电/强杀）就是半截 JSON，读侧的 catch 又会
 * 静默回落到默认配置 —— 用户的 QQ 号、允许列表、凭据看起来「被重置了」，实际上
 * 只是文件坏了。rename 在同一分区上是原子的，读到的要么是旧文件、要么是新文件。
 *
 * 实现已收口到 atomic-write.mjs（全项目唯一一份）；这里保留别名以兼容调用点。
 */

// 嵌入模式：由 DSH 插件宿主在本进程内启动（不再 spawn 独立进程）。
// 嵌入时**不能**抢锁、不能注册会退出宿主进程的钩子、不能把控制台 HTML 对外提供。
// 由插件在动态 import 之前设置 SURFCORE_EMBEDDED=1。
const EMBEDDED_MODE = process.env.SURFCORE_EMBEDDED === '1';
// 嵌入运行时句柄（仅嵌入模式使用）：停止/热重载由插件宿主调用。
let embeddedRuntime = null;
// 跨模块实例的单例句柄：插件热重载会重新 import 本文件，模块内变量各自一份，
// 但 globalThis 是共享的。没有它，旧实例的 pumpMux 会和新实例并行消费同一条
// 事件流 —— 同一轮回复被处理两遍、发两遍（2026-11-14 日志实测）。
const BRIDGE_SINGLETON = Symbol.for('surfcore.qq.bridge.instance');
// 嵌入模式的「未处理拒绝隔离器」单例：插件热重载会重新 import 本文件，
// 但 globalThis 共享 —— 没有它，每热重载一次就多挂一个 process 监听器。
const EMBEDDED_REJECTION_GUARD = Symbol.for('surfcore.qq.rejectionGuard');
// 二代会话状态的「立即落盘」钩子：由 main() 创建合并写器后注册。
// 进程级退出钩子（installProcessGuards）与内嵌 stop() 都要把合并窗口里的脏数据刷掉，
// 否则 300ms 合并期内正常退出会丢掉最后一批入站缓冲/唤醒计数。
let socialV2FlushOnShutdown = null;

// ── 代码根 vs 数据根（2026-11 公共分发改造）───────────────────────────────────
// ROOT 是**代码根**（npm 包 / clone 的仓库根，只读）：public/console.html、dsh/agent-presets、
// assets 都从这里读。QQ 的运行数据（config.json / state / roles / pet）统一放
// $DSH_HOME/surfcore/qq（数据根，可写）——标准 DSH 安装时包在 <profile>/node_modules 里，
// 写包目录会失败或被 npm 清掉。公式与 backend/lib/paths.js、src/config-locate.js 一致。
// 旧布局升级窗口：数据根还没迁好时 CONFIG_FILE 回退读仓库根的 config.json（避免"配置看起来空了"）。
const DSH_HOME = SHARED_DSH_HOME;
const DATA_ROOT = QQ_DATA_ROOT;
const ROLES_DIR = QQ_ROLES_DIR;
// 先迁移、再定位 CONFIG_FILE：单独启动桥接（没有插件先跑一次）时，这一步会把
// 旧仓库根的 config.json 复制到数据根；否则 CONFIG_FILE 会回退成旧路径，
// 本次进程写旧文件、下次进程读新副本 → 两份配置分叉。
// 内嵌桥接由插件 import 时，插件侧（backend/lib/paths.js）已经迁过，这里是空操作。
try { migrateLegacyQqData({ log: (message) => console.error(`[bridge] ${message}`) }); } catch {}
const CONFIG_FILE = effectiveQqConfigFile();
const STATE_DIR = QQ_STATE_DIR;
const { LOCK_FILE, consolePortInUse, lockPidAlive, acquireLock, releaseLock } = createLock({
  stateDir: STATE_DIR,
  configFile: CONFIG_FILE,
});
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const GROUP_POLICY_FILE = path.join(STATE_DIR, 'group-policy.json');
const LIMIT_MUTE_FILE = path.join(STATE_DIR, 'limit-mutes.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// 操作者为每个会话预写的「初始提示词」（见 main() 里的 initialPrompts）。
// 单独一个文件：它属于操作者配置，不能随 social-v2.json 的会话状态一起被重置清掉。
const INITIAL_PROMPTS_FILE = path.join(STATE_DIR, 'initial-prompts.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
// 合体插件（surfcore）用的两个单向文件：
//   · qq-public-feed.jsonl：只追加“允许群里的公开消息”，供 QQ→B站 脱敏记忆用。
//     私信永远不会写进来（handleIncoming 里只处理 kind === 'group'）。
//   · alignment-brief.md：身份对齐提示块，由插件生成，桥接在投递前置顶注入。
//     对齐高于记忆同步开关，所以它不依赖 cfg.biliBridge.memory.enabled。
const PUBLIC_FEED = path.join(STATE_DIR, 'qq-public-feed.jsonl');
const ALIGNMENT_BRIEF = path.join(STATE_DIR, 'alignment-brief.md');

const {
  createCappedLogger, localClock, log, auditOnce, auditOwner, auditActor, ownerAudit,
  appendActivity, appendPublicFeed, alignmentBriefBlock, readActivityTail,
} = createLogging({
  stateDir: STATE_DIR,
  bridgeLogFile: BRIDGE_LOG,
  activityLogFile: ACTIVITY_LOG,
  publicFeedFile: PUBLIC_FEED,
  alignmentBriefFile: ALIGNMENT_BRIEF,
  embedded: EMBEDDED_MODE,
  redact: redactSensitiveText,
});
// 记忆卡：插件宿主（DSH）是唯一写卡的人；桥接只追加 inbox + 读现成的 QQ 注入块。
// 位置必须和插件 paths.js 的 MEMORY_DIR 一致，否则会出现「卡在写、桥接读不到」。
// 插件（SurfCore 宿主）与桥接共享的额度目录。插件写 token-usage-daily.json，
// 桥接读它做「QQ 今日额度 / 总额度」闸门；插件没跑时回落到自己的 ledger。
// 路径用桥接自己的 DSH_HOME 拼，别在 VM 测试里落到真实 ~/.dsh。
const SURFCORE_DIR = path.join(DSH_HOME, 'surfcore');
// 角色人格：桥接进程启动时解析一次当前角色。切换角色由插件完成「停桥接 → 换指针 → 启桥接」，
// 所以这里不需要在运行中动态换路径；任务开始后也只写自己捕获的这一份目录。
const ACTIVE_CHARACTER = readCurrentCharacter();
const CHARACTER_ID = ACTIVE_CHARACTER?.id ?? '';
const CHARACTER_EPOCH = Number(ACTIVE_CHARACTER?.epoch ?? 0);
const MEMORY_CARD_PATHS = resolveMemoryCardPaths(activeMemoryPaths().dir);
const memoryRecall = createMemoryRecall({ cardFile: MEMORY_CARD_PATHS.json, log });
const PLATFORM_STATE_DIR = activePlatformStateDir(STATE_DIR);
// 容量告警私聊节流（同一档 10 分钟内最多一条；插件侧还有 12 小时的同档节流）。
const memoryCardNotifyAt = new Map();





/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

const {
  listRoles, applyRoleInjectLimit, roleFilePath, roleWarnings, roleSummaries,
  validateRoleName, validateRoleContent, readRoleContent, writeRoleContent,
  knownPresetName, presetSourceYaml, installedPresetYaml, readPresetPromptText,
  backupPresetFile, listPresetBackups, presetStatus,
  readRoleState, writeRoleState, sanitizeRoleName, PRESET_NAMES, ROLE_INJECT_MAX_CHARS_DEFAULT,
  ROLE_NAME_MAX, ROLE_CONTENT_MAX_BYTES, PRESET_BACKUP_DIR,
} = createRoles({
  rolesDir: ROLES_DIR,
  roleStateFile: ROLE_STATE_FILE,
  rootDir: ROOT,
  stateDir: STATE_DIR,
  log,
  getRoleInjectMaxChars: () => roleInjectMaxChars,
});

let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;

// 配置读取统一入口：默认值/归一逻辑都在 src/qq/config.js，这里只绑定当前运行时的路径与回调。
const loadConfig = () => loadConfigFrom({
  configFile: CONFIG_FILE,
  log,
  roleInjectMaxCharsDefault: ROLE_INJECT_MAX_CHARS_DEFAULT,
  applyRoleInjectLimit,
  setRoleInjectMaxChars: (value) => { roleInjectMaxChars = value; },
});









// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
  // 策略签名在磁盘上一直是 JSON 字符串（见 sessionPolicy()），isCurrentSession 用严格相等比较它。
  // 万一文件被手工改成数组形态，比较会永远不相等 → 所有会话被判「权限变了」而退役重建、上下文全丢。
  // 这里只把数组归一化成同一个字符串，其余形态原样保留（读不懂的就不动，别自作主张）。
  for (const [key, value] of Object.entries(state.sessionPolicies)) {
    if (Array.isArray(value)) state.sessionPolicies[key] = JSON.stringify(value);
  }
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}


// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）




const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
// DSH 控制类调用（停任务/归档会话）的超时。这些 await 以前是裸的：DSH 接受了连接但
// 不返回响应时，HTTP handler 永不返回，控制台与群消息一起失去响应（issue #32）。
// 超时后走各自的 catch 记日志，最坏情况只是「这一次重置没做成」，而不是整体挂死。
const DSH_CONTROL_TIMEOUT_MS = 15000;

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true, resolveVoice = null } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      // 语音条：内置模式在这里转文字。以前只塞一个 "[语音]" 占位，
      // 设置里的 ASR 开关在内置模式等于摆设（只有 AstrBot 插件桥会转写）。
      case 'record': {
        if (resolveVoice) {
          try {
            const spoken = String(await resolveVoice(d) ?? '').trim();
            if (spoken) { out.push(`[语音] ${spoken}`); break; }
          } catch { /* 转写失败回退占位；细节由 resolveVoice 记日志 */ }
        }
        out.push('[语音]');
        break;
      }
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

/**
 * 媒体摘要（QQ 表情的 `summary`）会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
//
// 字段必须尽量保留：SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 +
// emoji_id/emoji_package_id/key/url**（实测：sub_type 可能是 0，靠 emoji_id 区分），
// 部分网关实现则用 mface 段。以前只留 file/url/subType/summary，emoji 字段被丢掉，
// 一旦 get_image 取不到（市场表情不在网关缓存里），就再也没有其它可用的兜底地址。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'mface') {
      // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    }
  }
  return media;
}


// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main(options = {}) {
  const embed = EMBEDDED_MODE || options.embed === true;
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  // 嵌入模式不抢锁：锁文件是给独立进程/守护脚本用的，宿主进程由 DSH 生命周期保证唯一。
  if (!embed) acquireLock();
  let shuttingDown = false;
  // 停机叫醒机制：stop() 只置了 shuttingDown，拦得住「下一轮」，却叫不醒正在
  // 退避 sleep 的循环。那个残留的 30s setTimeout 会让宿主进程/测试进程在插件
  // 已经停掉之后还挂着不退出（热重载时表现为旧实例迟迟不结束）。
  const shutdownWaiters = new Set();
  const notifyShutdown = () => {
    for (const wake of [...shutdownWaiters]) { try { wake(); } catch {} }
    shutdownWaiters.clear();
  };
  /** 可被停机打断的 sleep：到点或被 stop() 叫醒，两者谁先发生都行。 */
  function sleepUnlessShutdown(ms) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        shutdownWaiters.delete(done);
        resolve();
      };
      timer = setTimeout(done, ms);
      timer.unref?.();
      shutdownWaiters.add(done);
    });
  }
  // 事件流的显式中断器：shuttingDown 只能拦住「下一轮重连」，叫不醒正卡在
  // `for await` 里的旧实例。插件热重载时旧实例不 abort，就会和新实例并行消费
  // 同一条事件流（2026-11-14 日志：同一秒两条 `事件流已结束`，155 帧 / 183 帧），
  // 结果是同一轮回复被处理两遍、发两遍。
  const muxAbort = new AbortController();
  const embeddedTimers = [];
  loadState();

  // ── 功能组件（见 src/qq/core/registry.js）──────────────────────────────
  // 新功能一律写成组件：自带状态/定时器/路由，依赖显式注入。main() 只负责装配，
  // 不再往里加 if 分支。当前已迁移：morning-greeting。
  const qqRegistry = createRegistry({ log });
  const qqContext = createCoreContext({
    log,
    config: cfg,
    paths: { stateDir: STATE_DIR, configFile: CONFIG_FILE },
  });

  // 闸门事件中心：只记录“发生了什么 + 级别”；具体 UI 通知由插件读同一份文件。
  const gateEvents = createGateEventStore({ dir: SURFCORE_DIR, log: (...args) => log(...args) });
  const turnGuard = createTurnGuard({
    maxSteps: cfg.socialV2?.turnGuard?.maxSteps ?? 40,
    maxRepeatedErrors: cfg.socialV2?.turnGuard?.maxRepeatedErrors ?? 3,
  });

  let proactiveTimer = null;

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  // 已组件化：库状态、提取/研究、学习会话、控制台接口都在
  // src/qq/features/slang.js。这里只注册并注入运行时依赖。
  qqRegistry.register(createSlangComponent({
    stateFile: SLANG_FILE,
    sessionFile: SLANG_SESSION_FILE,
    configFile: CONFIG_FILE,
    log,
    getConfig: () => cfg,
    isDshReady: () => dshReady,
    getApi: () => api,
    resolvePresetName,
    ensureChatModel,
    learnerBudgetBlock,
    createTurnCollector,
  }));
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 已组件化：库状态、同步、标注、推荐、控制台接口都在
  // src/qq/features/stickers.js。这里只注册并注入运行时依赖。
  qqRegistry.register(createStickerComponent({
    stateFile: STICKER_FILE,
    log,
    getConfig: () => cfg,
    getBot: () => bot,
  }));

  // ── 目的机制（主动找主人）─────────────────────────────────────────────
  // 已组件化：状态文件、排程、tick、回合回执、载体/专注、控制台接口都在
  // src/qq/features/purpose.js。这里只注入运行时依赖与状态文件定位规则。
  qqRegistry.register(createPurposeComponent({
    log,
    getConfig: () => cfg,
    getMode: () => currentMode,
    isDshReady: () => dshReady,
    allowed: (kind, id, config) => allowed(kind, id, config),
    getSocialV2State: (key) => getSocialV2State(key),
    getConversations: () => socialV2.conversations,
    isConversationBusy: (key, st) => isConversationBusyV2(key, st),
    flushSocialV2State: () => flushSocialV2State(),
    isSocialPaused: () => socialV2.paused,
    readRoleName: () => String(readRoleState().role || ''),
    readBiliEntries: () => {
      try {
        const raw = readJsonSafe(bili.memory.paths.index, null);
        return Array.isArray(raw?.entries) ? raw.entries : [];
      } catch { return []; }
    },
    readMemoryRecords: () => {
      try {
        const raw = readJsonSafe(MEMORY_CARD_PATHS.json, null);
        return Array.isArray(raw?.records) ? raw.records : [];
      } catch { return []; }
    },
    personaText: () => {
      const file = activePersonaFile();
      if (file) {
        try {
          const text = fs.readFileSync(file, 'utf8').trim();
          if (text) return text;
        } catch {}
      }
      // 没有角色包时回退旧布局的人格卡读取（roleRawContent 是桥接已有的缓存实现）。
      try { return String(roleRawContent() ?? '').trim(); } catch { return ''; }
    },
    selfIdentityText: () => selfIdentityTextV2(),
    adminPromptLine: (withMarker) => adminPromptLine(withMarker),
    adminIdentity: () => adminIdentity(),
    biliBrief: () => (cfg.biliBridge?.enabled !== false && cfg.biliBridge?.memory?.enabled !== false
      ? bili.briefBlock()
      : ''),
    memoryCardText: () => memoryCardPromptBlock(),
    tokenGuardWakeBlock: (key, st, opts) => tokenGuardWakeBlock(key, st, opts),
    friendCheck: (owner) => morningGreeting.friendCheck(owner),
    deliverPrompt: (key, promptText) => deliverPrompt(key, promptText),
    resolveStateFile: () => {
      const cur = readCurrentCharacter();
      return cur?.id
        ? path.join(characterPaths(cur.id).dir, 'purpose-outreach.json')
        : path.join(STATE_DIR, 'purpose-outreach.json');
    },
    defaultStateDir: STATE_DIR,
    configFile: CONFIG_FILE,
  }));

  // ── B 站桥（记忆 / 动态 / 每日分享）─────────────────────────────────────
  // 已组件化：src/qq/features/bilibili.js。启动时机仍在 DSH / 网关就绪之后，
  // 这里只注册；bridge 通过兼容别名 biliMemory 继续读取提示词块。
  qqRegistry.register(createBilibiliComponent({
    stateDir: PLATFORM_STATE_DIR,
    unifiedDir: SURFCORE_DIR,
    log,
    getConfig: () => cfg,
    getMode: () => currentMode,
    isDshReady: () => dshReady,
    isGatewayReady: () => snowlumaHealth.connected === true,
    sendToQQ: (key, message) => sendToQQ(key, message),
    deliverPrompt: (key, promptText) => deliverPrompt(key, promptText),
    sendCard: (opts) => sendBiliCard(opts),
    currentRoleHint: () => currentRoleHint(),
  }));

  // ── 语音发送（组件化）──────────────────────────────────────────────────
  // 状态、限流、触发规则、合成/试听、操作者接口都在 src/qq/features/voice.js。
  // AI 通道 /api/socialV2/send-voice 的协议闸门仍留在 bridge，只调用组件导出的方法。
  qqRegistry.register(createVoiceComponent({
    stateDir: STATE_DIR,
    dataRoot: DATA_ROOT,
    rootDir: ROOT,
    configFile: CONFIG_FILE,
    log,
    getConfig: () => cfg,
    getMode: () => currentMode,
    appendActivity,
    shouldAuditKey: (key) => shouldAuditKey(key),
    captureSendGuard: (key) => captureSendGuard(key),
    // 与文本/图片共用同一发送队列：语音条要过 SILK 转码，不能插队。
    enqueueSend: (fn) => { sendChain = sendChain.then(fn); },
    getSocialV2State: (key) => getSocialV2State(key),
    saveSocialV2State: () => saveSocialV2State(),
    modeAllowed: (key, kind, id, config, mode) => modeAllowed(key, kind, id, config, mode),
  }));

  // ── token 用量账本（组件化）──────────────────────────────────────────────
  // 账本与价格表仍由 bridge 创建；组件只负责读取/重置接口，AI 通道一律拒绝。
  qqRegistry.register(createTokenComponent({
    log,
    getLedger: () => tokenLedger,
    dailyUsage: () => bridgeDailyUsage(),
    budgetLimits: () => bridgeBudgetLimits(),
    priceSymbol: () => priceTable.symbol,
  }));

  // ── 人格 / 预设管理（组件化）────────────────────────────────────────────
  // 文件读写与校验规则在 src/qq/roles.js；组件只负责控制台接口的形状。
  // /api/mode 仍在 bridge（要联动定时器、排队投递与会话策略）。
  qqRegistry.register(createRoleConsoleComponent({
    roles: {
      roleFilePath, readRoleContent, writeRoleContent, validateRoleName, validateRoleContent,
      applyRoleInjectLimit, roleSummaries, roleWarnings, readRoleState, writeRoleState, sanitizeRoleName,
      ROLE_NAME_MAX, ROLE_CONTENT_MAX_BYTES,
      knownPresetName, readPresetPromptText, presetStatus, PRESET_NAMES,
      backupPresetFile, listPresetBackups, presetSourceYaml, installedPresetYaml, PRESET_BACKUP_DIR,
    },
    log,
    configFile: CONFIG_FILE,
    getConfig: () => cfg,
    stateDir: STATE_DIR,
    getRoleInjectMaxChars: () => roleInjectMaxChars,
    setRoleInjectMaxChars: (value) => { roleInjectMaxChars = value; },
    listPresets: async () => {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
      return list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
    },
  }));

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    await stickers.sync(true);
    const entry = stickers.find(stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id（也可以直接用编号 "#01" 发送）`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片下载失败（QQ CDN 网络异常或地址已失效）：${error?.message ?? error}`);
    }
    segments.push({ type: 'image', data: { file: 'base64://' + image.buffer.toString('base64') } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const used = stickers.markUsed(entry.id);
    return { entry: used ?? entry, messageId: data?.message_id ?? null };
  }

  // 本地认知标注 / 表情推荐 / 备注：已收口到 src/qq/features/stickers.js。
  //   stickers.note(id, patch)   stickers.suggest(messages)   stickers.remark(id, text)

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark, meta = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用（并在合并时拿到编号 + 兜底情绪/内容）。
    await stickers.sync(true);
    const entry = stickers.find(emojiId);
    // 收藏时模型看过图，顺手给的 emotion/content 比事后自动推断准，直接落到本地库。
    let tagged = entry;
    if (entry && (meta.emotion || meta.content || (Array.isArray(meta.keywords) && meta.keywords.length))) {
      tagged = stickers.note(entry.id, {
        emotion: meta.emotion,
        content: meta.content,
        keywords: meta.keywords
      }) || entry;
    }
    return { emojiId, entry: tagged || null, remark: cleanRemark };
  }

  // 同一会话 10 分钟内不重复注入同一段近况：每条消息都带一遍太占上下文。
  const learningInjectAt = new Map(); // key -> { text, at }
  function withSlangContext(promptText, key = '') {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    const block = slang.context();
    if (block) parts.push(block);
    // 情绪 / 口头禅：和桌宠、抖音读同一份状态，避免各平台语气前后矛盾。
    // 用 compact 版：完整版会随每条消息进入会话历史，几十轮后变成大片重复噪音。
    try {
      const persona = personaPromptBlock(Date.now(), { compact: true });
      if (persona) parts.push(persona);
    } catch { /* 状态坏了不影响聊天 */ }
    // 她自己看到的（贴吧/B站/抖音）与自动近况：只当背景，不主动汇报。
    try {
      const learning = learningPromptBlock({ compact: true });
      if (learning) {
        const prev = key ? learningInjectAt.get(key) : null;
        const nowMs = Date.now();
        const repeated = prev && prev.text === learning && nowMs - prev.at < 10 * 60_000;
        if (!repeated) {
          if (key) {
            if (learningInjectAt.size > 200) learningInjectAt.clear();
            learningInjectAt.set(key, { text: learning, at: nowMs });
          }
          parts.push(learning);
        }
      }
    } catch { /* 学习状态坏了不影响聊天 */ }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  // 身份对齐置顶：只对群聊注入（私聊不需要，也避免把群成员映射带进私聊）。
  // 它不读 cfg.biliBridge.memory.enabled —— 对齐高于记忆同步开关，这是产品约定。
  function withAlignmentContext(key, promptText) {
    if (!String(key ?? '').startsWith('group:')) return promptText;
    const block = alignmentBriefBlock();
    if (!block) return promptText;
    if (String(promptText).includes('【身份对齐')) return promptText;
    return `${block}\n\n${promptText}`;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 人的黑名单：生效范围是「所有群 + 私聊」，很容易被人误以为只是"某个群禁言"，
  // 所以启动时明确打出来，避免出现"我明明拉黑了他，怎么还不理我"。
  if (cfg.deny?.users?.length) {
    log(`🚫 人的黑名单 deny.users：${cfg.deny.users.join(', ')} —— 无论在哪个群或私聊，这些人的消息一律不入库、不触发唤醒`);
    if (cfg.ownerQQ && cfg.deny.users.map(String).includes(String(cfg.ownerQQ))) {
      log(`⚠️  管理员 QQ ${cfg.ownerQQ} 在黑名单 deny.users 里：审批、私聊、管理命令都会被忽略。请从黑名单里移除`);
    }
  }
  // deny.private 只拦私聊，群里照常回应 —— 用户实测踩过（2026-10-23：把要「彻底拉黑」的人
  // 填进了私聊黑名单，然后在群里测试发现还在回）。只提示「不在 deny.users 里的人」，
  // 免得每次启动都刷一条无关噪音。
  {
    const userSet = new Set((cfg.deny?.users ?? []).map(String));
    const privateOnly = (cfg.deny?.private ?? []).map(String).filter((id) => !userSet.has(id));
    if (privateOnly.length) {
      log(`ℹ️  deny.private 只拦私聊（这些人在群里仍会被回应）：${privateOnly.join(', ')}；`
        + '想在群里也不理，请把他们加到 deny.users（设置页 QQ →「拉黑的人」）');
    }
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  //
  // 端口兜底：DSH 桌面端每次重启都换回环端口，而会话 Cookie 把 host:port 绑进签名，
  // 端口旧了只会 401。DSH 拉起本进程时带了 DSH_WEB_URL，start-with-dsh-port.bat 会先
  // 跑 scripts/sync-dsh-port.mjs；但直接 `npm start` 两条都没走，于是「QQ 有消息、
  // DSH 毫无反应」。这里在启动时补一次探测，只针对回环地址（远程 DSH 不覆盖）。
  if (!String(process.env.DSH_WEB_URL ?? '').trim() && isLoopbackBaseUrl(cfg.dsh.baseUrl)) {
    if (!(await probeDshBaseUrl(cfg.dsh.baseUrl))) {
      const found = await discoverDshBaseUrl();
      if (found) {
        log(`DSH 端口探测：${cfg.dsh.baseUrl || '（未配置）'} 连不上，实际在运行的是 ${found}，本次改用它（并写回 config.json）`);
        cfg.dsh.baseUrl = found;
        try {
          const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          raw.dsh = { ...(raw.dsh ?? {}), baseUrl: found };
          // 原子写：这条路径发生在启动探测失败后自动改配置，正是「写到一半被杀」最可能的时候。
          writeJsonFileAtomicSync(CONFIG_FILE, raw);
        } catch (error) {
          log(`写回 dsh.baseUrl 失败（不影响本次运行）：${error?.message ?? error}`);
        }
      } else {
        log(`⚠️ DSH 端口探测：${cfg.dsh.baseUrl || '（未配置）'} 连不上，也没找到正在运行的 DSH；QQ 消息会排队等待`);
      }
    }
  }
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 官方客户端的 sessions 门面里没有这个方法
  // （只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  // 思考强度热切换代号（原误放在 qq/redaction.js 且未导出，引用会 ReferenceError）。
  // 控制台改强度后递增，让运行中的会话在下一条消息重新 selectModel。
  let modelSelectionEpoch = 0;
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      // loose：旧 DSH 上端点不存在时的措辞五花八门（not found / unknown / unsupported / 404），
      // 判据统一收在 dsh-protocol.js，避免各处再各写一条正则。
      if (!isDshProtocolMismatch(error, { loose: true })) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  // 待退役会话：sessionId -> { key, at }。回合在途时先保留映射与订阅，
  // 等 turn/end 把这一轮回复发完，再真正停用并归档（避免「已生成回复静默蒸发」）。
  const retiringSessions = new Map();
  // 唤醒失败 / 额度耗尽的通知节流：key -> 时间戳。只在「有人明确在叫她」时提醒，
  // 主动叫醒失败不打扰（避免刷屏）。
  const wakeFailureNotifiedAt = new Map();
  const quotaBlockedNotifiedAt = new Map();
  // 本回合是否成功调用过发送工具：sessionId -> { sent, at }。
  // reserved2 模式下模型应通过 qq_send_message 发送；若整轮都没成功调用，
  // 私聊里至少降级把文本发出去，避免「她明明回了却什么都不发」。
  const turnSendToolState = new Map();
  // reserved2「该发没发」的提醒节流：同一会话 10 分钟内只提醒一次，
  // 防止模型连着几轮都不调发送工具时无限追加 turn（每轮都要花钱）。
  const sendNudgeAt = new Map();

  /** 唤醒投递失败时给用户一条可见提示（仅限被 @/叫名字/私聊），10 分钟限频。 */
  function notifyWakeFailure(key, reason, error) {
    try {
      const direct = isHardDirectWakeReason(reason) || String(key ?? '').startsWith('private:');
      if (!direct) return;
      const now = Date.now();
      if (now - (wakeFailureNotifiedAt.get(key) ?? 0) < 10 * 60_000) return;
      wakeFailureNotifiedAt.set(key, now);
      const detail = String(error?.message ?? error ?? '').slice(0, 120);
      const assertSendAllowed = captureSendGuard(key);
      assertSendAllowed();
      sendToQQ(key, `⚠️ 这条没接上：${detail || 'DSH 没响应'}。稍后再叫我一次，或去 设置 → dsh-Dfy → 维护 看诊断。`);
    } catch { /* 提示发不出去也不能影响唤醒流程 */ }
  }

  /** 额度/次数耗尽时给用户一次可见提示（仅限被点名/私聊），6 小时限频。 */
  function notifyQuotaBlocked(key, reason, block) {
    try {
      const direct = isHardDirectWakeReason(reason) || String(key ?? '').startsWith('private:');
      if (!direct) return;
      const now = Date.now();
      if (now - (quotaBlockedNotifiedAt.get(key) ?? 0) < 6 * 3600_000) return;
      quotaBlockedNotifiedAt.set(key, now);
      const assertSendAllowed = captureSendGuard(key);
      assertSendAllowed();
      sendToQQ(key, `⚠️ 今天自动回复的次数/额度用完了，暂时不自动回。可以去 设置 → dsh-Dfy → 额度 调高，或明天再来；你的消息我留着没丢。`);
    } catch { /* 同上 */ }
  }
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  // 连续 wait 计数（2026-10-22）：模型会在一个回合里反复「等消息 → 再等消息」，
  // 每次 wait 都正常返回，回合就永远不结束，侧边栏一直显示“运行中”，还白烧 token。
  // 这里按会话限制：同一回合连续等待超过 2 次，就返回一条收尾提示，让它去设置唤醒/结束回合。
  const waitStreaks = new Map(); // leaseKey -> { count, lastAt }
  const WAIT_STREAK_LIMIT = 2;
  const WAIT_STREAK_RESET_MS = 10 * 60 * 1000;
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  /**
   * 回合判忙租约：只要 `turn/start` 的结束信号（turn/end）丢了，会话就会**永久**判忙，
   * 之后所有唤醒只进 pendingWakeReasons、QQ 上表现为「它不理我了」，只能重启（issue #11/#23/#26/#19）。
   * 正常回合 1~3 分钟，最长工具调用（DSH 的 toolCallTimeoutMs）≈12 分钟，15 分钟足以覆盖任何
   * **还活着**的回合。过期只是不再判忙：collector 本身保留，真回复照常 flush，只是允许新唤醒排队。
   */
  const TURN_BUSY_LEASE_MS = 15 * 60 * 1000;
  const turnLeaseNoted = new Set(); // 租约过期的日志去重（每个 session 只记一次）
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  // 启动审计：多个 QQ 会话不能共用同一个 DSH sessionId，否则上下文会串成「一个会话」。
  const sessionAudit = dedupeSessionMappings(state.sessions);
  if (sessionAudit.removed.length) {
    for (const key of sessionAudit.removed) {
      delete state.sessions[key];
      delete state.sessionPolicies[key];
    }
    saveState();
    const message = `检测到 ${sessionAudit.duplicates.length} 个 sessionId 被多个 QQ 会话共用，已删除 ${sessionAudit.removed.length} 条映射；这些会话下一条消息会重建独立会话。`;
    log(`⚠️ ${message}`);
    try {
      gateEvents.record({
        gate: 'session',
        kind: 'fault',
        event: 'session-map-duplicate',
        action: 'repaired',
        reason: { code: 'SESSION_MAP_DUPLICATE', message },
        impact: '修复前这些群/私聊会共享同一段 DSH 上下文；修复后会各自重建。',
        recommendation: '无需操作；如仍看到同一会话，检查 DSH 侧是否把多个 key 指到同一 sessionId。',
        confidence: 'confirmed',
        dedupeKey: 'session-map-duplicate',
      });
    } catch {}
    for (const item of sessionAudit.duplicates) {
      try { void api.workspace.archiveSession({ sessionId: item.sessionId }).catch?.(() => {}); } catch {}
    }
  }

  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (slang.ownsSession(sessionId) || (slang.activeSessionId() && sessionId === slang.activeSessionId())
        ? 'internal:黑话学习'
        : undefined)
  });

  // Phase 0A：只记录唤醒/prompt 字符数，不参与任何行为判断。
  const contextTelemetry = createContextTelemetry({
    file: path.join(STATE_DIR, 'context-telemetry-bridge.jsonl'),
    source: 'bridge',
    log: (...args) => log(...args),
  });
  let telemetryWakeSeq = 0;
  let lastWakePromptMeta = null;
  const sessionWakeIds = new Map();
  const sessionCharacterIds = new Map();

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  /** sessionId → 最近一次模型调用的输入 tokens（miss+hit+write）。
   *  上下文自动滚动（chat.contextRolloverTokens）的数据源：长会话的全量注入会
   *  永久写进会话历史，上下文滚到十几万 tokens 后每轮延迟暴涨（实测 127k 时
   *  单轮 ~2 分钟）。这里只记数字，滚动动作在 turn_end 收尾时执行。 */
  const sessionContextTokens = new Map();

  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') {
        rememberModel(sessionId, event.data);
        noteManualModelSelection(sessionId, event.data);
      }
      const evUsage = usageOfEvent(event);
      if (evUsage) {
        const buckets = normalizeUsage(evUsage);
        sessionContextTokens.set(sessionId, (buckets.cacheMiss ?? 0) + (buckets.cacheHit ?? 0) + (buckets.cacheWrite ?? 0));
      }
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    // 恢复出来的回合也必须带起始时间，否则租约对它无从生效 —— 这正是
    // 「DSH 重启后忙标记永不复位」的那条路径（issue #19）。不知道真实起点时按现在算：
    // 活着的回合会在 turn/end 清掉；真丢了的回合最多再忙一个租约期就自动解除。
    if (!v2TurnStartAt.has(sessionId)) v2TurnStartAt.set(sessionId, Date.now());
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）
  // 队列落盘：以前 queued 只在内存里，DSH 退出（尤其嵌入模式整个进程结束）时
  // 「系统服务重启中，消息已排队」的那批消息会直接消失。落盘后下次启动补投。
  const QUEUE_FILE = path.join(STATE_DIR, 'pending-prompts.json');
  const saveQueued = () => {
    try {
      const data = {};
      for (const [key, items] of queued) {
        if (Array.isArray(items) && items.length) data[key] = items;
      }
      atomicWriteJson(QUEUE_FILE, data);
    } catch (error) { log(`保存待投递队列失败：${error?.message ?? error}`); }
  };
  const loadQueued = () => {
    const data = readJsonSafe(QUEUE_FILE, {}, false);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    let total = 0;
    for (const [key, items] of Object.entries(data)) {
      if (!/^(group|private):\d+$/.test(key) || !Array.isArray(items)) continue;
      const clean = items
        .filter((item) => item && typeof item.promptText === 'string' && item.promptText)
        .slice(-QUEUE_MAX);
      if (!clean.length) continue;
      queued.set(key, clean);
      total += clean.length;
    }
    if (total) log(`已恢复 ${total} 条上次退出前没投递出去的消息，DSH 就绪后自动补投`);
  };
  // 已知会话：内置版没有 unread 状态，靠这份名单在重启后找回离线消息。
  const KNOWN_FILE = path.join(STATE_DIR, 'known-conversations.json');
  const knownConversations = (() => {
    const data = readJsonSafe(KNOWN_FILE, {}, false);
    return data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {};
  })();
  let knownSaveTimer = null;
  function noteKnownConversation(key) {
    if (!/^(group|private):\d+$/.test(key)) return;
    knownConversations[key] = Date.now();
    if (knownSaveTimer) return;
    knownSaveTimer = setTimeout(() => {
      knownSaveTimer = null;
      try { atomicWriteJson(KNOWN_FILE, knownConversations); } catch { /* 下次还有机会 */ }
    }, 5000);
    knownSaveTimer.unref?.();
  }

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason, petOwnerMessage: !!opts.petOwnerMessage });
      queued.set(key, items);
      saveQueued();
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      const defaultPreset = settingFromDshNamespace(presetNs, 'default');
      if (typeof defaultPreset === 'string' && defaultPreset) {
        dshDefaultPreset = defaultPreset;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      // 读取必须 user 层优先：DSH 0.2.0-rc.2 写完 settings 后同进程内 value 不更新，
      // 只读 value 会让控制台切的模式被 5 秒轮询改回去（issue #22）。
      const fromDsh = normalizeModeInput(settingFromDshNamespace(ns, 'mode'));
      if (fromDsh) {
        currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；**留空表示不覆盖 config.json**
        // （见 plugins/qq-mode-console 的 schema 描述）。这里必须显式判断空串：
        // normalizeOwnerQQ('') 返回 null，若照旧 `!== undefined` 就直接赋值，
        // 设置页每次轮询都会把 config.json 里的 ownerQQ 抹成 null —— 而 5 秒一次的
        // refreshMode 会让它「几秒后必然发生」，后果是 closed-agent 谁都不放行、
        // 审批/提问永远等不到管理员回答。
        const rawOwnerValue = settingFromDshNamespace(ns, 'ownerQQ');
        if (rawOwnerValue !== undefined) {
          const rawOwner = String(rawOwnerValue ?? '').trim();
          if (rawOwner) {
            try {
              cfg.ownerQQ = normalizeOwnerQQ(rawOwner);
            } catch (error) {
              log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
            }
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  /**
   * preset 文件指纹：语气规则改在 preset 的 system prompt 里，只换 preset 内容、
   * 不换 preset 名字时，老会话会一直用旧提示词。把它算进会话策略，内容一变就换新会话。
   */
  function presetContentKey(presetId) {
    if (!presetId) return '';
    try {
      const file = new URL(`../presets/${presetId}.patch.yml`, import.meta.url);
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch { return ''; }
  }

  function sessionPolicy(key) {
    const preset = modePreset(key, currentMode, cfg) ?? '';
    return JSON.stringify([currentMode, preset, presetContentKey(preset), currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slang.forgetSubmitTimes(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  function retireSession(key, { reason = '权限变化' } = {}) {
    const sessionId = state.sessions[key];
    // 回合在途时不能立刻退役：collectors/reverse/事件订阅一删，已经生成好的回复
    // 会在 pumpMux 里因为「key 找不到 / 会话不再当前」被静默丢弃（token 已花、QQ 收不到）。
    // 记成「待退役」，让这一轮先把回复送出去，turn/end 后再真正停用归档。
    if (sessionId && v2TurnStartAt.has(sessionId) && !retiringSessions.has(sessionId)) {
      retiringSessions.set(sessionId, { key, at: Date.now(), reason });
      reverse.set(sessionId, key); // 保留反查：否则 pumpMux 拿不到 key，回复照样丢
      log(`会话${reason}但回合在途：先让这一轮回完再停用 ${key} -> ${sessionId}`);
      delete state.sessions[key];
      delete state.sessionPolicies[key];
      forgetConversationCaches(key);
      contextPrimed.delete(key);
      saveState();
      return true;
    }
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    contextPrimed.delete(key);
    if (!sessionId) return false;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionContextTokens.delete(sessionId);
    sessionModels.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    turnLeaseNoted.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    saveState();
    flushSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      for (const [key, items] of entries) {
        // 只把当前会话的这一批从队列里拿出来；其它会话的还留在 queued 里（也还在盘上），
        // 这样处理到一半进程被关掉，不会把别的会话排队消息一起弄丢。
        queued.delete(key);
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason, petOwnerMessage: item.petOwnerMessage });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        saveQueued();
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      saveQueued();
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        // 每天定时早安（DSH 在线才排定；桥接重启会重新排）
        try { morningGreeting?.schedule?.(); } catch (error) { log(`[早安] 排定失败：${error?.message ?? error}`); }
        // 在线时每群每小时最多主动 @ 一次
        try { startProactiveScheduler(); } catch (error) { log(`[搭话] 启动失败：${error?.message ?? error}`); }
        // 目的机制：定期从近期记忆里提炼目的，主动私聊主人（默认开，可关）。
        if (cfg.purpose?.enabled !== false) {
          try { purpose.start(); } catch (error) { log(`[目的] 启动失败：${error?.message ?? error}`); }
        }
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
          // 2026-10-31：重启前积压的 unread 不会触发事件，必须显式补唤醒；白名单也要先纠正。
          reconcileAllowlist('dsh-ready');
          void auditDshHealth('dsh-ready');
          wakeBacklogConversations('boot');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // 内置版也要补：DSH 关闭期间 SnowLuma 不会推历史，只靠这里把消息捞回来。
        void runChatHistoryCatchUp('dsh-ready');
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        slang.maybeQueueAll();
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    embeddedTimers.push(setInterval(() => { if (!shuttingDown) checkDsh(); }, 5000));
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
    lastSendOkAt: 0,      // 最近一次真实 QQ 发送成功
    lastSendFailAt: 0,    // 最近一次真实 QQ 发送失败
    lastSendError: '',
    everConnected: false, // 本次进程是否成功连过 SnowLuma（仅作展示用，不再拿它当告警前提）
    downNotified: false,  // 通道断开告警是否已发出（边沿触发）
    downSince: 0,         // 首次确认「连不上」的时刻；用于「持续不可达」判据
    downTimer: null,      // close 后的观察窗口（重连很快时不该报 L2）
    downReason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  // ── QQ 发送通道健康 / 跨回合失败抑制 ─────────────────────────────────────
  // 主动唤醒是「先生成、后发送」：通道断着时，模型已经烧完 token 才发现发不出去。
  // 所以门槛必须在 sendWakePromptV2 之前（不创建 DSH 会话），不在工具层。
  const SEND_CHANNEL_SUSPEND_MS = 30 * 60 * 1000;
  // 告警判据是「持续不可达」而不是「本次进程曾连上过」。
  // 2026-11-03 真实事故：SnowLuma 08:09 就没了，内嵌桥接 16:05 才随 DSH 启动，
  // everConnected 恒为 false → notifySendChannelDown 直接 return → 界面上零提示，
  // 直到真去发消息才看到 fetch failed。给 2 分钟观察窗口挡住启动瞬间的正常抖动。
  const SNOWLUMA_DOWN_GRACE_MS = 120_000;

  function qqSendChannelStatus() {
    if (snowlumaHealth.connected !== true) {
      return { ok: false, code: 'SNOWLUMA_OFFLINE', reason: 'SnowLuma WS 未连接' };
    }
    if (snowlumaHealth.lastSendFailAt > snowlumaHealth.lastSendOkAt
      && Date.now() - snowlumaHealth.lastSendFailAt < 2 * 60 * 1000) {
      return { ok: false, code: 'SEND_RECENTLY_FAILED', reason: `最近发送失败：${snowlumaHealth.lastSendError || '未知'}` };
    }
    return { ok: true };
  }

  const logThrottle = new Map();
  /** 同一 tag 在 ms 内只打一次日志（未授权会话/守卫重试会刷屏）。 */
  function logThrottled(tag, ms, message) {
    const now = Date.now();
    const last = logThrottle.get(tag) ?? 0;
    if (now - last < ms) return false;
    logThrottle.set(tag, now);
    log(message);
    return true;
  }

  /**
   * 白名单自愈：去掉机器人自己、补上主人、去重。
   * 2026-10-31 实测：allow.private 里只有机器人自己的 UIN → 主人私信被当未授权忽略。
   * 这里在启动/登录/DSH 就绪时纠正一次，并落盘 + 记事件，避免用户被静默丢消息。
   */
  /**
   * DSH 升级后的健康审计（2026-11-01 用户反馈：升级后 QQ 会话没有 qq_* 工具）。
   *   ① profile 的 3 条 MCP 被摘 → 新会话也没有 qq_*（提示重跑 setup-dsh.mjs + 重启 DSH）；
   *   ② 旧会话的 preset 与当前配置不一致 → 工具表在创建时定死，必须重建。
   * 只审计“有记录 preset 且与期望不同”的会话，避免误删老会话。
   */
  async function auditDshHealth(reason = 'dsh-ready') {
    try {
      const home = process.env.USERPROFILE || os.homedir();
      const check = checkProfileMcp(home);
      if (check.checked > 0 && !check.ok) {
        const broken = check.broken[0];
        gateEvents.record({
          gate: 'dsh', kind: 'fault', event: 'dsh-profile-mcp-missing', action: 'blocked',
          level: 'L2',
          reason: { code: 'DSH_PROFILE_MCP_MISSING', message: `profile ${broken?.profile ?? '?'} 缺少 MCP：${(broken?.missing ?? []).join(', ')}` },
          impact: 'DSH 升级可能摘掉了 surfcore 的 MCP 注册：新会话拿不到 qq_* 工具，机器人收到消息也发不出来。',
          recommendation: '请在**宿主机终端**运行 node scripts/setup-dsh.mjs <profile>（QQ 会话里的模型没有本地工具权限，跑不了这条）；脚本本身不会重启 DSH，跑完需完全退出并重开 DSH；旧会话可能仍需在控制台重置一次。',
          confidence: 'confirmed',
          dedupeKey: 'dsh-profile-mcp-missing',
          evidence: { manualOnly: true, checked: check.checked, broken: check.broken.map((b) => b.profile) },
        });
        log(`⚠️ DSH profile 缺 MCP（${broken?.profile ?? '?'}）：${(broken?.missing ?? []).join(', ')}；qq_* 工具可能不可用，请重跑 setup-dsh.mjs 并重启 DSH`);
      }
    } catch (error) {
      log(`[dsh-health] profile 检查失败（继续）：${error?.message ?? error}`);
    }
    try {
      const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
      const byId = new Map((list.items ?? []).map((item) => [item.sessionId, item]));
      let rebuilt = 0;
      const details = [];
      for (const [key, sid] of Object.entries(state.sessions ?? {})) {
        const item = byId.get(sid);
        if (!item) continue;
        const expected = modePreset(key, currentMode, cfg);
        if (!presetMismatch(expected, item.agentPreset)) continue;
        details.push({ key, expected: expected ?? '', actual: item.agentPreset });
        retireSession(key);
        rebuilt += 1;
      }
      if (rebuilt > 0) {
        gateEvents.record({
          gate: 'dsh', kind: 'fault', event: 'session-preset-rebuilt', action: 'blocked',
          level: 'L1',
          reason: { code: 'SESSION_PRESET_MISMATCH', message: `${rebuilt} 个会话的 preset 与当前配置不一致，已重建` },
          impact: '旧会话的工具表在创建时定死；重建后会按当前 preset 重新拉 qq_* 工具（上下文会重新开始）。',
          recommendation: '无需操作；若仍没有 qq_* 工具，请在宿主机终端运行 setup-dsh.mjs（QQ 内模型无法执行本地命令），再完全重启 DSH。',
          confidence: 'confirmed',
          dedupeKey: 'session-preset-rebuilt',
          evidence: { rebuilt, details: details.slice(0, 10) },
        });
        log(`[dsh-health] 已重建 ${rebuilt} 个 preset 不一致的会话：${details.map((d) => d.key).join(', ')}`);
      }
    } catch (error) {
      log(`[dsh-health] 会话 preset 审计失败（继续）：${error?.message ?? error}`);
    }
  }

  function reconcileAllowlist(reason = 'boot') {
    try {
      const { allow, changed, warnings } = normalizeAllowlist({
        allow: cfg.allow,
        ownerQQ: cfg.ownerQQ,
        selfUserId,
      });
      if (!changed) return false;
      cfg.allow = { ...(cfg.allow ?? {}), private: allow.private, groups: allow.groups };
      const configFile = CONFIG_FILE;
      const file = readConfigObject(configFile);
      file.allow = { ...(file.allow ?? {}), private: allow.private, groups: allow.groups };
      // 改配置前先留一份原始文件（AGENTS 铁律 6）；只保留最近 5 份。
      try {
        const dir = path.join(STATE_DIR, 'allowlist-backups');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(configFile, path.join(dir, `config.${stamp}.json`));
        const stale = fs.readdirSync(dir).filter((f) => f.startsWith('config.')).sort();
        for (const f of stale.slice(0, Math.max(0, stale.length - 5))) fs.rmSync(path.join(dir, f), { force: true });
      } catch (error) {
        log(`[allow] 备份 config.json 失败（继续）：${error?.message ?? error}`);
      }
      atomicWriteJson(configFile, file);
      for (const w of warnings) log(`[allow] (${reason}) ${w.code}: ${w.message}`);
      gateEvents.record({
        gate: 'allowlist',
        kind: 'config',
        event: 'allowlist-reconciled',
        action: 'fixed',
        reason: { code: 'ALLOWLIST_RECONCILED', message: warnings.map((w) => w.code).join(', ') },
        impact: '白名单已自动纠正（移除机器人自己 / 补上主人）。不纠正时主人私信会被当作未授权会话忽略。',
        recommendation: '如需增删，请在设置页保存；系统会保留已有条目并确保主人在私聊白名单里。',
        confidence: 'confirmed',
        dedupeKey: `allowlist:${reason}:${allow.private.join(',')}:${allow.groups.join(',')}`,
      });
      return true;
    } catch (error) {
      log(`[allow] 自愈失败（${reason}）：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 启动补唤醒：桥接重启前积压的 unread 不会触发任何事件，必须在这里补一次。
   * 只在 reserved2 + DSH 就绪后调用（open 时 currentMode 还是 chat，会被模式守卫吞掉）。
   */
  function wakeBacklogConversations(trigger = 'boot') {
    if (shuttingDown) return;
    if (currentMode !== 'reserved2' || cfg.socialV2?.enabled === false) return;
    const timer = setTimeout(() => {
      if (shuttingDown) return;
      try {
        const all = pickBacklogSessions(socialV2.conversations.entries(), {
          isAllowed: (key) => isSessionAllowedInCurrentMode(key),
        });
        // 限量：默认最多 3 个会话（按未读条数降序），避免重启后一次性叫醒几十个群、白烧 token。
        // 从 5 降到 3 的依据：Phase 1A 样本里 backlog 是最贵的唤醒类型（冷启动）。
        const cap = Math.max(1, Math.min(20, Number(cfg.socialV2?.wake?.backlogMaxSessions) || 3));
        const backlog = all.sort((a, b) => b.unread - a.unread).slice(0, cap);
        if (all.length > backlog.length) log(`[reserved2] 启动补唤醒：共 ${all.length} 个会话有积压，本次只补前 ${backlog.length} 个`);
        for (const item of backlog) {
          log(`[reserved2] 启动补唤醒 ${item.key}（${trigger}）：积压 ${item.unread} 条未读`);
          void sendWakePromptV2(item.key, 'backlog').catch((error) => log(`[reserved2] 补唤醒异常 ${item.key}：${error?.message ?? error}`));
        }
        if (backlog.length) log(`[reserved2] 启动补唤醒完成（${trigger}）：${backlog.length} 个会话`);
      } catch (error) {
        log(`[reserved2] 启动补唤醒失败：${error?.message ?? error}`);
      }
    }, 12_000);
    timer.unref?.();
  }

  // 宿主侧（backend/lib/index.js）每次尝试拉起 SnowLuma 都会写这份状态文件。
  // 弹窗决策要用它：自愈还在进行就不弹（系统正在修），自愈失败才弹、且弹真实原因——
  // 否则就是「一边自动拉起一边报警让你去手动拉起」，报告问题而不是解决问题
  // （2026-11-17 用户批评：弹窗说 code=1006、建议去启动 SnowLuma，而系统正在启动它）。
  let launchStateCache = { at: 0, data: null };
  function readSnowLumaLaunchState() {
    const now = Date.now();
    if (now - launchStateCache.at < 10_000) return launchStateCache.data;
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(SURFCORE_DIR, 'snowluma-launch-state.json'), 'utf8')); } catch { data = null; }
    launchStateCache = { at: now, data };
    return data;
  }

  function notifySendChannelDown(reason = '') {
    if (snowlumaHealth.connected === true) return;
    const now = Date.now();
    // 不能以「本次进程曾经连上过」为前提：桥接重启时网关可能已经死了，
    // 那样这条告警永远不会触发（见 SNOWLUMA_DOWN_GRACE_MS 的说明）。
    if (!snowlumaHealth.downSince) {
      snowlumaHealth.downSince = now;
      // 启动瞬间/短暂抖动：先只记一行，2 分钟内恢复就不升级为告警。
      log(`[snowluma] 暂未连接（${String(reason || '未启动').slice(0, 120)}）；${Math.round(SNOWLUMA_DOWN_GRACE_MS / 1000)} 秒内没恢复才告警`);
      return;
    }
    if (now - snowlumaHealth.downSince < SNOWLUMA_DOWN_GRACE_MS) return;
    if (snowlumaHealth.downNotified) return;

    // ── 自愈感知决策：先弄清「系统能不能自己修、修到哪一步了」，再决定弹不弹、弹什么 ──
    const allowLaunch = cfg.snowluma?.allowLaunch === true;
    const state = readSnowLumaLaunchState();
    const stateAge = state?.at ? now - Number(state.at) : Infinity;
    // 自愈正在拉起 SnowLuma（90 秒内的 launching 记录）：系统正在修，弹窗只会是噪音。
    if (allowLaunch && state?.phase === 'launching' && stateAge < 90_000) {
      log(`[snowluma] 通道未恢复，但自愈正在拉起 SnowLuma（${Math.round(stateAge / 1000)}s 前开始）——不弹窗，等结果`);
      return;
    }
    // 上一次拉起成功但通道还没连上：连上只是时间问题（WS token 自愈 + 重连），
    // 不弹；真连不上说明 SnowLuma 起来了但 OneBot 有问题，落到下面的通用告警。
    if (allowLaunch && state?.phase === 'done' && state?.ok === true && !state?.needsLogin && stateAge < 3 * 60_000) {
      log(`[snowluma] SnowLuma 已被自动拉起（${Math.round(stateAge / 1000)}s 前），等待 OneBot/WS 就绪——不弹窗`);
      return;
    }

    let message = String(reason || 'SnowLuma 连接断开').slice(0, 300);
    let recommendation = '启动或重启 SnowLuma（launcher.bat），确认 OneBot HTTP :3000 与 WS :3001 可用；恢复后会自动继续。';
    if (allowLaunch === false) {
      // 用户主动关了自动启动：这是唯一「必须用户动手」的情形，直说。
      message = 'SnowLuma 未运行，且「允许插件打开 SnowLuma」处于关闭状态';
      recommendation = '在 设置 → 维护 → SnowLuma 打开自动启动并保存（会自动拉起），或点概览「一键开始」手动启动。';
    } else if (state?.phase === 'done' && stateAge < 6 * 3600_000) {
      // 自愈试过了、失败了：弹真实原因（没装/路径不对/要扫码/启动报错），别再报 code=1006。
      if (state.needsLogin === true) {
        message = 'SnowLuma 已自动启动，但还没有登录 QQ：需要你扫码（只需一次）';
        recommendation = String(state.message || '').slice(0, 300) || '打开 SnowLuma 控制台扫码登录 QQ；登录后桥接会自动连上。';
      } else if (state.ok === false) {
        message = `SnowLuma 自动启动未成功：${String(state.error || state.message || '原因未知').slice(0, 240)}`;
        recommendation = '按上面的原因处理（常见：安装目录没指定 / QQ 没登录）；处理后系统会自动重试，不用重启 DSH。';
      }
      // ok===true 的成功态上面已经 return 了，这里只可能是 needsLogin/失败。
    }

    snowlumaHealth.downNotified = true;
    gateEvents.record({
      gate: 'snowluma',
      kind: 'fault',
      event: 'send-channel-down',
      action: 'blocked',
      reason: { code: 'SNOWLUMA_OFFLINE', message },
      impact: '当前无法把消息发到 QQ；通道恢复前会自动跳过主动唤醒，避免先生成后丢弃、白烧 token。',
      recommendation,
      confidence: 'confirmed',
      dedupeKey: 'snowluma:send-channel-down',
    });
    log(`❌ SnowLuma 发送通道不可用（已持续 ${Math.round((now - snowlumaHealth.downSince) / 1000)} 秒）：${message}`);
    log(`   处理：${recommendation}`);
  }

  function notifySendChannelUp() {
    snowlumaHealth.downSince = 0;
    if (snowlumaHealth.downTimer) {
      clearTimeout(snowlumaHealth.downTimer);
      snowlumaHealth.downTimer = null;
    }
    // 不管告警是否真的发过，都把“未处理”的断线事件确认掉：
    // 重连成功后用户明明连着，不该再被 L2 弹窗追着确认（2026-10-31 用户反馈）。
    try { gateEvents.ackByDedupe('snowluma:send-channel-down'); } catch {}
    if (!snowlumaHealth.downNotified) return;
    snowlumaHealth.downNotified = false;
    gateEvents.record({
      gate: 'snowluma',
      kind: 'fault',
      event: 'send-channel-restored',
      action: 'allowed',
      reason: { code: 'SNOWLUMA_RESTORED', message: 'SnowLuma 已重新连接' },
      impact: '发送通道恢复，自动唤醒可以继续。',
      recommendation: '无需操作。',
      confidence: 'confirmed',
      dedupeKey: 'snowluma:send-channel-restored',
    });
    log('✅ SnowLuma 发送通道已恢复，自动唤醒恢复。');
    try {
      for (const key of socialV2.conversations.keys()) {
        const st = getSocialV2State(key);
        st.sendFailureStreak = 0;
        st.wakeSuspendedUntil = 0;
        scheduleProactiveCheckV2(key);
      }
      flushSocialV2State();
    } catch (error) {
      log('[snowluma] 恢复唤醒调度失败：', String(error?.message ?? error).slice(0, 160));
    }
  }

  function noteSendSuccess(key) {
    snowlumaHealth.lastSendOkAt = Date.now();
    snowlumaHealth.lastSendError = '';
    try {
      const st = getSocialV2State(key);
      if (st.sendFailureStreak || st.wakeSuspendedUntil) {
        st.sendFailureStreak = 0;
        st.wakeSuspendedUntil = 0;
        flushSocialV2State();
        scheduleProactiveCheckV2(key);
      }
    } catch {}
  }

  function noteSendFailure(key, error) {
    // 发送守卫/审计拒绝不是通道故障，不能拿它们去暂停唤醒。
    if (/白名单|不在允许|审计|会话令牌|replyToMessageId|atUserId/.test(String(error?.message ?? error))) return;
    snowlumaHealth.lastSendFailAt = Date.now();
    snowlumaHealth.lastSendError = String(error?.message ?? error ?? '发送失败').slice(0, 200);
    try {
      const st = getSocialV2State(key);
      st.sendFailureStreak = Number(st.sendFailureStreak || 0) + 1;
      st.lastSendFailureAt = Date.now();
      if (st.sendFailureStreak === 1) {
        gateEvents.record({
          gate: 'snowluma',
          kind: 'fault',
          event: 'send-failed',
          action: 'blocked',
          subject: { key },
          reason: { code: 'SEND_FAILED', message: snowlumaHealth.lastSendError },
          impact: '这次生成的内容没有发到 QQ；如果继续自动唤醒，会重复消耗 token。',
          recommendation: '检查 SnowLuma/QQ 通道；连续 3 次失败会自动暂停自动唤醒。',
          confidence: 'confirmed',
          dedupeKey: `snowluma:send-failed:${key}`,
        });
      }
      if (st.sendFailureStreak >= 3 && !(Number(st.wakeSuspendedUntil) > Date.now())) {
        st.wakeSuspendedUntil = Date.now() + SEND_CHANNEL_SUSPEND_MS;
        gateEvents.record({
          gate: 'snowluma',
          kind: 'fault',
          event: 'wake-suspended-after-send-failures',
          action: 'blocked',
          subject: { key },
          reason: { code: 'SEND_FAILURE_STREAK', message: `连续 ${st.sendFailureStreak} 次发送失败` },
          impact: '该会话的自动唤醒已暂停 30 分钟，避免继续先生成后丢弃、白烧 token。',
          recommendation: '检查 SnowLuma/QQ 通道；恢复或收到新消息后会自动解除。',
          confidence: 'confirmed',
          dedupeKey: `snowluma:send-fail:${key}`,
        });
        log(`⏸️ ${key} 连续 ${st.sendFailureStreak} 次发送失败；自动唤醒暂停 30 分钟，避免空烧。`);
      }
      flushSocialV2State();
    } catch {}
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /**
   * 记录 QQ 账号上下线（heartbeat / bot_status / get_status 三个来源共用）。
   *
   * 为什么在这里做「上线补历史」：桥接/QQ 掉线期间的消息不会由 SnowLuma 补发，
   * 只有账号重新上线这一刻才知道「离线窗口结束了」。边沿触发（false/null → true），
   * 心跳每 30 秒重复报 online 时不会重复补。
   */
  function setAccountOnline(online, source) {
    if (typeof online !== 'boolean') return;
    const wasOnline = snowlumaHealth.accountOnline === true;
    snowlumaHealth.accountOnline = online;
    if (online && !wasOnline) {
      if (historyCatchUpConfig().enabled && currentMode === 'reserved2') {
        log(`[history] QQ 账号会话已上线（${source}），检查离线期间的历史消息`);
        void runHistoryCatchUp(`online:${source}`).catch((error) => log(`[history] 上线补历史异常：${error?.message ?? error}`));
      }
    }
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      everConnected: snowlumaHealth.everConnected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    // 兜底：SDK 在升级被拒等场景下可能只静默重试、不再 emit close，
    // 光等 close 会漏掉「网关已死」；30 秒一轮的探活同样参与「持续不可达」判定。
    if (!snap.connected) notifySendChannelDown(snowlumaHealth.downReason || 'SnowLuma 未连接');
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') setAccountOnline(body.data.online, 'get_status');
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    embeddedTimers.push(setTimeout(() => { if (!shuttingDown) void pollSnowlumaStatus(); }, 5000));
    embeddedTimers.push(setInterval(() => { if (!shuttingDown) void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS));
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    embeddedTimers.push(setInterval(() => { if (!shuttingDown) reportSnowlumaHealth(); }, 30_000));
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken(STATE_DIR);
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    // 不打印令牌任何片段：控制台令牌能读聊天记录、发消息、改配置，
    // 前缀同样是凭据的一部分（CWE-532）。日志只需说明「已生成、去哪取」。
    if (!configuredToken) log('控制台未配置 consoleToken，已自动生成（完整值保存在 state/console-token）');
    // 二代会话级隔离用的令牌校验已上提到 main() 作用域（见 socialV2 声明处），
    // 这里直接复用；控制台/管理端请求不带 x-agent-token，仍走 consoleToken 管理通道。

    // 协议邻近的 8 个端点（图片查询/桌宠代发/统一发送/会话与工作区重置/重启/记忆卡告警）
    // 已迁到 src/qq/features/protocol-routes.js。运行时状态仍只保留在本闭包一份，
    // 这里注入引用与 getter；分发顺序与全局闸门保持原样。
    const protocolRoutes = createProtocolRoutes({
      log,
      getConfig: () => cfg,
      getMode: () => currentMode,
      agentTokenOk,
      v2ToolEnabled,
      modeAllowed,
      findMessageMedia,
      fetchMediaData,
      sendToQQ,
      lastSendSucceeded,
      scheduleSocialReply,
      ownerMessageTag,
      resolveReplyTargetV2,
      sendMessagesV2,
      recordSentMessagesV2,
      sendRateLimitInfo,
      reportLimitEvent,
      shouldBlockSilentReply,
      getSocialV2State,
      saveSocialV2State,
      appendActivity,
      scheduleReplyCheckV2,
      cancelPendingEntry,
      drainPromptQueue,
      drainAllPromptQueues,
      cancelSocialTimers,
      cancelAllSocialTimers,
      clearSocialV2Timers,
      clearAllSocialV2Timers,
      slang,
      forgetAgentToken,
      flushSocialV2State,
      saveState,
      api,
      withTimeout,
      unwrap,
      onebotSend,
      releaseLock,
      auditOwner,
      DSH_CONTROL_TIMEOUT_MS,
      SEND_TIMEOUT_MS,
      embed,
      getEmbeddedRuntime: () => embeddedRuntime,
      state,
      social,
      socialV2,
      pending,
      queued,
      queuedHintAt,
      sessionPromises,
      messageMediaStore,
      seenForwardIds,
      modelAppliedSessions,
      reverse,
      collectors,
      sendToolSucceededSessions,
      pendingSendToolCalls,
      v2TurnStartAt,
      turnLeaseNoted,
      toolCallNames,
      pendingWakeKeys,
      wakeConfigUpdatedKeys,
      markReadCalledKeys,
      wakeConfigMissCount,
      CONVERSATION_TOKENS,
      KNOWN_AGENT_TOKENS,
      memoryCardNotifyAt,
      bumpSessionEpoch: () => { sessionEpoch++; },
      SENSITIVE_RE,
      ILLEGAL_CONTENT_RE,
      unquoteJsonString,
      STATE_DIR,
      ACTIVITY_LOG,
    });

    // 一代社交 / 测试发送 / 后台提醒（控制台自用）已迁到 social-legacy.js。
    const socialLegacyRoutes = createSocialLegacyRoutes({
      log,
      getConfig: () => cfg,
      getMode: () => currentMode,
      modeAllowed,
      allowed,
      onebotSend,
      withTimeout,
      SEND_TIMEOUT_MS,
      SENSITIVE_RE,
      CONFIG_FILE,
      readConfigObject,
      atomicWriteJson,
      social,
      state,
      enterActive,
      leaveActive,
      flushSummaries,
      getDshReady: () => dshReady,
      readRoleState,
      getSocialV2State,
      ensureSession,
      deliverPrompt,
      appendActivity,
    });

    // 控制台管理端点（会话/挂起/白名单/模型/安全）已迁到 console-admin.js。
    const consoleAdminRoutes = createConsoleAdminRoutes({
      log,
      getConfig: () => cfg,
      state,
      pending,
      CONFIG_FILE,
      readConfigObject,
      atomicWriteJson,
      normalizeOwnerQQ,
      normalizeAllowlist,
      getSelfUserId: () => selfUserId,
      reconcileSessionPolicies,
      fetchModelCatalog,
      withTimeout,
      unwrap,
      REASONING_EFFORT_OPTIONS,
      REASONING_EFFORT_DEFAULT,
      normalizeReasoningEffort,
      bumpModelSelectionEpoch: () => { modelSelectionEpoch += 1; },
      STATE_DIR,
      getStateDirHardened: () => stateDirHardened,
      rehardenStateDir: () => {
        stateDirHardened = null;
        hardenStateDirAcl();
        return stateDirHardened;
      },
      manualDirCommand,
    });

    // 二代管理 / AI 工具端点（重置、语音、黑话、旧读授权）已迁到 v2-admin.js。
    const v2AdminRoutes = createV2AdminRoutes({
      log,
      getConfig: () => cfg,
      getMode: () => currentMode,
      modeAllowed,
      agentTokenOk,
      v2SessionAllowed,
      v2ToolEnabled,
      shouldBlockSilentReply,
      voice,
      auditOwner,
      fishGuardSendBlock,
      tokenGuardSendBlock,
      getSocialV2State,
      bumpSessionEpoch: () => { sessionEpoch += 1; },
      sessionPromises,
      clearAllSocialV2Timers,
      drainAllPromptQueues,
      socialV2,
      state,
      stopRetiredSessionWork,
      sessionModels,
      modelAppliedSessions,
      reverse,
      collectors,
      v2TurnStartAt,
      turnLeaseNoted,
      toolCallNames,
      pendingSendToolCalls,
      sendToolSucceededSessions,
      api,
      forgetAgentToken,
      seenForwardIds,
      saveState,
      pendingWakeKeys,
      clearAllPendingWakeLeases,
      wakeConfigUpdatedKeys,
      markReadCalledKeys,
      wakeConfigMissCount,
      cancelSocialV2PendingSave,
      atomicWriteJson,
      SOCIAL_V2_FILE,
      slang,
      appendActivity,
      redactKnownTokensOnly,
      inspectAudio,
      describeAudio,
      listAudioFiles,
    });

    // 控制台核心端点（运行状态/模式切换/访问令牌/审计读取）已迁到 console-core-routes.js。
    const consoleCoreRoutes = createConsoleCoreRoutes({
      log,
      getConfig: () => cfg,
      getMode: () => currentMode,
      setMode: (mode) => { currentMode = mode; lastMode = mode; },
      getClosedAgentPreset: () => closedAgentPreset,
      setClosedAgentPreset: (value) => { closedAgentPreset = value; },
      getConsoleToken: () => consoleToken,
      setConsoleToken: (value) => { consoleToken = value; },
      VALID_MODES,
      normalizeModeInput,
      readJsonSafe,
      atomicWriteJson,
      atomicWriteText,
      CONFIG_FILE,
      STATE_DIR,
      MODE_FILE: path.join(STATE_DIR, 'mode.json'),
      CONSOLE_TOKEN_FILE: path.join(STATE_DIR, 'console-token'),
      readConfigObject,
      crypto,
      readRoleState,
      getDshReady: () => dshReady,
      ROOT,
      ownerAudit,
      purpose,
      closureConfigV2,
      assessClosureV2,
      getSocialV2State,
      closureStatus,
      snowlumaHealthSnapshot,
      readActivityTail,
      socialV2,
      api,
      unwrap,
      cleanupSocialForModeChange,
      clearAllSocialV2Timers,
      drainAllPromptQueues,
      reconcileSessionPolicies,
      setupSleepTimerV2,
      scheduleProactiveCheckV2,
    });

    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      })();
      if (consoleToken && !tokenMatches) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1；带了令牌就必须命中某个活跃会话，
      // 端点自己漏写校验也不会退回管理端。
      //
      // 但「没带令牌」的智能体调用不能一律拒绝：closed-agent（管理员私聊）模式下模型
      // 本来就**没有**会话令牌（令牌只在 reserved2 的唤醒提示里下发），而 qq_send_group_message
      // / qq_list_groups 等工具必须在这个模式里可用（工具描述写的也是"closed-agent 模式不需要"）。
      // 这些端点各自按模式判定（/api/send/* 只在 closed-agent 放行；/api/images/* 在 reserved2
      // 强制要令牌；/api/status 对智能体调用只回最小对象），所以这里把「无令牌智能体调用」
      // 限制到这条非 v2 会话面；整个 /api/socialV2/ 前缀一概不放——那里的 token 校验全是
      // `if (x-agent-token && …)`，放进来就等于退化成管理端全权（confused deputy）。
      if (req.headers['x-agent-call'] !== undefined) {
        const agentToken = req.headers['x-agent-token'];
        const hasToken = typeof agentToken === 'string' && agentToken !== '';
        if (hasToken && !isLiveAgentToken(agentToken)) {
          sendJson({ ok: false, error: '未授权：智能体调用携带的会话令牌无效' }, 403);
          return;
        }
        if (!hasToken) {
          const tokenlessAgentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/');
          if (!tokenlessAgentAllowed) {
            sendJson({ ok: false, error: '未授权：该接口的智能体调用必须携带有效的会话令牌' }, 403);
            return;
          }
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        // /api/socialV2/initial-prompt 也在这里：它是操作者写给 AI 的"环境背景"，
        // 让 AI 自己读/改等于把控制台的管理输入（以及未来可能写入的其它群信息）交给会话主体。
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/initial-prompt', '/api/socialV2/history-catchup'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          // 审计读取只给控制台：agent token 明确拒绝（即使以后白名单改宽也不放行）。
          if (url.pathname === '/api/owner-audit') {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        // 只读降级：黑话库/表情库在启动时加载失败时，写接口必须**明确失败**。
        // 旧行为是 save 函数里只打一行日志就 return，而接口照样回 {ok:true}：
        // 控制台显示"✅ 已保存"，实际只改在内存里，重启后全部消失。
        if (req.method !== 'GET') {
          const readonlyStore = (!slang.writable() && (url.pathname === '/api/slang'
            || url.pathname === '/api/slang/clear'
            || url.pathname === '/api/slang/extract'
            || url.pathname === '/api/slang/research'
            || url.pathname.startsWith('/api/slang/batch-')
            || url.pathname === '/api/socialV2/slang/submit')) ? '黑话库'
            : (!stickers.writable() && (url.pathname === '/api/stickers/sync'
              || url.pathname === '/api/stickers/note'
              || url.pathname === '/api/stickers/remark'
              || url.pathname === '/api/socialV2/sticker-note'
              || url.pathname === '/api/socialV2/sticker-remark'
              || url.pathname === '/api/socialV2/collect-sticker')) ? '表情库'
              : '';
          if (readonlyStore) {
            sendJson({ ok: false, error: `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接` }, 503);
            return;
          }
        }
        // 组件路由：注册表里的功能自带路由表（见 src/qq/core/registry.js）。
        // 放在全局鉴权/CSRF/只读降级之后，保证组件不会绕过这些闸门。
        if (await qqRegistry.dispatchHttp(req, res, url, { sendJson, readBody })) return;
        if (req.method === 'GET' && url.pathname === '/') {
          // 嵌入 DSH 时没有「独立控制台」：这里只留内部 API，页面一律 404。
          if (embed) { sendJson({ ok: false, error: 'not found' }, 404); return; }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        // 运行状态 / 模式切换 / 访问令牌 / 审计读取已迁到 console-core-routes.js，
        // 在下方统一分发（路径与其它模块互不重叠）。
        // B站接口已迁到组件：/api/bili/*（src/qq/features/bilibili.js）
        // /api/presets 已迁到 src/qq/features/role-console.js
        // 人格 / 预设接口已迁到 src/qq/features/role-console.js（注册表分发）

        // 会话/挂起/白名单/DSH 模型与思考强度/安全设置已迁到 console-admin.js，
        // 在下方统一分发（路径互不重叠）。
        // 控制台访问令牌已迁到 console-core-routes.js（随上面的 dispatch 一起分发）。
        // 测试发送 / 一代社交配置 / 后台提醒已迁到 src/qq/features/social-legacy.js，
        // 在下方统一分发（路径互不重叠）。早安试发见 morning-greeting.js，目的机制见 purpose.js。
        // 二代状态重置 / 语音发送 / 语音库 / 黑话 / 旧读授权已迁到 v2-admin.js，
        // 在下方统一分发（路径互不重叠）。
        // 控制台核心端点（状态/模式/访问令牌/审计）
        if (await consoleCoreRoutes.dispatch(req, res, url, sendJson, readBody)) return;
        // 一代社交 / 测试发送 / 后台提醒（控制台自用）
        if (await socialLegacyRoutes.dispatch(req, res, url, sendJson, readBody)) return;
        // 控制台管理端点（会话/挂起/白名单/模型/安全）
        if (await consoleAdminRoutes.dispatch(req, res, url, sendJson, readBody)) return;
        // 二代管理 / AI 工具端点（重置/语音/黑话/旧读授权）
        if (await v2AdminRoutes.dispatch(req, res, url, sendJson, readBody)) return;

        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (await protocolRoutes.handleImagesMessage(req, res, url, sendJson, readBody)) return;

        // ── 桌宠挂件代主人发消息（控制台令牌鉴权，只允许主人私聊） ──────────────
        if (await protocolRoutes.handlePetQqSend(req, res, url, sendJson, readBody)) return;

        // ── 桌宠输入 → 当成「主人刚在 QQ 说了这句话」，走 agent 管线 ──────────────
        // 关键：这条和她真正收到 QQ 消息是同一套上下文/记忆/会话记录，
        // 她的回复再由 agent 正常发回 QQ，桌宠那边通过 mirror 看到 —— 不再另起一套对话。
        if (await protocolRoutes.handlePetOwnerMessage(req, res, url, sendJson, readBody)) return;

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (await protocolRoutes.handleSend(req, res, url, sendJson, readBody)) return;
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (await protocolRoutes.handleSessionReset(req, res, url, sendJson, readBody)) return;
        if (await protocolRoutes.handleWorkspaceReset(req, res, url, sendJson, readBody)) return;
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (await protocolRoutes.handleRestart(req, res, url, sendJson, readBody)) return;
        // ── 记忆卡容量告警：只私聊管理员本人，不发群、不接受任意收件人 ──────────
        if (await protocolRoutes.handleMemoryCardNotify(req, res, url, sendJson, readBody)) return;
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(embed
        ? `内嵌桥接 API 已启动（随 DSH 进程）：http://127.0.0.1:${port}`
        : `本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：独立进程以 exit 2 退出；嵌入模式只记录，绝不退出 DSH。
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        if (embed) {
          embeddedRuntime = { ...(embeddedRuntime ?? {}), error: `控制台端口 ${port} 已被占用（已有独立 bridge 在运行？）` };
          return;
        }
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      if (embed) return;
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  /**
   * 群聊出站兜底脱敏（实现见 src/redact-paths.mjs，可单测）。
   * 2026-11 真实事故：表情 Markdown 图片行降级成文字发进群，公开了
   * `C:\Users\<用户名>\...`。图片行本身已在 splitMarkdownImages 里被剥离；
   * 这里再兜一层，防止模型/工具把路径写进普通文本。
   */


  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）
  // 鱼群保护的两张运行时表（提前初始化：sendToQQ 可能在后面的状态机建立前被调用）。
  const fishGroupNames = new Map(); // groupId -> group_name（'' = 查不到）
  const fishChatWindows = new Map(); // groupId -> [{sender,userId,time,isSelf,isOwner,fish}]

  /**
   * 把 QQ 私聊消息镜像给桌宠挂件（SurfCore pet-api）。
   * 只做旁路通知：读 host.json 拿地址/令牌，失败静默 —— 挂件没开不影响 QQ。
   */
  function mirrorPetMessage(payload) {
    // 情绪状态：私聊里主人说话 / 她回了话都记一笔，桌宠和 QQ 读同一份心情。
    try {
      const key = String(payload?.key || '');
      const ownerKey = cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';
      if (payload?.role === 'assistant') notePersonaActivity({ kind: 'reply' });
      else notePersonaActivity({ kind: ownerKey && key === ownerKey ? 'owner' : 'contact' });
    } catch { /* 状态写失败不影响消息镜像 */ }
    try {
      // host.json 由插件侧（pet-api）写进**数据根**的 pet/（$DSH_HOME/surfcore/qq/pet）。
      // 兼容两种旧位置：clone 安装的仓库根 pet/、2026-11-04 之前合体层的 $DSH_HOME/surfcore/pet。
      const candidates = [
        path.join(QQ_PET_DIR, 'host.json'),
        path.join(ROOT, 'pet', 'host.json'),
        path.join(DSH_HOME, 'surfcore', 'pet', 'host.json'),
      ];
      let host = null;
      for (const file of candidates) {
        try {
          host = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (host?.baseUrl && host?.token) break;
          host = null;
        } catch {}
      }
      if (!host?.baseUrl || !host?.token) return;
      const url = `${String(host.baseUrl).replace(/\/+$/, '')}${host.api || '/dsh-surfcore/pet-api'}/qq/incoming`;
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pet-token': String(host.token) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
    } catch {}
  }

  // 大肥鱼表情包：回复后按配置自动补一张（内置版专用；配置在 qq 配置的 stickers 段）
  let nekoStickers = null;
  async function sendNekoAfterReply(key, text) {
    try {
      const nowCfg = loadConfig();
      const stickerCfg = nowCfg.stickers ?? {};
      if (stickerCfg.enabled === false) return;   // 默认开；面板里可关
      // 本轮回复里已经有表情插件（dsh-nekowhale-stickers）的 Markdown 图 → 自动配图让位，避免两张
      if (hasMarkdownImage(text)) return;
      // 模型自己写了 [sticker:名字]：sendToQQ 会按标记补发真图，这里别再自动补第二张
      if (hasStickerTag(text)) return;
      if (!/^(private|group):\d{5,15}$/.test(String(key ?? ''))) return;
      nekoStickers ||= createNekoStickers({ dir: path.join(STATE_DIR, 'nekowhale-cache'), log });
      const result = await nekoStickers.afterReply({
        key,
        text: String(text ?? ''),
        httpUrl: nowCfg.snowluma?.httpUrl,
        token: nowCfg.snowluma?.accessToken,
        // 显式传 enabled：旧版 kit 模块里写的是 `enabled !== true` 才发，默认配置不写该键会被误拦。
        config: { ...stickerCfg, enabled: stickerCfg.enabled !== false },
      });
      if (result) log(`[neko] 已补一张表情：${result.name}（${result.emotion || '无情绪'}）`);
    } catch (error) {
      log(`[neko] 表情补发失败：${error?.message ?? error}`);
    }
  }

  // ── 活人感：兜底清洗 + 打字刹车（内置版第一阶段）──────────────────────
  const burstCancelAt = new Map();
  const incomingSeq = new Map();   // 每个会话收到消息的序号（判断「生成期间对方又说话了」）
  const turnIncomingSeqByKey = new Map();
  const lastUserText = new Map();
  const lastSenderLabel = new Map();
  // 每个会话的人设/记忆只注入一次（会话里已有历史），避免每轮重复塞几千字导致上下文爆炸
  const contextPrimed = new Map(); // key -> 注入时间
  let humanizeGateInstance = null;
  function humanizeGate() {
    humanizeGateInstance ||= createHumanizeGate({ tokenUsageFile: path.join(SURFCORE_DIR, 'token-usage-daily.json'), scope: 'qq', log });
    return humanizeGateInstance;
  }
  // 成熟表情插件（dsh-nekowhale-stickers）返回的是 Markdown 图片行：
  // ![](http://127.0.0.1:<port>/s/<hash>.gif) 或本地文件路径。桥接把它转成 QQ 图片段发出。
  //
  // 另外：模型有时会自己写 `[sticker:委屈]` 这种「回复标记」（外部表情插件的约定），
  // 桥接原来的发送链不认它，原样发到 QQ 就是一段乱码文字。这里统一剥出来，
  // 能匹配到大肥鱼表情就补发一张真图；匹配不到就只删标记，绝不把标记当正文发出去。
  // 具体规则在 outbound-reply.mjs，这里只保留本进程内的调用别名。
  const takeStickerRefs = takeStickerTags;
  async function sendStickerRef(key, ref) {
    try {
      if (!/^(private|group):\d{5,15}$/.test(String(key ?? ''))) return;
      nekoStickers ||= createNekoStickers({ dir: path.join(STATE_DIR, 'nekowhale-cache'), log });
      const stickerCfg = loadConfig().stickers ?? {};
      // enabled 只关「回复后自动补一张」；标记兜底是模型主动发的，只受间隔/每小时上限约束
      if (!nekoStickers.canSend({ ...stickerCfg, enabled: true })) {
        log(`[neko] 表情已达限额（最小间隔/每小时上限），「${ref}」不发`);
        return;
      }
      const item = await nekoStickers.pick(ref, { minScore: 1 });
      if (!item) {
        log(`[neko] 标记「${ref}」没匹配到表情，只删标记`);
        return;
      }
      const file = await nekoStickers.download(item);
      await sendMarkdownImage(key, `file:///${String(file).replace(/\\/g, '/')}`);
      nekoStickers.markSent();
      nekoStickers.markRecent(item.id);
      noteSendSuccess(key);
      log(`[neko] 按标记补发表情：${item.name}（${ref}）`);
    } catch (error) {
      log(`[neko] 按标记发表情失败：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  async function sendMarkdownImage(key, rawUrl) {
    const [kind, id] = String(key ?? '').split(':');
    if (!['private', 'group'].includes(kind) || !/^\d{5,15}$/.test(String(id ?? ''))) throw new Error('未知会话');
    let bytes;
    let stickerSent = false;
    if (/^https?:\/\//i.test(rawUrl)) {
      const url = new URL(rawUrl);
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) throw new Error('只允许本机图片地址');
      const res = await fetch(rawUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } else if (/^dshsticker:/i.test(String(rawUrl))) {
      // 表情工具返回的是「不含路径的引用」（dshsticker:<文件名>），避免把 C:\Users\… 这类
      // 本机路径写进 Markdown —— 一旦降级成文字发出去就是隐私泄漏（2026-11 真实事故）。
      const name = decodeURIComponent(String(rawUrl).slice('dshsticker:'.length)).replace(/[\\/]/g, '');
      if (!name) throw new Error('表情引用为空');
      // 与自动补发、[sticker:] 兜底、抖音共用同一份限额：模型主动发也算在「每小时最多」里
      // enabled 只关自动补发，这里不挡主动发图
      nekoStickers ||= createNekoStickers({ dir: path.join(STATE_DIR, 'nekowhale-cache'), log });
      const stickerCfg = loadConfig().stickers ?? {};
      if (!nekoStickers.canSend({ ...stickerCfg, enabled: true })) {
        log(`[neko] 表情已达限额（最小间隔/每小时上限），工具表情 ${name} 跳过`);
        return;
      }
      const candidates = [
        path.join(SURFCORE_DIR, 'nekowhale-cache', 'nekowhale', 'gif', name),
        path.join(STATE_DIR, 'nekowhale-cache', 'nekowhale', 'gif', name),
      ];
      let found = '';
      for (const candidate of candidates) {
        try { if (fs.statSync(candidate).isFile()) { found = candidate; break; } } catch { /* 继续找下一处 */ }
      }
      if (!found) throw new Error(`表情文件不存在：${name}`);
      bytes = fs.readFileSync(found);
      stickerSent = true;
    } else {
      const file = rawUrl.startsWith('file://') ? new URL(rawUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1') : rawUrl;
      bytes = fs.readFileSync(file);
    }
    if (!bytes?.length) return;
    if (bytes.length > 8 * 1024 * 1024) throw new Error('图片超过 8MB');
    const segment = { type: 'image', data: { file: 'base64://' + bytes.toString('base64') } };
    if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), [segment]), SEND_TIMEOUT_MS, `QQ图片 ${key}`);
    else await withTimeout(bot.sendGroupMessage(Number(id), [segment]), SEND_TIMEOUT_MS, `QQ图片 ${key}`);
    if (stickerSent) nekoStickers?.markSent();
    noteSendSuccess(key);
  }

  // 群聊回复上限：真人接话中位数 15 字、75% 在 30 字以内。超过 80 字基本就是
  // 一屏小作文，在群里特别显眼；实际截断逻辑在 outbound-reply.mjs 的 capText。
  const GROUP_REPLY_MAX = 80;
  const capGroupReply = (text) => capText(text, GROUP_REPLY_MAX, { collapseLines: true });

  function sendToQQ(key, msg, opts = {}) {
    const burstStartedAt = Date.now();
    const [kind, id] = key.split(':');
    const isGroup = kind === 'group';
    // 所有出站文本走同一个管道（抽表情标记 / 归一全角 Markdown / 去 AI 味 / 限长 / 脱敏）。
    // 入口只负责「怎么发」，不再各写一份清洗 —— 以前 QQ 修了、抖音漏了就是这么来的。
    const prepared = prepareReply(msg, {
      platform: 'qq',
      group: isGroup,
      cleanClutter: cfg.humanize?.cleanReply !== false,
      maxChars: opts.groupCap && isGroup ? GROUP_REPLY_MAX : 0,
      stripPaths: isGroup,
      transform: redactKnownTokensOnly,
    });
    const stickerRef = prepared.stickerRefs[0] || '';
    const assertSendAllowed = captureSendGuard(key);
    // 群聊是公开场合：出站文本再兜一层本机路径脱敏（图片行已在上面被剥离）。
    const beforeRedact = prepared.text;
    const safeMsg = isGroup ? redactLocalPaths(beforeRedact) : beforeRedact;
    if (isGroup && safeMsg !== beforeRedact) {
      logThrottled('privacy:group-path', 60_000, `[privacy] 群聊出站文本含本机路径/文件 URL，已脱敏 (${key})`);
    }
    if (isGroup) recordFishWindow(key, '我', selfUserId, { isSelf: true });
    const parts = splitForQQ(safeMsg);
    // 语料回流：只记**真正发出**的文本，且在发送成功之后记账。以前在发送前整条记账，
    // 被刹车作废的分段、发送失败的、系统通知（recordCorpus:false）都会配上历史用户消息
    // 学进语料——「他：A / 你：<从没说过的话>」（2026-11-14 体检，与旁白回流同类）。
    const recordCorpus = opts.recordCorpus !== false;
    const sentParts = [];
    lastSendFailed.delete(key);
    let partIndex = 0;
    for (const part of parts) {
      // 第一段永远发出去：对方在你「话说到一半」时插话，只作废后面的分段，
      // 不能把整条回复全丢掉 —— 否则就是「谁都没回」的空档（humanize 竞态）。
      const isFirstPart = partIndex++ === 0;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          const cancelAt = burstCancelAt.get(key);
          if (!isFirstPart && cfg.humanize?.burstBrake !== false && cancelAt && cancelAt > burstStartedAt) { log(`[humanize] 对方又说话了，剩余分段不发 (${key})`); return; }
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), sdkText(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), sdkText(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sentParts.push(part);
          noteSendSuccess(key);
          if (opts.mirror !== false && kind === 'private') mirrorPetMessage({ role: 'assistant', key, sender: '', text: part });
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          noteSendFailure(key, error);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    if (prepared.images.length) {
      sendChain = sendChain.then(async () => {
        for (const image of prepared.images) {
          try {
            await sendMarkdownImage(key, image);
          } catch (error) {
            log(`[表情] 图片发送失败 (${key})：${String(error?.message ?? error).slice(0, 120)}`);
          }
        }
      });
    }
    if (stickerRef) {
      sendChain = sendChain.then(() => sendStickerRef(key, stickerRef));
    }
    // 返回「本批是否全部发送成功」。调用方（例如 B站动态同步）需要据此决定
    // 能不能把这条内容标记为已推送 —— 以前返回 void，发送失败也会被当成成功，
    // 于是动态永久丢失且日志还写「已同步」。
    return sendChain.then(() => {
      if (recordCorpus && sentParts.length) recordReply(key, sentParts.join(' '));
      return lastSendFailed.get(key) !== true;
    });
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax, opts = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    const burstStartedAt = Date.now();
    // 分条回复里的表情包也是 Markdown 图片行（插件 sticker_send 返回）。
    // sendToQQ 会把它拆成图片段，但这里以前原样当文字发 —— 群里就出现
    // 「![名字](C:\...\xxx.gif)」这样一整行乱码文字。先统一抽取：文本走分条，
    // 图片在文本之后按顺序补发。
    lastSendFailed.delete(key); // 清掉上一轮的失败残留（否则本轮成功也被判失败）
    const pendingImages = [];
    const pendingStickerRefs = [];
    const cleaned = [];
    for (const raw of messages) {
      const prepared = prepareReply(raw, {
        platform: 'qq',
        group: kind === 'group',
        cleanClutter: cfg.humanize?.cleanReply !== false,
        maxChars: kind === 'group' ? GROUP_REPLY_MAX : 0,
        stripPaths: kind === 'group',
        transform: redactKnownTokensOnly,
      });
      if (prepared.stickerRefs.length) pendingStickerRefs.push(prepared.stickerRefs[0]);
      if (prepared.text) cleaned.push(prepared.text);
      if (prepared.images.length) pendingImages.push(...prepared.images);
    }
    // 语料回流：与 sendToQQ 同口径——只记真正发出的分段，发送后记账
    const recordCorpus = opts.recordCorpus !== false;
    const sentParts = [];
    for (let i = 0; i < cleaned.length; i++) {
      const msg = cleaned[i];
      const isLast = i === cleaned.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          // 分段刹车：分条发到一半对方又说话了，剩下的不发（与 sendToQQ 同一口径）
          if (i > 0 && cfg.humanize?.burstBrake !== false) {
            const cancelAt = burstCancelAt.get(key);
            if (cancelAt && cancelAt > burstStartedAt) {
              log(`[humanize] 对方又说话了，剩余分段不发 (${key})`);
              return;
            }
          }
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), sdkText(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), sdkText(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sentParts.push(msg);
          noteSendSuccess(key);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    // 文本发完后补发表情/图片（纯表情回复也能发出去）。
    if (pendingImages.length) {
      sendChain = sendChain.then(async () => {
        for (const image of pendingImages) {
          try {
            await sendMarkdownImage(key, image);
            noteSendSuccess(key);
          } catch (error) {
            log(`[表情] 图片发送失败 (${key})：${String(error?.message ?? error).slice(0, 120)}`);
            lastSendFailed.set(key, true);
          }
        }
      });
    }
    if (pendingStickerRefs.length) {
      sendChain = sendChain.then(() => sendStickerRef(key, pendingStickerRefs[0]));
    }
    return sendChain.then(() => {
      if (recordCorpus && sentParts.length) recordReply(key, sentParts.join(' '));
      return sent;
    });
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    if (ILLEGAL_CONTENT_RE.test(rawMessage)) {
      log(`发送内容命中违规黑名单，已阻止发送 (${kind}:${id})`);
      appendActivity(`${kind}:${id} [guard] 发送被拦截（内容命中违规黑名单，未发出）`);
      throw new Error('发送内容命中违规关键词黑名单，已阻止发送');
    }
    // 群聊公开场合：统一发送端点（MCP 发送工具 / 旧发送工具都走这里）也要做本机路径脱敏。
    const outgoing = kind === 'group' ? redactLocalPaths(rawMessage) : rawMessage;
    segments.push({ type: 'text', data: { text: escapeCqText(outgoing) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const sendKey = `${kind}:${id}`;
    let res;
    try {
      res = await fetch(`${httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      noteSendFailure(sendKey, error);
      throw error;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      const error = new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
      noteSendFailure(sendKey, error);
      throw error;
    }
    noteSendSuccess(sendKey);
    // 私聊回复也镜像给桌宠（模型回复多走 /api/send/*，不一定经过 sendToQQ）
    if (kind === 'private') mirrorPetMessage({ role: 'assistant', key: sendKey, sender: '', text: rawMessage });
    return body.data;
  }

  // 直接发任意 OneBot 消息段（卡片/分享卡用）。文本发送仍走 sendToQQ，
  // 这样限速、审计和会话守卫不被绕过。
  async function onebotSendSegments(kind, id, segments) {
    if (!Array.isArray(segments) || !segments.length) throw new Error('消息段为空');
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
    }
    return body.data;
  }

  // B站视频卡片：默认发 com.tencent.structmsg 新闻链接卡（普通分享卡，点开进 B站）。
  // 为什么不再默认走小程序：QQ 侧 B站小程序（appid 1109937557）已下架，点卡片提示
  // 「小程序已下架」，而 appid 写死在 SnowLuma 的 get_mini_app_ark 里，桥接改不了。
  // `share.cardMode = 'miniapp'` 仍可手动切回（确认小程序恢复后再说）。
  // 返回 true 表示至少有卡片发出去了，调用方就不用再让 AI 在正文里发链接。
  const sendBiliCard = createBiliCardSender({
    getShare: () => cfg.biliBridge?.share ?? {},
    fetchVideoInfo,
    // 仅 miniapp 模式会用到：调 SnowLuma 的小程序 ARK。
    requestMiniArk: async ({ title, desc, picUrl, jumpUrl }) => {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_mini_app_ark`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ type: 'bili', title, desc, picUrl, jumpUrl }),
        signal: AbortSignal.timeout(20000)
      });
      const body = await res.json().catch(() => ({}));
      const data = body?.data?.data;
      if (body?.status !== 'ok' || body?.retcode !== 0 || !data?.app || !data?.meta) {
        throw new Error(body?.wording || `get_mini_app_ark 返回异常（${body?.retcode ?? res.status}）`);
      }
      return data;
    },
    sendGroupSegments: (id, segments) => onebotSendSegments('group', id, segments),
    log,
  });

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  const { maxBytes: MAX_MEDIA_BYTES, maxCount: MAX_MEDIA_COUNT, maxPixels: MAX_MEDIA_PIXELS } = resolveMediaLimits(cfg);
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长
  const isSafeLocalMediaPath = (filePath) => isSafeLocalMediaPathImpl(filePath, cfg.snowluma?.homeDir);
  const acceptImageBuffer = (buf, label = '图片') => acceptImageBufferImpl(buf, label, { maxPixels: MAX_MEDIA_PIXELS, log });

  async function fetchOneBotImage(media) {
    // 表情包（市场/收藏表情）优先走 CDN：get_image 对市场表情必然失败
    // （SnowLuma 缓存里没有该文件），先试 URL 能省一次失败往返，也更可靠。
    const emojiId = String(media.emojiId || emojiIdFromFileName(media.file) || '');
    const isSticker = media.kind === 'sticker' || !!emojiId || String(media.subType || '') === '1';
    const label = isSticker ? '表情' : '图片';
    const failures = [];
    const urls = [];
    const pushUrl = (raw) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || urls.includes(s)) return;
      urls.push(s);
    };
    pushUrl(media.url);
    for (const candidate of emojiCdnCandidates(emojiId)) pushUrl(candidate);

    const tryUrls = async () => {
      for (const url of urls) {
        try {
          const fetched = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
          const accepted = acceptImageBuffer(fetched.buffer, `${label} URL `);
          if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(url) };
          failures.push(`${url} 不是有效图片`);
        } catch (error) {
          failures.push(`${url}: ${error?.message ?? error}`);
        }
      }
      return null;
    };
    // 只有 file 是安全缓存文件名时才允许交给网关（防任意路径/内网 URL 注入）。
    const tryGetImage = async () => {
      if (!(media.kind === 'image' || media.kind === 'sticker')) return null;
      if (!media.file || !isProbablySafeImageFileRef(media.file)) return null;
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const accepted = acceptImageBuffer(Buffer.from(base64, 'base64'), 'get_image 返回的图片');
            if (accepted) return accepted;
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          try {
            const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, 'get_image URL 图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(obj.url) };
          } catch (error) {
            failures.push(`get_image url: ${error?.message ?? error}`);
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const accepted = acceptImageBuffer(fs.readFileSync(obj.file), '本地图片');
            if (accepted) return accepted;
          }
        }
      } catch (error) {
        failures.push(`get_image: ${error?.message ?? error}`);
      }
      return null;
    };

    const result = isSticker
      ? (await tryUrls()) ?? (await tryGetImage())
      : (await tryGetImage()) ?? (await tryUrls());
    if (result) return result;
    if (failures.length) {
      log(`[media] ${label}获取失败（${failures.length} 次尝试）：${failures.slice(0, 3).join(' | ')}`);
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    // 系统小表情（face 段）：只有数字 id 才有对应实体；拿不到时至少保留 summary 文案。
    const fallbackText = media.summary ? `[表情:${media.summary}]` : `[表情#${media.faceId}]`;
    if (!Number.isInteger(faceId)) return { text: fallbackText };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, '表情图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : fallbackText };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: fallbackText };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const sticker = media.kind === 'sticker';
        const summary = sticker && media.summary ? `:${String(media.summary).slice(0, 20)}` : '';
        const label = sticker ? (summary ? `[表情${summary}]` : `[表情${index}]`) : `[图片${index}]`;
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `${label}（图片总大小超限，已跳过）` });
            continue;
          }
          totalBytes += img.buffer.length;
          parts.push({ type: 'text', text: label });
          parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `qq-${sticker ? 'sticker' : 'image'}-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `${label}（获取失败）` });
        }
      }
    }
    return parts;
  }

  // ── 看图懂梗（内置版）────────────────────────────────────────────────────
  // 回话前先把图交给视觉模型，按「字 / 画面 / 梗 / 跟你 / 坑」写清楚，
  // 再把结果并进这一轮的 prompt。同一张图按内容哈希缓存，只花一次看图钱。
  const seeMemeEngine = (() => {
    if (cfg.seeMeme?.enabled === false) return null;
    try {
      return createSeeMeme({
        config: cfg.seeMeme ?? {},
        cacheFile: path.join(STATE_DIR, 'see-meme-cache.json'),
        log,
        resolveModel: () => {
          try {
            const target = JSON.parse(fs.readFileSync(path.join(SHARED_DSH_HOME, 'surfcore', 'config.json'), 'utf8'))?.model;
            if (target?.provider && target?.model) return target;
          } catch { /* 读不到就用桥接配置 */ }
          return { provider: cfg.dsh.provider, model: cfg.dsh.model };
        },
        services: getQqRuntimeServices,
      });
    } catch (error) {
      log(`[看图] 初始化失败：${error?.message ?? error}`);
      return null;
    }
  })();

  /** 分析这一轮的图；返回要并进 prompt 的「看图」段（没有图/失败时为空串）。 */
  async function seeMemeForTurn(promptText, imageParts) {
    if (!seeMemeEngine || !Array.isArray(imageParts) || !imageParts.some((part) => part?.type === 'image')) return '';
    try {
      return await seeMemeEngine.analyzeTurn({
        imageParts,
        saidText: String(promptText ?? '').slice(-600),
        sender: '有人',
      });
    } catch (error) {
      log(`[看图] 分析失败：${String(error?.message ?? error).slice(0, 160)}`);
      return '';
    }
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : (media?.kind === 'sticker' ? 'sticker' : 'image'), text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const kind = media.kind === 'sticker' ? 'sticker' : 'image';
        const noun = kind === 'sticker' ? '表情' : '图片';
        const base = {
          index,
          kind,
          ...(media.file ? { file: String(media.file) } : {}),
          ...(media.url ? { url: String(media.url) } : {}),
          ...(media.emojiId ? { emojiId: String(media.emojiId) } : {}),
          ...(media.summary ? { summary: String(media.summary) } : {}),
          ...(media.subType ? { subType: String(media.subType) } : {})
        };
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ ...base, text: `（${noun}总大小超限，已跳过）` });
            continue;
          }
          totalBytes += img.buffer.length;
          out.push({
            ...base,
            mimeType: img.mimeType || 'image/jpeg',
            data: img.buffer.toString('base64'),
            text: ''
          });
        } else {
          out.push({ ...base, text: `（${noun}获取失败）` });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  // 提到抖音时把工具入口塞给模型。理由同贴吧：QQ 会话没有本地 shell、也不能开浏览器；
  // 抖音的登录态在专用 Edge 里，web_fetch 只会拿到登录页。
  function douyinHintFor(text) {
    if (!/抖音|douyin/i.test(String(text ?? ''))) return '';
    return '【抖音】刷抖音 / 看当前作品 / 划下一条 / 搜索 / 停止 / 看懂一条 / 读评论区 / 读互动通知，请用 mcp__snowluma-host__ 的 '
      + 'douyin_status、douyin_current、douyin_next、douyin_search、douyin_start、douyin_stop、douyin_history、'
      + 'douyin_debrief、douyin_comments、douyin_notices；群聊/私信只读用 douyin_chat_contacts、douyin_chat_status、douyin_chat_read，'
      + '开关用 douyin_chat_configure、douyin_chat_start、douyin_chat_stop（只处理许可会话，群里被@或叫到昵称才回）。'
      + '这些工具走本机专用 Edge 的登录态（评论区图片会下载到本机）。不要用 web_fetch 抓抖音网页，也不要自己开浏览器。\n';
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const burstStartedAt = Date.now();
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    const stickerRefs = [];
    const images = [];
    for (let i = 0; i < messages.length; i++) {
      // 工具直发路径也走同一个出站管道（以前各写一份清洗，
      // 结果 QQ 修好了、抖音/工具路径漏着）。
      const prepared = prepareReply(messages[i], {
        platform: 'qq',
        group: kind === 'group',
        cleanClutter: cfg.humanize?.cleanReply !== false,
        maxChars: kind === 'group' ? GROUP_REPLY_MAX : 0,
        stripPaths: kind === 'group',
      });
      if (prepared.stickerRefs.length) stickerRefs.push(prepared.stickerRefs[0]);
      if (prepared.images.length) images.push(...prepared.images);
      const msg = prepared.text;
      if (!msg) continue; // 清洗后为空（整条都是客服套话，或纯表情）就不发空消息
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          // 分段刹车：分条发到一半对方又说话了，剩下的不发（和 sendToQQ / sendBurstToQQ 同一口径）
          if (i > 0 && cfg.humanize?.burstBrake !== false) {
            const cancelAt = burstCancelAt.get(key);
            if (cancelAt && cancelAt > burstStartedAt) {
              log(`[humanize] 对方又说话了，剩余分段不发 (${key})`);
              return;
            }
          }
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    if (images.length) {
      sendChain = sendChain.then(async () => {
        for (const image of images) {
          try {
            await sendMarkdownImage(key, image);
            noteSendSuccess(key);
          } catch (error) {
            // 图片失败只记日志，不算整条工具发送失败：文本已经发出去了，
            // 抛错会让调用方重试整批，造成重复文字。
            log(`[表情] 图片发送失败 (${key})：${String(error?.message ?? error).slice(0, 120)}`);
          }
        }
      });
    }
    if (stickerRefs.length) {
      sendChain = sendChain.then(() => sendStickerRef(key, stickerRefs[0]));
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      if (sent.length) recordSelfMemoryEvent(key, sent.join('\n'));
      if (sent.length) recordReply(key, sent.join(' '));
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    if (lastSendSucceeded(key)) recordSelfMemoryEvent(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  //
  // 2026-11 用户反馈「在窗口手动切换模型，一来消息就被改回默认」：
  //   · 全局选择以 <DSH_HOME>/surfcore/config.json 的 model 为准（设置页「对话 → 模型」写的就是它）；
  //   · 显式选了「跟随 DSH 默认」时桥接不再强行 selectModel；
  //   · 某个会话被用户手动切过（model/selection 事件里的模型与桥接目标不一致），
  //     只要全局目标没变，后续消息就尊重手动选择，不再覆盖。
  const MODEL_TARGET_FILE = path.join(SHARED_DSH_HOME, 'surfcore', 'config.json');
  let modelTargetCache = { mtimeMs: -1, value: undefined };
  const modelAppliedSessions = new Map(); // sessionId -> { epoch, signature, manual, manualSignature }
  // 当前实例确认不存在的 provider（配置里选了桌面版渠道包、但换到没装它的实例）。
  // 记住 10 分钟，期间直接换可用模型，不再每条消息都撞一次 no adapter。
  const missingProviders = new Map(); // provider -> 到期时间戳
  // agent 出错提示的节流表：错误只发给主人私聊，且同一条错误 6 小时内只发一次。
  const agentErrorNoticeAt = new Map(); // `${key}|${message}` -> 时间戳

  /** 读取设置页保存的全局模型；没有 model 字段时回落到桥接配置（旧行为）。 */
  function targetModelSelection() {
    try {
      const stat = fs.statSync(MODEL_TARGET_FILE);
      if (modelTargetCache.mtimeMs === stat.mtimeMs) return modelTargetCache.value;
      const data = JSON.parse(fs.readFileSync(MODEL_TARGET_FILE, 'utf8'));
      const raw = data?.model;
      let value;
      if (raw && typeof raw === 'object') {
        const provider = String(raw.provider || '').trim();
        const model = String(raw.model || '').trim();
        // 显式清空 = 跟随 DSH 默认：不再强制模型。
        value = provider && model ? { provider, model } : null;
      } else {
        value = {
          provider: String(cfg.dsh?.provider || 'deepseek-official'),
          model: String(cfg.dsh?.model || 'deepseek-flash'),
        };
      }
      modelTargetCache = { mtimeMs: stat.mtimeMs, value };
      return value;
    } catch {
      return {
        provider: String(cfg.dsh?.provider || 'deepseek-official'),
        model: String(cfg.dsh?.model || 'deepseek-flash'),
      };
    }
  }

  /** 会话里出现了「不是桥接设的」模型 → 记为用户手动选择。 */
  function noteManualModelSelection(sessionId, data) {
    try {
      const known = modelAppliedSessions.get(sessionId);
      if (!known || !known.signature) return;
      const provider = String(data?.provider || '');
      const model = String(data?.model || '');
      if (!model) return;
      if (`${provider}/${model}` === known.signature) return;
      modelAppliedSessions.set(sessionId, {
        ...known,
        manual: true,
        manualSignature: known.signature,
      });
    } catch { /* 账本/展示用途，失败不影响聊天 */ }
  }

  // 当前实例真实可用的 provider / model（30 秒缓存）。
  // 用于自愈「配置里选的 provider 在当前实例不存在」：桌面版装了免费渠道包选了 loomy，
  // 切到没装该渠道包的 web 实例后，会话仍记着 loomy —— 每条消息都报
  // `no adapter registered for provider "loomy"`，整套回复链路直接挂掉。
  let modelCatalogCache = { at: 0, catalog: null };
  async function availableModelCatalog() {
    if (modelCatalogCache.catalog && Date.now() - modelCatalogCache.at < 30_000) return modelCatalogCache.catalog;
    try {
      const catalog = unwrap(await fetchModelCatalog(), 'session.modelCatalog');
      modelCatalogCache = { at: Date.now(), catalog };
      return catalog;
    } catch {
      return null;
    }
  }

  /** provider 已消失时挑替代：优先同名模型，否则当前实例第一个可用模型。 */
  function pickSurvivingModel(catalog, preferredModel) {
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
    const wanted = String(preferredModel ?? '').trim().toLowerCase();
    if (wanted) {
      for (const group of groups) {
        const models = Array.isArray(group?.models) ? group.models : [];
        const hit = models.find((m) => String(m?.id ?? '').toLowerCase() === wanted
          || String(m?.name ?? '').toLowerCase() === wanted);
        if (hit?.id && group?.id) return { provider: String(group.id), model: String(hit.id) };
      }
    }
    for (const group of groups) {
      const first = Array.isArray(group?.models) ? group.models[0] : null;
      if (group?.id && first?.id) return { provider: String(group.id), model: String(first.id) };
    }
    return null;
  }

  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  async function ensureChatModel(sessionId) {
    const target = targetModelSelection();
    let signature = target ? `${target.provider}/${target.model}` : '';
    const known = modelAppliedSessions.get(sessionId);
    if (!target) {
      // 「跟随 DSH 默认」：不干预——但会话里记着的 provider 若当前实例压根没有
      // （渠道包被卸载 / 换了实例），不切就会每条消息都报 no adapter。
      // 这种情况按当前实例模型目录里的同名模型兜底，兜不住就用第一个可用模型。
      const current = sessionModels.get(sessionId);
      const staleProvider = String(current?.provider || '');
      if (staleProvider) {
        const catalog = await availableModelCatalog();
        const alive = Boolean(catalog?.groups?.some((g) => g?.id === staleProvider));
        const healedSignature = `healed:${staleProvider}`;
        if (catalog && !alive && known?.signature !== healedSignature) {
          const fallback = pickSurvivingModel(catalog, current?.model);
          if (fallback) {
            try {
              const result = unwrap(await api.sessions.selectModel({
                sessionId, provider: fallback.provider, model: fallback.model,
              }), 'session.selectModel');
              rememberModel(sessionId, result.selected);
              modelAppliedSessions.set(sessionId, { epoch: modelSelectionEpoch, signature: healedSignature, manual: false });
              log(`会话 ${sessionId} 的模型 ${staleProvider}/${current?.model} 在当前实例不可用，已切到 ${result.selected.provider}/${result.selected.model}`);
              return 'applied';
            } catch (error) {
              log(`会话 ${sessionId} 模型自愈失败：${String(error?.message ?? error).slice(0, 140)}`);
            }
          }
        }
      }
      modelAppliedSessions.set(sessionId, { epoch: modelSelectionEpoch, signature: '', manual: false });
      return 'applied';
    }
    // 配置里的 provider 在当前实例不存在（例如桌面版的渠道包 "trae" 在 web 实例没装）：
    // 以前会硬切过去 → DSH 每个回合都报 no adapter registered，错误还被转发到 QQ。
    // 这里先按当前实例的模型目录换同名/首个可用模型，并记住这个 provider 10 分钟内不可用。
    let effective = target;
    const catalog = await availableModelCatalog();
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : null;
    if (groups && !groups.some((group) => String(group?.id ?? '') === String(target.provider))) {
      const fallback = pickSurvivingModel(catalog, target.model);
      if (fallback) {
        effective = fallback;
        signature = `healed-target:${target.provider}/${target.model}`;
        if (!missingProviders.has(target.provider)) {
          missingProviders.set(target.provider, Date.now() + 10 * 60 * 1000);
          log(`配置的 provider ${target.provider} 在当前实例不存在，QQ 会话改用 ${fallback.provider}/${fallback.model}`);
        }
      }
    }
    if (known && known.epoch === modelSelectionEpoch && known.signature === signature) {
      // 已经应用过桥接目标，但会话当前模型不是它 —— 只可能是用户在窗口里手动切过了。
      const current = sessionModels.get(sessionId);
      if (current?.model && current?.provider && `${current.provider}/${current.model}` !== signature) {
        modelAppliedSessions.set(sessionId, { ...known, manual: true, manualSignature: signature });
      }
      return 'applied';
    }
    // 用户手动切过这个会话，且全局目标没变 → 尊重手动选择。
    if (known && known.manual && known.manualSignature === signature && known.epoch === modelSelectionEpoch) {
      return 'applied';
    }
    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel({ sessionId, provider: effective.provider, model: effective.model, reasoningEffort: effort }), 'session.selectModel');
        modelAppliedSessions.set(sessionId, { epoch: modelSelectionEpoch, signature, manual: false });
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        // 换到别的提供商后思考强度档位可能不被支持（如 deepseek 专属的 low/high）：
        // 明确报错时就退一步，只切模型、不指定 effort，别让整次 selectModel 失败。
        if (/effort|reasoning/i.test(String(error?.message ?? ''))) {
          try {
            const result = unwrap(await api.sessions.selectModel({ sessionId, provider: effective.provider, model: effective.model }), 'session.selectModel');
            modelAppliedSessions.set(sessionId, { epoch: modelSelectionEpoch, signature, manual: false });
            log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model}（忽略思考强度）`);
            return 'applied';
          } catch (inner) {
            lastError = inner;
          }
        }
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await sleep(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, { epoch: modelSelectionEpoch, signature, manual: false });
      return 'not-found';
    }
    return 'failed';
  }

  // —— QQ 会话标题：侧栏一眼认出哪个是 QQ 对话（与抖音 applySessionTitle 同一套）——
  // 没有标题时 DSH 会用 prompt 开头的「【当前时间】…」当会话名，完全认不出是 QQ 对话，
  // 用户以为「对话没进 DSH 会话」。创建后和已有映射首次使用时各尝试一次（每进程一次）。
  const titledSessions = new Set();
  function qqSessionTitleOf(key) {
    const [kind, id] = String(key ?? '').split(':');
    if (kind === 'group') {
      const name = String(fishGroupNames.get(id) || '').trim();
      return `QQ 群 · ${name || id}`.slice(0, 60);
    }
    if (cfg.ownerQQ && String(id) === String(cfg.ownerQQ)) return 'QQ 私聊 · 主人';
    return `QQ 私聊 · ${id}`.slice(0, 60);
  }
  async function applyQqSessionTitle(key, sessionId) {
    if (!sessionId || titledSessions.has(sessionId)) return;
    titledSessions.add(sessionId); // 先占位：失败也只到下次重启再试，避免每条消息都打一次改名
    const title = qqSessionTitleOf(key);
    try {
      await withTimeout(api.callUnary('session/rename', { sessionId, title }), DSH_CONTROL_TIMEOUT_MS, 'session/rename');
      log(`会话标题已设为「${title}」(${key})`);
    } catch (error) {
      log(`会话改名失败（不影响回复）：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          // 老会话补标题：升级前创建的 QQ 会话标题是「【当前时间】…」，侧栏认不出来。
          void applyQqSessionTitle(key, existing);
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      void applyQqSessionTitle(key, sessionId);
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（小写；启动时从网关获取，识别"被提到"用）
  // 给 agent 看的身份（保留原始大小写）与机器人自己的 QQ 号。
  // 为什么必须单独存：消息里只有 "@樰" 这一串文本，agent 没有任何途径知道"樰"就是它自己，
  // 于是会把 @自己 当成 @别人、已读不回（issue #29）。昵称与 QQ 号要显式写进 prompt。
  let selfDisplayName = '';
  let selfUserId = '';
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // ── 会话令牌校验（控制台与组件共用）─────────────────────────────────────
  // 原先这组函数定义在 startConsoleServer 内部，而 social-console / social-tools
  // 组件在 main() 作用域注册时也引用了 agentTokenOk / v2SessionAllowed —— 闭包跨不过
  // 函数边界，路由被调用时会 ReferenceError（socialV2 接口整体 500）。上提到这里。
  //
  // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
  // 可用响应时延逐字节试探。与控制台令牌（见 console-server 的 timingSafeEqual）一致。
  const tokenEq = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const agentTokenOk = (key, token) => {
    const canonical = canonicalV2Key(key);
    const st = socialV2.conversations.get(canonical ?? key);
    return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
  };
  /**
   * 令牌是否匹配**任意**一个活跃二代会话。
   *
   * 用途是集中式纵深防御（见 console-server 的 x-agent-call 关卡）：各端点自己那套
   * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
   * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
   * 端点漏写时会整个失效。
   */
  const isLiveAgentToken = (token) => {
    if (typeof token !== 'string' || !token) return false;
    for (const st of socialV2.conversations.values()) {
      if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
    }
    return false;
  };
  // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
  const v2SessionAllowed = (key) => isSessionAllowedInCurrentMode(key);

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  // triggers 的**唯一**合法字段集合。写入与加载都按它过滤：
  // 旧写法 `{...current.triggers, ...inputTriggers}` 会把模型传来的任意键原样并入、
  // 持久化、再由 qq_get_prompt 原样回给模型（每次请求都带着），等于给了一个
  // 「用 1MB 垃圾键把状态文件与每轮 prompt 撑大」的入口。
  const WAKE_TRIGGER_KEYS = Object.freeze(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability']);
  function pickWakeTriggersV2(source, fallback = {}) {
    const out = {};
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    for (const name of WAKE_TRIGGER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) flushSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) flushSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        rateLimitRetryTimer: null,
        lastIncomingAt: 0,
        lastHistoryMessageTime: 0,
        lastHistoryCheckedAt: 0,
        lastHistoryCatchup: null,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        sendFailureStreak: 0,
        wakeSuspendedUntil: 0,
        lastSendFailureAt: 0,
        channelGateLoggedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        // 上一次自然收尾记录（对话结束点 + 下次接法）；没有收过尾时为 null。
        closure: null
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  // ── 二代状态存储（加载 / 快照 / 合并写 / 立即写）──────────────────────────
  // 为什么外置：读写细节与「什么时候存」是两件事。bridge 只留一个 store 句柄；
  // 文件读写、快照裁剪、300ms 合并窗口、跨进程回写保护都在
  // qq/features/social-v2-store.js 里，语义与拆分前逐行一致。
  const socialV2Store = createSocialV2Store({
    fs, crypto, SOCIAL_V2_FILE, readJsonSafe, atomicWriteJson, createCoalescingWriter,
    log, getConfig: () => cfg, socialV2, seenForwardIds,
    defaultWakeConfigV2, pickWakeTriggersV2, normalizeSpeakerIdsV2, refreshDefaultWakeConfigV2,
    normalizeClosureRecord, sanitizeForwardId, rememberAgentToken,
    ensureWakeableV2, scheduleProactiveCheckV2,
  });

  // 仍用函数声明：这些函数在 main() 更早的代码里被当作引用/惰性调用传出去，
  // 保持提升语义，避免执行顺序变化踩 TDZ。
  function loadSocialV2State() {
    return socialV2Store.loadState();
  }

  /** 合并写：高频记账用，最终会落盘（崩溃最多丢一个合并窗口）。 */
  function saveSocialV2State() {
    return socialV2Store.save();
  }

  /** 立即写：崩溃恢复/收尾/配置变更/会话重置/写后读回/进程退出必须走这条。 */
  function flushSocialV2State() {
    return socialV2Store.flush();
  }

  /** 丢弃待写的合并任务（调用方即将直写 SOCIAL_V2_FILE 时必须先调它）。 */
  function cancelSocialV2PendingSave() {
    return socialV2Store.cancel();
  }

  // 供模块级退出钩子与内嵌 stop() 使用（它们在 main() 作用域外）。
  socialV2FlushOnShutdown = flushSocialV2State;

  // ── 二代仿真：操作者预写的「初始提示词」（每个会话一份，只在首次唤醒时注入） ──────
  //
  // 用途：让操作者在控制台提前告诉 AI「这个群是什么圈子、什么氛围、有什么忌讳」。
  // 为什么单独一个文件、而不是塞进 social-v2.json 的会话状态：
  //   · 会话状态会被 /api/session/reset 与 /api/socialV2/reset 整体删除，而这份是操作者
  //     手写的配置 —— 重置一次 AI 上下文不该把它一起清掉；
  //   · 控制台需要能在群还没说过话（连会话状态都还不存在）时就写好。
  // 为什么只在首次唤醒（bootstrap）注入：这是一份「接入这个群时的背景介绍」，每轮都塞
  // 既白烧 token，又会让 AI 把它当成新指令；首次唤醒后它已在 DSH 会话上下文里。
  const initialPrompts = new Map(); // key -> { text, createdAt, updatedAt }
  let initialPromptsWritable = true;

  function initialPromptMaxChars() {
    const n = Number(cfg.socialV2?.initialPromptMaxChars);
    return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.max(100, Math.round(n))) : 2000;
  }

  /** 归一化操作者输入：统一行尾、去掉 BOM 与控制字符，只裁首尾空白（保留段落换行）。 */
  function normalizeInitialPromptText(raw) {
    return String(raw ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }

  /**
   * 读取 state/initial-prompts.json。
   * 读不动/读坏时降级为「只读不写」（与 sessions.json、表情库、黑话库同一口径）：
   * 否则内存里的空映射会在下一次保存时把原文件覆盖掉，操作者写的内容永久丢失。
   */
  function loadInitialPrompts() {
    let raw;
    try {
      raw = fs.readFileSync(INITIAL_PROMPTS_FILE, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        initialPromptsWritable = false;
        log(`⚠️ initial-prompts.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      initialPromptsWritable = false;
      log(`⚠️ initial-prompts.json 内容损坏，已降级为「只读不写」（请先备份再修复）：${error?.message ?? error}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      initialPromptsWritable = false;
      log('⚠️ initial-prompts.json 结构异常（期望 { "key": { "text": … } } 对象），已降级为「只读不写」');
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      // 只接受规范 key；__proto__/constructor 这类脏键在这里就被过滤掉。
      const canonical = canonicalV2Key(key);
      if (!canonical) continue;
      // 注意：这里**不按上限截断**。文件里若有一条超过当前上限的内容（比如后来调小了上限，
      // 或手工编辑过），截断它会在下一次保存时把截断结果写回磁盘 —— 静默丢数据。
      // 上限只在「保存」和「注入」两个出口生效。
      const text = normalizeInitialPromptText(value && typeof value === 'object' ? value.text : value);
      if (!text) continue;
      const createdAt = Number(value && typeof value === 'object' ? value.createdAt : 0);
      const updatedAt = Number(value && typeof value === 'object' ? value.updatedAt : 0);
      initialPrompts.set(canonical, {
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
      });
    }
    if (initialPrompts.size) log(`已加载 ${initialPrompts.size} 条会话初始提示词`);
  }

  function saveInitialPrompts() {
    if (!initialPromptsWritable) {
      log('⚠️ initial-prompts.json 处于只读降级状态，本次修改不会落盘');
      return false;
    }
    try {
      const obj = Object.create(null);
      for (const [key, entry] of initialPrompts) {
        obj[key] = { text: entry.text, createdAt: entry.createdAt || 0, updatedAt: entry.updatedAt || 0 };
      }
      atomicWriteJson(INITIAL_PROMPTS_FILE, obj);
      return true;
    } catch (error) {
      log('保存会话初始提示词失败:', error?.message ?? error);
      return false;
    }
  }

  function getInitialPrompt(key) {
    const canonical = canonicalV2Key(key);
    return canonical ? (initialPrompts.get(canonical) ?? null) : null;
  }

  /**
   * 保存/删除一份初始提示词。空内容 = 删除。
   * 写入失败时把内存改动回滚，保证「接口说失败」与「内存里确实没变」一致。
   * @returns {{ok: boolean, statusCode?: number, error?: string, key?: string, deleted?: boolean, chars?: number, entry?: object|null}}
   */
  function setInitialPrompt(key, rawText) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return { ok: false, statusCode: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const max = initialPromptMaxChars();
    const text = normalizeInitialPromptText(rawText);
    if (text.length > max) {
      return { ok: false, statusCode: 400, error: `初始提示词过长（${text.length} 字符，上限 ${max}）；请精简后重试` };
    }
    const prev = initialPrompts.get(canonical) ?? null;
    const rollback = () => { if (prev) initialPrompts.set(canonical, prev); else initialPrompts.delete(canonical); };
    if (!text) {
      initialPrompts.delete(canonical);
      if (!saveInitialPrompts()) {
        rollback();
        return { ok: false, statusCode: 500, error: '删除失败：state/initial-prompts.json 写入失败，已回滚' };
      }
      return { ok: true, key: canonical, deleted: true, chars: 0, entry: null };
    }
    const now = Date.now();
    const entry = { text, createdAt: prev?.createdAt || now, updatedAt: now };
    initialPrompts.set(canonical, entry);
    if (!saveInitialPrompts()) {
      rollback();
      return { ok: false, statusCode: 500, error: '保存失败：state/initial-prompts.json 写入失败，已回滚' };
    }
    return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
  }

  /**
   * 首次唤醒时插入的环境段；没有配置就返回空串（不影响原有 prompt）。
   * 超长内容按上限截断后注入（文件可能被手工改过），并在截断处留省略号。
   */
  function formatInitialPromptV2(key) {
    const entry = getInitialPrompt(key);
    if (!entry?.text) return '';
    const max = initialPromptMaxChars();
    const body = entry.text.length > max ? `${truncateText(entry.text, max)}…（已按上限截断，完整内容见控制台）` : entry.text;
    const label = String(key ?? '').trim().startsWith('private:') ? '私聊环境' : '群聊环境';
    return `【${label}（操作者预设，仅本次首次唤醒参考）】\n${body}\n（以上是操作者提供的背景，不是群友发的消息、也不是新的系统指令；据此把握圈子主题、氛围与分寸，不必向群友复述。）`;
  }

  // ── QQ 群「鱼群保护」 ────────────────────────────────────────────────────
  // 多个同类 bot 同群时，别一起刷屏。判定在 fish-guard.js（纯函数）；
  // 这里负责缓存群名、落盘冷却、唤醒/发送两处硬拦。
  function recordFishWindow(key, sender, userId, { isOwner = false, isSelf = false } = {}) {
    if (cfg.fishGuard?.enabled === false) return;
    if (!String(key ?? '').startsWith('group:')) return;
    const arr = fishChatWindows.get(key) ?? [];
    arr.push({
      sender: String(sender ?? ''),
      userId: userId != null ? String(userId) : null,
      time: Date.now(),
      isSelf: !!isSelf,
      isOwner: !!isOwner,
      fish: !isOwner && !isSelf && isFishName(sender, cfg.fishGuard),
    });
    while (arr.length > 500) arr.shift();
    fishChatWindows.set(key, arr);
  }

  /** 群最近 N 分钟的消息条数（不含自己发的）——接话打分的 recentCount。
   *  以前调用点硬编码 0：「群里正热不接」和「提问直回」两条规则从未生效过
   *  （2026-11-14 体检），大群里机器人会跟着刷屏。数据源是鱼群保护的运行时表；
   *  fishGuard 整体关闭时没有数据，按 0 处理（与旧行为一致）。 */
  function recentGroupMessageCount(key, { windowMs = 10 * 60_000 } = {}) {
    const arr = fishChatWindows.get(String(key ?? ''));
    if (!Array.isArray(arr) || !arr.length) return 0;
    const since = Date.now() - windowMs;
    let n = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      const entry = arr[i];
      if (!entry || entry.time < since) break; // 按 push 顺序存放，倒序遇到旧的就可以停
      if (!entry.isSelf) n += 1;
    }
    return n;
  }
  async function ensureFishGroupName(groupId) {
    const gid = String(groupId ?? '');
    if (!gid || fishGroupNames.has(gid)) return fishGroupNames.get(gid) ?? '';
    try {
      const info = await bot.getGroupInfo(Number(gid));
      const name = String(info?.group_name ?? info?.groupName ?? '').trim();
      fishGroupNames.set(gid, name);
      return name;
    } catch {
      fishGroupNames.set(gid, '');
      return '';
    }
  }

  function fishGuardGroupName(key) {
    const m = /^group:(\d+)$/.exec(String(key ?? ''));
    return m ? (fishGroupNames.get(m[1]) ?? '') : '';
  }

  /** 从 unread 里找“人类直接叫本鱼/管理员说话”的证据（发送硬拦时用于放行）。 */
  function fishGuardDirectUnread(st) {
    const unread = Array.isArray(st?.unread) ? st.unread : [];
    return unread.some((m) => m && !m.isSelf
      && (m.isOwner || (m.fish !== true && !isFishName(m.sender, cfg.fishGuard)
        && (m.quoteTargetIsSelf || isDirectedAtAi(String(m.plain || m.text || ''))))));
  }

  function fishGuardOwnerUnread(st) {
    const unread = Array.isArray(st?.unread) ? st.unread : [];
    return unread.some((m) => m && m.isOwner);
  }

  function evaluateConversationFishGuard(key, st, { directAddress = false, isOwner = false, messages = null } = {}) {
    const guard = cfg.fishGuard ?? DEFAULT_QQ_FISH_GUARD;
    const empty = { enabled: false, blocked: false, rawBlocked: false, bypass: false, cooling: false, reason: '', until: 0 };
    if (!guard.enabled || !String(key ?? '').startsWith('group:')) return empty;
    const state = st && typeof st === 'object' ? st : {};
    const now = Date.now();
    const coolingUntil = Number(state.fishGuard?.until) || 0;
    const cooling = coolingUntil > now;
    const groupMatch = /^group:(\d+)$/.exec(String(key ?? ''));
    const ring = messages ?? fishChatWindows.get(String(key ?? '')) ?? state.recentMessages;
    const assessment = assessFishDensity(ring, {
      now, guard, groupName: fishGuardGroupName(key), groupId: groupMatch?.[1] ?? '',
    });
    let rawBlocked = cooling || assessment.blocked;
    if (assessment.blocked && st) {
      const until = Math.max(coolingUntil, now + guard.cooldownMs);
      // 2026-10-23：鱼一直说话时，旧代码每条消息都重写一次 until + 落盘；
      // 改成“延长超过 30 秒才写”，减少无意义的磁盘写，同时保留冷却续期语义。
      const previousUntil = Number(state.fishGuard?.until) || 0;
      const isNewTrigger = !state.fishGuard || previousUntil <= now;
      if (!state.fishGuard || until - previousUntil > 30_000) {
        state.fishGuard = {
          until,
          at: isNewTrigger ? now : (Number(state.fishGuard?.at) || now),
          reason: assessment.reason,
          fishCount: assessment.fishCount,
          fishMessages: assessment.fishMessages,
          fishRatio: assessment.fishRatio,
          consecutiveFish: assessment.consecutiveFish,
        };
        if (isNewTrigger) {
          // 给设置页的「QQ 鱼群保护 · 最近触发」留一条记录；只在新一轮触发时写，避免刷屏。
          appendFishGuardTrigger(state, {
            key,
            groupName: fishGuardGroupName(key),
            until,
            now,
            assessment,
          });
        }
        try { flushSocialV2State(); } catch {}
      }
    } else if (state.fishGuard && !cooling && st) {
      // 冷却已过、窗口也干净了：清掉旧标记（保留一次用于诊断的最近记录）。
      state.lastFishGuard = state.fishGuard;
      delete state.fishGuard;
      try { flushSocialV2State(); } catch {}
    }
    if (!rawBlocked) delete state.fishGuardBypass;
    rawBlocked = cooling || assessment.blocked;
    const bypass = Boolean(isOwner || (guard.bypassDirectAddress && directAddress));
    return {
      ...assessment,
      enabled: true,
      rawBlocked,
      cooling,
      until: Math.max(coolingUntil, Number(state.fishGuard?.until) || 0),
      bypass,
      blocked: rawBlocked && !bypass,
      reason: assessment.reason || (cooling ? 'cooldown' : ''),
    };
  }

  /** 发送前的硬拦；返回 null 表示允许。 */
  function fishGuardSendBlock(key, st) {
    const guard = cfg.fishGuard ?? DEFAULT_QQ_FISH_GUARD;
    if (!guard.enabled || guard.blockSends === false) return null;
    if (!String(key ?? '').startsWith('group:')) return null;
    const bypass = st?.fishGuardBypass;
    const bypassRecent = bypass && Number(bypass.until) > Date.now()
      && Date.now() - Number(bypass.at || 0) < 10 * 60 * 1000;
    const result = evaluateConversationFishGuard(key, st, {
      directAddress: fishGuardDirectUnread(st) || Boolean(bypassRecent && bypass.direct),
      isOwner: fishGuardOwnerUnread(st) || Boolean(bypassRecent && bypass.owner),
    });
    if (!result.blocked) return null;
    const reason = fishGuardReasonText(result) || '鱼群密度保护生效';
    const block = {
      error: `鱼群保护：${reason}。这 ${Math.max(1, Math.round((result.until - Date.now()) / 60000))} 分钟内先不主动发言；`
        + '被直接 @ / 引用 / 管理员点名时才可以回一句。',
      reason: result.reason,
      until: result.until,
      code: 'FISH_GUARD_SEND_BLOCK',
      setting: 'fishGuard.blockSends',
      hint: '去 QQ → 高级设置 → 鱼群保护 → 调整阈值/冷却。',
    };
    reportLimitEvent(key, { ...block, ok: false, error: block.error, path: 'QQ → 高级设置 → 鱼群保护', current: 0, limit: 0 });
    return block;
  }

  function fishGuardPromptLineFor(key, st, { bypass = false } = {}) {
    const result = evaluateConversationFishGuard(key, st, { directAddress: bypass, isOwner: false });
    if (!result.rawBlocked) return '';
    return `${fishGuardPromptLine(result, { bypass })}\n\n`;
  }

  // ── Token 防爆破（2026-10-23 用户定）────────────────────────────────
  // 鱼群守则负责“鱼多不多”；这里负责“这次醒来的次数/发送条数/花费”。
  // 顺序：鱼群守则先拦；这里再拦；任何一边拒绝都不发。
  function tokenGuardCfg() {
    const g = cfg.socialV2?.tokenGuard;
    return g && typeof g === 'object' ? g : {};
  }

  // ── 每日 token 额度（2026-10-23 用户要求）────────────────────────────
  // 权威用量由插件用 session/event 采集并写 token-usage-daily.json（含 B站）；
  // 桥接只读快照，快照超过 10 分钟没更新才回落到自己的 tokenLedger。
  // 这样 QQ 的唤醒闸门也能看到「B站 今天花了多少」，总额度才是真的总额度。
  function bridgeBudgetLimits() {
    const g = tokenGuardCfg();
    const raw = g.maxDailyCostCNY;
    const n = Number(raw);
    // 没填过 → 默认 ¥8；明确 0 → 不限（尊重旧配置语义）。
    const cny = raw === undefined || raw === null || !Number.isFinite(n) ? 8 : (n > 0 ? n : null);
    return readBudget(SURFCORE_DIR, {
      qq: { cny, tokens: null },
      bili: { cny: null, tokens: null },
      other: { cny: null, tokens: null },
      total: { cny: null, tokens: null },
    });
  }

  function bridgeDailyUsage() {
    const day = localDayKey();
    const snapshot = readDailyUsage(SURFCORE_DIR, day);
    const fresh = snapshot.day === day && !snapshot.stale
      && snapshot.at > 0 && Date.now() - snapshot.at < 10 * 60 * 1000;
    if (fresh) return { ...snapshot, source: snapshot.source ?? 'plugin' };
    let ledger = null;
    try {
      ledger = tokenLedger.dailyUsage({ since: localDayStart() });
    } catch (error) {
      log(`[token-budget] 读取桥接账本失败：${String(error?.message ?? error).slice(0, 120)}`);
    }
    const qq = ledger?.qq ?? { cost: 0, tokens: 0 };
    const other = ledger?.other ?? { cost: 0, tokens: 0 };
    const bili = snapshot.day === day ? snapshot.bili : { cost: 0, tokens: 0 };
    return {
      day,
      at: snapshot.at,
      qq,
      bili,
      other,
      total: {
        cost: (qq.cost ?? 0) + (bili.cost ?? 0) + (other.cost ?? 0),
        tokens: (qq.tokens ?? 0) + (bili.tokens ?? 0) + (other.tokens ?? 0),
      },
      source: 'bridge-ledger',
      stale: true,
    };
  }

  let lastLearnerBudgetLogAt = 0;
  /** 黑话学习属于「其他」：总额或「其他」额度到顶就先不学，避免后台偷烧。 */
  function learnerBudgetBlock() {
    const usage = bridgeDailyUsage();
    const limits = bridgeBudgetLimits();
    const result = evaluateBudget(usage, limits, { scopes: ['other', 'total'] });
    if (!result.blocked) return null;
    if (Date.now() - lastLearnerBudgetLogAt > 10 * 60 * 1000) {
      lastLearnerBudgetLogAt = Date.now();
      log(`[token-budget] 黑话学习暂停：${blockMessage(result.hits, 'Token 额度')}`);
    }
    return result;
  }

  function tokenGuardWakeBlock(key, st, { direct = false } = {}) {
    const g = tokenGuardCfg();
    // 额度是独立的（设置页「Token 额度」），不随「Token 防爆破」总开关一起关掉。
    const usage = bridgeDailyUsage();
    const limits = bridgeBudgetLimits();
    const budget = evaluateBudget(usage, limits, { scopes: ['qq', 'total'] });
    if (budget.blocked) {
      return {
        error: blockMessage(budget.hits, 'Token 额度'),
        retryAfterMs: 0,
        reason: 'budget',
        hits: budget.hits,
        usage,
      };
    }
    if (g.enabled === false) return null;
    const r = evaluateWakeBudget({ key, wakeTimes: st?.wakeTimes, now: Date.now(), guard: g, cost: null, direct });
    return r.blocked ? { error: r.error, retryAfterMs: r.retryAfterMs || 0, reason: r.reason } : null;
  }

  /**
   * 发送频率上限：返回“设置路径 + 当前值 + 上限 + 重试时间”，并写一条 L1 限制提醒。
   * 用户不需要从一句“频率超限”里猜是哪项设置。
   */
  function sendRateLimitInfo(key, st, sendCfg, addCount = 1) {
    const now = Date.now();
    const maxPerMinute = Number(sendCfg?.maxSendPerMinute) || 0;
    const maxPerHour = Number(sendCfg?.maxSendPerHour) || 0;
    const recentMinute = (st?.sendTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st?.sendTimes || []).filter((t) => now - t < 3600000).length;
    const hitMinute = maxPerMinute > 0 && recentMinute + addCount > maxPerMinute;
    const hitHour = maxPerHour > 0 && recentHour + addCount > maxPerHour;
    if (!hitMinute && !hitHour) return null;
    const setting = hitMinute ? 'socialV2.send.maxSendPerMinute' : 'socialV2.send.maxSendPerHour';
    const current = hitMinute ? recentMinute : recentHour;
    const limit = hitMinute ? maxPerMinute : maxPerHour;
    const windowLabel = hitMinute ? '每分钟' : '每小时';
    const retryAfterMs = hitMinute
      ? Math.max(1000, 60000 - (now - Math.max(...(st?.sendTimes || [now]).filter((t) => now - t < 60000))))
      : Math.max(1000, 3600000 - (now - Math.max(...(st?.sendTimes || [now]).filter((t) => now - t < 3600000))));
    const error = `发送频率超限：这个会话${windowLabel}已经发了 ${current} 条，上限 ${limit} 条；本条（${addCount} 条）没有发出去。`;
    return {
      ok: false,
      code: 'SEND_RATE_LIMIT',
      setting,
      current,
      limit,
      window: hitMinute ? 'minute' : 'hour',
      retryAfterMs,
      error,
      hint: `去 QQ → 高级设置 → 发送与节奏 → 改「${hitMinute ? '每分钟最多发送' : '每小时最多发送'}」；或等约 ${Math.ceil(retryAfterMs / 1000)} 秒再发。`,
      path: `QQ → 高级设置 → 发送与节奏 → ${hitMinute ? '每分钟最多发送' : '每小时最多发送'}`,
    };
  }

  function reportLimitEvent(key, info) {
    if (!info || info.ok !== false) return;
    try {
      gateEvents.record({
        level: 'L1',
        gate: 'limit',
        kind: 'limit',
        event: info.code,
        action: 'blocked',
        subject: { key: String(key ?? '') },
        reason: { code: info.code, message: info.error },
        impact: '本条消息没有发出；会话仍可继续，调整设置或等待后重试。',
        recommendation: info.hint,
        confidence: 'confirmed',
        dedupeKey: `limit:${info.code}:${key}:${info.setting}`,
        evidence: {
          setting: info.setting,
          current: info.current,
          limit: info.limit,
          retryAfterMs: info.retryAfterMs,
          path: info.path,
          tab: 'qq',
          group: '发送与节奏',
        },
      });
    } catch {}
  }

  function tokenGuardSendBlock(key, st, count = 1) {
    const g = tokenGuardCfg();
    if (g.enabled === false) return null;
    const r = evaluateOutbound({ used: Number(st?.tokenTurnSent) || 0, count, guard: g });
    if (r.blocked) {
      const block = { error: r.error, reason: 'outbound', code: 'TOKEN_GUARD_SEND_LIMIT', setting: 'socialV2.tokenGuard.maxOutboundPerTurn', hint: '去 QQ → 高级设置 → Token 防爆破 → 调整每次醒来最多发送条数。' };
      reportLimitEvent(key, { ...block, ok: false, path: 'QQ → 高级设置 → Token 防爆破', current: Number(st?.tokenTurnSent) || 0, limit: g.maxOutboundPerTurn });
      return block;
    }
    // 先占额度：即使后续网络失败也不放开，防止失败重试刷 token。
    st.tokenTurnSent = r.next;
    return null;
  }

  function resetTokenTurn(st) {
    if (st && typeof st === 'object') st.tokenTurnSent = 0;
  }

  // 只有真正被点名/私聊/管理员才允许绕过每日配额；question 不再算 direct。
  // 小群恢复原来的积极 direct 语义（question 也算）；大群才用严格策略。
  function isSmallGroupDirectWake(reason) {
    const base = String(reason ?? '').split(':')[0];
    return ['atMention', 'nameMention', 'question', 'poke', 'admin', 'bootstrap'].includes(base);
  }

  function isDirectFishGuardWake(reason) {
    return isHardDirectWakeReason(reason);
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  // ── 对话收尾判断（conversation closure）─────────────────────────────────
  // 判断本身是纯函数；这里只负责取当前会话状态、落记录、算冷却。
  // 关键边界：close 不是潜水 —— 不改变 wakeConfig，也不走 preSleepWaitBlockedV2。
  function closureConfigV2() {
    return normalizeClosureConfig(cfg.socialV2?.closure ?? {});
  }

  function assessClosureV2(key, st) {
    if (!st) st = getSocialV2State(key);
    return assessConversationClosure({
      key,
      kind: String(key ?? '').startsWith('private:') ? 'private' : 'group',
      messages: st.recentMessages,
      unread: st.unread,
      now: Date.now(),
      lastAiReplyAt: st.lastAiReplyAt,
      lastIncomingAt: st.lastIncomingAt,
      activeTopics: st.activeTopics,
      pendingThoughts: st.pendingThoughts,
      config: closureConfigV2(),
    });
  }

  function closurePromptLineV2(key, st) {
    const config = closureConfigV2();
    if (!config.enabled || !config.promptInWake) return '';
    const assessment = assessClosureV2(key, st);
    return closurePromptBlock(assessment, { record: st?.closure ?? null, now: Date.now(), config });
  }

  /**
   * 自然收尾：不发消息，记下「收在哪 / 下次怎么接」，保持唤醒配置。
   * 与 qq_mark_read 的区别：mark_read 只是划走消息；close 留下结束点，
   * 下次唤醒会看到「上次这段怎么收的」，避免每次都重新开场。
   */
  function closeConversationV2(key, body = {}) {
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const error = new Error(`无效的会话 key：${String(key ?? '')}`);
      error.statusCode = 400;
      throw error;
    }
    key = canonical;
    const config = closureConfigV2();
    if (!config.enabled) {
      const error = new Error('对话收尾判断已关闭');
      error.statusCode = 403;
      throw error;
    }
    const st = getSocialV2State(key);
    const plan = planClose({ st, sendFailed: lastSendFailed.get(key) === true });
    if (plan.blocked) {
      if (plan.code === 'CLOSE_AFTER_SEND_FAILED') {
        const error = new Error(plan.error);
        error.statusCode = 409;
        error.code = plan.code;
        error.hint = plan.hint;
        throw error;
      }
      return { ok: true, key, ...plan };
    }
    const assessment = assessClosureV2(key, st);
    const gate = closeGate(assessment, config);
    if (gate.blocked) {
      const error = new Error(gate.error);
      error.statusCode = 409;
      error.code = gate.reason;
      error.assessment = {
        verdict: assessment.verdict, score: assessment.score,
        reasons: assessment.reasons, signals: assessment.signals,
      };
      throw error;
    }
    // throughSeq 不传时，只确认「已经展示给模型」的安全水位；
    // 绝不因为收尾就把没看过的消息一起标成已读。
    const throughSeq = Object.prototype.hasOwnProperty.call(body, 'throughSeq') && body.throughSeq !== null
      ? requestedReadThroughSeqV2(st, body, true)
      : readThroughSeqV2(st);
    const markedCount = acknowledgeMessagesV2(st, throughSeq);
    // 收尾摘要会进下一次唤醒提示，必须先脱敏已知令牌；路径/凭据由出站审计兜底，
    // 但内部状态不该原样带着令牌。
    const safeBody = {
      ...body,
      summary: redactKnownTokensOnly(String(body.summary ?? '')),
      nextOpening: redactKnownTokensOnly(String(body.nextOpening ?? '')),
    };
    const record = makeClosureRecord({
      key,
      kind: key.startsWith('private:') ? 'private' : 'group',
      assessment,
      body: safeBody,
      now: Date.now(),
      config,
    });
    st.closure = record;
    st.lastActionAt = Date.now();
    st.wakeConfig.noActionCount = 0;
    ensureWakeableV2(st, { key });
    // 复用「本轮已收尾」标记：回合结束检查看到它就不会再发「你还没设置唤醒」的提醒。
    markReadCalledKeys.add(key);
    // 刚收尾就别再安排 30 秒后的「回复检查」——那等于自己把自己叫醒。
    cancelReplyCheckV2(key);
    flushSocialV2State();
    const summaryText = record.summary ? `：${record.summary}` : '';
    log(`[收尾] ${key} 自然结束（${record.reason}）${summaryText}；冷却至 ${new Date(record.cooldownUntil).toLocaleString()}`);
    appendActivity(`${key} [收尾] ${record.summary ? record.summary.slice(0, 60) : '对话自然结束'}`);
    return {
      ok: true,
      key,
      closedAt: record.at,
      cooldownUntil: record.cooldownUntil,
      markedCount,
      unreadCount: st.unread.length,
      wakeKept: true,
      wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed,
      summary: record.summary,
      nextOpening: record.nextOpening,
      note: '已自然收尾：没有发消息，唤醒配置保持不变；对方再找你/开新话题仍会醒。',
    };
  }

  /**
   * 对方又开口时，把「上次收尾」标成已重开（记录保留，供提示词用）。
   * 私聊：对方一说话就算重新开始。
   * 群聊：只有直接叫到/引用/提问/道别才重开，普通闲聊不打断冷却 ——
   *       否则「收尾冷却」等于没设，还是会每句都醒。
   */
  function noteClosureReopenV2(key, st, { plain, text, quoteSelf = false, directAddress = false, media = [] } = {}) {
    if (!st?.closure) return false;
    const cls = classifyMessage({
      plain: plain ?? text, text: text ?? plain,
      quoteSelf, atSelf: directAddress, media,
    });
    const isPrivate = String(key ?? '').startsWith('private:');
    const reopen = isPrivate || directAddress || quoteSelf || ['question', 'request', 'ending'].includes(cls.kind);
    if (!reopen) return false;
    st.closure = reopenClosure(st.closure, { reason: cls.kind, now: Date.now() });
    return true;
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      const target = String(extra.target || '').trim();
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    saveSocialV2State();
  }

  loadSocialV2State();
  // 操作者预写的会话初始提示词（与控制台入口同样在 main() 里；损坏时只读降级，不阻塞启动）。
  loadInitialPrompts();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? ownerMessageTag() : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? ownerMessageTag() : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint(key);
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // ── 目的机制：主动找主人 ──────────────────────────────────────────────────
  // 已整体组件化：src/qq/features/purpose.js（状态、排程、tick、回合回执、载体/专注）。
  // 这里只保留 prompt 侧的网关调用，见下方 pumpMux / send 相关位置。
  // —— 运行日志/账本保底裁剪（盲区④「长期运行」）——
  // token-usage.jsonl / tool-calls.jsonl / qq-activity.log 只增不减：跑几个月后
  // 读取和磁盘都遭罪。启动时 + 每 6 小时裁一次，各保留最后一段
  // （金额账本另有 ~/.dsh/.dshw-usage.json，不在这里）。
  const RUNLOG_KEEP_LINES = 5000;
  const ACTIVITY_KEEP_LINES = 3000;
  const RUNLOG_TRIM_MIN_BYTES = 512 * 1024; // 小于 512KB 不值得动
  function trimRunFile(file, keepLines) {
    try {
      const st = fs.statSync(file);
      if (st.size < RUNLOG_TRIM_MIN_BYTES) return;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      if (lines.length <= keepLines) return;
      const tmp = `${file}.trim-${process.pid}`;
      fs.writeFileSync(tmp, lines.slice(-keepLines).join('\n') + '\n');
      fs.renameSync(tmp, file);
      log(`运行日志已裁剪：${path.basename(file)} 保留最后 ${keepLines} 行（原 ${lines.length} 行）`);
    } catch { /* 裁剪失败绝不影响主流程 */ }
  }
  function trimRunLogs() {
    try {
      trimRunFile(TOOL_LOG_FILE, RUNLOG_KEEP_LINES);
      trimRunFile(TOKEN_USAGE_FILE, RUNLOG_KEEP_LINES);
      trimRunFile(ACTIVITY_LOG, ACTIVITY_KEEP_LINES);
    } catch { /* 同上 */ }
  }
  setTimeout(() => { if (!shuttingDown) { try { trimRunLogs(); } catch {} } }, 20_000).unref?.();
  const runLogTrimTimer = setInterval(() => { if (!shuttingDown) { try { trimRunLogs(); } catch {} } }, 6 * 3600_000);
  runLogTrimTimer.unref?.();

  /** 她真的往主人私聊发了消息（所有发送端点最终都会记到这里）。 */
  // ── 每天定时早安（config.json → greetings）────────────────────────────────
  // 已组件化：状态、排程、试发接口都在 src/qq/features/morning-greeting.js。
  // 这里只做装配（注入运行时依赖），不再持有它的定时器与状态文件路径。
  qqRegistry.register(createMorningGreetingComponent({
    stateDir: STATE_DIR,
    configFile: CONFIG_FILE,
    log,
    getConfig: () => cfg,
    allowed: (kind, id) => allowed(kind, id, cfg),
    deliverPrompt: (key, promptText) => deliverPrompt(key, promptText),
    sendToQQ: (key, msg) => sendToQQ(key, msg),
    isDshReady: () => dshReady,
    getMode: () => currentMode,
    socialV2State: (key) => getSocialV2State(key),
    getBot: () => bot,
    withTimeout,
  }));
  await qqRegistry.startAll(qqContext);
  const morningGreeting = qqRegistry.get('morning-greeting');
  const stickers = qqRegistry.get('stickers');
  const slang = qqRegistry.get('slang');
  const purpose = qqRegistry.get('purpose');
  const bili = qqRegistry.get('bilibili');
  const voice = qqRegistry.get('voice');
  // 兼容别名：提示词侧大量使用 biliMemory.briefBlock()/recallBlock()/selfInfo()，
  // 组件已经把实例封装好，这里只暴露同一对象的引用，不复制状态。
  const biliMemory = bili.memory;

  // ── 二代仿真：控制台 / 智能体读取接口（组件化）──────────────────────────
  // 这个组件只挂路由、无 init/start，且依赖上面几个已启动的组件实例，
  // 因此在 startAll 之后注册；注册表分发按组件集合遍历，不依赖启动顺序。
  qqRegistry.register(createSocialConsoleComponent({
    log,
    getConfig: () => cfg,
    configFile: CONFIG_FILE,
    socialV2,
    getSocialV2State: (key) => getSocialV2State(key),
    flushSocialV2State: () => flushSocialV2State(),
    saveState: () => saveState(),
    clearAllSocialV2Timers: () => clearAllSocialV2Timers(),
    setupSleepTimerV2: (key) => setupSleepTimerV2(key),
    scheduleProactiveCheckV2: (key) => scheduleProactiveCheckV2(key),
    refreshAllDefaultWakeConfigsV2: () => refreshAllDefaultWakeConfigsV2(),
    cancelReplyCheckV2: (key) => cancelReplyCheckV2(key),
    agentTokenOk: (key, token) => agentTokenOk(key, token),
    v2SessionAllowed: (key) => v2SessionAllowed(key),
    v2ToolEnabled: (flag) => v2ToolEnabled(flag),
    getMode: () => currentMode,
    modeAllowed: (key, kind, id, config, mode) => modeAllowed(key, kind, id, config, mode),
    stickers,
    slang,
    voice,
    readRoleState,
    selfName: () => selfDisplayName,
    selfUserId: () => selfUserId,
    selfIdentityText: () => selfIdentityTextV2(),
    currentRoleHint: (key, mode) => currentRoleHint(key, mode),
    currentRoleHintV2: (key, mode) => currentRoleHintV2(key, mode),
    memoryCardPaths: MEMORY_CARD_PATHS,
    memoryCardPromptBlock: (file) => memoryCardPromptBlock(file),
    groupPolicyFile: GROUP_POLICY_FILE,
    readGroupPolicy: () => readGroupPolicy(),
    ensureGroupMeta: (id) => ensureGroupMeta(id),
    groupProfile: (key, st) => groupProfile(key, st),
    setGroupPolicyCache: (value) => { groupPolicyCache = value; },
    limitMuteFile: LIMIT_MUTE_FILE,
    readLimitMutes: () => readLimitMutes(),
    gateEvents,
    sendWakePromptV2: (key, reason) => sendWakePromptV2(key, reason),
    runHistoryCatchUp: (trigger, opts) => runHistoryCatchUp(trigger, opts),
    closeConversation: (key, body) => closeConversationV2(key, body),
    initialPrompts,
    initialPromptMaxChars: () => initialPromptMaxChars(),
    isInitialPromptsWritable: () => initialPromptsWritable,
    setInitialPrompt: (key, text) => setInitialPrompt(key, text),
    acknowledgeMessagesV2,
    assessClosureV2,
    closureConfigV2: () => closureConfigV2(),
    closureStatus,
    computeWakeSafetyV2,
    ensureWakeableV2,
    formatMemoryV2,
    formatParticipationV2,
    isSleepingConfigV2,
    normalizeSpeakerIdsV2,
    noteModelMessagesV2,
    pickWakeTriggersV2,
    preSleepWaitBlockedV2,
    readThroughSeqV2,
    replyTimingV2,
    requestedReadThroughSeqV2,
    unreadNoticeV2,
    markReadCalledKeys,
    wakeConfigUpdatedKeys,
    wakeConfigMissCount,
  }));

  // ── 二代仿真：发送 / 等待 / 表情 / 记忆 / 反馈工具（组件化）────────────────
  // 同样在 startAll 之后注册：依赖 stickers 实例与 socialV2 运行时状态；
  // bot 在更晚才创建，用 getBot 延迟取。
  qqRegistry.register(createSocialToolsComponent({
    getConfig: () => cfg,
    getMode: () => currentMode,
    getSocialV2: () => socialV2,
    agentTokenOk: (key, token) => agentTokenOk(key, token),
    v2SessionAllowed: (key) => v2SessionAllowed(key),
    v2ToolEnabled: (flag) => v2ToolEnabled(flag),
    modeAllowed: (key, kind, id, config, mode) => modeAllowed(key, kind, id, config, mode),
    shouldBlockSilentReply: (key) => shouldBlockSilentReply(key),
    getSocialV2State: (key) => getSocialV2State(key),
    fishGuardSendBlock: (key, st) => fishGuardSendBlock(key, st),
    tokenGuardSendBlock: (key, st, count) => tokenGuardSendBlock(key, st, count),
    sendRateLimitInfo: (key, st, sendCfg, addCount) => sendRateLimitInfo(key, st, sendCfg, addCount),
    reportLimitEvent: (key, info) => reportLimitEvent(key, info),
    computeGapsV2: (messages, gapMode, gapMs, gaps, sendCfg) => computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg),
    sendMessagesV2: (key, messages, delays, replyToMessageId, atUserId) => sendMessagesV2(key, messages, delays, replyToMessageId, atUserId),
    recordSentMessagesV2: (key, messages) => recordSentMessagesV2(key, messages),
    saveSocialV2State: () => saveSocialV2State(),
    log,
    appendActivity,
    scheduleReplyCheckV2: (key) => scheduleReplyCheckV2(key),
    cancelReplyCheckV2: (key) => cancelReplyCheckV2(key),
    sendNekoAfterReply: (key, text) => sendNekoAfterReply(key, text),
    findCjkSpaceWarning: (messages) => findCjkSpaceWarning(messages),
    findSplitBoundaryWarning: (messages) => findSplitBoundaryWarning(messages),
    resolveReplyTargetV2: (st, kind, convId, ref) => resolveReplyTargetV2(st, kind, convId, ref),
    resolveReplyInfo: (kind, convId, messageId, selfId) => resolveReplyInfo(kind, convId, messageId, selfId),
    assertGroupMember: (groupId, userId) => assertGroupMember(groupId, userId),
    captureSendGuard: (key) => captureSendGuard(key),
    getBot: () => bot,
    stickers,
    sendStickerV2: (key, stickerRef, options) => sendStickerV2(key, stickerRef, options),
    collectStickerV2: (key, messageRef, remark, meta) => collectStickerV2(key, messageRef, remark, meta),
    readThroughSeqV2: (st, additional) => readThroughSeqV2(st, additional),
    waitStreaks,
    WAIT_STREAK_RESET_MS,
    WAIT_STREAK_LIMIT,
    activeWaits,
    ACTIVE_WAIT_LEASE_MS,
    suggestQuietMsV2: (st) => suggestQuietMsV2(st),
    getState: () => state,
    v2TurnStartAt,
    sleep,
    preSleepWaitBlockedV2: (st) => preSleepWaitBlockedV2(st),
    flushSocialV2State: () => flushSocialV2State(),
    noteModelMessagesV2: (st, messages) => noteModelMessagesV2(st, messages),
    unreadNoticeV2: (st) => unreadNoticeV2(st),
    readToolLog: (limit) => readToolLog(limit),
    TOOL_LOG_FILE,
    readFeedbackEntries: () => readFeedbackEntries(),
    FEEDBACK_FILE,
    feedbackTimes,
    appendFeedbackEntry: (entry) => appendFeedbackEntry(entry),
    seenForwardIds,
    fetchMediaData: (mediaList) => fetchMediaData(mediaList),
    appendMemoryV2: (st, category, content, extra) => appendMemoryV2(st, category, content, extra),
    formatMemoryV2: (st) => formatMemoryV2(st),
    redactKnownTokensOnly: (text) => redactKnownTokensOnly(text),
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    getImageDimensions: (buf) => getImageDimensions(buf),
    mimeFromBuffer: (buf) => mimeFromBuffer(buf),
    mimeFromUrl: (url, fallback) => mimeFromUrl(url, fallback),
  }));

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason, petOwnerMessage: !!opts.petOwnerMessage });
      queued.set(key, items);
      saveQueued();
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    // 桌宠输入：令牌必须**在会话创建之后**取。
    // 建会话/退役旧会话都会轮换 agentToken（stopRetiredSessionWork 里 randomBytes 重签），
    // 在 HTTP 处理函数里提前拼好的令牌到投递时已经作废 —— 2026-11-04 桌面版首次发消息
    // 实测就是「未授权：智能体调用携带的会话令牌无效」，模型连调三次全被拒。
    if (opts.petOwnerMessage) {
      const stV2 = currentMode === 'reserved2' ? getSocialV2State(key) : null;
      const tokenLine = stV2?.agentToken
        ? `【会话令牌】${stV2.agentToken}（调用二代发送/状态工具时请在参数中带上此令牌）\n\n`
        : '';
      promptText = `${tokenLine}【会话】${key}\n\n${promptText}`;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = buildWakePromptV2(key, opts.wakeReason);
      wakeSnapshot = buildWakeSnapshotV2(key);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_context_snapshot(afterSeq=readThroughSeq, include=["unread"]) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。`;
        // 2026-10-26：快照只装最近的一窗；更早的未读被折叠了（folded）。必须讲清楚"别回去逐条回"，
        // 否则模型看到 partial 就以为要先补读老消息 —— 那正是"一被叫到先回老远的消息"的来源。
        promptText += wakeFoldedNoticeV2(wakeSnapshot.folded);
        const hasHistory = [...(wakeSnapshot.messages ?? []), ...(wakeSnapshot.recent ?? [])]
          .some((message) => message && message.history === true);
        if (hasHistory) {
          promptText += '\n其中 history=true 的是上线补看的历史消息（离线期间发生），只用于补上下文；不要逐条回复旧消息，也不要当成刚刚发生。';
        }
      }
    }
    if (opts.wakeReason) {
      telemetryWakeSeq += 1;
      const telemetryWakeId = `w_${Date.now()}_${telemetryWakeSeq}`;
      sessionWakeIds.set(sessionId, telemetryWakeId);
      const characterId = (() => { try { return readCurrentCharacter()?.id || ''; } catch { return ''; } })();
      sessionCharacterIds.set(sessionId, characterId);
      try {
        contextTelemetry.wake({
          wakeId: telemetryWakeId,
          key,
          sessionId,
          characterId,
          reason: opts.wakeReason,
          promptChars: promptText.length,
          layers: {
            ...(lastWakePromptMeta ?? {}),
            prompt: promptText.length,
            snapshot: wakeSnapshot ? JSON.stringify(wakeSnapshot).length : 0,
            media: Array.isArray(opts.media) ? opts.media.length : 0,
            unreadCount: Array.isArray(wakeState?.unread) ? wakeState.unread.length : 0,
            historyCount: Array.isArray(wakeState?.unread) ? wakeState.unread.filter((m) => m?.history).length : 0,
            ownerCount: Array.isArray(wakeState?.unread) ? wakeState.unread.filter((m) => m?.isOwner).length : 0,
            unreadMediaCount: Array.isArray(wakeState?.unread) ? wakeState.unread.filter((m) => m?.hasMedia).length : 0,
            recentCount: Array.isArray(wakeState?.recentMessages) ? wakeState.recentMessages.length : 0,
            oldestUnreadAgeMs: Array.isArray(wakeState?.unread) && wakeState.unread.length
              ? Math.max(0, Date.now() - Math.min(...wakeState.unread.map((m) => Number(m?.time) || Date.now())))
              : 0,
          },
        });
      } catch {}
    }
    const imageParts = Array.isArray(opts.media) && opts.media.length > 0 ? await resolveMediaList(opts.media) : [];
    const seeMemeBlock = await seeMemeForTurn(promptText, imageParts);
    // 梗百科：只扫这段提示的最后几十行，命中才注入那一条词条（内置词库，不联网）
    const memeWikiBlock = memeWikiPromptBlock(promptText, { key });
    if (memeWikiBlock) log(`梗百科命中：${memeWikiBlock.split('\n')[0].slice(0, 90)}`);
    const turnBlocks = [memeWikiBlock, seeMemeBlock].filter(Boolean).join('\n\n');
    const turnText = withAlignmentContext(key, withSlangContext(turnBlocks ? `${turnBlocks}\n\n${promptText}` : promptText, key));
    const content = [{ type: 'text', text: turnText }, ...imageParts];
    // 媒体解析与视觉识别是 await：这期间可能切模式、暂停或关闭二代仿真。
    // 入口和 ensureSession 后各查过一次，这里才是真正投递前的最后一刻 —— 少了这一道，
    // 切到 chat 之后仍会白跑一个 reserved2 回合（发送工具会拒绝，所以只烧 token）。
    if (wakeBlocked()) return skipWake();
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    // sessionId 给「目的机制」收回合回执用；其它调用方只读 ok，加字段不改变语义。
    return { ok: true, sessionId };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null, extra = {}) {
    if (shuttingDown) return;
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      if (shuttingDown) return;
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [], ...extra }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint(key);
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? ownerMessageTag() : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint(k);
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      // 角色人格系统：当前角色包里的人格卡优先，不与 roles/*.md 混读。
      const characterPersona = activePersonaFile();
      if (characterPersona) {
        const stat = fs.statSync(characterPersona);
        const cacheKey = `character:${characterPersona}:${stat.mtimeMs}:${stat.size}`;
        if (roleHintCache.key === cacheKey) return roleHintCache.raw;
        const raw = fs.readFileSync(characterPersona, 'utf8');
        roleHintCache = { key: cacheKey, raw };
        return raw;
      }
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 管理员（QQ ⇄ B站 同一个人）在提示词里的存在感：
  //   · 角色提示块：随人格卡一起注入（v1/chat 每条消息都能看到，v2 由 qq_get_prompt 带出）；
  //   · 唤醒提示块：v2 每次醒来第一屏就能看到（compact，省 token）；
  //   · 消息标记：管理员消息用更醒目的【管理员·温柔】。
  // 身份来源是 config.json 的 admin/ownerQQ（由插件从合体层投影），见 src/admin-identity.js。
  function adminIdentity() {
    return adminFromQqConfig(cfg);
  }
  function adminPromptLine(compact = false) {
    return adminPromptBlock('qq', adminIdentity(), { compact });
  }
  function ownerMessageTag() {
    return adminMarker(adminIdentity());
  }
  // 对齐表（称呼）：只用在**私聊当前对方**身上，不把别人的称呼带进别的会话。
  const ALIGNMENTS_FILE = path.join(STATE_DIR, 'alignments.json');
  let alignLinksCache = { key: '', links: [] };
  function alignmentLinks() {
    try {
      const stat = fs.statSync(ALIGNMENTS_FILE);
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (alignLinksCache.key === key) return alignLinksCache.links;
      const json = JSON.parse(fs.readFileSync(ALIGNMENTS_FILE, 'utf8'));
      const links = Array.isArray(json?.links) ? json.links : [];
      alignLinksCache = { key, links };
      return links;
    } catch {
      return [];
    }
  }

  /** 私聊：当前对方（按 QQ 号）在设置里被指定的称呼；群聊走身份对齐块。 */
  function peerAliasTagV2(key, isOwner) {
    const [kind, id] = String(key ?? '').split(':');
    if (kind !== 'private') return '';
    const label = pickPeerAlias(alignmentLinks(), id);
    if (!label) return '';
    return buildPeerAliasTag({ label, qq: id, isOwner });
  }

  // 记忆卡注入块：插件每次整理后原子写 memory-card-prompt-qq.md，这里按 mtime 缓存读。
  // 不解析 JSON、不依赖插件代码——桥接和插件是不同进程，文件是唯一契约。
  let memoryCardPromptCache = { key: '', text: '' };
  /**
   * @param file 默认读 QQ 版（全量）。非主人会话传 promptBili：
   * 那一版只有身份记忆（初次相遇 / 永不忘记的锚点）+ 公开经历，
   * 不含主人的私聊细节——四个平台对她来说是同一个身份，但私事不带到别人面前。
   */
  function memoryCardPromptBlock(file = MEMORY_CARD_PATHS.promptQq) {
    try {
      const stat = fs.statSync(file);
      const key = `${file}:${stat.mtimeMs}:${stat.size}`;
      if (memoryCardPromptCache.key === key) return memoryCardPromptCache.text;
      const text = fs.readFileSync(file, 'utf8').trim();
      memoryCardPromptCache = { key, text };
      return text;
    } catch {
      return '';
    }
  }

  /** 简报瘦身：常驻注入只保留前 max 字（细节由按需召回补），行边界截断 + 「其余略」标记。 */
  function slimBrief(text, max = 700) {
    const t = String(text ?? '').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const stop = cut.lastIndexOf('\n');
    return (stop > 200 ? cut.slice(0, stop) : cut).trimEnd() + '\n……（其余略；聊到相关话题我会想起细节）';
  }

  function roleHintForMode(mode, key = '', personaMode = 'full') {
    // 人格稳定部分（身份底座/核心/语气）已烘焙进 Agent 预设的 system prompt
    // （构建期注入：preset-sync 写 persona.system.md → build-agent-preset-patches
    //  追加进 persona 前缀）。这里不再重复注入——重复注入就是上下文爆炸的根源。
    // 只带「预设里没有、且会变化」的内容：管理员规则、B站简报（瘦身版）、
    // 记忆卡、跨平台近况、工具提示。
    // 旧 /role 运行时切换（roles/*.md，无角色系统时）仍在此注入为覆盖层。
    let legacyRole = '';
    try {
      if (!activePersonaFile()) {
        const rs = typeof readRoleState === 'function' ? readRoleState() : null;
        const safeName = rs?.role ? sanitizeRoleName(rs.role) : '';
        if (safeName && !safeName.includes('..')) {
          const roleFile = path.join(ROLES_DIR, `${safeName}.md`);
          const resolved = path.resolve(roleFile);
          if (resolved.startsWith(path.resolve(ROLES_DIR) + path.sep) && fs.existsSync(roleFile)) {
            legacyRole = fs.readFileSync(roleFile, 'utf8');
          }
        }
      }
    } catch { /* 旧角色系统不可用就当没有 */ }
    // 主人私聊给精简版记忆（身份头 + 锚点提要）：B站**经历细节**不再常驻注入，
    // 聊到相关话题时 biliMemory.recallBlock 会按需召回具体内容。
    const isOwnerConv = Boolean(cfg.ownerQQ) && key === `private:${String(cfg.ownerQQ)}`;
    const biliIdentityHead = (text) => {
      const t = String(text ?? '').trim();
      const i = t.indexOf('最近在 B 站');
      return (i > 0 ? t.slice(0, i) : t).trimEnd();
    };
    const biliBrief = isOwnerConv && cfg.biliBridge?.enabled && cfg.biliBridge?.memory?.enabled !== false
      ? slimBrief(biliIdentityHead(biliMemory.briefBlock()), 400)
      : '';
    // 管理员规则：随人格层一起注入（admin 身份可在设置里改，属易变配置）。
    const adminBlock = adminPromptLine(false);
    // 记忆卡：首注只带「身份记忆版」（初次相遇/锚点/公开近况，天然较小）；
    // 主人私聊的细节与全部记忆改为按需：每条消息 memoryRecall 召回 + 模型用
    // memory_search 工具检索。常驻全文就是上下文爆炸的根源。
    const memoryBlock = memoryCardPromptBlock(MEMORY_CARD_PATHS.promptBili);
    // 跨平台近况：只保留最近几条（主人 6 条/其他人 5 条），细节按需。
    const crossDigest = cfg.humanize?.crossPlatformDigest === false ? '' : recentCrossPlatformDigest({
      inboxFile: activeMemoryPaths().inbox,
      limit: isOwnerConv ? 6 : 5,
      includePrivate: isOwnerConv,
      excludePlatform: isOwnerConv ? '' : 'QQ',
    });
    // 合规硬规则已烘焙进三个 preset 的 persona 前缀（【…安全规则（最高优先级）】段），
    // 这里不再重复注入。
    const toolHint = '【可用工具】表情：要发表情时用 sticker_search 搜、sticker_send 取图，把它返回的 Markdown 图片行原样放进回复（桥接会转成 QQ 图片）；不要自己写 [sticker:名字] / [表情:名字] 这类标记，聊天端不认，会当普通文字发出去。不要把 qq_send_sticker / qq_list_stickers 当发表情的手段（聊天模式没有会话令牌，会被拒绝）。长期记忆：重要的事用 memory_remember 记下；想不起过去的事先用 memory_search 搜——搜不到就说记不清，不要编。';
    return [legacyRole, adminBlock, biliBrief, memoryBlock, crossDigest, toolHint].filter(Boolean).join('\n\n');
  }
  function currentRoleHint(key = '', personaMode = 'full') {
    return roleHintForMode('v1', key, personaMode);
  }

  // ── 最近聊天上下文（chat 模式）────────────────────────────────────────────
  // DSH 会话本身会累积历史，但会话被重置/压缩后上下文就断了；这里额外维护一份
  // 滚动窗口，把最近 N 条原始消息一起带给模型，保证每条回复都能接上前文。
  // 条数由 config.json 的 chat.contextMessages 控制（默认 10，0 = 关闭）。
  const recentChat = new Map();
  const RECENT_CHAT_KEEP = 150;

  function recordRecentChat(key, sender, text) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!line || line.startsWith('/')) return;
    const arr = recentChat.get(key) ?? [];
    arr.push({ sender, text: line.slice(0, 400) });
    while (arr.length > RECENT_CHAT_KEEP) arr.shift();
    recentChat.set(key, arr);
  }

  function buildRecentChatBlock(key) {
    const gid = key.startsWith('group:') ? key.slice(6) : '';
    const override = gid ? cfg.chat?.groupContextMessages?.[gid] : undefined;
    const limit = Math.min(100, Math.max(0, Math.round(Number(override ?? cfg.chat?.contextMessages ?? 6))));
    if (!limit) return '';
    const arr = recentChat.get(key) ?? [];
    const tail = arr.slice(-limit);
    if (!tail.length) return '';
    const lines = tail.map((m) => `${m.sender}：${m.text}`).join('\n');
    return `【最近聊天记录（最近 ${tail.length} 条，仅用于理解上下文；不要逐条回应、不要复述，也不要把它当成新消息）】\n${lines}\n`
      + '【判断提示】结合上面的记录判断当前这句话是不是在说你：即使没叫你的名字，只要对方用「你 / 她 / 他 / 你的名字 / 你的 B站昵称」等指代你、或明显在议论你，就当成在跟你说话，正常回应，别装没看见。\n\n';
  }

  // ── 群聊生物钟（chat 模式）────────────────────────────────────────────────
  // 每个整点重新分配一次：这一小时内「在线（看群）」的总时长约占 40%，
  // 具体切成 1~2 段、放在这一小时的哪个位置，由它自己随机分配。
  // 被叫醒后额外在线 wakeWindowMs（默认 3 分钟）；其间没再被叫，就下线至少 offlineMinMs（默认 10 分钟）。
  const presence = new Map(); // key -> { windows, nextRoll, wokenUntil, online, lastProactiveAt }
  const HOUR_MS = 3_600_000;
  const hourStart = (ts) => { const d = new Date(ts); d.setMinutes(0, 0, 0); return d.getTime(); };

  function rollPresenceWindows(base) {
    const share = Math.max(0.05, Math.min(0.95, Number(cfg.chat?.presence?.onlineShare ?? 0.4)));
    // 总在线时长在 40% 上下浮动（0.85~1.15 倍），避免每个小时都一样机械
    const total = Math.round(HOUR_MS * share * (0.85 + Math.random() * 0.3));
    const half = HOUR_MS / 2;
    const twoBlocks = Math.random() < 0.4 && total > 4 * 60_000;
    if (!twoBlocks) {
      const start = base + Math.round(Math.random() * Math.max(0, HOUR_MS - total));
      return [{ start, end: start + total }];
    }
    // 两块：一块落在上半小时、一块落在下半小时，互不重叠
    const d1 = Math.max(90_000, Math.round(total * (0.35 + Math.random() * 0.3)));
    const d2 = Math.max(90_000, total - d1);
    const s1 = base + Math.round(Math.random() * Math.max(0, half - d1));
    const s2 = base + half + Math.round(Math.random() * Math.max(0, half - d2));
    return [{ start: s1, end: s1 + d1 }, { start: s2, end: s2 + d2 }];
  }

  const fmtHM = (ts) => new Date(ts).toTimeString().slice(0, 5);

  function presenceState(key) {
    const now = Date.now();
    let st = presence.get(key);
    if (!st) {
      const base = hourStart(now);
      st = { windows: rollPresenceWindows(base), nextRoll: base + HOUR_MS, wokenUntil: 0, online: false, lastProactiveAt: 0 };
      presence.set(key, st);
      log(`[生物钟] ${key} 本小时在线时段：${st.windows.map((w) => `${fmtHM(w.start)}~${fmtHM(w.end)}`).join('、')}`);
    }
    while (now >= st.nextRoll) {
      const base = st.nextRoll;
      st.nextRoll += HOUR_MS;
      st.windows = rollPresenceWindows(base);
      log(`[生物钟] ${key} 本小时在线时段：${st.windows.map((w) => `${fmtHM(w.start)}~${fmtHM(w.end)}`).join('、')}`);
    }
    const offlineMin = Number(cfg.chat?.presence?.offlineMinMs ?? 600_000);
    const cooling = st.wokenUntil > 0 && now >= st.wokenUntil && now < st.wokenUntil + offlineMin;
    st.online = st.wokenUntil > now
      ? true
      : (cooling ? false : st.windows.some((w) => now >= w.start && now < w.end));
    return st;
  }

  function wakePresence(key) {
    const st = presenceState(key);
    st.wokenUntil = Date.now() + Number(cfg.chat?.presence?.wakeWindowMs ?? 180000);
    st.online = true;
    return st;
  }

  // ── 主动搭话（在线时结合最近消息 @ 一个人）──────────────────────────────
  const pendingProactiveAt = new Map(); // key -> { qq, at }

  async function sendGroupWithAt(key, qq, text) {
    const [kind, id] = key.split(':');
    // 主动搭话不是对某条用户消息的回复，不进语料（5 分钟配对窗口内的会错配）
    if (kind !== 'group') return sendToQQ(key, text, { recordCorpus: false });
    // 主动搭话里也可能带表情包（Markdown 图片行）：统一交给出站管道拆，
    // 文字随 @ 发，图片/表情补发。
    const prepared = prepareReply(text, {
      platform: 'qq',
      group: true,
      cleanClutter: cfg.humanize?.cleanReply !== false,
      maxChars: GROUP_REPLY_MAX,
      stripPaths: true,
      transform: redactKnownTokensOnly,
    });
    const bodyText = prepared.text;
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    if (bodyText) {
      const body = {
        group_id: Number(id),
        message: [
          { type: 'at', data: { qq: String(qq) } },
          { type: 'text', data: { text: ` ${bodyText}` } }
        ]
      };
      const res = await fetch(`${httpUrl}/send_group_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.status !== 'ok' || payload.retcode !== 0) {
        throw new Error(`发送失败: ${payload.wording || payload.retcode || res.status}`);
      }
    }
    lastSendFailed.delete(key);
    for (const image of prepared.images) {
      try { await sendMarkdownImage(key, image); } catch (error) {
        log(`[表情] 图片发送失败 (${key})：${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
    if (prepared.stickerRefs[0]) await sendStickerRef(key, prepared.stickerRefs[0]);
    return { ok: true };
  }

  async function checkProactiveAt() {
    const conf = cfg.chat?.proactive;
    if (!conf || conf.enabled === false || !dshReady) return;
    if (currentMode !== 'chat') return;
    for (const key of [...presence.keys()]) {
      if (!key.startsWith('group:')) continue;
      const st = presenceState(key);
      if (!st.online) continue;
      if (Date.now() - Number(st.lastProactiveAt || 0) < Number(conf.minIntervalMs)) continue;
      const arr = recentChat.get(key) ?? [];
      if (arr.length < Number(conf.minMessages)) continue;
      if (!allowed('group', Number(key.split(':')[1]), cfg)) continue;
      st.lastProactiveAt = Date.now();
      pendingProactiveAt.set(key, { at: Date.now() });
      const sample = arr.slice(-30).map((m) => `${m.sender}：${m.text}`).join('\n');
      const promptText = '【主动搭话】你一直在群里潜水看大家聊天。结合下面最近的消息，挑一个你自己觉得有意思的点，主动说一句。\n'
        + '要求：用你自己的口吻（按人格卡），1~2 句，短、可爱；可以软软地轻微调侃，但不许刻薄、不许骂人。\n'
        + '如果你想 @ 某个人，就把回复写成「@QQ号 内容」，例如「@1000000003 omm今天好安静呀」；'
        + 'QQ 号从下面发送者名字后面的括号里查，不用 @ 就正常说。\n'
        + '不要解释，直接输出要说的话。\n\n'
        + `【最近的聊天】\n${sample}`;
      try {
        await deliverPrompt(key, promptText);
        log(`[搭话] 已投递 ${key}（由她自己决定要不要 @ 谁）`);
      } catch (error) {
        pendingProactiveAt.delete(key);
        log(`[搭话] 投递失败 ${key}：${error?.message ?? error}`);
      }
    }
  }

  function startProactiveScheduler() {
    if (cfg.chat?.proactive?.enabled === false) return;
    // 幂等：已在跑就不再叠一个 interval（见 proactiveTimer 的注释）。
    if (proactiveTimer) return;
    // 主动搭话循环以前 .catch(() => {})：presenceState/allowed 抛错时该轮无声消失，
    // 表现为"她偶尔不主动冒泡"且零留痕（2026-11-14 体检）
    proactiveTimer = setInterval(() => { checkProactiveAt().catch((error) => log(`[proactive] 搭话循环异常：${String(error?.message ?? error).slice(0, 160)}`)); }, 5 * 60 * 1000);
    proactiveTimer.unref?.();
    log(`[搭话] 已启动：每群每小时最多一次主动 @（至少 ${cfg.chat?.proactive?.minMessages ?? 10} 条上下文）`);
  }

  function currentRoleHintV2(key = '', personaMode = 'full') {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2', key, personaMode);
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算一代指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 认为是二代内容、
    // 这里却把一代指令漏进二代提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMetaCache = new Map(); // groupId -> { memberCount, name, ts }
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    // 仍然超限就按插入顺序（Map 保证是「最早写入优先」）批量裁到 800：
    // 旧实现只删 1 条，于是每来一条新引用都要整表扫一遍 + 反复贴着 1000 抖动。
    if (replyInfoCache.size > 1000) {
      for (const k of replyInfoCache.keys()) {
        if (replyInfoCache.size <= 800) break;
        replyInfoCache.delete(k);
      }
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    // 存储层的归一化**不能只留 kind/file/url/faceId**：reserved2 的图片/表情工具
    // （findMessageMedia → fetchOneBotImage / fetchMediaData）只从这里的产物取字段。
    // 丢了 emojiId/subType，fetchOneBotImage 的 isSticker 判定为假 ⇒ 市场/收藏表情会先走
    // 必然失败的 get_image、且 emoji_id 推出的 CDN 兜底整条失效（见 extractMediaFromSegments
    // 与「部分表情 20 秒超时」的根因）；丢了 summary，模型只看到「[图片1]」而不是「[表情:给你糖吃]」；
    // kind 被拍平还会让 mface（市场表情）被当成普通图片。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : 'image');
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = sanitizeMediaSummary(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `${ownerMessageTag()}管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      // 入站时就标记：后续群名/昵称/规则改了也不影响已经发生的判定。
      fish: !isOwner && isFishName(sender, cfg.fishGuard),
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    // 这里是**唯一的高频入口**（每条入站消息一次）：用合并写，300ms 窗口内多条消息
    // 只落盘一次。崩溃最多丢一个窗口（≤300ms）的入站缓冲；正常退出由 flush 钩子兜住。
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `${ownerMessageTag()}管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // 目的机制：这一发是不是「主动找主人」那一回合里真发出去的；是就记下来，回合结束记 sent。
    try { purpose.noteOutbound(key, list); } catch {}
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    flushSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  let groupPolicyCache = { key: '', value: normalizeGroupPolicy() };
  // 「永久不再显示」的限流提示（limit-mutes.json）。此前只有写入、没有读取函数，
  // POST /api/socialV2/limit-mute 一调就 ReferenceError（2026-11-14 全量体检）。
  function readLimitMutes() {
    const value = readJsonSafe(LIMIT_MUTE_FILE, { muted: {} });
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { muted: {} };
  }
  function readGroupPolicy() {
    try {
      const stat = fs.statSync(GROUP_POLICY_FILE);
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (groupPolicyCache.key === key) return groupPolicyCache.value;
      const raw = JSON.parse(fs.readFileSync(GROUP_POLICY_FILE, 'utf8'));
      groupPolicyCache = { key, value: normalizeGroupPolicy(raw) };
      return groupPolicyCache.value;
    } catch {
      return normalizeGroupPolicy();
    }
  }

  async function ensureGroupMeta(groupId) {
    const gid = String(groupId ?? '');
    if (!gid) return null;
    const hit = groupMetaCache.get(gid);
    if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit;
    try {
      const info = await bot.getGroupInfo(Number(gid));
      const meta = {
        memberCount: Number(info?.member_count ?? info?.memberCount ?? 0) || 0,
        name: String(info?.group_name ?? info?.groupName ?? '').trim(),
        ts: Date.now(),
      };
      groupMetaCache.set(gid, meta);
      if (groupMetaCache.size > 100) {
        for (const [k, v] of groupMetaCache) if (Date.now() - v.ts > 30 * 60 * 1000) groupMetaCache.delete(k);
      }
      return meta;
    } catch {
      groupMetaCache.set(gid, { memberCount: 0, name: '', ts: Date.now() });
      return null;
    }
  }

  function groupProfile(key, st) {
    const m = /^group:(\d+)$/.exec(String(key ?? ''));
    if (!m) return { tier: 'small', large: false, source: 'not-group', memberCount: 0, activityCount: 0 };
    const meta = groupMetaCache.get(m[1]) || null;
    const policy = readGroupPolicy();
    const activityCount = Array.isArray(st?.recentMessages)
      ? st.recentMessages.filter((msg) => msg && !msg.isSelf && Date.now() - Number(msg.time || 0) <= policy.activeWindowMs).length
      : 0;
    const tier = groupTier({ key, memberCount: meta?.memberCount || 0, activityCount, policy });
    return { ...tier, name: meta?.name || '', memberCount: meta?.memberCount || 0, activityCount };
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    const groupProfileNow = groupProfile(key, st);
    const large = groupProfileNow.large;
    if (tr.anyMessage && !large) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      // 用 plainContent（当前消息自己的文字）：textContent 含 `[引用 某人：原文]`，
      // 引用一条恰好提到机器人昵称的旧消息不该算「叫了名字」（那是被动触发的付费回合）。
      const lower = String(plainContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (!large && Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (!large && tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (!large && Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  /**
   * 本轮「还没看过」的未读：seq 高于模型已看水位。
   * 为什么需要它：回合进行中到的消息无法推进当前回合上下文（DSH 没有插话接口），
   * 只能在每个工具返回里提醒模型「还有 N 条没看，想看就现在调 wait/unread」，
   * 否则模型以为没消息，直接收尾，只能等 turn/end 再被唤醒一次（2026-10-31 用户反馈）。
   */
  function unseenUnreadV2(st) {
    const through = readThroughSeqV2(st);
    return (Array.isArray(st?.unread) ? st.unread : [])
      .filter((m) => m && m.isSelf !== true && Number.isSafeInteger(m.seq) && m.seq > through);
  }

  function unreadNoticeV2(st) {
    const unseen = unseenUnreadV2(st);
    if (!unseen.length) return null;
    return {
      unseenCount: unseen.length,
      unreadNotice: `还有 ${unseen.length} 条本轮还没看过的消息（seq ${unseen[0].seq}~${unseen[unseen.length - 1].seq}）。想看就现在调用 qq_wait_for_messages(purpose="messages") 或 qq_get_unread_messages，不要等下一轮。`,
    };
  }

  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  // 2026-10-26：唤醒快照只装"最近的一窗"，更早的未读被折叠。这段提示词必须讲清楚
  // "别回去逐条回"，否则模型看到 partial 就以为要先补读老消息。
  function wakeFoldedNoticeV2(folded) {
    if (!(Number(folded?.count) > 0)) return '';
    return `\n【更早的未读已折叠】${folded.count} 条更早的未读没有展开（本地 seq ${folded.fromSeq ?? '?'}–${folded.toSeq ?? '?'}）。它们只是背景，默认**不要**回头逐条回复；本次先跟上面快照里的最近消息走。确实需要背景时才用 qq_get_recent_messages 往前翻。`;
  }

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    // 2026-10-26：**从最近往回看**（PITFALLS #76）。
    // 旧版是 `st.unread.slice(0, maxUnread)`（最早的在前）：群里积压一多，被 @ 叫醒时
    // 她先看到的是十几条老消息、最新那条（也就是叫她的那条）反而进不了快照 ——
    // 表现就是"一进来先回老远的消息"。
    // 现在：窗口之外的**更早未读在唤醒时折叠**（从 buffer 摘掉并记进 packet.folded），
    // 只保留最近 maxUnread 条。这样既满足"从最近往回看"，又保住 readThroughSeq 的连续回执语义
    // （被折叠的消息低于 lowestBuffered，按既有规则可被越过，不会卡住 mark_read）。
    // 想恢复旧行为：`socialV2.context.wakeFoldOld = false`。
    let folded = null;
    if (context.wakeFoldOld !== false && v2ToolEnabled('getUnread') && st.unread.length > maxUnread) {
      const dropCount = st.unread.length - maxUnread;
      const dropped = st.unread.slice(0, dropCount);
      st.unread = st.unread.slice(dropCount);
      const first = dropped[0];
      const last = dropped[dropped.length - 1];
      folded = {
        count: dropCount,
        fromSeq: Number.isSafeInteger(first?.seq) ? first.seq : null,
        toSeq: Number.isSafeInteger(last?.seq) ? last.seq : null,
        fromAt: first?.at ?? first?.time ?? null,
        toAt: last?.at ?? last?.time ?? null,
      };
    }
    const packet = { messages: [], recent: [], unreadCount: st.unread.length, includedUnreadCount: 0, readThroughSeq: readThroughSeqV2(st), partial: st.unread.length > 0, folded };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      // 折叠掉的更早未读不能从这里"绕回来"（它们还留在 recentMessages 里）。
      // 只补比折叠范围更新的、且不在未读里的消息（= 已经读过的上下文）。
      const floorSeq = Number.isSafeInteger(folded?.toSeq) ? folded.toSeq : 0;
      const recent = st.recentMessages
        .filter((m) => !Number.isSafeInteger(m.seq) || (!unread.has(m.seq) && m.seq > floorSeq))
        .slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  // 机器人自己的身份（昵称 + QQ 号）。**必须显式写进 prompt**：
  // agent 能看到的消息里只有 "@樰" 这串文本，没人告诉它"樰"就是它自己，于是它会把
  // @自己 当成 @别人、已读不回（issue #29）。群名片可能与昵称不同，但 at/引用段里
  // 带的是 QQ 号，所以两条都给。
  function selfIdentityTextV2() {
    const name = String(selfDisplayName || '').trim();
    const id = String(selfUserId || '').trim();
    if (!name && !id) return '';
    const label = name ? `「${name}」` : '（昵称未取到）';
    const idText = id ? `（QQ ${id}）` : '';
    const callBits = name
      ? `消息里出现「@${name}」、有人叫「${name}」、或引用你的消息，指的都是你 —— 不要当成别人`
      : '被 @、被叫到你的昵称、或引用你的消息，指的都是你 —— 不要当成别人';
    return `【你的身份】你在 QQ 上的昵称是${label}${idText}。${callBits}；群名片可能与昵称不同，at/引用段里带${id ? ` ${id} ` : '你的 QQ 号'}就是在叫你。\n\n`;
  }

  // 把 QQ 昵称/号落给 B站 侧：B站 会话跑在插件进程里，拿不到网关登录信息，
  // 认「自己的 QQ 资料卡截图」就缺这两个锚点（2026-10-23 用户要求跨平台互认）。
  // 只在内容变化时写盘，失败不影响主流程（B站 侧读不到时会退化成只有 B站 锚点）。
  let lastSelfIdentityStamp = '';
  function saveQqSelfIdentity() {
    const payload = {
      nickname: String(selfDisplayName || '').trim(),
      userId: String(selfUserId || '').trim(),
      updatedAt: new Date().toISOString(),
    };
    if (!payload.nickname && !payload.userId) return;
    const stamp = `${payload.nickname}|${payload.userId}`;
    if (stamp === lastSelfIdentityStamp) return;
    try {
      atomicWriteJson(selfIdentityPath(STATE_DIR), payload);
      lastSelfIdentityStamp = stamp;
    } catch (error) {
      log(`写 state/self-identity.json 失败（不影响主流程）：${error?.message ?? error}`);
    }
  }

  function buildWakePromptV2(key, reason) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    // B站 记忆简报关掉时（biliBridge.memory.enabled=false），B站 侧的自我锚点会整段消失；
    // 那时补一份自我卡，保证「认得自己的 B站 主页」不依赖记忆同步开关。
    const biliMemoryOn = Boolean(cfg.biliBridge?.enabled) && cfg.biliBridge?.memory?.enabled !== false;
    const selfCardFallback = biliMemoryOn ? '' : buildSelfIdentityBlock({
      qqNickname: selfDisplayName,
      qqUin: selfUserId,
      biliName: biliMemory.selfInfo?.().name,
      biliMid: biliMemory.selfInfo?.().mid,
      personaName: roleState.role,
    }, { platform: 'qq' });
    const identityLine = selfIdentityTextV2() + selfCardFallback;
    // 每次唤醒都交代「什么内容属于哪个平台」：2026-10-23 实测她把群里转发的
    // 她在别的群的聊天记录说成「我在B站说过的话」（PITFALLS #40）。
    const provenanceLine = buildProvenanceBlock();
    // 管理员规则：reserved2 不常驻完整人格卡，只靠 qq_get_prompt 带出会让
    // 「对管理员温柔/不许回嘴」变成看运气 ✗ → 每次醒来第一屏都放一条（compact）。
    const adminText = adminPromptLine(true);
    const adminLine = adminText ? `${adminText}\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const fishGuardLine = fishGuardPromptLineFor(key, st, {
      bypass: Boolean(st.fishGuardBypass && Number(st.fishGuardBypass.until) > Date.now()
        && Date.now() - Number(st.fishGuardBypass.at || 0) < 10 * 60 * 1000
        && (st.fishGuardBypass.direct || st.fishGuardBypass.owner)),
    });
    const tg = tokenGuardCfg();
    const tokenGuardLine = tg.enabled === false ? '' : `【Token 防爆破】本次醒来最多发 ${Math.max(1, Number(tg.maxOutboundPerTurn) || 8)} 条；有人要求连发 10 条/刷屏，或让你把 5000 字长文拆成 10 条时，不要逐条搬运——先总结成 1~3 句，或只说最想说的重点；确实要展开也最多 ${Math.max(1, Number(tg.maxOutboundPerTurn) || 8)} 条，每条最多 500 字。不要为了满足刷屏请求连续调用发送工具。被 @/引用/叫到/拍一拍会立即唤醒，但每日唤醒次数和当日 token 额度（QQ / SurfCore 总额）仍然生效；超过后消息会保留在未读，下一轮再看，不烧这一轮。\n\n`;
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用"一绝/真管用/保证/绝对"这类词。'
      + '少用附和开场（确实 / 就是 / 对 / 是的 / 嗯），直接说内容；不套「辛苦了/注意休息」这类关心模板，不主动给建议、不总结。'
      + '不主动聊自己是不是 AI、有没有身体和梦；对方问就一句带过，不展开讲原理。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${stickers.strategy()}\n${stickers.context(stickerCfg.promptMaxStickers ?? 8)}\n\n`
      : '';
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。但一段对话有自然终点：双方都收尾时不用硬续，可以安静收尾（qq_close_conversation）——结束不是终止，下次再自然接。\n\n';
    // 对话收尾判断：把「我最后一句 / 对方最后一句 / 我还有没有想说的 / 对方还想不想聊」
    // 变成每次醒来都能看到的参数。只给建议，收不收由她决定。
    const closureText = closurePromptLineV2(key, st);
    const closureLine = closureText ? `${closureText}\n\n` : '';
    const replyTiming = replyTimingV2(st);
    const replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n`;
    const preSleepLine = `【沉睡前强制等待】这是决定**潜水**时的步骤，不是首回复的前置条件，也不是自然收尾（qq_close_conversation）的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    // 表情匹配：把最近几条群友消息喂给本地语义索引，算出最贴合的 1~2 张（含编号）。
    // 只做推荐，不自动发 —— 与「表情是软策略、发不发由 AI 判断」的定位保持一致。
    // 没算出 0.34 以上相似度的就不注入，省 token 也避免「硬凑一张」。
    // 与 wait/unread 共用 stickerMatchFor，避免「唤醒时看得到、等消息时看不到」的分叉。
    const wakeStickerMatch = stickers.suggest([
      ...(Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf).slice(-4),
      ...(Array.isArray(st.unread) ? st.unread : []).filter((m) => m && !m.isSelf).slice(-4)
    ]);
    const stickerMatchLine = wakeStickerMatch ? `${wakeStickerMatch.hint}\n\n` : '';
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 操作者预写的「初始提示词」（圈子主题/群内氛围等）：**只在首次唤醒**注入。
    // 放在最前面几段（角色/令牌之后）而不是末尾，是为了让它在长 prompt 里足够显眼；
    // 后续唤醒不再带它 —— 那时它已经在这条 DSH 会话的上下文里了。
    const initialPromptText = reason === 'bootstrap' ? formatInitialPromptV2(key) : '';
    const initialPromptLine = initialPromptText ? `${initialPromptText}\n\n` : '';
    // 二代模式不自动注入完整角色卡（让 AI 调 qq_get_prompt），但 B 站身份头必须每轮都在：
    // 否则群友问起「B站那个号」时，它会把自己当成另一个人。经历细节按需召回（biliRecall）。
    // 同一理由反过来：只有主人的私聊才带长期记忆，非主人会话不注入记忆卡/B站记忆。
    const isOwnerConv = Boolean(cfg.ownerQQ) && key === `private:${String(cfg.ownerQQ)}`;
    const biliIdentityHead = (text) => {
      const t = String(text ?? '').trim();
      const i = t.indexOf('最近在 B 站');
      return (i > 0 ? t.slice(0, i) : t).trimEnd();
    };
    const biliBrief = isOwnerConv && cfg.biliBridge?.enabled && cfg.biliBridge?.memory?.enabled !== false
      ? slimBrief(biliIdentityHead(biliMemory.briefBlock()), 400)
      : '';
    const biliRecall = isOwnerConv && lastMsg && cfg.biliBridge?.enabled && cfg.biliBridge?.memory?.enabled !== false
      ? biliMemory.recallBlock(String(lastMsg.text || lastMsg.plain || ''))
      : '';
    const biliLine = biliBrief || biliRecall ? `${biliBrief}${biliRecall ? `${biliRecall}\n` : ''}\n` : '';
    // 二代不自动注入完整角色卡，但记忆卡必须每轮都在：否则她记不起和主人的事。
    // 非主人会话用身份记忆版（初次相遇 + 锚点），仍然不暴露主人的私聊细节。
    // 记忆卡只带「身份记忆版」（初次相遇/锚点/公开近况，天然较小）；主人私聊的
    // 细节与全部记忆按需：每条消息的召回 + 模型的 memory_search 工具。
    const memoryCardText = memoryCardPromptBlock(MEMORY_CARD_PATHS.promptBili);
    const memoryCardLine = memoryCardText ? `${memoryCardText}\n\n` : '';
    const base = roleLine + identityLine + provenanceLine + adminLine + biliLine + memoryCardLine + tokenLine + initialPromptLine + antiAiLine + proactiveLine + closureLine + stickerLine + stickerMatchLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + fishGuardLine + tokenGuardLine + preSleepLine;
    lastWakePromptMeta = {
      role: roleLine.length,
      identity: identityLine.length,
      provenance: provenanceLine.length,
      admin: adminLine.length,
      bili: biliLine.length,
      memory: memoryCardLine.length,
      token: tokenLine.length,
      initialPrompt: initialPromptLine.length,
      antiAi: antiAiLine.length,
      proactive: proactiveLine.length,
      closure: closureLine.length,
      sticker: stickerLine.length,
      stickerMatch: stickerMatchLine.length,
      reply: replyLine.length,
      status: statusLine.length,
      wake: wakeLine.length,
      memoryStatus: memoryLine.length,
      participation: participationLine.length,
      fishGuard: fishGuardLine.length,
      tokenGuard: tokenGuardLine.length,
      preSleep: preSleepLine.length,
      base: base.length,
    };
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n先看有没有人回。如果没人回，这段对话可能已经自然结束：不用硬补一句，也不用为了收尾去等 5 分钟沉睡前观察——直接判断，还有想说的就回，没有就 qq_close_conversation 自然收尾（不是潜水，唤醒配置不变）。如果有人回你，先看【对话收尾判断】再决定接不接；需要确认对方是否说完，用 qq_wait_for_messages(purpose="reply")。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'history') {
      return `${base}【上线补历史】${key}\n原因：你刚上线，桥接用 QQ 历史记录把离线期间错过的消息补进了未读（消息带 history=true；若本次快照没内联，可调用 qq_get_context_snapshot(include=["unread"]) 查看）。\n先快速扫一遍补上下文；这些是已经发生的旧消息，除非仍然相关，不要逐条回复或引用，也不要当成刚刚发生。看完可以用 qq_mark_read 或 qq_set_wake_config 安静收尾。`;
    }
    if (reason === 'backlog') {
      return `${base}【启动补唤醒】${key}
原因：桥接重启后，这个会话还积压着重启前的未读消息（之前没人唤醒它们）。
先调用 qq_get_context_snapshot(include=["unread"]) 看一遍，判断是否还需要回应；如果只是旧话题，用 qq_mark_read 清掉即可，不用逐条回应。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。开口前先看【对话收尾判断】：判断这段已自然结束时，不用再补一句，直接 qq_close_conversation 收尾。`;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = selfIdentityTextV2();
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${identityLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    const stForGuard = getSocialV2State(key);
    const autoWake = ['proactiveCheck', 'timeout', 'replyCheck', 'history', 'bootstrap'].includes(String(reason));
    const channel = qqSendChannelStatus();
    if (!channel.ok) {
      if (!stForGuard.channelGateLoggedAt || Date.now() - stForGuard.channelGateLoggedAt > 10 * 60 * 1000) {
        stForGuard.channelGateLoggedAt = Date.now();
        log(`[channel-gate] 跳过唤醒 ${key}（${reason}）：${channel.reason}；不创建 DSH 会话，避免空烧 token`);
      }
      return;
    }
    if (autoWake) {
      if (Number(stForGuard.wakeSuspendedUntil) > Date.now()) {
        if (!stForGuard.channelGateLoggedAt || Date.now() - stForGuard.channelGateLoggedAt > 10 * 60 * 1000) {
          stForGuard.channelGateLoggedAt = Date.now();
          log(`[channel-gate] 跳过唤醒 ${key}（${reason}）：发送失败后暂停中，约 ${Math.ceil((stForGuard.wakeSuspendedUntil - Date.now()) / 60000)} 分钟后重试`);
        }
        return;
      }
    }
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = stForGuard;
    // 鱼群保护：定时器/主动机会在保护期内不唤醒；只有人类 @/名字/提问/拍一拍且已记录 bypass 才放行。
    const bypass = st.fishGuardBypass && Number(st.fishGuardBypass.until) > Date.now()
      && Date.now() - Number(st.fishGuardBypass.at || 0) < 10 * 60 * 1000
      && (st.fishGuardBypass.direct || st.fishGuardBypass.owner);
    const fishWake = evaluateConversationFishGuard(key, st, {
      directAddress: Boolean(bypass),
      isOwner: Boolean(st.fishGuardBypass?.owner && bypass),
    });
    if (fishWake.blocked) {
      log(`[鱼群保护] 跳过唤醒 ${key}（${reason}）：${fishGuardReasonText(fishWake) || '保护冷却中'}`);
      return;
    }
    // Token 防爆破：鱼群守则之后、真正投递之前。被拦时消息保留在未读，不烧模型回合。
    const groupProfileNow = groupProfile(key, st);
    const directWake = groupProfileNow.large
      ? (isHardDirectWakeReason(reason) || hasStrictDirectUnread(st.unread, { selfNickname }))
      : (isSmallGroupDirectWake(reason) || fishGuardDirectUnread(st) || fishGuardOwnerUnread(st) || Boolean(bypass));
    const tokenWake = tokenGuardWakeBlock(key, st, { direct: directWake });
    if (tokenWake) {
      logThrottled(`token-guard:${key}`, 10 * 60_000, `[token-guard] 跳过唤醒 ${key}（${reason}）：${tokenWake.error}`);
      // 额度/次数/花费这类「今天没戏了」的拦截要让人知道，否则被 @ 也永远没反应。
      // gap 类（两次唤醒间隔太短）不提示，避免刷屏。
      if (['day', 'cost', 'budget'].includes(String(tokenWake.reason))) {
        notifyQuotaBlocked(key, reason, tokenWake);
      }
      if (tokenWake.retryAfterMs > 0 && !st.tokenRetryTimer) {
        const cap = tokenWake.reason === 'day' ? 10 * 60_000 : 60_000;
        const waitMs = Math.min(cap, Math.max(1000, Math.round(tokenWake.retryAfterMs)));
        st.tokenRetryTimer = setTimeout(() => {
          st.tokenRetryTimer = null;
          if (!isTimerWakeReason(reason) && !(Array.isArray(st.unread) && st.unread.length > 0)) return;
          void sendWakePromptV2(key, reason).catch((error) => log(`[token-guard] 重试唤醒异常 ${key}:`, error?.message ?? error));
        }, waitMs);
        st.tokenRetryTimer.unref?.();
      }
      return;
    }
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    // 唤醒频率硬限制：超限则**延后重试**，不能直接丢弃。直接 return 的后果：
    //   · timeout 唤醒时 setupSleepTimerV2 已经清空 sleepTimer，丢弃后这个会话会停在
    //     「infinite=false、sleepUntil 已过期、没有任何定时器」的静默态，除非重启或
    //     主动机会兜底（默认 30~90 分钟）才可能恢复；
    //   · @/提问被丢弃则要等下一条消息才可能再唤醒。
    // 重试仍然遵守限频（等到窗口腾出位置），只是把「这一枪」补回来。
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    // 被直接 @ / 叫到 / 引用 / 拍一拍时，强制实时唤醒：越过 2 分钟间隔和旧的 1 分钟/12 小时限频。
    // 仍然受 Token 的每日次数与近 24h 花费上限约束，不能靠 @ 无限烧。
    const directBypass = directWake && tokenGuardCfg().enabled !== false && tokenGuardCfg().directBypassGap !== false;
    if (!directBypass && ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour))) {
      let retryAfterMs = 0;
      if (maxPerMinute > 0 && recentMinute >= maxPerMinute) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 60000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 60000 - (now - times[0]) + 500);
      }
      if (maxPerHour > 0 && recentHour >= maxPerHour) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 3600000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 3600000 - (now - times[0]) + 500);
      }
      // 每次只等一小段（最长 60s）：小时级限频不会一次性睡满一小时而错过中途可用的窗口。
      const waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterMs) || 5000));
      if (!st.rateLimitRetryTimer) {
        st.rateLimitRetryTimer = setTimeout(() => {
          st.rateLimitRetryTimer = null;
          // 消息类原因在重试前再确认一次：等待窗口里消息可能已被别的回合处理掉，
          // 没必要为一条已经处理过的消息再唤醒一次（定时器类原因与未读无关，不检查）。
          if (!isTimerWakeReason(reason) && !(Array.isArray(st.unread) && st.unread.length > 0)) {
            log(`[reserved2] 限频重试前发现未读已清空，跳过 ${key}（${reason}）`);
            return;
          }
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 限频重试唤醒异常 ${key}:`, error?.message ?? error));
        }, waitMs);
        st.rateLimitRetryTimer.unref?.();
      }
      log(`[reserved2] 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${key}（${reason}）`);
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    resetTokenTurn(st);   // 新的一轮醒来，重新给最多 N 条额度
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    flushSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      flushSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          flushSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
        notifyWakeFailure(key, reason, result.error || '投递被拒绝');
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        flushSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
      notifyWakeFailure(key, reason, error);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 刚自然收尾：30 秒后的例行回复检查只会把她自己叫醒，直接跳过。
    if (closureSuppressesWake(st.closure, 'replyCheck', Date.now())) {
      log(`[收尾] ${key} 冷却中，跳过回复检查`);
      return;
    }
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  /** 会话此刻算忙的具体原因（只用于日志，避免排查时只能反复重启加猜）。 */
  function busyReasonV2(key, st) {
    if (st?.pendingWakeTimer) return 'pendingWakeTimer';
    if (pendingWakeKeys.has(key)) return 'pendingWakeKey';
    const q = promptQueues.get(key);
    if (q?.running) return 'promptRunning';
    if (q && q.queue.length > 0) return 'promptQueued';
    const sid = state.sessions[key];
    if (sid) {
      const startedAt = Number(v2TurnStartAt.get(sid));
      if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < TURN_BUSY_LEASE_MS) return 'turn';
    }
    return 'unknown';
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (!sid) return false;
    // 回合只按「起始时间 + 租约」判忙，**不再**只看 Map 里有没有键：
    //   · 有 collector 但没起始时间（杂散事件重建出来的）→ 无法证明还活着，不判忙；
    //   · 起始时间超过租约（turn/end 丢了 / DSH 重启把回合丢了）→ 不判忙；
    // collector 保留，所以万一回合其实还活着，它的回复仍会被 flush，只是允许新唤醒排队。
    const startedAt = Number(v2TurnStartAt.get(sid));
    const hasTurn = Number.isFinite(startedAt) && startedAt > 0;
    const collector = collectors.has(sid);
    if (!hasTurn) return false;
    if (Date.now() - startedAt < TURN_BUSY_LEASE_MS) return true;
    if (collector && !turnLeaseNoted.has(sid)) {
      turnLeaseNoted.add(sid);
      log(`[reserved2] 回合判忙租约已过期（${sid}，起始 ${Math.round((Date.now() - startedAt) / 60000)} 分钟前），解除忙碌；collector 保留，迟到回复仍会 flush`);
    }
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    // 上线补历史：比主动机会重要，但低于任何“有人正在说话”的原因；
    // 合并窗口里如果同时来了真实消息，会升级成消息类原因，历史仍留在快照里。
    history: 25,
    backlog: 22,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // 与「未读消息」无关的唤醒原因（定时器/引导/上线补历史）。这些原因在会话繁忙时被暂存后，
  // 不能用「unread 里还有没有对应 seq」来判断是否还要补发 —— 那一轮很可能已经把
  // 未读全部标读了，结果就是 timeout 定时器被静默丢掉、会话停在无定时器的静默态。
  const TIMER_WAKE_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin', 'history', 'backlog']);
  function isTimerWakeReason(reason) {
    return TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  /**
   * 回合结束后补发「繁忙期间暂存」的唤醒原因。
   *
   * 两类原因必须分开处理：
   *   · 消息类（@/关键词/提问/私聊/拍一拍…）只有在那条消息还没被本回合处理掉时才补发
   *     （unread 里还能找到它的 seq）；
   *   · 定时器类（timeout/replyCheck/proactiveCheck/bootstrap/admin）与未读水位无关：
   *     那一轮很可能已经把未读全部标读，用 unread 判断会让「到点唤醒」被静默吞掉 ——
   *     timeout 时 sleepTimer 已被清空，结果是会话停在「sleepUntil 已过期、无任何定时器」。
   */
  function replayPendingWakeReasonsV2(key) {
    const st = getSocialV2State(key);
    if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return null;
    const item = st.pendingWakeReasons.shift();
    if (!item || typeof item !== 'object') return null;
    if (isTimerWakeReason(item.reason)) {
      if (item.reason === 'timeout') {
        log(`[reserved2] ${key} 补收繁忙期间到期的潜水定时器`);
        setupSleepTimerV2(key);
      } else if (item.reason === 'replyCheck') {
        log(`[reserved2] ${key} 补排繁忙期间的回复检查`);
        scheduleReplyCheckV2(key);
      } else if (item.reason === 'proactiveCheck') {
        // 主动机会有周期性重排，错过一次可接受（也不该在回合结束时立刻补一刀）。
        log(`[reserved2] ${key} 繁忙期间的主动机会已过期，跳过补发`);
      } else {
        log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}`);
        scheduleWakeV2(key, item.reason);
      }
      return { reason: item.reason, action: 'timer' };
    }
    const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
    if (stillRelevant) {
      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
      scheduleWakeV2(key, item.reason);
      return { reason: item.reason, action: 'replayed' };
    }
    log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
    return { reason: item.reason, action: 'skipped' };
  }

  // ── 离线补课（内置版 / chat 模式）────────────────────────────────────────
  // 二代有 unread + 唤醒；一代聊天没有这个状态：DSH 一退出，SnowLuma 不会补推，
  // 消息只留在 QQ 服务端。这里在 DSH 就绪后，对「来过消息且仍在白名单」的会话
  // 拉最近历史，把上次水位之后的别人消息合成一轮提示投给模型。
  // 首次运行没有水位时只看最近 6 小时，避免把很久以前的聊天翻出来重回。
  const CHAT_HISTORY_MAX = 8;
  const CHAT_HISTORY_WINDOW_MS = 6 * 3600_000;
  const CHAT_HISTORY_FILE = path.join(STATE_DIR, 'chat-history-cursor.json');
  let chatHistoryRunning = null;
  let chatHistoryCheckedAt = 0;
  let chatHistoryDone = false;

  function chatHistoryTargets() {
    const keys = new Set(Object.keys(knownConversations));
    for (const kind of ['group', 'private']) {
      const list = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
      for (const id of Array.isArray(list) ? list : []) {
        const text = String(id ?? '').trim();
        if (/^\d+$/.test(text)) keys.add(`${kind}:${text}`);
      }
    }
    return [...keys].filter((key) => /^(group|private):\d+$/.test(key)).slice(0, 20);
  }

  async function chatHistoryTextOf(raw) {
    const segments = Array.isArray(raw?.message) ? raw.message : [];
    if (!segments.length) return '';
    try {
      const text = await segmentsToText(segments, { includeReply: false });
      return truncateText(String(text ?? '').trim(), 160);
    } catch { return ''; }
  }

  async function runChatHistoryCatchUp(trigger) {
    if (!dshReady || currentMode === 'reserved2' || currentMode === 'closed-agent') return null;
    if (!historyCatchUpConfig().enabled) return null;
    if (chatHistoryDone) return null;   // 每次桥接启动只补一次，别每 10 秒翻一遍历史
    // 先等登录拿到自己的 QQ 号，否则会把自己以前发的话当成别人说的再回一遍。
    if (!String(selfUserId || '').trim()) return null;
    if (chatHistoryRunning) return chatHistoryRunning;
    const now = Date.now();
    if (now - chatHistoryCheckedAt < HISTORY_CATCHUP_THROTTLE_MS) return null;
    chatHistoryCheckedAt = now;
    chatHistoryRunning = (async () => {
      const loaded = readJsonSafe(CHAT_HISTORY_FILE, {}, false);
      const map = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
      const self = String(selfUserId || '').trim();
      let total = 0;
      let fetchedAny = false;
      for (const key of chatHistoryTargets()) {
        const match = /^(group|private):(\d+)$/.exec(key);
        if (!match) continue;
        if (!isSessionAllowedInCurrentMode(key)) continue;
        const kind = match[1];
        const id = match[2];
        const previous = Number(map[key] ?? 0);
        const floor = previous > 0 ? previous : now - CHAT_HISTORY_WINDOW_MS;
        const raws = await fetchOneBotHistory(kind, id, 20);
        if (!raws) continue;
        fetchedAny = true;
        const missed = [];
        let newest = previous;
        for (const raw of raws) {
          const senderId = String(raw?.sender?.user_id ?? raw?.user_id ?? '').trim();
          const time = Number(raw?.time) > 0 ? Number(raw.time) * 1000 : 0;
          if (time > newest) newest = time;
          if (!time || time <= floor) continue;
          if (self && senderId === self) continue;
          if (senderBlocked(senderId, cfg.deny?.users)) continue;
          const text = await chatHistoryTextOf(raw);
          if (!text) continue;
          missed.push({ name: String(raw?.sender?.card || raw?.sender?.nickname || senderId || '有人'), text });
        }
        // 水位只往前走，且不能低于本次的起点 floor：否则首次运行看到的全是很久以前
        // 的历史时，会把水位写回过去，下次启动又把这些老消息当「刚错过」补一遍。
        map[key] = Math.max(newest, floor);
        // 退出前已经排进待投递队列的，以队列为准，别重复补一遍。
        if ((queued.get(key)?.length ?? 0) > 0) continue;
        if (!missed.length) continue;
        const lines = missed.slice(-CHAT_HISTORY_MAX).map((item) => `${item.name}：${item.text}`).join('\n');
        const prompt = [
          `【离线期间的消息】${key}`,
          '你刚才不在线（DSH 关闭或重启），下面是这段时间里收到、你没看到的消息，按时间顺序：',
          lines,
          '现在你重新上线了。看完自然接一下最后还在聊的话题：',
          '- 不要逐条回复、不要复述这些消息、不要解释你刚下线/刚重启；',
          '- 群里没人叫你、或者没什么想说的，只输出 [SILENT]，不要硬接；不要写「没叫我 / 不接」这种说明；',
          '- 私聊里对方在等你，就正常回一句。',
        ].join('\n');
        try {
          const result = await deliverPrompt(key, prompt, { silent: true });
          if (result?.ok) total += Math.min(missed.length, CHAT_HISTORY_MAX);
        } catch (error) { log(`[history] ${key} 离线补课投递失败：${error?.message ?? error}`); }
      }
      try { atomicWriteJson(CHAT_HISTORY_FILE, map); } catch { /* 下次再写 */ }
      // 一个历史接口都没通（SnowLuma 还没就绪）就不算补完，下次检查再试。
      if (fetchedAny) chatHistoryDone = true;
      if (total) log(`[history] 离线补课完成（${trigger}）：补看 ${total} 条`);
      return total;
    })().catch((error) => {
      log(`[history] 离线补课异常：${error?.message ?? error}`);
      return 0;
    }).finally(() => { chatHistoryRunning = null; });
    return chatHistoryRunning;
  }

  // ── 上线补历史消息（socialV2.history） ──────────────────────────────────
  //
  // 用户需求（2026-10-24）：每次上线查看历史消息，防止错过群友在掉线期间发的消息；
  // 设置里可关，默认勾选打开。
  //
  // 为什么必须用历史接口：SnowLuma 只在 WebSocket 在线时推送消息，桥接/QQ 掉线期间
  // 的消息不会补发；它们只存在 QQ 服务端。桥接启动或 QQ 账号重新上线时，对**已经在
  // 二代状态里、且完成过首次唤醒**的白名单会话各取最近 N 条，按 messageId + 时间水位
  // 去重后并入 unread（标 history=true）。只补历史、不重复走 handleIncoming，
  // 所以不会触发鱼群/黑话/唤醒触发器的二次判定（唤醒由这里单独调度一次）。
  const HISTORY_CATCHUP_THROTTLE_MS = 10_000;
  const historyFetchErrorAt = new Map();
  // 按 action 记录「这个运行时没实现」：群历史可用但好友历史不可用时，不能一起关掉。
  const historyApiUnsupported = new Set();
  let historyCatchUpRunning = null;
  let historyCatchUpStartedAt = 0;

  function historyCatchUpConfig() {
    return normalizeHistoryConfig(cfg.socialV2?.history);
  }

  function historyCatchUpTargets(conf) {
    const targets = [];
    for (const [key, st] of socialV2.conversations) {
      // 没完成首次唤醒的会话不补：bootstrap 提示词还没发过，直接补历史会让模型
      // 在缺少二代协议说明的情况下被唤醒。等它先正常醒过一次再说。
      if (!st || st.bootstrapSent !== true) continue;
      const match = /^(group|private):(\d+)$/.exec(key);
      if (!match) continue;
      const kind = match[1];
      if (kind === 'private' && conf.includePrivate === false) continue;
      if (!isSessionAllowedInCurrentMode(key)) continue;
      targets.push({ key, kind, id: match[2] });
    }
    return targets;
  }

  async function fetchOneBotHistory(kind, id, count) {
    const action = kind === 'private' ? 'get_friend_msg_history' : 'get_group_msg_history';
    if (historyApiUnsupported.has(action)) return null;
    const params = kind === 'private'
      ? { user_id: Number(id), count }
      : { group_id: Number(id), count };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
        const wording = String(body.wording ?? body.message ?? '');
        if (!historyApiUnsupported.has(action) && (res.status === 404 || res.status === 405
          || /not\s*(support|implement)|unsupported|unknown action/i.test(wording))) {
          historyApiUnsupported.add(action);
          log(`⚠️ 当前 SnowLuma 未实现 ${action}，上线补历史已跳过该接口（不影响正常收消息）`);
        } else if (!historyApiUnsupported.has(action)) {
          // 断线重连风暴时同一个错误会反复出现；每个 action 最多 5 分钟报一次。
          const now = Date.now();
          if (now - (historyFetchErrorAt.get(action) || 0) > 300_000) {
            historyFetchErrorAt.set(action, now);
            log(`[history] ${action} ${kind}:${id} 失败：${wording || `HTTP ${res.status}`}`);
          }
        }
        return null;
      }
      return Array.isArray(body.data?.messages) ? body.data.messages : [];
    } catch (error) {
      const now = Date.now();
      if (now - (historyFetchErrorAt.get(action) || 0) > 300_000) {
        historyFetchErrorAt.set(action, now);
        log(`[history] ${action} ${kind}:${id} 请求异常：${error?.message ?? error}`);
      }
      return null;
    }
  }

  async function historyCandidateFromRaw(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const segments = Array.isArray(raw.message) ? raw.message : (typeof raw.message === 'string' ? raw.message : []);
    let text = '';
    let plain = '';
    try {
      // 历史消息里的引用/at 不在这里解析（解析器会逐条打网关）；引用用占位符即可，
      // 真要看那条消息 AI 仍可按 messageId 调 qq_get_message_detail。
      text = await segmentsToText(segments, { includeReply: true });
      plain = await segmentsToText(segments, { includeReply: false });
    } catch {}
    const senderInfo = raw.sender && typeof raw.sender === 'object' ? raw.sender : {};
    const senderId = String(senderInfo.user_id ?? raw.user_id ?? '').trim();
    const self = String(selfUserId || '').trim();
    const isSelf = Boolean(self) && senderId === self;
    const sender = isSelf ? '我' : (String(senderInfo.card || senderInfo.nickname || '').trim() || senderId || '未知');
    const messageIdRaw = raw.message_id ?? raw.real_id ?? raw.message_seq;
    const messageId = messageIdRaw != null ? String(messageIdRaw).trim() : '';
    const time = Number(raw.time) > 0 ? Number(raw.time) * 1000 : 0;
    if (!messageId || !time) return null;
    const media = extractMediaFromSegments(segments);
    const forwardIds = extractForwardIds(Array.isArray(segments) ? segments : []);
    const isOwner = Boolean(cfg.ownerQQ) && senderId === String(cfg.ownerQQ);
    return {
      messageId,
      time,
      userId: senderId || null,
      sender,
      text: truncateText(text || '[消息]', 200),
      plain: truncateText(plain || text || '[消息]', 200),
      tail: truncateTextTail(plain || text || '', 200),
      isSelf,
      isOwner,
      fish: !isSelf && !isOwner && isFishName(sender, cfg.fishGuard),
      media,
      forwardIds
    };
  }

  function appendHistoryCatchupV2(key, candidates, { trigger = 'online', watermark = 0, maxAgeMs, fetched = 0 } = {}) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const existingIds = new Set();
    for (const message of [...(st.recentMessages || []), ...(st.unread || [])]) {
      const id = String(message?.messageId ?? '').trim();
      if (id) existingIds.add(id);
    }
    const picked = selectMissedHistory(candidates, {
      watermark,
      maxAgeMs,
      limit: historyCatchUpConfig().limit,
      existingIds,
      blockedUsers: cfg.deny?.users ?? []
    });
    const caughtUpAt = Date.now();
    for (const candidate of picked) {
      const media = Array.isArray(candidate.media) ? candidate.media.slice(0, 20) : [];
      const forwardIds = Array.isArray(candidate.forwardIds) ? candidate.forwardIds.slice(0, 20) : [];
      const msg = {
        seq: null,
        messageId: candidate.messageId,
        sender: candidate.sender,
        userId: candidate.userId,
        text: candidate.text,
        plain: candidate.plain,
        tail: candidate.tail,
        quoteTargetIsSelf: false,
        isOwner: candidate.isOwner,
        ownerLabel: candidate.isOwner ? `${ownerMessageTag()}管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
        isSelf: candidate.isSelf,
        history: true,
        fish: candidate.fish,
        media,
        hasMedia: media.length > 0,
        forwardIds,
        hasForward: forwardIds.length > 0,
        time: candidate.time
      };
      if (candidate.isSelf) {
        // 自己以前发的消息只进 recent 帮助理解上下文，不进未读（不需要“处理”）。
        st.recentMessages.push(msg);
        continue;
      }
      msg.seq = (st.lastUnreadSeq || 0) + 1;
      st.lastUnreadSeq = msg.seq;
      st.recentMessages.push(msg);
      st.unread.push(msg);
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    // 水位按「本次看到的最新历史消息」推进（而不是 now）：历史接口返回后、下一次检查前
    // 到达的消息时间一定更大，不会被误跳；同一批消息也不会二次灌入。
    // 未来时间（时钟漂移/异常网关）不参与水位，否则会把之后正常的消息全跳过去。
    const newestFetched = (Array.isArray(candidates) ? candidates : [])
      .reduce((max, item) => {
        const time = Number(item?.time) || 0;
        return time > 0 && time <= caughtUpAt ? Math.max(max, time) : max;
      }, 0);
    if (newestFetched > (st.lastHistoryMessageTime || 0)) st.lastHistoryMessageTime = newestFetched;
    st.lastHistoryCheckedAt = caughtUpAt;
    const summary = summarizeHistoryCatchup(picked);
    st.lastHistoryCatchup = {
      at: new Date(caughtUpAt).toISOString(),
      trigger,
      fetched: Number(fetched) || 0,
      ...summary
    };
    flushSocialV2State();
    return summary;
  }

  async function catchUpHistoryForConversation({ key, kind, id }, conf, trigger) {
    const st = getSocialV2State(key);
    const maxAgeMs = conf.maxAgeMinutes * 60_000;
    // 水位必须在 fetch 之前算：fetch 期间可能来实时消息，把 lastIncomingAt 推到现在；
    // 如果 fetch 后再算，会把真正错过的历史消息误判成“太旧”而丢掉。
    const watermark = historyWatermark(st, { now: Date.now(), maxAgeMs });
    const raw = await fetchOneBotHistory(kind, id, conf.limit);
    if (!raw) return { key, ok: false };
    const candidates = [];
    for (const item of raw) {
      const candidate = await historyCandidateFromRaw(item);
      if (candidate) candidates.push(candidate);
    }
    if (!candidates.length) {
      return { key, ok: true, fetched: 0, incoming: 0, self: 0, total: 0, wakeScheduled: false };
    }
    const summary = appendHistoryCatchupV2(key, candidates, { trigger, watermark, maxAgeMs, fetched: candidates.length });
    let wakeScheduled = false;
    if (summary.incoming > 0 && conf.wake !== false) {
      scheduleWakeV2(key, 'history');
      wakeScheduled = true;
    }
    if (summary.total > 0) {
      log(`[history] ${key} 补回 ${summary.incoming} 条群友消息 / ${summary.self} 条自己的旧消息（${trigger}）`);
    }
    return { key, ok: true, fetched: candidates.length, ...summary, wakeScheduled };
  }

  async function runHistoryCatchUp(trigger = 'online', { force = false } = {}) {
    const conf = historyCatchUpConfig();
    if (!conf.enabled) return { ok: true, disabled: true, results: [] };
    if (currentMode !== 'reserved2' || cfg.socialV2?.enabled === false) {
      return { ok: true, skipped: 'mode', results: [] };
    }
    // 没有自己的 QQ 号时无法区分「群友」和「自己以前发的消息」；宁可等下一次
    // （open 的 getLoginInfo 完成后会再触发一次），也不要先把历史消息错灌进未读。
    if (!String(selfUserId || '').trim()) {
      return { ok: true, skipped: 'no-self-id', results: [] };
    }
    if (historyCatchUpRunning) return historyCatchUpRunning;
    const now = Date.now();
    if (!force && now - historyCatchUpStartedAt < HISTORY_CATCHUP_THROTTLE_MS) {
      return { ok: true, throttled: true, results: [] };
    }
    historyCatchUpStartedAt = now;
    historyCatchUpRunning = (async () => {
      const targets = historyCatchUpTargets(conf);
      const results = [];
      for (const target of targets) {
        try {
          results.push(await catchUpHistoryForConversation(target, conf, trigger));
        } catch (error) {
          results.push({ key: target.key, ok: false, error: error?.message ?? String(error) });
          log(`[history] ${target.key} 补历史异常：${error?.message ?? error}`);
        }
      }
      const summary = results.reduce((acc, item) => ({
        incoming: acc.incoming + (Number(item?.incoming) || 0),
        self: acc.self + (Number(item?.self) || 0),
        total: acc.total + (Number(item?.total) || 0)
      }), { incoming: 0, self: 0, total: 0 });
      if (summary.total > 0) {
        log(`[history] 上线补历史完成（${trigger}）：${results.filter((item) => Number(item?.total) > 0).length} 个会话，共 ${summary.total} 条`);
      }
      return { ok: true, trigger, targets: targets.length, results, ...summary };
    })().finally(() => { historyCatchUpRunning = null; });
    return historyCatchUpRunning;
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等一小段后重新续期，
    // 而不是提前唤醒。这里刻意用 100 秒级的小步长（而不是 24 天的上限）：
    // 每次续期都会用 Date.now() 重新算剩余时间，系统时钟被校正/跳变时能很快纠正过来。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 1000)} 秒后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (Number(st.wakeSuspendedUntil) > Date.now()) return;
    if (!qqSendChannelStatus().ok) return;
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      // 刚自然收尾：这一次主动机会先不发，等冷却过去再按原节奏重排。
      if (closureSuppressesWake(st.closure, 'proactiveCheck', Date.now())) {
        log(`[收尾] ${key} 冷却中，跳过本次主动机会`);
        scheduleProactiveCheckV2(key);
        return;
      }
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (st.rateLimitRetryTimer) {
      clearTimeout(st.rateLimitRetryTimer);
      st.rateLimitRetryTimer = null;
    }
    if (st.tokenRetryTimer) {
      clearTimeout(st.tokenRetryTimer);
      st.tokenRetryTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
    // 连续等待计数也必须清：它按会话 key 记账，只在「等到消息」时删除。会话重置/模式
    // 切换（本函数就是这两条路径的清理点）之后计数若留着，新回合第 3 次 wait 会被
    // 直接判成 consecutive-wait-limit 而拿不到长轮询 —— 看起来像「刚 reset 就坏了」。
    // 注意：**不清 activeWaits**。那是长轮询租约，在途 handler 自己会释放/超时；
    // 强行清掉会让同一会话同时跑两个等待，反而可能重复交付同一条消息。
    waitStreaks.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // 记忆方式：facts（默认）= 只记重要的事，不把聊天流水当记忆；chatlog = 旧行为。
  const MEMORY_EXPLICIT = /(记住|记一下|记着|别忘了|写进记忆|保存到记忆|你记得|帮我记)/;
  const MEMORY_FACT = /(喜欢|讨厌|不喜欢|打算|计划|约定|答应|以后|生日|纪念日|名字|叫我|工作|上班|学校|考试|考研|搬家|养了|生病|吃药|结婚|分手|在一起|习惯|忌口|过敏|梦想|害怕)/;
  function memoryRecordMode() {
    try { return loadConfig()?.memory?.recordMode === 'chatlog' ? 'chatlog' : 'facts'; } catch { return 'facts'; }
  }
  function memoryWorthRecording(text, { isOwner, direct }) {
    if (memoryRecordMode() === 'chatlog') return true;
    const body = String(text ?? '').trim();
    if (MEMORY_EXPLICIT.test(body)) return true;
    if (MEMORY_FACT.test(body) && body.length >= 6) return isOwner || direct;
    return false;
  }

  // 记忆卡原料：只把「值得记」的消息追加到 inbox，真正的评分/脱敏/遗忘在插件宿主里做。
  //   · 主人消息：全部记（私聊/群聊都记；scope 在插件侧固定为 qq，不会带去 B站）。
  //   · 群友消息：只记直接对她说、引用她、或明显有情绪/约定/道歉的，避免把整个群搬进记忆。
  //   · 私聊（非主人）：白名单好友的长消息记一条低权重的，短寒暄不记。
  function recordMemoryInboxEvent({ key: conversationKey, kind, event, plainContent, textContent, isOwner, quoteTargetIsSelf }) {
    try {
      const text = String(plainContent || textContent || '').trim();
      if (!text || text.startsWith('/')) return;
      if (/^\[(图片|表情|转发消息|拍一拍)\]/.test(text)) return;
      const direct = quoteTargetIsSelf || isOwner || isDirectAddress(text, event, kind);
      if (!isOwner) {
        if (kind === 'group' && !direct && !looksNoteworthyMessage(text, { names: [selfNickname, readRoleState().role] })) return;
        if (kind === 'private' && text.length < 8) return;
      }
      // 默认只记「重要的事」：明确让她记、或提到偏好/约定/计划/近况；不把每条闲聊搬进记忆。
      if (!memoryWorthRecording(text, { isOwner, direct })) return;
      appendMemoryInboxEvent(MEMORY_CARD_PATHS, {
        at: Date.now(),
        kind: kind === 'private' ? 'private' : 'group',
        sender: String(event.sender?.card || event.sender?.nickname || event.user_id || ''),
        senderId: String(event.user_id ?? ''),
        groupId: String(event.group_id ?? ''),
        isOwner,
        private: kind === 'private',
        direct: direct || isOwner,
        quoteSelf: quoteTargetIsSelf,
        conversationKey,
        text,
      });
    } catch {}
  }

  // 她自己的发言：写进记忆 inbox；插件会尽量并进最近一条主人记录（一问一答）。
  function recordSelfMemoryEvent(key, text) {
    try {
      // 默认不把她的回复写进记忆：回复是聊天记录，不是需要长期记住的事实。
      if (memoryRecordMode() !== 'chatlog') return;
      const body = String(text ?? '').trim();
      if (!body) return;
      if (/^⚠️|^⏳|^⏹️|^❓|^🔐/.test(body)) return; // 系统提示，不是她的话
      const [kind, id] = String(key).split(':');
      appendMemoryInboxEvent(MEMORY_CARD_PATHS, {
        at: Date.now(),
        kind: kind === 'private' ? 'private' : 'group',
        sender: selfNickname || '角色',
        senderId: selfUserId,
        groupId: kind === 'group' ? id : '',
        isSelf: true,
        private: kind === 'private',
        direct: true,
        conversationKey: key,
        text: body,
      });
    } catch {}
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    const seqThisTurn = (incomingSeq.get(key) ?? 0) + 1;
    incomingSeq.set(key, seqThisTurn);
    turnIncomingSeqByKey.set(key, seqThisTurn);
    if (cfg.humanize?.burstBrake !== false) burstCancelAt.set(key, Date.now());
    // 群画像：成员数缓存用于小群/大群分层；失败不影响消息处理。
    if (kind === 'group') void ensureGroupMeta(id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      logThrottled(`unauth:${key}`, 10 * 60_000, `忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}；同类日志 10 分钟内只记一次）`);
      return;
    }
    // 记下「这个会话真的来过消息」：DSH 退出期间的历史补课靠这份名单找会话，
    // 不依赖白名单是否枚举得出来（allowAllWhenEmpty 时白名单是空的）。
    noteKnownConversation(key);
    // 人的黑名单（deny.users）：**在一切副作用之前**返回 —— 不入库、不进上下文、
    // 不写记忆卡、不计鱼群、不触发唤醒。放在后面任何一处都等于「他还能叫醒你」。
    if (senderBlocked(event.user_id, cfg.deny?.users)) {
      appendActivity(`${key} [黑名单] 忽略 ${String(event.user_id)} 的消息（deny.users）`);
      log(`[黑名单] 忽略 ${key} 来自 ${event.user_id} 的消息（deny.users）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    // 语音条转写：同一条消息的 textContent / plainContent 会各扫一遍段列表，
    // 这里按 file/url 记忆化，避免同一段语音被转写两次（ASR 按秒计费）。
    const voiceTexts = new Map();
    const resolveVoiceText = async (data) => {
      const ref = String(data?.file || data?.url || '');
      if (!ref) return '';
      if (!voiceTexts.has(ref)) {
        const settings = readAsrSettings(cfg);
        if (!settings.enabled || !settings.apiKey) return '';
        voiceTexts.set(ref, transcribeQqVoice({
          recordFile: String(data?.file || ''),
          recordUrl: String(data?.url || ''),
          settings,
          log,
        }).then((r) => r?.text || '').catch(() => ''));
      }
      return voiceTexts.get(ref);
    };
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply, resolveVoice: resolveVoiceText });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false, resolveVoice: resolveVoiceText });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) {
      // 封闭模式只放行主人私聊；拒绝也要留审计（按会话限频，避免群消息刷屏）。
      if (currentMode === 'closed-agent' && auditOnce('closed-agent-deny', key, 60_000)) {
        auditOwner('closed-agent.access', {
          actor: auditActor(event.user_id, String(event.user_id) === String(cfg.ownerQQ ?? '')),
          rule: 'closed-agent',
          decision: 'deny',
          ok: false,
          errorCode: 'not-owner-private',
          ref: { session: key },
        });
      }
      return;
    }
    // 任何入站消息（含纯图片/表情/引用）都先记「谁在说话」，且必须在下面的空文本过滤之前：
    // 语音触发判定只认这条记录，漏记就等于给"换个人来喊"留了后门。
    {
      const isOwnerMsg = String(event.user_id) === String(cfg.ownerQQ ?? '');
      const now = Date.now();
      voice.noteSpeaker(key, { userId: String(event.user_id ?? ''), isOwner: isOwnerMsg, at: now });
    }
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    // 语料回流：记下这一轮用户说的话，出站时和她的回复配对（src/chat-corpus.js）。
    // 群聊只学「主人说的」或「直接对她说的」（@她 / 引用她 / 叫名字）；
    // 群友闲聊也记（避免她回了 B 却错配上更早的 A），但标记为不学。
    if (plainContent) {
      noteIncoming(key, plainContent, {
        eligible: kind === 'private' || isOwner || quoteTargetIsSelf || isDirectAddress(textContent, event, kind),
      });
    }
    const displayName = kind === 'group'
      ? (event.sender?.card || event.sender?.nickname || String(event.user_id))
      : '私聊';
    // 记忆卡原料：在静默/审批/命令等分支之前记录，避免「主人说的话没进记忆」。
    recordMemoryInboxEvent({ key, kind, event, plainContent, textContent, isOwner, quoteTargetIsSelf });
    if (kind === 'group') {
      recordFishWindow(key, displayName, event.user_id, { isOwner });
    }
    const senderIsFish = Boolean(!isOwner && (isFishName(displayName, cfg.fishGuard)
      || cfg.fishGuard?.fishIds?.includes(String(event.user_id))));
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (canConsumePending(p, isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner, String(event.user_id ?? ''), displayName);
      return;
    }
    // 带 [仅主人] 的提问 + 非主人：不消费、不回传答案、不吞消息，继续走正常群聊。
    if (p && p.kind === 'question' && p.ownerOnly === true && !isOwner && auditOnce('question-deny', key, 60_000)) {
      auditOwner('question.answer', {
        actor: auditActor(event.user_id, false),
        rule: 'ownerOnly',
        decision: 'deny',
        ok: false,
        errorCode: 'not-owner',
        ref: { session: key },
      });
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 桌宠挂件：私聊消息镜像（管理命令不镜像，避免把 /reset 之类当对话）
    if (kind === 'private' && !plainContent.startsWith('/')) {
      mirrorPetMessage({ role: 'user', key, sender: displayName, text: textContent });
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        if (/^\/role\b/.test(plainContent)) {
          auditOwner('role.switch', {
            actor: auditActor(event.user_id, false),
            rule: 'ownerQQ',
            decision: 'deny',
            ok: false,
            errorCode: 'not-owner',
            ref: { session: key },
          });
        }
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          turnLeaseNoted.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slang.resetKey(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          flushSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await withTimeout(api.stopSessionWork(old), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: old }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          auditOwner('role.switch', {
            actor: auditActor(event.user_id, true),
            rule: 'ownerQQ',
            decision: 'allow',
            ref: { session: key, role: '(clear)' },
          });
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROLES_DIR, name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            auditOwner('role.switch', {
              actor: auditActor(event.user_id, true),
              rule: 'ownerQQ',
              decision: 'allow',
              ref: { session: key, role: name },
            });
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      if (kind === 'group' && cfg.fishGuard?.enabled !== false) {
        await ensureFishGroupName(id);
      }
      const sender = displayName;
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') slang.feedWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      const directed = !senderIsFish && (quoteTargetIsSelf || isDirectAddress(textContent, event, kind));
      // 鱼群保护：同一批 bot 同群时先闭嘴。只影响“自动参与群聊”，
      // 被直接叫到/管理员说话仍可回一句（规则可关）。
      const fish = evaluateConversationFishGuard(key, st, {
        directAddress: directed,
        isOwner,
      });
      if (fish.blocked) {
        appendActivity(`${key} [鱼群保护] 本轮不参与：${fishGuardReasonText(fish) || '保护冷却中'}`);
        log(`[鱼群保护] 跳过唤醒 ${key}：${fishGuardReasonText(fish) || '保护冷却中'}`);
        return;
      }
      if (fish.rawBlocked && fish.bypass) {
        st.fishGuardBypass = { at: Date.now(), until: fish.until, reason: fish.reason, direct: !isOwner, owner: isOwner };
        try { flushSocialV2State(); } catch {}
        if (isOwner && auditOnce('fish-bypass', key, 60_000)) {
          auditOwner('fish.bypass', {
            actor: auditActor(event.user_id, true),
            rule: 'ownerQQ',
            decision: 'allow',
            ref: { session: key },
          });
        }
      }
      // 对方又开口：上次的收尾记录保留，但标记为「已重开」（下次提示词会说是新的开始）。
      noteClosureReopenV2(key, st, {
        plain: plainContent, text: textContent,
        quoteSelf: quoteTargetIsSelf, directAddress: directed, media: mediaList,
      });
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        flushSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          // 收尾后的软冷却只压普通概率唤醒；@/名字/提问/关键词/指定成员/私聊照常醒。
          if (closureSuppressesWake(st.closure, reason, Date.now())) {
            appendActivity(`${key} [收尾] 冷却中，跳过 ${reason} 唤醒：${textContent.slice(0, 60)}`);
            log(`[收尾] ${key} 冷却中，跳过 ${reason} 唤醒`);
          } else {
            scheduleWakeV2(key, reason);
          }
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      slang.feedWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 鱼群保护：chat / reserved 模式也走同一套判定（reserved2 在下面的分支里单独拦）。
    if (kind === 'group' && !isOwner && cfg.fishGuard?.enabled !== false
        && (currentMode === 'chat' || currentMode === 'reserved')) {
      await ensureFishGroupName(id);
      const directed = !senderIsFish && (quoteTargetIsSelf || isDirectAddress(textContent, event, kind));
      const st = getSocialV2State(key);
      const fish = evaluateConversationFishGuard(key, st, {
        messages: fishChatWindows.get(key) ?? [],
        directAddress: directed,
        isOwner: false,
      });
      if (fish.blocked) {
        appendActivity(`${key} [鱼群保护] 本轮不参与：${fishGuardReasonText(fish) || '保护中'}`);
        log(`[鱼群保护] 跳过群聊回复 ${key}：${fishGuardReasonText(fish) || '保护中'}`);
        return;
      }
      // 2026-10-23 修：以前这里只放行“接收”，发送时 fishGuardSendBlock 会重新判一次；
      // chat / reserved 模式的 unread 可能已被读掉，直呼证据消失 → 又被硬拦。
      // 和 reserved2 一样落一个 10 分钟 bypass，发送时才能真的回那一句。
      if (fish.rawBlocked && fish.bypass) {
        st.fishGuardBypass = { at: Date.now(), until: fish.until, reason: fish.reason, direct: directed, owner: false };
        try { flushSocialV2State(); } catch {}
      }
    }

    // 省 token：人设 / 记忆卡 / 跨平台近况只有本会话第一次（或 6 小时后）才注入；
    // 这些内容已经在会话历史里，每轮重复注入会让输入越滚越大、token 烧得很快。
    const primedAt = Number(contextPrimed.get(key) ?? 0);
    const needFullContext = !primedAt || Date.now() - primedAt > 6 * 3600_000;
    if (needFullContext) contextPrimed.set(key, Date.now());

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = needFullContext ? currentRoleHint(key) : '';

    // 最近聊天上下文：先取「当前消息之前」的窗口，再把当前消息记进窗口。
    // 只在完整注入时带；平时会话历史里已经有这些消息，再塞一份就是重复计费。
    const recentBlock = currentMode === 'chat' && needFullContext ? buildRecentChatBlock(key) : '';
    recordRecentChat(
      key,
      `${event.sender?.card || event.sender?.nickname || String(event.user_id)}(${String(event.user_id)})`,
      textContent
    );

    // 生物钟（chat 模式）：离线时只回应「明确叫它」的消息，其余只记录不接话。
    // 在线时行为和以前一样，照常回消息。
    if (currentMode === 'chat' && kind === 'group' && !isOwner && cfg.chat?.presence?.enabled !== false) {
      const st = presenceState(key);
      // 只要这条消息 @ 的是别人，就不算「叫醒我」——避免群里 @ 别的机器人时把自己叫起来
      const segs0 = Array.isArray(event?.message) ? event.message : [];
      const selfId0 = String(event?.self_id ?? '');
      const atOther0 = segs0.some((seg) => {
        if (seg?.type !== 'at') return false;
        const qq = String(seg.data?.qq ?? '');
        return qq !== '' && qq !== 'all' && qq !== selfId0;
      });
      const called = !atOther0 && (quoteTargetIsSelf || isDirectAddress(textContent, event, kind));
      if (called) {
        if (!st.online) log(`[生物钟] 被叫醒 ${key}`);
        wakePresence(key);
      } else if (!st.online) {
        appendActivity(`${key} [生物钟] 离线中，未接话：${textContent.slice(0, 50)}`);
        log(`[生物钟] 离线，跳过 ${key}（${plainContent.slice(0, 40)}）`);
        return;
      }
    }

    // 群聊「别人之间的对话」判定（chat 模式）：
    // 只有**明确指向别人**才算——@ 了别人，或者引用回复的是别人的消息。
    // 其余消息（包括普通闲聊、没叫名字的发言）一律正常回复，保持参与度。
    // 判定为「在跟别人说话」时，默认不插话，仅按概率附和；附和时提示它可以只输出 [SILENT]。
    // 关闭方式：config.json → chat.addressFilter.enabled = false
    let chimeInHint = '';
    // 私聊 / 直接对我们说的消息：明确要求必须回复，避免模型自己输出 [SILENT] 导致 QQ 上没反应
    const directToUs = kind === 'private' || quoteTargetIsSelf || isOwner || isDirectAddress(textContent, event, kind);
    // 旧文案「不要只回嗯/收到/好就结束」会逼模型硬凑一句完整回复，正是 AI 味的来源；
    // 改成「给个反应就行」，保留短回复的空间。
    const mustReplyHint = directToUs ? '\n\n【这条是直接对你说的：给个反应就行（一个字、一个问号都可以），不要输出 [SILENT]；不用为了凑话解释、总结或给建议。】' : '';
    if (currentMode === 'chat' && kind === 'group' && !isOwner && cfg.chat?.addressFilter?.enabled !== false) {
      const segs = Array.isArray(event?.message) ? event.message : [];
      const selfId = String(event?.self_id ?? '');
      const atOther = segs.some((seg) => {
        if (seg?.type !== 'at') return false;
        const qq = String(seg.data?.qq ?? '');
        return qq !== '' && qq !== 'all' && qq !== selfId;
      });
      const quotesOther = !quoteTargetIsSelf && String(textContent ?? '').includes('[引用');
      if (atOther || quotesOther) {
        const silenceP = Math.max(0, Math.min(1, Number(cfg.chat?.addressFilter?.silenceWhenAddressedToOther ?? 0.4)));
        const senderName = event.sender?.card || event.sender?.nickname || String(event.user_id);
        if (Math.random() < silenceP) {
          appendActivity(`${key} 别人之间在聊（@或引用别人），未接话：${textContent.slice(0, 60)}`);
          log(`群聊在叫别人，跳过 ${key}（${senderName}：${plainContent.slice(0, 40)}）`);
          return;
        }
        chimeInHint = '【注意：这条消息像是在跟另一个人说话（@ 或引用的是别人）。但如果结合上面的记录看，它其实是在说你（比如用「她」指你、或者在议论你），那就当成在跟你说话，正常回应。真没什么想附和的话，就只输出 [SILENT]，别抢话。】\n';
        log(`群聊在叫别人，随机附和 ${key}（${senderName}：${plainContent.slice(0, 40)}）`);
      }
    }

    // 合体插件：只把“真正进入正常处理的群消息”写进公开 feed。
    // 私信、命令、静默模式、审批回答都不会到这里；后续的隐私过滤在插件侧完成。
    if (kind === 'group' && plainContent && !plainContent.startsWith('/')) {
      appendPublicFeed({
        groupId: String(event.group_id ?? id),
        senderId: String(event.user_id ?? ''),
        senderName: String(event.sender?.card || event.sender?.nickname || event.user_id || ''),
        text: plainContent,
        isOwner,
      });
    }

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    // 发送者后面必须带 QQ 号：人格卡里的「称呼表」是按 QQ 号映射的，
    // 只给昵称的话模型根本对不上号（曾出现「表里写 omm，实际却叫阿零」）。
    const senderLabel = `${event.sender?.card || event.sender?.nickname || String(event.user_id)}(${String(event.user_id)})`;
    lastSenderLabel.set(key, senderLabel);
    lastUserText.set(key, textContent);
    // 群友提到 B 站 / 视频 / 某次看片时，按关键词从完整记忆里捞几条相关细节，
    // 和常驻的「B站记忆简报」互补：简报给身份和最近见闻，检索给具体那次。
    const biliRecall = cfg.biliBridge?.enabled && cfg.biliBridge?.memory?.enabled !== false
      ? biliMemory.recallBlock(textContent)
      : '';
    // 贴吧已由 dsh-tieba-dive 插件接管（自带工具与提示），这里不再塞入口。
    // 内置记忆召回：按当前这句话从记忆卡里挑几条相关的（不是整张卡），省 token 也更准。
    // 群聊是公开场合：按 platform='bili' 过滤，绝不把桌宠/私聊记录召回进群（隐私）；
    // 私聊给全量。与上面 memoryCardBlock 的平台口径一致。
    let recallBlock = '';
    try { recallBlock = memoryRecall.promptBlock(textContent, { platform: kind === 'group' ? 'bili' : 'qq' }); } catch { recallBlock = ''; }
    const promptText = (recallBlock ? recallBlock + '\n\n' : '') + recentBlock + (roleHint ? roleHint + '\n\n' : '') + (biliRecall ? biliRecall + '\n\n' : '') + douyinHintFor(`${plainContent} ${textContent}`) + chimeInHint + mustReplyHint
      + (isOwner ? ownerMessageTag() : '')
      + peerAliasTagV2(key, isOwner)
      + senderLabel + '：' + textContent
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const biliRecall = cfg.biliBridge?.enabled && cfg.biliBridge?.memory?.enabled !== false
            ? biliMemory.recallBlock(textContent)
            : '';
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${biliRecall ? biliRecall + '\n\n' : ''}${douyinHintFor(`${plainContent} ${textContent}`)}${isOwner ? ownerMessageTag() : ''}${peerAliasTagV2(key, isOwner)}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint(key);
      const currentLine = (isOwner && kind === 'private') ? `${ownerMessageTag()}${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const biliRecall = cfg.biliBridge?.enabled && cfg.biliBridge?.memory?.enabled !== false
        ? biliMemory.recallBlock(textContent)
        : '';
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}${biliRecall ? biliRecall + '\n\n' : ''}${douyinHintFor(`${plainContent} ${textContent}`)}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // ── 活人感：群聊接话打分（chat 模式；reserved2 有自己的社交状态机）──
    if (kind === 'group' && currentMode !== 'reserved2' && cfg.humanize?.groupGate !== false) {
      const verdict = humanizeGate().judgeGroup({
        text: plainContent || textContent,
        event,
        cfg: cfg.humanize,
        selfNames: [selfNickname, selfDisplayName],
        isOwner,
        quoteTargetIsSelf,
        recentCount: recentGroupMessageCount(key),
      });
      appendActivity(`${key} [humanize] 接话打分 ${verdict.score}（${verdict.reasons.join('、')}）→ ${verdict.reply ? '接' : '不接'}`);
      if (!verdict.reply) {
        log(`[humanize] 群聊未点名，打分 ${verdict.score} 不接 (${key})`);
        return;
      }
    }

    // ── 活人感：攒一攒（先等安静窗口；期间对方继续补充就交给下一条统一回）──
    if (cfg.humanize?.gather !== false && currentMode !== 'reserved2') {
      const waitMs = humanizeGate().gatherDelayMs(textContent, cfg.humanize);
      if (waitMs > 0) {
        const seqAtWait = incomingSeq.get(key) ?? 0;
        await sleep(waitMs);
        if ((incomingSeq.get(key) ?? 0) > seqAtWait) {
          log(`[humanize] 对方继续补充，本轮交给下一条统一回 (${key})`);
          return;
        }
      }
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      saveQueued();
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    const imageParts = Array.isArray(mediaList) && mediaList.length > 0 ? await resolveMediaList(mediaList) : [];
    const seeMemeBlock = await seeMemeForTurn(promptText, imageParts);
    // 梗百科：只扫这段提示的最后几十行，命中才注入那一条词条（内置词库，不联网）
    const memeWikiBlock = memeWikiPromptBlock(promptText, { key });
    if (memeWikiBlock) log(`梗百科命中：${memeWikiBlock.split('\n')[0].slice(0, 90)}`);
    const turnBlocks = [memeWikiBlock, seeMemeBlock].filter(Boolean).join('\n\n');
    const turnText = withAlignmentContext(key, withSlangContext(turnBlocks ? `${turnBlocks}\n\n${promptText}` : promptText, key));
    const content = [{ type: 'text', text: turnText }, ...imageParts];
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    // ack 是「收到，正在思考」类流程提示，不是对用户的回复——绝不进语料
    //（自定义 ackMessage 文案没固定指纹，必须显式关）
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage, { recordCorpus: false });
    log(`已投递 ${key}: ${promptText.length} 字${needFullContext ? '（含人设/记忆）' : '（仅新消息）'} · ${promptText.slice(0, 60)}${promptText.length > 60 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false, senderId = '', senderName = '') {
    if (p.kind === 'question') {
      // 防御：owner-only 的提问即使被调用也拒绝（正常路径在消费点已经拦住）。
      if (p.ownerOnly === true && !isOwner) return;
      const answers = buildQuestionAnswers(p, answerText, { isOwner, sender: senderName });
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        auditOwner('question.answer', {
          actor: auditActor(senderId, isOwner),
          rule: p.ownerOnly === true ? 'ownerOnly' : 'anyone',
          decision: 'allow',
          ref: { session: key },
        });
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        auditOwner('approval.answer', {
          actor: auditActor(senderId, isOwner),
          rule: 'ownerQQ',
          decision: outcome === 'allowed-once' ? 'allow' : 'deny',
          ref: { session: key, approvalId: p.approvalId ?? '' },
        });
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    // 黑名单用户拍一拍也不响应：否则「戳一下」就成了绕过 deny.users 的唤醒通道。
    if (senderBlocked(senderId, cfg.deny?.users)
      || (kind === 'private' && senderBlocked(id, cfg.deny?.users))) {
      appendActivity(`${key} [黑名单] 忽略拍一拍 ${senderId || id}（deny.users）`);
      log(`[黑名单] 忽略 ${key} 的拍一拍（来自 ${senderId || id}，deny.users）`);
      return;
    }
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      flushSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    if (shuttingDown) return entry;
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (shuttingDown) return;
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    // [仅主人] 是模型写的分类标记，只用于**收窄**谁能回答，绝不作为任何授权凭证。
    if (entry.kind === 'question') entry.ownerOnly = isOwnerOnlyFrame(entry.questions);
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ

  /**
   * 把一条 session/event 喂给该会话的 turn collector，并维护 collectors 的生命周期。
   *
   * 两条不变量（都曾被真实故障踩过）：
   *   ① 只为 turn/start 建 collector —— 任何事件都建的话，一条重连后补发的
   *      assistant/message 就会留下永不结束的空 collector，而「会话是否繁忙」正是按
   *      collectors.has() 判断的 ⇒ 这个会话从此再也收不到唤醒；
   *   ② turn/end 即使没有匹配的 turn/start（重连快照没带上）也要清掉已成空壳的
   *      collector，否则同样会永久繁忙。
   */
  function trackTurnEvent(sessionId, event) {
    let collector = collectors.get(sessionId);
    if (!collector && event?.type === 'turn/start') {
      collector = createTurnCollector();
      collectors.set(sessionId, collector);
    }
    const ended = collector ? collector.push(event) : null;
    if (ended) {
      // 回合正常收尾：collector 立刻释放。v2TurnStartAt 留给调用方（无行动判定要用它），
      // 调用方在 `if (ended)` 分支里用完再删。
      collectors.delete(sessionId);
    } else if (event?.type === 'turn/end' && (!collector || collector.size?.() === 0)) {
      collectors.delete(sessionId);
      v2TurnStartAt.delete(sessionId);
      turnLeaseNoted.delete(sessionId);
    }
    return { collector, ended };
  }

  // ── 回合安全控制器（L3 止血）─────────────────────────────────────────────
  // 只做三件事：步数、同一工具错误重复、回合内每日额度。
  // 单轮费用上限还没接价格表；先不做“看起来有、实际不准”的假上限。
  let lastTurnBudgetProbeAt = 0;

  function turnBudgetHits() {
    if (Date.now() - lastTurnBudgetProbeAt < 5000) return [];
    lastTurnBudgetProbeAt = Date.now();
    try {
      const usage = bridgeDailyUsage();
      const limits = bridgeBudgetLimits();
      const result = evaluateBudget(usage, limits, { scopes: ['qq', 'total'] });
      return result.blocked ? result.hits ?? [] : [];
    } catch (error) {
      log('[turn-guard] 额度检查失败：', String(error?.message ?? error).slice(0, 160));
      return [];
    }
  }

  function recordTurnStop(sessionId, key, stop) {
    if (!stop) return;
    const code = String(stop.code ?? 'TURN_ABORTED');
    const kind = code === 'TURN_BUDGET_EXHAUSTED' ? 'cost' : 'fault';
    const impact = code === 'TURN_BUDGET_EXHAUSTED'
      ? '回合进行中每日额度已耗尽；继续调用会继续产生费用。'
      : code === 'TURN_REPEATED_TOOL_ERROR'
        ? '同一工具和错误反复出现，模型可能陷入重试循环；本轮已停止。'
        : '单轮工具步数超过上限，任务可能已失控；本轮已停止。';
    gateEvents.record({
      gate: 'turn-guard',
      kind,
      event: code,
      action: 'stopped',
      subject: { session: sessionId, key },
      reason: { code, message: stop.reason },
      impact,
      recommendation: '检查 QQ 预设/第三方插件与额度设置；修复后再开新回合。',
      confidence: 'confirmed',
      dedupeKey: `turn-guard:${code}:${sessionId}`,
      evidence: stop.evidence ?? {},
    });
    log(`⛔ 回合止血 ${key || sessionId}：${stop.reason}`);
    void (async () => {
      try { await api.cancelTurn(sessionId); }
      catch (error) { log(`⚠️ 取消回合失败 ${key || sessionId}：${error?.message ?? error}`); }
      if (!key) return;
      try {
        await sendToQQ(key, `【SurfCore】本轮已停止，避免继续消耗：${stop.reason}。修复后回复「继续」可开新回合；详情见 设置 → dsh-Dfy → 维护 → 安装与维护 → 诊断与体检。`);
      } catch (error) {
        log(`⚠️ 回合止血通知发送失败 ${key}：${error?.message ?? error}`);
      }
    })();
  }

  /** 处理一条会话事件；返回 true 表示本回合已停止，调用方应跳过后续处理。 */
  // 回合级止血幂等：turn-guard 自己的 state.stopped 只能挡住「同一份 state」的重复
  // stop，但 DSH 事件流在重连/flush 时可能重放 turn/start —— begin() 会重建 state
  // （stopped=false、错误计数清零），同一毫秒内能把同一次停轮记成 3 条 L3
  // （2026-11-08 13:24:06 实测：session-16a4ac25 三条同因记录，间隔 2~3ms）。
  // 这里按回合（turn/end 清除）再挡一层，保证一次停轮只记一条闸门事件。
  const turnStopNotified = new Set();
  function guardTurnEvent(sessionId, key, event) {
    if (!sessionId || !key) return false;
    const type = event?.type;
    if (type === 'turn/start') {
      turnGuard.begin(sessionId, key);
      return false;
    }
    if (type === 'turn/end') {
      turnGuard.end(sessionId);
      turnStopNotified.delete(sessionId);
      return false;
    }

    const state = turnGuard.get(sessionId);
    if (!state) return false;

    let stop = null;
    if (type === 'tool/call') {
      stop = turnGuard.noteStep(sessionId);
    } else if (type === 'tool/result') {
      const callId = event.data?.message?.source?.callId;
      const toolName = callId != null ? (toolCallNames.get(sessionId)?.get(String(callId)) ?? '') : '';
      const resultBlock = event.data?.message?.content?.[0];
      const resultError = event.data?.message?.isError === true || resultBlock?.isError === true;
      if (resultError) {
        const errorText = String(resultBlock?.text ?? resultBlock?.error ?? event.data?.message?.error ?? '');
        stop = turnGuard.noteToolError(sessionId, toolName, errorText);
      }
    }
    if (!stop && (type === 'assistant/message' || type === 'tool/result')) {
      const hits = turnBudgetHits();
      if (hits.length) stop = turnGuard.noteBudgetExhausted(sessionId, hits);
    }
    if (stop) {
      if (!turnStopNotified.has(sessionId)) {
        turnStopNotified.add(sessionId);
        recordTurnStop(sessionId, key, stop);
      }
      return true;
    }
    return false;
  }

  async function pumpMux() {
    // 事件流重连退避：DSH 侧流被立刻关闭时（例如版本不兼容，见 issue #34），
    // 固定 3 秒重连会以每分钟 20 行的速度刷屏，真正有用的错误反而被淹没。
    let retryMs = 3000;
    let failureStreak = 0;
    // loop-allow: DSH 事件流长连接；shuttingDown 时 break，失败按指数退避（上限 30s）
    for (;;) {
      if (shuttingDown) break;
      let framesThisStream = 0;
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({}, muxAbort.signal)) {
          framesThisStream += 1;
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            const key = reverse.get(frame.sessionId);
            if (key) {
              try {
                const wakeId = sessionWakeIds.get(frame.sessionId) ?? '';
                const characterId = sessionCharacterIds.get(frame.sessionId) ?? '';
                contextTelemetry.ingestEvent({ id: frame.sessionId }, frame.event, { wakeId, key, characterId });
                if (frame.event.type === 'turn/end') {
                  sessionWakeIds.delete(frame.sessionId);
                  sessionCharacterIds.delete(frame.sessionId);
                }
              } catch {}
            }
            if (key && guardTurnEvent(frame.sessionId, key, frame.event)) continue;
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              slang.collectLearnerEvent(frame.sessionId, frame.event);
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            // 「待退役」的会话也要继续处理：这一轮已经生成好的回复必须发出去，
            // 不能在退役瞬间被丢掉（token 已花、QQ 却收不到）。
            const retiringNow = retiringSessions.get(frame.sessionId) ?? null;
            if (!isCurrentSession(key, frame.sessionId) && !retiringNow) continue;
            if (frame.event.type === 'turn/end' && retiringNow) {
              retiringSessions.delete(frame.sessionId);
              reverse.delete(frame.sessionId);
              api.events.forget?.(frame.sessionId);
              // 延迟停用/归档：本轮回复的发送在同一次事件处理的后半段，先让它发完。
              const retireTimer = setTimeout(() => {
                if (shuttingDown) return;
                stopRetiredSessionWork(frame.sessionId, retiringNow.key);
              }, 4000);
              retireTimer.unref?.();
              embeddedTimers.push(retireTimer);
              log(`退役会话的在途回合已结束，稍后停用 ${retiringNow.key} -> ${frame.sessionId}`);
            }
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              turnSendToolState.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              turnLeaseNoted.delete(frame.sessionId);
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // collector 生命周期见 trackTurnEvent()：只为 turn/start 建、空壳 turn/end 即清。
            const { ended } = trackTurnEvent(frame.sessionId, frame.event);
            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const sendToolHit = sendToolSucceededSessions.has(frame.sessionId);
                // turn/start 丢了（重连后由快照补发的回合）就无从判断「这一轮有没有行动」：
                // 此时记 miss 会冤枉 AI，连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
                if (turnStart > 0 || sendToolHit) {
                  const actionTaken = sendToolHit || (turnStart > 0 && st.lastActionAt >= turnStart);
                  if (actionTaken) {
                    st.wakeConfig.noActionCount = 0;
                  } else {
                    st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                    const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                    if (st.wakeConfig.noActionCount >= limit) {
                      log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                      st.wakeConfig = defaultWakeConfigV2();
                      st.bootstrapSent = true;
                      st.wakeConfig.noActionCount = 0;
                    }
                  }
                  flushSocialV2State();
                } else {
                  log(`[reserved2] ${key} 回合结束但缺少 turn/start（重连补发），跳过无行动计数`);
                }
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              turnLeaseNoted.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              // 记给后面的 reserved2 分支用：整轮没成功调用发送工具时决定要不要降级直发。
              if (turnSendToolState.size > 200) turnSendToolState.clear();
              turnSendToolState.set(frame.sessionId, { sent: sendToolSucceeded, at: Date.now() });
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 目的机制：先把「这一枪到底发没发 / 她写了什么目的」记下来，再走正常收尾。
              try { purpose.noteTurnEnded(frame.sessionId, ended, sendToolSucceeded); } catch (error) {
                log(`[目的] 回合回执异常：${error?.message ?? error}`);
              }
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    flushSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次（定时器类与消息类语义不同，
              // 详见 replayPendingWakeReasonsV2 的注释）。
              replayPendingWakeReasonsV2(key);
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                const turnIncomingSeq = turnIncomingSeqByKey.get(key) ?? 0;
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain) || (String(key).startsWith('group:') && isSilenceDecision(plain))) {
                  // 主动搭话回合选择了沉默 → 别再让 @ 挂到后面的普通回复上
                  pendingProactiveAt.delete(key);
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 活人感：生成期间对方又说话了（或撤回）→ 这条基于旧消息的回复不再发，
                // 交给下一个回合按新内容重新回答。
                if (cfg.humanize?.cancelOnNewMessage !== false) {
                  const seqNow = incomingSeq.get(key) ?? 0;
                  if (seqNow > turnIncomingSeq) {
                    log(`[humanize] 生成期间对方又说话了，这条回复不发 (${key})`);
                    appendActivity(`${key} [humanize] 生成期间对方又说话，旧回复作废`);
                    continue;
                  }
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social, undefined, { recordCorpus: false });
                  } else {
                    await sendToQQ(key, messages[0], { recordCorpus: false });
                    void sendNekoAfterReply(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'reserved2') {
                  // 二代仿真模式：模型应通过 qq_send_message 发送，纯文本是内部输出。
                  //
                  // 2026-11-14 结构性收口：**纯文本永不自动转发**。
                  // 之前留了「私聊有人叫她就降级直发」的口子，靠黑名单判断像不像内部输出；
                  // 措辞是无穷的，模型换个说法就漏一次（日志里 4 次降级直发全是内部旁白：
                  // 「这段已经收尾」「空唤醒没有实际来信」）。现在改成：
                  //   · 不转发原文；
                  //   · 确实是用户在叫她（private/@/叫名字/拍一拍/管理员）、却没调发送工具时，
                  //     用一条内部提醒让她自己调 qq_send_message 发出去，10 分钟最多一次；
                  //   · 空唤醒/主动回合不提醒（避免白烧一轮 token）。
                  const toolState = turnSendToolState.get(frame.sessionId);
                  turnSendToolState.delete(frame.sessionId);
                  const st2 = getSocialV2State(key);
                  const realUserWake = isHardDirectWakeReason(st2.lastWakeReason);
                  const nudgedAt = sendNudgeAt.get(key) ?? 0;
                  if (toolState && toolState.sent === false && realUserWake
                    && plain.trim() && Date.now() - nudgedAt > 10 * 60_000) {
                    sendNudgeAt.set(key, Date.now());
                    log(`[reserved2] 本轮没调发送工具，提醒她自己发（不转发原文）(${key})`);
                    appendActivity(`${key} [reserved2] 未调发送工具，已提醒（不直发）`);
                    try {
                      await api.sessions.prompt({
                        sessionId: frame.sessionId,
                        mode: 'queue',
                        content: [{
                          type: 'text',
                          text: '（系统提醒，不是对方的发言）你上一轮想说的话还没有发出去。请调用 qq_send_message，把你想说的那句话原样发给对方；不要复述这条提醒，也不要解释。',
                        }],
                      });
                    } catch (error) {
                      log(`[reserved2] 发送提醒失败：${error?.message ?? error}`);
                    }
                  } else {
                    log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                    appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  }
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  const pend = pendingProactiveAt.get(key);
                  if (pend && Date.now() - Number(pend.at) < 10 * 60 * 1000) {
                    // 主动搭话回合：由她自己决定 @ 谁（回复以「@QQ号 内容」开头）
                    pendingProactiveAt.delete(key);
                    const mAt = /^\s*[@＠]\s*(\d{5,12})\s*[：:，,]?\s*/.exec(plain);
                    const atQq = mAt ? mAt[1] : null;
                    const body = mAt ? plain.slice(mAt[0].length).trim() : plain;
                    if (atQq && body) {
                      try {
                        const cappedBody = capGroupReply(body);
                        await sendGroupWithAt(key, atQq, cappedBody);
                        log(`agent 回复 (${key}) ${cappedBody.length} 字（自己 @ 了 ${atQq}）`);
                        appendActivity(`${key} agent 回复(@${atQq})：${cappedBody.slice(0, 80)}`);
                      } catch (error) {
                        log(`带 @ 发送失败，退回普通发送 (${key}): ${error?.message ?? error}`);
                        await sendToQQ(key, body, { groupCap: true });
                      void sendNekoAfterReply(key, body);
                      }
                    } else {
                      log(`agent 回复 (${key}) ${plain.length} 字（主动搭话，没 @ 人）`);
                      appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                      await sendToQQ(key, plain, { groupCap: true });
                    void sendNekoAfterReply(key, plain);
                    }
                  } else {
                    log(`agent 回复 (${key}) ${plain.length} 字`);
                    appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                    await sendToQQ(key, plain, { groupCap: true });
                    void sendNekoAfterReply(key, plain);
                  }
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 以前这里只发 QQ、不写日志：出问题时 bridge.log 里什么都没有，排查只能靠猜（PR #24）。
                log(`⚠️ agent 处理出错 (${key})：${safeMsg}`);
                appendActivity(`${key} agent 处理出错：${safeMsg.slice(0, 80)}`);
                // 错误提示只发主人私聊，且同一条错误 6 小时内只发一次。
                // 2026-11-15 实测：配置的 provider 失效时，每小时一次主动唤醒都会把
                // 「no adapter registered」原样发到聊天里，像刷屏机器人。
                const ownerKey = cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';
                const noticeKey = `${key}|${safeMsg.slice(0, 120)}`;
                const lastNotice = Number(agentErrorNoticeAt.get(noticeKey) ?? 0);
                if (ownerKey && key === ownerKey && Date.now() - lastNotice > 6 * 60 * 60 * 1000) {
                  agentErrorNoticeAt.set(noticeKey, Date.now());
                  await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                } else if (key !== ownerKey) {
                  log(`（非主人会话，错误只记日志不外发：${key}）`);
                }
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                log(`⏹️ 回合被中止 (${key})`);
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }

              // —— 上下文自动滚动（放在块尾：本轮回复已全部 await 发完，退役不会再打断任何发送）——
              // 全量注入（人设/记忆/简报）会永久写进会话历史，长会话上下文滚到十几万
              // tokens：实测 127k tokens 时单轮 ~2 分钟。滚动聊天窗口（最近 10 条）+
              // 记忆卡 + 按需召回本来就能保证「新会话不断线」，这里补触发器：
              // 本轮输入 tokens 超过阈值 → 退役旧会话；下一条消息开新会话并重新
              // 注入一次全量，此后恢复轻量。阈值 0 = 关闭。
              {
                const inputTokens = sessionContextTokens.get(frame.sessionId) ?? 0;
                const rolloverLimit = Math.round(Number(cfg.chat?.contextRolloverTokens ?? 60000));
                if (rolloverLimit > 0 && inputTokens > rolloverLimit
                  && state.sessions[key] === frame.sessionId && !retiringSessions.has(frame.sessionId)) {
                  log(`[上下文滚动] ${key} 本轮输入 ${inputTokens} tokens > ${rolloverLimit}，滚动新会话（记忆卡/最近窗口保持连续）`);
                  appendActivity(`${key} [上下文滚动] 上下文达 ${inputTokens} tokens，自动滚动新会话`);
                  retireSession(key, { reason: '上下文超限滚动' });
                  contextPrimed.delete(key);
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && slang.ownsSession(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
        // 流正常关闭（服务端主动断开）不会抛错。以前这里什么都不打，日志看起来
        // 就像「连上了、然后又连一次」，完全看不出 DSH 把流关了。
        log(`DSH 事件流已结束（本次收到 ${framesThisStream} 帧）`);
      } catch (error) {
        if (!shuttingDown) log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        turnStopNotified.clear(); // 事件流已断，回合级止血幂等表一并清（新流按新回合重记）
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        activeWaits.clear();
      }
      if (framesThisStream > 0) {
        failureStreak = 0;
        retryMs = 3000;
      } else {
        failureStreak += 1;
        retryMs = Math.min(30000, retryMs * 2);
        if (failureStreak === 3) {
          log('⚠️ 连续多次连上 DSH 事件流后一帧都没收到就断开：多半是 DSH 侧事件流协议/版本不匹配'
            + '（可在 DSH 里核对版本，或查看 issue #34）。已改为指数退避重连，不再每 3 秒刷屏。');
        }
      }
      await sleepUnlessShutdown(retryMs);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  // 只桌宠/未安装 SDK 时这里会抛出可读错误（由 start 流程回报给设置页），不影响其它功能。
  await loadSnowLumaSdk();
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  // 入口兜底通知：能走到这个顶层 catch 的，都是 handleIncoming 内部各环节都没接住的
  // 意外错误（建会话/prompt/分发抛出）。此时用户一条回执都没收到，表现为「发了石沉大海」。
  // 这里补一条降级提示（按会话限频，且自身绝不再抛），把「静默失败」变成「至少知道没收到」。
  const entryFailNotifiedAt = new Map(); // key -> ts，10 分钟内不重复打扰
  function notifyEntryFailure(key, error) {
    try {
      const now = Date.now();
      if (now - (entryFailNotifiedAt.get(key) ?? 0) < 10 * 60_000) return;
      entryFailNotifiedAt.set(key, now);
      // 复用发送守卫：出错期间模式/白名单可能已变，不允许就别硬发。
      const assertSendAllowed = captureSendGuard(key);
      assertSendAllowed();
      const msg = String(error?.message ?? error ?? '').slice(0, 120);
      sendToQQ(key, `⚠️ 这条消息没处理成功：${msg || '未知错误'}。稍后再发一次，或去 设置 → dsh-Dfy → 维护 看诊断。`);
    } catch { /* 兜底通知绝不能反过来打断消息循环 */ }
  }

  bot.onPrivateMessage(async (event) => {
    // 统一按字符串比较：网关可能把 id 序列化成 number/string 混用，
    // 用 `===` 漏掉自己发的消息会进入正常处理（reserved2 下 AI 会回答自己 / chat 下可能回复循环）。
    if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); notifyEntryFailure(convKey('private', event.user_id), error); }
  });
  bot.onGroupMessage(async (event) => {
    if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
      || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); notifyEntryFailure(convKey('group', event.group_id), error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });
  // 活人感：撤回 → 还没发的分段/回复作废
  const handleRecallNotice = (event) => {
    try {
      const kind = event?.group_id ? 'group' : 'private';
      const id = event?.group_id ?? event?.user_id;
      const key = convKey(kind, id);
      incomingSeq.set(key, (incomingSeq.get(key) ?? 0) + 1);
      burstCancelAt.set(key, Date.now());
      const timers = social.pendingTimers.get(key);
      if (timers) { for (const timer of timers) clearTimeout(timer); social.pendingTimers.delete(key); }
      log(`[humanize] 撤回事件：${key} 未发的分段/回复作废`);
      appendActivity(`${key} [humanize] 对方撤回，未发内容作废`);
    } catch (error) {
      log('[humanize] 撤回事件处理失败：', error?.message ?? error);
    }
  };
  try {
    bot.onNotice('group_recall', handleRecallNotice);
    bot.onNotice('friend_recall', handleRecallNotice);
  } catch (error) {
    log('（撤回事件订阅不可用：' + (error?.message ?? error) + '）');
  }

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') setAccountOnline(event.status.online, 'heartbeat');
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      setAccountOnline(sub === 'online', 'bot_status');
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    snowlumaHealth.everConnected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    notifySendChannelUp();
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        selfDisplayName = String(login.nickname).trim();
        log(`机器人昵称: ${login.nickname}`);
      }
      if (login?.user_id != null) {
        selfUserId = String(login.user_id);
        reconcileAllowlist('login');
      }
      // 把「QQ 昵称 / QQ 号」落一小份给另一侧用：B站 会话是插件进程，拿不到网关登录信息，
      // 但它要靠这两个锚点认出「自己的 QQ 资料卡截图」（2026-10-23 用户要求跨平台互认）。
      saveQqSelfIdentity();
    }).catch(() => {}).finally(() => {
      // 登录信息拿到（或失败）后再补历史：需要 selfUserId 区分「自己以前发的消息」。
      void runHistoryCatchUp('connect').catch((error) => log(`[history] 连接后补历史异常：${error?.message ?? error}`));
      void runChatHistoryCatchUp('connect');
    });
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
    // 预热/刷新表情库：必须等 WS 真的通了再拉 —— 以前放在启动处（bot.connect() 之后立刻调），
    // 而 SnowLuma 的 WS 首连几乎必然被拒（HTTP token ≠ WS token）→ 每次启动都打一条
    // 「同步收藏表情失败: SnowLuma WebSocket closed before opening」，看着像故障、其实必然。
    // 放到 open 里：首连/自愈重连/断线重连都会在这里刷新一次，日志只在真失败时出现。
    if (cfg.socialV2?.sticker?.enabled !== false) {
      stickers.sync(true).catch((error) => log(`[sticker] 连接后刷新表情库失败（不影响发送，工具调用时会再试）：${error?.message ?? error}`));
    }
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}`);
    if (cfg.snowluma.accessToken !== httpToken) {
      // 不打印 token 片段：日志会被贴进 issue / 截图，前缀同样是凭据的一部分
      // （CWE-532，与下方 syncTokenToFile 的注释同一口径）。
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(CONFIG_FILE, {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    // 注意：自愈要读磁盘/探测端点，期间宿主可能已经 stop —— 必须在真正重连前
    // 再看一眼 shuttingDown，否则「停机后又被自愈拉起来」。
    if (wsChanged && !shuttingDown) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(CONFIG_FILE, cfg.snowluma.accessToken ?? '');
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图，
      // 前 4 个字符同样是凭据的一部分（CWE-532，见 PR #13）。
      if (r.updated) log('🔄 已把当前 token 写回 config.json');
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    // 停机后绝不能自愈：stop() 里的 bot.close() 会触发 close 事件，自愈一旦成功
    // 就会 close+connect 重新连上 SnowLuma —— 插件已经停了，却留着一个活连接，
    // 下次启动/热重载时两个实例抢同一条消息流。
    if (shuttingDown) return;
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    // 主动停机（插件 stop / 热重载）不是「断线」：不记健康、不排心跳告警、更不自愈重连。
    if (shuttingDown) return;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 从第一次断开就开始计时：判据是「持续不可达」，与本次进程是否连过无关。
    if (!snowlumaHealth.downSince) snowlumaHealth.downSince = Date.now();
    // 1006 在每次启动/短暂抖动都会出现，重连通常几百毫秒；先给 15 秒观察窗口，
    // 窗口内重连成功就不记 L2、不弹窗（2026-10-31：用户明明连着却收到“通道断开”）。
    snowlumaHealth.downReason = `SnowLuma 连接断开（code=${info?.code ?? '?'}）`;
    if (snowlumaHealth.downTimer) clearTimeout(snowlumaHealth.downTimer);
    snowlumaHealth.downTimer = setTimeout(() => {
      snowlumaHealth.downTimer = null;
      if (shuttingDown) return;
      if (snowlumaHealth.connected === true) return;
      notifySendChannelDown(snowlumaHealth.downReason || 'SnowLuma 连接断开');
    }, 15_000);
    snowlumaHealth.downTimer.unref?.();
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => {
    // SDK 在 WS 升级被拒（401 / 建连失败）时可能**只 emit error、不 emit close**，
    // 于是挂在 close 上的 token 自愈永远不会触发 —— 表现为「桥接活着但收发全废」，
    // 用户只能靠手工改 token 绕过去（issue #19）。这里同样尝试一次（内部有 10s 节流）。
    // 详情提取不能只用 JSON.stringify：Error 对象序列化恒为 `{}`（message 是不可枚举
    // 属性），日志里就只剩一句「SnowLuma 错误：{}」，排障时等于没有日志（2026-11-16
    // 每次桥接启动都刷一条）。cause（Node 16.9+ 的 Error.cause）也要翻出来。
    const detail = error && typeof error === 'object'
      ? [
        error.code,
        error.message,
        error.reason,
        error.type,
        error.cause?.message ?? error.cause?.code,
      ].filter(Boolean).join(' | ')
        || (error instanceof Error ? (error.stack ?? '').split(/\r?\n/).slice(0, 2).join(' | ') : '')
        || util.inspect(error, { depth: 2, breakLength: 200, maxStringLength: 160 })
      : String(error ?? '');
    log(`SnowLuma 错误：${detail || '(无详情)'}`);
    void healTokenIfStale(`error ${detail}`.trim().slice(0, 200));
  });

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 表情库预热放在 bot.on('open') 里（见上）：WS 没通时拉收藏表情必然失败，
  // 启动阶段调用只会制造一条吓人的假故障日志。AI 首次调用工具时也会兜底再试。

  // ── B站：记忆注入 / 动态同步 / 每天 8 次分享 ─────────────────────────────
  // 已组件化：src/qq/features/bilibili.js（状态、定时器、白名单、合体层开关都在组件内）。
  bili.start();
  loadQueued();
  startDshWatch();
  startSnowlumaWatch();
  const consoleServer = startConsoleServer();

  // 嵌入 DSH 时对外暴露一个生命周期句柄：停止/热重载由插件宿主调用。
  // 独立进程模式不设置它（保持原来的进程语义）。
  if (embed) {
    embeddedRuntime = {
      port: cfg.consolePort ?? 3100,
      get stopped() { return shuttingDown; },
      reload: async () => {
        try {
          const fresh = loadConfig();
          for (const key of Object.keys(cfg)) delete cfg[key];
          Object.assign(cfg, fresh);
          // 角色切换会改变目的状态文件的位置，热重载时一并重算。
          purpose.reloadStateFile();
          try { bot.close(1000, 'config reload'); } catch {}
          log('内嵌桥接：配置已热重载（SnowLuma 地址变更需重启 DSH）');
          return { ok: true, message: '配置已热重载（SnowLuma 地址变更需重启 DSH）' };
        } catch (error) {
          return { ok: false, error: `热重载失败：${error?.message ?? error}` };
        }
      },
      stop: async () => {
        if (shuttingDown) return { ok: true, already: true, message: '内嵌桥接已停止' };
        shuttingDown = true;
        // 叫醒还在退避 sleep 里的循环，别让 stop 之后留一个孤儿定时器拖住宿主退出。
        notifyShutdown();
        // 先叫醒事件流：不 abort 的话它一直挂在 for-await 上，旧实例会继续消费
        // 事件并与新实例抢着回复。
        try { muxAbort.abort(); } catch {}
        if (globalThis[BRIDGE_SINGLETON] === embeddedRuntime) delete globalThis[BRIDGE_SINGLETON];
        try { saveState(); } catch {}
        // 先落盘，再摘掉退出钩子：停止之后本实例不能再回写 —— 宿主可能已经让
        // 独立 bridge 接管，进程退出时用我们这份旧快照覆盖它更新的状态就是数据回退。
        try { flushSocialV2State(); } catch {}
        socialV2FlushOnShutdown = null;
        for (const timer of embeddedTimers) {
          try { clearInterval(timer); } catch {}
          try { clearTimeout(timer); } catch {}
        }
        embeddedTimers.length = 0;
        try { clearAllSocialV2Timers(); } catch {}
        // 社交模式 scheduleSocialReply 登记在 social.pendingTimers 里的延迟投递 —
        // 独立于上面的会话级定时器，stop 时必须一并清掉，否则它会在 shutdown 期间
        // 到期后绕过 shutdown 门再次调用 deliverPrompt（已加 shuttingDown 门但保险起见）。
        try { cancelAllSocialTimers(); } catch {}
        // 挂起问答的超时定时器（pending Map 全局持有）。同样有 shuttingDown 门，
        // 但直接清 entry.timer 让它从根源停掉。
        try {
          for (const [, entry] of pending) {
            try { clearTimeout(entry.timer); } catch {}
          }
          pending.clear();
        } catch {}
        try { if (social.loopTimer) clearInterval(social.loopTimer); } catch {}
        try { if (typeof runLogTrimTimer !== 'undefined') clearInterval(runLogTrimTimer); } catch {}
        try { purpose.stop(); } catch {}
        try { if (proactiveTimer) { clearInterval(proactiveTimer); proactiveTimer = null; } } catch {}
        try { await qqRegistry.stopAll(); } catch {}
        try { bili.stop(); } catch {}
        try {
          bot.close(1000, 'DSH plugin stopped');
          // SDK 的重连定时器不属于我们的 embeddedTimers：只要还有一处晚到的
          // request/close 把 closedByUser 重置，它就会在插件停掉之后继续每 2s
          // 重连一次（宿主进程不退出、热重载后新旧实例同时在线）。停机是一次性的，
          // 这里把重连入口一并焊死。
          bot.closedByUser = true;
          bot.reconnect = false;
          if (bot.reconnectTimer) { clearTimeout(bot.reconnectTimer); bot.reconnectTimer = null; }
        } catch {}
        await new Promise((resolve) => {
          try {
            consoleServer.close(() => resolve());
            const timer = setTimeout(resolve, 2000);
            timer.unref?.();
          } catch { resolve(); }
        });
        log('内嵌桥接：已停止（随 DSH 插件生命周期）');
        return { ok: true, stopped: true, message: '内嵌桥接已停止' };
      },
    };
    // 登记到 globalThis：热重载后的新实例靠它找到并停掉这个旧实例。
    globalThis[BRIDGE_SINGLETON] = embeddedRuntime;
    // 启动窗口内宿主已要求停用：此刻 runtime 才可用，补做停止（stopEmbedded 已把
    // 意图登记在 embeddedStopRequested；这里消费掉，避免宿主以为停了实例却活着）。
    if (embeddedStopRequested) {
      embeddedStopRequested = false;
      void embeddedRuntime.stop().catch((error) => {
        try { log('启动窗口内补做停止失败:', error?.message ?? error); } catch {}
      });
    }
  }

  await pumpMux();
}

/**
 * 进程级退出钩子：只有「独立进程模式」才安装。
 *
 * 嵌入 DSH 后这些钩子绝不能注册 —— 它们会 `process.exit()`，等于把整个 DSH 带走。
 */
function installProcessGuards() {
  /**
   * 退出前把「合并落盘」窗口里的二代会话状态刷到磁盘。
   *
   * 为什么必须有：saveSocialV2State() 现在是 300ms 合并写，正常退出如果不等这个窗口，
   * 最后一次入站缓冲 / 唤醒计数 / 读水位就会随进程一起消失（SIGTERM 恰好落在窗口内
   * 的概率不低：守护脚本 stop、DSH 退出、控制台重启都走这条路径）。
   * 用同步写，所以 'exit' 事件里也能生效。
   */
  const flushSocialV2StateOnExit = () => {
    try { socialV2FlushOnShutdown?.(); } catch {}
  };
  process.on('SIGINT', () => {
    log('退出中…');
    flushSocialV2StateOnExit();
    saveState();
    releaseLock();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    flushSocialV2StateOnExit();
    saveState();
    releaseLock();
    process.exit(0);
  });
  process.on('unhandledRejection', (error) => {
    // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
    log('未处理异常:', error?.stack ?? error?.message ?? error);
  });
  /**
   * 未捕获异常兜底。
   *
   * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
   * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
   * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
   * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
   * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
   */
  process.on('uncaughtException', (error) => {
    try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
    try { flushSocialV2StateOnExit(); } catch {}
    try { saveState(); } catch {}
    releaseLock();
    process.exit(1);
  });
  // 兜底最后一道：正常 return 的退出路径不经过上面几个信号处理器。
  process.on('exit', () => {
    flushSocialV2StateOnExit();
    releaseLock();
  });
  // 事件循环自然排空（没有显式 process.exit）时也刷一次：合并窗口里的脏数据
  // 若恰好卡在 unref 计时器上，进程会在计时器触发前就退出。
  process.on('beforeExit', () => {
    flushSocialV2StateOnExit();
  });
}

// 直接 `node src/bridge.js` 才自动启动；被 DSH 插件 import 时什么都不做。
const isDirectRun = (() => {
  try {
    return Boolean(process.argv[1])
      && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (isDirectRun && !EMBEDDED_MODE) {
  installProcessGuards();
  main().catch((error) => {
    console.error('[bridge] 启动失败:', error);
    process.exit(1);
  });
}

// ── 嵌入模式生命周期（DSH 插件宿主使用）─────────────────────────────────────
let embeddedStarted = false;
let embeddedStartupError = '';
// 启动窗口内的停止请求：main() 跑到赋值 embeddedRuntime 之前（最长约 12 秒），
// stopEmbedded() 看不到 runtime，过去会直接返回「未运行」，但 main() 仍在跑 ——
// 宿主以为停了、实例却活着（幽灵实例会继续连 SnowLuma 并处理消息）。
let embeddedStopRequested = false;
let embeddedExitFlushHooked = false;

export async function startEmbedded({ dshWebUrl = '' } = {}) {
  if (!EMBEDDED_MODE) {
    return { ok: false, error: '未以嵌入模式加载：需要先设置 SURFCORE_EMBEDDED=1 再 import bridge.js' };
  }
  if (embeddedStarted) {
    if (embeddedRuntime?.error) return { ok: false, error: embeddedRuntime.error };
    return { ok: true, already: true, port: embeddedRuntime?.port ?? null };
  }
  // 先占住位再做事：下面有 `await previousInstance.stop()` 这样的让出点，若把
  // `embeddedStarted = true` 放到它们之后，两个并发 startEmbedded（插件激活时
  // maybeAutoStartBridge 与 ensureBridgePluginHealth 同帧调进来）会都通过上面的
  // 检查、各自 main() 一遍 —— 两条事件流并行消费同一条 DSH 流。
  embeddedStarted = true;
  embeddedStartupError = '';
  embeddedStopRequested = false;
  // 嵌入模式**不能**装 installProcessGuards（那些钩子会 process.exit，等于把 DSH 带走），
  // 但「退出前把合并写刷盘」是纯同步写入、不退出进程，必须装：否则 DSH 被关掉时
  // saveSocialV2State 的 300ms 合并窗口里可能还有未落盘的入站缓冲/唤醒计数。
  // 只注册一次（插件可能被反复启停）。
  if (!embeddedExitFlushHooked) {
    embeddedExitFlushHooked = true;
    process.on('exit', () => { try { socialV2FlushOnShutdown?.(); } catch {} });
  }
  // 本插件自己泄漏的未处理 Promise 拒绝不能把宿主带走：Node 默认会把它升级成
  // 致命异常，嵌入 DSH 后"插件崩溃 = DSH 崩溃"。隔离器只吞堆栈属于本包的拒绝，
  // 外部拒绝仍按宿主原策略处理（详见 embedded-rejection-guard.js 顶部说明）。
  if (!globalThis[EMBEDDED_REJECTION_GUARD]) {
    const guard = createEmbeddedRejectionGuard({
      rootDir: ROOT,
      log: (...args) => { try { log(...args); } catch {} },
    });
    guard.install();
    globalThis[EMBEDDED_REJECTION_GUARD] = guard;
  }
  // 已有独立 bridge 占着端口：绝不能再连一次 SnowLuma，否则同一条 QQ 消息会处理两遍。
  if (consolePortInUse()) {
    embeddedStarted = false;
    return { ok: false, error: '端口 3100 已被占用（已有独立 bridge 在运行）；请先停掉它再让 DSH 接管' };
  }
  if (dshWebUrl) process.env.DSH_WEB_URL = String(dshWebUrl);
  // 热重载场景：旧模块实例可能还活着（它的 embeddedStarted 在新实例里看不到）。
  // 先按 globalThis 上的登记停掉旧的，再启动新的，否则两条事件流并行消费。
  const previousInstance = globalThis[BRIDGE_SINGLETON];
  if (previousInstance && typeof previousInstance.stop === 'function') {
    try { await previousInstance.stop(); } catch {}
  }
  main({ embed: true }).catch((error) => {
    embeddedStartupError = String(error?.message ?? error);
    embeddedStarted = false;
    try { log('内嵌桥接启动失败:', error?.stack ?? error); } catch {}
  });
  // 等端口就绪（与独立进程的 12 秒启动窗口一致）
  for (let i = 0; i < 24; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (embeddedRuntime?.error) return { ok: false, error: embeddedRuntime.error };
    if (embeddedStartupError) break;
    if (consolePortInUse()) return { ok: true, started: true, port: embeddedRuntime?.port ?? 3100 };
  }
  return { ok: false, error: embeddedStartupError || '内嵌桥接启动后端口未监听' };
}

export async function stopEmbedded() {
  if (!embeddedRuntime?.stop) {
    if (!embeddedStarted) return { ok: true, already: true, message: '内嵌桥接未运行' };
    // 还在启动窗口内：先登记停止意图（main() 完成注册后会立即自停），再等一个
    // 启动窗口（与 startEmbedded 一致，最多 12 秒）。等到就顺便同步停掉，
    // 返回结果更真实；等不到也已是「确定会停」，不会再出现幽灵实例。
    embeddedStopRequested = true;
    for (let i = 0; i < 24; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (embeddedRuntime?.stop) break;
      if (!embeddedStarted) break;
    }
    if (!embeddedRuntime?.stop) {
      return { ok: true, deferred: true, message: '内嵌桥接仍在启动，已登记停止请求（启动完成后立即停止）' };
    }
  }
  const result = await embeddedRuntime.stop();
  embeddedStarted = false;
  embeddedStopRequested = false;
  return result;
}

export async function reloadEmbedded() {
  if (!embeddedRuntime?.reload) return { ok: false, error: '内嵌桥接未运行' };
  return embeddedRuntime.reload();
}

export function embeddedStatus() {
  return {
    started: embeddedStarted,
    port: embeddedRuntime?.port ?? null,
    error: embeddedRuntime?.error || embeddedStartupError || '',
  };
}

export { main };
