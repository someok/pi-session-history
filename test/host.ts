import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import {
  SessionManager,
  Theme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  type KeybindingsManager as HostKeybindingsManager,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager, TUI_KEYBINDINGS, type KeybindingsConfig } from "@earendil-works/pi-tui";
import history from "../src/index.ts";

export const NOW = Date.UTC(2026, 5, 1, 12);

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// adapter 只替代公开宿主；会话发现、读取和目标载入均使用真实 pi SDK。
export class HistoryHost {
  readonly commands = new Map<string, RegisteredCommand>();
  readonly notifications: { message: string; type?: string }[] = [];
  readonly switches: string[] = [];
  readonly frames: string[][] = [];
  // 宿主如何呈现这次交互：inline 替换编辑器区域，overlay 覆盖在内容之上。
  readonly placements: ("inline" | "overlay")[] = [];
  readonly terminal: { columns: number; rows: number };
  readonly keybindings: KeybindingsManager;
  readonly context: ExtensionCommandContext;
  activeSession: SessionManager;
  cancelSwitch = false;
  lateOutput = false;
  theme = makeTheme();
  frame = ["Original editor"];
  // 交互区域上方已存在的会话内容；overlay 会遮住它，inline 不会。
  transcript: string[] = [];
  private component?: Component & { dispose?(): void };
  private placement: "inline" | "overlay" = "inline";
  private cancelCustom?: () => void;
  private invalidated = false;
  private readonly events = new Map<string, (...args: any[]) => unknown>();
  private readonly waiters = new Set<() => void>();

