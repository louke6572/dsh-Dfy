/* 插件管理（独立页）：AstrBot 生态的插件启停/卸载/安装。
   只做日常减法操作；市场搜索、人设等完整配置在 AstrBot WebUI（AstrBot 页 → 打开完整设置）。 */

function AstrbotPluginsPage({ busy, setBusy, toast }) {
  const [plugins, setPlugins] = useState(null);
  const [pluginsErr, setPluginsErr] = useState("");
  const [installUrl, setInstallUrl] = useState("");
  const [confirmUnload, setConfirmUnload] = useState("");

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
  useEffect(() => { loadPlugins(); }, [loadPlugins]);

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

  return h("div", null,
    h(Card, {
      title: "已装插件",
      right: h(Btn, { kind: "qbw-btn3", onClick: () => loadPlugins({ manual: true }), disabled: !!busy }, busy === "astrbot-plugins" ? "刷新中…" : "刷新"),
      note: "启停 / 卸载 / 按仓库安装。这些插件跑在 AstrBot 里，服务 QQ 对话与扩展功能；市场搜索和插件高级配置在「AstrBot → 打开完整设置」。",
    },
      pluginsErr
        ? h("div", { className: "qbw-err" }, `读取失败：${pluginsErr}`)
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
          : h("div", { className: "qbw-hint" }, "还没装任何插件：在下面填仓库地址安装，或去 AstrBot 的插件市场逛（AstrBot → 打开完整设置 → 插件）。"),
      h("div", { className: "qbw-actions", style: { marginTop: "10px" } },
        h("input", {
          className: "qbw-input", style: { flex: "1 1 240px" },
          placeholder: "github 用户/仓库（如 AstrBotDevs/astrbot-plugin-xxx）", value: installUrl,
          onChange: (e) => setInstallUrl(e.target.value),
        }),
        h(Btn, { onClick: installPlugin, disabled: !!busy || !installUrl.trim() }, busy === "astrbot-install" ? "安装中…" : "安装"))),
    h("div", { className: "qbw-hint" }, "插件装好后即插即用：AstrBot 重启由 dsh-Dfy 守护自动完成，不用手动重启。"));
}
