/**
 * 配置路由（组件化迁移 #11）。
 *
 * GET  /config  → QQ / B站 / 合体层三份配置 + 默认值 + 备份 + 文件戳
 * POST /config  → 乐观并发校验后写回三份文件，并触发平台启停副作用
 *
 * 从 backend/lib/index.js 的 apply(ctx) 闭包里原样搬出；调度器生命周期
 * （scheduler / schedulerStatus）通过回调交回宿主维护，模块本身不持有状态。
 */
import path from 'node:path';

export function createConfigRoutes(deps) {
  const {
    STATE_DIR, QQ_CONFIG, BILI_CONFIG,
    readAll, configDefaults, pathSummary, listBackups, fileStamp, isStale,
    readQqConfig, readBiliConfig, readUnified,
    adminFromSources, projectAdminSave, normalizeAllowlist,
    saveQqConfig, saveBiliConfig, saveUnified,
    writeAlignmentBriefs, douyinSyncPolicy, douyinChatResume, startSyncTimer,
    runMemoryCardMaintenance, syncQqToBili,
    platformStartState, platformStartEnabled,
    invalidateScheduler, retireScheduler, resetSchedulerIdle, startSchedulerNow,
    stopBridge, startBridge, restartBridge, currentDshUrl,
    readJsonBody, json,
    // 只桌宠模式：保存配置时的「顺带启动」一律跳过（默认 false 便于旧测试独立复用）。
    petOnlyOn = () => false,
  } = deps || {};

  const required = {
    STATE_DIR, QQ_CONFIG, BILI_CONFIG,
    readAll, configDefaults, pathSummary, listBackups, fileStamp, isStale,
    readQqConfig, readBiliConfig, readUnified,
    adminFromSources, projectAdminSave, normalizeAllowlist,
    saveQqConfig, saveBiliConfig, saveUnified,
    writeAlignmentBriefs, douyinSyncPolicy, douyinChatResume, startSyncTimer,
    runMemoryCardMaintenance, syncQqToBili,
    platformStartState, platformStartEnabled,
    invalidateScheduler, retireScheduler, resetSchedulerIdle, startSchedulerNow,
    stopBridge, startBridge, restartBridge, currentDshUrl,
    readJsonBody, json,
  };
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === null) throw new TypeError(`config-routes 缺少依赖：${name}`);
  }

  async function handleConfig(req, res) {
    if (req.method === 'GET') {
      json(res, 200, {
        ok: true, ...readAll(),
        // 后端真实默认值（形状与 qq/bili/unified 一致、已脱敏）：设置页显示「默认是什么」
        // 直接读这里，别在前端再抄一份默认值（两份必然漂移）。
        defaults: configDefaults(),
        paths: pathSummary(), backups: listBackups(20),
        // 保存时回传这些戳：服务端据此判断"加载之后配置有没有被别处改过"
        stamps: {
          qq: fileStamp(QQ_CONFIG),
          bili: fileStamp(BILI_CONFIG),
          unified: fileStamp(path.join(STATE_DIR, 'config.json')),
        },
      });
      return;
    }
    const body = await readJsonBody(req);
    // 乐观并发：设置页加载后，如果配置被控制台/别的窗口改过，这里拒绝整份回写，
    // 否则会把别人的修改覆盖掉（2026-10-29：语音开关"自己回弹"）。
    const baseStamp = body?.baseStamp && typeof body.baseStamp === 'object' ? body.baseStamp : null;
    const currentStamps = {
      qq: fileStamp(QQ_CONFIG),
      bili: fileStamp(BILI_CONFIG),
      unified: fileStamp(path.join(STATE_DIR, 'config.json')),
    };
    if (baseStamp) {
      const stale = ['qq', 'bili', 'unified'].filter((k) => isStale(baseStamp[k], currentStamps[k]));
      if (stale.length) {
        json(res, 409, {
          ok: false, code: 'CONFIG_STALE',
          error: `配置已被别处修改（${stale.join(' / ')}），本次保存未执行`,
          hint: '点「重新读取」拿到最新配置后再改；直接覆盖会丢掉别人的修改',
          stamps: currentStamps,
        });
        return;
      }
    }
    const result = { ok: true, saved: {}, warnings: [] };
    // ── 管理员：QQ ⇄ B站 默认是同一个人 ────────────────────────────────────
    // 合体层 admin 是唯一真相；旧格式（qq.ownerQQ / bili.owner）是投影。
    // 合并逻辑放在 src/admin-identity.js 的 projectAdminSave（纯函数，有单测），
    // 这里只负责把结果写回三份文件，避免「只改了一边」。
    // 管理员 B站 UID：显式拒绝非法值，别静默清空（用户会以为"填不进去"）
    const rawAdminMid = String(body?.unified?.admin?.biliMid ?? '').trim();
    if (rawAdminMid && !/^\d{4,20}$/.test(rawAdminMid)) {
      json(res, 400, {
        ok: false, code: 'admin.mid-invalid',
        error: `管理员 B站 UID「${rawAdminMid}」不合法`,
        hint: 'B站 UID 是 4~20 位数字（个人空间地址 space.bilibili.com/<数字>）；不要带字母或空格',
      });
      return;
    }

    const currentQq = readQqConfig().config;
    const currentBili = readBiliConfig().config;
    const currentUnifiedState = readUnified();
    const beforePlatformStart = platformStartState();
    // 合并默认值后 admin 永远存在（默认空串）；只有用户文件里明确写过才当"显式清空"，
    // 否则会把旧字段 ownerQQ / owner.mid 当成没配置，保存时把两边投影抹掉。
    const currentUnified = currentUnifiedState.hasAdmin
      ? currentUnifiedState.config
      : { ...currentUnifiedState.config, admin: undefined };
    const currentAdmin = adminFromSources({ unified: currentUnified, qq: currentQq, bili: currentBili });
    const planned = projectAdminSave({ current: currentAdmin, qq: body.qq, bili: body.bili, unified: body.unified });
    if (planned.conflict) {
      result.warnings.push('管理员卡片与高级参数同时改了 ownerQQ / owner.mid：已按管理员卡片对齐，两边会同时写成同一个人。');
    }
    body.qq = planned.qq;
    body.bili = planned.bili;
    body.unified = planned.unified;
    // 名单 / 放行开关同 admin 一样以合体层为真相，但内置桥只读 qq/config.json
    //（AstrBot 路径读合体层）。以前只镜像了 admin：页面改白/黑名单后内置桥永远看不到
    //（2026-11-14 全量体检实测：合体层无 allow，qq/config.json 里才有效名单）。
    // 只镜像用户**明确写过**的键，避免一次无关保存把 QQ 侧已有名单冲掉。
    if (body.unified && typeof body.unified === 'object') {
      const u = body.unified;
      // 只同步「确实变了」的键：设置页保存时会把展示用名单一起带回来，
      // 否则改任何无关设置都会多写一次 QQ 配置并提示重启桥接。
      const cur = readQqConfig().config ?? {};
      const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      const mirror = {};
      if (Object.prototype.hasOwnProperty.call(u, 'allow') && !same(u.allow, cur.allow)) mirror.allow = u.allow;
      if (Object.prototype.hasOwnProperty.call(u, 'deny') && !same(u.deny, cur.deny)) mirror.deny = u.deny;
      if (Object.prototype.hasOwnProperty.call(u, 'allowAllWhenEmpty') && u.allowAllWhenEmpty !== (cur.allowAllWhenEmpty === true)) {
        mirror.allowAllWhenEmpty = u.allowAllWhenEmpty;
      }
      if (Object.keys(mirror).length) {
        body.qq = { ...(body.qq && typeof body.qq === 'object' ? body.qq : {}), ...mirror };
      }
    }
    if (body.qq && typeof body.qq === 'object') {
      if (body.qq.allow && typeof body.qq.allow === 'object') {
        const ownerForAllow = planned.unified?.admin?.qq || readQqConfig().config?.ownerQQ || '';
        const { allow, warnings } = normalizeAllowlist({ allow: body.qq.allow, ownerQQ: ownerForAllow });
        body.qq.allow = allow;
        for (const w of warnings) result.warnings.push(`白名单：${w.message}`);
      }
      const saved = saveQqConfig(body.qq);
      result.saved.qq = true;
      result.qq = saved.config;
      result.qqBackup = saved.backup;
      result.warnings.push('QQ 配置已保存；桥接只在启动时读 config.json，需要「重启桥接」才会生效。');
    }
    if (body.bili && typeof body.bili === 'object') {
      const saved = saveBiliConfig(body.bili);
      result.saved.bili = true;
      result.bili = saved.config;
      result.biliBackup = saved.backup;
      result.warnings.push('B站配置已保存；生物钟每轮重读配置，下一轮即生效。');
    }
    if (body.unified && typeof body.unified === 'object') {
      const saved = saveUnified(body.unified);
      result.saved.unified = true;
      result.unified = saved.config;
    }
    if (result.saved.unified) {
      try { writeAlignmentBriefs(); } catch (error) { result.warnings.push(`对齐简报重建失败：${error?.message ?? error}`); }
      try { invalidateScheduler(); } catch {}
      // 抖音的时段/额度投影到网页端账本；失败只提示，不影响其它设置落盘。
      try { douyinSyncPolicy(); } catch (error) { result.warnings.push(`抖音时段同步失败：${String(error?.message ?? error).slice(0, 120)}`); }
      // 群聊/私信开关变化后立即生效（关掉会停，开起来会在下一轮恢复）。
      // 只桌宠模式不恢复任何抖音连接。
      if (!petOnlyOn()) { try { void douyinChatResume(); } catch {} }
      startSyncTimer();
      // 改了记忆卡容量/注入上限后立刻重渲染，避免「设置保存了但提示词还是旧的」。
      try {
        const memoryCard = await runMemoryCardMaintenance({ config: readUnified().config.memoryCard });
        result.memoryCard = { status: memoryCard.status, changed: memoryCard.changed };
      } catch (error) {
        result.warnings.push(`记忆卡重渲染失败：${error?.message ?? error}`);
      }
      if (!petOnlyOn() && readUnified().config.memory?.qqToBili?.enabled === true) {
        try { result.qqMemory = syncQqToBili(); } catch (error) { result.warnings.push(`QQ→B站 同步失败：${error?.message ?? error}`); }
      }
    }
    // 平台启动开关的副作用：保存即生效（不是等下次重启）。
    // 用户关掉哪一边，就把正在跑的那一边停掉；重新打开则拉起来。
    // 这是「是否启动」和「只是改个参数」的区别，不能只写文件不执行。
    // 目的载体同理：切到桌宠后桥接下一次 tick 就不再自动出发（30 秒内生效），
    // 桌宠那边由 petPurpose 接手；不用重启桥接。
    if (result.saved.qq || result.saved.unified) {
      const afterCarrier = readQqConfig().config?.purpose?.carrier === 'pet' ? 'pet' : 'qq';
      const beforeCarrier = currentQq?.purpose?.carrier === 'pet' ? 'pet' : 'qq';
      result.purposeCarrier = afterCarrier;
      if (afterCarrier !== beforeCarrier) {
        result.warnings.push(afterCarrier === 'pet'
          ? '目的载体已切到「桌宠」：QQ 桥接不再自动主动搭话，改由桌宠气泡/语音发出（30 秒内生效，不用重启桥接）。'
          : '目的载体已切回「QQ」：桌宠不再主动搭话，改由桥接私聊你（30 秒内生效）。');
      }
    }
    const afterPlatformStart = platformStartState();
    result.platformStart = afterPlatformStart;
    if (result.saved.unified && process.env.SURFCORE_SKIP_AUTOSTART !== '1') {
      if (!afterPlatformStart.bili && beforePlatformStart.bili) {
        // 用 retire 而不是 stop：除了清定时器，还取消当前在途的 DSH 回合，
        // 否则关掉开关后她这一轮仍可能把消息发出去（见 PITFALLS #62）。
        try { await retireScheduler(); } catch (error) { result.warnings.push(`取消 B站 在途回合失败：${error?.message ?? error}`); }
        result.scheduler = resetSchedulerIdle('disabled');
        result.warnings.push('B站 启动开关已关闭：生物钟已停止。');
      } else if (afterPlatformStart.bili && !beforePlatformStart.bili) {
        if (petOnlyOn()) {
          result.warnings.push('只桌宠模式已开启：已跳过启动 B站 生物钟。');
        } else {
          result.scheduler = startSchedulerNow();
          result.warnings.push(result.scheduler.running
            ? 'B站 启动开关已打开：生物钟已启动。'
            : 'B站 启动开关已打开，但生物钟启动失败（看插件日志）。');
        }
      }
      if (!afterPlatformStart.qq && beforePlatformStart.qq) {
        const stopped = await stopBridge();
        // 不要写 result.bridge：前端把它当成「已重启」并显示错误提示；启停单独记。
        result.bridgeStop = stopped;
        result.warnings.push(stopped.ok
          ? 'QQ 启动开关已关闭：QQ 桥接已停止。'
          : `QQ 启动开关已关闭，但桥接没停下来：${stopped.error ?? stopped.message ?? '未知'}`);
      } else if (afterPlatformStart.qq && !beforePlatformStart.qq && body.restartBridge !== true) {
        if (petOnlyOn()) {
          result.warnings.push('只桌宠模式已开启：已跳过启动 QQ 桥接。');
        } else {
          const started = await startBridge({ dshWebUrl: currentDshUrl() });
          result.bridgeStart = started;
          result.warnings.push(started.ok
            ? 'QQ 启动开关已打开：QQ 桥接已启动。'
            : `QQ 启动开关已打开，但桥接启动失败：${started.error ?? started.message ?? '未知'}`);
        }
      }
    }
    if (body.restartBridge === true) {
      // 开关关掉时不允许「保存并重启」把 QQ 又拉起来；否则用户刚关的开关会被绕过。
      if (!platformStartEnabled('qq')) {
        result.warnings.push('QQ 启动开关已关闭：已跳过「保存并重启 QQ 桥接」。');
      } else {
        const restart = await restartBridge({ dshWebUrl: currentDshUrl() });
        result.bridge = restart;
        if (!restart.ok) result.warnings.push(`桥接重启失败：${restart.error ?? restart.message ?? '未知'}`);
      }
    }
    // 保存成功后把新的文件戳一起回传：客户端据此更新下一次保存的 baseStamp。
    // 不回传的话，第一次保存之后文件 mtime 已变，客户端仍拿旧戳 → 第二次保存必被判 CONFIG_STALE。
    result.stamps = {
      qq: fileStamp(QQ_CONFIG),
      bili: fileStamp(BILI_CONFIG),
      unified: fileStamp(path.join(STATE_DIR, 'config.json')),
    };
    json(res, 200, result);
  }

  return { handleConfig };
}
