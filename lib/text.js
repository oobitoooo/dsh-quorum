// dsh-quorum / text.js —— 纯文本工具：分词、覆盖度、截断、JSON 抽取、稳定哈希
// 全部零依赖、确定性：同样的输入永远得到同样的分数，便于回归测试。

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const LATIN_WORD = /[a-zA-Z][a-zA-Z0-9_+#.-]*/g;
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;

const STOP_WORDS = new Set([
  '的', '了', '和', '与', '就', '都', '而', '及', '或', '把', '被', '让', '在', '是', '有', '不',
  '我们', '你们', '他们', '这个', '那个', '一个', '可以', '需要', '应该', '进行', '通过', '对于',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'we', 'you', 'it', 'that', 'this',
]);

/** 中文按二元组切，英文按词切；去停用词与单字噪音。 */
export function tokens(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  for (const m of s.matchAll(LATIN_WORD)) {
    if (!STOP_WORDS.has(m[0]) && m[0].length > 1) out.push(m[0]);
  }
  for (const m of s.matchAll(CJK_RUN)) {
    const run = m[0];
    if (run.length === 1) {
      if (!STOP_WORDS.has(run)) out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const bigram = run.slice(i, i + 2);
      if (!STOP_WORDS.has(bigram)) out.push(bigram);
    }
  }
  return out;
}

/** 发言的词有多少比例落在参照文本里（衡量相关性/跑题）。 */
export function coverage(statement, reference) {
  const a = new Set(tokens(statement));
  const b = new Set(tokens(reference));
  if (a.size === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit += 1;
  return hit / a.size;
}

/** 关键词表命中计数。 */
export function countMatches(text, patterns) {
  let n = 0;
  for (const re of patterns) {
    const m = String(text ?? '').match(re);
    if (m) n += m.length;
  }
  return n;
}

/** 命中即计 1 的关键词表。 */
export function hitsAny(text, patterns) {
  const s = String(text ?? '');
  return patterns.reduce((n, re) => (re.test(s) ? n + 1 : n), 0);
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value, digits = 2) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

/** 按字符数硬截断，保留语义尾巴。 */
export function truncate(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** 压成单行，用于报告里的短引用。 */
export function oneLine(text, maxChars) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[`*_>#|]/g, '')
    .trim();
  return truncate(s, maxChars);
}

/**
 * 从模型输出里抠第一个合法 JSON（对象或数组）。
 * 模型爱加 ```json 围栏、爱加前言，这里全部剥掉；解析不了返回 undefined。
 */
export function extractJson(raw) {
  const s = String(raw ?? '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(s);

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct !== undefined) return direct;
    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i];
      if (ch !== '{' && ch !== '[') continue;
      const end = scanBalanced(candidate, i);
      if (end < 0) continue;
      const parsed = tryParse(candidate.slice(i, end + 1));
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function tryParse(s) {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

/** 从 start 处的 { 或 [ 开始，返回匹配闭合符号的下标；不完整返回 -1。 */
function scanBalanced(s, start) {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 稳定哈希（FNV-1a 32bit），用于 mock 的可复现剧本。 */
export function stableHash(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 确定性伪随机序列（xorshift32）。 */
export function makeRng(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** 估算 token：中日韩字符按 1，其余按 4 字符 1 token。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk += 1;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}
