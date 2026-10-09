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
  matchesKey,
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
import { MAX_PREVIEW_LINES, toMessagePreview, wrapMessage, wrapMessageLines } from "./message-preview.ts";
import { readSessionDetails } from "./session-details.ts";
import { DetailsScheduler, type DetailsState } from "./details-scheduler.ts";

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

/** 展开预览左侧的竖线标记，用于在列表中区分消息体；宽度计两列。 */
const PREVIEW_MARKER = "│ ";

/** 全文入口文案；Ctrl+O 是固定按键。 */
const FULL_MESSAGE_HINT = "Ctrl+O full message";

/** 消息未就绪、读取失败、无 user 与空正文的反馈；预览与全文视图共用同一口径。 */
const LOADING_MESSAGE = "Loading message preview...";
const FAILED_MESSAGE = "Could not load message preview.";
const NO_USER_MESSAGE = "No user message";
const EMPTY_MESSAGE = "(empty message)";

/** 只读全文视图：绑定打开时的会话身份与标题，独立保存滚动位置。 */
interface FullMessageView {
  /** 会话身份（会话文件路径）；属于其它会话的迟到结果不会替换这里的正文。 */
  path: string;
  /** 打开时的会话标题，用于说明正在阅读哪条会话。 */
  title: string;
  /** 顶部首个显示行的偏移量，单位为显示行。 */
  scrollTop: number;
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
  private pageRows = 1;
  private searchFocused = false;
  /**
   * 已展开消息预览的会话身份（会话文件路径）；按身份关联，排序、筛选和
   * 范围切换后仍指向同一条，关闭选择器即随实例一起重置。
   */
  private readonly expandedPreviews = new Set<string>();
  /** 展开预览的正文滚动偏移；按会话身份关联，收起时清除。 */
  private readonly previewScroll = new Map<string, number>();
  /** 上一次渲染得到的正文窗口行数与最大偏移，供分页按键夹紧。 */
  private readonly previewScrollMetrics = new Map<string, { textWindow: number; maxOffset: number }>();
  private readonly details: DetailsScheduler;
  /** 打开中的全文视图；为 null 表示列表模式。 */
  private fullView: FullMessageView | null = null;
  /** 全文视图上一次渲染得到的翻页步长与最大滚动偏移。 */
  private fullPageRows = 1;
  private fullScrollMax = 0;

  constructor(options: HistorySelectorOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.cwd = options.cwd;
    this.sessionDir = options.sessionDir;
    this.usesDefaultSessionDir = options.usesDefaultSessionDir;
    this.currentSessionCanonicalPath = canonicalizePath(options.currentSessionFile);
    this.onDone = options.done;
    this.details = new DetailsScheduler({
      read: (path, signal) => readSessionDetails(path, signal),
      onUpdate: () => this.tui.requestRender(),
    });
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
    return this.fullView ? this.renderFullMessage(width) : this.renderList(width);
  }

