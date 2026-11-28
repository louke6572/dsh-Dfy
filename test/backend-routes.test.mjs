/**
 * 后端路由功能族（#11）的边界回归：依赖契约 + 路由形状 + 关键副作用。
 * 路由体是从 backend/lib/index.js 原样搬出的，这里只验证搬出后的接口约定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPersonaRoutes } from '../backend/lib/routes/persona.js';
import { createLearningRoutes } from '../backend/lib/routes/learning.js';
import { createBridgeProxyRoutes } from '../backend/lib/routes/bridge-proxy.js';
import { createPetPurposeRoutes } from '../backend/lib/routes/pet-purpose.js';
import { createDouyinRoutes } from '../backend/lib/routes/douyin.js';
import { createConfigRoutes } from '../backend/lib/routes/config.js';
import { createCharacterRoutes } from '../backend/lib/routes/characters.js';
import { createMemoryRoutes } from '../backend/lib/routes/memory.js';
import { createDiagnosticsRoutes } from '../backend/lib/routes/diagnostics.js';
import { createSnowLumaRoutes } from '../backend/lib/routes/snowluma.js';
import { createConsoleExtrasRoutes } from '../backend/lib/routes/console-extras.js';
import { createModuleRoutes } from '../backend/lib/routes/modules.js';
import { isPetOnlyBlockedPath } from '../backend/lib/modules.js';
import { createBiliTiebaRoutes } from '../backend/lib/routes/bili-tieba.js';
import { createPlatformRoutes } from '../backend/lib/routes/platforms.js';

function makeRes() {
  const out = { status: 0, body: null };
  const json = (res, status, body) => { out.status = status; out.body = body; };
  return { out, json };
}

function makePersonaDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-persona-'));
  const files = {
    [path.join(dir, 'persona.md')]: '核心人格'.repeat(20),
    [path.join(dir, 'tone.md')]: '语气规则',
    [path.join(dir, 'examples.md')]: '语料',
    [path.join(dir, 'daily.md')]: '',
    [path.join(dir, 'group.md')]: '群聊场景',
  };
  let touches = 0;
  let quirks = [];
  let mood = '平静';
  const deps = {
    API_PREFIX: '/api',
    activePersonaLayers: () => ({
      core: path.join(dir, 'persona.md'),
      daily: path.join(dir, 'daily.md'),
      tone: path.join(dir, 'tone.md'),
      examples: path.join(dir, 'examples.md'),
      scenes: { 'qq-group': path.join(dir, 'group.md') },
      scenesDir: dir,
    }),
    resolvePersonaFile: () => path.join(dir, 'persona.md'),
    readTextFile: (file) => files[file] ?? '',
    listBackups: () => [{ name: 'persona-1.md' }, { name: 'other.json' }],
    mtimeIso: () => '2026-11-17T00:00:00.000Z',
    safeBackupName: (name) => String(name ?? ''),
    personaPresetStatus: () => ({ ok: true }),
    syncPersonaSystemPreset: () => ({ changed: false }),
    BACKUP_DIR: dir,
    backupFile: (target, label) => ({ target, label }),
    writeTextAtomic: (target, text) => { files[target] = text; },
    readCurrentCharacter: () => ({ id: 'c1', name: '小鲸鱼' }),
    touchCharacter: () => { touches += 1; },
    readUnified: () => ({ config: { admin: { displayName: '主人甲' } } }),
    readQqConfig: () => ({ config: {} }),
    adminSummary: (admin) => ({ displayName: String(admin?.displayName ?? '') }),
    personaClassifier: { classify: async () => ({ core: '', daily: '日常草稿' }) },
    scanText: () => ({ secrets: [], pii: [] }),
    personaSnapshot: () => ({ quirks, mood }),
    setPersonaQuirks: (next) => { quirks = next; },
    setPersonaMood: (next, note) => { mood = next + (note ? `（${note}）` : ''); },
    readJsonBody: async (req) => req.body ?? {},
    json: null,
    pluginLog: () => {},
    ...overrides,
  };
  return { deps, files, dir, getTouches: () => touches, getState: () => ({ quirks, mood }) };
}

test('路由工厂缺少依赖时构造即失败', () => {
  assert.throws(() => createPersonaRoutes({}), /persona-routes 缺少依赖/);
  assert.throws(() => createLearningRoutes({}), /learning-routes 缺少依赖/);
  assert.throws(() => createBridgeProxyRoutes({}), /bridge-proxy-routes 缺少依赖/);
  assert.throws(() => createPetPurposeRoutes({}), /pet-purpose-routes 缺少依赖/);
  assert.throws(() => createDouyinRoutes({}), /douyin-routes 缺少依赖/);
  assert.throws(() => createConfigRoutes({}), /config-routes 缺少依赖/);
  assert.throws(() => createCharacterRoutes({}), /character-routes 缺少依赖/);
  assert.throws(() => createMemoryRoutes({}), /memory-routes 缺少依赖/);
  assert.throws(() => createDiagnosticsRoutes({}), /diagnostics-routes 缺少依赖/);
  assert.throws(() => createSnowLumaRoutes({}), /snowluma-routes 缺少依赖/);
  assert.throws(() => createConsoleExtrasRoutes({}), /console-extras-routes 缺少依赖/);
  assert.throws(() => createModuleRoutes({}), /module-routes 缺少依赖/);
  assert.throws(() => createBiliTiebaRoutes({}), /bili-tieba-routes 缺少依赖/);
  assert.throws(() => createPlatformRoutes({}), /platform-routes 缺少依赖/);
});

test('GET /persona 返回分层内容，日常层自动补身份行', async () => {
  const { deps } = makePersonaDeps();
  const { out, json } = makeRes();
  const routes = createPersonaRoutes({ ...deps, json });
  await routes.handlePersona({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/persona'));
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.match(out.body.layers.daily.text, /你是小鲸鱼；你的主人是主人甲。/);
  assert.equal(out.body.backups.length, 1);
  assert.equal(out.body.backups[0].name, 'persona-1.md');
});

test('POST /persona 保存日常层并触碰角色；核心层过短被拒', async () => {
  const { deps, files, dir, getTouches } = makePersonaDeps();
  const { out, json } = makeRes();
  const routes = createPersonaRoutes({ ...deps, json });
  await routes.handlePersona(
    { method: 'POST', body: { layer: 'daily', text: '今天很安静' } },
    {},
    new URL('http://127.0.0.1/api/persona'),
  );
  assert.equal(out.status, 200);
  assert.equal(files[path.join(dir, 'daily.md')], '今天很安静\n');
  assert.equal(getTouches(), 1);

  await routes.handlePersona(
    { method: 'POST', body: { layer: 'core', text: '太短' } },
    {},
    new URL('http://127.0.0.1/api/persona'),
  );
  assert.equal(out.status, 400);
  assert.equal(out.body.code, 'PERSONA_CORE_TOO_SHORT');
});

test('POST /persona/classify 给草稿补身份行', async () => {
  const { deps } = makePersonaDeps();
  const { out, json } = makeRes();
  const routes = createPersonaRoutes({ ...deps, json });
  await routes.handlePersonaClassify(
    { method: 'POST', body: { text: '随便写写' } },
    {},
  );
  assert.equal(out.status, 200);
  assert.match(out.body.drafts.daily, /你是小鲸鱼/);
});

test('人格状态：GET 读快照，POST /config 改情绪与口头禅', async () => {
  const { deps, getState } = makePersonaDeps();
  const { out, json } = makeRes();
  const routes = createPersonaRoutes({ ...deps, json });
  await routes.handlePersonaState({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/persona/state'));
  assert.equal(out.body.mood, '平静');
  await routes.handlePersonaState(
    { method: 'POST', body: { quirks: ['嗯'], mood: '开心', note: '刚聊完' } },
    {},
    new URL('http://127.0.0.1/api/persona/config'),
  );
  assert.deepEqual(getState(), { quirks: ['嗯'], mood: '开心（刚聊完）' });
  assert.equal(out.status, 200);
});

test('学习路由：状态直读、配置夹取范围并重建定时器', async () => {
  let started = 0;
  let stopped = 0;
  let saved = null;
  const { out, json } = makeRes();
  const routes = createLearningRoutes({
    API_PREFIX: '/api',
    learningLoop: {
      status: () => ({ ok: true, enabled: true }),
      run: async () => ({ ok: true, ran: true }),
      start: () => { started += 1; },
      stop: () => { stopped += 1; },
    },
    rollbackAutoPersona: () => ({ ok: true }),
    saveUnified: (patch) => { saved = patch; },
    readJsonBody: async (req) => req.body ?? {},
    json,
  });
  await routes.handleLearning({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/learning/status'));
  assert.equal(out.body.ok, true);

  await routes.handleLearning(
    { method: 'POST', body: { intervalHours: 999, minItems: 0 } },
    {},
    new URL('http://127.0.0.1/api/learning/config'),
  );
  assert.deepEqual(saved, { learning: { intervalHours: 48, minItems: 1 } });
  assert.equal(stopped, 1);
  assert.equal(started, 1);

  await routes.handleLearning({ method: 'POST' }, {}, new URL('http://127.0.0.1/api/learning/nope'));
  assert.equal(out.status, 404);
});

test('桥接代理：群策略成功透传，桥接不可用时 502', async () => {
  const { out, json } = makeRes();
  const ok = createBridgeProxyRoutes({
    callBridge: async () => ({ ok: true, data: { tiers: ['a'] } }),
    readJsonBody: async (req) => req.body ?? {},
    json,
  });
  await ok.handleGroupPolicy({ method: 'GET' }, {});
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { tiers: ['a'] });

  const down = createBridgeProxyRoutes({
    callBridge: async () => ({ ok: false, error: 'down' }),
    readJsonBody: async (req) => req.body ?? {},
    json,
  });
  await down.handleGroupPolicy({ method: 'GET' }, {});
  assert.equal(out.status, 502);
  assert.equal(out.body.code, 'GROUP_POLICY_BRIDGE');
});

test('桌宠 / 目的路由：状态、测一句话与载体路由', async () => {
  const emitted = [];
  const { out, json } = makeRes();
  const routes = createPetPurposeRoutes({
    API_PREFIX: '/api',
    readQqConfig: () => ({ config: { purpose: { carrier: 'pet', petModality: 'voice' } } }),
    readJsonBody: async (req) => req.body ?? {},
    json,
    petService: { status: () => ({ installed: true, running: true, external: {} }) },
    petChat: {
      setFocus: () => ({ focus: true }),
      chat: async () => ({ ok: true, reply: { text: '嗨', modality: 'text', id: 'm1' } }),
      emit: (event) => { emitted.push(event); return 'ev1'; },
      status: () => ({ presence: { online: true } }),
      online: () => ({ online: true, lastSeenAt: 1 }),
      focusEnabled: () => true,
      roleInfo: () => ({ name: '小鲸鱼' }),
    },
    petPurpose: {
      status: () => ({ enabled: true, modality: 'text', fallbackToQQ: true, ownerName: '主人', config: {}, state: {}, online: true }),
      preview: async () => ({ ok: true, text: '预览' }),
      run: async () => ({ ok: true }),
    },
    bridgeStatus: async () => ({ running: true, ok: true }),
    callBridge: async () => ({ status: 200, data: { ok: true } }),
  });

  await routes.handlePet({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/pet/status'));
  assert.equal(out.body.installed, true);

  await routes.handlePet({ method: 'POST', body: { text: '在吗' } }, {}, new URL('http://127.0.0.1/api/pet/chat-test'));
  assert.equal(out.body.ok, true);
  assert.equal(emitted[0].text, '嗨');
  assert.equal(emitted[0].messageId, 'm1');

  await routes.handlePurpose({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/purpose/status'));
  assert.equal(out.body.source, 'pet');
  assert.equal(out.body.ownerName, '主人');

  await routes.handlePurpose({ method: 'POST', body: {} }, {}, new URL('http://127.0.0.1/api/purpose/pet-chat'));
  assert.equal(out.body.ok, true);
});

test('抖音路由：状态直读、未知动作 400、apply 同步策略', async () => {
  let synced = 0;
  const { out, json } = makeRes();
  const asyncOk = async () => ({ ok: true });
  const deps = {
    readJsonBody: async (req) => req.body ?? {},
    json,
    pluginLog: () => {},
    douyinSyncPolicy: () => { synced += 1; },
    readDouyinHistory: () => ({ videos: [] }),
    douyinStatus: async () => ({ ok: true, config: { enabled: false } }),
    douyinOpen: asyncOk, douyinCurrent: asyncOk, douyinNext: asyncOk, douyinSearch: asyncOk,
    douyinStart: asyncOk, douyinStop: asyncOk, douyinSummary: () => ({ ok: true }),
    douyinComments: asyncOk, douyinNotices: asyncOk, douyinDebrief: asyncOk,
    douyinChatStatus: asyncOk, douyinChatContacts: asyncOk, douyinChatConfigure: asyncOk,
    douyinChatStart: asyncOk, douyinChatStop: asyncOk, douyinChatRead: asyncOk,
    douyinChatMinimize: asyncOk, douyinChatModels: asyncOk, douyinChatSetModel: asyncOk,
    douyinChatSetup: asyncOk, douyinChatEnable: asyncOk, douyinChatRecover: asyncOk,
    douyinImStatus: () => ({ ok: true }), douyinImLoginQr: asyncOk, douyinImLoginSms: asyncOk,
    douyinImSubmitSms: asyncOk, douyinImLogout: asyncOk, douyinImContacts: asyncOk,
    douyinImSaveConfig: () => ({ ok: true }), douyinImStart: asyncOk, douyinImStop: asyncOk,
    douyinImSelftest: asyncOk,
  };
  const routes = createDouyinRoutes(deps);

  await routes.handleDouyin({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/douyin'));
  assert.equal(out.body.config.enabled, false);

  await routes.handleDouyin({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/douyin/history'));
  assert.deepEqual(out.body, { videos: [] });

  await routes.handleDouyin({ method: 'POST', body: { action: 'unknown' } }, {}, new URL('http://127.0.0.1/api/douyin'));
  assert.equal(out.status, 400);

  await routes.handleDouyin({ method: 'POST', body: { action: 'apply' } }, {}, new URL('http://127.0.0.1/api/douyin'));
  assert.equal(synced, 1);
  assert.equal(out.status, 200);
});

function makeConfigDeps(overrides = {}) {
  const calls = [];
  const deps = {
    STATE_DIR: 'C:/state', QQ_CONFIG: 'C:/state/qq.json', BILI_CONFIG: 'C:/state/bili.json',
    readAll: () => ({ qq: {}, bili: {}, unified: {} }),
    configDefaults: () => ({ qq: {} }),
    pathSummary: () => ({ state: 'C:/state' }),
    listBackups: () => [],
    fileStamp: () => 's1',
    isStale: (a, b) => a !== b,
    readQqConfig: () => ({ config: {} }),
    readBiliConfig: () => ({ config: {} }),
    readUnified: () => ({ config: {}, hasAdmin: false }),
    adminFromSources: () => ({}),
    projectAdminSave: ({ unified, qq, bili }) => ({ unified, qq, bili }),
    normalizeAllowlist: ({ allow }) => ({ allow, warnings: [] }),
    saveQqConfig: () => { calls.push('saveQq'); return { config: {}, backup: '' }; },
    saveBiliConfig: () => { calls.push('saveBili'); return { config: {}, backup: '' }; },
    saveUnified: () => { calls.push('saveUnified'); return { config: {} }; },
    writeAlignmentBriefs: () => calls.push('briefs'),
    douyinSyncPolicy: () => calls.push('douyin'),
    douyinChatResume: async () => calls.push('chatResume'),
    startSyncTimer: () => calls.push('syncTimer'),
    runMemoryCardMaintenance: async () => { calls.push('memoryCard'); return { status: 'ok', changed: false }; },
    syncQqToBili: () => ({ ok: true }),
    platformStartState: () => ({ qq: true, bili: true }),
    platformStartEnabled: () => true,
    invalidateScheduler: () => calls.push('invalidate'),
    retireScheduler: async () => calls.push('retire'),
    resetSchedulerIdle: (reason) => ({ running: false, reason }),
    startSchedulerNow: () => ({ running: true }),
    stopBridge: async () => ({ ok: true }),
    startBridge: async () => ({ ok: true }),
    restartBridge: async () => ({ ok: true }),
    currentDshUrl: () => 'http://127.0.0.1',
    readJsonBody: async (req) => req.body ?? {},
    json: null,
    ...overrides,
  };
  return { deps, calls };
}

test('配置路由：GET 带默认值与文件戳，保存触发重渲染副作用', async () => {
  const { deps, calls } = makeConfigDeps();
  const { out, json } = makeRes();
  const routes = createConfigRoutes({ ...deps, json });

  await routes.handleConfig({ method: 'GET' }, {});
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.stamps, { qq: 's1', bili: 's1', unified: 's1' });
  assert.deepEqual(out.body.defaults, { qq: {} });

  await routes.handleConfig(
    { method: 'POST', body: { unified: { admin: { biliMid: '12345' } }, qq: {}, bili: {} } },
    {},
  );
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.saved, { qq: true, bili: true, unified: true });
  for (const name of ['saveQq', 'saveBili', 'saveUnified', 'briefs', 'invalidate', 'douyin', 'syncTimer', 'memoryCard']) {
    assert.ok(calls.includes(name), `缺少副作用：${name}`);
  }
});

test('配置路由：旧文件戳拒绝覆盖，非法 B站 UID 直接 400', async () => {
  const { deps } = makeConfigDeps();
  const { out, json } = makeRes();
  const routes = createConfigRoutes({ ...deps, json });

  await routes.handleConfig(
    { method: 'POST', body: { baseStamp: { qq: 'old', bili: 's1', unified: 's1' }, qq: {} } },
    {},
  );
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'CONFIG_STALE');

  await routes.handleConfig(
    { method: 'POST', body: { unified: { admin: { biliMid: 'abc' } } } },
    {},
  );
  assert.equal(out.status, 400);
  assert.equal(out.body.code, 'admin.mid-invalid');
});

function makeCharacterDeps(overrides = {}) {
  const calls = [];
  const deps = {
    characterDetail: (id) => ({ ok: true, id }),
    characterOverview: () => ({ characters: [] }),
    getCharacterMigration: () => ({ migrated: true }),
    readCurrentCharacter: () => ({ id: 'c1' }),
    createCharacterFromPayload: () => ({ character: { id: 'c2' } }),
    switchCharacterEverywhere: async (id) => ({ switched: id }),
    updateCharacterFromPayload: (id) => ({ ok: true, id }),
    manualSnapshot: (id) => ({ slot: id }),
    autoSnapshot: (id) => ({ slot: id }),
    restoreCharacterSnapshot: (id, slot) => { calls.push(['restore', id, slot]); return { restored: slot }; },
    writeCharacterRolePointer: () => calls.push('pointer'),
    archiveBridgeRuntimeState: () => calls.push('archive'),
    ensureCharacterSystem: () => ({ ok: true }),
    deleteCharacter: (id) => ({ deleted: id }),
    bridgeStatus: async () => ({ running: true }),
    memoryCardIdle: async () => calls.push('memoryIdle'),
    stopAllBridgeSessions: async () => calls.push('stopSessions'),
    stopBridge: async () => { calls.push('stopBridge'); return { ok: true }; },
    startBridge: async () => { calls.push('startBridge'); return { ok: true }; },
    currentDshUrl: () => 'http://127.0.0.1',
    runMemoryCardMaintenance: async () => ({}),
    prepareSchedulerForRestore: async (skip) => calls.push(['prepare', skip]),
    resetSchedulerIdleForRestore: () => { calls.push('resetIdle'); return { running: false }; },
    getSchedulerStatus: () => ({ running: true }),
    startSchedulerNow: () => { calls.push('startScheduler'); return { running: true }; },
    readJsonBody: async (req) => req.body ?? {},
    json: null,
    pluginLog: () => {},
    ...overrides,
  };
  return { deps, calls };
}

test('角色路由：GET 总览带迁移信息，详情按 id 取', async () => {
  const { deps } = makeCharacterDeps();
  const { out, json } = makeRes();
  const routes = createCharacterRoutes({ ...deps, json });

  await routes.handleCharacters({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/characters'));
  assert.deepEqual(out.body, { characters: [], migration: { migrated: true } });

  await routes.handleCharacters({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/characters?id=c9'));
  assert.deepEqual(out.body, { ok: true, id: 'c9' });
});

test('角色路由：回档按序停桥、回滚、重启并恢复生物钟', async () => {
  const { deps, calls } = makeCharacterDeps();
  const { out, json } = makeRes();
  const routes = createCharacterRoutes({ ...deps, json });

  await routes.handleCharacters(
    { method: 'POST', body: { action: 'restore', id: 'c1', slot: 'slot-a' } },
    {},
  );
  assert.equal(out.status, 200);
  assert.equal(out.body.bridgeRestarted, true);
  assert.deepEqual(out.body.scheduler, { running: true });
  const order = calls.filter((item) => typeof item === 'string');
  assert.deepEqual(order, ['memoryIdle', 'resetIdle', 'stopSessions', 'stopBridge', 'pointer', 'archive', 'startBridge', 'startScheduler']);
  assert.deepEqual(calls.filter((item) => Array.isArray(item)), [['prepare', false], ['restore', 'c1', 'slot-a']]);
});

function makeMemoryDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-memory-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const paths = {
    qqForBili: path.join(dir, 'qq-for-bili.md'),
    inbox: path.join(dir, 'inbox.jsonl'),
    dir,
  };
  const calls = [];
  let saved = null;
  const deps = {
    PRIVACY_POLICY_VERSION: 'v1',
    readJsonBody: async (req) => req.body ?? {},
    json: null,
    readUnified: () => ({ config: { memoryCard: { organize: {} } } }),
    saveUnified: (patch) => { saved = patch; },
    maskPath: (value) => String(value),
    backupFile: (file, label) => { calls.push(['backup', file, label]); return `${file}.bak`; },
    QQ_STATE_DIR: () => stateDir,
    activeMemoryPaths: () => paths,
    readTextFile: () => '',
    QQ_ALIGNMENT_BRIEF: path.join(dir, 'qq-align.md'),
    BILI_ALIGNMENT_FILE: path.join(dir, 'bili-align.md'),
    platforms: { list: () => [] },
    memoryOrganizer: {
      llmReady: () => true,
      organize: async () => ({ ok: true }),
      diary: async () => ({ ok: true }),
    },
    callBridge: async () => ({ ok: true }),
    memoryStatus: () => ({ ok: true }),
    previewQqForBili: () => '预览',
    biliToQqStatus: () => ({ briefPreview: 'B站预览' }),
    auditTail: () => [],
    syncQqToBili: () => ({ ok: true }),
    refreshBiliToQq: async () => ({ ok: true }),
    scanQqFeedForCandidates: () => ({ candidates: 1 }),
    scanBiliFeedForCandidates: async () => ({ candidates: 2 }),
    rebuildAllPrompts: () => ({ rebuilt: true }),
    memoryCardSnapshot: () => ({ records: [], status: { percent: 0 } }),
    fullMemoryCardSnapshot: () => ({ records: [] }),
    applyMemoryCardAction: async () => ({ ok: true }),
    runMemoryCardMaintenance: async () => ({ changed: 0 }),
    compactMemoryCardNow: async () => ({ steps: [] }),
    restoreMemoryCardBackup: async () => ({ ok: true }),
    notifyOwnerIfNeeded: async () => ({ ok: true }),
    listLinks: () => [],
    listCandidates: () => [],
    addLink: (link) => link,
    updateLink: (id, patch) => ({ id, ...patch }),
    removeLink: () => ({ removed: true }),
    approveCandidate: () => ({}),
    rejectCandidate: () => ({}),
    importAlignments: () => ({}),
    exportAlignments: () => ({}),
    alignStats: () => ({}),
    ...overrides,
  };
  return { deps, dir, stateDir, paths, calls, getSaved: () => saved };
}

test('记忆路由：GET 汇总、清空只删 feed/记忆/同步状态并先备份', async () => {
  const { deps, stateDir, paths, calls } = makeMemoryDeps();
  const { out, json } = makeRes();
  const routes = createMemoryRoutes({ ...deps, json });

  await routes.handleMemory({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/memory?chars=500'));
  assert.equal(out.status, 200);
  assert.equal(out.body.qqPreview, '预览');
  assert.equal(out.body.biliPreview, 'B站预览');

  const feed = path.join(stateDir, 'qq-public-feed.jsonl');
  fs.writeFileSync(feed, '{}\n');
  fs.writeFileSync(paths.qqForBili, '记忆');
  fs.writeFileSync(path.join(paths.dir, 'sync-state.json'), '{}');
  await routes.handleMemory({ method: 'POST', body: { action: 'purge' } }, {}, new URL('http://127.0.0.1/api/memory'));
  assert.equal(out.status, 200);
  assert.equal(calls[0][0], 'backup');
  for (const file of [feed, paths.qqForBili, path.join(paths.dir, 'sync-state.json')]) {
    assert.equal(fs.existsSync(file), false, `未删除：${file}`);
  }
});

test('记忆卡路由：整理开关夹取范围，未知动作 400', async () => {
  const { deps, getSaved } = makeMemoryDeps();
  const { out, json } = makeRes();
  const routes = createMemoryRoutes({ ...deps, json });

  await routes.handleMemoryCard(
    { method: 'POST', body: { action: 'organize-config', enabled: true, diary: true, intervalHours: 999, minRecords: 0 } },
    {},
    new URL('http://127.0.0.1/api/memory-card'),
  );
  assert.equal(out.status, 200);
  assert.deepEqual(getSaved(), { memoryCard: { organize: { enabled: true, diary: true, intervalHours: 168, minRecords: 10 } } });

  await routes.handleMemoryCard({ method: 'POST', body: { action: 'nope' } }, {}, new URL('http://127.0.0.1/api/memory-card'));
  assert.equal(out.status, 400);

  await routes.handleMemoryCardFull({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/memory-card/full?limit=999'));
  assert.equal(out.status, 200);
});

test('对齐路由：GET 带 briefs，scan 同时扫描两端', async () => {
  const { deps } = makeMemoryDeps();
  const { out, json } = makeRes();
  const routes = createMemoryRoutes({ ...deps, json });

  await routes.handleAlign({ method: 'GET' }, {});
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.briefs, { qqChars: 0, biliChars: 0 });

  await routes.handleAlign({ method: 'POST', body: { action: 'scan' } }, {});
  assert.deepEqual(out.body.qq, { candidates: 1 });
  assert.deepEqual(out.body.bili, { candidates: 2 });
});

function makeDiagnosticsDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-diag-'));
  const calls = [];
  let savedMode = null;
  let savedOwner = null;
  let settingsUpdate = null;
  const deps = {
    getSettings: () => ({
      describe: () => [{ ns: 'qq-mode', value: { mode: 'chat' } }],
      update: async (ns, value) => { settingsUpdate = { ns, value }; },
    }),
    parseModeState: () => ({ localMode: 'chat', localRole: null }),
    readJsonBody: async (req) => req.body ?? {},
    json: null,
    pluginLog: () => {},
    readJson: () => ({}),
    writeJsonAtomic: (file, value) => { savedMode = { file, value }; },
    QQ_STATE_DIR: () => path.join(dir, 'qq-state'),
    readQqConfig: () => ({ config: { allow: {} } }),
    saveQqConfig: (patch) => { calls.push(['qq', patch]); return { config: patch }; },
    readUnified: () => ({ hasUserFile: true, config: {} }),
    saveUnified: (patch) => { savedOwner = patch; calls.push(['unified', patch]); },
    readAll: () => ({ unified: { admin: { qq: '10001' }, memory: {} } }),
    callBridge: async () => ({ ok: true }),
    pathSummary: () => ({}),
    backupFile: (file, label) => { calls.push(['backup', label]); return `${file}.bak`; },
    safeBackupName: (name) => String(name ?? ''),
    maskPath: (value) => String(value),
    resolvePersonaFile: () => path.join(dir, 'persona.md'),
    activeMemoryPaths: () => ({ qqForBili: path.join(dir, 'qq-for-bili.md') }),
    STATE_DIR: path.join(dir, 'state'),
    QQBOT_ROOT: dir,
    DSH_HOME: dir,
    UNIFIED_FILE: path.join(dir, 'unified.json'),
    BILI_MJS: path.join(dir, 'bili.mjs'),
    BILI_CONFIG: path.join(dir, 'bili.json'),
    BILI_CRED: path.join(dir, 'cred.json'),
    QQ_CONFIG: path.join(dir, 'qq.json'),
    ALIGN_FILE: path.join(dir, 'align.json'),
    QQ_ALIGNMENT_BRIEF: path.join(dir, 'qq-align.md'),
    BILI_ALIGNMENT_FILE: path.join(dir, 'bili-align.md'),
    BACKUP_DIR: path.join(dir, 'backups'),
    bridgeStatus: async () => ({ running: true, port: 1 }),
    astrbotSupervisor: { status: async () => ({ running: true, port: 6199 }) },
    astrbotApi: { listPlugins: async () => [], isQqConnected: async () => true, getRouteB: () => ({ on: false, apiBase: '' }) },
    portOpen: async () => true,
    currentDshUrl: () => 'http://127.0.0.1:1234',
    discoverSnowLumaConnection: async () => ({ ok: false }),
    diagnoseSnowLuma: async () => ({ state: 'unknown' }),
    buildInstallChecks: () => [{ name: 'QQ 桥接源码', ok: true }],
    installOk: () => true,
    planDoctorFix: () => ['生成统一配置', '生成控制台令牌'],
    normalizeAllowlist: ({ allow }) => ({ allow, warnings: [] }),
    startBridge: async () => ({ ok: true }),
    ...overrides,
  };
  return { deps, dir, calls, getMode: () => savedMode, getOwner: () => savedOwner, getSettingsUpdate: () => settingsUpdate };
}

test('模式路由：GET 读本地与 DSH 设置，POST 同步 mode.json 与 qq-mode', async () => {
  const { deps, calls, getMode, getSettingsUpdate } = makeDiagnosticsDeps();
  const { out, json } = makeRes();
  const routes = createDiagnosticsRoutes({ ...deps, json });

  await routes.handleMode({ method: 'GET' }, {});
  assert.equal(out.body.localMode, 'chat');
  assert.deepEqual(out.body.dshSetting, { mode: 'chat' });

  await routes.handleMode({ method: 'POST', body: { mode: 'reserved', ownerQQ: '10002' } }, {});
  assert.equal(out.status, 200);
  assert.deepEqual(getMode().value, { mode: 'reserved' });
  const qqSave = calls.find(([kind]) => kind === 'qq');
  assert.equal(qqSave[1].ownerQQ, '10002');
  assert.deepEqual(getSettingsUpdate(), { ns: 'qq-mode', value: { mode: 'reserved', ownerQQ: '10002' } });
});

test('诊断路由：doctor-fix 只补缺失项，backup 逐项落备份', async () => {
  const { deps, calls } = makeDiagnosticsDeps();
  const { out, json } = makeRes();
  const routes = createDiagnosticsRoutes({ ...deps, json });

  await routes.handleDiagnostics({ method: 'POST', body: { action: 'doctor-fix', ownerQQ: '10001' } }, {});
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.changed, ['生成统一配置', '生成控制台令牌']);
  assert.ok(calls.some(([kind, patch]) => kind === 'qq' && patch.consoleToken));

  calls.length = 0;
  await routes.handleDiagnostics({ method: 'POST', body: { action: 'backup' } }, {});
  assert.equal(out.body.created.length, 8);
  assert.equal(calls.filter(([kind]) => kind === 'backup').length, 8);
});

test('SnowLuma：未开启允许打开时只返回可执行错误，不启动进程', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-snow-'));
  const stateWrites = [];
  const routes = createSnowLumaRoutes({
    readQqConfig: () => ({ config: { snowluma: { allowLaunch: false } } }),
    saveQqConfig: () => ({}),
    readUnified: () => ({ config: {} }),
    readJsonBody: async (req) => req.body ?? {},
    json: () => {},
    pluginLog: () => {},
    QQBOT_ROOT: dir,
    STATE_DIR: dir,
    writeFileAtomic: () => {},
    writeJsonAtomic: (file, value) => stateWrites.push({ file, value }),
    bridgeStatus: async () => ({ running: false }),
    currentDshUrl: () => 'http://127.0.0.1:1234',
    getSchedulerRunning: () => false,
  });
  const result = await routes.launchSnowLuma();
  assert.equal(result.ok, false);
  assert.match(result.error, /未开启/);
  assert.equal(stateWrites.length, 2);
  assert.equal(stateWrites[1].value.phase, 'done');
});

test('外围接口：缺少 DeepSeek key 时直接给出排查提示', async () => {
  const { out, json } = makeRes();
  const routes = createConsoleExtrasRoutes({
    json,
    readJsonBody: async (req) => req.body ?? {},
    readQqConfig: () => ({ config: {} }),
    readAsrSettings: () => ({ apiKey: '', keySource: 'none' }),
    httpRequest: async () => { throw new Error('不该发起请求'); },
    consoleBase: () => 'http://127.0.0.1:3100',
    consoleToken: () => 't',
  });
  await routes.handleDeepseekStatus({ method: 'GET' }, {});
  assert.equal(out.status, 200);
  assert.equal(out.body.hasKey, false);
  assert.match(out.body.hint, /读不到 DeepSeek key/);
});

test('模块路由：停用 QQ/抖音会停对应运行时，未知模块 400', async () => {
  const calls = [];
  let saved = null;
  const modules = [{ id: 'qq' }, { id: 'douyin' }];
  const { out, json } = makeRes();
  const routes = createModuleRoutes({
    capabilityRegistry: { snapshot: () => ({}), switchTo: async () => ({}), runContract: async () => ({}), resetStats: () => ({}) },
    moduleList: () => modules,
    readUnified: () => ({ config: {} }),
    saveUnified: (patch) => { saved = patch; },
    readJsonBody: async (req) => req.body ?? {},
    json,
    douyinStop: async () => { calls.push('douyinStop'); },
    stopBridge: async () => { calls.push('stopBridge'); },
    pluginLog: () => {},
  });

  await routes.handleModules({ method: 'POST', body: { id: 'nope', enabled: false } }, {});
  assert.equal(out.status, 400);

  await routes.handleModules({ method: 'POST', body: { id: 'qq', enabled: false } }, {});
  assert.deepEqual(saved, { modules: { qq: false } });
  await routes.handleModules({ method: 'POST', body: { id: 'douyin', enabled: false } }, {});
  assert.deepEqual(calls, ['stopBridge', 'douyinStop']);
});

test('模块路由：只桌宠模式停所有集成运行时，关闭后恢复生物钟', async () => {
  const calls = [];
  let saved = null;
  const { out, json } = makeRes();
  const routes = createModuleRoutes({
    capabilityRegistry: { snapshot: () => ({}), switchTo: async () => ({}), runContract: async () => ({}), resetStats: () => ({}) },
    moduleList: () => [],
    readUnified: () => ({ config: saved ?? {} }),
    saveUnified: (patch) => { saved = patch; },
    readJsonBody: async (req) => req.body ?? {},
    json,
    douyinStop: async () => { calls.push('douyinStop'); },
    stopBridge: async () => { calls.push('stopBridge'); },
    douyinImStop: async () => { calls.push('douyinImStop'); },
    astrbotStop: () => { calls.push('astrbotStop'); },
    stopSchedulerNow: () => { calls.push('stopSchedulerNow'); },
    startSchedulerNow: () => { calls.push('startSchedulerNow'); },
    pluginLog: () => {},
  });

  await routes.handleModules({ method: 'POST', body: { petOnly: true } }, {});
  assert.deepEqual(saved, { petOnly: true });
  assert.equal(out.body.petOnly, true);
  assert.deepEqual(calls, ['stopBridge', 'douyinStop', 'douyinImStop', 'astrbotStop', 'stopSchedulerNow']);

  await routes.handleModules({ method: 'POST', body: { petOnly: false } }, {});
  assert.deepEqual(saved, { petOnly: false });
  assert.equal(out.body.petOnly, false);
  assert.equal(calls.at(-1), 'startSchedulerNow');
});

test('只桌宠模式：只放行桌宠与桌宠自己的配置接口', () => {
  const api = '/dsh-surfcore/api';
  for (const pathname of ['/pet', '/pet/chat', '/characters', '/persona', '/voice/preview', '/memory-card/full']) {
    assert.equal(isPetOnlyBlockedPath(`${api}${pathname}`, api), false, pathname);
  }
  for (const pathname of ['/qq-runtime', '/bridge', '/astrbot/panel', '/snowluma', '/platforms', '/platform-hub', '/mode', '/douyin/status', '/bili/status', '/tieba/status', '/memory/status', '/align']) {
    assert.equal(isPetOnlyBlockedPath(`${api}${pathname}`, api), true, pathname);
  }
  // /models 不能被 /mode 误伤
  assert.equal(isPetOnlyBlockedPath(`${api}/models`, api), false);
});

function makeBiliTiebaDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dfy-bili-'));
  const deps = {
    getCtx: () => ({ sessionController: {}, sessions: {} }),
    getScheduler: () => null,
    isSchedulerRunning: () => false,
    readJson: (file, fallback) => fallback,
    readJsonBody: async (req) => req.body ?? {},
    json: null,
    pluginLog: () => {},
    maskPath: (value) => String(value),
    writeJsonAtomic: () => {},
    readQqConfig: () => ({ config: {} }),
    QQ_STATE_DIR: () => path.join(dir, 'qq-state'),
    readBiliConfig: () => ({ config: { self: { mid: '100', name: '鱼' }, owner: { mid: '', name: '' } } }),
    saveBiliConfig: () => ({}),
    BILI_MJS: path.join(dir, 'bili.mjs'),
    BILI_TOOLS_DIR: dir,
    BILI_CRED: path.join(dir, 'credentials.json'),
    BILI_AI_DIR: dir,
    BILI_DIR: dir,
    BACKUP_DIR: path.join(dir, 'backups'),
    ALIGN_FILE: path.join(dir, 'align.json'),
    activePlatformStateDir: () => dir,
    readCurrentCharacter: () => ({ id: 'c1', name: '角色', epoch: 1 }),
    readWatchHistory: () => ({ items: [{ bvid: 'BV1' }], total: 1 }),
    enrichWatchHistory: (items) => ({ items: items.map((item) => ({ ...item, acted: true })), actions: ['comment'] }),
    scanPreferences: async () => ({ ok: true, words: [] }),
    fishGuardStateSummary: () => ({ recent: [] }),
    summarizeQqFishGuard: () => ({ triggers: 0 }),
    automationSnapshot: () => ({ enabled: false }),
    callBridge: async () => ({ ok: true }),
    findNodeExe: () => 'node',
    applySessionPermission: () => ({ ok: true }),
    biliCookieHeader: () => '',
    readFishAccount: () => ({ configured: true, mid: '', name: '' }),
    readOwnerAccount: () => ({ mid: '200', name: '主人' }),
    pollQrLogin: async () => ({ ok: true }),
    startQrLogin: async () => ({ id: 'qr' }),
    cancelQrLogin: () => {},
    verifyStoredCredentials: async () => ({ ok: true }),
    saveTiebaCookieLogin: async () => ({ ok: true }),
    markTiebaVerified: () => {},
    verifyStoredTiebaCredentials: async () => ({ ok: true }),
    readTiebaViewHistory: () => ({ items: [] }),
    tiebaStatus: () => ({ ok: true, loggedIn: false }),
    tiebaAction: async () => ({ done: true }),
    clearTiebaCredentials: () => {},
    startTiebaQrLogin: async () => ({ id: 'tieba_qr_x' }),
    pollTiebaQrLogin: async () => ({ status: 'waiting' }),
    cancelTiebaQrLogin: () => {},
    ...overrides,
  };
  return { deps, dir };
}

test('B站/贴吧：观看历史补动作、账号回落配置、贴吧 GET 状态', async () => {
  const { deps } = makeBiliTiebaDeps();
  const { out, json } = makeRes();
  const routes = createBiliTiebaRoutes({ ...deps, json });

  routes.handleWatchHistory({}, new URL('http://127.0.0.1/bili/watch-history?limit=10'));
  assert.equal(out.body.items[0].acted, true);
  assert.deepEqual(out.body.actions, ['comment']);

  await routes.handleBili({ method: 'GET' }, {}, new URL('http://127.0.0.1/bili/accounts'));
  assert.equal(out.body.fish.mid, '100');
  assert.equal(out.body.fish.name, '鱼');
  assert.equal(out.body.owner.mid, '200');

  await routes.handleTieba({ method: 'GET' }, {}, new URL('http://127.0.0.1/tieba/status'));
  assert.equal(out.body.loggedIn, false);
});

test('贴吧：生物钟未运行时 heartbeat-now 返回 400 与可执行提示', async () => {
  const { deps } = makeBiliTiebaDeps();
  const { out, json } = makeRes();
  const routes = createBiliTiebaRoutes({ ...deps, json });

  await routes.handleTieba(
    { method: 'POST', body: { action: 'heartbeat-now' } },
    {},
    new URL('http://127.0.0.1/tieba/heartbeat-now'),
  );
  assert.equal(out.status, 400);
  assert.match(out.body.error, /生物钟没在运行/);
});

function makePlatformDeps(overrides = {}) {
  const calls = [];
  let saved = null;
  const deps = {
    platforms: { statusAll: async () => ({ qq: 'ok' }) },
    platformHub: { snapshot: async () => ({ plugins: [] }) },
    astrbotSupervisor: { status: async () => ({ running: true }) },
    getLlmService: () => ({
      listProviders: () => [{ id: 'p1', name: '提供商1' }],
      listModels: async () => [{ id: 'm1', name: '模型1' }],
    }),
    getDefaultModelService: () => ({ currentSelection: () => ({ provider: 'p1', model: 'm1' }), saveSelection: async () => {} }),
    readUnified: () => ({ config: { model: { provider: '', model: '' } } }),
    saveUnified: (patch) => { saved = payloadMerge(saved, patch); calls.push(['saveUnified', patch]); },
    readQqConfig: () => ({ config: {} }),
    saveQqConfig: (patch) => { calls.push(['saveQqConfig', patch]); return { config: patch }; },
    readJsonBody: async (req) => req.body ?? {},
    json: null,
    pluginLog: () => {},
    updates: { status: () => ({ items: [] }), check: async () => ({ ok: true }), apply: async () => ({ ok: true }), rollback: async () => ({ ok: true }), dismiss: () => ({}), resetDismissed: () => ({}) },
    tokenBudget: {
      budgetFile: 'budget.json',
      status: async () => ({ ok: true }),
      resetLimits: () => calls.push('resetLimits'),
      addLimit: () => calls.push('addLimit'),
      saveLimits: () => calls.push('saveLimits'),
    },
    backupFile: (file, label) => { calls.push(['backup', label]); return `${file}.bak`; },
    ...overrides,
  };
  return { deps, calls, getSaved: () => saved };
}

function payloadMerge(current, patch) {
  return { ...(current ?? {}), ...(patch ?? {}) };
}

test('平台路由：平台状态透传，模型保存同步 QQ 与 DSH 默认', async () => {
  const { deps, calls } = makePlatformDeps();
  const { out, json } = makeRes();
  const routes = createPlatformRoutes({ ...deps, json });

  await routes.handlePlatforms({ method: 'GET' }, {});
  assert.deepEqual(out.body.platforms, { qq: 'ok' });

  await routes.handleModels({ method: 'POST', body: { provider: 'p1', model: 'm1' } }, {});
  assert.equal(out.body.defaultSaved, true);
  assert.ok(calls.some(([kind]) => kind === 'saveUnified'));
  assert.ok(calls.some(([kind, patch]) => kind === 'saveQqConfig' && patch.dsh.model === 'm1'));
});

test('额度路由：保存前先备份，缺字段返回 400', async () => {
  const { deps, calls } = makePlatformDeps();
  const { out, json } = makeRes();
  const routes = createPlatformRoutes({ ...deps, json });

  await routes.handleTokenBudget({ method: 'POST', body: { limits: { daily: 100 } } }, {}, new URL('http://127.0.0.1/token-budget'));
  assert.equal(out.status, 200);
  assert.deepEqual(calls[0], ['backup', 'token-budget-before-save']);
  assert.ok(calls.includes('saveLimits'));

  await routes.handleTokenBudget({ method: 'POST', body: {} }, {}, new URL('http://127.0.0.1/token-budget'));
  assert.equal(out.status, 400);
});

