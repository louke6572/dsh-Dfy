/* 记忆同步：记忆卡容量 + QQ ⇄ B站 双向脱敏同步。 */
const CLARITY_LABEL = { vivid: '鲜明', clear: '清楚', fuzzy: '模糊', trace: '仅印象' };
const CLARITY_COLOR = { vivid: '#34d399', clear: '#60a5fa', fuzzy: '#fbbf24', trace: '#94a3b8' };

function MemoryPage({ qq, setQq, unified, rawUnified, setUnified, overview, busy, setBusy, toast, reload, goTab }) {
  const [data, setData] = useState(null);
  const [card, setCard] = useState(null);
  const [err, setErr] = useState("");
  const [docOpen, setDocOpen] = useState(false);

  // toast 每次渲染都是新函数：用 ref 固定，避免 load/loadCard 的依赖把它带进 useEffect 反复触发。
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const load = useCallback(async () => {
    try { setData(await api("/memory")); setErr(""); }
    catch (e) { setErr(e.message); }
  }, []);
  const loadCard = useCallback(async ({ manual = false } = {}) => {
    if (manual) setBusy("card-refresh");
    try {
      setCard(await api("/memory-card"));
      if (manual) toastRef.current?.("✓ 记忆卡已刷新");
    } catch (e) {
      if (manual) toastRef.current?.(`✗ 刷新失败：${e.message}`);
    } finally {
      if (manual) setBusy("");
    }
  }, []);
  useEffect(() => { load(); loadCard(); }, [load, loadCard]);

  const biliToQq = qq?.biliBridge?.memory?.enabled !== false && qq?.biliBridge?.enabled !== false;
  const toggle = typeof rawUnified?.__biliToQqToggle === "boolean" ? rawUnified.__biliToQqToggle : biliToQq;
  const qqToBili = unified?.memory?.qqToBili ?? {};
  const setQqToBili = (key, value) => setUnified(["memory", "qqToBili", key], value);
  const status = data?.status ?? overview?.memory ?? {};

  const run = async (key, fn, okText) => {
    setBusy(key);
    try {
      const r = await fn();
      toast(r?.ok === false ? `✗ ${r.error ?? "失败"}` : okText(r));
      await load();
      await loadCard();
      await reload();
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };

  // 一键整理要调模型，可能跑几十秒：按钮状态之外再给一行常驻进度/结果，
  // 免得用户以为点了没反应（2026-11 反馈）。
  const [organizeMsg, setOrganizeMsg] = useState("");
  const [preview, setPreview] = useState(null);
  const previewOrganize = async () => {
    setBusy("organize-preview");
    setPreview(null);
    try {
      const r = await api("/memory-card", { method: "POST", body: { action: "organize-preview" } });
      if (r?.ok === false) throw new Error(r.error ?? "预览失败");
      setPreview(r.preview ?? null);
    } catch (e) { toast(`✗ ${e.message}`); }
    finally { setBusy(""); }
  };
  const setOrganizeCfg = (patch, okText) => run("organize-config", () => api("/memory-card", { method: "POST", body: { action: "organize-config", ...patch } }), () => okText);
  const diaryYesterday = async () => {
    if (!confirm("把昨天的记录写成一篇日记，并把那天的原始流水归档？")) return;
    setBusy("diary");
    setOrganizeMsg("正在写昨日日记…（模型处理中，通常 30~60 秒）");
    try {
      const r = await api("/memory-card", { method: "POST", body: { action: "diary" } });
      if (r?.ok === false) throw new Error(r.error ?? "写日记失败");
      const d = r.diary ?? {};
      const text = `✓ 日记已写入（${d.date ?? "昨天"}）：归档 ${d.removed ?? 0} 条原始记录`;
      setOrganizeMsg(text);
      toast(text);
      await load();
      await loadCard();
      await reload();
    } catch (e) {
      setOrganizeMsg(`✗ ${e.message}`);
      toast(`✗ ${e.message}`);
    } finally { setBusy(""); }
  };
  const organizeAll = async () => {
    if (!confirm("一键整理会用一次模型调用：合并重复、删掉纯寒暄；置顶、初次相遇和标记「不整理」的记录都不会动。继续？")) return;
    const before = card?.status?.counts?.total ?? card?.counts?.total ?? "";
    setBusy("organize");
    setOrganizeMsg(`正在整理${before ? ` ${before} 条` : ""}记忆…（选得多会自动分批调用模型，可能需要几分钟，请勿重复点）`);
    try {
      const r = await api("/memory-card", { method: "POST", body: { action: "organize" } });
      if (r?.ok === false) throw new Error(r.error ?? "整理失败");
      const info = r.organized ?? {};
      const text = `✓ 已整理：合并 ${info.merged ?? 0} 组 · 删除 ${info.dropped ?? 0} 条（输入 ${info.before ?? "?"} 条）${info.note ? ` · ${info.note}` : ""}`;
      setOrganizeMsg(text);
      toast(text);
      await load();
      await loadCard();
      await reload();
    } catch (e) {
      setOrganizeMsg(`✗ ${e.message}`);
      toast(`✗ ${e.message}`);
    } finally { setBusy(""); }
  };

  const st = card?.status ?? card ?? {};
  const percent = Number(st.percent ?? overview?.memoryCard?.percent ?? 0);

  const counts = st.counts ?? {};
  const total = Number(counts.total) || 0;
  const organizable = Math.max(0, total - (Number(counts.noOrganize) || 0) - (Number(counts.anchors) || 0) - (Number(counts.firstMet) || 0));
  const nextPlan = (() => {
    const organize = card?.organize ?? {};
    if (!organize.enabled) return "未开启自动整理";
    if (!organize.lastRunAt) return "等下一次整点检查";
    const nextAt = organize.lastRunAt + (organize.intervalHours ?? 20) * 3600_000;
    return `${fmtTime(nextAt)} 之后${Number(organize.hour) >= 0 ? `（${String(organize.hour).padStart(2, "0")}:00 左右）` : ""}`;
  })();

  return h("div", null,
    h(Card, {
      title: "记忆",
      right: h(Badge, { kind: percent >= 80 ? "warn" : "ok" }, `${percent}%`),
      note: "长期记忆由 dsh-evolve 插件管理（重启 DSH 后生效）：只记事实、按需召回、自动注入。这里保留旧的记忆卡作为档案与日记。",
    },
      h("div", { className: "qbw-meter " + (percent >= 90 ? "bad" : percent >= 80 ? "warn" : "") },
        h("i", { style: { width: `${Math.min(100, percent)}%` } })),
      h("div", { style: { display: "flex", gap: "24px", margin: "10px 0 6px" } },
        [["总记忆", total], ["可整理", organizable], ["不整理", counts.noOrganize ?? 0], ["锚点", counts.anchors ?? 0]].map(([label, value]) =>
          h("div", { key: label, style: { textAlign: "center", minWidth: "54px" } },
            h("div", { style: { fontSize: "22px", fontWeight: 700, lineHeight: "26px" } }, String(value ?? 0)),
            h("div", { style: { fontSize: "11px", opacity: 0.65 } }, label)))),
      (() => {
        const segs = ["vivid", "clear", "fuzzy", "trace"].filter((key) => Number(counts[key]) > 0);
        return segs.length
          ? h("div", { style: { display: "flex", height: "10px", borderRadius: "6px", overflow: "hidden", margin: "4px 0 8px" } },
            segs.map((key) => h("div", { key, title: `${CLARITY_LABEL[key]} ${counts[key]}`, style: { width: `${(Number(counts[key]) / Math.max(1, total)) * 100}%`, background: CLARITY_COLOR[key] } })))
          : null;
      })(),
      h("div", { className: "qbw-meta" },
        h("span", { key: "v" }, `● 鲜明 ${counts.vivid ?? 0}`),
        h("span", { key: "c" }, `● 清楚 ${counts.clear ?? 0}`),
        h("span", { key: "f" }, `● 模糊 ${counts.fuzzy ?? 0}`),
        h("span", { key: "t" }, `● 仅印象 ${counts.trace ?? 0}`),
        h("span", { key: "o" }, `● 不整理 ${counts.noOrganize ?? 0}`)),
      card?.enabled === false ? h("div", { className: "qbw-warnbox" }, "记忆写入已关闭：她不会记新东西。") : null,
      h(Row, { label: "记忆方式", hint: "默认只记重要的事：明确让她记的、偏好/约定/计划/近况；闲聊不进记忆" },
        h("select", {
          className: "qbw-select",
          value: qq?.memory?.recordMode === "chatlog" ? "chatlog" : "facts",
          onChange: (e) => setQq(["memory", "recordMode"], e.target.value),
        },
          h("option", { key: "facts", value: "facts" }, "只记重要的事（推荐）"),
          h("option", { key: "chatlog", value: "chatlog" }, "记录聊天流水（旧）"))),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => setDocOpen(true), disabled: !!busy }, "打开记忆管理"),
        h(Btn, { kind: "qbw-btn3", onClick: () => loadCard({ manual: true }), disabled: !!busy }, busy === "card-refresh" ? "刷新中…" : "刷新")),
      err ? h("div", { className: "qbw-err" }, err) : null),

    h(Card, {
      title: "整理",
      right: h(Badge, { kind: card?.organize?.enabled ? "ok" : "" }, card?.organize?.enabled ? "自动" : "手动"),
      note: "整理会合并重复、删掉纯寒暄；置顶 / 初次相遇 / 不整理 永远不动。",
    },
      h(Row, { label: "自动整理" },
        h("label", { className: "qbw-check" },
          h("input", {
            type: "checkbox", className: "qbw-switch", checked: card?.organize?.enabled === true,
            onChange: (e) => run("organize-config", () => api("/memory-card", { method: "POST", body: { action: "organize-config", enabled: e.target.checked } }),
              () => e.target.checked ? "✓ 已开启自动整理" : "✓ 已关闭自动整理"),
          }),
          h("span", null, card?.organize?.enabled ? "开" : "关"))),
      h(Row, { label: "自动写日记" },
        h("label", { className: "qbw-check" },
          h("input", {
            type: "checkbox", className: "qbw-switch", checked: card?.organize?.diary === true,
            onChange: (e) => run("organize-diary-config", () => api("/memory-card", { method: "POST", body: { action: "organize-config", diary: e.target.checked } }),
              () => e.target.checked ? "✓ 已开启自动写日记" : "✓ 已关闭自动写日记"),
          }),
          h("span", null, card?.organize?.diary ? "开" : "关"))),
      h(KV, { label: "下次" }, nextPlan),
      h(Section, { title: "计划细节", note: "间隔 / 时间点 / 记录数阈值", defaultOpen: false },
        h(Row, { label: "间隔（小时）" },
          h("input", { className: "qbw-input", type: "number", min: 6, max: 168, value: card?.organize?.intervalHours ?? 20,
            onChange: (e) => setOrganizeCfg({ intervalHours: Number(e.target.value) || 20 }, "✓ 间隔已保存") })),
        h(Row, { label: "时间点" },
          h("select", { className: "qbw-select", value: String(card?.organize?.hour ?? -1),
            onChange: (e) => setOrganizeCfg({ hour: Number(e.target.value) }, "✓ 时间已保存") },
            h("option", { key: "-1", value: "-1" }, "任意时间"),
            Array.from({ length: 24 }, (_, hour) => h("option", { key: String(hour), value: String(hour) }, `${String(hour).padStart(2, "0")}:00`)))),
        h(Row, { label: "至少多少条" },
          h("input", { className: "qbw-input", type: "number", min: 10, max: 300, value: card?.organize?.minRecords ?? 40,
            onChange: (e) => setOrganizeCfg({ minRecords: Number(e.target.value) || 40 }, "✓ 阈值已保存") }))),
      h(KV, { label: "上次整理" }, card?.organize?.lastRunAt
        ? `${fmtTime(card.organize.lastRunAt)} · 合并 ${card.organize.lastMerged ?? 0} 组 · 删除 ${card.organize.lastDropped ?? 0} 条`
        : "还没整理过"),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: previewOrganize, disabled: !!busy }, busy === "organize-preview" ? "分析中…" : "预览整理"),
        h(Btn, { kind: "qbw-btn2", onClick: organizeAll, disabled: !!busy }, busy === "organize" ? "整理中…" : "立即整理"),
        h(Btn, { kind: "qbw-btn2", onClick: diaryYesterday, disabled: !!busy }, busy === "diary" ? "写日记中…" : "写昨日日记"),
        h(Btn, {
          kind: "qbw-btn3", disabled: !!busy,
          onClick: () => run("compact", () => api("/memory-card", { method: "POST", body: { action: "compact", targetRatio: 0.8 } }), (r) => `✓ 已压缩（降级 ${r.steps ?? 0} 档）`),
        }, "压缩到 80%"),
        h(Btn, {
          kind: "qbw-btn3 danger", disabled: !!busy,
          onClick: async () => {
            if (!confirm("清空聊天流水？会删掉所有非锚点、非初次相遇、非日记、非手动、非合并的记录（也就是旧的聊天记录）。原始内容仍保留在全量档案。")) return;
            await run("purge-chatlog", () => api("/memory-card", { method: "POST", body: { action: "purge-chatlog" } }),
              (r) => `✓ 已清掉 ${r.removed ?? 0} 条聊天流水`);
          },
        }, busy === "purge-chatlog" ? "清理中…" : "清空聊天流水")),
      preview
        ? h("div", { className: "qbw-hint" },
          `会动：重复 ${preview.duplicates} 组 / 寒暄 ${preview.noisy} 条 / 淡忘 ${preview.faded} 条；`
          + `不动：锚点/初次相遇 ${preview.protectedCount} 条、不整理 ${preview.noOrganizeCount ?? 0} 条；`
          + `inbox 新增 ${preview.inboxPending} 条、容量 ${preview.capacity}%。`)
        : h("div", { className: "qbw-hint" }, "先点「预览整理」看会动哪些（本地规则，不调模型），再决定要不要立即整理。"),
      organizeMsg ? h("div", { className: organizeMsg.startsWith("✗") ? "qbw-err" : "qbw-hint", style: { marginTop: "6px", fontWeight: 600 } }, organizeMsg) : null),

    h(Section, { title: "跨平台同步（B站 ⇄ QQ）", note: "只搬公开、脱敏后的近况；私聊永不跨平台", defaultOpen: false },
      h(Row, { label: "B站 → QQ" },
        h("input", { className: "qbw-switch", type: "checkbox", checked: toggle, onChange: (e) => setUnified(["__biliToQqToggle"], e.target.checked) })),
      h(KV, { label: "B站简报" }, `${status.biliToQq?.briefChars ?? 0} 字 · ${fmtTime(status.biliToQq?.generatedAt)}`),
      h(Row, { label: "QQ → B站" },
        h("input", { className: "qbw-switch", type: "checkbox", checked: qqToBili.enabled === true, onChange: (e) => setQqToBili("enabled", e.target.checked) })),
      h(Row, { label: "回看（小时）" },
        h("input", { className: "qbw-input", type: "number", min: 1, max: 336, value: qqToBili.windowHours ?? 72,
          onChange: (e) => setQqToBili("windowHours", Number(e.target.value) || 72) })),
      h("div", { className: "qbw-actions" },
        h(Btn, { kind: "qbw-btn2", disabled: !!busy,
          onClick: () => run("refresh-bili", () => api("/memory", { method: "POST", body: { action: "refresh-bili" } }), () => "✓ 已刷新 B站简报") }, "刷新 B站简报"),
        h(Btn, {
          disabled: !!busy,
          onClick: () => run("sync", () => api("/memory", { method: "POST", body: { action: "sync" } }),
            (r) => `✓ 已同步（${r.stats?.kept ?? 0} 条）`),
        }, busy === "sync" ? "同步中…" : "立即同步"),
        h(Btn, {
          kind: "qbw-btn2 danger", disabled: !!busy,
          onClick: async () => {
            if (!confirm("清空 QQ→B站 记忆和公开 feed？对齐表与 B站→QQ 简报不受影响。")) return;
            await run("purge", () => api("/memory", { method: "POST", body: { action: "purge" } }), () => "✓ 已清空");
          },
        }, "清空 QQ→B站"))),

    h(Section, { title: "身份对齐（QQ ⇄ B站）", note: "同一个人在两边是谁；称呼优先于群名片 / B站昵称", defaultOpen: false },
      h(AlignPage, { busy, setBusy, toast, reload })),

    docOpen ? h(MemoryDocModal, {
      onClose: () => setDocOpen(false),
      toast,
      onChanged: async () => { await loadCard(); await load(); },
    }) : null);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 记忆文档：打开看全文 / 逐条改记录 / 全量档案搜索 / 备份恢复。
 * 文档（memory-card.md）是记录渲染出来的，所以编辑入口在「记忆记录」页签，
 * 改完保存会重写 md / 两份 prompt，不需要让用户手改生成文件。
 * ───────────────────────────────────────────────────────────────────────── */
