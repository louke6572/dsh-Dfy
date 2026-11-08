/* 启动与连接：打开 DSH 她就自动上线，这里只回答一个问题——她连好了没有。
   链路：QQ → SnowLuma（登录层，不换）→ 大脑（AstrBot，管她想什么怎么说）→ 回消息。
   老的内置 QQ 桥在这里一键停用，避免双回复。 */

function AstrbotPage({ busy, setBusy, toast }) {
  const [st, setSt] = useState(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const [qqModule, setQqModule] = useState(null);
  const [qqConn, setQqConn] = useState(null);
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
      toast("✓ 旧桥已停用：QQ 从此由新大脑接管（想回退随时重新启用）");
      await load();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const sendTest = async () => {
    if (!testText.trim()) { toast("✗ 先输入一句话"); return; }
    setBusy("astrbot-test");
    setTestReply("…她在想");
    try {
      const r = await api("/astrbot/chat-test", { method: "POST", body: { text: testText.trim() } });
      setTestReply(r.ok ? r.reply : `✗ ${r.error ?? "失败"}`);
      if (r.ok) toast("✓ 她回话了");
    } catch (e) { setTestReply(`✗ ${e.message}`); }
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

    h(Card, {
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

    h(Card, { title: "跟她试一句话", note: "配置完在这里直接验证：她能不能回、语气对不对。不用打开任何别的窗口。" },
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
        meta: [h("span", { key: "a" }, "QQ 登录层没换：SnowLuma 自动连入大脑，断线 5 秒重连；首次接入重启一次 SnowLuma 即可")],
      }),
      h(SRow, {
        title: "内置 QQ 桥（旧）",
        dot: qqOn ? "warn" : "",
        dotText: qqOn ? "还在跑" : "已停用",
        actions: qqOn
          ? h(Btn, { kind: "qbw-btn2", onClick: disableBuiltinBridge, disabled: !!busy }, busy === "qq-module-off" ? "停用中…" : "停用")
          : null,
        meta: [h("span", { key: "m" }, qqOn ? "新旧两个大脑同时在线会双回复：上面的「跟她试一句话」通了之后，在这里停用旧的。" : "QQ 消息已完全由新大脑接管；想回退随时重新启用。")],
      })));
}
