/* AstrBot 网关页：dsh-Dfy 负责拉起（打开 DSH 自动就绪），配置一次后不再管。
   老平台页（B站/抖音/QQ）已从导航退场——平台能力归 AstrBot 生态，QQ 连接仍走 SnowLuma。 */

function AstrbotPage({ busy, setBusy, toast }) {
  const [st, setSt] = useState(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api("/platform-hub");
      setSt(r.astrbot ?? null);
    } catch { setSt(null); }
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
    if (!key.trim()) { toast("✗ 先粘贴 DeepSeek API Key"); return; }
    setBusy("astrbot-key");
    setMsg("");
    try {
      const r = await api("/astrbot/config", { method: "POST", body: { apiKey: key.trim() } });
      if (r.ok) { setKey(""); setMsg("✓ 已写入 AstrBot 并触发重启：约 30 秒后生效，之后 QQ 与插件对话都走它。"); toast("✓ DeepSeek key 已配置"); }
      else setMsg(`✗ ${r.error ?? "失败"}`);
      await load();
    } catch (e) { setMsg(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const running = st?.running === true;

  return h("div", null,
    h(Card, {
      title: "AstrBot 网关",
      right: h(Badge, { kind: running ? "ok" : (st?.enabled === false ? "" : "warn") }, running ? "运行中" : (st?.enabled === false ? "已停用" : "未运行")),
      note: "dsh-Dfy 负责拉起：打开 DSH 自动就绪，不需要手动启动。它的插件、人设、记忆配置都在它自己的 WebUI 里改。",
    },
      h(KV, { label: "WebUI" }, running ? `http://127.0.0.1:${st.port}` : "未运行"),
      h(KV, { label: "数据目录" }, st?.cwd ?? "—"),
      st?.hint ? h("div", { className: "qbw-hint" }, st.hint) : null,
      st?.lastError ? h("div", { className: "qbw-err" }, st.lastError) : null,
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => act("start"), disabled: !!busy || running }, busy === "astrbot-start" ? "拉起中…" : "拉起"),
        h(Btn, { kind: "qbw-btn2", onClick: () => act("restart"), disabled: !!busy }, busy === "astrbot-restart" ? "重启中…" : "重启"),
        running ? h(Btn, { kind: "qbw-btn3", onClick: () => window.open(`http://127.0.0.1:${st.port}`, "_blank", "noopener") }, "打开 WebUI") : null),
      h("div", { className: "qbw-hint" }, "重启约需 30 秒（Python 冷启动），页面每 10 秒自动刷新状态。")),

    h(Card, {
      title: "首次配置（一次性）",
      note: "把 DeepSeek API key 写进 AstrBot：之后 QQ 对话和插件功能都走它。key 在 platform.deepseek.com → API Keys 创建。",
    },
      h("div", { className: "qbw-actions" },
        h("input", {
          className: "qbw-input", type: "password", style: { flex: "1 1 240px" },
          placeholder: "sk-...（DeepSeek API Key）", value: key,
          onChange: (e) => setKey(e.target.value),
        }),
        h(Btn, { onClick: saveKey, disabled: !!busy || !key.trim() }, busy === "astrbot-key" ? "写入中…" : "保存并重启")),
      msg ? h("div", { className: msg.startsWith("✓") ? "qbw-hint" : "qbw-err" }, msg) : null,
      h("div", { className: "qbw-hint" }, "key 只写进本机 AstrBot 的配置文件（不回显、不进日志）；保存后自动重启 AstrBot。")),

    h(Card, { title: "QQ 连接（SnowLuma 直连）" },
      h(SRow, {
        title: "SnowLuma → AstrBot",
        dot: running ? "ok" : "",
        dotText: running ? "就绪（等 SnowLuma 连入）" : "等 AstrBot 运行",
        meta: [h("span", { key: "a" }, "已配置 SnowLuma wsClients 连出 ws://127.0.0.1:6199/ws（断线 5 秒自动重连）")],
      }),
      h("div", { className: "qbw-hint" }, "SnowLuma 重启一次后自动连入，AstrBot 这边零操作；连接层不用换，稳定性跟现在一样。"),
      h("div", { className: "qbw-hint" }, "确认 AstrBot 能正常回消息后，再到 系统 → 模块中心 停用内置 QQ 桥——同一个 QQ 号两边同时在线会双回复。")));
}
