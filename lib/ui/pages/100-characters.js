/* 人设：她是谁（人格分层）+ 预设同步 + 角色包 + 自我学习。
 *
 * 2026-11 架构（用户定稿）：人格的**稳定层**（身份底座 + 核心 + 语气）烘进 DSH Agent
 * 预设的 system prompt，不再每轮以「输入消息」塞进对话；易变层（日常/场景/近况/记忆）
 * 仍按场景注入。所以这一页按「层」拆成独立卡片：每层单独编辑、单独保存，
 * 保存后自动同步到 Agent 预设（重启 DSH 生效），状态在「同步到 Agent 预设」卡里可见。
 */

const PERSONA_LAYER_META = {
  core: {
    title: "核心人格",
    hint: "她是谁、从哪来、在意什么、什么脾气。必填；会进 Agent 预设（系统提示词）。",
    placeholder: "# 角色卡：小肥鱼\n\n你是小肥鱼，一条住在主人电脑里的小鲸鱼。\n性格：黏人、嘴馋、有点小骄傲。\n说话语气：软软的、爱撒娇，句尾常带「~」。",
    inPreset: true,
  },
  tone: {
    title: "行为规则",
    hint: "默认状态、什么时候不按默认走、对话结构、梗与边界。留空就不写这一层；会进 Agent 预设。",
    placeholder: "例：\n- 话短。一句话能说完就一句。\n- 有态度，不同意直接说，但不说教。\n- 他明确说难过时放下玩笑，先听。",
    inPreset: true,
  },
  examples: {
    title: "对话语料",
    hint: "真实对话示例（few-shot）：被夸、被怼、他难过、求助、闲聊等。她的说话习惯主要靠这一层学，单独放，不撑大核心。",
    placeholder: "他：你还挺厉害的\n你：那不然呢\n\n他：搞砸了\n你：搞砸啥了\n你：说清楚点",
    inPreset: true,
  },
  daily: {
    title: "日常",
    hint: "最近在做什么、生活状态。留空就不注入；这一层不走预设，按场景注入对话。",
    placeholder: "例：最近在补番、在学做菜、今天被主人坑了。",
    inPreset: false,
  },
};

