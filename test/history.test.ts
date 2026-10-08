import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { HistoryHost, NOW, deferred, makeTheme, world } from "./host.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";

test("通过独立 /history 浏览真实会话并恢复选中目标，不覆盖原生入口", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const data = await world(t);
  const current = await data.save({ id: "current", name: "Previous task", activity: NOW - 3_600_000 });
  const target = await data.save({ id: "target", name: "Target task" });
  const host = new HistoryHost({ ...data, current });
  t.after(() => host.close());
  assert.deepEqual([...host.commands.keys()], ["history"]);
  const command = host.open();
  await host.waitFor((text) => text.includes("Target task") && text.includes("Previous task") && !text.includes("Loading"));
  assert.match(host.text(), /› Target task/);
  assert.match(host.text(), /Target task\s+2m/);
  assert.match(host.text(), /Previous task\s+1h/);
  const currentLine = host.frame.find((line) => stripAnsi(line).includes("Previous task"))!;
  assert.ok(currentLine.includes(host.theme.fg("accent", "Previous task")));
  const selectedLine = host.frame.find((line) => stripAnsi(line).includes("› Target task"))!;
  assert.ok(selectedLine.includes(host.theme.getBgAnsi("selectedBg")));
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [target]);
  assert.equal(host.activeSession.getSessionFile(), target);
  assert.equal(host.activeSession.getBranch().some((entry) => entry.type === "message"), true);
  assert.equal(host.text(), "Original editor");
  assert.deepEqual(host.notifications, []);
});

test("当前活动会话经符号链接载入时仍使用原生当前会话样式", async (t) => {
  const data = await world(t);
  const current = await data.save({ id: "current", name: "Linked current task" });
  const alias = `${data.root}/alias.jsonl`;
  await symlink(current, alias);
  const host = new HistoryHost({ ...data, current: alias });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Linked current task") && !text.includes("Loading"));
  const line = host.frame.find((row) => stripAnsi(row).includes("Linked current task"))!;
  assert.ok(line.includes(host.theme.fg("accent", "Linked current task")));
  host.press("\u001b");
  await command;
});

test("上下选择、按可用高度分页和缩放后确认始终恢复可见目标", async (t) => {
  const data = await world(t);
  const paths: string[] = [];
  for (let i = 1; i <= 12; i++) {
    paths.push(await data.save({ id: `task-${i}`, name: `Task ${String(i).padStart(2, "0")}`, activity: NOW - i * 60_000 }));
  }
  const host = new HistoryHost({ ...data, rows: 10 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Task 01") && !text.includes("Loading"));
  assert.ok(host.frame.length <= 8, "内容应留在 overlay 的可用高度内");
  assert.match(host.text(), /› Task 01/);
  assert.doesNotMatch(host.text(), /Task 06/);
  host.press("\u001b[6~");
  assert.match(host.text(), /› Task 06/);
  host.press("\u001b[5~");
  host.press("\u001b[A");
  assert.match(host.text(), /› Task 01/);
  host.press("\u001b[B");
  assert.match(host.text(), /› Task 02/);
  host.resize(24, 7);
  host.press("\u001b[6~");
  assert.match(host.text(), /› Task 04/);
  assert.ok(host.frame.length <= 5);
  assert.ok(host.frame.every((line) => visibleWidth(line) <= 24));
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [paths[3]]);
});

test("空列表明确反馈，忽略确认并允许 Esc 返回原编辑器", async (t) => {
  const data = await world(t);
  await writeFile(`${data.sessionDir}/broken.jsonl`, "not a session\n");
  await data.save({ id: "other-project", name: "Hidden project", cwd: `${data.root}/another-project` });
  const host = new HistoryHost(data);
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("No sessions in current folder."));
  assert.doesNotMatch(host.text(), /Hidden project/);
  host.press("\r");
  assert.match(host.text(), /No sessions in current folder/);
  host.press("\u001b");
  await command;
  assert.deepEqual(host.switches, []);
  assert.equal(host.text(), "Original editor");
});

