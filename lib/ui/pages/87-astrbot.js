/* AstrBot 网关页（减法版）：dsh-Dfy 负责拉起（打开 DSH 自动就绪）。
   机器人配置走 AstrBot 的配置文件；插件管理拆到独立页；QQ 连接仍走 SnowLuma。
   老的角色/记忆/额度/语音页已随架构切换退场——那些是老桥时代的系统，与 AstrBot 无关。 */

function AstrbotPage({ busy, setBusy, toast }) {
  const [st, setSt] = useState(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const [qqModule, setQqModule] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api("/platform-hub");
      setSt(r.astrbot ?? null);
    } catch { setSt(null); }
    try {
      const m = await api("/modules");
      setQqModule((m.modules ?? []).find((x) => x.id === "qq") ?? null);
    } catch { setQqModule(null); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // 重启要 30 秒上下：自动刷几次状态，用户不用手动点
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
        setMsg(r.auto ? "✓ 已自动读取 DSH 侧的 DEEPSEEK_API_KEY 并写入，重启后生效。" : "✓ 已写入 AstrBot 并触发重启：约 30 秒后生效，之后 QQ 与插件对话都走它。");
        toast("✓ DeepSeek 已配置");
      } else setMsg(`✗ ${r.error ?? "失败"}`);
      await load();
    } catch (e) { setMsg(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const disableBuiltinBridge = async () => {
    setBusy("qq-module-off");
    try {
      await api("/modules", { method: "POST", body: { id: "qq", enabled: false } });
      toast("✓ 内置 QQ 桥已停用：QQ 从此由 AstrBot 接管（可随时在配置里重新启用）");
      await load();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const running = st?.running === true;
  const qqOn = qqModule?.enabled !== false;

  return h("div", null,
    h(Card, {
      title: "AstrBot 网关",
      right: h(Badge, { kind: running ? "ok" : (st?.enabled === false ? "" : "warn") }, running ? "运行中" : (st?.enabled === false ? "已停用" : "未运行")),
      note: "dsh-Dfy 负责拉起：打开 DSH 自动就绪，不需要手动启动。",
    },
      h(KV, { label: "WebUI" }, running ? `http://127.0.0.1:${st.port}` : "未运行"),
      h(KV, { label: "数据目录" }, st?.cwd ?? "—"),
      st?.hint ? h("div", { className: "qbw-hint" }, st.hint) : null,
      st?.lastError ? h("div", { className: "qbw-err" }, st.lastError) : null,
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => act("start"), disabled: !!busy || running }, busy === "astrbot-start" ? "拉起中…" : "拉起"),
        h(Btn, { kind: "qbw-btn2", onClick: () => act("restart"), disabled: !!busy }, busy === "astrbot-restart" ? "重启中…" : "重启"),
        running ? h(Btn, { kind: "qbw-btn3", onClick: () => window.open(`http://127.0.0.1:${st.port}`, "_blank", "noopener") }, "打开完整设置") : null),
      h("div", { className: "qbw-hint" }, "重启约需 30 秒（Python 冷启动），页面每 10 秒自动刷新状态。")),

    h(Card, {
      title: "机器人配置（一次性）",
      note: "key 在 platform.deepseek.com → API Keys 创建。DSH 的账号余额体系不能直接给 AstrBot 用（它不对外提供接口），所以这一步只填一次，之后不再管。",
    },
      h("div", { className: "qbw-actions" },
        h("input", {
          className: "qbw-input", type: "password", style: { flex: "1 1 240px" },
          placeholder: "sk-...（DeepSeek API Key；环境变量里配过可留空）", value: key,
          onChange: (e) => setKey(e.target.value),
        }),
        h(Btn, { onClick: saveKey, disabled: !!busy }, busy === "astrbot-key" ? "写入中…" : "保存并重启")),
      msg ? h("div", { className: msg.startsWith("✓") ? "qbw-hint" : "qbw-err" }, msg) : null,
      h("div", { className: "qbw-hint" }, "留空点保存 = 自动读取环境变量 DEEPSEEK_API_KEY；key 只写进本机 AstrBot 配置（不回显、不进日志）。")),

    h(Card, { title: "QQ 连接（SnowLuma 直连）" },
      h(SRow, {
        title: "SnowLuma → AstrBot",
        dot: running ? "ok" : "",
        dotText: running ? "就绪（等 SnowLuma 连入）" : "等 AstrBot 运行",
        meta: [h("span", { key: "a" }, "已配置 SnowLuma wsClients 连出 ws://127.0.0.1:6199/ws（断线 5 秒自动重连）")],
      }),
      h("div", { className: "qbw-hint" }, "SnowLuma 重启一次后自动连入，AstrBot 这边零操作；连接层不用换，稳定性跟现在一样。"),
      h(SRow, {
        title: "内置 QQ 桥（旧）",
        dot: qqOn ? "warn" : "",
        dotText: qqOn ? "还在跑" : "已停用",
        actions: qqOn
          ? h(Btn, { kind: "qbw-btn2", onClick: disableBuiltinBridge, disabled: !!busy }, busy === "qq-module-off" ? "停用中…" : "停用（AstrBot 就绪后）")
          : null,
        meta: [h("span", { key: "m" }, qqOn ? "同一个 QQ 号两边都开会双回复：确认 AstrBot 能回消息后，在这里一键停用。" : "QQ 消息已完全由 AstrBot 接管；想回退就重新启用它。")],
      })));
}
