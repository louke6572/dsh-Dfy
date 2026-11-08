/* AstrBot 网关页（减法版）：dsh-Dfy 负责拉起（打开 DSH 自动就绪）。
   机器人配置（key）、插件启停/卸载/安装走 AstrBot 的 dashboard API；
   市场搜索、人设等完整配置仍在 AstrBot WebUI（本页只留日常操作）。 */

function AstrbotPage({ busy, setBusy, toast }) {
  const [st, setSt] = useState(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const [plugins, setPlugins] = useState(null);
  const [pluginsErr, setPluginsErr] = useState("");
  const [installUrl, setInstallUrl] = useState("");
  const [confirmUnload, setConfirmUnload] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api("/platform-hub");
      setSt(r.astrbot ?? null);
    } catch { setSt(null); }
  }, []);
  const loadPlugins = useCallback(async ({ manual = false } = {}) => {
    if (manual) setBusy("astrbot-plugins");
    try {
      const r = await api("/astrbot/panel");
      setPlugins(r.plugins ?? []);
      setPluginsErr(r.ok ? "" : (r.error || "读取失败"));
    } catch (e) {
      setPlugins([]);
      setPluginsErr(e.message);
    } finally {
      if (manual) setBusy("");
    }
  }, []);
  useEffect(() => { load(); loadPlugins(); }, [load, loadPlugins]);
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

  const togglePlugin = async (p) => {
    setBusy(`ptoggle-${p.name}`);
    try {
      const r = await api("/astrbot/plugins/enabled", { method: "POST", body: { name: p.name, enabled: !p.enabled } });
      toast(r.ok ? `✓ 已${p.enabled ? "停用" : "启用"} ${p.name}` : `✗ ${r.error ?? "失败"}`);
      await loadPlugins();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const unloadPlugin = async (p) => {
    setBusy(`punload-${p.name}`);
    try {
      const r = await api("/astrbot/plugins/uninstall", { method: "POST", body: { name: p.name } });
      toast(r.ok ? `✓ 已卸载 ${p.name}` : `✗ ${r.error ?? "失败"}`);
      setConfirmUnload("");
      await loadPlugins();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const installPlugin = async () => {
    if (!installUrl.trim()) { toast("✗ 先填插件仓库（github 用户/仓库 或完整 URL）"); return; }
    setBusy("astrbot-install");
    try {
      const r = await api("/astrbot/plugins/install", { method: "POST", body: { url: installUrl.trim() } });
      toast(r.ok ? `✓ 插件已安装：${installUrl.trim()}` : `✗ ${r.error ?? "失败"}`);
      if (r.ok) setInstallUrl("");
      await loadPlugins();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const running = st?.running === true;

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

    h(Card, {
      title: "插件",
      right: h(Btn, { kind: "qbw-btn3", onClick: () => loadPlugins({ manual: true }), disabled: !!busy }, busy === "astrbot-plugins" ? "刷新中…" : "刷新"),
      note: "日常启停/卸载/按仓库安装在这里做减法；市场搜索、人设、高级配置在「打开完整设置」里。",
    },
      pluginsErr
        ? h("div", { className: "qbw-err" }, `读取插件失败：${pluginsErr}`)
        : (plugins ?? []).length
          ? plugins.map((p) => h(SRow, {
            key: p.name,
            title: `${p.name}${p.version ? ` · v${p.version}` : ""}`,
            dot: p.enabled ? "ok" : "",
            dotText: p.enabled ? "启用" : "停用",
            meta: [
              p.desc ? h("span", { key: "d" }, p.desc) : null,
              p.author ? h("span", { key: "a" }, `作者 ${p.author}`) : null,
            ].filter(Boolean),
            actions: [
              h(Btn, { key: "t", kind: "qbw-btn2", onClick: () => togglePlugin(p), disabled: !!busy }, busy === `ptoggle-${p.name}` ? "切换中…" : (p.enabled ? "停用" : "启用")),
              confirmUnload === p.name
                ? h(Btn, { key: "u", onClick: () => unloadPlugin(p), disabled: !!busy }, "确认卸载？")
                : h(Btn, { key: "u", kind: "qbw-btn3", onClick: () => setConfirmUnload(p.name) }, "卸载"),
            ],
          }))
          : h("div", { className: "qbw-hint" }, "还没装任何插件：在下面填仓库地址安装，或去「打开完整设置」逛插件市场。"),
      h("div", { className: "qbw-actions", style: { marginTop: "10px" } },
        h("input", {
          className: "qbw-input", style: { flex: "1 1 240px" },
          placeholder: "github 用户/仓库（如 AstrBotDevs/astrbot-plugin-xxx）", value: installUrl,
          onChange: (e) => setInstallUrl(e.target.value),
        }),
        h(Btn, { onClick: installPlugin, disabled: !!busy || !installUrl.trim() }, busy === "astrbot-install" ? "安装中…" : "安装"))),

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