  /** 列表模式渲染；行顺序与原生选择器一致。 */
  private renderList(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    // 与原生选择器一致的行顺序：分隔横线、标题与状态、两行提示、空行、
    // 搜索框、空行、列表、空行、分隔横线。按可用高度取舍装饰行，高度不足时先让位给列表。
    const chrome = chromeFor(height);
    const fixedLines = (chrome.header ? 1 : 0) + (chrome.hint1 ? 1 : 0) + (chrome.hint2 ? 1 : 0)
      + (chrome.search ? 1 : 0) + (chrome.gaps ? 3 : 0) + (chrome.borders ? 2 : 0);
    const listBudget = Math.max(1, height - fixedLines - 1);
    const preferredVisible = Math.max(5, Math.floor(height / 2));
    this.viewportHeight = Math.max(1, Math.min(preferredVisible, listBudget));

    const lines: string[] = [];
    if (chrome.borders) lines.push(this.renderBorder(width));
    if (chrome.header) lines.push(this.renderHeader(width));
    if (chrome.hint1) lines.push(truncateToWidth(this.hintLine1(), width, "…"));
    if (chrome.hint2) lines.push(truncateToWidth(this.hintLine2(), width, "…"));
    if (chrome.gaps) lines.push("");
    if (chrome.search) {
      for (const line of this.searchInput.render(width)) {
        lines.push(truncateToWidth(line, width, ""));
      }
    }
    if (chrome.gaps) lines.push("");

    const rows = this.nodes.map((node, index) => this.renderNode(node, index, width));
    if (!rows.length) {
      lines.push(this.theme.fg(this.failed ? "error" : "muted", this.emptyMessage()));
      if (chrome.gaps) lines.push("");
      if (chrome.borders) lines.push(this.renderBorder(width));
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
    this.prioritizeVisibleDetails(range.start, range.end);
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
    if (chrome.gaps) lines.push("");
    if (chrome.borders) lines.push(this.renderBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.fullView) {
      this.handleFullViewInput(data);
      return;
    }
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
      // 先滚动选中项已展开且溢出的预览；窗口到顶后再按原语义分页列表。
      if (!this.scrollSelectedPreview(-1)) this.moveSelection(-this.pageRows);
      return;
    }
    if (kb.matches(data, "tui.select.pageDown")) {
      if (!this.scrollSelectedPreview(1)) this.moveSelection(this.pageRows);
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
    // 列表中的 ←/→ 专用于原地展开与收起最后用户消息；Ctrl+B、Ctrl+F 等
    // 替代按键仍交给搜索框，查询保持可编辑。
    if (this.nodes.length > 0) {
      const expand = matchesKey(data, "right");
      if (expand || matchesKey(data, "left")) {
        this.togglePreview(expand);
        return;
      }
      // Ctrl+O 为固定按键，与该项是否已展开无关，直接打开选中会话的全文视图。
      if (matchesKey(data, "ctrl+o")) {
        this.openFullMessage();
        return;
      }
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
  // 增强信息（消息数、最后回复模型与最后用户消息）
  // ---------------------------------------------------------------------------

  /** 为尚未读取的会话排队；列表渐进更新与后续范围切换都只请求一次。 */
  private requestDetails(sessions: readonly SessionInfo[]): void {
    if (this.closed) return;
    this.details.enqueue(sessions.map((session) => session.path));
  }

  // ---------------------------------------------------------------------------
  // 过滤与选择
  // ---------------------------------------------------------------------------

  /** 提交当前范围的数据到列表，并按原生规则保持用户的选择。 */
  private setSessions(sessions: readonly SessionInfo[]): void {
    const selectedPath = this.selectionTouched ? this.selectedPath() : undefined;
    this.visibleSessions = [...sessions];
    this.requestDetails(this.visibleSessions);
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

  /**
   * 视口内的会话优先读取增强信息；滚动、查询、筛选与范围切换后重新排序，
   * 让已经离开视口的读取为当前可见项让出并发槽位。
   */
  private prioritizeVisibleDetails(start: number, end: number): void {
    const paths: string[] = [];
    for (let index = start; index < end; index++) {
      const session = this.nodes[index]?.session;
      if (session) paths.push(session.path);
    }
    this.details.prioritize(paths);
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

  /**
   * 原地展开或收起选中会话的消息预览。
   *
   * 重复展开/收起幂等，不隐式打开全文，也不影响其它已展开项；收起时清除
   * 该会话的滚动位置，重新展开回到窗口顶部。
   */
  private togglePreview(expand: boolean): void {
    const identity = this.selectedIdentity();
    if (identity === undefined) return;
    if (expand) {
      this.expandedPreviews.add(identity);
    } else {
      this.expandedPreviews.delete(identity);
      this.previewScroll.delete(identity);
      this.previewScrollMetrics.delete(identity);
    }
    this.tui.requestRender();
  }

  /**
   * 会话身份：列表项对应的会话文件路径。
   *
   * 同一选择器实例内路径稳定，排序、筛选与范围切换后仍指向同一条；
   * 关闭选择器时随实例丢弃展开状态。
   */
  private selectedIdentity(): string | undefined {
    return this.nodes[this.selected]?.session.path;
  }

  // ---------------------------------------------------------------------------
  // 只读全文视图
  // ---------------------------------------------------------------------------

  /**
   * 打开选中会话的只读全文视图。
   *
   * 不要求该项已展开，也不要求增强信息已经读取完成；视图绑定打开时的会话
   * 身份，之后的异步结果只按该身份更新同一会话的正文。
   */
  private openFullMessage(): void {
    const node = this.nodes[this.selected];
    if (!node) return;
    this.requestDetails([node.session]);
    this.fullView = { path: node.session.path, title: sessionTitle(node.session), scrollTop: 0 };
    this.tui.requestRender();
  }

  /** Esc 返回列表；搜索、范围、排序、筛选、选中、展开与滚动位置都保持不变。 */
  private closeFullMessage(): void {
    this.fullView = null;
    this.tui.requestRender();
  }

  /** 按显示行滚动全文；偏移量在渲染时按内容高度夹紧。 */
  private scrollFullMessage(delta: number): void {
    const view = this.fullView;
    if (!view) return;
    view.scrollTop = Math.max(0, Math.min(this.fullScrollMax, view.scrollTop + delta));
    this.tui.requestRender();
  }

  /**
   * 全文视图为只读：只接受滚动、翻页与返回；Enter、字符及其它列表动作都不会
   * 修改正文、删除会话或触发会话恢复。
   */
  private handleFullViewInput(data: string): void {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.up")) {
      this.scrollFullMessage(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.scrollFullMessage(1);
      return;
    }
    if (kb.matches(data, "tui.select.pageUp")) {
      this.scrollFullMessage(-this.fullPageRows);
      return;
    }
    if (kb.matches(data, "tui.select.pageDown")) {
      this.scrollFullMessage(this.fullPageRows);
      return;
    }
    // ←/→ 与 PageUp/PageDown 等效；fullscreen 下 alt-screen 会先消费
    // PageUp/PageDown，内联组件只能用这两个固定按键翻页。
    if (matchesKey(data, "left")) {
      this.scrollFullMessage(-this.fullPageRows);
      return;
    }
    if (matchesKey(data, "right")) {
      this.scrollFullMessage(this.fullPageRows);
      return;
    }
    // 其余按键（含 Enter 与列表动作）在只读视图中不做任何事。
    if (kb.matches(data, "tui.select.cancel")) this.closeFullMessage();
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
    this.details.stop();
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
    return this.renderTwoColumnHeader(this.theme.bold(title), rightText, width);
  }

  /** 左右两栏的头部行：右侧信息先被截断，标题保留更多空间。 */
  private renderTwoColumnHeader(left: string, right: string, width: number): string {
    const truncatedRight = truncateToWidth(right, width, "");
    const availableLeft = Math.max(0, width - visibleWidth(truncatedRight) - 1);
    const truncatedLeft = truncateToWidth(left, availableLeft, "…");
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
      + separator + this.keyHint("app.session.togglePath", `path (${this.showPath ? "on" : "off"})`)
      + separator + this.theme.fg("dim", "→/←") + this.theme.fg("muted", " preview")
      + separator + this.theme.fg("dim", "Ctrl+O") + this.theme.fg("muted", " full message");
  }

  /** 渲染单条会话：第一行原生识别信息，第二行增强信息，展开时追加消息预览。 */
  private renderNode(node: SessionTreeNode, index: number, width: number): string[] {
    const prefix = buildTreePrefix(node);
    const titleLine = this.renderTitleLine(node, index, width, prefix);
    const indent = Math.min(width, 2 + visibleWidth(prefix));
    const selected = index === this.selected;
    const lines = [titleLine, this.renderIndentedLine(this.detailsText(node.session), width, indent, selected)];
    if (this.expandedPreviews.has(node.session.path)) {
      for (const text of this.previewLines(node.session, previewContentWidth(width, indent))) {
        lines.push(this.renderPreviewLine(text, width, indent, selected));
      }
    }
    return lines;
  }

  /** 缩进的增强信息行；选中行铺满选中背景，保持连续高亮。 */
  private renderIndentedLine(text: string, width: number, indent: number, selected: boolean): string {
    const content = this.theme.fg("dim", truncateToWidth(text, Math.max(0, width - indent), "…"));
    return this.renderListLine(" ".repeat(indent) + content, width, selected);
  }

  /** 展开的消息体行：左侧竖线标记，正文按与换行一致的可用宽度渲染。 */
  private renderPreviewLine(text: string, width: number, indent: number, selected: boolean): string {
    const prefix = " ".repeat(indent) + this.theme.fg("dim", PREVIEW_MARKER);
    const content = this.theme.fg("dim", truncateToWidth(text, previewContentWidth(width, indent), "…"));
    return this.renderListLine(prefix + content, width, selected);
  }

  /** 选中行铺满选中背景；所有行都按可用宽度硬截断，不越界。 */
  private renderListLine(line: string, width: number, selected: boolean): string {
    if (!selected) return truncateToWidth(line, width, "");
    const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    return truncateToWidth(this.theme.bg("selectedBg", padded), width, "");
  }

  /**
   * 展开后的消息预览行。
   *
   * 未就绪时显示加载态，读取失败与没有 user 消息分别提示；正文保留换行并按
   * 内容宽度换行，窗口固定为 MAX_PREVIEW_LINES 个显示行，附件提示始终保留。
   * 正文超出窗口时附加当前窗口范围与全文入口提示，偏移由 PageUp/PageDown 驱动。
   */
  private previewLines(session: SessionInfo, contentWidth: number): string[] {
    const state = this.details.get(session.path);
    if (!state || state.status === "loading") return [LOADING_MESSAGE];
    if (state.status === "failed") return [FAILED_MESSAGE];
    if (state.lastUser === null) return [NO_USER_MESSAGE];
    const wrapped = wrapMessage(toMessagePreview(state.lastUser), contentWidth);
    // 附件提示始终保留，正文在扣除附件行数后的窗口里翻页。
    const textWindow = Math.max(1, MAX_PREVIEW_LINES - wrapped.attachmentLines.length);
    const maxOffset = Math.max(0, wrapped.textLines.length - textWindow);
    this.previewScrollMetrics.set(session.path, { textWindow, maxOffset });
    const offset = Math.max(0, Math.min(this.previewScroll.get(session.path) ?? 0, maxOffset));
    this.previewScroll.set(session.path, offset);
    const visible = wrapped.textLines.slice(offset, offset + textWindow);
    const lines = [...visible, ...wrapped.attachmentLines];
    if (wrapped.textLines.length <= textWindow) return lines;
    const range = `${offset + 1}-${offset + visible.length}/${wrapped.textLines.length}`;
    return [...lines, `… ${range} · ${FULL_MESSAGE_HINT}`];
  }

  /**
   * 用 PageUp/PageDown 滚动选中项的展开预览。
   *
   * 只有选中项已展开且正文超出预览窗口时才消费按键；已经在窗口顶部或底部
   * 时返回 false，让分页按键继续按原语义移动列表选中项。
   */
  private scrollSelectedPreview(direction: -1 | 1): boolean {
    const path = this.selectedIdentity();
    if (path === undefined || !this.expandedPreviews.has(path)) return false;
    const metrics = this.previewScrollMetrics.get(path);
    if (!metrics || metrics.maxOffset === 0) return false;
    const offset = this.previewScroll.get(path) ?? 0;
    const next = Math.max(0, Math.min(metrics.maxOffset, offset + direction * metrics.textWindow));
    if (next === offset) return false;
    this.previewScroll.set(path, next);
    this.tui.requestRender();
    return true;
  }

  // ---------------------------------------------------------------------------
  // 全文视图渲染
  // ---------------------------------------------------------------------------

  /**
   * 只读全文视图：沿用列表的装饰取舍，正文占满剩余高度；内容超出时
   * 显示位置提示，并支持上下与分页滚动。
   */
  private renderFullMessage(width: number): string[] {
    const view = this.fullView as FullMessageView;
    const height = Math.max(1, this.tui.terminal.rows);
    const chrome = chromeFor(height);
    const fixedLines = (chrome.header ? 1 : 0) + (chrome.hint1 ? 1 : 0) + (chrome.gaps ? 2 : 0)
      + (chrome.borders ? 2 : 0);
    const contentBudget = Math.max(1, height - fixedLines - 1);

    const lines: string[] = [];
    if (chrome.borders) lines.push(this.renderBorder(width));
    if (chrome.header) {
      lines.push(this.renderTwoColumnHeader(this.theme.bold("Full message"), this.theme.fg("dim", view.title), width));
    }
    if (chrome.hint1) lines.push(truncateToWidth(this.fullHintLine(), width, "…"));
    if (chrome.gaps) lines.push("");

    const content = this.fullContentLines(width);
    this.details.prioritize([view.path]);
    const scrollable = content.length > contentBudget;
    const budget = scrollable ? Math.max(1, contentBudget - 1) : contentBudget;
    this.fullPageRows = budget;
    this.fullScrollMax = Math.max(0, content.length - budget);
    view.scrollTop = Math.max(0, Math.min(this.fullScrollMax, view.scrollTop));
    for (const line of content.slice(view.scrollTop, view.scrollTop + budget)) lines.push(line);
    if (scrollable) lines.push(this.theme.fg("muted", `  (${view.scrollTop + 1}/${content.length})`));
    if (chrome.gaps) lines.push("");
    if (chrome.borders) lines.push(this.renderBorder(width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  /**
   * 全文正文：与预览相同的最后用户消息、技能简化与附件提示口径，
   * 但不限制显示行数；未就绪与异常状态给出与预览一致的反馈。
   */
  private fullContentLines(width: number): string[] {
    const view = this.fullView;
    if (!view) return [];
    const state = this.details.get(view.path);
    if (!state || state.status === "loading") return [this.theme.fg("muted", LOADING_MESSAGE)];
    if (state.status === "failed") return [this.theme.fg("muted", FAILED_MESSAGE)];
    if (state.lastUser === null) return [this.theme.fg("muted", NO_USER_MESSAGE)];
    const content = wrapMessageLines(toMessagePreview(state.lastUser), width);
    return content.length ? content : [this.theme.fg("muted", EMPTY_MESSAGE)];
  }

  /** 全文视图提示：滚动、翻页与返回；其它按键在只读视图中不生效。 */
  private fullHintLine(): string {
    const separator = this.theme.fg("muted", " · ");
    return this.keyHint("tui.select.up", "scroll")
      + separator + this.theme.fg("dim", "←/→") + this.theme.fg("muted", " page")
      + separator + this.keyHint("tui.select.cancel", "back");
  }

  /** 第二行的增强信息；加载态、读取失败、无 assistant 与字段缺失各自区分。 */
  private detailsText(session: SessionInfo): string {
    const details = this.details.get(session.path);
    if (!details || details.status === "loading") return "Loading details...";
    if (details.status === "failed") return "Could not load session details.";
    const messageCount = `${details.messageCount} msgs`;
    if (!details.lastAssistant) return `${messageCount} · No assistant message`;
    const provider = details.lastAssistant.provider ?? "unknown";
    const model = details.lastAssistant.model ?? "unknown";
    return `${messageCount} · ${provider}/${model}`;
  }

  private renderTitleLine(node: SessionTreeNode, index: number, width: number, prefix: string): string {
    const session = node.session;
    const isSelected = index === this.selected;
    const hasName = hasSessionName(session);
    const title = sessionTitle(session);

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

/** 与原生一致的会话标题文本：有名称取名称，否则取首条可读消息。 */
function sessionTitle(session: SessionInfo): string {
  return (session.name ?? session.firstMessage).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
}

/**
 * 按终端高度决定各装饰行的取舍：高度不足时先让位给内容。
 * 列表与全文视图共用同一套阈值，保证两个视图的装饰行为一致。
 */
function chromeFor(height: number): {
  header: boolean;
  hint1: boolean;
  hint2: boolean;
  search: boolean;
  gaps: boolean;
  borders: boolean;
} {
  return {
    header: height >= 5,
    hint1: height >= 8,
    hint2: height >= 9,
    search: height >= 7,
    gaps: height >= 11,
    borders: height >= 13,
  };
}

/**
 * 展开预览正文的可用显示宽度：扣除行缩进与左侧竖线标记，
 * 保证换行宽度与渲染宽度一致。
 */
function previewContentWidth(width: number, indent: number): number {
  return Math.max(1, width - indent - visibleWidth(PREVIEW_MARKER));
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
