import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { fuzzyMatch } from "@earendil-works/pi-tui";

// 本模块移植 pi 1.1.0 原生会话选择器的查询语义
// （dist/modes/interactive/components/session-selector-search.js），
// 使 /history 的模糊、精确短语与正则搜索行为与原生 /resume 保持一致。

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

// 匹配范围与原生一致：会话 id、名称、全部 user/assistant 正文及工作目录。
// model、provider 等元信息不属于搜索字段。
function getSessionSearchText(session: SessionInfo): string {
  return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
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
  const text = getSessionSearchText(session);

  if (parsed.mode === "regex") {
    if (!parsed.regex) return { matches: false, score: 0 };
    const index = text.search(parsed.regex);
    if (index < 0) return { matches: false, score: 0 };
    // 匹配位置越靠前越相关。
    return { matches: true, score: index * 0.1 };
  }

  if (parsed.tokens.length === 0) {
    return { matches: true, score: 0 };
  }

  let totalScore = 0;
  let normalizedText: string | null = null;
  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      if (normalizedText === null) normalizedText = normalizeWhitespaceLower(text);
      const phrase = normalizeWhitespaceLower(token.value);
      if (!phrase) continue;
      const index = normalizedText.indexOf(phrase);
      if (index < 0) return { matches: false, score: 0 };
      totalScore += index * 0.1;
      continue;
    }
    const result = fuzzyMatch(token.value, text);
    if (!result.matches) return { matches: false, score: 0 };
    totalScore += result.score;
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