function CharactersPage({ overview, busy, setBusy, toast, reload, goTab }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", personaText: "", memoryText: "", fullText: "" });
  // 人格层保存 → 预设同步卡要立刻反映「已改，等重启」。
  const [presetNonce, setPresetNonce] = useState(0);

  const load = useCallback(async () => {
    try { setData(await api("/characters")); setErr(""); }
    catch (e) { setErr(`读取角色失败：${e.message}`); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (action, extra = {}, okText = "✓ 已完成") => {
    setBusy(`character-${action}`);
    try {
      const r = await api("/characters", { method: "POST", body: { action, ...extra } });
      if (r.ok === false) throw new Error(r.error ?? "失败");
      toast(okText);
      await load();
      // 切换/新建/恢复都会换掉整个人格，预设状态跟着变。
      if (action === "load" || action === "restore" || action === "create") {
        setPresetNonce((n) => n + 1);
        await reload?.();
      }
      return r;
    } catch (e) { toast(`✗ ${e.message}`); return null; }
    finally { setBusy(""); }
  };

  const create = async (loadIt) => {
    if (!form.name.trim()) { toast("✗ 先填角色名"); return; }
    let memoryCard;
    if (form.memoryText.trim()) {
      try { memoryCard = JSON.parse(form.memoryText); }
      catch { toast("✗ 记忆库不是合法 JSON"); return; }
    }
    const r = await act("create", {
      name: form.name.trim(),
      personaText: form.personaText,
      memoryCard,
      fullRecords: form.fullText,
      load: loadIt,
    }, loadIt ? "✓ 角色已创建并加载" : "✓ 角色已创建");
    if (r) { setForm({ name: "", personaText: "", memoryText: "", fullText: "" }); setShowCreate(false); }
  };

  const current = data?.current ?? null;
  const characters = data?.characters ?? [];
  const snapshots = data?.snapshots ?? [];
  const fileTo = (key, accept) => h("input", {
    type: "file", accept,
    onChange: async (e) => {
      const input = e.target;
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      setForm((f) => ({ ...f, [key]: text }));
      // 清空选择：同一个文件第二次选时不会触发 change（恢复默认/重选同一份文件的场景）。
      input.value = "";
    },
  });

  return h("div", null,
    h(Card, {
      title: "当前角色",
      right: current ? h(Badge, { kind: "ok" }, current.name) : h(Badge, { kind: "warn" }, "还没有角色"),
    },
      h("p", null, "一个角色 = 一套人格卡 + 一份记忆库 + B站账本；切换角色前会先备份当前状态。"),
      h(KV, { label: "角色" }, current ? `${current.name}` : "（未加载）"),
      h(KV, { label: "备份" }, `${snapshots.length} 个`),
      h("div", { className: "qbw-actions" },
        current ? h(Btn, { kind: "qbw-btn2", onClick: () => goTab?.("memory") }, "打开记忆库") : null,
        h(Btn, { kind: "qbw-btn3", onClick: () => setShowCreate((v) => !v), disabled: !!busy }, showCreate ? "收起新建" : "新建角色"))),

    err ? h("div", { className: "qbw-err" }, err) : null,

    // key = 当前角色：切换角色后强制重建，否则人格编辑区还显示上一个角色的层。
    h(PersonaLayersEditor, { key: current?.id ?? "none", busy, setBusy, toast, onSaved: () => setPresetNonce((n) => n + 1) }),
    h(PresetSyncCard, { nonce: presetNonce, toast }),

    showCreate ? h(Card, { title: "新建角色", note: "可以只填名字；也可以把已有的人格卡 / 记忆库一起导入" },
      h(Row, { label: "角色名" },
        h("input", { className: "qbw-input", value: form.name, placeholder: "例如 小咪", onChange: (e) => setForm((f) => ({ ...f, name: e.target.value })) })),
      h("div", { className: "qbw-group" }, "人格卡（Markdown）"),
      fileTo("personaText", ".md,.txt,text/markdown,text/plain"),
      h("textarea", { className: "qbw-textarea", value: form.personaText, placeholder: "# 角色卡：名字\n\n你是谁、说话方式…", onChange: (e) => setForm((f) => ({ ...f, personaText: e.target.value })) }),
      h("div", { className: "qbw-group" }, "记忆库 JSON（可选，导入已有记忆）"),
      fileTo("memoryText", ".json,application/json"),
      h("textarea", { className: "qbw-textarea", value: form.memoryText, placeholder: "{\"version\":1,\"records\":[]}", onChange: (e) => setForm((f) => ({ ...f, memoryText: e.target.value })) }),
      h("div", { className: "qbw-group" }, "聊天记录 JSONL（可选，只备份）"),
      fileTo("fullText", ".jsonl,.json,text/plain"),
      h("textarea", { className: "qbw-textarea", value: form.fullText, placeholder: "{\"id\":\"...\"}", onChange: (e) => setForm((f) => ({ ...f, fullText: e.target.value })) }),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => create(true), disabled: !!busy }, "创建并加载"),
        h(Btn, { kind: "qbw-btn2", onClick: () => create(false), disabled: !!busy }, "只创建"))) : null,

    h(Card, {
      title: `角色包（${characters.length}）`,
      note: "加载别的角色会自动保存当前角色；删除会移进备份目录，可手动恢复。",
    },
      characters.length
        ? characters.map((item) => h("div", { key: item.id, className: "qbw-item" },
          h("div", null,
            h("div", { className: "qbw-label" }, item.name,
              item.current ? h(Badge, { kind: "ok" }, "当前") : null,
              h(Badge, null, `${item.snapshots ?? 0} 个备份`)),
            h("div", { className: "qbw-hint" }, `人格 ${item.personaChars ?? 0} 字 · 记忆库 ${fmtBytes(item.fullMemoryBytes)} · 更新 ${fmtTime(item.updatedAt)}`)),
          h("div", { style: { display: "flex", gap: "6px", flex: "0 0 auto" } },
            item.current ? null : h(Btn, { onClick: () => act("load", { id: item.id }, `✓ 已加载「${item.name}」`), disabled: !!busy }, "加载"),
            item.current ? null : h(Btn, {
              kind: "qbw-btn2", disabled: !!busy,
              onClick: async () => {
                if (!confirm(`删除角色「${item.name}」？整个目录会移进 backups/deleted-character-*，可手动恢复。`)) return;
                await act("delete", { id: item.id }, "✓ 已移入备份");
              },
            }, "删除"))))
        : h("div", { className: "qbw-hint" }, "还没有角色；点上方「新建角色」。")),

    h(LearningCard, { busy, setBusy, toast }),

    h(AdvancedSettings, { note: "备份 / 恢复：低频操作，展开再用" },
      h(Section, { title: `备份（${snapshots.length}）`, note: "自动备份 12 份 · 手动/切换前不覆盖", collapsible: false },
        h("div", { className: "qbw-actions", style: { marginTop: 0, borderTop: 0, paddingTop: 0 } },
          current ? h(Btn, { kind: "qbw-btn2", onClick: () => act("snapshot", { id: current.id, label: "手动" }, "✓ 已备份"), disabled: !!busy }, "立即备份") : null,
          current ? h(Btn, { kind: "qbw-btn2", onClick: () => act("auto-snapshot", { id: current.id }, "✓ 自动备份已更新"), disabled: !!busy }, "更新自动备份") : null),
        snapshots.length
          ? snapshots.map((item) => h("div", { key: item.slot, className: "qbw-item" },
            h("div", null,
              h("div", { className: "qbw-label" }, item.slot,
                item.slot === "before-switch" ? h(Badge, { kind: "warn" }, "切换前") : null),
              h("div", { className: "qbw-hint" }, `${fmtTime(item.createdAt)} · ${item.reason || ""} · 记忆 ${fmtBytes(item.memoryBytes)}`)),
            current ? h(Btn, {
              kind: "qbw-btn2", disabled: !!busy,
              onClick: async () => {
                if (!confirm(`把「${current.name}」恢复到 ${item.slot}？会先备份当前状态。`)) return;
                await act("restore", { id: current.id, slot: item.slot }, "✓ 已恢复");
              },
            }, "恢复") : null))
          : h("div", { className: "qbw-hint" }, "还没有备份；切换角色或点「立即备份」。"))));
}