test("选择、分页、确认和取消遵循宿主自定义快捷键并停用被替换的默认按键", async (t) => {
  const data = await world(t);
  const paths: string[] = [];
  for (let i = 1; i <= 12; i++) paths.push(await data.save({
    id: `custom-${i}`, name: `Task ${String(i).padStart(2, "0")}`, activity: NOW - i * 60_000,
  }));
  const host = new HistoryHost({ ...data, rows: 10, bindings: {
    "tui.select.up": "k", "tui.select.down": "j",
    "tui.select.pageUp": "u", "tui.select.pageDown": "d",
    "tui.select.confirm": "x", "tui.select.cancel": "q",
  } });
  t.after(() => host.close());
  let command = host.open();
  await host.waitFor((text) => text.includes("Task 01") && !text.includes("Loading"));
  assert.match(host.text(), /k\/j select/);
  assert.match(host.text(), /u\/d page/);
  assert.match(host.text(), /x resume · q cancel/);
  for (const key of ["\u001b[A", "\u001b[B", "\u001b[5~", "\u001b[6~", "\r", "\u001b"]) host.press(key);
  assert.match(host.text(), /› Task 01/);
  assert.deepEqual(host.switches, []);
  host.press("q");
  await command;
  assert.equal(host.text(), "Original editor");
  command = host.open();
  await host.waitFor((text) => text.includes("Task 01") && !text.includes("Loading"));
  host.press("d");
  assert.match(host.text(), /› Task 06/);
  host.press("j");
  assert.match(host.text(), /› Task 07/);
  host.press("k");
  host.press("u");
  host.press("j");
  assert.match(host.text(), /› Task 02/);
  host.press("x");
  await command;
  assert.deepEqual(host.switches, [paths[1]]);
});

test("标题按原生首条用户文本回退，清空名称和无消息有正确反馈", async (t) => {
  const data = await world(t);
  await data.save({ id: "cleared", name: "Retired name", firstMessage: "Restored first request", extraEntries: [{
    type: "session_info", id: "clear-name", parentId: "name", timestamp: new Date(NOW).toISOString(), name: " ",
  }] });
  await data.save({ id: "images", messages: [
    { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
    { role: "assistant", content: [{ type: "text", text: "Not the title" }] },
    { role: "user", content: [{ type: "text", text: "First readable request" }, { type: "text", text: "continued" }] },
    { role: "user", content: "Later request" },
  ] });
  await data.save({ id: "empty-session", messages: [] });
  await data.save({ id: "another-cwd", name: "Unrelated session", cwd: `${data.root}/unrelated` });
  const host = new HistoryHost(data);
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("First readable request continued") && !text.includes("Loading"));
  assert.match(host.text(), /Restored first request/);
  assert.match(host.text(), /\(no messages\)/);
  assert.doesNotMatch(host.text(), /Retired name|Not the title|Later request|Unrelated session/);
  host.press("\u001b");
  await command;
});

