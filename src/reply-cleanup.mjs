/**
 * 回复文本清洗（各平台共用）：
 *   去掉模型英文草稿（Question/Answer）、"作为一个AI"、"希望对你有帮助"这类客服腔。
 * 内置桥（QQ）和抖音回复都用这一份，避免两个平台语气不一致。
 *
 * cleanClutter=false 只关「客服腔 / 英文草稿」这一段（设置页的开关就是这么写的）；
 * 表情标记、句号、空行这些是人格与格式兜底，仍然照常处理。
 */

/**
 * 把全角写法（或 `]` 与 `(` 之间有空格）的 Markdown 图片行归一成标准半角。
 * GLM 等模型会写 `！[噫]（dshsticker:…）`；桥接只认半角，不修就会当文字发出去。
 * 只修正 dshsticker 引用，避免误伤正文里的正常括号。
 */
export function normalizeFullWidthMarkdown(input) {
  return String(input ?? '').replace(
    /[!！]\[\s*([^\]]{0,40})\s*\]\s*[（(]\s*(dshsticker:[^）)\s]+)\s*[）)]/gi,
    '![$1]($2)',
  );
}

/**
 * 自我旁白：模型把自己的动作/收尾/沉默决定当成一句话发出来，例如
 *   「她发表情，我回了张吃饱了的鲸鱼娘，正好接投喂话题，收尾」
 *   「这段已经收尾，主人没有再发新的，自然结束」
 *   「已经收尾过了，这轮是空唤醒没有实际来信，不重复收尾也不硬回话…」
 * 这些是工具提示 / 收尾摘要被当成台词复述，不是在对人说话。
 * 只按**整行**判定，句子里顺带提到不算。
 */
const NARRATION_LINE = new RegExp([
  // 动作旁白
  '(?:^|[，。；])\\s*(?:她|他|对方)(?:就|又|也)?(?:发|回)(?:了|个|张)?(?:表情|图片|照片|表情包)',
  '(?:正好|刚好)接(?:上|着)?[^，。]{0,8}话题',
  '(?:话题|梗|聊天|对话)[^，。]{0,10}(?:收尾|结束)',
  // 收尾 / 空唤醒决策旁白（2026-11-14 复发：planClose 提示与 closure summary 被复述）
  '(?:这段|这轮|本轮|这波|对话|聊天|话题)(?:已经|也)?收尾',
  '^(?:已经|刚|刚刚)?收尾(?:过|了)?了?$',
  '空唤醒',
  '没有实际来信',
  '(?:主人|对方)(?:也|都)?没有(?:再)?发(?:新|来)',
  '不硬回话',
  '不重复收尾',
  '就?保持安静',
  '等(?:有)?新话题再醒',
].join('|'), 'u');

