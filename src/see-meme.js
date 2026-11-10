/**
 * 看图懂梗（内置版，V1）。
 *
 * 移植自 MIT 插件 astrbot_plugin_fatfish_seememe v0.4.0（作者 Vegra85）：
 *   https://github.com/Vegra85/astrbot_plugin_fatfish_seememe
 * 只取「回话前先看懂图」这一层，不依赖 AstrBot / Python：
 *   · 看图写五样：字 / 画面 / 梗 / 跟你 / 坑
 *   · 谐音词表（字面匹配，取自 upstream puns.py 的 TABLE）
 *   · 认不出的梗查 cnmeme.wiki 公开接口
 *   · 按图片内容哈希缓存，同一张图只花一次看图钱
 *
 * V1 不做：表情包词典、按读音找谐音、转发聊天记录里的图、看机器人的头像。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PUNS = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./see-meme-puns.json', import.meta.url), 'utf8'));
  } catch { return []; }
})();

const SITE = 'cnmeme.wiki';
const API = 'https://cnmeme.wiki/api/v1/public/memes';
const HEAD = '[看图看懂] 下面是系统帮你看过的图 你就当亲眼看到了：';
const HINT_HEAD = '# 这一轮的图（只给这一轮看）';
const CACHE_VERSION = 1;

const NONE_FIELD = /^(无|没|不是|不清楚|看不出|与你无|和你无|跟你无|纯(属)?(搞笑|玩梗|逗)|就是(逗|玩|搞笑))/;
const FIELD = /(梗|跟你|坑)[：:]\s*([^。\n\]]+)/g;
const THINK = /<(think|thinking)>[\s\S]*?<\/\1>/gi;
const REFUSE = /^(抱歉|对不起|很抱歉|不好意思|我(无法|不能|看不到|没法)|无法(查看|识别|看到|处理)|作为(一个)?(AI|人工智能)|I'?m sorry|Sorry|I can(no|'?)t)/i;
const FAKE_MARK = /[\[［【]\s*看图看懂\s*[\]］】]/g;

const clip = (text, n) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : `${s.slice(0, n)}…`;
};

function cleanCaption(raw, maxChars) {
  let text = String(raw ?? '').replace(THINK, '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^(这是|图中是|图片中?是?|画面中?是?)一(张|幅)[^，,。]*?[，,。]/, '').trim();
  // 模型爱写「跟你：没关系」「坑：没有」——这两项没有意义，直接从描述里去掉
  text = text
    .replace(/跟你[：:]\s*(没关系|与你无关|无|没有)[。；]?/g, '')
    .replace(/坑[：:]\s*(没有|没坑|无|没有坑)[。；]?/g, '')
    .replace(/\s+/g, ' ').trim();
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'));
    text = `${(at > maxChars * 0.5 ? cut.slice(0, at) : cut).replace(/[。，；]$/, '')}…`;
  }
  return text.trim();
}

function parseFields(caption) {
  const out = { 梗: [], 跟你: [], 坑: [] };
  for (const m of String(caption ?? '').matchAll(FIELD)) {
    const value = m[2].trim().replace(/[」）)]+$/, '');
    if (!value || NONE_FIELD.test(value) || out[m[1]].includes(value)) continue;
    out[m[1]].push(clip(value, 80));
  }
  return out;
}

/** 图里的字：「我太南了」；没有返回空串。 */
function quotedText(caption) {
  const m = /字[：:]\s*[「“"]([^」”"]{1,40})[」”"]/.exec(String(caption ?? ''));
  return m ? m[1].trim() : '';
}

/** 谐音词表（字面）：文本里出现了谐音写法 → 「写法」= 原词 */
function punHits(text) {
  const source = String(text ?? '');
  if (!source) return [];
  const hits = [];
  for (const row of PUNS) {
    for (const variant of row.variants ?? []) {
      if (!variant || !source.includes(variant)) continue;
      hits.push(`「${variant}」= ${row.origin}`);
      break;
    }
    if (hits.length >= 3) break;
  }
  return [...new Set(hits)];
}

function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