test("活动时间和所有相对时间桶使用原生语义，不受 mtime、命名或工具结果时间影响", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const data = await world(t);
  const cases: [string, number, string][] = [
    ["Now", 0, "now"], ["Minute", 60_000, "1m"], ["Before hour", 59 * 60_000, "59m"],
    ["Hour", 3_600_000, "1h"], ["Before day", 23 * 3_600_000, "23h"],
    ["Day", 86_400_000, "1d"], ["Before week", 6 * 86_400_000, "6d"],
    ["Week", 7 * 86_400_000, "1w"], ["Before month", 29 * 86_400_000, "4w"],
    ["Month", 30 * 86_400_000, "1mo"], ["Before year", 364 * 86_400_000, "12mo"],
    ["Year", 365 * 86_400_000, "1y"],
  ];
  for (const [name, ago] of cases) {
    const path = await data.save({ id: name.replaceAll(" ", "-"), name, activity: NOW - ago });
    await utimes(path, new Date(NOW + 86_400_000), new Date(NOW + 86_400_000));
  }
  await data.save({ id: "tool-time", name: "Tool ignored", messages: [
    { role: "user", content: "Real activity", timestamp: NOW - 2 * 86_400_000 },
    { role: "toolResult", content: [{ type: "text", text: "Recent tool result" }], timestamp: NOW },
  ] });
  await data.save({ id: "header-time", name: "Header fallback", messages: [], created: NOW - 14 * 86_400_000 });
  const host = new HistoryHost({ ...data, rows: 30 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Header fallback") && !text.includes("Loading"));
  for (const [name, , age] of cases) assert.match(host.text(), new RegExp(`${name}\\s+${age}(?:\\n|$)`));
  assert.match(host.text(), /Tool ignored\s+2d/);
  assert.match(host.text(), /Header fallback\s+2w/);
  host.press("\u001b");
  await command;
});

test("真实读取的渐进结果先可选，迟到的新会话不会移走用户选择", async (t) => {
  const data = await world(t);
  await data.save({ id: "latest", name: "Arriving latest", activity: NOW - 60_000 });
  await data.save({ id: "first", name: "First available", activity: NOW - 120_000 });
  const target = await data.save({ id: "selected", name: "Chosen session", activity: NOW - 180_000 });
  const read = SessionManager.list.bind(SessionManager);
  const published = deferred();
  const release = deferred();
  t.mock.method(SessionManager, "list", async (...[cwd, dir, progress, signal]: Parameters<typeof SessionManager.list>) => {
    const sessions = await read(cwd, dir, undefined, signal);
    progress?.(2, 3, sessions.slice(1));
    published.resolve();
    await release.promise;
    return sessions;
  });
  const host = new HistoryHost(data);
  t.after(() => { host.close(); release.resolve(); });
  const command = host.open();
  await published.promise;
  assert.match(host.text(), /First available/);
  assert.match(host.text(), /Loading sessions/);
  assert.doesNotMatch(host.text(), /Arriving latest/);
  host.press("\u001b[B");
  assert.match(host.text(), /› Chosen session/);
  release.resolve();
  await host.waitFor((text) => text.includes("Arriving latest") && !text.includes("Loading"));
  assert.match(host.text(), /› Chosen session/);
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [target]);
});

test("宿主读取失败有明确反馈，不被当成真实空列表", async (t) => {
  const data = await world(t);
  t.mock.method(SessionManager, "list", async () => { throw new Error("Controlled read failure"); });
  const host = new HistoryHost(data);
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => !text.includes("Loading") && text.includes("History"));
  assert.match(host.text(), /Could not load sessions/);
  assert.doesNotMatch(host.text(), /No sessions in current folder/);
  host.press("\u001b");
  await command;
  assert.deepEqual(host.switches, []);
});

