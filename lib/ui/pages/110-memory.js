/* 记忆库：按需检索架构下的记忆管理。
 *
 * 2026-11 架构（用户定稿）：记忆不常驻注入对话——首注只带身份版（初次相遇/重点/公开近况），
 * 主人私聊细节按每条消息召回，其余靠模型的 memory_search 工具按关键词临时检索。
 * 所以这一页不再围着「记忆卡容量 %」和清晰度衰减转：主视图是记忆库里有什么、
 * 她最近记了什么、检索会返回什么；维护类操作收进「维护」与「平台同步」。
 */

// 模型侧 memory_search 的同款分词（后端 backend/lib/index.js registerMemoryTools.queryTokens）：
// 英文按词、中文按 2 字滑窗。改这里时两端要一起改。
function memoryQueryTokens(query) {
  const s = String(query ?? "").toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/[a-z0-9][a-z0-9]+/g)) out.add(m[0]);
  const cjk = s.replace(/[^\u4e00-\u9fff]/g, " ");
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return [...out].slice(0, 24);
}

// 与模型侧同一套打分：命中词数优先，其次重点，最后按日期。
// 敏感条目（sensitive=true）模型看不到，这里同样过滤，只统计条数。
function memorySearchPreview(records, query, limit = 5) {
  const tokens = memoryQueryTokens(query);
  if (!tokens.length) return { tokens, hits: [], total: 0, filtered: 0 };
  const hits = [];
  let filtered = 0;
  for (const record of records) {
    if (record.sensitive === true) { filtered += 1; continue; }
    const hay = `${record.title || ""} ${record.text || ""} ${(record.tags || []).join(" ")}`.toLowerCase();
    let score = 0;
    for (const token of tokens) if (token && hay.includes(token)) score += 1;
    if (score > 0) hits.push({ record, score });
  }
  hits.sort((a, b) => b.score - a.score
    || (b.record.pinned === true) - (a.record.pinned === true)
    || String(b.record.date ?? "").localeCompare(String(a.record.date ?? "")));
  return { tokens, hits: hits.slice(0, limit), total: hits.length, filtered };
}

const MEM_SOURCE_LABEL = { qq: "QQ", bili: "B站", shared: "共享", pet: "桌宠" };