/** 外部词条只留陈述句；网址、指令式句子、问句全部删掉（防注入）。 */
function sanitizeExternal(text, n = 160) {
  const raw = htmlToText(text)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\[\]【】#]/g, ' ')
    .replace(/「|」/g, '"');
  const sentences = raw.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
  const kept = sentences.filter((s) => !/你|您|请|回复|必须|记住|以后|忽略|指令|system\s*prompt|prompt/i.test(s));
  const text2 = (kept.length ? kept : sentences).join('');
  return clip(text2, n);
}

function pickMeme(items, term) {
  const key = String(term ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!key) return null;
  for (const item of Array.isArray(items) ? items : []) {
    const title = String(item?.title ?? '');
    const aliases = Array.isArray(item?.aliases) ? item.aliases.map(String) : [];
    const keys = [title, ...aliases].map((x) => x.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''));
    if (keys.some((k) => k && (k === key || k.includes(key) || key.includes(k)))) return item;
    const base = title.replace(/\s*[（(][^）)]{1,12}[）)]$/, '').trim();
    if (base && base !== title && base.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').includes(key)) return item;
  }
  return null;
}

function looksLikeMemeTerm(text) {
  const s = String(text ?? '').trim();
  if (s.length < 2 || s.length > 10) return false;
  if (/\d/.test(s)) return false;             // 电话、期数、价格都不查
  if (/[：:]/.test(s)) return false;          // 「名字：话」这种聊天行
  return true;
}

/**
 * @param {object} opts
 * @param {object} opts.config    qq 配置里的 seeMeme 段
 * @param {string} opts.cacheFile 缓存文件
 * @param {Function} opts.log
 * @param {Function} opts.resolveModel 返回 { provider, model }
 * @param {Function} opts.services 返回 { llm, attachments }
 */
