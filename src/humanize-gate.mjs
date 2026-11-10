/**
 * 活人感（内置版）第三阶段：攒一攒 / 群聊接话打分 / 按花费降低回复意愿。
 *
 * 全部是本地启发式，不额外调模型：
 *   · gather：等一个安静窗口再回（对方还在补、明显没说完、"稍等/我还没说完" → 多等）；
 *   · groupGate：群里没点名时用 8 条理由打分，低于阈值就不接；
 *   · willingness：读当天 QQ 花费，花得越多越不愿主动开口（被点名/私聊不受影响）。
 */
import fs from 'node:fs';
import path from 'node:path';

const PROFILES = {
  quiet: { yesScore: 5, noScore: 2.5, replyProb: 0.1, halfUsd: 0.25, floor: 0.05, baseSec: 3 },
  default: { yesScore: 4, noScore: 1.5, replyProb: 0.3, halfUsd: 0.45, floor: 0.1, baseSec: 2 },
  loud: { yesScore: 3, noScore: 1, replyProb: 0.5, halfUsd: 0.9, floor: 0.2, baseSec: 1.5 },
};

// 插件写的用量是人民币；halfUsd 是美元阈值。只用于「花得越多越不想说话」的软启发式。
const CNY_PER_USD = 7.2;

const UNFINISHED_TAIL = ['然后', '那个', '就是', '但是', '所以', '还有', '对了', '等我', '我跟你讲', '你知道', '等一下', '其实'];
const ASK_FOR_WAIT = ['稍等', '等我一下', '我还没说完', '别急', '还有一条', '马上说完'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function createHumanizeGate({ tokenUsageFile = null, log = () => {} } = {}) {
  let cachedUsage = { at: 0, cost: 0 };

  function profileOf(cfg = {}) {
    const name = String(cfg.profile || 'default');
    const base = PROFILES[name] ?? PROFILES.default;
    const custom = cfg.profile === 'custom';
    return {
      yesScore: Number(custom ? cfg.yesScore ?? base.yesScore : base.yesScore),
      noScore: Number(custom ? cfg.noScore ?? base.noScore : base.noScore),
      replyProb: custom ? Number(cfg.replyProb ?? 0.3) : base.replyProb,
      baseSec: Number(custom ? cfg.baseSec ?? 2 : base.baseSec),
      halfUsd: Number(custom ? cfg.halfUsd ?? 0.45 : base.halfUsd),
      floor: Number(custom ? cfg.floor ?? 0.1 : base.floor),
    };
  }

  function todayCost() {
    const now = Date.now();
    if (now - cachedUsage.at < 30_000) return cachedUsage.cost;
    let cost = 0;
    try {
      const data = readJson(tokenUsageFile);
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      // token-usage-daily.json 的 cost 是人民币（model-prices 的 currency=CNY），
      // 而配置里的 halfUsd 按美元写。这里换成美元再比，否则阈值会差 7 倍左右、
      // 花几毛钱就把接话意愿打到地板。汇率只影响软阈值的偏移，不参与计费。
      if (data && data.day === today) cost = (Number(data?.qq?.cost) || 0) / CNY_PER_USD;
    } catch { /* 读不到就当 0 */ }
    cachedUsage = { at: now, cost };
    return cost;
  }

  /** 回复意愿：0.05~1，花得越多越低。 */
  function willingness(cfg = {}) {
    const p = profileOf(cfg);
    const half = Math.max(0.01, p.halfUsd);
    const floor = Math.min(1, Math.max(0, p.floor));
    const ratio = 1 - todayCost() / half;
    return Math.max(floor, Math.min(1, ratio));
  }

  /** 等多久再回（毫秒）；0 = 不用等。 */
  function gatherDelayMs(text, cfg = {}) {
    if (cfg.gather === false) return 0;
    const p = profileOf(cfg);
    let ms = Math.max(0, Number(p.baseSec) || 0) * 1000;
    const body = String(text ?? '').trim();
    const tail = body.slice(-6);
    if (UNFINISHED_TAIL.some((word) => tail.endsWith(word))) ms += 1500;
    if (ASK_FOR_WAIT.some((word) => body.includes(word))) ms += 2500;
    return Math.min(8000, Math.max(0, ms));
  }

  /**
   * 群聊接话打分。返回 { score, reasons, reply }。
   * 被 @ / 引用她 / 叫名字 → 高分直回；群里正热闹且没点名 → 低分不接。
   */
  function judgeGroup({ text = '', event = {}, cfg = {}, selfNames = [], isOwner = false, quoteTargetIsSelf = false, recentCount = 0 } = {}) {
    if (cfg.groupGate === false) return { score: 99, reasons: ['gate-off'], reply: true };
    const p = profileOf(cfg);
    const body = String(text ?? '');
    const raw = String(event?.raw_message ?? '');
    const selfId = String(event?.self_id ?? '');
    const names = selfNames.map((name) => String(name ?? '')).filter(Boolean);
    let score = 0;
    const reasons = [];
    const add = (points, reason) => { score += points; reasons.push(`${reason}${points >= 0 ? '+' : ''}${points}`); };

    if (selfId && raw.includes(`[CQ:at,qq=${selfId}]`)) add(5, '@她');
    else if (raw.includes('[CQ:at,')) { /* 叫的是别人：不加分 */ }
    if (quoteTargetIsSelf) add(5, '引用她');
    if (names.some((name) => body.includes(name))) add(2.5, '叫了名字');
    if (/[你妳](们)?/.test(body)) add(1.5, '对你说');
    if (/[？?]|吗|呢|怎么|为什么|是不是|能不能/.test(body)) add(1.5, '在问');
    if (/哈哈|笑死|草|离谱|救命|呜呜|啊啊|好耶/.test(body)) add(0.5, '有情绪');
    if (body.length > 0 && body.length <= 24) add(0.5, '短句');
    if (recentCount >= 8) add(-1, '群里正热');
    if (isOwner) add(0.5, '主人');

    let reply;
    if (score >= p.yesScore) reply = true;
    else if (score <= p.noScore) reply = false;
    else reply = Math.random() < p.replyProb * willingness(cfg);
    return { score: Math.round(score * 10) / 10, reasons, reply };
  }

  return { profileOf, willingness, gatherDelayMs, judgeGroup, todayCost };
}

export { PROFILES };