const MEM_PLATFORM_LABEL = { qq: "QQ", bili: "B站", shared: "共享", pet: "桌宠" };
const MEM_CLARITY_LABEL = { vivid: "鲜明", clear: "清楚", fuzzy: "模糊", trace: "仅印象" };
const MEM_DOC_TABS = [
  ["records", "记录"], ["backups", "备份"], ["advanced", "高级"],
];

function MemoryDocModal({ onClose, toast, onChanged }) {
  const [snap, setSnap] = useState(null);
  // 默认直接进可编辑的记录列表：先看到「能改什么」，而不是一份只读预览。
  const [tab, setTab] = useState("records");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [recordQuery, setRecordQuery] = useState("");
  // 列表过滤：全部 / 锚点 / 模糊或仅印象 / 手动新增 / QQ / B站
  const [recordFilter, setRecordFilter] = useState("all");
  const [recordSort, setRecordSort] = useState("recent");
  const [draft, setDraft] = useState(null);
  const [addForm, setAddForm] = useState({ title: "", text: "", importance: 60, tags: "" });
  const [full, setFull] = useState(null);
  const [fullQuery, setFullQuery] = useState("");
  // 手动整理：勾选若干条 → 交给模型合并/去噪（置顶和初次相遇不可选）。
  const [selected, setSelected] = useState(function () { return new Set(); });
  const [selectedId, setSelectedId] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const loadSnap = useCallback(async () => {
    setBusy("reload");
    // 文档页要能逐条编辑，列表默认 80 条不够：这里多拿一些（后端上限 500）。
    try { setSnap(await api("/memory-card?limit=300")); setErr(""); }
    catch (e) { setErr(`读取记忆卡失败：${e.message}`); }
    finally { setBusy(""); }
  }, []);
  useEffect(() => { loadSnap(); }, [loadSnap]);

  const loadFull = useCallback(async (query) => {
    setBusy("full");
    try {
      setFull(await api(`/memory-card/full?q=${encodeURIComponent(String(query ?? ""))}&limit=40`));
      setErr("");
    } catch (e) { setErr(`读取全量档案失败：${e.message}`); }
    finally { setBusy(""); }
  }, []);

  const openTab = (key) => {
    setTab(key);
    setDraft(null);
    setNotice("");
    if (key === "advanced" && !full) void loadFull(fullQuery);
  };

  const mutate = async (body, okText) => {
    setBusy("act");
    setNotice("");
    try {
      const r = await api("/memory-card", { method: "POST", body });
      if (r?.ok === false) throw new Error(r.error ?? "失败");
      setSnap(r);
      // POST 返回的是默认 80 条快照；再按文档上限拉一次，避免刚改的第 200 条从列表里消失。
      try { setSnap(await api("/memory-card?limit=300")); } catch { /* 失败就先用 80 条快照 */ }
      setFull(null);
      setNotice(okText);
      toast(okText);
      await onChanged?.();
      return r;
    } catch (e) {
      // 弹窗里也留一条可见反馈：只靠外壳 toast 的话，保存失败容易被当成「按钮没反应」。
      setNotice(`✗ ${e.message}`);
      toast(`✗ ${e.message}`);
      return null;
    } finally { setBusy(""); }
  };

  const dirtyDraft = () => {
    if (!draft) return false;
    const origin = (snap?.records ?? []).find((record) => record.id === draft.id);
    if (!origin) return false;
    return String(origin.title || "") !== String(draft.title || "")
      || String(origin.text || "") !== String(draft.text || "")
      || Number(origin.importance || 0) !== Number(draft.importance || 0)
      || (origin.pinned === true) !== (draft.pinned === true)
      || (origin.noOrganize === true) !== (draft.noOrganize === true)
      || (Array.isArray(origin.tags) ? origin.tags.join(",") : "") !== String(draft.tags || "").replace(/\s+/g, "");
  };

  const startEdit = (record) => {
    if (draft && draft.id !== record.id && dirtyDraft()) {
      if (!confirm("当前这条有未保存的修改，放弃并切换？")) return;
    }
    setSelectedId(record.id);
    setDraft({
      id: record.id,
      title: record.title || "",
      text: record.text || "",
      importance: Number(record.importance) || 60,
      tags: Array.isArray(record.tags) ? record.tags.join(", ") : "",
      pinned: record.pinned === true,
      noOrganize: record.noOrganize === true,
    });
  };

  const saveDraft = async () => {
    if (!draft) return;
    if (!String(draft.text ?? "").trim()) { toast("✗ 内容不能为空"); setNotice("✗ 内容不能为空"); return; }
    const r = await mutate({
      action: "update",
      id: draft.id,
      patch: {
        title: draft.title,
        text: draft.text,
        importance: Number(draft.importance) || 60,
        tags: String(draft.tags ?? "").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        pinned: draft.pinned === true,
        noOrganize: draft.noOrganize === true,
      },
    }, "✓ 记忆已保存");
    if (r) setDraft(null);
  };

  const addMemory = async () => {
    if (!String(addForm.text ?? "").trim()) { toast("✗ 先写内容"); setNotice("✗ 先写内容"); return; }
    const r = await mutate({
      action: "add",
      title: addForm.title,
      text: addForm.text,
      importance: Number(addForm.importance) || 60,
      scope: "qq",
      tags: String(addForm.tags ?? "").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    }, "✓ 已新增一条记忆");
    if (r) setAddForm({ title: "", text: "", importance: 60, tags: "" });
  };

  const restoreBackup = async (name) => {
    if (!confirm(`恢复到备份「${name}」？当前记忆卡会先自动备份一份。`)) return;
    await mutate({ action: "restore", name }, "✓ 已恢复备份");
  };

  const selectableRecords = (snap?.records ?? []).filter((record) => !record.pinned && !record.firstMet);
  const allSelected = selectableRecords.length > 0 && selectableRecords.every((record) => selected.has(record.id));
  const toggleSelectAll = () => {
    if (allSelected) { setSelected(new Set()); return; }
    setSelected(new Set(selectableRecords.map((record) => record.id)));
  };

  const toggleSelected = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const forgetSelected = async () => {
    const ids = [...selected].filter((id) => (snap?.records ?? []).some((record) => record.id === id));
    if (!ids.length) { toast("✗ 先勾选要忘记的记录"); return; }
    if (!confirm(`忘记选中的 ${ids.length} 条记忆？置顶记录会被跳过；原始内容仍保留在全量档案。`)) return;
    const r = await mutate({ action: "forget-batch", ids }, "✓ 已忘记选中的记忆");
    if (r) setSelected(new Set());
  };

  const organizeSelected = async () => {
    const ids = [...selected].filter((id) => (snap?.records ?? []).some((record) => record.id === id));
    if (ids.length < 2) { toast("✗ 至少选 2 条再整理"); return; }
    if (!confirm(`整理选中的 ${ids.length} 条记忆？会分批调用模型合并重复内容、删除纯闲聊；置顶、初次相遇和「不整理」的记录会被跳过。`)) return;
    const r = await mutate({ action: "organize", ids }, "✓ 选中记忆已整理");
    if (r) setSelected(new Set());
  };

  const setNoOrganize = async (record, value) => {
    await mutate({ action: "update", id: record.id, patch: { noOrganize: value } },
      value ? "✓ 已标记「不整理」" : "✓ 已恢复「可整理」");
  };

  const batchProtect = async (value) => {
    const ids = [...selected].filter((id) => (snap?.records ?? []).some((record) => record.id === id));
    if (!ids.length) { toast("✗ 先勾选记忆"); return; }
    await mutate({ action: "protect-batch", ids, noOrganize: value },
      value ? `✓ ${ids.length} 条已设为「不整理」` : `✓ ${ids.length} 条已恢复「可整理」`);
    setSelected(new Set());
  };

  const records = (snap?.records ?? []).filter((record) => {
    const needle = recordQuery.trim().toLowerCase();
    if (needle && !`${record.title} ${record.text} ${(record.tags ?? []).join(" ")}`.toLowerCase().includes(needle)) return false;
    if (recordFilter === "organizable") return record.noOrganize !== true && record.pinned !== true && record.firstMet !== true;
    if (recordFilter === "noOrganize") return record.noOrganize === true;
    if (recordFilter === "pinned") return record.pinned === true;
    if (recordFilter === "fuzzy") return record.clarity === "fuzzy" || record.clarity === "trace";
    if (recordFilter === "manual") return (record.tags ?? []).includes("manual");
    if (recordFilter === "qq") return record.platform === "qq";
    if (recordFilter === "bili") return record.platform === "bili";
    return true;
  }).sort((a, b) => {
    if (recordSort === "importance") return (Number(b.importance) || 0) - (Number(a.importance) || 0);
    if (recordSort === "clarity") {
      const order = { vivid: 0, clear: 1, fuzzy: 2, trace: 3 };
      return (order[a.clarity] ?? 9) - (order[b.clarity] ?? 9);
    }
    return (Date.parse(b.date || "") || 0) - (Date.parse(a.date || "") || 0);
  });

  // 列表行：只负责选中；真正编辑在右侧面板，避免「列表一边展开一边改」的混乱。
  const renderRecordRow = (record) => {
    const protectedRecord = record.pinned === true || record.firstMet === true;
    const active = draft && draft.id === record.id;
    return h("div", {
      key: record.id, className: "qbw-rec qbw-rec-edit", role: "button", tabIndex: 0,
      title: "点这条在右侧编辑",
      style: active ? { borderColor: "var(--qbw-accent)", margin: "0 0 8px" } : { margin: "0 0 8px" },
      onClick: () => startEdit(record),
      onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startEdit(record); } },
    },
      h("div", { style: { display: "flex", gap: "8px", alignItems: "flex-start" } },
        h("input", {
          type: "checkbox", checked: selected.has(record.id), disabled: protectedRecord,
          title: protectedRecord ? "置顶 / 初次相遇默认不参与整理" : "勾选后可批量整理或标记",
          style: { marginTop: "3px" },
          onClick: (e) => e.stopPropagation(),
          onChange: (e) => { e.stopPropagation(); toggleSelected(record.id); },
        }),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { className: "qbw-rec-title", style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
            h("span", null, record.title || "（无标题）"),
            record.noOrganize ? h(Badge, { kind: "warn" }, "不整理") : null,
            record.pinned ? h(Badge, null, "置顶") : null,
            record.firstMet ? h(Badge, { kind: "ok" }, "初次相遇") : null),
          h("div", { className: "qbw-hint" },
            `${fmtTime(record.date)} · ${MEM_CLARITY_LABEL[record.clarity] ?? record.clarity ?? "—"} · 重要 ${record.importance ?? 0}`),
          h("div", {
            className: "qbw-rec-text",
            style: { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", opacity: 0.85 },
          }, record.text || "（空）")),
        h("div", { style: { flex: "0 0 auto" } },
          h(Btn, {
            kind: record.noOrganize ? "qbw-btn3 danger" : "qbw-btn3", disabled: protectedRecord,
            title: protectedRecord
              ? "置顶 / 初次相遇默认不参与整理"
              : (record.noOrganize ? "当前：不整理（点一下恢复为可整理）" : "当前：可整理（点一下标记为不整理）"),
            onClick: (e) => { e.stopPropagation(); setNoOrganize(record, !record.noOrganize); },
          }, record.noOrganize ? "不整理" : "可整理"))));
  };

  const editorPane = () => draft
    ? h("div", { className: "qbw-rec", style: { margin: 0 } },
      h("div", { className: "qbw-hint", style: { marginBottom: "6px" } }, dirtyDraft() ? "有未保存的修改" : "编辑中，改完点保存"),
      h(Row, { label: "标题" },
        h("input", {
          className: "qbw-input", value: draft.title, placeholder: "一句话概括",
          onChange: (e) => setDraft((d) => ({ ...d, title: e.target.value })),
        })),
      h("div", { className: "qbw-group" }, "内容"),
      h("textarea", {
        className: "qbw-textarea", value: draft.text, style: { minHeight: "120px" },
        onChange: (e) => setDraft((d) => ({ ...d, text: e.target.value })),
      }),
      h("div", { style: { display: "flex", gap: "12px", flexWrap: "wrap" } },
        h(Row, { label: "重要度", hint: "1-100" },
          h("input", {
            className: "qbw-input", type: "number", min: 1, max: 100, value: draft.importance, style: { width: "90px" },
            onChange: (e) => setDraft((d) => ({ ...d, importance: e.target.value })),
          })),
        h(Row, { label: "标签", hint: "逗号分隔" },
          h("input", {
            className: "qbw-input", value: draft.tags, style: { minWidth: "200px" },
            onChange: (e) => setDraft((d) => ({ ...d, tags: e.target.value })),
          }))),
      h(Row, { label: "参与整理", hint: "关掉后：一键整理 / 自动整理 / 批量整理都不会动这条" },
        h("label", { className: "qbw-check" },
          h("input", {
            type: "checkbox", className: "qbw-switch", checked: draft.noOrganize !== true,
            onChange: (e) => setDraft((d) => ({ ...d, noOrganize: !e.target.checked })),
          }),
          h("span", null, draft.noOrganize ? "不整理（受保护）" : "可整理"))),
      h(Row, { label: "置顶", hint: "置顶同样不会被压缩 / 忘记" },
        h("input", {
          type: "checkbox", className: "qbw-switch", checked: draft.pinned === true,
          onChange: (e) => setDraft((d) => ({ ...d, pinned: e.target.checked })),
        })),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: saveDraft, disabled: !!busy }, busy === "act" ? "保存中…" : "保存"),
        h(Btn, { kind: "qbw-btn2", disabled: !!busy, onClick: () => { setDraft(null); setSelectedId(""); } }, "取消"),
        h(Btn, {
          kind: "qbw-btn3 danger", disabled: !!busy,
          onClick: async () => {
            if (!confirm("忘记这条记忆？置顶的记忆不会被忘记。原始内容仍保留在全量档案。")) return;
            const r = await mutate({ action: "forget", id: draft.id }, "✓ 已忘记");
            if (r) { setDraft(null); setSelectedId(""); }
          },
        }, "忘记")))
    : h("div", {
      className: "qbw-hint",
      style: { padding: "24px 14px", border: "1px dashed var(--qbw-bd)", borderRadius: "10px", textAlign: "center" },
    }, selectedId ? "这条记忆已经不在列表里了（可能被整理掉）" : "从左边点一条记忆，这里会出现编辑框");

  const renderFullRecord = (record, index) => h("div", { key: `${record.id}-${index}`, className: "qbw-rec" },
    h("div", null,
      h("div", { className: "qbw-rec-title" }, record.title || "（无标题）",
        record.firstMet ? h(Badge, { kind: "ok" }, "初次相遇") : null),
      h("div", { className: "qbw-hint" },
        `${fmtTime(record.date)} · ${MEM_PLATFORM_LABEL[record.platform] ?? record.platform ?? "—"} · 重要 ${record.importance ?? 0}${record.matchScore ? ` · 匹配度 ${record.matchScore}` : ""}`),
      h("div", {
        className: "qbw-rec-text", title: record.text,
        style: { display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" },
      }, record.text || "（空）"),
      record.archivedAt ? h("div", { className: "qbw-hint" }, `归档于 ${fmtTime(record.archivedAt)}`) : null));

  const body = !snap
    ? h("div", { className: "qbw-hint" }, busy === "reload" ? "读取记忆卡…" : "还没有读到记忆卡。")
    : tab === "records"
        ? h("div", null,
          h("div", { className: "qbw-search" },
            h("input", {
              className: "qbw-input", placeholder: "搜标题 / 正文 / 标签",
              value: recordQuery, onChange: (e) => setRecordQuery(e.target.value),
            }),
            recordQuery ? h(Btn, { kind: "qbw-btn2", onClick: () => setRecordQuery("") }, "清空") : null,
            h(Btn, { kind: "qbw-btn2", onClick: () => setAddOpen((value) => !value) }, addOpen ? "收起新增" : "手动新增"),
            h("select", { className: "qbw-select", value: recordSort, onChange: (e) => setRecordSort(e.target.value) },
              h("option", { key: "recent", value: "recent" }, "最新"),
              h("option", { key: "importance", value: "importance" }, "最重要"),
              h("option", { key: "clarity", value: "clarity" }, "最清晰"))),
          addOpen ? h("div", { className: "qbw-rec", style: { marginTop: "8px" } },
            h(Row, { label: "标题" },
              h("input", {
                className: "qbw-input", placeholder: "可选，一句话概括", value: addForm.title,
                onChange: (e) => setAddForm((f) => ({ ...f, title: e.target.value })),
              })),
            h("div", { className: "qbw-group" }, "内容"),
            h("textarea", {
              className: "qbw-textarea", placeholder: "她应该记住什么？", value: addForm.text,
              onChange: (e) => setAddForm((f) => ({ ...f, text: e.target.value })),
            }),
            h("div", { style: { display: "flex", gap: "12px", flexWrap: "wrap" } },
              h(Row, { label: "重要度", hint: "默认 60" },
                h("input", {
                  className: "qbw-input", type: "number", min: 1, max: 100, value: addForm.importance, style: { width: "90px" },
                  onChange: (e) => setAddForm((f) => ({ ...f, importance: e.target.value })),
                })),
              h(Row, { label: "标签", hint: "逗号分隔" },
                h("input", {
                  className: "qbw-input", value: addForm.tags, style: { minWidth: "180px" },
                  onChange: (e) => setAddForm((f) => ({ ...f, tags: e.target.value })),
                }))),
            h("div", { className: "qbw-actions" },
              h(Btn, { onClick: addMemory, disabled: !!busy }, busy === "act" ? "保存中…" : "新增记忆"))) : null,
          h("div", { className: "qbw-chips", style: { margin: "10px 0 2px" } },
            [["all", "全部"], ["organizable", "可整理"], ["noOrganize", "不整理"], ["pinned", "锚点"], ["fuzzy", "模糊/仅印象"], ["manual", "手动"]].map(([key, label]) =>
              h("button", {
                key, type: "button", className: recordFilter === key ? "qbw-chip on" : "qbw-chip",
                onClick: () => setRecordFilter(key),
              }, label))),
          h("div", { style: { display: "flex", gap: "10px", alignItems: "center", marginTop: "6px" } },
            h("label", { className: "qbw-check" },
              h("input", { type: "checkbox", checked: allSelected, onChange: toggleSelectAll }),
              h("span", null, allSelected ? "取消全选" : "全选可整理")),
            h("span", { className: "qbw-hint" }, `已选 ${selected.size} 条`)),
          selected.size
            ? h("div", { className: "qbw-actions", style: { marginTop: "8px" } },
              h("span", { className: "qbw-hint", style: { alignSelf: "center" } }, `已选 ${selected.size} 条`),
              h(Btn, { kind: "qbw-btn2", onClick: organizeSelected, disabled: !!busy || selected.size < 2 }, busy === "act" ? "整理中…" : "整理选中"),
              h(Btn, { kind: "qbw-btn2", onClick: () => batchProtect(true), disabled: !!busy }, "设为不整理"),
              h(Btn, { kind: "qbw-btn2", onClick: () => batchProtect(false), disabled: !!busy }, "设为可整理"),
              h(Btn, { kind: "qbw-btn2 danger", onClick: forgetSelected, disabled: !!busy }, "忘记选中"),
              h(Btn, { kind: "qbw-btn3", onClick: () => setSelected(new Set()) }, "清空"))
            : null,
          h("div", { className: "qbw-hint", style: { margin: "8px 0 2px" } },
            `共 ${records.length} 条${recordFilter !== "all" || recordQuery ? "（已筛选）" : ""}。点一条开始编辑；右侧「可整理 / 不整理」是状态，点一下切换。`),
          draft
            ? h("div", { style: { display: "flex", gap: "14px", alignItems: "flex-start", marginTop: "8px" } },
              h("div", { style: { flex: "0 0 340px", minWidth: 0 } },
                h("div", { className: "qbw-rows qbw-doc-list", style: { maxHeight: "56vh", overflowY: "auto", paddingRight: "2px" } },
                  records.length ? records.map(renderRecordRow) : h("div", { className: "qbw-hint" }, "没有匹配的记忆。"))),
              h("div", { style: { flex: 1, minWidth: 0 } }, editorPane()))
            : h("div", { className: "qbw-rows qbw-doc-list", style: { maxHeight: "58vh", overflowY: "auto", marginTop: "8px" } },
              records.length ? records.map(renderRecordRow) : h("div", { className: "qbw-hint" }, "没有匹配的记忆。")))
    : tab === "advanced"
      ? h("div", null,
        h(Section, { title: "全文预览", note: "由记录自动生成，不用手改", defaultOpen: false },
          snap.status?.paths?.markdown ? h(PathLine, { label: "文件", path: snap.status.paths.markdown }) : null,
          h("div", { className: "qbw-out", style: { maxHeight: "36vh" } }, snap.markdown || "（空）")),
        h(Section, { title: "提示词块", note: "注入 QQ / B站 的内容，有字数上限", defaultOpen: false },
          h("div", { className: "qbw-group" }, "QQ"),
          h("div", { className: "qbw-out", style: { maxHeight: "22vh" } }, snap.promptQq || "（空）"),
          h("div", { className: "qbw-group" }, "B站"),
          h("div", { className: "qbw-out", style: { maxHeight: "22vh" } }, snap.promptBili || "（空）")),
        h(Section, { title: "全量档案", note: "只存档，不参与日常提示词；可搜索", defaultOpen: false },
          h("div", { className: "qbw-search" },
            h("input", {
              className: "qbw-input", placeholder: "搜全量档案（标题 / 正文 / 标签）",
              value: fullQuery,
              onChange: (e) => setFullQuery(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") void loadFull(fullQuery); },
            }),
            h(Btn, { onClick: () => loadFull(fullQuery), disabled: busy === "full" }, busy === "full" ? "搜索中…" : "搜索")),
          !full
            ? h("div", { className: "qbw-hint" }, "点「搜索」加载全量档案。")
            : h("div", null,
              h("div", { className: "qbw-hint" },
                `档案 ${fmtBytes(full.status?.bytes)} · ${full.status?.records ?? 0} 条${full.query ? ` · 匹配「${full.query}」` : ""}`),
              h("div", { className: "qbw-rows", style: { maxHeight: "46vh", overflowY: "auto" } },
                (full.records ?? []).length ? full.records.map(renderFullRecord) : h("div", { className: "qbw-hint" }, "没有匹配的记录。")))))
    : h("div", null,
              h("div", { className: "qbw-hint" }, "压缩 / 每日整理前会自动备份；恢复时会把当前卡先备份一份。全量档案的备份不在这里。"),
              (snap.backups ?? []).length
                ? h("div", { className: "qbw-rows" }, snap.backups.map((item) => h("div", { key: item.name, className: "qbw-item" },
                  h("div", null,
                    h("div", { className: "qbw-label" }, item.name),
                    h("div", { className: "qbw-hint" }, `${fmtTime(item.mtime)} · ${fmtBytes(item.bytes)}`)),
                  h(Btn, { kind: "qbw-btn2", disabled: !!busy, onClick: () => restoreBackup(item.name) }, "恢复"))))
                : h("div", { className: "qbw-hint" }, "还没有备份。"));

  return h(Modal, { title: "记忆文档", note: "左边选、右边改；标「不整理」的记录不会被整理合并或删除", onClose, width: 980 },
    h("div", { className: "qbw-seg" },
      MEM_DOC_TABS.map(([key, label]) => h("button", {
        key, type: "button", className: tab === key ? "on" : "", onClick: () => openTab(key),
      }, label))),
    h("div", { style: { marginTop: "10px", minHeight: "180px" } }, body),
    notice ? h("div", {
      className: "qbw-hint",
      style: { marginTop: "8px", fontWeight: 600, color: notice.startsWith("✗") ? "#c0353a" : "#1a8f5c" },
    }, notice) : null,
    err ? h("div", { className: "qbw-err" }, err) : null,
    h("div", { className: "qbw-actions" },
      h(Btn, { kind: "qbw-btn2", onClick: loadSnap, disabled: !!busy }, busy === "reload" ? "读取中…" : "刷新"),
      h(Btn, { kind: "qbw-btn2", onClick: onClose, disabled: busy === "act" }, "关闭")));
}