  constructor(options: {
    cwd: string;
    sessionDir: string;
    current?: string;
    mode?: ExtensionCommandContext["mode"];
    hasUI?: boolean;
    columns?: number;
    rows?: number;
    bindings?: KeybindingsConfig;
  }) {
    this.terminal = { columns: options.columns ?? 80, rows: options.rows ?? 18 };
    this.keybindings = new KeybindingsManager(TUI_KEYBINDINGS, options.bindings);
    this.activeSession = options.current
      ? SessionManager.open(options.current, options.sessionDir)
      : SessionManager.create(options.cwd, options.sessionDir);
    const api = strictAdapter({
      registerCommand: (name: string, command: RegisteredCommand) => this.commands.set(name, command),
      on: (event: string, handler: (...args: any[]) => unknown) => {
        this.events.set(event, handler);
        return () => this.events.delete(event);
      },
    }, "ExtensionAPI") as unknown as ExtensionAPI;
    history(api);
    const ui = strictAdapter({
      notify: (message: string, type?: string) => { this.notifications.push({ message, type }); },
      custom: async <T>(
        factory: Parameters<ExtensionUIContext["custom"]>[0],
        customOptions?: Parameters<ExtensionUIContext["custom"]>[1],
      ): Promise<T> => {
        assert.equal(options.mode ?? "tui", "tui", "非 TUI 不应创建终端界面");
        assert.notEqual(options.hasUI, false, "无 UI 时不应创建终端界面");
        assert.equal(this.component, undefined, "不能叠加未关闭的交互");
        this.placements.push(customOptions?.overlay ? "overlay" : "inline");
        this.placement = customOptions?.overlay ? "overlay" : "inline";
        const result = deferred<T>();
        let closed = false;
        const done = (value: unknown) => {
          if (closed) return;
          closed = true;
          const component = this.component;
          this.component = undefined;
          this.cancelCustom = undefined;
          this.frame = ["Original editor"];
          this.publish();
          component?.dispose?.();
          result.resolve(value as T);
        };
        const tui = strictAdapter({
          terminal: this.terminal,
          requestRender: () => {
            if (closed) { this.lateOutput = true; return; }
            this.render();
          },
        }, "TUI") as unknown as TUI;
        const theme = new Proxy(this.theme, {
          get: (_target, key) => {
            const value = Reflect.get(this.theme, key);
            return typeof value === "function" ? value.bind(this.theme) : value;
          },
        });
        this.component = await factory(tui, theme, this.keybindings as HostKeybindingsManager, done);
        this.cancelCustom = () => done(undefined);
        if (!closed) this.render();
        return result.promise;
      },
    }, "ExtensionUIContext") as unknown as ExtensionUIContext;
    const context = {
      mode: options.mode ?? "tui",
      hasUI: options.hasUI ?? (options.mode !== "json" && options.mode !== "print"),
      cwd: options.cwd,
      sessionManager: this.activeSession,
      ui,
      waitForIdle: async () => {},
      switchSession: async (path: string) => {
        this.switches.push(path);
        if (this.cancelSwitch) return { cancelled: true };
        this.activeSession = SessionManager.open(path, options.sessionDir);
        this.invalidated = true;
        return { cancelled: false };
      },
    };
    this.context = new Proxy(strictAdapter(context, "ExtensionCommandContext"), {
      get: (target, key, receiver) => {
        assert.equal(this.invalidated, false, `切换后不能继续读取旧上下文：${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    }) as unknown as ExtensionCommandContext;
  }

  open(): Promise<void> {
    const command = this.commands.get("history");
    assert.ok(command, "扩展必须注册独立 /history");
    return command.handler("", this.context);
  }

  press(key: string): void {
    assert.ok(this.component, "用户输入需要已打开的界面");
    this.component.handleInput?.(key);
    if (this.component) this.render();
  }

  resize(columns: number, rows: number): void {
    this.terminal.columns = columns;
    this.terminal.rows = rows;
    this.component?.invalidate();
    this.render();
  }

  changeTheme(theme: Theme): void {
    this.theme = theme;
    this.component?.invalidate();
    this.render();
  }

  render(): void {
    if (!this.component) return;
    this.frame = this.component.render(this.terminal.columns);
    this.publish();
  }

  text(): string {
    // overlay 画在会话内容上方，被遮住的内容不算可见。
    const visible = this.component && this.placement === "overlay" ? [] : this.transcript;
    return [...visible, ...this.frame].map(stripAnsi).join("\n");
  }

  async waitFor(predicate: (text: string) => boolean): Promise<void> {
    if (predicate(this.text())) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`等待可见输出超时：\n${this.text()}`));
      }, 5000);
      const check = () => {
        if (!predicate(this.text())) return;
        clearTimeout(timeout);
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
      check();
    });
  }

  async shutdown(): Promise<void> {
    await this.events.get("session_shutdown")?.({ type: "session_shutdown" }, this.context);
  }

  close(): void { this.cancelCustom?.(); }

  private publish(): void {
    this.frames.push([...this.frame]);
    for (const check of this.waiters) check();
  }
}

function strictAdapter<T extends object>(value: T, label: string): T {
  return new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === "string" && !(key in target)) {
        throw new Error(`测试宿主未提供 ${label}.${key}`);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

export function makeTheme(accent = "#55aaff"): Theme {
  // 有意让各语义色不同，以便从可见 ANSI 样式辨认当前会话和选中项。
  const tokens = `accent border borderAccent borderMuted success error warning muted dim text
    thinkingText userMessageText customMessageText customMessageLabel toolTitle toolOutput
    mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder
    mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword
    syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation
    thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh bashMode`.split(/\s+/);
  const foreground = Object.assign(Object.fromEntries(tokens.map((token) => [token, "#ffffff"])), {
    accent, border: "#666666", borderAccent: accent, borderMuted: "#444444",
    success: "#00ff00", error: "#ff0000", warning: "#ffcc00", muted: "#aaaaaa", dim: "#777777",
  }) as ConstructorParameters<typeof Theme>[0];
  const background = Object.fromEntries(
    "selectedBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg".split(" ")
      .map((token) => [token, "#223344"]),
  ) as ConstructorParameters<typeof Theme>[1];
  return new Theme(foreground, background, "truecolor");
}

export async function world(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-history-test-"));
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd);
  await mkdir(sessionDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root, cwd, sessionDir,
    async save(options: {
      id: string;
      name?: string;
      firstMessage?: string;
      activity?: number;
      created?: number;
      cwd?: string;
      messages?: unknown[];
      extraEntries?: Record<string, unknown>[];
    }): Promise<string> {
      const activity = options.activity ?? NOW - 120_000;
      const messages = options.messages ?? [
        { role: "user", content: options.firstMessage ?? "First request", timestamp: activity - 1000 },
        {
          role: "assistant", content: [{ type: "text", text: "Saved response" }],
          api: "openai-responses", provider: "openai", model: "gpt-4.1-mini",
          stopReason: "stop", timestamp: activity,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      ];
      const entries: Record<string, unknown>[] = [{
        type: "session", version: 3, id: options.id,
        cwd: options.cwd ?? cwd, timestamp: new Date(options.created ?? activity).toISOString(),
      }];
      messages.forEach((message, index) => entries.push({
        type: "message", id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
        timestamp: new Date(activity).toISOString(), message,
      }));
      if (options.name !== undefined) entries.push({
        type: "session_info", id: "name", parentId: messages.length ? `entry-${messages.length - 1}` : null,
        timestamp: new Date(NOW).toISOString(), name: options.name,
      });
      entries.push(...(options.extraEntries ?? []));
      const path = join(sessionDir, `${options.id}.jsonl`);
      await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      return path;
    },
  };
}