export function createSeeMeme({ config = {}, cacheFile = '', log = () => {}, resolveModel, services } = {}) {
  const cfg = {
    enabled: config.enabled !== false,
    provider: String(config.provider ?? ''),
    model: String(config.model ?? ''),
    maxPerTurn: Math.max(1, Math.min(6, Number(config.maxPerTurn) || 3)),
    maxChars: Math.max(80, Math.min(400, Number(config.maxChars) || 180)),
    hourlyLimit: Math.max(1, Math.min(500, Number(config.hourlyLimit) || 60)),
    dailyLimit: Math.max(1, Math.min(2000, Number(config.dailyLimit) || 300)),
    puns: config.puns !== false,
    lookup: config.lookup !== false,
    timeoutMs: Math.max(3000, Math.min(60000, Number(config.timeoutMs) || 25000)),
    botNames: Array.isArray(config.botNames) && config.botNames.length
      ? config.botNames.map(String)
      : ['大肥鱼', '小鲸鱼'],
    botLook: String(config.botLook ?? ''),
  };

  let cache = { version: CACHE_VERSION, items: {}, uses: [], memes: {} };
  if (cacheFile) {
    try {
      const loaded = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (loaded && typeof loaded === 'object') {
        cache = {
          version: CACHE_VERSION,
          items: loaded.items && typeof loaded.items === 'object' ? loaded.items : {},
          uses: Array.isArray(loaded.uses) ? loaded.uses.slice(-2000) : [],
          memes: loaded.memes && typeof loaded.memes === 'object' ? loaded.memes : {},
        };
      }
    } catch { /* 首次运行 */ }
  }

  let saveTimer = null;
  function save() {
    if (!cacheFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(cache), { mode: 0o600 });
      } catch (error) { log(`[看图] 缓存写入失败：${error?.message ?? error}`); }
    }, 800);
    saveTimer.unref?.();
  }

  function quotaLeft() {
    const now = Date.now();
    const hour = cache.uses.filter((t) => now - Number(t) < 3600_000).length;
    const day = cache.uses.filter((t) => now - Number(t) < 86400_000).length;
    return hour < cfg.hourlyLimit && day < cfg.dailyLimit;
  }

  function markUse() {
    cache.uses.push(Date.now());
    cache.uses = cache.uses.slice(-2000);
    save();
  }

  function prune() {
    const entries = Object.entries(cache.items);
    if (entries.length <= 600) return;
    entries.sort((a, b) => Number(a[1]?.t ?? 0) - Number(b[1]?.t ?? 0));
    for (const [key] of entries.slice(0, entries.length - 600)) delete cache.items[key];
  }

  function buildPrompt({ index, total, said, sender, kind }) {
    const names = cfg.botNames.join('、');
    const lines = [];
    lines.push(`这是群聊里「${sender || '有人'}」发的一张${kind || '图'}`);
    lines.push(`看图的是聊天机器人「${names}」${cfg.botLook ? `，它长这样：${cfg.botLook}` : ''}。`);
    if (cfg.botLook) {
      lines.push('图里画的是它本人（Q 版、群友给它画的图）、或者图里写着它的名字 / 外号，就是在说它；'
        + '认长相至少对上两样明显特征才算，只对上一样不算。');
    }
    if (total > 1) lines.push(`这条消息一共有 ${total} 张图，现在看的是第 ${index} 张。`);
    const saidText = clip(String(said ?? '').replace(/\s+/g, ' '), 80);
    if (saidText) lines.push(`发图的时候还说了：「${saidText}」`);
    lines.push('用中文写一段话，让看不到图的机器人也能接话。按这个顺序：');
    lines.push('字：图里的文字原样抄（没有就不写这项；动图拼图的帧号、「AI生成」水印不算字）');
    lines.push('画面：有什么、谁在干什么（只写要紧的：动作、表情、姿势、场景）');
    lines.push('梗：这是什么梗 / 出处 / 在玩什么（影视截图、历史事件、网络模板都点名说清；认不出就写「看不出出处」，别编）');
    lines.push('跟你：图里画的就是它本人，或者图里的字明着说 AI、token、机器人、它的名字 才写；没关系就整项不写');
    lines.push('坑：有擦边、挖坑、钓鱼、等它上当的地方才写；没有就整项不写，别写「坑：没有」');
    lines.push(`格式：字：「…」。画面：…。梗：…。跟你：…。坑：…。总共不超过 ${cfg.maxChars} 字。`);
    return lines.join('\n');
  }

  async function vision({ part, index, total, said, sender, kind }) {
    const runtime = services?.() ?? {};
    const { llm, attachments } = runtime;
    if (!llm?.stream || !attachments?.saveImages) throw new Error('DSH 模型/附件服务未就绪');
    const selected = (() => {
      if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
      try { return resolveModel?.() ?? null; } catch { return null; }
    })();
    if (!selected?.provider || !selected?.model) throw new Error('没有可用的看图模型');
    const refs = await attachments.saveImages([{
      data: Buffer.from(String(part.data ?? ''), 'base64'),
      mediaType: part.mediaType || 'image/jpeg',
    }]);
    if (!Array.isArray(refs) || !refs[0]?.attachmentId) throw new Error('DSH 没能保存图片');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    timer.unref?.();
    let text = '';
    try {
      for await (const chunk of llm.stream({
        provider: selected.provider,
        model: selected.model,
        maxTokens: 500,
        sessionId: 'see-meme',
        signal: controller.signal,
        messages: [{
          id: `see-${Date.now()}-${index}`,
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt({ index, total, said, sender, kind }) },
            { type: 'image', attachment: refs[0] },
          ],
        }],
      })) {
        if (chunk?.type === 'text-delta') text += chunk.text;
        else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && !text) text += chunk.block.text;
      }
    } finally { clearTimeout(timer); }
    return String(text ?? '').trim();
  }

  async function lookupMeme(term) {
    if (!cfg.lookup || !looksLikeMemeTerm(term)) return '';
    const key = String(term).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 40);
    if (!key) return '';
    const hit = cache.memes[key];
    const now = Date.now();
    if (hit && hit.text && now - Number(hit.t ?? 0) < 30 * 86400_000) return hit.text;
    if (hit && !hit.text && now - Number(hit.t ?? 0) < 2 * 3600_000) return '';
    let text = '';
    try {
      const res = await fetch(`${API}?q=${encodeURIComponent(term.slice(0, 80))}&limit=5`, {
        signal: AbortSignal.timeout(4500),
        headers: { accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        const pick = pickMeme(data?.items, term);
        if (pick) {
          let detail = pick;
          try {
            const slug = encodeURIComponent(String(pick.slug || pick.title || ''));
            const res2 = await fetch(`${API}/${slug}`, { signal: AbortSignal.timeout(4500), headers: { accept: 'application/json' } });
            if (res2.ok) {
              const d2 = await res2.json();
              if (d2?.item) detail = d2.item;
            }
          } catch { /* 正文拿不到就用摘要 */ }
          const body = sanitizeExternal(detail?.content_html || detail?.summary || '');
          if (body) text = `- 「${term}」可能是这个梗：${body}（来源：${SITE} · 自动查询，可能不准）`;
        }
      }
    } catch { /* 站点挂了就跳过 */ }
    cache.memes[key] = { text, t: now };
    const keys = Object.keys(cache.memes);
    if (keys.length > 500) delete cache.memes[keys[0]];
    save();
    return text;
  }

  function captionLine(sender, caption, index, total) {
    const label = total > 1 ? ` ${total} 张图里第 ${index} 张` : '图';
    return `- 「${sender || '有人'}」发的${label}：${caption}`;
  }

  async function analyzeTurn({ imageParts = [], saidText = '', sender = '', kind = '', chat = [] } = {}) {
    if (!cfg.enabled) return '';
    const images = (Array.isArray(imageParts) ? imageParts : [])
      .filter((part) => part && part.type === 'image' && part.data)
      .slice(0, cfg.maxPerTurn);
    if (!images.length) return '';
    if (chat?.length) saidText += `\n（前面在聊：${chat.slice(-3).map((x) => clip(x, 40)).join(' / ')}）`;

    const captions = [];
    for (let i = 0; i < images.length; i += 1) {
      const part = images[i];
      const key = crypto.createHash('sha1').update(String(part.data)).digest('hex');
      const cached = cache.items[key];
      if (cached?.cap) {
        cached.t = Date.now();
        captions.push(cached.cap);
        continue;
      }
      if (!quotaLeft()) { log('[看图] 超过每小时/每天上限，这一轮跳过'); break; }
      markUse();
      try {
        const raw = await vision({ part, index: i + 1, total: images.length, said: saidText, sender, kind });
        if (REFUSE.test(raw) && !/画面：/.test(raw)) throw new Error('看图模型拒绝/看不到图');
        const caption = cleanCaption(raw, cfg.maxChars);
        if (!caption) throw new Error('看图结果为空');
        cache.items[key] = { cap: caption, t: Date.now() };
        prune();
        save();
        captions.push(caption);
      } catch (error) {
        log(`[看图] 第 ${i + 1} 张没看成：${String(error?.message ?? error).slice(0, 140)}`);
      }
    }
    if (!captions.length) return '';

    const lines = [HEAD];
    captions.forEach((caption, index) => lines.push(captionLine(sender, caption, index + 1, captions.length)));

    const fields = captions.map(parseFields);
    const hints = [HINT_HEAD, '- 图本身大家都看得到（就发在聊天里）'];
    const meme = fields.flatMap((f) => f['梗']).find(Boolean);
    if (meme) hints.push(`- 梗点：${meme}`);
    const self = fields.flatMap((f) => f['跟你']).find(Boolean);
    if (self) hints.push(`- 图在说你（${self}）：说的是你，不是别人`);
    const trap = fields.flatMap((f) => f['坑']).find(Boolean);
    if (trap) hints.push(`- 图里有坑（${trap}）：是擦边的话，露骨的话不能说`);

    if (cfg.puns) {
      const hits = punHits(`${captions.join(' ')} ${clip(saidText, 400)}`);
      if (hits.length) hints.push(`- 谐音（本地词表查的，只是可能）：${hits.join('；')}`);
    }
    if (cfg.lookup) {
      const unknown = !meme || /看不出|不确定|不知道/.test(meme);
      const imageText = quotedText(captions[0]);
      if (unknown && imageText) {
        const fact = await lookupMeme(imageText);
        if (fact) hints.push(fact);
      }
    }
    return `${lines.join('\n')}\n\n${hints.join('\n')}`;
  }

  return { analyzeTurn };
}
