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
  private searchFocused = false;

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
    // 与原生选择器一致的行顺序：标题与状态、两行提示、空行、搜索框、空行、列表。
    // 按可用高度取舍装饰行，高度不足时先让位给列表。
    const showHeader = height >= 5;
    const showHint1 = height >= 8;
    const showHint2 = height >= 9;
    const showSearch = height >= 7;
    const showBlank = height >= 11;
    const fixedLines = (showHeader ? 1 : 0) + (showHint1 ? 1 : 0) + (showHint2 ? 1 : 0)
      + (showSearch ? 1 : 0) + (showBlank ? 2 : 0);
    const listBudget = Math.max(1, height - fixedLines - 1);
    const preferredVisible = Math.max(5, Math.floor(height / 2));
    this.viewportHeight = Math.max(1, Math.min(preferredVisible, listBudget));

    const lines: string[] = [];
    if (showHeader) lines.push(this.renderHeader(width));
    if (showHint1) lines.push(truncateToWidth(this.hintLine1(), width, "…"));
    if (showHint2) lines.push(truncateToWidth(this.hintLine2(), width, "…"));
    if (showBlank) lines.push("");
    if (showSearch) {
      for (const line of this.searchInput.render(width)) {
        lines.push(truncateToWidth(line, width, ""));
      }
    }
    if (showBlank) lines.push("");

    const rows = this.nodes.map((node, index) => this.renderRow(node, index, width));
    if (!rows.length) {
      lines.push(this.theme.fg(this.failed ? "error" : "muted", this.emptyMessage()));
      return lines.map((line) => truncateToWidth(line, width, ""));
    }
    // 内容超出可用行数时，用一行展示原生风格的滚动位置。
    const scrollable = rows.length > this.viewportHeight;
    const visibleCount = scrollable ? Math.max(1, this.viewportHeight - 1) : rows.length;
    const selectedOnScreen = Math.max(0, Math.min(this.nodes.length - 1, this.selected));
    const maxScroll = Math.max(0, rows.length - visibleCount);
    this.scrollTop = Math.max(0, Math.min(selectedOnScreen - Math.floor(visibleCount / 2), maxScroll));
    lines.push(...rows.slice(this.scrollTop, this.scrollTop + visibleCount));
    if (scrollable) {
      lines.push(this.theme.fg("muted", `  (${this.selected + 1}/${this.nodes.length})`));
    }
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
      this.moveSelection(-this.viewportHeight);
      return;
    }
    if (kb.matches(data, "tui.select.pageDown")) {
      this.moveSelection(this.viewportHeight);
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
  // 过滤与选择
  // ---------------------------------------------------------------------------

  /** 提交当前范围的数据到列表，并按原生规则保持用户的选择。 */
  private setSessions(sessions: readonly SessionInfo[]): void {
    const selectedPath = this.selectionTouched ? this.selectedPath() : undefined;
    this.visibleSessions = [...sessions];
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

  private renderRow(node: SessionTreeNode, index: number, width: number): string {
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
    const prefix = buildTreePrefix(node);
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
