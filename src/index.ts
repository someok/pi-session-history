import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function history(pi: ExtensionAPI): void {
  let cancelOpen: (() => void) | undefined;
  pi.on("session_shutdown", () => { cancelOpen?.(); });
  pi.registerCommand("history", {
    description: "Browse and resume saved sessions in the current folder",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        if (ctx.hasUI) ctx.ui.notify("History is only available in interactive terminal mode.", "warning");
        return;
      }
      cancelOpen?.();
      const cwd = ctx.cwd;
      const sessionDir = ctx.sessionManager.getSessionDir();
      const currentFile = canonicalizePath(ctx.sessionManager.getSessionFile());
      const target = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
        const controller = new AbortController();
        let closed = false;
        let loadState: "loading" | "ready" | "error" = "loading";
        let sessions: readonly SessionInfo[] = [];
        let currentPaths = new Set<string>();
        let selected = 0;
        let selectionTouched = false;
        let scrollTop = 0;
        let viewportHeight = 1;
        let rowStarts: number[] = [];

        const finish = (path?: string) => {
          if (closed) return;
          closed = true;
          controller.abort();
          sessions = [];
          currentPaths.clear();
          if (cancelOpen === cancel) cancelOpen = undefined;
          done(path);
        };
        const cancel = () => finish();
        cancelOpen = cancel;
        const updateSessions = (result: readonly SessionInfo[]) => {
          if (closed) return;
          const selectedPath = selectionTouched ? sessions[selected]?.path : undefined;
          sessions = result;
          currentPaths = new Set(sessions.filter((session) => canonicalizePath(session.path) === currentFile).map((session) => session.path));
          const index = selectedPath ? sessions.findIndex((session) => session.path === selectedPath) : 0;
          selected = index >= 0 ? index : Math.max(0, Math.min(selected, sessions.length - 1));
          tui.requestRender();
        };
        void SessionManager.list(cwd, sessionDir, (_loaded, _total, partial) => {
          if (partial) updateSessions(partial);
        }, controller.signal).then((result) => {
          if (closed) return;
          loadState = "ready";
          updateSessions(result);
        }).catch(() => {
          if (closed) return;
          loadState = "error";
          tui.requestRender();
        });

        return {
          render(width: number): string[] {
            // 以终端显示行组织条目，后续双行或变高条目无需更换滚动模型。
            const rows = sessions.map((session, index) => {
              const isSelected = index === selected;
              const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
              const age = formatSessionDate(session.modified);
              const title = (session.name ?? session.firstMessage).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
              const right = truncateToWidth(age, Math.max(0, width - 4), "");
              const truncatedTitle = truncateToWidth(title, Math.max(0, width - 4 - visibleWidth(right)), "…");
              let styledTitle = currentPaths.has(session.path)
                ? theme.fg("accent", truncatedTitle)
                : session.name ? theme.fg("warning", truncatedTitle) : truncatedTitle;
              if (isSelected) styledTitle = theme.bold(styledTitle);
              const left = cursor + styledTitle;
              const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
              let line = left + padding + theme.fg("dim", right);
              if (isSelected) line = theme.bg("selectedBg", line);
              return [truncateToWidth(line, width, "")];
            });
            const height = Math.max(1, tui.terminal.rows - 2);
            const header = height >= 3 ? [theme.bold("History (Current Folder)")] : [];
            const footer = height >= 2 ? [theme.fg("dim", `${keybindings.getKeys("tui.select.up").join("/")}/${keybindings.getKeys("tui.select.down").join("/")} select · ${keybindings.getKeys("tui.select.pageUp").join("/")}/${keybindings.getKeys("tui.select.pageDown").join("/")} page · ${keybindings.getKeys("tui.select.confirm").join("/")} resume · ${keybindings.getKeys("tui.select.cancel").join("/")} cancel`)] : [];
            const info = height >= 4 && sessions.length ? [theme.fg("muted", `${loadState === "loading" ? "Loading sessions... " : ""}(${selected + 1}/${sessions.length})`)] : [];
            viewportHeight = height - header.length - footer.length - info.length;
            let offset = 0;
            rowStarts = rows.map((row) => {
              const start = offset;
              offset += row.length;
              return start;
            });
            const emptyText = loadState === "loading" ? "Loading sessions..." : loadState === "error" ? "Could not load sessions." : "No sessions in current folder.";
            const lines = rows.length ? rows.flat() : [theme.fg(loadState === "error" ? "error" : "muted", emptyText)];
            const start = rowStarts[selected] ?? 0;
            const end = rowStarts[selected + 1] ?? lines.length;
            if (start < scrollTop) scrollTop = start;
            else if (end > scrollTop + viewportHeight) scrollTop = Math.min(start, end - viewportHeight);
            scrollTop = Math.max(0, Math.min(scrollTop, lines.length - viewportHeight));
            return [...header, ...lines.slice(scrollTop, scrollTop + viewportHeight), ...info, ...footer]
              .map((line) => truncateToWidth(line, width, ""));
          },
          handleInput(data: string): void {
            if (closed) return;
            if (keybindings.matches(data, "tui.select.cancel")) {
              finish();
              return;
            }
            if (!sessions.length) return;
            if (keybindings.matches(data, "tui.select.confirm")) {
              finish(sessions[selected].path);
              return;
            }
            if (keybindings.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
            else if (keybindings.matches(data, "tui.select.down")) selected = Math.min(sessions.length - 1, selected + 1);
            else if (keybindings.matches(data, "tui.select.pageDown")) {
              const targetLine = (rowStarts[selected] ?? 0) + viewportHeight;
              const index = rowStarts.findIndex((start) => start >= targetLine);
              selected = index < 0 ? sessions.length - 1 : index;
            } else if (keybindings.matches(data, "tui.select.pageUp")) {
              const targetLine = (rowStarts[selected] ?? 0) - viewportHeight;
              selected = 0;
              for (let i = 0; i < rowStarts.length && rowStarts[i] <= targetLine; i++) selected = i;
            } else return;
            selectionTouched = true;
            tui.requestRender();
          },
          invalidate(): void {},
          dispose: () => finish(),
        };
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 1 } });
      if (target === undefined) return;
      const result = await ctx.switchSession(target);
      // 成功切换会使旧上下文失效；只有取消时仍可向原会话反馈。
      if (result.cancelled) ctx.ui.notify("Session switch cancelled.", "info");
    },
  });
}

function canonicalizePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try { return realpathSync.native(path); }
  catch { return resolve(path); }
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
