import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { fuzzyMatch } from "@earendil-works/pi-tui";

// 本模块移植 pi 1.5.0 原生会话选择器的查询语义
// （dist/modes/interactive/components/session-selector-search.js），
// 使 /history 的模糊、精确短语与正则搜索行为与原生 /resume 保持一致。
//
// 1.5.0 起原生 /resume 改了两个关键点，1.1.0 的旧语义会误匹配：
// 1. id 与消息正文只做精确子串匹配，只有名称和 cwd 参与模糊匹配。
//    以前 /resume 搜 "1024" 会命中 UUID 里散落的 1、0、2、4。
// 2. 每个字段单独匹配，token 不会跨字段边界拼凑命中。
// 匹配分三层，层级差距远大于层内分数差，所以任何精确命中都排在模糊命中之前。

export type SortMode = "threaded" | "recent" | "relevance";
export type NameFilter = "all" | "named";

export interface SearchToken {
  kind: "fuzzy" | "phrase";
  value: string;
}

export interface ParsedSearchQuery {
  mode: "tokens" | "regex";
  tokens: SearchToken[];
  regex: RegExp | null;
  /** 解析失败时设置；此时查询不匹配任何会话。 */
  error?: string;
}

export interface MatchResult {
  matches: boolean;
  /** 仅在 matches 为 true 时有意义；数值越小表示越相关。 */
  score: number;
}

function normalizeWhitespaceLower(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** 匹配层级，数值越小越好：名称命中 → 文本精确命中 → 名称/cwd 模糊命中。 */
const TIER_NAME = 0;
const TIER_TEXT = 1;
const TIER_FUZZY = 2;
/** 层级权重：远大于层内任何分数，保证跨层时顺序由层级决定。 */
const TIER_WEIGHT = 1_000_000;

interface CachedMessageText {
  /** 缓存对应的原文；allMessagesText 变化时缓存失效。 */
  source: string;
  lower: string;
  normalized?: string;
}

/**
 * 小写后的消息正文缓存。
 * allMessagesText 可能有几 MB，每次按键重新 toLowerCase 会明显拖慢输入。
 */
const messageTextCache = new WeakMap<SessionInfo, CachedMessageText>();

function getMessageText(session: SessionInfo): CachedMessageText {
  let cached = messageTextCache.get(session);
  if (!cached || cached.source !== session.allMessagesText) {
    cached = { source: session.allMessagesText, lower: session.allMessagesText.toLowerCase() };
    messageTextCache.set(session, cached);
  }
  return cached;
}

function getNormalizedMessageText(session: SessionInfo): string {
  const cached = getMessageText(session);
  cached.normalized ??= normalizeWhitespaceLower(cached.lower);
  return cached.normalized;
}

function tierScore(tier: number, score = 0): number {
  return tier * TIER_WEIGHT + score;
}

/**
 * 精确（大小写不敏感）子串命中。
 * 返回分数时带上命中位置，让相关性排序仍能区分“开头的命中”和“文末的命中”。
 * 名称与 cwd 之外，id 和消息正文只走这一条路径：散落的字母是噪音，不算命中。
 */
function matchLiteralToken(session: SessionInfo, value: string): number | undefined {
  const name = session.name?.toLowerCase() ?? "";
  const nameIndex = name.indexOf(value);
  if (nameIndex >= 0) return tierScore(TIER_NAME, nameIndex * 0.1);

  const idIndex = session.id.toLowerCase().indexOf(value);
  if (idIndex >= 0) return tierScore(TIER_TEXT, idIndex * 0.1);

  const messageIndex = getMessageText(session).lower.indexOf(value);
  if (messageIndex >= 0) return tierScore(TIER_TEXT, messageIndex * 0.1);

  const cwdIndex = session.cwd.toLowerCase().indexOf(value);
  if (cwdIndex >= 0) return tierScore(TIER_TEXT, cwdIndex * 0.1);

  return undefined;
}

/** 普通 token：先试精确子串，落在名称或 cwd 里才退到模糊匹配。 */
function matchFuzzyToken(session: SessionInfo, value: string): number | undefined {
  const literal = matchLiteralToken(session, value.toLowerCase());
  if (literal !== undefined) return literal;

  let best: number | undefined;
  for (const field of [session.name ?? "", session.cwd]) {
    const result = fuzzyMatch(value, field);
    if (result.matches && (best === undefined || result.score < best)) best = result.score;
  }
  return best === undefined ? undefined : tierScore(TIER_FUZZY, best);
}

/** 引号短语：两端都折叠空白后按原样子串匹配，不做逐字符模糊。 */
function matchPhraseToken(session: SessionInfo, phrase: string): number | undefined {
  const nameIndex = normalizeWhitespaceLower(session.name ?? "").indexOf(phrase);
  if (nameIndex >= 0) return tierScore(TIER_NAME, nameIndex * 0.1);

  const idIndex = session.id.toLowerCase().indexOf(phrase);
  if (idIndex >= 0) return tierScore(TIER_TEXT, idIndex * 0.1);

  const messageIndex = getNormalizedMessageText(session).indexOf(phrase);
  if (messageIndex >= 0) return tierScore(TIER_TEXT, messageIndex * 0.1);

  const cwdIndex = normalizeWhitespaceLower(session.cwd).indexOf(phrase);
  if (cwdIndex >= 0) return tierScore(TIER_TEXT, cwdIndex * 0.1);

  return undefined;
}

/** 正则逐字段测试：拼接后再 search 会让模式跨字段命中。 */
function matchRegex(session: SessionInfo, regex: RegExp): number | undefined {
  if (session.name) {
    const match = regex.exec(session.name);
    if (match) return tierScore(TIER_NAME, match.index * 0.1);
  }
  for (const text of [session.id, session.allMessagesText, session.cwd]) {
    const match = regex.exec(text);
    if (match) return tierScore(TIER_TEXT, match.index * 0.1);
  }
  return undefined;
}

export function hasSessionName(session: SessionInfo): boolean {
  return Boolean(session.name?.trim());
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const trimmed = query.trim();
  if (!trimmed) {
    return { mode: "tokens", tokens: [], regex: null };
  }

  // 正则模式：re:<pattern>，大小写不敏感。
  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3).trim();
    if (!pattern) {
      return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
    }
    try {
      return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { mode: "regex", tokens: [], regex: null, error: message };
    }
  }

  // 分词模式支持引号短语，例如 foo "node cve" bar。
  const tokens: SearchToken[] = [];
  let buffer = "";
  let inQuote = false;
  let hadUnclosedQuote = false;
  const flush = (kind: SearchToken["kind"]) => {
    const value = buffer.trim();
    buffer = "";
    if (!value) return;
    tokens.push({ kind, value });
  };
  for (const ch of trimmed) {
    if (ch === '"') {
      if (inQuote) {
        flush("phrase");
        inQuote = false;
      } else {
        flush("fuzzy");
        inQuote = true;
      }
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      flush("fuzzy");
      continue;
    }
    buffer += ch;
  }
  if (inQuote) hadUnclosedQuote = true;

  // 引号不配对时退回普通空白分词，避免把整段查询当作短语。
  if (hadUnclosedQuote) {
    return {
      mode: "tokens",
      tokens: trimmed
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0)
        .map((value) => ({ kind: "fuzzy" as const, value })),
      regex: null,
    };
  }

  flush(inQuote ? "phrase" : "fuzzy");
  return { mode: "tokens", tokens, regex: null };
}

