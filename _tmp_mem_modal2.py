from pathlib import Path
p = Path('lib/ui/pages/110-memory.js')
s = p.read_text(encoding='utf-8')

# tabs
s = s.replace('const MEM_DOC_TABS = [\n  ["records", "记忆记录（可编辑）"], ["doc", "全文预览"], ["prompt", "提示词"], ["full", "全量档案"], ["backups", "备份"],\n];',
              'const MEM_DOC_TABS = [\n  ["records", "记录"], ["backups", "备份"], ["advanced", "高级"],\n];', 1)

# sort state
s = s.replace('  const [recordFilter, setRecordFilter] = useState("all");',
              '  const [recordFilter, setRecordFilter] = useState("all");\n  const [recordSort, setRecordSort] = useState("recent");', 1)

# records sort
anchor = '''    if (recordFilter === "bili") return record.platform === "bili";
    return true;
  });'''
assert anchor in s
s = s.replace(anchor, '''    if (recordFilter === "bili") return record.platform === "bili";
    return true;
  }).sort((a, b) => {
    if (recordSort === "importance") return (Number(b.importance) || 0) - (Number(a.importance) || 0);
    if (recordSort === "clarity") {
      const order = { vivid: 0, clear: 1, fuzzy: 2, trace: 3 };
      return (order[a.clarity] ?? 9) - (order[b.clarity] ?? 9);
    }
    return (Date.parse(b.date || "") || 0) - (Date.parse(a.date || "") || 0);
  });''', 1)

# dirty helper + guard
anchor2 = '  const startEdit = (record) => {'
assert anchor2 in s
s = s.replace(anchor2, '''  const dirtyDraft = () => {
    if (!draft) return false;
    const origin = (snap?.records ?? []).find((record) => record.id === draft.id);
    if (!origin) return false;
    return String(origin.title || "") !== String(draft.title || "")
      || String(origin.text || "") !== String(draft.text || "")
      || Number(origin.importance || 0) !== Number(draft.importance || 0)
      || (origin.pinned === true) !== (draft.pinned === true)
      || (origin.noOrganize === true) !== (draft.noOrganize === true)
      || (Array.isArray(origin.tags) ? origin.tags.join(",") : "") !== String(draft.tags || "").replace(/\\s+/g, "");
  };

  const startEdit = (record) => {
    if (draft && draft.id !== record.id && dirtyDraft()) {
      if (!confirm("当前这条有未保存的修改，放弃并切换？")) return;
    }''', 1)
# 上面替换把原来的 `setSelectedId(record.id);` 之前的 `{` 保留了吗？原文本是 `const startEdit = (record) => {\n    setSelectedId`，替换后以 `const startEdit = (record) => {\n    if (...)` 继续，原有 setSelectedId 紧跟在后面 ✓

# openTab advanced
s = s.replace('    if (key === "full" && !full) void loadFull(fullQuery);',
              '    if (key === "advanced" && !full) void loadFull(fullQuery);', 1)

# advanced + backups
start = s.index('    : tab === "doc"')
backups_start = s.index('            : h("div", null,\n              h("div", { className: "qbw-hint" }, "压缩 / 每日整理前会自动备份')
modal_end = s.index('  return h(Modal, { title: "记忆文档"', backups_start)
backups = s[backups_start:modal_end]
advanced = '''    : tab === "advanced"
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
'''
s = s[:start] + advanced + backups + s[modal_end:]

# 排序下拉
anchor3 = '''            h(Btn, { kind: "qbw-btn2", onClick: () => setAddOpen((value) => !value) }, addOpen ? "收起新增" : "手动新增")),'''
assert anchor3 in s
s = s.replace(anchor3, '''            h(Btn, { kind: "qbw-btn2", onClick: () => setAddOpen((value) => !value) }, addOpen ? "收起新增" : "手动新增"),
            h("select", { className: "qbw-select", value: recordSort, onChange: (e) => setRecordSort(e.target.value) },
              h("option", { key: "recent", value: "recent" }, "最新"),
              h("option", { key: "importance", value: "importance" }, "最重要"),
              h("option", { key: "clarity", value: "clarity" }, "最清晰"))),''', 1)

# 编辑面板顶部提示
anchor4 = '''  const editorPane = () => draft
    ? h("div", { className: "qbw-rec", style: { margin: 0 } },'''
assert anchor4 in s
s = s.replace(anchor4, '''  const editorPane = () => draft
    ? h("div", { className: "qbw-rec", style: { margin: 0 } },
      h("div", { className: "qbw-hint", style: { marginBottom: "6px" } }, dirtyDraft() ? "有未保存的修改" : "编辑中，改完点保存"),''', 1)

p.write_text(s, encoding='utf-8')
print('modal IA applied')
