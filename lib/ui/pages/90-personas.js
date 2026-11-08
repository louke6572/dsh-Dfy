/* 人格设定（= 老版「角色卡」，现在由 AstrBot 承载）：
   列表 / 编辑提示词 / 新建 / 删除；切换当前人格会重启 AstrBot（约 30 秒）。 */

function AstrbotPersonasPage({ busy, setBusy, toast }) {
  const [personas, setPersonas] = useState(null);
  const [active, setActive] = useState("");
  const [selected, setSelected] = useState("");
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState("");
  const [newName, setNewName] = useState("");
  const [confirmDel, setConfirmDel] = useState("");

  const load = useCallback(async ({ keepSelection = "" } = {}) => {
    try {
      const r = await api("/astrbot/personas");
      setPersonas(r.personas ?? []);
      setActive(r.active ?? "");
      setErr(r.ok ? "" : (r.error || "读取失败"));
      const pick = keepSelection || r.active || (r.personas ?? [])[0]?.id || "";
      setSelected(pick);
      setPrompt((r.personas ?? []).find((p) => p.id === pick)?.prompt ?? "");
    } catch (e) {
      setPersonas([]);
      setErr(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

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
      title: "人格（角色卡）",
      right: h(Btn, { kind: "qbw-btn3", onClick: () => load(), disabled: !!busy }, "刷新"),
      note: "这就是 AstrBot 的人格设定：机器人按当前人格的提示词说话。改提示词即时生效；切换当前人格会重启 AstrBot（约 30 秒）。",
    },
      err ? h("div", { className: "qbw-err" }, `读取失败：${err}`) : null,
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

    selected ? h(Card, {
      title: `编辑：${selected}`,
      right: h(Badge, { kind: selected === active ? "ok" : "warn" }, selected === active ? "当前使用" : "备用"),
    },
      h("textarea", {
        className: "qbw-input", rows: 10,
        style: { width: "100%", resize: "vertical", lineHeight: "20px" },
        placeholder: "人格提示词：她的性格、说话习惯、身份背景……（等同老版角色卡正文）",
        value: prompt,
        onChange: (e) => setPrompt(e.target.value),
      }),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: save, disabled: !!busy }, busy === "persona-save" ? "保存中…" : "保存（即时生效）"),
        selected !== active ? h(Btn, { kind: "qbw-btn2", onClick: () => activate(selected), disabled: !!busy }, "保存并设为当前") : null),
      h("div", { className: "qbw-hint" }, "提示词走 AstrBot 的人格系统；对话记忆、日记等由 AstrBot 的记忆类插件负责（插件管理页可装）。")) : null);
}