export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult {
  if (parsed.mode === "regex") {
    if (!parsed.regex) return { matches: false, score: 0 };
    const score = matchRegex(session, parsed.regex);
    return score === undefined ? { matches: false, score: 0 } : { matches: true, score };
  }

  if (parsed.tokens.length === 0) {
    return { matches: true, score: 0 };
  }

  let totalScore = 0;
  for (const token of parsed.tokens) {
    let score: number | undefined;
    if (token.kind === "phrase") {
      const phrase = normalizeWhitespaceLower(token.value);
      if (!phrase) continue;
      score = matchPhraseToken(session, phrase);
    } else {
      score = matchFuzzyToken(session, token.value);
    }
    if (score === undefined) return { matches: false, score: 0 };
    totalScore += score;
  }
  return { matches: true, score: totalScore };
}

/**
 * 按查询与排序模式过滤会话。
 *
 * - recent：只过滤，保持传入顺序（调用方已按活动时间降序提供）。
 * - threaded / relevance：有查询时按相关性升序，分数相同按活动时间降序。
 *   threaded 的树形展示由调用方在无查询时另行处理。
 */
export function filterAndSortSessions(
  sessions: readonly SessionInfo[],
  query: string,
  sortMode: SortMode,
): SessionInfo[] {
  const trimmed = query.trim();
  if (!trimmed) return [...sessions];

  const parsed = parseSearchQuery(query);
  if (parsed.error) return [];

  if (sortMode === "recent") {
    const filtered: SessionInfo[] = [];
    for (const session of sessions) {
      if (matchSession(session, parsed).matches) filtered.push(session);
    }
    return filtered;
  }

  const scored: { session: SessionInfo; score: number }[] = [];
  for (const session of sessions) {
    const result = matchSession(session, parsed);
    if (!result.matches) continue;
    scored.push({ session, score: result.score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return b.session.modified.getTime() - a.session.modified.getTime();
  });
  return scored.map((entry) => entry.session);
}