test("中文、emoji、组合字符和控制字符在窄屏、缩放和主题变化后不越界", async (t) => {
  const data = await world(t);
  const current = await data.save({
    id: "unicode", name: "中文🚀 e\u0301 👨‍👩‍👧‍👦\n第二行\t文本\u001b[2J", activity: NOW - 60_000,
  });
  await data.save({ id: "other", name: "Older task", activity: NOW - 120_000 });
  const host = new HistoryHost({ ...data, current, columns: 120 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("中文🚀") && !text.includes("Loading"));
  assert.match(host.text(), /中文🚀 e\u0301 👨‍👩‍👧‍👦 第二行 文本/);
  assert.ok(host.frame.every((line) => !stripAnsi(line).includes("\n") && !stripAnsi(line).includes("\t")));
  host.changeTheme(makeTheme("#ee4488"));
  const selected = host.frame.find((line) => stripAnsi(line).includes("› 中文"))!;
  assert.ok(selected.includes(host.theme.getFgAnsi("accent")));
  assert.ok(selected.includes(host.theme.getBgAnsi("selectedBg")));
  for (const [width, height] of [[40, 10], [18, 7], [8, 6], [2, 4], [1, 3], [100, 18]]) {
    host.resize(width, height);
    assert.ok(host.frame.every((line) => visibleWidth(line) <= width), `宽度 ${width} 不应越界`);
    assert.ok(host.frame.length <= Math.max(1, height - 2));
    assert.ok(host.text().includes("›"), "缩放后选中项仍应可见");
  }
  host.press("\u001b");
  await command;
});

test("浏览与取消不修改或另存会话，重新打开时读取新的保存内容", async (t) => {
  const data = await world(t);
  await data.save({ id: "saved", name: "Before external update" });
  const before = new Map<string, string>();
  for (const file of await readdir(data.sessionDir)) before.set(file, await readFile(`${data.sessionDir}/${file}`, "utf8"));
  const host = new HistoryHost(data);
  t.after(() => host.close());
  let command = host.open();
  await host.waitFor((text) => text.includes("Before external update") && !text.includes("Loading"));
  host.press("\u001b");
  await command;
  const after = new Map<string, string>();
  for (const file of await readdir(data.sessionDir)) after.set(file, await readFile(`${data.sessionDir}/${file}`, "utf8"));
  assert.deepEqual(after, before);
  assert.deepEqual((await readdir(data.root)).sort(), ["project", "sessions"]);
  await data.save({ id: "saved", name: "After external update" });
  command = host.open();
  await host.waitFor((text) => text.includes("After external update") && !text.includes("Loading"));
  assert.doesNotMatch(host.text(), /Before external update/);
  host.press("\u0003");
  await command;
  assert.deepEqual(host.switches, []);
});

test("RPC、JSON、print 和无 UI 的上下文都不启动自定义终端界面", async (t) => {
  const data = await world(t);
  for (const mode of ["rpc", "json", "print", "tui"] as const) {
    await t.test(mode, async () => {
      const host = new HistoryHost({ ...data, mode, hasUI: mode === "rpc" });
      await host.open();
      assert.equal(host.text(), "Original editor");
      assert.deepEqual(host.switches, []);
      if (mode === "rpc") assert.match(host.notifications[0]?.message ?? "", /interactive terminal/);
      else assert.deepEqual(host.notifications, []);
    });
  }
});

test("宿主取消恢复时保留原会话并显示取消结果，而非报告成功", async (t) => {
  const data = await world(t);
  const current = await data.save({ id: "current", name: "Original task", activity: NOW - 3_600_000 });
  const target = await data.save({ id: "target", name: "Cancelled target" });
  const host = new HistoryHost({ ...data, current });
  host.cancelSwitch = true;
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Cancelled target") && !text.includes("Loading"));
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [target]);
  assert.equal(host.activeSession.getSessionFile(), current);
  assert.deepEqual(host.notifications, [{ message: "Session switch cancelled.", type: "info" }]);
  assert.equal(host.text(), "Original editor");
  const reopened = host.open();
  await host.waitFor((text) => text.includes("Cancelled target") && !text.includes("Loading"));
  host.press("\u001b");
  await reopened;
  assert.equal(host.activeSession.getSessionFile(), current);
});

test("加载未完成时取消、宿主关闭或会话 shutdown 会释放交互且忽略迟到结果", async (t) => {
  const data = await world(t);
  await data.save({ id: "late", name: "Late session" });
  const read = SessionManager.list.bind(SessionManager);
  for (const action of ["escape", "dispose", "shutdown"] as const) {
    await t.test(action, async (sub) => {
      const loaded = deferred();
      const release = deferred();
      const returned = deferred();
      let loadSignal: AbortSignal | undefined;
      sub.mock.method(SessionManager, "list", async (...[cwd, dir, progress, signal]: Parameters<typeof SessionManager.list>) => {
        loadSignal = signal;
        const sessions = await read(cwd, dir, undefined, signal);
        loaded.resolve();
        await release.promise;
        progress?.(sessions.length, sessions.length, sessions);
        returned.resolve();
        return sessions;
      });
      const host = new HistoryHost(data);
      sub.after(() => { host.close(); release.resolve(); });
      const command = host.open();
      await loaded.promise;
      await host.waitFor((text) => text.includes("Loading sessions"));
      host.press("\r");
      assert.deepEqual(host.switches, [], "加载中不能确认不存在的条目");
      if (action === "escape") host.press("\u001b");
      else if (action === "dispose") host.close();
      else await host.shutdown();
      assert.equal(host.text(), "Original editor");
      await command;
      assert.equal(loadSignal?.aborted, true);
      release.resolve();
      await returned.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(host.text(), "Original editor");
      assert.equal(host.lateOutput, false, "关闭后不应再向终端提交旧界面更新");
      assert.deepEqual(host.switches, []);
    });
  }
});
