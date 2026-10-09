import { homedir } from "node:os";
import {
  SessionManager,
  type ExtensionAPI,
  type KeybindingsManager,
  type SessionInfo,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type Keybinding,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  filterAndSortSessions,
  hasSessionName,
  type NameFilter,
  type SortMode,
} from "./search.ts";
import {
  buildSessionRows,
  buildTreePrefix,
  canonicalizePath,
  type SessionTreeNode,
} from "./session-tree.ts";
import { readSessionStats, type SessionStats } from "./session-stats.ts";

/** 会话范围：当前工作目录，或 pi 存储内的全部会话。 */
type Scope = "current" | "all";

/** 与 pi 公开 SessionManager.list/listAll 的进度回调签名一致。 */
type SessionListProgress = (
  loaded: number,
  total: number,
  partialSessions?: readonly SessionInfo[],
) => void;

/** 单个范围（当前目录/全部）的缓存与进行中的读取。 */
interface ScopeState {
  sessions: SessionInfo[] | null;
  load: AbortController | null;
}

/** 单条会话增强信息的加载状态；未就绪时渲染加载态，不伪造 0、unknown 或无消息。 */
type StatsState =
  | { status: "loading" }
  | { status: "failed" }
  | ({ status: "ready" } & SessionStats);

/** 并发读取增强信息的条数上限；关闭选择器时会中止全部读取。 */
const MAX_CONCURRENT_STATS_READS = 4;

interface HistorySelectorOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  cwd: string;
  sessionDir: string;
  /** 使用默认 session 目录时，全部范围扫描 pi 的整个 sessions 根目录。 */
  usesDefaultSessionDir: boolean;
  currentSessionFile: string | undefined;
  done: (result: string | undefined) => void;
}

export default function history(pi: ExtensionAPI): void {
  let cancelOpen: (() => void) | undefined;
  pi.on("session_shutdown", () => {
    cancelOpen?.();
  });
  pi.registerCommand("history", {
    description: "Browse and resume saved sessions in the current folder",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        if (ctx.hasUI) {
          ctx.ui.notify("History is only available in interactive terminal mode.", "warning");
        }
        return;
      }
      cancelOpen?.();
      const cwd = ctx.cwd;
      const sessionDir = ctx.sessionManager.getSessionDir();
      // 只读类型未暴露 usesDefaultSessionDir；运行时对象是完整的 SessionManager。
      // 取不到时按自定义目录处理，避免误扫其它项目的会话。
      const usesDefaultSessionDir =
        (ctx.sessionManager as { usesDefaultSessionDir?(): boolean }).usesDefaultSessionDir?.() ?? false;
      const currentSessionFile = ctx.sessionManager.getSessionFile();
      let selector: HistorySelector | undefined;
      const cancel = () => selector?.cancel();
      cancelOpen = cancel;
      const target = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
        selector = new HistorySelector({
          tui,
          theme,
          keybindings,
          cwd,
          sessionDir,
          usesDefaultSessionDir,
          currentSessionFile,
          done,
        });
        return selector;
      }, { overlay: false });
      if (cancelOpen === cancel) cancelOpen = undefined;
      selector = undefined;
      if (target === undefined) return;
      const result = await ctx.switchSession(target);
      // 成功切换会使旧上下文失效；只有取消时仍可向原会话反馈。
      if (result.cancelled) ctx.ui.notify("Session switch cancelled.", "info");
    },
  });
}

/**
 * 增强会话选择器：搜索、范围切换、排序、已命名筛选与路径显示均按
 * pi 1.1.0 原生选择器语义工作，并在选中后请求宿主恢复目标会话。
 */
