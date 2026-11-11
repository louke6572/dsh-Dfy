/**
 * 记忆召回（插件内置，不依赖外部记忆服务）。
 *
 * 记忆卡里已经是「事实条目」，这里做的是：按当前这句话的关键词/二字词，
 * 从卡里挑最多 N 条最相关的记忆，拼成一小段注入。目标：问什么想什么，
 * 而不是每轮把整张卡塞进上下文。
 */
import fs from 'node:fs';

function tokensOf(text) {
  const body = String(text ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]/gu, ' ')
    .trim();
  const parts = body.split(/\s+/).filter((word) => word.length >= 2);
  const out = new Set();
  for (const word of parts) {
    if (word.length <= 6) out.add(word.toLowerCase());
    for (let i = 0; i + 2 <= word.length && out.size < 48; i += 1) out.add(word.slice(i, i + 2).toLowerCase());
    if (out.size >= 48) break;
  }
  return [...out];
}

export function createMemoryRecall({ cardFile, log = () => {} } = {}) {
  let cache = { mtime: -1, records: [] };

  function records() {
    try {
      const stat = fs.statSync(cardFile);
      if (stat.mtimeMs === cache.mtime) return cache.records;
      const data = JSON.parse(fs.readFileSync(cardFile, 'utf8'));
      const list = Array.isArray(data?.records) ? data.records : [];
      cache = { mtime: stat.mtimeMs, records: list };
      return list;
    } catch {
      return cache.records;
    }
  }

  /**
   * 平台可见性：与 memory-card.js 的 visibleFor() 同一套口径。
   * 'bili'（=公开场合：群聊/抖音群/B站）排除桌宠(scope=pet)与普通 QQ 私聊流水，
   * 只保留 公开(bili/shared) + 身份记忆(初次相遇/锚点)；'qq'/'pet' 私下场合给全量。
   * 敏感条目任何注入版都不进（只供管理员看全量卡）。
   * 没有这一层时，group 里按关键词会把「主人喜欢猫」这类 pet/私聊记录召回进公开提示词，
   * 模型可能当众复述私事 —— 隐私泄漏。
   */
  function visibleForPlatform(record, platform) {
    if (!record) return false;
    if (record.sensitive) return false;
    if (platform === 'bili') {
      if (record.scope === 'pet' || record.platform === 'pet') return false;
      if (record.scope === 'bili' || record.scope === 'shared') return true;
      // 身份记忆全平台共用：初次相遇 + 被钉住的锚点（主人是谁、关系怎么开始的）。
      if (record.firstMet || record.pinned) return true;
      // 普通 QQ 私聊流水不进公开场合（与 visibleFor 的 includeQqInBili 默认关闭一致）。
      return false;
    }
    // 私下场合（qq / pet）读全量。
    return true;
  }

  /** 当前消息 → 相关记忆块；没有相关记录返回空串。
   *  platform：'bili' = 公开场合（群聊/抖音群/B站，排除桌宠与私聊流水）；
   *            'qq' / 'pet' = 私下场合（全量）。
   *  默认 'bili'（失败关闭）：漏传/拼错的平台只会拿到公开记忆，
   *  不会因为一个参数忘了传就把私聊记忆注入群聊。 */
  function promptBlock(text, { limit = 3, maxChars = 520, platform = 'bili' } = {}) {
    const tokens = tokensOf(text);
    if (!tokens.length) return '';
    const scored = [];
    for (const record of records()) {
      if (!visibleForPlatform(record, platform)) continue;
      const haystack = `${record.title || ''} ${record.text || ''} ${(record.tags || []).join(' ')}`.toLowerCase();
      if (!haystack) continue;
      let score = 0;
      for (const token of tokens) if (haystack.includes(token)) score += 1;
      if (score < 2) continue;
      const importance = Number(record.importance) || 50;
      const pinned = record.pinned || record.firstMet ? 0.6 : 0;
      scored.push({ record, score: score + importance / 100 + pinned });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, Math.max(1, limit));
    if (!picked.length) return '';
    const lines = picked.map(({ record }) => {
      const head = record.title || String(record.text || '').slice(0, 24);
      const body = String(record.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return `- ${head}${body && body !== head ? `：${body}` : ''}`;
    });
    return `【相关记忆（从你过去的记忆里找到，供参考，不要逐条复述）】\n${lines.join('\n')}`.slice(0, maxChars);
  }

  return { promptBlock };
}
