/**
 * 回复文本清洗（各平台共用）：
 *   去掉模型英文草稿（Question/Answer）、"作为一个AI"、"希望对你有帮助"这类客服腔。
 * 内置桥（QQ）和抖音回复都用这一份，避免两个平台语气不一致。
 */
export function humanizeReplyText(input) {
  let text = String(input ?? '');
  // 模型英文草稿：Question: ... / Answer: ... —— 保留 Answer 之后，丢掉草稿
  const lf = String.fromCharCode(10);
  let lines = text.split(String.fromCharCode(13)).join('').split(lf);
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
  text = lines.join(lf);
  for (const phrase of ['作为一个AI', '作为一个 ai', '作为人工智能', '作为语言模型', '作为一个语言模型', '作为AI助手', '作为一个助手',
    '希望对你有帮助', '希望这些能帮到你', '希望我的回答对你有帮助', '希望这个回答对你有帮助', '如果还有其他问题', '还有什么可以帮到你']) {
    text = text.split(phrase).join('');
  }
  const spaces = String.fromCharCode(32);
  const three = spaces + spaces + spaces;
  while (text.includes(three)) text = text.split(three).join(spaces);
  // 「禁止夹带句号」：人格卡（行为规则层）明确要求不用「。」，但模型很爱用，
  // 且注入的近况/见闻本身带句号，模型会照抄。这里做确定性兜底：
  // 句末/换行前的句号直接去掉，句中句号换成逗号（保留断句）。
  text = text.replace(/。[ \t]*(?=\n|$)/g, '');
  text = text.replace(/。/g, '，');
  return text.trim();
}