class HistorySelector implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly cwd: string;
  private readonly sessionDir: string;
  private readonly usesDefaultSessionDir: boolean;
  private readonly currentSessionCanonicalPath: string | undefined;
  private readonly onDone: (result: string | undefined) => void;
  private readonly searchInput = new Input();

  private scope: Scope = "current";
  private sortMode: SortMode = "threaded";
  private nameFilter: NameFilter = "all";
  private showPath = false;
  private closed = false;
  private loading = false;
  private failed = false;
  private progress: { loaded: number; total: number } | null = null;
  private readonly scopeStates: Record<Scope, ScopeState> = {
    current: { sessions: null, load: null },
    all: { sessions: null, load: null },
  };
  private visibleSessions: readonly SessionInfo[] = [];
  private nodes: SessionTreeNode[] = [];
  private selected = 0;
  private selectionTouched = false;
  private scrollTop = 0;
  private viewportHeight = 1;
  private pageRows = 1;
  private searchFocused = false;
  private readonly stats = new Map<string, StatsState>();
  private readonly statsQueue: string[] = [];
  private activeStatsReads = 0;
  private readonly statsAbort = new AbortController();

  constructor(options: HistorySelectorOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.cwd = options.cwd;
    this.sessionDir = options.sessionDir;
    this.usesDefaultSessionDir = options.usesDefaultSessionDir;
    this.currentSessionCanonicalPath = canonicalizePath(options.currentSessionFile);
    this.onDone = options.done;
    void this.loadScope("current");
  }

  // 宿主的 TUI 会把焦点落在该组件上；搜索框以此决定是否显示光标。
  get focused(): boolean {
    return this.searchFocused;
  }

  set focused(value: boolean) {
    this.searchFocused = value;
    this.searchInput.focused = value;
  }

  /** 供扩展在 session_shutdown 等场景下结束交互。 */
  cancel(): void {
    this.finish();
  }

  dispose(): void {
    this.finish();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    // 与原生选择器一致的行顺序：分隔横线、标题与状态、两行提示、空行、
    // 搜索框、空行、列表、空行、分隔横线。按可用高度取舍装饰行，高度不足时先让位给列表。
    const showHeader = height >= 5;
    const showHint1 = height >= 8;
    const showHint2 = height >= 9;
    const showSearch = height >= 7;
    // 搜索框上下空行，以及内容与下方提示之间的空行。
    const showGaps = height >= 11;
    // 与原生一致，上方与下方各一条 accent 色分隔横线。
    const showBorders = height >= 13;
    const fixedLines = (showHeader ? 1 : 0) + (showHint1 ? 1 : 0) + (showHint2 ? 1 : 0)
      + (showSearch ? 1 : 0) + (showGaps ? 3 : 0) + (showBorders ? 2 : 0);
    const listBudget = Math.max(1, height - fixedLines - 1);
    const preferredVisible = Math.max(5, Math.floor(height / 2));
    this.viewportHeight = Math.max(1, Math.min(preferredVisible, listBudget));

    const lines: string[] = [];
    if (showBorders) lines.push(this.renderBorder(width));
    if (showHeader) lines.push(this.renderHeader(width));
    if (showHint1) lines.push(truncateToWidth(this.hintLine1(), width, "…"));
    if (showHint2) lines.push(truncateToWidth(this.hintLine2(), width, "…"));
    if (showGaps) lines.push("");
    if (showSearch) {
      for (const line of this.searchInput.render(width)) {
        lines.push(truncateToWidth(line, width, ""));
      }
    }
    if (showGaps) lines.push("");

    const rows = this.nodes.map((node, index) => this.renderNode(node, index, width));
    if (!rows.length) {
      lines.push(this.theme.fg(this.failed ? "error" : "muted", this.emptyMessage()));
      if (showGaps) lines.push("");
      if (showBorders) lines.push(this.renderBorder(width));
      return lines.map((line) => truncateToWidth(line, width, ""));
    }
    // 双行（及后续变高）条目按终端可用行数滚动，选中项必须完整可见。
    const rowHeights = rows.map((row) => row.length);
    const totalLines = rowHeights.reduce((sum, rowHeight) => sum + rowHeight, 0);
    const scrollable = totalLines > this.viewportHeight && this.viewportHeight >= 2;
    const budget = scrollable ? this.viewportHeight - 1 : this.viewportHeight;
    const range = visibleRows(rowHeights, this.selected, budget);
    this.pageRows = Math.max(1, range.end - range.start);
    this.scrollTop = range.start;
    let rendered = 0;
    for (let index = range.start; index < range.end && rendered < budget; index++) {
      for (const line of rows[index]) {
        if (rendered >= budget) break;
        lines.push(line);
        rendered++;
      }
    }
    if (scrollable) {
      lines.push(this.theme.fg("muted", `  (${this.selected + 1}/${this.nodes.length})`));
    }
    // 与下方的状态栏等内容留出一个空行，再加与原生一致的分隔横线。
    if (showGaps) lines.push("");
    if (showBorders) lines.push(this.renderBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const kb = this.keybindings;
    // 先匹配开关类动作，避免原生快捷键（可能是不带修饰的字符）被搜索框吞掉。
    if (kb.matches(data, "tui.input.tab")) {
      this.toggleScope();
      return;
    }
    if (kb.matches(data, "app.session.toggleSort")) {
      this.toggleSortMode();
      return;
    }
    if (kb.matches(data, "app.session.toggleNamedFilter")) {
      this.toggleNameFilter();
      return;
    }
    if (kb.matches(data, "app.session.togglePath")) {
      this.togglePath();
      return;
    }
    // 与原生一致：任何未被开关动作消费的按键都表示用户已与列表交互，
    // 后续数据更新按会话身份保留选择，而不是重置为第一项。
    this.selectionTouched = true;
    if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (kb.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-this.pageRows);
      return;
    }
    if (kb.matches(data, "tui.select.pageDown")) {
      this.moveSelection(this.pageRows);
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.confirmSelection();
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.finish();
      return;
    }
    this.searchInput.handleInput(data);
    this.refreshFilter();
    this.tui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // 加载
  // ---------------------------------------------------------------------------

  /**
   * 按原生规则加载指定范围：当前目录使用 SessionManager.list，
   * 全部范围在默认存储下扫描 sessions 根目录，自定义目录下扫描该目录。
   */
  private async loadScope(scope: Scope): Promise<void> {
    if (this.closed) return;
    const state = this.scopeStates[scope];
    if (state.load) return;
    const controller = new AbortController();
    state.load = controller;

    if (scope === this.scope) {
      this.loading = true;
      this.failed = false;
      this.progress = null;
      this.tui.requestRender();
    }
    const isActive = () => !this.closed && state.load === controller;
    const onProgress: SessionListProgress = (loaded, total, partial) => {
      if (!isActive()) return;
      if (partial) {
        state.sessions = [...partial];
        if (scope === this.scope) this.setSessions(state.sessions);
      }
      if (scope !== this.scope) return;
      this.progress = { loaded, total };
      this.tui.requestRender();
    };

    try {
      const sessions = scope === "current"
        ? await SessionManager.list(this.cwd, this.sessionDir, onProgress, controller.signal)
        : this.usesDefaultSessionDir
          ? await SessionManager.listAll(onProgress, controller.signal)
          : await SessionManager.listAll(this.sessionDir, onProgress, controller.signal);
      if (!isActive()) return;
      state.sessions = sessions;
      state.load = null;
      if (scope !== this.scope) return;
      this.loading = false;
      this.failed = false;
      this.setSessions(sessions);
    } catch {
      if (!isActive()) return;
      state.sessions = null;
      state.load = null;
      if (scope !== this.scope) return;
      this.loading = false;
      this.failed = true;
      this.setSessions([]);
    }
  }

  private toggleScope(): void {
    this.scope = this.scope === "current" ? "all" : "current";
    const state = this.scopeStates[this.scope];
    this.loading = state.load !== null;
    this.failed = false;
    this.progress = null;
    this.setSessions(state.sessions ?? []);
    // 缓存为空且没有进行中的加载时才发起请求，避免重复读取。
    if (state.sessions === null && !this.loading) void this.loadScope(this.scope);
  }

  // ---------------------------------------------------------------------------
  // 增强信息（消息数与最后回复模型）
  // ---------------------------------------------------------------------------

  /** 为尚未读取的会话排队，每条只请求一次；列表渐进更新时同样适用。 */
  private requestStats(sessions: readonly SessionInfo[]): void {
    if (this.closed) return;
    for (const session of sessions) {
      if (this.stats.has(session.path)) continue;
      this.stats.set(session.path, { status: "loading" });
      this.statsQueue.push(session.path);
    }
    this.pumpStats();
  }

  /** 以有限并发读取排队中的会话；关闭选择器后不再补位。 */
  private pumpStats(): void {
    while (!this.closed && this.activeStatsReads < MAX_CONCURRENT_STATS_READS && this.statsQueue.length > 0) {
      const path = this.statsQueue.shift() as string;
      this.activeStatsReads++;
      void readSessionStats(path, this.statsAbort.signal).then(
        (result) => this.applyStats(path, { status: "ready", ...result }),
        () => this.applyStats(path, { status: "failed" }),
      );
    }
  }

  /** 单条读取完成：只更新该条并继续排队；已关闭的界面不再接收迟到结果。 */
  private applyStats(path: string, state: StatsState): void {
    this.activeStatsReads--;
    if (this.closed) return;
    this.stats.set(path, state);
    this.tui.requestRender();
    this.pumpStats();
  }

  // ---------------------------------------------------------------------------
  // 过滤与选择
  // ---------------------------------------------------------------------------

  /** 提交当前范围的数据到列表，并按原生规则保持用户的选择。 */
  private setSessions(sessions: readonly SessionInfo[]): void {
    const selectedPath = this.selectionTouched ? this.selectedPath() : undefined;
    this.visibleSessions = [...sessions];
    this.requestStats(this.visibleSessions);
    this.refreshFilter();
    if (!this.selectionTouched) {
      this.selected = 0;
    } else if (selectedPath) {
      const index = this.nodes.findIndex((node) => node.session.path === selectedPath);
      if (index >= 0) this.selected = index;
    }
    this.tui.requestRender();
  }

  /** 按查询、排序与已命名筛选重新计算可见列表；无搜索的线程模式展示层级。 */
  private refreshFilter(): void {
    const query = this.searchInput.getValue();
    const nameFiltered = this.nameFilter === "all"
      ? this.visibleSessions
      : this.visibleSessions.filter((session) => hasSessionName(session));
    if (this.sortMode === "threaded" && !query.trim()) {
      this.nodes = buildSessionRows(nameFiltered);
    } else {
      this.nodes = filterAndSortSessions(nameFiltered, query, this.sortMode).map((session) => ({
        session,
        depth: 0,
        isLast: true,
        ancestorContinues: [],
      }));
    }
    this.selected = Math.max(0, Math.min(this.selected, this.nodes.length - 1));
  }

  private selectedPath(): string | undefined {
    return this.nodes[this.selected]?.session.path;
  }

  private moveSelection(delta: number): void {
    this.selected = Math.max(0, Math.min(this.nodes.length - 1, this.selected + delta));
    this.tui.requestRender();
  }

  private confirmSelection(): void {
    const target = this.selectedPath();
    if (target === undefined) return;
    this.finish(target);
  }

  private toggleSortMode(): void {
    // 与原生一致：threaded → recent → relevance → threaded。
    this.sortMode = this.sortMode === "threaded"
      ? "recent"
      : this.sortMode === "recent"
        ? "relevance"
        : "threaded";
    this.refreshFilter();
    this.tui.requestRender();
  }

  private toggleNameFilter(): void {
    this.nameFilter = this.nameFilter === "all" ? "named" : "all";
    this.refreshFilter();
    this.tui.requestRender();
  }

  private togglePath(): void {
    this.showPath = !this.showPath;
    this.tui.requestRender();
  }

  private finish(result?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.statsAbort.abort();
    for (const state of Object.values(this.scopeStates)) {
      state.load?.abort();
      state.load = null;
    }
    this.onDone(result);
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  private renderHeader(width: number): string {
    const title = this.scope === "all" ? "History (All)" : "History (Current Folder)";
    const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
    // 与原生一致：左侧标题，右侧范围/名称/排序状态。
    const rightText = [
      this.scopeStatus(),
      this.theme.fg("muted", "Name: ") + this.theme.fg("accent", this.nameFilter === "all" ? "All" : "Named"),
      this.theme.fg("muted", "Sort: ") + this.theme.fg("accent", sortLabel),
    ].join("  ");
    const truncatedRight = truncateToWidth(rightText, width, "");
    const availableLeft = Math.max(0, width - visibleWidth(truncatedRight) - 1);
    const truncatedLeft = truncateToWidth(this.theme.bold(title), availableLeft, "…");
    const spacing = Math.max(0, width - visibleWidth(truncatedLeft) - visibleWidth(truncatedRight));
    return truncatedLeft + " ".repeat(spacing) + truncatedRight;
  }

  /** 与原生选择器一致：accent 色的整宽分隔横线。 */
  private renderBorder(width: number): string {
    return this.theme.fg("accent", "─".repeat(Math.max(1, width)));
  }

  /** 与原生一致的范围状态：加载中显示读取进度，否则显示当前/全部范围的选择。 */
  private scopeStatus(): string {
    if (this.loading) {
      const progress = this.progress ? `${this.progress.loaded}/${this.progress.total}` : "...";
      return this.theme.fg("muted", "○ Current Folder | ") + this.theme.fg("accent", `Loading ${progress}`);
    }
    const onCurrent = this.scope === "current";
    const current = onCurrent ? this.theme.fg("accent", "◉ Current Folder") : this.theme.fg("muted", "○ Current Folder");
    const all = onCurrent ? this.theme.fg("muted", "○ All") : this.theme.fg("accent", "◉ All");
    return `${current}${this.theme.fg("muted", " | ")}${all}`;
  }

  /** 与原生一致的提示行：键名为 dim 色，描述为 muted 色。 */
  private keyHint(action: Keybinding, label: string): string {
    const keys = this.keybindings.getKeys(action);
    const text = keys.length ? formatKeyText(keys.join("/")) : action;
    return this.theme.fg("dim", text) + this.theme.fg("muted", ` ${label}`);
  }

  private hintLine1(): string {
    return this.keyHint("tui.input.tab", "scope")
      + this.theme.fg("muted", " · ")
      + this.theme.fg("muted", 're:<pattern> regex · "phrase" exact');
  }

  private hintLine2(): string {
    const separator = this.theme.fg("muted", " · ");
    return this.keyHint("app.session.toggleSort", "sort")
      + separator + this.keyHint("app.session.toggleNamedFilter", "named")
      + separator + this.keyHint("app.session.togglePath", `path (${this.showPath ? "on" : "off"})`);
  }

  /** 渲染单条会话：第一行原生识别信息，第二行消息数与最后回复模型。 */
  private renderNode(node: SessionTreeNode, index: number, width: number): string[] {
    const prefix = buildTreePrefix(node);
    const titleLine = this.renderTitleLine(node, index, width, prefix);
    const indent = Math.min(width, 2 + visibleWidth(prefix));
    const info = truncateToWidth(this.statsText(node.session), Math.max(0, width - indent), "…");
    let infoLine = " ".repeat(indent) + this.theme.fg("dim", info);
    if (index === this.selected) {
      infoLine += " ".repeat(Math.max(0, width - visibleWidth(infoLine)));
      infoLine = this.theme.bg("selectedBg", infoLine);
    }
    return [titleLine, truncateToWidth(infoLine, width, "")];
  }

  /** 第二行的增强信息；加载态、读取失败、无 assistant 与字段缺失各自区分。 */
  private statsText(session: SessionInfo): string {
    const stats = this.stats.get(session.path);
    if (!stats || stats.status === "loading") return "Loading details...";
    if (stats.status === "failed") return "Could not load session details.";
    const messageCount = `${stats.messageCount} msgs`;
    if (!stats.lastAssistant) return `${messageCount} · No assistant message`;
    return `${messageCount} · ${stats.lastAssistant.model ?? "unknown"} · ${stats.lastAssistant.provider ?? "unknown"}`;
  }

  private renderTitleLine(node: SessionTreeNode, index: number, width: number, prefix: string): string {
    const session = node.session;
    const isSelected = index === this.selected;
    const hasName = hasSessionName(session);
    const title = (session.name ?? session.firstMessage).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();

    // 右侧依次为路径、全部范围下的工作目录、相对时间；与原生顺序一致。
    const meta: string[] = [];
    if (this.showPath) meta.push(shortenPath(session.path));
    if (this.scope === "all" && session.cwd) meta.push(shortenPath(session.cwd));
    const age = formatSessionDate(session.modified);
    // 附加信息先于标题被截断，且空间不足时优先保留相对时间。
    const shownRight = fitSessionMeta(meta, age, Math.max(12, Math.floor(width * 0.6)));

    const cursor = isSelected ? this.theme.fg("accent", "› ") : "  ";
    const available = width - 2 - visibleWidth(prefix) - (visibleWidth(shownRight) + 2);
    const truncatedTitle = truncateToWidth(title, Math.max(4, available), "…");

    let styledTitle = this.isCurrentSession(session)
      ? this.theme.fg("accent", truncatedTitle)
      : hasName
        ? this.theme.fg("warning", truncatedTitle)
        : truncatedTitle;
    if (isSelected) styledTitle = this.theme.bold(styledTitle);

    const left = cursor + this.theme.fg("dim", prefix) + styledTitle;
    const spacing = Math.max(1, width - visibleWidth(left) - visibleWidth(shownRight));
    let line = left + " ".repeat(spacing) + this.theme.fg("dim", shownRight);
    if (isSelected) line = this.theme.bg("selectedBg", line);
    return truncateToWidth(line, width, "");
  }

  private isCurrentSession(session: SessionInfo): boolean {
    if (!this.currentSessionCanonicalPath) return false;
    return (canonicalizePath(session.path) ?? session.path) === this.currentSessionCanonicalPath;
  }

  private emptyMessage(): string {
    if (this.loading) return "Loading sessions...";
    if (this.failed) return "Could not load sessions.";
    const namedKey = this.keybindings.getKeys("app.session.toggleNamedFilter").join("/") || "ctrl+n";
    if (this.nameFilter === "named") {
      return this.scope === "all"
        ? `  No named sessions found. Press ${namedKey} to show all.`
        : `  No named sessions in current folder. Press ${namedKey} to show all, or Tab to view all.`;
    }
    if (this.scope === "all") return "  No sessions found";
    return "  No sessions in current folder. Press Tab to view all.";
  }
}

/**
 * 在变高条目列表中选出完整可见的范围。
 *
 * 以选中项为中心分配预算：先向上占用约一半，再向下填满，最后把剩余预算补向上方。
 * 行高超过预算时只返回选中项，由调用方按行预算截断。
 */
function visibleRows(heights: readonly number[], selected: number, budget: number): { start: number; end: number } {
  if (heights.length === 0) return { start: 0, end: 0 };
  const target = Math.max(0, Math.min(heights.length - 1, selected));
  if (heights[target] > budget) return { start: target, end: target + 1 };
  const halfAbove = Math.max(0, Math.floor((budget - heights[target]) / 2));
  let start = target;
  let usedAbove = 0;
  while (start > 0 && usedAbove + heights[start - 1] <= halfAbove) {
    start--;
    usedAbove += heights[start];
  }
  let end = target + 1;
  let used = usedAbove + heights[target];
  while (end < heights.length && used + heights[end] <= budget) {
    used += heights[end];
    end++;
  }
  // 下方没有更多条目时，把剩余预算补到上方。
  while (start > 0 && used + heights[start - 1] <= budget) {
    start--;
    used += heights[start];
  }
  return { start, end };
}

/** 与 pi 原生提示一致：macOS 上把 alt 显示为 option。 */
function formatKeyText(keys: string): string {
  return keys
    .split("/")
    .map((key) => key
      .split("+")
      .map((part) => (process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part))
      .join("+"))
    .join("/");
}

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * 拼装列表右侧的附加信息。
 *
 * 超过可用宽度时先截断路径与工作目录并保留相对时间：
 * 窄终端下时间比完整路径更能帮助辨认会话。
 */
function fitSessionMeta(parts: readonly string[], age: string, maxWidth: number): string {
  const full = [...parts, age].join(" ");
  if (visibleWidth(full) <= maxWidth) return full;
  const room = maxWidth - visibleWidth(age) - 2; // 预留省略号与分隔空格
  if (room <= 0) return truncateToWidth(age, maxWidth, "");
  return `${truncateToWidth(parts.join(" "), room, "…")} ${age}`;
}

// 时间桶与 pi 1.1.0 原生选择器一致；活动时间由公开 SessionManager 提供。
function formatSessionDate(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
