/* 概览（运行状态）/ 安装与更新：一页两视图，互不挤在一起。 */

function OverviewPage({ view = "home", overview, reload, busy, setBusy, toast, goTab, autoStart, openConsole, refreshStamps }) {
  const bridge = overview?.bridge ?? {};
  const biliStatus = overview?.bili ?? {};
  const memory = overview?.memory ?? {};
  const align = overview?.alignment ?? {};
  const scheduler = overview?.scheduler ?? {};
  const snow = overview?.snowluma ?? {};
  // 网关是独立进程：桥接在跑 ≠ 消息发得出去（3100 能应答只说明桥接活着）。
  const gateway = bridge?.snowluma ?? {};
  const gatewayConnected = gateway.connected === true;
  const platformStart = overview?.platformStart ?? {};
  const qqStart = platformStart.qq !== false;
  const biliStart = platformStart.bili !== false;
  // 路线 B：QQ 由 AstrBot 接管。这一页的「启动 QQ 桥接」向导和桥接状态都要换说法，
  // 否则会误导用户去启动内置桥 → 和 AstrBot 双回复。
  // QQ 运行方式：内置版（dsh-Dfy 内置桥）/ AstrBot 版（插件桥接），二选一
  const qqRuntime = overview?.qqRuntime === "builtin" ? "builtin" : "astrbot";
  // 只有 AstrBot 版 + 装了 dsh_bridge 才算插件桥接；内置版一律按旧桥显示
  const pluginMode = qqRuntime === "astrbot" && overview?.routeB?.bridgePlugin === true;
  const routeBOn = pluginMode || overview?.routeB?.on === true;
  const routeBQq = overview?.routeB?.qqConnected === true;
  const douyin = overview?.douyin ?? {};

  const [gates, setGates] = useState(null);
  const [snowError, setSnowError] = useState(null);
  const [snowImport, setSnowImport] = useState(false);
  // 维护页的 AstrBot 状态（Supervisor 状态 + 插件数 + QQ 接入）
  const [astrbotInfo, setAstrbotInfo] = useState(null);
  const loadAstrbotInfo = useCallback(async () => {
    try {
      const [hub, panel] = await Promise.all([api("/platform-hub"), api("/astrbot/panel")]);
      setAstrbotInfo({
        status: hub?.astrbot ?? null,
        plugins: Array.isArray(panel?.plugins) ? panel.plugins : [],
        qqConnected: panel?.qqConnected === true,
        routeB: panel?.routeB ?? null,
      });
    } catch { setAstrbotInfo(null); }
  }, []);
  // 维护页的 SnowLuma 状态（账号 / 控制台 / 鉴权状态，来自 /snowluma）
  const [snowlumaInfo, setSnowlumaInfo] = useState(null);
  const loadSnowlumaInfo = useCallback(async () => {
    try {
      const r = await api("/snowluma");
      setSnowlumaInfo(r ?? null);
    } catch { setSnowlumaInfo(null); }
  }, []);
  useEffect(() => {
    if (view !== "install") return;
    loadAstrbotInfo();
    loadSnowlumaInfo();
  }, [view, loadAstrbotInfo, loadSnowlumaInfo]);
  const astrbotAct = async (action) => {
    setBusy(`astrbot-${action}`);
    try {
      const r = await api("/astrbot/action", { method: "POST", body: { action } });
      say(r.ok ? `✓ ${action === "start" ? "已拉起 AstrBot" : "已重启 AstrBot（约 30 秒）"}` : `✗ ${r.error ?? "失败"}`);
      await loadAstrbotInfo();
    } catch (e) { say(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };
  // 高级/回退：旧 provider 路线与「不经过 QQ 的大脑自测」（从「我的鱼」页挪过来，日常不占位）
  const [fallbackText, setFallbackText] = useState("");
  const [fallbackReply, setFallbackReply] = useState("");
  const switchFallbackRoute = async (on) => {
    setBusy("route-b");
    try {
      const r = await api("/astrbot/route-b", { method: "POST", body: { on } });
      say(r.ok ? `✓ ${r.message}` : `✗ ${r.error ?? "失败"}`);
      await loadAstrbotInfo();
    } catch (e) { say(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };
  const testBridgeBrain = async () => {
    const text = fallbackText.trim();
    if (!text) return;
    setBusy("bridge-test");
    setFallbackReply("…她在想");
    try {
      const r = await api("/astrbot/qq-bridge-test", { method: "POST", body: { text } });
      setFallbackReply(r.ok ? (r.reply || "（空回复）") : `✗ ${r.error ?? "失败"}`);
    } catch (e) { setFallbackReply(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  // toast 是宿主每次渲染新建的函数：用 ref 固定住，避免定时器/useCallback 每次渲染都重建。
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const say = (msg) => { try { toastRef.current?.(msg); } catch { /* 宿主没给 toast 时忽略 */ } };

  const loadGates = useCallback(async ({ manual = false } = {}) => {
    if (manual) setBusy("gates-refresh");
    try {
      const r = await api("/gate-events?limit=30&includeAcked=0");
      setGates(r);
      if (manual) say(`✓ 已刷新：未确认 ${(r.events ?? []).length} 条`);
    } catch (e) {
      // 手动刷新失败要说话；自动轮询失败保持旧数据，别把页面清空成「没数据」
      if (manual) say(`✗ 刷新失败：${e.message}`);
    } finally {
      if (manual) setBusy("");
    }
  }, []);
  useEffect(() => { if (view === "home") loadGates(); }, [view, loadGates]);

  const act = async (action) => {
    setBusy(action);
    try {
      const res = await api("/bridge", { method: "POST", body: { action } });
      toast(res.ok ? `✓ ${res.message ?? "完成"}` : `✗ ${res.error ?? "失败"}`);
      await reload();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  // 全部停止：QQ 桥接 + B站 一起停（和顶部「一键开始」对称，只有一个入口）。
  const stopAll = async () => {
    setBusy("stop-all");
    try {
      const res = await api("/bridge", { method: "POST", body: { action: "stop-selected", components: ["qq", "bili"] } });
      const bad = (res.items ?? []).filter((x) => !x.ok);
      say(bad.length
        ? `✗ ${bad.length} 项没停下：${bad.map((x) => `${x.label}（${x.error || ""}）`).join("、")}`
        : `✓ 已全部停止${(res.items ?? []).length ? `：${res.items.map((x) => x.label).join("、")}` : ""}`);
      await reload();
    } catch (e) { say(`✗ 全部停止失败：${e.message}`); } finally { setBusy(""); }
  };

  const [snowScan, setSnowScan] = useState(null);
  // 面板直连 SnowLuma 控制台：账号 + QQ 注入进程，全部在设置页里操作。
  const [snowApi, setSnowApi] = useState(null);
  const [webuiPwd, setWebuiPwd] = useState("");
  // 配好一次之后向导收起来，日常只剩「加/删账号」——像 DSH 配好模型后直接用。
  const [forceWizard, setForceWizard] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const loadSnowApi = useCallback(async ({ manual = false } = {}) => {
    if (manual) setBusy("snow-refresh");
    try {
      const r = await api("/snowluma");
      setSnowApi(r);
      if (manual) {
        say(`✓ 已刷新：账号 ${(r.accounts ?? []).length} 个 · 进程 ${(r.processes ?? []).length} 个${r.note ? `（${r.note}）` : ""}`);
      }
    } catch (e) {
      // 关键：失败时**保留上一次的数据**。之前这里 setSnowApi(null)，网络抖一下就误报「控制台没在运行」。
      if (manual) say(`✗ 刷新失败：${e.message}`);
    } finally {
      if (manual) setBusy("");
    }
  }, []);
  useEffect(() => { if (view === "home") loadSnowApi(); }, [view, loadSnowApi]);
  // 向导进度自己走（账号登录 / 注入完成后不用手动刷新）
  useEffect(() => {
    if (view !== "home") return undefined;
    const timer = setInterval(() => { void loadSnowApi(); }, 30_000);
    return () => clearInterval(timer);
  }, [view, loadSnowApi]);
  const connectWebui = async () => {
    setBusy("webui-login");
    try {
      await api("/snowluma", { method: "POST", body: { action: "login", password: webuiPwd } });
      setWebuiPwd("");
      toast("✓ 已连上 SnowLuma 控制台");
      await loadSnowApi();
    } catch (e) { toast(`✗ ${e.message}`); } finally { setBusy(""); }
  };
  const processAct = async (action, pid) => {
    setBusy("proc");
    try {
      const r = await api("/snowluma", { method: "POST", body: { action, pid } });
      toast(`✓ ${r.message ?? "完成"}`);
      await loadSnowApi();
    } catch (e) { toast(`✗ ${e.message}`); } finally { setBusy(""); }
  };
  const forgetWebui = async () => {
    setBusy("webui-logout");
    try {
      await api("/snowluma", { method: "POST", body: { action: "logout" } });
      toast("已断开 SnowLuma 控制台，密码已清除");
      await loadSnowApi();
    } catch (e) { toast(`✗ ${e.message}`); } finally { setBusy(""); }
  };
  const scanSnow = async () => {
    setBusy("snow-scan");
    try {
      const r = await api("/diagnostics", { method: "POST", body: { action: "install-scan" } });
      setSnowScan(r);
      const s = r?.snow ?? {};
      toast(r?.ok ? `✓ 已连上 SnowLuma：${s.nickname || "?"}${s.uin ? `（${s.uin}）` : ""} · 群 ${(r.groups ?? []).length} 个` : `✗ ${r?.error || "没连上 SnowLuma"}`);
    } catch (e) { toast(`✗ ${e.message}`); } finally { setBusy(""); }
  };
  const applySnow = async () => {
    setBusy("snow-apply");
    try {
      const r = await api("/diagnostics", { method: "POST", body: { action: "install-apply", discoverSnow: true } });
      toast(`✓ ${(r?.changed ?? []).join("、") || "已写入"}${r?.needRestart ? "（重启桥接后生效）" : ""}`);
      await reload();
    } catch (e) { toast(`✗ ${e.message}`); } finally { setBusy(""); }
  };

  const detectSnow = async (picked = "") => {
    setBusy("detect");
    try {
      const r = await api("/bridge", { method: "POST", body: { action: "detect-snowluma", ...(picked ? { path: picked } : {}) } });
      if (r.ok) { toast(`✓ ${r.message}`); await reload(); }
      else setSnowError({ title: r.title || "没找到 SnowLuma", message: r.error || "没找到 SnowLuma", hint: r.hint || "", tried: r.tried ?? [] });
    } catch (e) {
      setSnowError({ title: "检测失败", message: e.message, hint: "确认 DSH 插件正常后重试；也可以直接选目录。" });
    } finally { setBusy(""); }
  };
  const pickSnow = async (mode) => {
    setSnowImport(false);
    const r = await browseNative(mode, mode === "file" ? "选择 SnowLuma 的启动文件（SnowLuma.exe 或 app\\launcher.bat）" : "选择 SnowLuma2 根目录（里面有 app）");
    if (r.ok && r.path) await detectSnow(String(r.path));
    else if (!r.cancelled) toast(`✗ ${r.error || "打不开选择框"}`);
  };
  const ackGates = async (id) => {
    try {
      await api("/gate-events", { method: "POST", body: id ? { ids: [id] } : { all: true } });
      say(id ? "✓ 已确认这条提醒" : "✓ 已全部确认");
      await loadGates();
    } catch (e) { say(`✗ 确认失败：${e.message}`); }
  };

  const buckets = [];
  for (const ev of gates?.events ?? []) {
    const text = ev.impact || ev.reason?.message || ev.event || "";
    const key = `${ev.level}|${ev.gate}|${text}`;
    const hit = buckets.find((b) => b.key === key);
    if (hit) hit.count += 1; else buckets.push({ key, count: 1, ev, text });
  }

  if (view === "home") {
    // 步骤逻辑在 01-core 的 buildSetupSteps（可单测）：核心完成条件 = 桥接在跑且网关连通。
    const webuiUp = Boolean(snowApi?.webui?.up);
    const accounts = snowApi?.accounts ?? [];
    const processes = snowApi?.processes ?? [];
    const firstFree = processes.find((p) => !(p.loaded === true || p.injected === true || p.hooked === true) && p.pid);
    const wizard = buildSetupSteps({
      launcherPath: snow.launcherPath,
      detected: snow.detected === true,
      webuiUp,
      hasPassword: Boolean(snowApi?.hasPassword),
      accounts,
      bridgeRunning: Boolean(bridge.running),
      gatewayConnected,
      processPid: firstFree?.pid ?? null,
    });
    // 路线 B 接管 QQ 时，「启动 QQ 桥接」这一步不但不用做，做了还会双回复 ——
    // 在向导里直接标成已完成并改文案，别让用户点。
    const steps = pluginMode
      ? wizard.steps.map((s) => (s.actionId === "auto-start"
        ? {
          ...s,
          label: "接入 AstrBot（插件桥接，自动建 DSH 会话）",
          done: true,
          doneText: routeBQq ? "路线 B 已接管" : "路线 B 待接入",
          hint: routeBQq
            ? "QQ 已由 AstrBot 接管（插件桥接）：消息按 QQ 会话进 DSH，每条对话一个会话窗口；内置桥保持停止是正确状态"
            : "QQ 已切给 AstrBot，但还没连上：重启一次 SnowLuma 即可",
        }
        : s))
      : wizard.steps;
    const currentStep = steps.find((s) => !s.done);
    const doneCount = steps.filter((s) => s.done).length;
    // 插件桥接模式下 QQ 由 AstrBot 接管，内置桥「不运行」是正常的 —— 向导不再要求走完桥接那步。
    const configured = wizard.ready || routeBOn;
    const runStep = (id) => {
      if (id === "detect") return detectSnow();
      if (id === "start-snowluma") return act("start-snowluma");
      if (id === "open-console") return act("open-snowluma-webui");
      if (id === "process-load") return processAct("process-load", firstFree?.pid);
      if (id === "refresh") return loadSnowApi({ manual: true });
      if (id === "auto-start") return autoStart();
      return undefined;
    };
    const switchRuntime = async (mode) => {
      if (mode === qqRuntime) return;
      if (!confirm(`切换到${mode === "builtin" ? "内置版" : "AstrBot 版"}？会重启 SnowLuma（约 10 秒），QQ 会短暂重连。`)) return;
      setBusy("runtime-switch");
      try {
        const r = await api("/qq-runtime", { method: "POST", body: { mode } });
        toast(r.ok ? `✓ 已切到${mode === "builtin" ? "内置版" : "AstrBot 版"}${r.restart?.ok ? "" : "（SnowLuma 重启未确认，请手动重启）"}` : `✗ ${r.error ?? "切换失败"}`);
        reload();
      } catch (e) { toast(`✗ ${e.message}`); }
      finally { setBusy(""); }
    };
    const loadedList = processes.filter((p) => p.loaded === true || p.injected === true || p.hooked === true);
    // 日常操作：加账号 = 注入一个没注入的 QQ 进程（之后手机扫码）；删账号 = 取消注入。
    const addAccount = async () => {
      if (firstFree) { await processAct("process-load", firstFree.pid); return; }
      toast("先打开 QQ 停在登录页（要加哪个号就登录哪个号），再点「+ 添加账号」");
      await loadSnowApi({ manual: true });
    };
    return h("div", null,
      h(Card, {
        title: "QQ 运行方式（二选一）",
        right: h(Badge, { kind: qqRuntime === "builtin" ? "ok" : "warn" }, qqRuntime === "builtin" ? "内置版" : "AstrBot 版"),
      },
        h("div", { className: "qbw-hint" }, qqRuntime === "builtin"
          ? "当前：内置版。QQ → SnowLuma → dsh-Dfy 内置桥 → DSH，少一跳、回复更快；AstrBot 不接 QQ（它的插件效果不走这条线）。"
          : "当前：AstrBot 版。QQ → SnowLuma → AstrBot（插件层）→ dsh_bridge → DSH；能用 AstrBot 的表情包等插件，但多一跳、会慢一些。"),
        h("div", { className: "qbw-actions" },
          h(Btn, { kind: qqRuntime === "builtin" ? "qbw-btn3" : "", onClick: () => switchRuntime("builtin"), disabled: !!busy }, busy === "runtime-switch" ? "切换中…" : "切到内置版"),
          h(Btn, { kind: qqRuntime === "astrbot" ? "qbw-btn3" : "", onClick: () => switchRuntime("astrbot"), disabled: !!busy }, "切到 AstrBot 版")),
        h("div", { className: "qbw-hint" }, "切换会自动改配置、停/起对应进程、重启 SnowLuma 让连接生效。切换只影响 QQ 接入链路：设置导航两种方式下都保留（只有「QQ」桥接页和「我的鱼」按运行方式显示/隐藏），额度/模型/平台/角色/记忆等页一直都在，数据不丢。")),
      configured && !forceWizard
        ? h(Card, {
          title: routeBOn ? "SnowLuma（QQ 登录层）已就绪" : "SnowLuma 已就绪",
          right: h("div", { style: { display: "inline-flex", gap: "6px" } },
            h(Btn, { kind: "qbw-btn3", onClick: () => loadSnowApi({ manual: true }), disabled: !!busy }, busy === "snow-refresh" ? "刷新中…" : "刷新"),
            h(Btn, { kind: "qbw-btn3", onClick: () => setForceWizard(true) }, "重新配置")),
        },
          h("div", { className: "qbw-meta" },
            h("span", null, accounts.length ? `● 账号 ${accounts.length} 个` : `● 账号 ${gatewayConnected ? "未知（网关已连接但明细没读到，点「刷新」）" : "未读到"}`),
            routeBOn
              ? h("span", null, `● QQ→AstrBot ${routeBQq ? "已接入" : "未接入"}`)
              : h("span", null, `● 网关 ${gatewayConnected ? "已连接" : "未连接"}`),
            h("span", null, `● 控制台 ${webuiUp ? "运行中" : "未运行"}`)),
          accounts.length
            ? h("div", { className: "qbw-meta" }, accounts.map((a) => h("span", { key: a.uin }, `${a.nickname || "QQ"}（${a.uin}）${a.online ? " · 在线" : ""}`)))
            : (gatewayConnected
              ? h("div", { className: "qbw-hint" }, "已登录（网关已连通）；账号明细没读到就点「刷新」或启用面板管账号")
              : h("div", { className: "qbw-hint" }, routeBOn ? "账号明细要读 SnowLuma 控制台，启用面板管账号后才显示（不影响收发）" : "还没有账号：点「+ 添加账号」")),
          h("div", { className: "qbw-actions" },
            h(Btn, { onClick: addAccount, disabled: !!busy }, busy === "proc" ? "处理中…" : "+ 添加账号"),
            h(Btn, { kind: "qbw-btn3", onClick: openConsole, disabled: !!busy }, "打开控制台"),
            wizard.optional.done ? null : h(Btn, {
              kind: "qbw-btn3",
              onClick: () => { setForceWizard(true); setShowPwd(true); },
              disabled: !!busy,
            }, "启用面板管账号")),
          h("div", { className: "qbw-hint" },
            wizard.optional.done
              ? "面板内管账号：已启用（加号 / 退号都在这里，不用再开 SnowLuma 网页）"
              : "面板内管账号：未启用。填一次 SnowLuma 控制台密码就能在这里加号/退号/看账号明细（密码只存本机、不回显）；不填也不影响 QQ 收发，只是加号/换号要去 SnowLuma 网页操作。"),
          loadedList.length
            ? h("div", null, loadedList.map((p) => h(SRow, {
              key: String(p.pid),
              title: `已接入 ${p.name || "QQ"}（进程 ${p.pid}）`,
              dot: "ok",
              dotText: "运行中",
              actions: h(Btn, { kind: "qbw-btn3", onClick: () => processAct("process-unload", p.pid), disabled: !!busy }, "取消注入"),
            })))
            : null,
          h("div", { className: "qbw-hint" }, "日常只需要这两件事：加账号（点一下后手机扫码）、退出账号（点「退出」）。"))
        : null,
      (configured && !forceWizard) ? null : h(Card, {
        title: "上手向导",
        right: h(Badge, { kind: currentStep ? "warn" : "ok" }, currentStep ? `已完成 ${doneCount}/${steps.length} 步，还剩 ${steps.length - doneCount} 步` : "全部完成"),
      },
        h("div", { className: "qbw-hint" },
          currentStep ? `下一步：第 ${steps.indexOf(currentStep) + 1} 步「${currentStep.label}」—— 点右边按钮就行`
            : (qqRuntime === "builtin"
              ? "基础连接已就绪。接下来按需补这几项就能正常陪聊：QQ 白名单（哪些人能找她）、人格与语气、今日额度。"
              : "基础连接已就绪。接下来按需补：QQ 白名单与接入口径（我的鱼 → 启动与连接）、人格与语气（我的鱼 → 人格与语气）。")),
        pluginMode
          ? h("div", { className: "qbw-hint" }, routeBQq
            ? "路线 B 接管中：QQ → SnowLuma → AstrBot（插件/人设）→ DSH（想和说）。这页的内置 QQ 桥保持停止才是对的。"
            : "路线 B 已切过去，但 AstrBot 还没收到 QQ（6199 没连接）：重启一次 SnowLuma 即可。")
          : null,
        steps.map((s, i) => h(SRow, {
          key: s.id,
          title: `${i + 1}. ${s.label}`,
          dot: s.done ? "ok" : "",
          dotText: s.done ? (s.doneText || "已完成") : (s === currentStep ? "现在做这一步" : "等上一步"),
          meta: s.hint ? [h("span", { key: "h" }, s.hint)] : null,
          actions: (!s.done && s === currentStep) ? h(Btn, { onClick: () => runStep(s.actionId), disabled: !!busy }, s.actionLabel) : null,
        })),
        // 可选增强：面板内加/删账号。未启用也不影响「已就绪」，只是日常要开它的网页。
        h(SRow, {
          title: "（可选）面板内加 / 删 QQ 账号（填 SnowLuma 控制台密码）",
          dot: wizard.optional.done ? "ok" : "",
          dotText: wizard.optional.done ? "已启用" : "可选",
          meta: [h("span", { key: "h" }, "填一次 SnowLuma 控制台密码，就能在这个面板里加号 / 退号 / 看账号明细，不用再开 SnowLuma 网页；不填也不影响 QQ 收发，只是加号/换号要去 SnowLuma 控制台操作。密码只存本机、不回显。")],
          actions: wizard.optional.done ? null : (showPwd
            ? h("div", { className: "qbw-actions" },
              h("input", {
                className: "qbw-input", type: "password", style: { flex: "1 1 180px" },
                placeholder: "SnowLuma 控制台密码", value: webuiPwd,
                onChange: (e) => setWebuiPwd(e.target.value),
              }),
              h(Btn, { onClick: connectWebui, disabled: !!busy || !webuiPwd }, busy === "webui-login" ? "连接中…" : "连上控制台"))
            : h(Btn, { kind: "qbw-btn3", onClick: () => setShowPwd(true) }, "填密码")),
        }),
        h("div", { className: "qbw-hint" }, "所有步骤都在这个面板里完成；只有 QQ 扫码必须你本人用手机扫（腾讯侧限制）。"),
        configured ? h("div", { className: "qbw-actions" },
          h(Btn, { kind: "qbw-btn3", onClick: () => setForceWizard(false) }, "收起向导（已经配好了）")) : null),
      h(Card, {
        title: qqRuntime === "builtin" ? "运行状态（内置版）" : "运行状态（AstrBot 版）",
        // 插件桥接模式下 QQ 不受这里控制，别再给「全部停止」让人误以为能把 QQ 停掉。
        right: pluginMode ? null : h(Btn, { kind: "qbw-btn3", onClick: stopAll, disabled: !!busy }, busy === "stop-all" ? "停止中…" : "全部停止"),
      },
        h(SRow, {
          title: pluginMode ? "QQ（AstrBot 插件桥接）" : "QQ 桥接",
          dot: pluginMode ? (routeBQq ? "ok" : "warn") : (bridge.running ? (bridge.ok ? "ok" : "warn") : ""),
          dotText: pluginMode
            ? (routeBQq ? "AstrBot 已接入" : "AstrBot 未接入")
            : (bridge.running ? (bridge.ok ? "运行中" : "异常") : "未运行"),
          actions: pluginMode
            ? [
              h(Badge, { key: "b" }, "插件桥接"),
              h(Btn, { key: "g", kind: "qbw-btn3", onClick: () => goTab?.("astrbot") }, "去我的鱼"),
            ]
            : [
              h(Badge, { key: "b" }, "内置"),
              h(Btn, { key: "s", onClick: () => act("start"), disabled: !!busy || bridge.running }, "启动"),
              h(Btn, { key: "r", kind: "qbw-btn2", onClick: () => act("restart"), disabled: !!busy }, "重启"),
              h(Btn, { key: "t", kind: "qbw-btn2", onClick: () => act("stop"), disabled: !!busy || !bridge.running }, "停止"),
            ],
          meta: pluginMode
            ? [
              h("span", { key: "rb" }, routeBQq
                ? "QQ → SnowLuma → AstrBot（插件层）→ DSH（每段对话一个会话窗口）；内置桥保持停止即可，不需要它"
                : "AstrBot 还没收到 QQ（6199 没连接）；点「去我的鱼」看重启 SnowLuma 的提示"),
            ]
            : [
              h("span", { key: "p" }, "端口 ", h("b", null, bridge.port ?? "—")),
              h("span", { key: "m" }, "模式 ", h("b", null, ({ chat: "闲聊", "closed-agent": "托管", reserved2: "仿真" })[overview?.mode?.effective] ?? "—")),
              h("span", { key: "w" }, "白名单 ", h("b", null, `群 ${overview?.mode?.allowGroups ?? 0} · 私 ${overview?.mode?.allowPrivate ?? 0}`)),
            ],
        }),
        qqRuntime === "astrbot" ? h(SRow, {
          title: "AstrBot（接入 + 插件层）",
          dot: overview?.routeB?.astrbot?.running ? "ok" : "warn",
          dotText: overview?.routeB?.astrbot?.running ? "在线" : "离线",
          actions: [
            h(Badge, { key: "b" }, "插件层"),
            h(Btn, { key: "g", kind: "qbw-btn3", onClick: () => goTab?.("astrbot") }, "去我的鱼"),
          ],
          meta: [
            h("span", { key: "p" }, "端口 ", h("b", null, overview?.routeB?.astrbot?.port ?? "—")),
            h("span", { key: "c" }, "插件 ", h("b", null, `${overview?.routeB?.astrbot?.plugins ?? 0} 个`)),
            h("span", { key: "s" }, "dsh_bridge ", h("b", null, overview?.routeB?.bridgePlugin ? "已启用" : "未启用")),
          ],
        }) : null,
        qqRuntime === "builtin" ? h(SRow, {
          title: "B站记忆",
          dot: biliStatus.available ? "ok" : (biliStatus.enabled ? "warn" : ""),
          dotText: biliStatus.available ? "已生成" : "暂无",
          actions: [
            h(Badge, { key: "b" }, "内置"),
            h(Btn, {
              key: "r",
              kind: "qbw-btn2", disabled: !!busy,
              onClick: async () => {
                setBusy("refresh-bili");
                try {
                  const r = await api("/memory", { method: "POST", body: { action: "refresh-bili" } });
                  toast(r.ok ? "✓ B站记忆已刷新" : `✗ ${r.error ?? "失败"}`);
                  await reload();
                } catch (e) { toast(`✗ ${e.message}`); } finally { setBusy(""); }
              },
            }, "刷新"),
          ],
          meta: [
            h("span", { key: "b" }, "简报 ", h("b", null, `${biliStatus.briefChars ?? 0} 字`)),
            h("span", { key: "p" }, "隐私 ", h("b", null, biliStatus.blocked ? "发现隐私内容，已拦截" : "未发现隐私内容")),
            h("span", { key: "s" }, "同步 ", h("b", null, biliStatus.enabled ? "开" : "关")),
            h("span", { key: "t" }, fmtTime(biliStatus.generatedAt)),
          ],
        }) : null,
        qqRuntime === "builtin" ? h(SRow, {
          title: "生物钟",
          dot: scheduler.running ? "ok" : "",
          dotText: scheduler.running ? "在跑" : "已停",
          actions: [
            h(Badge, { key: "b" }, "内置"),
            h(Btn, { key: "m", kind: "qbw-btn3", onClick: () => goTab?.("memory") }, "记忆 / 对齐"),
          ],
          meta: [
            h("span", { key: "a" }, "对齐 ", h("b", null, `${align.links ?? 0} 条 / 候选 ${align.candidates ?? 0}`)),
            h("span", { key: "q" }, "QQ→B站 ", h("b", null, memory.qqToBili?.enabled ? "开" : "关")),
            h("span", { key: "b" }, "B站→QQ ", h("b", null, memory.biliToQq?.enabled ? "开" : "关")),
          ],
        }) : null,
        h(SRow, {
          title: qqRuntime === "builtin" ? "SnowLuma 网关" : "SnowLuma（QQ 登录层）",
          dot: qqRuntime === "builtin"
            ? (gatewayConnected ? "ok" : (bridge.running ? "warn" : ""))
            : (snow.runtime?.onebotUp ? "ok" : "warn"),
          dotText: qqRuntime === "builtin"
            ? (gatewayConnected ? "已连接" : (bridge.running ? "未连接" : "未启动"))
            : (snow.runtime?.onebotUp ? "在线" : "未运行（会被自动拉起）"),
          actions: h(Badge, null, qqRuntime === "builtin" ? "内置" : "登录层"),
          meta: qqRuntime === "builtin"
            ? [
              h("span", { key: "st" }, "状态 ", h("b", null, gatewayConnected ? "网关已连上，消息能发出去" : "网关没连上，消息发不出去")),
              snow.webui?.url ? h("span", { key: "w" }, "控制台 ", h("b", null, `${snow.webui.url}${snow.webui.up ? "" : "（未启动）"}`)) : null,
              !gatewayConnected && (snow.diagnosis?.hint || gateway.hint)
                ? h("span", { key: "h" }, snow.diagnosis?.hint || gateway.hint) : null,
            ]
            : [
              h("span", { key: "st" }, "状态 ", h("b", null, snow.runtime?.onebotUp ? "QQ 登录层在运行，AstrBot 已收到 QQ 消息" : "没在运行：AstrBot 收不到 QQ")),
              snow.webui?.url ? h("span", { key: "w" }, "控制台 ", h("b", null, `${snow.webui.url}${snow.webui.up ? "" : "（未启动）"}`)) : null,
              !snow.runtime?.onebotUp ? h("span", { key: "h" }, "在「我的鱼 → 启动与连接」点拉起，或概览点一键开始") : null,
            ],
        }),
        qqRuntime === "builtin"
          ? h("div", { className: "qbw-hint" }, "标「内置」的是 dsh-Dfy 自带实现；要换实现或彻底关掉某个模块，去「系统 → 模块与能力」。")
          : null),

      // ── SnowLuma 账号（面板直连控制台，不用再开它的网页）──────────────────────
      // 配好后日常视图已经管账号了，这张卡只在向导/重配时出现，避免重复入口。
      (configured && !forceWizard) ? null : h(Card, {
        title: "SnowLuma 账号",
        right: h(Btn, { kind: "qbw-btn3", onClick: () => loadSnowApi({ manual: true }), disabled: !!busy }, busy === "snow-refresh" ? "刷新中…" : "刷新"),
      },
        !snowApi?.webui?.up
          ? h("div", { className: "qbw-hint" }, snowApi?.note || "SnowLuma 控制台没在运行：按上面向导第 2 步启动")
          : !snowApi?.hasPassword
            ? h("div", null,
              accounts.length
                ? h("div", { className: "qbw-meta" }, accounts.map((a) => h("span", { key: a.uin }, `● ${a.nickname || "QQ"}（${a.uin}）${a.online ? " · 在线" : ""}`)))
                : h("div", { className: "qbw-hint" }, "还没发现账号：先把 QQ 打开登录，再点「刷新」"),
              h("div", { className: "qbw-hint" }, "上面的账号来自 SnowLuma 的本地配置（不用密码也能看到）；要在这个面板里加号/退号，填一次控制台密码即可（可选）。"),
              showPwd
                ? h("div", { className: "qbw-actions" },
                  h("input", {
                    className: "qbw-input", type: "password", style: { flex: "1 1 180px" },
                    placeholder: "SnowLuma 控制台密码", value: webuiPwd,
                    onChange: (e) => setWebuiPwd(e.target.value),
                  }),
                  h(Btn, { onClick: connectWebui, disabled: !!busy || !webuiPwd }, busy === "webui-login" ? "连接中…" : "连上控制台"))
                : h("div", { className: "qbw-actions" },
                  h(Btn, { kind: "qbw-btn3", onClick: () => setShowPwd(true) }, "填密码（可选）")))
            : h("div", null,
              (snowApi.accounts ?? []).length
                ? h("div", { className: "qbw-meta" }, snowApi.accounts.map((a) => h("span", { key: a.uin }, `● ${a.nickname || "?"}（${a.uin}）`)))
                : h("div", { className: "qbw-hint" }, "还没有已登录的 QQ 账号：在下面把 QQ 进程注入后扫码登录"),
              (snowApi.processes ?? []).slice(0, 6).map((p, i) => {
                const loaded = p.loaded === true || p.injected === true || p.hooked === true;
                return h(SRow, {
                  key: String(p.pid ?? i),
                  title: `${p.name || p.title || "QQ"} · PID ${p.pid ?? "?"}`,
                  dot: loaded ? "ok" : "",
                  dotText: loaded ? "已注入" : "未注入",
                  actions: h(Btn, {
                    kind: loaded ? "qbw-btn2" : "",
                    disabled: !!busy || !p.pid,
                    onClick: () => processAct(loaded ? "process-unload" : "process-load", p.pid),
                  }, loaded ? "取消注入" : "注入到 SnowLuma"),
                });
              }),
              (snowApi.processes ?? []).length
                ? null
                : h("div", { className: "qbw-hint" }, "没发现 QQ 进程：先把 QQ 打开停在登录页，再点右上角「刷新」"),
              h("div", { className: "qbw-actions" },
                h(Btn, { kind: "qbw-btn3", onClick: forgetWebui, disabled: !!busy }, "断开控制台（清除密码）"),
                snowApi.error ? h("span", { className: "qbw-hint" }, snowApi.error) : null))),

      buckets.length
        ? h(Card, {
          title: "提醒与异常",
          right: h("div", { style: { display: "inline-flex", gap: "6px", alignItems: "center" } },
            h(Badge, { kind: (gates?.counts?.L3 ?? 0) > 0 ? "bad" : "warn" }, `未确认 ${gates?.counts?.unacked ?? 0} 条`),
            h(Btn, { kind: "qbw-btn3", onClick: () => loadGates({ manual: true }), disabled: !!busy }, busy === "gates-refresh" ? "刷新中…" : "刷新")),
        },
          buckets.slice(0, 4).map(({ key, count, ev, text }) => h(SRow, {
            key,
            title: `${({ L0: "记录", L1: "提示", L2: "警告", L3: "严重" })[ev.level] ?? ev.level}：${({ quota: "额度", privacy: "隐私", "plugin-compat": "插件兼容", bridge: "桥接" })[ev.gate] ?? ev.gate}`,
            dot: ev.level === "L3" ? "bad" : "warn",
            actions: [
              count > 1 ? h(Badge, { key: "c" }, `×${count}`) : null,
              h(Badge, { key: "a", kind: ev.ack ? "ok" : "warn" }, ev.ack ? "已确认" : "未确认"),
              h(Btn, { key: "k", kind: "qbw-btn3", onClick: () => ackGates(ev.id) }, "确认"),
            ],
            meta: text ? [text] : null,
          })),
          h("div", { className: "qbw-hint" }, "L0 静默、L1 仅记录；L2/L3 才弹窗。"),
          h("div", { className: "qbw-actions" },
            h(Btn, { kind: "qbw-btn2", onClick: () => ackGates(null), disabled: !(gates?.counts?.unacked > 0) }, "全部确认")))
        : null,

      qqStart ? null : h("div", { className: "qbw-warnbox" }, "QQ 平台在配置里是关闭状态：桥接不会自动启动。"),
      qqRuntime === "builtin" && !biliStart ? h("div", { className: "qbw-warnbox" }, "B站 平台在配置里是关闭状态：生物钟不会自动醒来。") : null);
  }

  // ── 安装与维护 ──────────────────────────────────────────────────────────
  return h("div", null,
    h("div", { className: "qbw-infobox" }, "维护 SnowLuma / AstrBot 的安装与运行。更新 dsh-Dfy 请按安装说明重新安装最新版。"),

    h(Card, {
      title: "SnowLuma 安装与运行",
      right: h(Btn, { kind: "qbw-btn3", onClick: loadSnowlumaInfo, disabled: !!busy }, "刷新"),
      note: "SnowLuma 是 QQ 的登录层（注入 QQ 进程、扫码登录）。打开 DSH 会自动拉起；这里只看安装位置、控制台和账号状态。",
    },
      snow.launcherPath ? null : h("div", { className: "qbw-hint" }, "还没识别到 SnowLuma：点「官方下载页」下载，或用「手动选择」指定已装目录（只记录位置，不移动不删除文件）。"),
      h(KV, { label: "运行状态" }, snow.runtime?.onebotUp
        ? "在线（OneBot 3000 / 3001 在听）"
        : "未运行（会被自动拉起）"),
      h(KV, { label: "已登录账号" }, (snowlumaInfo?.accounts ?? []).length
        ? (snowlumaInfo.accounts).map((a) => `${a.nickname || "QQ"}（${a.uin}）`).join("、")
        : (snowlumaInfo ? "未读到（点刷新）" : "读取中…")),
      h(KV, { label: "安装目录" }, snow.launcherPath || "未设置"),
      h(KV, { label: "控制台" }, snow.webui
        ? `${snow.webui.url}${snow.webui.up ? "（就绪）" : "（未启动）"}`
        : "未知"),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => act("open-snowluma-webui"), disabled: !!busy }, "打开 SnowLuma 控制台"),
        h(Btn, { kind: "qbw-btn2", onClick: detectSnow, disabled: !!busy }, "检测安装位置"),
        h(Btn, { kind: "qbw-btn2", onClick: () => setSnowImport(true), disabled: !!busy }, "手动选择"),
        h(Btn, { kind: "qbw-btn2", onClick: () => act("start-snowluma"), disabled: !!busy }, "只打开 SnowLuma")),
      h("div", { className: "qbw-hint" }, "扫码 / 加号 / 退号必须在 SnowLuma 自己的控制台里做（它要注入 QQ 进程，插件不能代扫码）；插件只负责自动拉起和写入账号配置。"),
      h(Section, {
        title: "高级：账号扫描与写入配置",
        note: "换号 / 排障时用：把当前登录的账号 token 扫出来写进 dsh-Dfy 配置",
        defaultOpen: false,
      },
        h("div", { className: "qbw-actions" },
          h(Btn, { kind: "qbw-btn2", onClick: scanSnow, disabled: !!busy }, busy === "snow-scan" ? "扫描中…" : "扫描当前账号"),
          h(Btn, { kind: "qbw-btn2", onClick: applySnow, disabled: !!busy }, busy === "snow-apply" ? "写入中…" : "按扫描结果写入配置"),
          h(Btn, { kind: "qbw-btn3", onClick: () => window.open(snow.downloadUrl || "https://github.com/SnowLuma/SnowLuma/releases/latest", "_blank", "noopener") }, "官方下载页")),
        snowScan ? h("div", { className: "qbw-meta" },
          snowScan?.snow ? h("span", { key: "a" }, `账号 ${snowScan.snow.nickname || "?"}（${snowScan.snow.uin || "?"}） · ${snowScan.snow.httpUrl || "—"}`) : null,
          h("span", { key: "g" }, `群 ${(snowScan.groups ?? []).length} 个`)) : null,
        h("div", { className: "qbw-hint" }, "「手动选择 / 官方下载页」只是告诉你装好的 SnowLuma 在哪或去哪下载：不下载、不安装、不移动、不删除任何文件。")),
    ),

    qqRuntime === "astrbot" ? h(Card, {
      title: "AstrBot 安装与运行",
      right: h(Btn, { kind: "qbw-btn3", onClick: loadAstrbotInfo, disabled: !!busy }, "刷新"),
      note: "AstrBot 是 QQ 的接入层 + 插件层：打开 DSH 会自动拉起；插件在「我的鱼 → 能力与插件」管理。",
    },
      h(KV, { label: "运行状态" }, astrbotInfo?.status?.running
        ? `在线（端口 ${astrbotInfo.status.port}）`
        : (astrbotInfo ? "离线（会被自动拉起）" : "读取中…")),
      h(KV, { label: "安装目录" }, astrbotInfo?.status?.cwd || "—"),
      h(KV, { label: "启动程序" }, astrbotInfo?.status?.exe || "—"),
      h(KV, { label: "已装插件" }, astrbotInfo
        ? `${astrbotInfo.plugins.filter((p) => p.enabled).length} 个启用 / ${astrbotInfo.plugins.length} 个`
        : "—"),
      h(KV, { label: "初始化" }, !astrbotInfo ? "读取中…" : astrbotInfo.status?.initialized === false ? "还没初始化（先安装/初始化 AstrBot）" : "已初始化"),
      h(KV, { label: "QQ 接入" }, astrbotInfo?.qqConnected ? "已接入（6199 反向 WS）" : "未接入"),
      astrbotInfo?.status?.lastError ? h("div", { className: "qbw-err" }, astrbotInfo.status.lastError) : null,
      astrbotInfo?.status?.hint ? h("div", { className: "qbw-hint" }, astrbotInfo.status.hint) : null,
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => astrbotAct("start"), disabled: !!busy || astrbotInfo?.status?.running }, busy === "astrbot-start" ? "拉起中…" : "拉起"),
        h(Btn, { kind: "qbw-btn2", onClick: () => astrbotAct("restart"), disabled: !!busy }, busy === "astrbot-restart" ? "重启中…" : "重启"),
        astrbotInfo?.status?.running
          ? h(Btn, { kind: "qbw-btn2", onClick: () => window.open(`http://127.0.0.1:${astrbotInfo.status.port}`, "_blank", "noopener") }, "打开控制台")
          : null,
        h(Btn, { kind: "qbw-btn3", onClick: () => goTab?.("plugins") }, "管理插件"),
        h(Btn, { kind: "qbw-btn3", onClick: () => window.open("https://astrbot.app/", "_blank", "noopener") }, "AstrBot 安装说明")),
      h("div", { className: "qbw-hint" }, "第一次用：先按官方文档装好 AstrBot（没装好无法自动拉起）；装好后 dsh-Dfy 会负责拉起、装桥接插件和后续更新。")) : null,

    qqRuntime === "astrbot" ? h(Section, {
      title: "高级：回退方案与大脑自测",
      note: "日常用不到：插件桥接之外的两条旧路线，以及不经过 QQ 的大脑自测。",
      defaultOpen: false,
    },
      h(SRow, {
        title: "模型直连（AstrBot 的模型调用直接走 DSH）",
        dot: astrbotInfo?.routeB?.on ? "ok" : "",
        dotText: astrbotInfo?.routeB?.on ? "启用中" : "未启用",
        meta: [h("span", { key: "a" }, "所有 QQ 对话共用一个会话，聊天记录不再分开；只在卸载 dsh_bridge 插件时用")],
        actions: astrbotInfo?.routeB?.on ? null : h(Btn, { onClick: () => switchFallbackRoute(true), disabled: !!busy }, busy === "route-b" ? "切换中…" : "切到 provider 路线"),
      }),
      h(SRow, {
        title: "路线 A：AstrBot 直连模型",
        dot: "",
        dotText: "未启用",
        meta: [h("span", { key: "a" }, "需要 DeepSeek key；对话完全留在 AstrBot，DSH 看不到")],
        actions: astrbotInfo?.routeB?.on ? h(Btn, { kind: "qbw-btn2", onClick: () => switchFallbackRoute(false), disabled: !!busy }, busy === "route-a" ? "切换中…" : "切到路线 A") : null,
      }),
      h("div", { className: "qbw-actions" },
        h("input", {
          className: "qbw-input", style: { flex: "1 1 240px" },
          placeholder: "测试 DSH 大脑：说一句（直接进会话，不经过 QQ）", value: fallbackText,
          onChange: (e) => setFallbackText(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") testBridgeBrain(); },
        }),
        h(Btn, { onClick: testBridgeBrain, disabled: !!busy || !fallbackText.trim() }, busy === "bridge-test" ? "等她…" : "发送")),
      fallbackReply ? h("div", { className: fallbackReply.startsWith("✗") ? "qbw-err" : "qbw-hint" }, fallbackReply) : null,
      h("div", { className: "qbw-hint" }, "provider 路线会让 QQ 回到「一个固定会话」的形态；QQ 正常在用的插件桥接不需要切它。")) : null,

    h(Section, { title: "诊断与体检", note: "体检 / 路径 / 备份与日志：排障时再展开", defaultOpen: false },
      h(DiagPage, { busy, setBusy, toast, reload, refreshStamps })),

    snowImport ? h(Modal, { title: "导入 SnowLuma 的安装位置", onClose: () => setSnowImport(false) },
      h("p", null, "这里导入的是你已经装好的 SnowLuma 的启动文件，不是安装包；不会下载、安装、移动或删除任何文件。"),
      h("ul", { style: { paddingLeft: "18px", fontSize: "12px", lineHeight: "20px" } },
        h("li", null, "SnowLuma.exe —— SnowLuma2 目录里的主程序"),
        h("li", null, "app\\launcher.bat —— 标准布局里的启动脚本"),
        h("li", null, "解压出来的 SnowLuma2 根目录")),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => pickSnow("file"), disabled: !!busy }, "选择文件…"),
        h(Btn, { kind: "qbw-btn2", onClick: () => pickSnow("dir") }, "选择目录"),
        h(Btn, { kind: "qbw-btn2", onClick: () => setSnowImport(false) }, "取消"))) : null,

    snowError ? h(Modal, { title: snowError.title, onClose: () => setSnowError(null) },
      h("p", null, snowError.message),
      snowError.hint ? h("p", { className: "qbw-hint" }, snowError.hint) : null,
      (snowError.tried ?? []).length ? h("div", { className: "qbw-out" }, snowError.tried.join("\n")) : null,
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => { setSnowError(null); pickSnow("dir"); } }, "浏览…选择目录"),
        h(Btn, { kind: "qbw-btn2", onClick: () => window.open(snow.downloadUrl || "https://github.com/SnowLuma/SnowLuma/releases/latest", "_blank", "noopener") }, "打开下载页"),
        h(Btn, { kind: "qbw-btn2", onClick: () => setSnowError(null) }, "关闭"))) : null);
}