/* ── 人格分层编辑：每层一张独立卡片，保存即同步 Agent 预设 ───────────────── */
function PersonaLayersEditor({ busy, setBusy, toast, onSaved }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({ core: "", tone: "", examples: "", daily: "", scenes: {} });
  const [saved, setSaved] = useState({ core: "", tone: "", examples: "", daily: "", scenes: {} });
  const [scene, setScene] = useState("qq-group");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api("/persona");
      const layers = r.layers ?? {};
      const next = {
        core: layers.core?.text ?? r.text ?? "",
        tone: layers.tone?.text ?? "",
        examples: layers.examples?.text ?? "",
        daily: layers.daily?.text ?? "",
        scenes: Object.fromEntries(Object.entries(layers.scenes ?? {}).map(([id, layer]) => [id, { text: layer?.text ?? "", path: layer?.path ?? "" }])),
      };
      setData(r);
      setDraft(next);
      setSaved(next);
      const firstScene = Object.keys(next.scenes)[0];
      if (firstScene) setScene(firstScene);
      setErr("");
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const layerDirty = (key) => !data ? false : String(draft[key] ?? "") !== String(saved[key] ?? "");
  const sceneDirty = () => !data ? false : String(draft.scenes?.[scene]?.text ?? "") !== String(saved.scenes?.[scene]?.text ?? "");

  const saveLayer = async (key) => {
    if (!layerDirty(key)) return;
    setBusy(`persona-save-${key}`);
    try {
      const r = await api("/persona", { method: "POST", body: { layer: key, text: draft[key] } });
      if (r?.ok === false) throw new Error(r.error ?? "保存失败");
      setSaved((prev) => ({ ...prev, [key]: draft[key] }));
      const meta = PERSONA_LAYER_META[key];
      toast(r?.presetSync?.changed
        ? `✓ ${meta?.title ?? key}已保存，已同步到 Agent 预设（重启 DSH 生效）`
        : `✓ ${meta?.title ?? key}已保存`);
      onSaved?.();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const saveScene = async () => {
    if (!sceneDirty()) return;
    setBusy("persona-save-scene");
    try {
      const r = await api("/persona", { method: "POST", body: { layer: "scene", scene, text: draft.scenes?.[scene]?.text ?? "" } });
      if (r?.ok === false) throw new Error(r.error ?? "保存失败");
      setSaved((prev) => ({ ...prev, scenes: { ...prev.scenes, [scene]: { ...(prev.scenes?.[scene] ?? {}), text: draft.scenes?.[scene]?.text ?? "" } } }));
      toast(`✓ ${data?.sceneLabels?.[scene] ?? scene} 场景语气已保存`);
      onSaved?.();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  const resetLayer = (key) => setDraft((prev) => ({ ...prev, [key]: saved[key] }));
  const resetScene = () => setDraft((prev) => ({ ...prev, scenes: { ...prev.scenes, [scene]: { ...(prev.scenes?.[scene] ?? {}), text: saved.scenes?.[scene]?.text ?? "" } } }));

  const renderLayer = (key) => {
    const meta = PERSONA_LAYER_META[key];
    const dirty = layerDirty(key);
    const chars = String(draft[key] ?? "").length;
    const minHeight = key === "core" ? "260px" : key === "examples" ? "320px" : key === "tone" ? "200px" : "140px";
    return h(Card, {
      key,
      title: meta.title,
      right: h("div", { style: { display: "inline-flex", gap: "6px", alignItems: "center" } },
        dirty ? h(Badge, { kind: "warn" }, "未保存") : null,
        meta.inPreset ? h(Badge, { kind: "ok" }, "写入预设") : null,
        h("span", { className: "qbw-hint" }, `${chars} 字`)),
      note: meta.hint,
    },
      h("textarea", {
        className: "qbw-textarea", value: draft[key] ?? "", placeholder: meta.placeholder,
        style: { minHeight },
        onChange: (e) => setDraft((prev) => ({ ...prev, [key]: e.target.value })),
      }),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => saveLayer(key), disabled: !!busy || !dirty }, dirty ? "保存并同步" : "已保存"),
        dirty ? h(Btn, { kind: "qbw-btn3", onClick: () => resetLayer(key), disabled: !!busy }, "撤销") : null));
  };

  const sceneIds = Object.keys(data?.layers?.scenes ?? draft.scenes ?? {});
  const sceneChars = String(draft.scenes?.[scene]?.text ?? "").length;

  return h("div", null,
    h("div", { className: "qbw-group", style: { marginTop: 2 } }, "人格分层",
      h("small", null, "核心与语气进 Agent 预设（系统提示词）；日常与场景仍按场景注入对话")),
    err ? h("div", { className: "qbw-err" }, `读取人格失败：${err}`) : null,
    !data && !err ? h("div", { className: "qbw-hint" }, "读取人格卡…") : null,
    data ? renderLayer("core") : null,
    data ? renderLayer("tone") : null,
    data ? renderLayer("examples") : null,
    data ? renderLayer("daily") : null,
    data
      ? h(Card, {
        title: "场景语气",
        right: h("div", { style: { display: "inline-flex", gap: "6px", alignItems: "center" } },
          sceneDirty() ? h(Badge, { kind: "warn" }, "未保存") : null,
          h("span", { className: "qbw-hint" }, `${sceneChars} 字`)),
        note: "按平台微调语气（QQ 群聊 / QQ 私聊 / B站 / 桌宠）；留空就不写这一层。",
      },
        sceneIds.length
          ? h("select", { className: "qbw-select", value: scene, onChange: (e) => setScene(e.target.value) },
            sceneIds.map((id) => h("option", { key: id, value: id }, data?.sceneLabels?.[id] ?? id)))
          : h("div", { className: "qbw-hint" }, "当前角色还没有场景层文件。"),
        sceneIds.length
          ? h("textarea", {
            className: "qbw-textarea", style: { marginTop: "8px" },
            value: draft.scenes?.[scene]?.text ?? "",
            placeholder: "例：群里更收着一点，私聊可以撒娇；B站评论区不主动找人说话。",
            onChange: (e) => setDraft((prev) => ({
              ...prev,
              scenes: { ...prev.scenes, [scene]: { ...(prev.scenes?.[scene] ?? {}), text: e.target.value } },
            })),
          })
          : null,
        sceneIds.length
          ? h("div", { className: "qbw-actions" },
            h(Btn, { onClick: saveScene, disabled: !!busy || !sceneDirty() }, sceneDirty() ? "保存场景语气" : "已保存"),
            sceneDirty() ? h(Btn, { kind: "qbw-btn3", onClick: resetScene, disabled: !!busy }, "撤销") : null)
          : null)
      : null);
}

/* ── 同步到 Agent 预设：让人一眼看到人格进没进 system prompt、要不要重启 ──── */
function PresetSyncCard({ nonce, toast }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async ({ manual = false } = {}) => {
    if (manual) setBusy("refresh");
    try {
      const r = await api("/persona");
      setSt(r?.presetSync ?? null);
      setErr(r?.presetSync?.error ? `读取失败：${r.presetSync.error}` : "");
      if (manual) toast?.("✓ 已刷新预设状态");
    } catch (e) { setErr(e.message); if (manual) toast?.(`✗ ${e.message}`); }
    finally { if (manual) setBusy(""); }
  }, [toast]);
  useEffect(() => { load(); }, [load, nonce]);

  const badge = !st?.ok ? h(Badge, { kind: "warn" }, "未生成")
    : st.restartRequired ? h(Badge, { kind: "warn" }, "等重启")
      : h(Badge, { kind: "ok" }, "已同步");

  return h(Card, {
    title: "同步到 Agent 预设",
    right: h("div", { style: { display: "inline-flex", gap: "6px", alignItems: "center" } },
      badge,
      h(Btn, { kind: "qbw-btn3", onClick: () => load({ manual: true }), disabled: busy === "refresh" }, busy === "refresh" ? "刷新中…" : "刷新")),
    note: "DSH 会在会话启动时把这段人格读进 system prompt——对话记录里不再出现它，模型每轮直接读系统提示。",
  },
    err ? h("div", { className: "qbw-err" }, err) : null,
    st
      ? h("div", null,
        h(KV, { label: "人格字数" }, `${st.chars ?? 0} 字`),
        h(KV, { label: "更新时间" }, st.snapshotMtime ? fmtTime(st.snapshotMtime) : "还没有快照"),
        h(KV, { label: "写入到的预设" }, (st.presets ?? []).map((p) => `${p.name}${p.exists ? "" : "（未生成）"}`).join(" · ") || "—"),
        st.restartRequired
          ? h("div", { className: "qbw-warnbox", style: { marginTop: "8px" } },
            "人格改过了，等重启 DSH 生效：新会话读新的 system prompt；正在跑的会话仍用旧人格。")
          : null,
        st.ok
          ? h("div", { className: "qbw-hint", style: { marginTop: "6px" } },
            "改完人格点各层的「保存并同步」；这里显示「已同步」就说明预设文件已是最新，重启后生效。")
          : h("div", { className: "qbw-hint", style: { marginTop: "6px" } }, "还没有可用的人格卡：先在「核心人格」里写点内容并保存。"))
      : h("div", { className: "qbw-hint" }, "读取预设状态…"));
}

