/* 启动与连接：打开 DSH 她就自动上线，这里只回答一个问题——她连好了没有。
   链路：QQ → SnowLuma（登录层，不换）→ 大脑（AstrBot，管她想什么怎么说）→ 回消息。
   老的内置 QQ 桥在这里一键停用，避免双回复。 */

function AstrbotPage({ busy, setBusy, toast }) {
  const [st, setSt] = useState(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const [qqModule, setQqModule] = useState(null);
  const [qqConn, setQqConn] = useState(null);
  const [slClient, setSlClient] = useState(null);
  const [routeB, setRouteB] = useState({ on: false, apiBase: "" });
  const [testText, setTestText] = useState("");
  const [testReply, setTestReply] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api("/platform-hub");
      setSt(r.astrbot ?? null);
    } catch { setSt(null); }
    try {
      const m = await api("/modules");
      setQqModule((m.modules ?? []).find((x) => x.id === "qq") ?? null);
    } catch { setQqModule(null); }
    try {
      const p = await api("/astrbot/panel");
      setQqConn(p.qqConnected === true);
      setRouteB(p.routeB ?? { on: false, apiBase: "" });
      setSlClient(p.snowlumaClient ?? null);
    } catch { setQqConn(null); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // 大脑重启要 30 秒：自动刷几次状态，用户不用手动点
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (action) => {
    setBusy(`astrbot-${action}`);
    try {
      const r = await api("/astrbot/action", { method: "POST", body: { action } });
      toast(r.ok ? `✓ 已${action === "start" ? "拉起" : "重启"}（稍候自动刷新状态）` : `✗ ${r.error ?? "失败"}`);
      await load();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const saveKey = async () => {
    setBusy("astrbot-key");
    setMsg("");
    try {
      const r = await api("/astrbot/config", { method: "POST", body: { apiKey: key.trim() } });
      if (r.ok) {
        setKey("");
        setMsg(r.auto ? "✓ 已自动读取 DSH 侧的 DEEPSEEK_API_KEY 并写入，重启后生效。" : "✓ 已写入并重启：约 30 秒后她就能开口了。");
        toast("✓ 模型已配置");
      } else setMsg(`✗ ${r.error ?? "失败"}`);
      await load();
    } catch (e) { setMsg(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const disableBuiltinBridge = async () => {
    setBusy("qq-module-off");
    try {
      await api("/modules", { method: "POST", body: { id: "qq", enabled: false } });
      toast("✓ 旧桥已停 + 平台启动开关已关：QQ 消息不会再被它抢走（想回退：启动与连接 → QQ 页把启动开关打开保存）");
      await load();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const sendTest = async () => {
    if (!testText.trim()) { toast("✗ 先输入一句话"); return; }
    setBusy("astrbot-test");
    setTestReply("…她在想");
    try {
      // 插件桥接模式：走 DSH 会话（和 QQ 同一条大脑路径）；
      // provider 模式：走 AstrBot webchat（经 dfy-fish provider）。
      const path = routeB.bridgePlugin ? "/astrbot/qq-bridge-test" : "/astrbot/chat-test";
      const r = await api(path, { method: "POST", body: { text: testText.trim() } });
      setTestReply(r.ok ? r.reply : `✗ ${r.error ?? "失败"}`);
      if (r.ok) toast("✓ 她回话了");
    } catch (e) { setTestReply(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const switchRoute = async (on) => {
    setBusy(on ? "route-b" : "route-a");
    try {
      const r = await api("/astrbot/route-b", { method: "POST", body: { on } });
      toast(r.ok ? `✓ ${r.message}` : `✗ ${r.error ?? "失败"}`);
      await load();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const running = st?.running === true;
  const qqOn = qqModule?.enabled !== false;
  const qqState = qqConn === true ? "ok" : (running ? "warn" : "");

  return h("div", null,
    h(Card, {
      title: "一键上线",
      right: h(Badge, { kind: running ? "ok" : (st?.enabled === false ? "" : "warn") }, running ? "在线" : (st?.enabled === false ? "已停用" : "离线")),
      note: "打开 DSH 她就自动上线，不用手动启动；这里只在大脑没跟上时才需要点按钮。",
    },
      h(KV, { label: "大脑状态" }, running ? "在线（想什么说什么都归它管）" : "离线"),
      h(KV, { label: "数据目录" }, st?.cwd ?? "—"),
      st?.hint ? h("div", { className: "qbw-hint" }, st.hint) : null,
      st?.lastError ? h("div", { className: "qbw-err" }, st.lastError) : null,
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => act("start"), disabled: !!busy || running }, busy === "astrbot-start" ? "拉起中…" : "拉起"),
        h(Btn, { kind: "qbw-btn2", onClick: () => act("restart"), disabled: !!busy }, busy === "astrbot-restart" ? "重启中…" : "重启"),
        running ? h(Btn, { kind: "qbw-btn3", onClick: () => window.open(`http://127.0.0.1:${st.port}`, "_blank", "noopener") }, "高级设置") : null),
      h("div", { className: "qbw-hint" }, "重启约需 30 秒（冷启动），页面每 10 秒自动刷新；「高级设置」是大脑自己的控制台，平时不用进。")),

    routeB.bridgePlugin
      ? null
      : h("div", { className: "qbw-hint" }, "dsh_bridge 桥接插件还没生效：DSH 会自动把它装进 AstrBot；装好后重启一次 AstrBot（约 30 秒）就会切到「插件桥接」——届时本页自动换成新架构视图，QQ 对话会按会话出现在 DSH 侧栏。"),

    routeB.bridgePlugin
      ? h(Card, {
        title: "当前架构：插件桥接",
        right: h(Badge, { kind: "ok" }, "推荐"),
        note: "QQ → SnowLuma（登录层）→ AstrBot（接入 + 插件）→ dsh_bridge 插件 → DSH（每段对话一个会话窗口）→ 回复回 QQ。",
      },
        h(SRow, {
          title: "AstrBot（接入 + 插件）",
          dot: running ? "ok" : (st?.enabled === false ? "" : "warn"),
          dotText: running ? "在线" : "离线",
          meta: [h("span", { key: "a" }, "插件链照常跑（表情包 / 延时 / 收尾）；默认 LLM 已跳过，不会双回")],
        }),
        h(SRow, {
          title: "QQ 接入（SnowLuma → AstrBot）",
          dot: qqConn === true ? "ok" : "warn",
          dotText: qqConn === true ? "已连上" : "未连接",
          meta: [h("span", { key: "a" }, "6199 反向 WS；断了会 5 秒自动重连，SnowLuma 不在时会自动拉起")],
        }),
        h(SRow, {
          title: "DSH 会话",
          dot: qqConn === true ? "ok" : "",
          dotText: "每段 QQ 对话一个窗口",
          meta: [h("span", { key: "a" }, "侧栏「agents」工作区可见：可切模型、看思考、看上下文；重启后同名会话复用，记忆不断")],
        }))
      : null,

    routeB.bridgePlugin ? null : h(Card, {
      title: "她的脑子（模型）",
      note: "一次配置永久生效。key 在 platform.deepseek.com → API Keys 创建（DSH 的账号余额体系给不了它，这是唯一要手动填的东西）。",
    },
      h("div", { className: "qbw-actions" },
        h("input", {
          className: "qbw-input", type: "password", style: { flex: "1 1 240px" },
          placeholder: "sk-...（环境变量里配过 DEEPSEEK_API_KEY 可留空）", value: key,
          onChange: (e) => setKey(e.target.value),
        }),
        h(Btn, { onClick: saveKey, disabled: !!busy }, busy === "astrbot-key" ? "写入中…" : "保存并重启")),
      msg ? h("div", { className: msg.startsWith("✓") ? "qbw-hint" : "qbw-err" }, msg) : null,
      h("div", { className: "qbw-hint" }, "key 只写进本机大脑配置（不回显、不进日志）。")),

    routeB.bridgePlugin ? null : h(Card, {
        title: "对话走哪条线",
        right: h(Badge, { kind: routeB.on ? "ok" : "warn" }, routeB.on ? "路线 B：大脑在 DSH" : "路线 A：AstrBot 直连模型"),
        note: "路线 B = 她在 DSH 会话里想和说：思考过程可见、模型上下文在 DSH 调、走 DSH 账号余额；AstrBot 管接入和插件。切换会重启大脑（约 30 秒）。",
      },
        h(SRow, {
          title: "路线 B：大脑在 DSH（推荐）",
          dot: routeB.on ? "ok" : "",
          dotText: routeB.on ? "使用中" : "未启用",
          meta: [h("span", { key: "a" }, "对话回 DSH 会话；DSH 里能看她的思考过程，模型上下文在 DSH 调")],
          actions: routeB.on ? null : h(Btn, { onClick: () => switchRoute(true), disabled: !!busy }, busy === "route-b" ? "切换中…" : "切到路线 B"),
        }),
        h(SRow, {
          title: "路线 A：AstrBot 直连模型",
          dot: routeB.on ? "" : "ok",
          dotText: routeB.on ? "备用" : "使用中",
          meta: [h("span", { key: "a" }, "需要 DeepSeek key；对话只存在于 AstrBot 里，DSH 看不到")],
          actions: routeB.on ? h(Btn, { kind: "qbw-btn2", onClick: () => switchRoute(false), disabled: !!busy }, busy === "route-a" ? "切换中…" : "切回路线 A") : null,
        }),
        routeB.stale
          ? h("div", { className: "qbw-err", style: { marginTop: "8px" } },
            `指向漂移：现在写的是 ${routeB.apiBase}，当前 DSH 在 ${routeB.expectedApiBase || "未知"}。DSH 换端口后必须重新指向，否则她会一直不回话。`,
            h(Btn, { onClick: () => switchRoute(true), disabled: !!busy }, busy === "route-b" ? "修复中…" : "修复指向"))
          : null,
        h("div", { className: "qbw-hint" }, "两条线共用下面的「跟她试一句话」：切完在这里说一句就知道走没走通。")),

    routeB.bridgePlugin ? null : h(Card, {
      title: "跟她试一句话",
      note: "配置完在这里直接验证：她能不能回、语气对不对。不用打开任何别的窗口。",
    },
      h("div", { className: "qbw-actions" },
        h("input", {
          className: "qbw-input", style: { flex: "1 1 240px" },
          placeholder: "说点什么，比如「在吗」", value: testText,
          onChange: (e) => setTestText(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") sendTest(); },
        }),
        h(Btn, { onClick: sendTest, disabled: !!busy || !testText.trim() }, busy === "astrbot-test" ? "等她…" : "发送")),
      testReply ? h("div", { className: testReply.startsWith("✗") ? "qbw-err" : "qbw-hint" }, testReply) : null),

    h(Card, { title: "连接状态" },
      h(SRow, {
        title: "QQ（SnowLuma）→ 大脑",
        dot: qqState,
        dotText: qqConn === true ? "已连上" : (running ? "大脑在线，QQ 还没连入" : "等大脑上线"),
        meta: [h("span", { key: "a" }, routeB.bridgePlugin
          ? (qqConn === true
            ? "插件桥接模式：QQ → AstrBot（插件层）→ DSH 按会话建窗口；侧栏里能看每段对话"
            : "插件桥接模式已装好，但 QQ 还没接进 AstrBot（6199 没连接）：重启一次 SnowLuma")
          : (qqConn === true
            ? "QQ 已接入大脑：消息先过 AstrBot 的插件层，再交给 DSH 想"
            : (slClient?.changed
              ? "接入配置刚自动写好：重启一次 SnowLuma 就通（断线 5 秒重连）"
              : "QQ 登录层没换：SnowLuma 自动连入大脑，断线 5 秒重连；首次接入重启一次 SnowLuma 即可")))],
      })));
}