export function humanizeReplyText(input, { cleanClutter = true } = {}) {
  let text = String(input ?? '');
  // 模型英文草稿：Question: ... / Answer: ... —— 保留 Answer 之后，丢掉草稿
  const lf = String.fromCharCode(10);
  let lines = text.split(String.fromCharCode(13)).join('').split(lf);
  if (cleanClutter) {
    const answerAt = lines.findIndex((line) => {
      const low = line.trim().toLowerCase();
      return low.startsWith('answer:') || low.startsWith('a:');
    });
    if (answerAt >= 0) {
      const before = lines.slice(0, answerAt).join(lf).toLowerCase();
      if (answerAt === 0 || before.includes('question:') || before.includes('q:')) {
        lines = lines.slice(answerAt).map((line, index) => (index === 0
          ? line.replace(/^\s*(?:answer|a)\s*[:：]\s*/i, '')
          : line));
      }
    }
  }
  text = lines.join(lf);
  // 模型偶尔会自己写 [sticker:名字] / [表情:名字] 这类「假表情标记」：
  // 只有外部表情插件认这种标记，桥接不认，原样发出去就是一段乱码文字。
  // 真表情走 sticker_send 返回的 Markdown 图片行；这里统一剥掉兜底。
  text = text.replace(/\[(?:sticker|表情)[:：][^\]\n]{1,40}\]/gi, '');
  // 有些模型（GLM 等）会把 Markdown 图片写成全角：！[名字]（dshsticker:…）。
  // 桥接只认半角语法，不修就会把这一整串当文字发出去（表现为乱码）。
  text = normalizeFullWidthMarkdown(text);
  if (cleanClutter) {
    for (const phrase of ['作为一个AI', '作为一个 ai', '作为人工智能', '作为语言模型', '作为一个语言模型', '作为AI助手', '作为一个助手',
      '希望对你有帮助', '希望对你有所帮助', '希望这些能帮到你', '希望我的回答对你有帮助', '希望这个回答对你有帮助',
      '如果还有其他问题', '还有什么可以帮到你']) {
      text = text.split(phrase).join('');
    }
    const spaces = String.fromCharCode(32);
    const three = spaces + spaces + spaces;
    while (text.includes(three)) text = text.split(three).join(spaces);
    // AI 味的自我点评：模型偶尔不接内容，只报「我能接住 / 这个梗我懂 / 我 get 到了」。
    // 只清掉**句尾**这种能力声明；整句都是它时换成一个人味短回复，避免把旁白发出去。
    const metaTail = /[，,、\s]*(?:(?:这个|这|那个)(?:梗|话|点)?(?:我)?(?:也|都|当然)?(?:能|可以|会)?接(?:得)?住|(?:这个|这|那个)?(?:梗|话|点)?我(?:也|都|当然)?(?:能|可以|会)接(?:得)?住|(?:我)?\s*get\s*(?:到|得|了)(?:了)?|(?:这个|这|那个)?梗我懂(?:了)?)(?:了|啦|啊|哈)?[。.!！~～]*$/iu;
    const gotIt = /[，,、\s]*(?:我)?(?:get|懂)(?:到|得|了)?你(?:的)?意思[。.!！~～]*$/iu;
    const original = text.trim();
    const isMeta = (line) => metaTail.test(line.trim()) || gotIt.test(line.trim());
    const stripped = text
      .split(lf)
      .map((line) => {
        const cut = line.replace(metaTail, '').replace(gotIt, '').trim();
        if (cut) return cut;
        return isMeta(line) ? '' : line;
      })
      .filter((line) => line.trim())
      .join(lf)
      .trim();
    if (stripped) text = stripped;
    else if (isMeta(original)) text = '？';
    // 固定附和开场（确实 / 就是 / 对 / 嗯…）是最好认的 AI 味：真人不会每条都先点头再说话。
    // 只在这个开场后面还有内容时去掉，避免把「嗯」「对」这种正常短回复清空。
    const agreeOpen = /^(?:确实|就是|对啊|对|是的|是啊|没错|嗯嗯|嗯|也是)[，,、~～\s]+/u;
    text = text.split(lf).map((line) => {
      const cut = line.replace(agreeOpen, '').trim();
      return cut.length >= 4 ? cut : line;
    }).join(lf);
  }
  // 自我旁白整行丢掉：她把自己的动作/收尾写成旁白时，删行而不是留在气泡里。
  // 放在 cleanClutter 之外——关掉「活人感」也不该把旁白发给对方。
  text = text
    .split(lf)
    .map((line) => (NARRATION_LINE.test(line.trim()) ? '' : line))
    .filter((line) => line.trim())
    .join(lf)
    .trim();
  // 「禁止夹带句号」：人格卡（行为规则层）明确要求不用「。」，但模型很爱用，
  // 且注入的近况/见闻本身带句号，模型会照抄。这里做确定性兜底：
  // 句末/换行前的句号直接去掉，句中句号换成逗号（保留断句）。
  text = text.replace(/。[ \t]*(?=\n|$)/g, '');
  text = text.replace(/。/g, '，');
  // 模型爱用空行分段（一句话、空一行、再一句），QQ / 抖音里都会显示成一个大气泡里的
  // 空白间隔，不像人手打的。压成一个换行；真要分条由分条规则决定。
  text = text.replace(/\n{2,}/g, '\n');
  return text.trim();
}

/**
 * 模型有时不写 [SILENT]，而是把「决定」当话发出来：
 *   「没叫我，不接」「群里没叫我，不接话」「沉默」「这条不是在叫我」…
 * 这些在群里会变成一条很怪的消息。只在**群聊**、且整条很短时判定为沉默；
 * 私聊不受影响（避免把正常的「不接」当潜水）。
 */
export function looksLikeSilenceDecision(input) {
  const t = String(input ?? '').trim().replace(/[。.!！~～、，,\s]+$/g, '').trim();
  if (!t || t.length > 30) return false;
  // 「（沉默）」「[沉默]」这类旁白式括注
  const inner = /^[\[（(【]\s*(.{1,20})\s*[\]）)】]$/.exec(t)?.[1] ?? '';
  if (inner && /^(?:沉默|潜水|不接话?|不说话|静默|略过|跳过)$/.test(inner)) return true;
  if (/^[\[（(【]?\s*silent\s*[\]）)】]?$/i.test(t)) return true;
  if (/^(?:沉默|潜水|不接话?|不插话|不回复|不说话|略过|跳过|不参与)$/.test(t)) return true;
  const mentionsMe = /(?:没|没有|没人|没有人)\s*(?:叫|点名|提到)我/.test(t) || /不是在叫我/.test(t);
  const decision = /(?:不接|不回|不说|不插话|潜水|沉默|算了|你们聊)/.test(t);
  return mentionsMe && decision;
}
