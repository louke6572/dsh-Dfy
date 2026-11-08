/* 贴吧（平台页里的第五个）：本页只做界面，贴吧逻辑与执行全部在 dsh-tieba-dive 插件里。
   数据直接走插件自己的同源接口 /api/tieba-duty/*（status / config / cookie / run / sign / timeline），
   不在 dsh-Dfy 里另造一套后端；插件升级改了什么，这里跟着插件走。 */

// 插件路由前缀（不是 dsh-Dfy 的 /dsh-surfcore）。
async function tiebaDuty(path, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const hasBody = options.body !== undefined && options.body !== null;
  const res = await fetch(`/api/tieba-duty${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(hasBody || method !== "GET" ? { "content-type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(options.body) } : method !== "GET" ? { body: "{}" } : {}),
  });
  let data = {};
  try { data = await res.json(); } catch { /* 空响应按空对象处理 */ }
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// 平台页里的贴吧：账号 / 刷帖 / 节奏 / 吧与词 / 手动操作。
function TiebaPage({ setBusy, toast }) {
  const [status, setStatus] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState("");
  const [bduss, setBduss] = useState("");
  const [busyId, setBusyId] = useState("");
  const [timeline, setTimeline] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([tiebaDuty("/status"), tiebaDuty("/config")]);
      setStatus(s);
      setCfg(c.cfg ?? {});
      setErr("");
    } catch (e) {
      setErr(`读取贴吧插件失败：${e.message}（先确认 dsh-tieba-dive 已安装并启用）`);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const patch = (key, value) => setCfg((prev) => ({ ...(prev ?? {}), [key]: value }));

  const run = async (id, fn, okText) => {
    setBusyId(id);
    try {
      const result = await fn();
      if (okText) toast(okText);
      await load();
      return result;
    } catch (e) {
      toast(`✗ ${e.message}`);
      return null;
    } finally {
      setBusyId("");
    }
  };

  const save = () => run("save", async () => {
    const r = await tiebaDuty("/config", { method: "POST", body: cfg ?? {} });
    setCfg(r.cfg ?? cfg);
    toast("✓ 贴吧设置已保存（插件即时生效）");
  });

  const login = () => {
    if (!bduss.trim()) { toast("✗ 先粘贴 BDUSS"); return null; }
    return run("login", async () => {
      const r = await tiebaDuty("/cookie", { method: "POST", body: { cookie: bduss.trim() } });
      setBduss("");
      if (!r?.user && r?.ok !== false) toast("✓ BDUSS 已写入，若昵称为空说明 cookie 无效");
      else toast(`✓ 已登录${r?.user ? `：${r.user}` : ""}`);
      return r;
    });
  };

  const startRound = () => run("start", () => tiebaDuty("/run", { method: "POST", body: { reason: "手动" } }), "✓ 已开始一轮（结果在最近动态）");
  const stopRound = () => run("stop", () => tiebaDuty("/run/stop", { method: "POST" }), "✓ 已停止本轮");
  const signNow = () => run("sign", () => tiebaDuty("/sign", { method: "POST" }), "✓ 已签到关注的吧");
  const loadTimeline = () => run("timeline", async () => {
    const r = await tiebaDuty("/timeline?n=20");
    setTimeline(r.entries ?? []);
    return r;
  });

  if (err) {
    return h(Card, { title: "贴吧", note: "由 dsh-tieba-dive 插件提供" },
      h("div", { className: "qbw-warnbox" }, err));
  }
  if (!status || !cfg) {
    return h(Card, { title: "贴吧", note: "读取插件状态中…" },
      h("div", { className: "qbw-hint" }, "正在连接 /api/tieba-duty"));
  }

  const on = (key) => cfg[key] === true;

  return (
    h("div", { className: "qbw-page" },
      h(Card, {
        title: "账号",
        note: "登录由插件管理；BDUSS 从浏览器登录 tieba.baidu.com 后，开发者工具里复制 Cookie 的 BDUSS 字段。",
        right: h(StatusDot, { ok: Boolean(status.hasCookie), children: status.hasCookie ? "已登录" : "未登录" }),
      },
        status.user ? h(Row, { label: "当前账号" }, h("span", null, String(status.user))) : null,
        h(Row, { label: "BDUSS", hint: "粘贴整段值即可，不用带 BDUSS=" },
          h("div", { className: "qbw-inline" },
            h("input", {
              className: "qbw-input",
              style: { minWidth: "320px" },
              value: bduss,
              placeholder: "粘贴 BDUSS…",
              onChange: (e) => setBduss(e.target.value),
            }),
            h(Btn, { kind: "primary", onClick: login, disabled: busyId === "login" }, busyId === "login" ? "登录中…" : "登录"))),
        status.cooldown?.leftMin > 0 ? h("div", { className: "qbw-warnbox" }, `插件处于熔断冷却，还剩 ${status.cooldown.leftMin} 分钟`) : null,
        status.lastError ? h("div", { className: "qbw-warnbox" }, `上次报错：${status.lastError}`) : null),

      h(Card, { title: "刷帖与回复", note: "开关直接写插件配置；改完点下面的「保存」" },
        h(Row, { label: "自动回帖", hint: "AI 读帖后有把握才回" },
          h("input", { type: "checkbox", className: "qbw-switch", checked: on("autoReply"), onChange: (e) => patch("autoReply", e.target.checked) })),
        h(Row, { label: "自动签到", hint: "每天固定时间签到关注的吧" },
          h("input", { type: "checkbox", className: "qbw-switch", checked: on("autoSign"), onChange: (e) => patch("autoSign", e.target.checked) })),
        h(Row, { label: "新吧自动关注", hint: "不关注签不了到" },
          h("input", { type: "checkbox", className: "qbw-switch", checked: on("autoFollow"), onChange: (e) => patch("autoFollow", e.target.checked) })),
        h(Row, { label: "每天自动跑一轮", hint: "后台无头进程，需要本机 dsh 可用" },
          h("input", { type: "checkbox", className: "qbw-switch", checked: on("autoRun"), onChange: (e) => patch("autoRun", e.target.checked) })),
        h(Row, { label: "只在谷时跑", hint: "工作时段外" },
          h("input", { type: "checkbox", className: "qbw-switch", checked: on("valleyOnly"), onChange: (e) => patch("valleyOnly", e.target.checked) })),
        h(Row, { label: "客服腔过滤", hint: "拦掉亲亲、在的哦这类口气" },
          h("input", { type: "checkbox", className: "qbw-switch", checked: on("toneGate"), onChange: (e) => patch("toneGate", e.target.checked) })),
        h(Row, { label: "允许解答疑问", hint: "回帖里回答问题" },
          h("input", { type: "checkbox", className: "qbw-switch", checked: on("answerQuestions"), onChange: (e) => patch("answerQuestions", e.target.checked) }))),

      h(Card, { title: "节奏与额度", note: "数字都是插件配置里的原值" },
        h(Row, { label: "每轮读几个楼" },
          h(NumberInput, { value: cfg.readPerRound, onChange: (v) => patch("readPerRound", v), min: 1, max: 20 })),
        h(Row, { label: "每轮回几条" },
          h(NumberInput, { value: cfg.replyPerRound, onChange: (v) => patch("replyPerRound", v), min: 0, max: 10 })),
        h(Row, { label: "每天最多回几条", hint: "硬上限" },
          h(NumberInput, { value: cfg.replyPerDay, onChange: (v) => patch("replyPerDay", v), min: 0, max: 50 })),
        h(Row, { label: "两条回复至少隔几秒" },
          h(NumberInput, { value: cfg.replyGapSec, onChange: (v) => patch("replyGapSec", v), min: 5, max: 600 })),
        h(Row, { label: "请求间隔（毫秒）", hint: "越小越快，也越容易被风控" },
          h(NumberInput, { value: cfg.requestGapMs, onChange: (v) => patch("requestGapMs", v), min: 300, max: 10000, step: 100 })),
        h(Row, { label: "几点签到" },
          h(NumberInput, { value: cfg.signHour, onChange: (v) => patch("signHour", v), min: 0, max: 23 })),
        h(Row, { label: "读过的帖几天内不再推" },
          h(NumberInput, { value: cfg.dedupeDays, onChange: (v) => patch("dedupeDays", v), min: 0, max: 60 }))),

      h(Card, { title: "吧与关键词", note: "一行一个；不填就不会刷任何吧" },
        h(Row, { label: "关注的吧" },
          h(ListInput, { value: Array.isArray(cfg.bars) ? cfg.bars : [], onChange: (v) => patch("bars", v), placeholder: "例如：孙笑川吧" })),
        h(Row, { label: "关注关键词" },
          h(ListInput, { value: Array.isArray(cfg.keywords) ? cfg.keywords : [], onChange: (v) => patch("keywords", v), placeholder: "例如：显卡" }))),

      h(Card, { title: "手动操作", note: "直接调插件的执行接口" },
        h("div", { className: "qbw-actions" },
          h(Btn, { kind: "primary", onClick: startRound, disabled: busyId === "start" }, busyId === "start" ? "执行中…" : "现在刷一轮"),
          h(Btn, { onClick: stopRound, disabled: busyId === "stop" }, "停止本轮"),
          h(Btn, { onClick: signNow, disabled: busyId === "sign" }, "立即签到"),
          h(Btn, { onClick: loadTimeline, disabled: busyId === "timeline" }, "看最近动态")),
        timeline ? h("div", { className: "qbw-hint" },
          timeline.length ? timeline.map((item, i) => h("div", { key: i }, `${fmtTime(item.at)} · ${item.text ?? item.kind ?? ""}`)) : "还没有记录")
          : null),

      h("div", { className: "qbw-actions", style: { marginTop: "10px" } },
        h(Btn, { kind: "primary", onClick: save, disabled: busyId === "save" }, busyId === "save" ? "保存中…" : "保存贴吧设置")),

      h("div", { className: "qbw-hint", style: { marginTop: "8px" } },
        "说明：贴吧的全部能力（读帖、回帖、签到、人设学习）都由 dsh-tieba-dive 插件提供；本页只是把常用项搬进 dsh-Dfy 的平台页，卸载插件后这一页会提示未安装。")));
}
