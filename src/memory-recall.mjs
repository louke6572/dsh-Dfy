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

  /** 当前消息 → 相关记忆块；没有相关记录返回空串。 */
  function promptBlock(text, { limit = 3, maxChars = 520 } = {}) {
    const tokens = tokensOf(text);
    if (!tokens.length) return '';
    const scored = [];
    for (const record of records()) {
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