/* 自我学习：B站 / 抖音 的观看记录 → 经历 + 近况（后端 learning-loop）。 */
function LearningCard({ busy, setBusy, toast }) {
  const [st, setSt] = useState(null);
  const load = useCallback(async () => {
    try { setSt(await api("/learning/status")); } catch (e) { /* 后端还没升级 */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (action, okText, body = {}) => {
    setBusy(`learning-${action}`);
    try {
      const r = await api(`/learning/${action}`, { method: "POST", body });
      if (r.ok === false) throw new Error(r.error ?? r.reason ?? "失败");
      toast(okText);
      await load();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };
  const enabled = st?.enabled !== false;
  return h(Card, {
    title: "自我学习",
    right: st?.running ? h(Badge, { kind: "warn" }, "学习中") : null,
    note: "她刷过的 B站 / 抖音会定期变成「经历 + 近况」，按场景注入对话；核心人格卡不会被改。",
  },
    h(Row, { label: "自动学习", hint: "关掉后只能手动「立即学习」" },
      h("label", { className: "qbw-check" },
        h("input", {
          type: "checkbox", className: "qbw-switch", checked: enabled,
          onChange: (e) => act("config", e.target.checked ? "✓ 已开启自动学习" : "✓ 已暂停自动学习", { enabled: e.target.checked }),
        }),
        h("span", null, enabled ? "已开启" : "已关闭"))),
    h(KV, { label: "上次学习" }, st?.lastRunAt ? fmtTime(st.lastRunAt) : "还没学过"),
    h(KV, { label: "已沉淀" }, st ? `${st.stats?.items ?? 0} 条经历 · ${st.stats?.runs ?? 0} 次` : "—"),
    st?.interests?.length ? h(KV, { label: "最近兴趣" }, st.interests.join("、")) : null,
    st?.brief ? h("div", { className: "qbw-hint", style: { marginTop: "6px", whiteSpace: "pre-wrap" } }, st.brief) : null,
    st?.persona ? h("div", { className: "qbw-hint", style: { marginTop: "6px", whiteSpace: "pre-wrap" } }, `自动近况：${st.persona}`) : null,
    st?.lastError ? h("div", { className: "qbw-err", style: { marginTop: "6px" } }, st.lastError) : null,
    h("div", { className: "qbw-actions" },
      h(Btn, { onClick: () => act("run", "✓ 学习完成", { force: true }), disabled: !!busy }, busy === "learning-run" ? "学习中…" : "立即学习"),
      h(Btn, { kind: "qbw-btn2", onClick: () => act("rollback", "✓ 已回滚自动近况"), disabled: !!busy }, "撤销自动近况"),
      h(Btn, { kind: "qbw-btn3", onClick: load }, "刷新")),
    h("div", { className: "qbw-hint", style: { marginTop: "6px" } }, "学习内容只来自三平台「看过的记录」；不读聊天、不编造没看到的细节。"));
}
