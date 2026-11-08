/* 人格与语气：她是谁、什么性格、怎么说话——全写在人格提示词里（老「角色卡」的转世，
   由 AstrBot 的人格系统承载）。改提示词即时生效；切换当前人格会重启大脑（约 30 秒）。 */

function AstrbotPersonasPage({ busy, setBusy, toast }) {
  const [personas, setPersonas] = useState(null);
  const [active, setActive] = useState("");
  const [selected, setSelected] = useState("");
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [newName, setNewName] = useState("");
  const [confirmDel, setConfirmDel] = useState("");
  const [oldRoles, setOldRoles] = useState(null);
  const [zoom, setZoom] = useState(false);

  const load = useCallback(async ({ keepSelection = "" } = {}) => {
    try {
      const r = await api("/astrbot/personas");
      setPersonas(r.personas ?? []);
      setActive(r.active ?? "");
      setErr(r.ok ? "" : (r.error || "读取失败"));
      if (r.migrated?.ok) setNote(`✓ 已把老角色卡「${r.migrated.name}」连同伴记忆迁成人格（${Math.round(r.migrated.chars / 100) / 10}k 字），并设为当前。`);
      const pick = keepSelection || r.active || (r.personas ?? [])[0]?.id || "";
      setSelected(pick);
      setPrompt((r.personas ?? []).find((p) => p.id === pick)?.prompt ?? "");
    } catch (e) {
      setPersonas([]);
      setErr(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadOldRoles = useCallback(async () => {
    try {
      const r = await api("/astrbot/old-roles");
      setOldRoles((r.roles ?? []).filter((x) => !(personas ?? []).some((p) => p.id === x.name)));
    } catch { setOldRoles([]); }
  }, [personas]);
  useEffect(() => { loadOldRoles(); }, [loadOldRoles]);

  const importOld = async (x) => {
    setBusy(`oldrole-${x.key}`);
    try {
      const r = await api("/astrbot/old-roles/import", { method: "POST", body: { key: x.key } });
      toast(r.ok ? `✓ 「${r.name}」已导入为人格` : `✗ ${r.error ?? "失败"}`);
      await load({ keepSelection: r.name });
      await loadOldRoles();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const pick = (p) => { setSelected(p.id); setPrompt(p.prompt); };

  const save = async () => {
    if (!selected) { toast("✗ 先在上方选择或新建一个人格"); return; }
    setBusy("persona-save");
    try {
      const r = await api("/astrbot/personas/save", { method: "POST", body: { id: selected, prompt } });
      toast(r.ok ? `✓ 人格「${selected}」已保存（即时生效）` : `✗ ${r.error ?? "失败"}`);
      await load({ keepSelection: selected });
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const activate = async (id) => {
    setBusy(`persona-act-${id}`);
    try {
      const r = await api("/astrbot/personas/activate", { method: "POST", body: { id } });
      toast(r.ok ? `✓ ${r.message ?? "已切换"}` : `✗ ${r.error ?? "失败"}`);
      await load({ keepSelection: id });
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const create = async () => {
    const id = newName.trim();
    if (!id) { toast("✗ 先填人格名字"); return; }
    setBusy("persona-new");
    try {
      const r = await api("/astrbot/personas/save", { method: "POST", body: { id, prompt: "" } });
      toast(r.ok ? `✓ 人格「${id}」已创建` : `✗ ${r.error ?? "失败"}`);
      if (r.ok) setNewName("");
      await load({ keepSelection: id });
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const del = async (id) => {
    setBusy(`persona-del-${id}`);
    try {
      const r = await api("/astrbot/personas/delete", { method: "POST", body: { id } });
      toast(r.ok ? `✓ 已删除「${id}」` : `✗ ${r.error ?? "失败"}`);
      setConfirmDel("");
      await load();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  return h("div", null,
    h(Card, {
      title: "她是谁，怎么说话",
      right: h(Btn, { kind: "qbw-btn3", onClick: () => load(), disabled: !!busy }, "刷新"),
      note: "一个人格 = 一份提示词：性格、背景、说话语气都写在这里。可以备好几套随时切换；改提示词即时生效。",
    },
      err ? h("div", { className: "qbw-err" }, `读取失败：${err}`) : null,
      note ? h("div", { className: "qbw-hint" }, note) : null,
      (personas ?? []).map((p) => h(SRow, {
        key: p.id,
        title: p.id,
        dot: p.id === active ? "ok" : "",
        dotText: p.id === active ? "当前使用" : "备用",
        actions: [
          p.id !== active ? h(Btn, { key: "a", kind: "qbw-btn2", onClick: () => activate(p.id), disabled: !!busy }, busy === `persona-act-${p.id}` ? "切换中…" : "设为当前") : null,
          h(Btn, { key: "e", kind: "qbw-btn3", onClick: () => pick(p), disabled: !!busy }, "编辑"),
          p.id !== active
            ? (confirmDel === p.id
              ? h(Btn, { key: "d", onClick: () => del(p.id), disabled: !!busy }, "确认删除？")
              : h(Btn, { key: "d", kind: "qbw-btn3", onClick: () => setConfirmDel(p.id) }, "删除"))
            : null,
        ],
      })),
      !(personas ?? []).length && !err ? h("div", { className: "qbw-hint" }, "还没有人格：在下方新建一个。") : null,
      h("div", { className: "qbw-actions", style: { marginTop: "8px" } },
        h("input", {
          className: "qbw-input", style: { flex: "1 1 200px" },
          placeholder: "新人格名字（如 小肥鱼）", value: newName,
          onChange: (e) => setNewName(e.target.value),
        }),
        h(Btn, { onClick: create, disabled: !!busy || !newName.trim() }, busy === "persona-new" ? "创建中…" : "新建"))),

    h(Card, {
      title: "老角色卡库",
      note: "以前养过的角色都在这里，一键变回人格（含当时的人设正文）。",
    },
      (oldRoles ?? []).length
        ? oldRoles.map((x) => h(SRow, {
          key: x.key,
          title: x.name,
          meta: [h("span", { key: "c" }, `${x.chars} 字符`)],
          actions: h(Btn, { onClick: () => importOld(x), disabled: !!busy }, busy === `oldrole-${x.key}` ? "导入中…" : "导入为人格"),
        }))
        : h("div", { className: "qbw-hint" }, "老角色卡都导入了（或没找到存档）。")),

    selected ? h(Card, {
      title: `编辑：${selected}`,
      right: h("div", { style: { display: "inline-flex", gap: "6px", alignItems: "center" } },
        h("span", { className: "qbw-hint" }, `${prompt.length} 字`),
        h(Badge, { kind: selected === active ? "ok" : "warn" }, selected === active ? "当前使用" : "备用")),
    },
      h("textarea", {
        className: "qbw-textarea card",
        style: { minHeight: "380px", fontSize: "13px", lineHeight: "22px", padding: "10px 12px" },
        placeholder: "例：\n你是小肥鱼，一条住在主人电脑里的小鲸鱼。\n性格：黏人、嘴馋、有点小骄傲。\n说话语气：软软的、爱撒娇，句尾常带「~」。",
        value: prompt,
        onChange: (e) => setPrompt(e.target.value),
      }),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: save, disabled: !!busy }, busy === "persona-save" ? "保存中…" : "保存（即时生效）"),
        h(Btn, { kind: "qbw-btn2", onClick: () => setZoom(true), disabled: !!busy }, "放大编辑"),
        selected !== active ? h(Btn, { kind: "qbw-btn2", onClick: () => activate(selected), disabled: !!busy }, "保存并设为当前") : null),
      h("div", { className: "qbw-hint" }, "长期记忆、日记由记忆类插件负责（能力与插件页可装）；这里只管「她是谁、怎么说话」。")) : null,

    zoom ? h(Modal, { title: `编辑人格：${selected}（${prompt.length} 字）`, onClose: () => setZoom(false) },
      h("textarea", {
        className: "qbw-textarea",
        style: { width: "100%", height: "58vh", fontSize: "13.5px", lineHeight: "23px", padding: "12px" },
        value: prompt,
        onChange: (e) => setPrompt(e.target.value),
      }),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: save, disabled: !!busy }, busy === "persona-save" ? "保存中…" : "保存（即时生效）"),
        h(Btn, { kind: "qbw-btn2", onClick: () => setZoom(false) }, "收起"))) : null);
}