function MemoryPage({ qq, setQq, unified, rawUnified, setUnified, overview, busy, setBusy, toast, reload, goTab }) {
  const [data, setData] = useState(null);
  const [card, setCard] = useState(null);
  const [err, setErr] = useState("");
  const [docOpen, setDocOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState(null);

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
      if (manual) toastRef.current?.("✓ 记忆库已刷新");
    } catch (e) {
      if (manual) toastRef.current?.(`✗ 刷新失败：${e.message}`);
    } finally {
      if (manual) setBusy("");
    }
  }, []);
  useEffect(() => { load(); loadCard(); }, [load, loadCard]);

  const biliBridgeOn = qq?.biliBridge?.enabled !== false;
  const biliToQq = qq?.biliBridge?.memory?.enabled !== false;
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
  // 数字输入专用：本地草稿、防抖提交（400ms），且只刷新卡片（loadCard），
  // 不调 reload()/loadConfig() —— 否则每敲一键就把本会话里其它未保存的配置草稿整份覆盖掉，
  // 还会因为「服务端值回填」导致多位数输不进去（值跳变）。
  const organizeTimerRef = useRef(0);
  const setOrganizeNumber = (patch, okText) => {
    if (organizeTimerRef.current) clearTimeout(organizeTimerRef.current);
    organizeTimerRef.current = setTimeout(async () => {
      organizeTimerRef.current = 0;
      setBusy("organize-config");
      try {
        const r = await api("/memory-card", { method: "POST", body: { action: "organize-config", ...patch } });
        toastRef.current?.(r?.ok === false ? `✗ ${r.error ?? "保存失败"}` : okText);
        await loadCard();
      } catch (e) { toastRef.current?.(`✗ ${e.message}`); }
      finally { setBusy(""); }
    }, 400);
  };
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
    if (!confirm("一键整理会用一次模型调用：合并重复、删掉纯寒暄；重点、初次相遇和标记「不参与整理」的记录都不会动。继续？")) return;
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

  const runSearch = async () => {
    const q = query.trim();
    if (!q) { toast("✗ 先输入要检索的词"); return; }
    setSearching(true);
    setSearchResult(null);
    try {
      // 模型侧 memory_search 读的是 500 条上限的快照，这里保持一致。
      const snap = await api("/memory-card?limit=500");
      setSearchResult(memorySearchPreview(snap?.records ?? [], q));
    } catch (e) { toast(`✗ 检索失败：${e.message}`); }
    finally { setSearching(false); }
  };

  const renderSearchHit = ({ record, score }) => h("div", { key: record.id, className: "qbw-rec" },
    h("div", null,
      h("div", { className: "qbw-rec-title" }, record.title || "（无标题）",
        record.pinned ? h(Badge, null, "重点") : null,
        h("span", { className: "qbw-hint", style: { marginLeft: "6px" } }, `命中 ${score}`)),
      h("div", { className: "qbw-hint" }, `${fmtTime(record.date)} · ${MEM_SOURCE_LABEL[record.platform] ?? record.platform ?? "—"}`),
      h("div", { className: "qbw-rec-text", style: { marginTop: "2px" } }, String(record.text || "").slice(0, 160))));

  const st = card?.status ?? card ?? {};
  const records = card?.records ?? [];
  // 设置页统计也用「记忆」口径：聊天流水不算她记得的事。
  const memoryRecords = records.filter((record) => isRealMemory(record));
  const total = memoryRecords.length;
  const recent = [...memoryRecords]
    .sort((a, b) => (Date.parse(b.date || "") || 0) - (Date.parse(a.date || "") || 0))
    .slice(0, 5);
  const recent7 = memoryRecords.filter((r) => (Date.parse(r.date || "") || 0) > Date.now() - 7 * 86400_000).length;
  const memoryAnchors = memoryRecords.filter((r) => r.pinned === true).length;
  const memoryFirstMet = memoryRecords.filter((r) => r.firstMet === true).length;
  const organizable = memoryRecords.filter((r) => r.noOrganize !== true && r.pinned !== true && r.firstMet !== true).length;
  const noOrganizeCount = memoryRecords.filter((r) => r.noOrganize === true).length;
  const nextPlan = (() => {
    const organize = card?.organize ?? {};
    if (!organize.enabled) return "未开启自动整理";
    if (!organize.lastRunAt) return "等下一次整点检查";
    const nextAt = organize.lastRunAt + (organize.intervalHours ?? 20) * 3600_000;
    return `${fmtTime(nextAt)} 之后${Number(organize.hour) >= 0 ? `（${String(organize.hour).padStart(2, "0")}:00 左右）` : ""}`;
  })();
  const cardEnabled = card?.enabled !== false;

  return h("div", null,
    h(Card, {
      title: "记忆库",
      right: h(Badge, { kind: cardEnabled ? "ok" : "warn" }, cardEnabled ? "写入中" : "写入已关"),
      note: "她只记重要的事：你说「记住」的、偏好、约定、计划和重要近况。聊天时她按需检索，不会把整份记忆塞进对话。",
    },
      h("div", { style: { display: "flex", gap: "24px", margin: "8px 0 6px" } },
        [["她记得", total], ["重点", memoryAnchors], ["初次相遇", memoryFirstMet], ["最近 7 天", recent7]].map(([label, value]) =>
          h("div", { key: label, style: { textAlign: "center", minWidth: "54px" } },
            h("div", { style: { fontSize: "22px", fontWeight: 700, lineHeight: "26px" } }, String(value ?? 0)),
            h("div", { style: { fontSize: "11px", opacity: 0.65 } }, label)))),
      h("div", { className: "qbw-meta" },
        h("span", null, `参与自动整理 ${organizable}`),
        h("span", null, `不参与 ${noOrganizeCount}`),
        !cardEnabled ? h("span", null, "她不会记新东西") : null),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: () => setDocOpen(true), disabled: !!busy }, "打开记忆库"),
        h(Btn, { kind: "qbw-btn3", onClick: () => loadCard({ manual: true }), disabled: !!busy }, busy === "card-refresh" ? "刷新中…" : "刷新")),
      err ? h("div", { className: "qbw-err" }, err) : null),

    h(Card, { title: "她最近记了什么", note: "按时间倒序；点「打开记忆库」能改、能删。", right: recent.length ? h(Badge, null, `${recent.length} 条`) : null },
      recent.length
        ? recent.map((record) => h("div", { key: record.id, className: "qbw-item" },
          h("div", null,
            h("div", { className: "qbw-label" }, record.title || "（无标题）",
              record.pinned ? h(Badge, null, "重点") : null,
              record.noOrganize ? h(Badge, { kind: "warn" }, "不参与整理") : null),
            h("div", { className: "qbw-hint" },
              (record.tags || []).includes("AI记录") ? "她自己记的" : "")),
          h("div", { className: "qbw-hint", style: { maxWidth: "300px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } }, record.text || "")))
        : h("div", { className: "qbw-hint" }, records.length ? "最近没有新写入。" : "还没有读到记忆库。")),

    h(Card, {
      title: "她能想起什么",
      note: "她从记忆库里按关键词找回忆。这里可以试一下：问一个词，看她能不能想起相关的事。",
    },
      h("div", { className: "qbw-search" },
        h("input", {
          className: "qbw-input", placeholder: "试试：主人、B站、表情包",
          value: query,
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") void runSearch(); },
        }),
        h(Btn, { onClick: runSearch, disabled: searching }, searching ? "查找中…" : "查一下")),
      !searchResult
        ? h("div", { className: "qbw-hint" }, "输入关键词点「查一下」，看她这次能想起什么。")
        : !searchResult.tokens.length
          ? h("div", { className: "qbw-hint" }, "这个词太短了：至少两个中文字或一个英文词。")
          : searchResult.hits.length
          ? h("div", null,
            h("div", { className: "qbw-hint", style: { marginBottom: "6px" } },
              `想起 ${searchResult.total} 条，这里是前 ${searchResult.hits.length} 条${searchResult.filtered ? `（另有 ${searchResult.filtered} 条私人内容不会显示）` : ""}`),
            searchResult.hits.map(renderSearchHit))
          : h("div", { className: "qbw-hint" }, `她没想起和「${query.trim()}」有关的记忆。`)),

    h(Card, { title: "怎么记", note: "默认只记重要的事：明确让她记的、偏好 / 约定 / 计划 / 重要近况；闲聊不进记忆。" },
      h(Row, { label: "记忆方式", hint: "「记录聊天流水」是旧模式，会把整段对话当记忆存，不推荐" },
        h("select", {
          className: "qbw-select",
          value: qq?.memory?.recordMode === "chatlog" ? "chatlog" : "facts",
          onChange: (e) => setQq(["memory", "recordMode"], e.target.value),
        },
          h("option", { key: "facts", value: "facts" }, "只记重要的事（推荐）"),
          h("option", { key: "chatlog", value: "chatlog" }, "记录聊天流水（旧）"))),
      !cardEnabled ? h("div", { className: "qbw-warnbox" }, "记忆写入已关闭：她不会记新东西。") : null),

    h(Card, {
      title: "整理",
      right: h(Badge, { kind: card?.organize?.enabled ? "ok" : "" }, card?.organize?.enabled ? "自动整理" : "手动整理"),
      note: "整理会合并重复的记忆、删掉没用的；重点、初次相遇、不参与整理的永远不动。",
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
      h(KV, { label: "下次检查" }, nextPlan),
      h(KV, { label: "上次整理" }, card?.organize?.lastRunAt
        ? `${fmtTime(card.organize.lastRunAt)} · 合并 ${card.organize.lastMerged ?? 0} 组 · 删除 ${card.organize.lastDropped ?? 0} 条`
        : "还没整理过"),
      h("div", { className: "qbw-actions" },
        h(Btn, { onClick: previewOrganize, disabled: !!busy }, busy === "organize-preview" ? "分析中…" : "看看会动哪些"),
        h(Btn, { kind: "qbw-btn2", onClick: organizeAll, disabled: !!busy }, busy === "organize" ? "整理中…" : "立即整理"),
        h(Btn, { kind: "qbw-btn2", onClick: diaryYesterday, disabled: !!busy }, busy === "diary" ? "写日记中…" : "写昨日日记")),
      preview
        ? h("div", { className: "qbw-hint", style: { marginTop: "6px" } },
          `会合并 ${preview.duplicates} 组重复、删掉 ${preview.noisy} 条没用的（另有 ${preview.faded} 条已淡忘）；`
          + `重点 / 初次相遇 / 不参与整理 共 ${preview.protectedCount + (preview.noOrganizeCount ?? 0)} 条不会动。`)
        : h("div", { className: "qbw-hint", style: { marginTop: "6px" } }, "先点「看看会动哪些」（本地规则，不调模型），再决定要不要立即整理。"),
      organizeMsg ? h("div", { className: organizeMsg.startsWith("✗") ? "qbw-err" : "qbw-hint", style: { marginTop: "6px", fontWeight: 600 } }, organizeMsg) : null,
      h(Section, { title: "整理计划与清理", note: "多久整理一次 / 什么时候 / 多少条才值得整理 / 清空聊天记录", defaultOpen: false },
        h(Row, { label: "间隔（小时）" },
          h(NumberInput, { value: card?.organize?.intervalHours ?? 20, min: 6, max: 168,
            onChange: (v) => setOrganizeNumber({ intervalHours: v ?? 20 }, "✓ 间隔已保存") })),
        h(Row, { label: "时间点" },
          h("select", { className: "qbw-select", value: String(card?.organize?.hour ?? -1),
            onChange: (e) => setOrganizeCfg({ hour: Number(e.target.value) }, "✓ 时间已保存") },
            h("option", { key: "-1", value: "-1" }, "任意时间"),
            Array.from({ length: 24 }, (_, hour) => h("option", { key: String(hour), value: String(hour) }, `${String(hour).padStart(2, "0")}:00`)))),
        h(Row, { label: "至少多少条" },
          h(NumberInput, { value: card?.organize?.minRecords ?? 40, min: 10, max: 300,
            onChange: (v) => setOrganizeNumber({ minRecords: v ?? 40 }, "✓ 阈值已保存") })),
        h("div", { className: "qbw-actions" },
          h(Btn, {
            kind: "qbw-btn3 danger", disabled: !!busy,
            onClick: async () => {
              if (!confirm("清空聊天记录？只删原始聊天流水，不删记忆；重点、初次相遇、日记、手动新增和整理过的记忆都会保留。")) return;
              await run("purge-chatlog", () => api("/memory-card", { method: "POST", body: { action: "purge-chatlog" } }),
                (r) => `✓ 已清掉 ${r.removed ?? 0} 条聊天记录`);
            },
          }, busy === "purge-chatlog" ? "清理中…" : "清空聊天记录")))),

    h(Section, { title: "平台同步（B站 ⇄ QQ）", note: "只搬公开、脱敏后的近况；私聊永不跨平台", defaultOpen: false },
      h(Row, { label: "B站 → QQ" },
        h("input", { className: "qbw-switch", type: "checkbox", checked: toggle, onChange: (e) => setUnified(["__biliToQqToggle"], e.target.checked) })),
      biliBridgeOn
        ? null
        : h("div", { className: "qbw-hint" }, "注意：B站 桥接总闸是关的。要去「养鱼（B站）」打开「启用 B站 桥接」，这个同步开关才真正生效（这里不会代你打开总闸）。"),
      h(KV, { label: "B站简报" }, `${status.biliToQq?.briefChars ?? 0} 字 · ${fmtTime(status.biliToQq?.generatedAt)}`),
      h(Row, { label: "QQ → B站" },
        h("input", { className: "qbw-switch", type: "checkbox", checked: qqToBili.enabled === true, onChange: (e) => setQqToBili("enabled", e.target.checked) })),
      h(Row, { label: "回看（天）", hint: "同步时回看多少天的聊天记录（1~90 天）" },
        h(NumberInput, { value: qqToBili.lookbackDays ?? 7, min: 1, max: 90,
          onChange: (v) => setQqToBili("lookbackDays", v ?? 7) })),
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
 * 记忆库（弹窗）：逐条改记录 / 聊天记录 / 备份恢复。
 * 口径与设置页一致：这个列表就是记忆库本身（按需检索的来源），
 * 不是一张要整卡塞进提示词的东西——所以这里不放「容量 %」，只放条数与操作。
 * ───────────────────────────────────────────────────────────────────────── */
const MEM_PLATFORM_LABEL = { qq: "QQ", bili: "B站", shared: "共享", pet: "桌宠" };

/* 记忆主题：记忆库按「她记得的事」分组，而不是按时间列聊天流水。
 * 规则只读标题/正文与既有标签，不调模型；分错了可以在「记录」页改标签，或后续接整理器的分类。 */
const MEM_TOPIC_META = {
  first: { label: "初次相遇", hint: "最早认识时的记录，永远不会被整理" },
  master: { label: "关于主人", hint: "作息、工作、习惯、身体状态" },
  relation: { label: "称呼与关系", hint: "怎么叫她、两人之间的约定" },
  work: { label: "项目与技术", hint: "她帮主人做的事、系统与配置" },
  interest: { label: "兴趣与平台", hint: "B站、抖音、贴吧、表情包、内容口味" },
  diary: { label: "日记", hint: "按天写的完整回顾" },
  life: { label: "生活与近况", hint: "天气、吃饭、通勤、日常片段" },
  chat: { label: "原始对话片段", hint: "旧模式留下的聊天记录，只存档、不是记忆" },
};
const MEM_TOPIC_ORDER = ["first", "master", "relation", "work", "interest", "diary", "life", "chat"];

function memoryTopicOf(record) {
  const tags = Array.isArray(record.tags) ? record.tags : [];
  // 聊天原文 / 她自己说过的话：不论是不是「初次相遇」重点，都不是记忆。
  if (tags.includes("initial") || tags.includes("self")) return "chat";
  if (/^(和主人|桌宠 · 和主人)/.test(String(record.title ?? ""))) return "chat";
  if (tags.includes("diary")) return "diary";
  if (record.firstMet) return "first";
  const t = `${record.title ?? ""} ${record.text ?? ""}`;
  // 顺序即优先级：先认领域（平台/主人状态/技术），再认关系与生活。
  if (/(B站|抖音|贴吧|视频|表情包|评论区|up主|刷B|刷视频|刷到|刷抖音)/i.test(t)) return "interest";
  if (/(作息|起床|洗澡|上班|下班|加班|工作|累|休息)/.test(t)) return "master";
  if (/(插件|代码|配置|部署|DSH|Hermes|token|模型|语音|调试|联调|修复|接口|服务器|版本|脚本|模拟器|浏览器)/.test(t)) return "work";
  if (/(昵称|称呼|叫我|名字|羁绊|感情|喜欢我|在意我)/.test(t)) return "relation";
  if (/(天气|下雨|吃饭|吃了|到家|周末|放假|通勤)/.test(t)) return "life";
  if (/主人/.test(t)) return "master";
  return "life";
}

/** 记忆库只收「她记住的事实/事件」：聊天原文、日记、闲聊摘要都不算记忆。 */
function isRealMemory(record) {
  const topic = memoryTopicOf(record);
  if (topic === "chat" || topic === "diary") return false;
  if (/闲聊|碎片|背景/.test(String(record.title ?? ""))) return false;
  return true;
}
const MEM_DOC_TABS = [
  ["overview", "总览"], ["memory", "记忆"], ["archive", "聊天记录"], ["backup", "备份"],
];

function MemoryDocModal({ onClose, toast, onChanged }) {
  const [snap, setSnap] = useState(null);
  // 默认进「总览」：先看清她记得什么，再进「记忆」页逐条改。
  const [tab, setTab] = useState("overview");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");
  const [recordQuery, setRecordQuery] = useState("");
  // 列表过滤：全部 / 参与整理 / 重点 / 模糊或仅印象 / 手动新增 / QQ / B站
  const [recordFilter, setRecordFilter] = useState("all");
  const [recordSort, setRecordSort] = useState("importance");
  const [draft, setDraft] = useState(null);
  const [addForm, setAddForm] = useState({ title: "", text: "", importance: 60, tags: "" });
  const [full, setFull] = useState(null);
  const [fullQuery, setFullQuery] = useState("");
  // 手动整理：勾选若干条 → 交给模型合并/去噪（重点和初次相遇不可选）。
  const [selected, setSelected] = useState(function () { return new Set(); });
  const [selectedId, setSelectedId] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  const loadSnap = useCallback(async () => {
    setBusy("reload");
    // 记忆库页要能逐条编辑，列表默认 80 条不够：这里多拿一些（后端上限 500）。
    try { setSnap(await api("/memory-card?limit=300")); setErr(""); }
    catch (e) { setErr(`读取记忆库失败：${e.message}`); }
    finally { setBusy(""); }
  }, []);
  useEffect(() => { loadSnap(); }, [loadSnap]);

  const loadFull = useCallback(async (query) => {
    setBusy("full");
    try {
      setFull(await api(`/memory-card/full?q=${encodeURIComponent(String(query ?? ""))}&limit=40`));
      setErr("");
    } catch (e) { setErr(`读取聊天记录失败：${e.message}`); }
    finally { setBusy(""); }
  }, []);

  const openTab = (key) => {
    setTab(key);
    setDraft(null);
    setNotice("");
    if (key === "archive" && !full) void loadFull(fullQuery);
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
    if (!confirm(`恢复到备份「${name}」？当前记忆库会先自动备份一份。`)) return;
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
    if (!confirm(`忘记选中的 ${ids.length} 条记忆？重点记录会被跳过；原始内容仍保留在聊天记录里。`)) return;
    const r = await mutate({ action: "forget-batch", ids }, "✓ 已忘记选中的记忆");
    if (r) setSelected(new Set());
  };

  const organizeSelected = async () => {
    const ids = [...selected].filter((id) => (snap?.records ?? []).some((record) => record.id === id));
    if (ids.length < 2) { toast("✗ 至少选 2 条再整理"); return; }
    if (!confirm(`整理选中的 ${ids.length} 条记忆？会分批调用模型合并重复内容、删掉没用的；重点、初次相遇和「不参与整理」的记录会被跳过。`)) return;
    const r = await mutate({ action: "organize", ids }, "✓ 选中记忆已整理");
    if (r) setSelected(new Set());
  };

  const batchProtect = async (value) => {
    const ids = [...selected].filter((id) => (snap?.records ?? []).some((record) => record.id === id));
    if (!ids.length) { toast("✗ 先勾选记忆"); return; }
    await mutate({ action: "protect-batch", ids, noOrganize: value },
      value ? `✓ ${ids.length} 条已设为「不参与整理」` : `✓ ${ids.length} 条已恢复「参与整理」`);
    setSelected(new Set());
  };

  // 记忆库只算「记忆」：聊天流水不算，头部数字也不把它算进去。
  const memoryRecords = (snap?.records ?? []).filter((record) => isRealMemory(record));
  const memoryTotal = memoryRecords.length;
  const memoryAnchors = memoryRecords.filter((record) => record.pinned === true).length;
  const memoryOrganizable = memoryRecords.filter((record) => record.noOrganize !== true && record.pinned !== true && record.firstMet !== true).length;
  const memoryNoOrganize = memoryRecords.filter((record) => record.noOrganize === true).length;


  // 记忆库只看「记忆」：聊天流水不算记忆，不进这个界面（清理入口在设置页「维护」）。
  const records = (snap?.records ?? []).filter((record) => {
    if (!isRealMemory(record)) return false;
    const needle = recordQuery.trim().toLowerCase();
    if (needle && !`${record.title} ${record.text} ${(record.tags ?? []).join(" ")}`.toLowerCase().includes(needle)) return false;
    if (recordFilter === "organizable") return record.noOrganize !== true && record.pinned !== true && record.firstMet !== true;
    if (recordFilter === "noOrganize") return record.noOrganize === true;
    if (recordFilter === "pinned") return record.pinned === true;
    if (recordFilter === "fuzzy") return record.clarity === "fuzzy" || record.clarity === "trace";
    if (recordFilter === "manual") return (record.tags ?? []).includes("manual");
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
  // 行尾不再放「参与整理/不参与整理」按钮（每行一个太吵）：状态看徽标，切换在编辑面板和批量操作里。
  const renderRecordRow = (record) => {
    const protectedRecord = record.pinned === true || record.firstMet === true;
    const active = draft && draft.id === record.id;
    const broken = /[\uFFFD]/.test(`${record.title ?? ""}${record.text ?? ""}`);
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
          title: protectedRecord ? "重点 / 初次相遇默认不参与整理" : "勾选后可批量整理或标记",
          style: { marginTop: "3px" },
          onClick: (e) => e.stopPropagation(),
          onChange: (e) => { e.stopPropagation(); toggleSelected(record.id); },
        }),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { className: "qbw-rec-title", style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
            h("span", null, record.title || "（无标题）"),
            h(Badge, null, MEM_TOPIC_META[memoryTopicOf(record)]?.label ?? "其他"),
            record.noOrganize ? h(Badge, { kind: "warn" }, "不参与整理") : null,
            record.pinned ? h(Badge, null, "重点") : null,
            record.firstMet ? h(Badge, { kind: "ok" }, "初次相遇") : null,
            (record.tags ?? []).includes("AI记录") ? h(Badge, null, "她自己记的") : null,
            broken ? h(Badge, { kind: "bad" }, "编码异常") : null),
          h("div", { className: "qbw-hint" },
            // 记忆不显示「哪天从哪个平台来」——那是聊天记录的属性，只留重要度。
            `重要 ${record.importance ?? 0}`),
          h("div", {
            className: "qbw-rec-text",
            style: { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", opacity: 0.85 },
          }, record.text || "（空）"))));
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
          h("span", null, draft.noOrganize ? "不参与整理（受保护）" : "参与整理"))),
      h(Row, { label: "设为重点", hint: "重点记忆：整理时不会合并删除，检索时优先想起" },
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
            if (!confirm("忘记这条记忆？重点记忆不会被忘记。原始内容仍保留在聊天记录里。")) return;
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

  const recordsBody = !snap
    ? h("div", { className: "qbw-hint" }, busy === "reload" ? "读取记忆库…" : "读不到记忆库；点下方「刷新」重试。")
    : h("div", null,
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
        [["all", "全部"], ["organizable", "参与整理"], ["noOrganize", "不参与整理"], ["pinned", "重点"]].map(([key, label]) =>
          h("button", {
            key, type: "button", className: recordFilter === key ? "qbw-chip on" : "qbw-chip",
            onClick: () => setRecordFilter(key),
          }, label))),
      h("div", { style: { display: "flex", gap: "10px", alignItems: "center", marginTop: "6px", flexWrap: "wrap" } },
        h("label", { className: "qbw-check" },
          h("input", { type: "checkbox", checked: allSelected, onChange: toggleSelectAll }),
          h("span", null, allSelected ? "取消全选" : "全选参与整理")),
        h("span", { className: "qbw-hint" }, `已选 ${selected.size} 条 · 共 ${records.length} 条${recordFilter !== "all" || recordQuery ? "（已筛选）" : ""}`)),
      selected.size
        ? h("div", { className: "qbw-actions", style: { marginTop: "8px" } },
          h(Btn, { kind: "qbw-btn2", onClick: organizeSelected, disabled: !!busy || selected.size < 2 }, busy === "act" ? "整理中…" : "整理选中"),
          h(Btn, { kind: "qbw-btn2", onClick: () => batchProtect(true), disabled: !!busy }, "设为不参与整理"),
          h(Btn, { kind: "qbw-btn2", onClick: () => batchProtect(false), disabled: !!busy }, "设为参与整理"),
          h(Btn, { kind: "qbw-btn2 danger", onClick: forgetSelected, disabled: !!busy }, "忘记选中"),
          h(Btn, { kind: "qbw-btn3", onClick: () => setSelected(new Set()) }, "清空"))
        : null,
      draft
        ? h("div", { style: { display: "flex", gap: "14px", alignItems: "flex-start", marginTop: "8px" } },
          h("div", { style: { flex: "0 0 340px", minWidth: 0 } },
            h("div", { className: "qbw-rows qbw-doc-list", style: { maxHeight: "46vh", overflowY: "auto", paddingRight: "2px" } },
              records.length ? records.map(renderRecordRow) : h("div", { className: "qbw-hint" }, "没有匹配的记忆。"))),
          h("div", { style: { flex: 1, minWidth: 0 } }, editorPane()))
        : h("div", { className: "qbw-rows qbw-doc-list", style: { maxHeight: "52vh", overflowY: "auto", marginTop: "8px" } },
          records.length ? records.map(renderRecordRow) : h("div", { className: "qbw-hint" }, "没有匹配的记忆。")));

  const archiveBody = h("div", null,
    h("div", { className: "qbw-search" },
      h("input", {
        className: "qbw-input", placeholder: "搜聊天记录（标题 / 正文 / 标签）",
        value: fullQuery,
        onChange: (e) => setFullQuery(e.target.value),
        onKeyDown: (e) => { if (e.key === "Enter") void loadFull(fullQuery); },
      }),
      h(Btn, { onClick: () => loadFull(fullQuery), disabled: busy === "full" }, busy === "full" ? "搜索中…" : "搜索")),
    h("div", { className: "qbw-hint" }, "聊天记录只存档、不参与记忆，也永远不删；「忘记」只是从记忆库移走，原始内容仍在这里可搜。"),
    !full
      ? h("div", { className: "qbw-hint", style: { marginTop: "8px" } }, "点「搜索」加载聊天记录。")
      : h("div", { style: { marginTop: "8px" } },
        h("div", { className: "qbw-hint" },
          `聊天记录 ${fmtBytes(full.status?.bytes)} · ${full.status?.records ?? 0} 条${full.query ? ` · 匹配「${full.query}」` : ""}`),
        h("div", { className: "qbw-rows", style: { maxHeight: "50vh", overflowY: "auto" } },
          (full.records ?? []).length ? full.records.map(renderFullRecord) : h("div", { className: "qbw-hint" }, "没有匹配的记录。"))));

  const backupBody = h("div", null,
    h("div", { className: "qbw-hint" }, "压缩 / 每日整理前会自动备份；恢复时会把当前库先备份一份。聊天记录的备份不在这里。"),
    (snap?.backups ?? []).length
      ? h("div", { className: "qbw-rows", style: { marginTop: "8px" } }, snap.backups.map((item) => h("div", { key: item.name, className: "qbw-item" },
        h("div", null,
          h("div", { className: "qbw-label" }, item.name),
          h("div", { className: "qbw-hint" }, `${fmtTime(item.mtime)} · ${fmtBytes(item.bytes)}`)),
        h(Btn, { kind: "qbw-btn2", disabled: !!busy, onClick: () => restoreBackup(item.name) }, "恢复"))))
      : h("div", { className: "qbw-hint", style: { marginTop: "8px" } }, "还没有备份。"),
    h(Section, { title: "原始文件", note: "记录渲染出来的只读预览；要改内容请回「记忆」页签", defaultOpen: false },
      snap?.status?.paths?.markdown ? h(PathLine, { label: "文件", path: snap.status.paths.markdown }) : null,
      h("div", { className: "qbw-out", style: { maxHeight: "40vh" } }, snap?.markdown || "（空）")));

  // 总览：她记得的事按主题分组，一眼看全；点任意一条进「记忆」页编辑。
  // 总览：她记得的事按主题分组，一眼看全；点任意一条进「记忆」页编辑。
  const memoryGroups = (() => {
    const groups = {};
    for (const record of memoryRecords) {
      const topic = memoryTopicOf(record);
      (groups[topic] = groups[topic] || []).push(record);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
    }
    return groups;
  })();
  const memoryRecent7 = memoryRecords.filter((record) => (Date.parse(record.date || "") || 0) > Date.now() - 7 * 86400_000).length;

  const renderOverviewItem = (record) => h("div", {
    key: record.id, className: "qbw-item qbw-rec-edit", role: "button", tabIndex: 0,
    title: "点这条去「记忆」页编辑",
    style: { cursor: "pointer", alignItems: "flex-start" },
    onClick: () => { setTab("memory"); startEdit(record); },
  },
    h("div", { style: { flex: "1 1 100%", minWidth: 0 } },
      h("div", { className: "qbw-label" }, record.title || "（无标题）"),
      h("div", {
        className: "qbw-rec-text",
        style: { marginTop: "2px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
      }, record.text || "（空）")));

  const overviewBody = !snap
    ? h("div", { className: "qbw-hint" }, busy === "reload" ? "读取记忆库…" : "读不到记忆库；点下方「刷新」重试。")
    : !memoryTotal
      ? h("div", { className: "qbw-hint" }, "她还没有记住什么事：聊天里说「记住…」或在这里「手动新增」都会进记忆库。")
      : h("div", null,
        h("div", { className: "qbw-meta", style: { marginBottom: "8px" } },
          h("span", null, `她记得 ${memoryTotal} 件事`),
          h("span", null, `重点 ${memoryAnchors}`),
          h("span", null, `最近 7 天 +${memoryRecent7}`)),
        MEM_TOPIC_ORDER.filter((topic) => (memoryGroups[topic]?.length ?? 0) > 0).map((topic) => h(Section, {
          key: topic,
          title: `${MEM_TOPIC_META[topic].label}（${memoryGroups[topic].length}）`,
          note: MEM_TOPIC_META[topic].hint,
          defaultOpen: true,
        },
          h("div", { className: "qbw-rows" }, memoryGroups[topic].map(renderOverviewItem)))),
        h("div", { className: "qbw-hint", style: { marginTop: "10px" } },
          "聊天原文、日记、闲聊摘要不算记忆，不会出现在这里；要逐条改点上面任意一条。"));

  const body = !snap
    ? h("div", { className: "qbw-hint" }, busy === "reload" ? "读取记忆库…" : "读不到记忆库；点下方「刷新」重试。")
    : tab === "overview" ? overviewBody
      : tab === "memory" ? recordsBody
        : tab === "archive" ? archiveBody
          : backupBody;


  return h(Modal, {
    title: "记忆库",
    note: tab === "overview"
      ? "她记住的重要信息；点任意一条进「记忆」页改"
      : "点一条在右侧改；重点与「不参与整理」不会被整理合并或删除",
    onClose, width: 980,
  },
    tab !== "overview" && snap
      ? h("div", { className: "qbw-meta", style: { marginBottom: "6px" } },
        h("span", null, `她记得 ${memoryTotal} 件`),
        h("span", null, `重点 ${memoryAnchors}`),
        h("span", null, `参与整理 ${memoryOrganizable}`),
        h("span", null, `不参与整理 ${memoryNoOrganize}`))
      : null,
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
