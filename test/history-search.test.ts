import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HistoryHost, NOW, deferred, makeTheme, world } from "./host.ts";

// 逐字符输入，模拟真实按键；普通字符不会与默认快捷键冲突。
function type(host: HistoryHost, text: string): void {
  for (const char of text) host.press(char);
}

function clearQuery(host: HistoryHost): void {
  host.press("\u0015"); // Ctrl+U：删除到行首
}

function lineIndex(host: HistoryHost, needle: string): number {
  return host.frame.findIndex((line) => stripAnsi(line).includes(needle));
}

function frameLine(host: HistoryHost, needle: string): string {
  const index = lineIndex(host, needle);
  assert.ok(index >= 0, `未找到包含 ${needle} 的行：\n${host.text()}`);
  return stripAnsi(host.frame[index]);
}

test("模糊、精确短语与正则查询沿用原生匹配范围，不把 model/provider 变成搜索字段", async (t) => {
  const data = await world(t);
  // 固定工作目录字符串，使搜索文本完全可控，避免临时路径干扰匹配断言。
  await data.save({ id: "alpha-id", name: "Zenith", firstMessage: "Prepare the quarterly rollout checklist", cwd: "/proj/alpha", activity: NOW - 60_000 });
  await data.save({ id: "beta-id", name: "Beta notes", firstMessage: "Investigate Node CVE report", cwd: "/proj/beta", activity: NOW - 120_000 });
  const host = new HistoryHost({ ...data, rows: 20 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("History (Current Folder)"));
  // 两个会话都不在宿主当前目录下，切到全部范围后对比查询语义。
  host.press("\t");
  await host.waitFor((text) => text.includes("Zenith") && text.includes("Beta notes") && !text.includes("Loading"));

  // 模糊查询：名称完全匹配的会话应成为选中项。
  type(host, "zenith");
  assert.match(host.text(), /› Zenith/);
  assert.doesNotMatch(host.text(), /Beta notes/);

  // 精确短语按原样匹配正文，词序不同不匹配。
  clearQuery(host);
  type(host, "\"cve node\"");
  assert.match(host.text(), /No sessions found/);
  clearQuery(host);
  type(host, "\"node cve\"");
  assert.match(host.text(), /› Beta notes/);
  assert.doesNotMatch(host.text(), /Zenith/);

  // 正则查询大小写不敏感，空正则与非法正则都不匹配任何会话。
  clearQuery(host);
  type(host, "re:quarterly\\s+rollout");
  assert.match(host.text(), /› Zenith/);
  clearQuery(host);
  type(host, "re:");
  assert.match(host.text(), /No sessions found/);
  clearQuery(host);
  type(host, "re:(");
  assert.match(host.text(), /No sessions found/);

  // 会话 id 属于搜索范围。
  clearQuery(host);
  type(host, "\"alpha-id\"");
  assert.match(host.text(), /› Zenith/);
  assert.doesNotMatch(host.text(), /Beta notes/);

  // assistant 上记录的 model/provider 不是搜索字段。
  clearQuery(host);
  type(host, "\"gpt-4.1-mini\"");
  assert.match(host.text(), /No sessions found/);

  // 清空查询后恢复完整列表。
  clearQuery(host);
  await host.waitFor((text) => text.includes("Zenith") && text.includes("Beta notes"));
  host.press("\u001b");
  await command;
  assert.deepEqual(host.switches, []);
});

test("Tab 在当前目录与全部范围间切换，自定义 session 目录沿用该目录语义", async (t) => {
  const data = await world(t);
  await data.save({ id: "here", name: "Here session", activity: NOW - 60_000 });
  const elsewhere = await data.save({
    id: "elsewhere", name: "Elsewhere session", cwd: `${data.root}/another-project`, activity: NOW - 180_000,
  });
  const host = new HistoryHost({ ...data, columns: 160, rows: 16 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Here session") && !text.includes("Loading"));

  assert.match(host.text(), /History \(Current Folder\)/);
  assert.doesNotMatch(host.text(), /Elsewhere session/, "当前目录范围不应包含其它工作目录的会话");

  host.press("\t");
  await host.waitFor((text) => text.includes("Elsewhere session") && !text.includes("Loading"));
  assert.match(host.text(), /History \(All\)/);
  assert.match(host.text(), /Here session/);
  assert.match(host.text(), /another-project/, "全部范围应显示每个会话的工作目录");

  host.press("\u001b[B");
  assert.match(host.text(), /› Elsewhere session/);
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [elsewhere]);
  assert.equal(host.activeSession.getSessionFile(), elsewhere);
});

test("默认 session 存储下当前目录按项目隔离，全部范围扫描其它项目", async (t) => {
  const data = await world(t);
  const defaultDir = await data.defaultSessionDirFor(data.cwd);
  const otherProject = join(data.root, "other-project");
  await mkdir(otherProject, { recursive: true });
  const otherDir = await data.defaultSessionDirFor(otherProject);
  await data.save({ id: "default-here", name: "Default here", dir: defaultDir, activity: NOW - 60_000 });
  const there = await data.save({
    id: "default-there", name: "Default there", cwd: otherProject, dir: otherDir, activity: NOW - 120_000,
  });

  const host = new HistoryHost({ cwd: data.cwd, columns: 160, rows: 16 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Default here") && !text.includes("Loading"));
  assert.doesNotMatch(host.text(), /Default there/, "默认存储下当前目录范围只包含本项目");

  host.press("\t");
  await host.waitFor((text) => text.includes("Default there") && !text.includes("Loading"));
  assert.match(host.text(), /Default here/);
  assert.match(host.text(), /other-project/);

  host.press("\u001b[B");
  assert.match(host.text(), /› Default there/);
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [there]);
});

test("线程、最近与相关性排序按原生规则切换并保留父子层级", async (t) => {
  const data = await world(t);
  const parent = await data.save({
    id: "parent", name: "Parent task", activity: NOW - 100_000,
    firstMessage: "tail text that keeps going before needle appears at the very end",
  });
  await data.save({ id: "child-b", name: "Child B", activity: NOW - 200_000, parentSession: parent });
  await data.save({ id: "child-a", name: "Child A", activity: NOW - 300_000, parentSession: parent });
  await data.save({ id: "other", name: "Other task", activity: NOW - 400_000, firstMessage: "needle at the top" });

  const host = new HistoryHost({ ...data, rows: 20 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Child A") && !text.includes("Loading"));

  // 线程模式：根与子节点按子树最新活动时间排序，并显示层级前缀。
  assert.match(host.text(), /Sort: Threaded/);
  assert.ok(lineIndex(host, "Parent task") < lineIndex(host, "Other task"), "父会话子树更新时排在其它根之前");
  assert.ok(lineIndex(host, "Child B") < lineIndex(host, "Child A"), "子节点按活动时间降序");
  assert.match(frameLine(host, "Child B"), /├─ Child B/);
  assert.match(frameLine(host, "Child A"), /└─ Child A/);

  // 最近模式：平面列表按活动时间降序，不带层级前缀。
  host.press("\u0013");
  assert.match(host.text(), /Sort: Recent/);
  const recentOrder = ["Parent task", "Child B", "Child A", "Other task"].map((name) => lineIndex(host, name));
  assert.deepEqual(recentOrder, [...recentOrder].sort((a, b) => a - b));
  assert.doesNotMatch(host.text(), /├─|└─/);

  // 最近模式搜索：只过滤，保持活动时间顺序。
  type(host, "re:needle");
  assert.match(host.text(), /Parent task/);
  assert.match(host.text(), /Other task/);
  assert.doesNotMatch(host.text(), /Child [AB]/);
  assert.ok(lineIndex(host, "Parent task") < lineIndex(host, "Other task"), "最近模式搜索保持活动时间顺序");

  // 相关性模式：按匹配位置升序，正文开头命中的会话排前。
  host.press("\u0013");
  assert.match(host.text(), /Sort: Fuzzy/);
  assert.ok(lineIndex(host, "Other task") < lineIndex(host, "Parent task"), "相关性排序把更靠前的命中排前");

  // 线程模式带查询时也按相关性排序，清空查询后恢复层级。
  host.press("\u0013");
  assert.match(host.text(), /Sort: Threaded/);
  assert.ok(lineIndex(host, "Other task") < lineIndex(host, "Parent task"));
  clearQuery(host);
  await host.waitFor((text) => text.includes("Child A"));
  assert.match(frameLine(host, "Child A"), /└─ Child A/);

  host.press("\u001b");
  await command;
});

test("仅已命名筛选只显示命名会话，空结果时提示切回并保持可恢复", async (t) => {
  const data = await world(t);
  const named = await data.save({ id: "named", name: "Named session", firstMessage: "Named request", activity: NOW - 120_000 });
  await data.save({ id: "unnamed", firstMessage: "Unnamed request", activity: NOW - 60_000 });

  const host = new HistoryHost({ ...data, rows: 16 });
  t.after(() => host.close());
  let command = host.open();
  await host.waitFor((text) => text.includes("Named session") && text.includes("Unnamed request") && !text.includes("Loading"));
  host.press("\u000e");
  assert.match(host.text(), /Name: Named/);
  assert.match(host.text(), /› Named session/);
  assert.doesNotMatch(host.text(), /Unnamed request/);
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [named]);

  // 没有任何命名会话时，筛选结果为空并给出提示；确认无效果，切回后仍可恢复。
  const empty = await world(t);
  const plain = await empty.save({ id: "plain", firstMessage: "Plain request" });
  const emptyHost = new HistoryHost({ ...empty, rows: 16 });
  t.after(() => emptyHost.close());
  command = emptyHost.open();
  await emptyHost.waitFor((text) => text.includes("Plain request") && !text.includes("Loading"));
  emptyHost.press("\u000e");
  assert.match(emptyHost.text(), /No named sessions in current folder/);
  emptyHost.press("\r");
  assert.equal(emptyHost.text().includes("Plain request"), false);
  assert.deepEqual(emptyHost.switches, []);
  emptyHost.press("\u000e");
  assert.match(emptyHost.text(), /› Plain request/);
  emptyHost.press("\r");
  await command;
  assert.deepEqual(emptyHost.switches, [plain]);
});

test("路径显示开关与全部范围的工作目录信息按原生样式附加，不挤掉标题与当前会话标识", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const data = await world(t);
  const current = await data.save({ id: "current", name: "Current session", activity: NOW - 60_000 });
  await data.save({
    id: "other", name: "Other session", cwd: `${data.root}/another-project`, activity: NOW - 120_000,
  });

  const host = new HistoryHost({ ...data, current, columns: 320, rows: 16 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Current session") && !text.includes("Loading"));
  assert.doesNotMatch(host.text(), /another-project/);
  assert.doesNotMatch(host.text(), /\.jsonl/);

  host.press("\t");
  await host.waitFor((text) => text.includes("Other session") && !text.includes("Loading"));
  assert.match(frameLine(host, "Other session"), /another-project\s+2m/);

  host.press("\u0010");
  assert.match(host.text(), /path \(on\)/);
  assert.match(frameLine(host, "Other session"), /other\.jsonl.*another-project\s+2m/);
  assert.match(frameLine(host, "Current session"), /current\.jsonl.*1m/);

  // 当前会话仍使用原生强调色，且标题与时间保持在同一行内。
  const currentLine = host.frame.find((line) => stripAnsi(line).includes("Current session"))!;
  assert.ok(currentLine.includes(host.theme.fg("accent", "Current session")));

  host.press("\u0010");
  assert.match(host.text(), /path \(off\)/);
  assert.doesNotMatch(host.text(), /\.jsonl/);

  for (const [width, height] of [[60, 14], [30, 10], [12, 7]]) {
    host.resize(width, height);
    assert.ok(host.frame.every((line) => visibleWidth(line) <= width), `宽度 ${width} 不应越界`);
    assert.ok(host.frame.length < height);
    // 附加信息被截断时优先保留相对时间。
    if (width >= 30) assert.match(host.text(), /2m/, `宽度 ${width} 时应保留相对时间`);
  }

  host.press("\u001b");
  await command;
});

test("范围、排序、筛选与路径开关使用宿主重绑定的原生动作快捷键", async (t) => {
  const data = await world(t);
  const target = await data.save({ id: "target", name: "Bound target", activity: NOW - 120_000 });
  await data.save({ id: "unnamed", firstMessage: "Unnamed other", activity: NOW - 60_000 });

  const host = new HistoryHost({ ...data, rows: 16, bindings: {
    "tui.input.tab": "t",
    "app.session.toggleSort": "s",
    "app.session.toggleNamedFilter": "n",
    "app.session.togglePath": "p",
    "tui.select.up": "k", "tui.select.down": "j",
    "tui.select.pageUp": "u", "tui.select.pageDown": "d",
    "tui.select.confirm": "x", "tui.select.cancel": "q",
  } });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Bound target") && !text.includes("Loading"));

  assert.match(host.text(), /t scope/);
  assert.match(host.text(), /s sort/);
  assert.match(host.text(), /n named/);
  assert.match(host.text(), /p path \(off\)/);

  host.press("t");
  await host.waitFor((text) => text.includes("History (All)") && !text.includes("Loading"));
  host.press("t");
  await host.waitFor((text) => text.includes("History (Current Folder)") && !text.includes("Loading"));

  host.press("s");
  assert.match(host.text(), /Sort: Recent/);
  host.press("s");
  assert.match(host.text(), /Sort: Fuzzy/);
  host.press("s");
  assert.match(host.text(), /Sort: Threaded/);

  host.press("n");
  assert.match(host.text(), /Name: Named/);
  assert.doesNotMatch(host.text(), /Unnamed other/);
  host.press("n");
  assert.match(host.text(), /Unnamed other/);

  host.press("p");
  assert.match(host.text(), /p path \(on\)/);

  host.press("j");
  assert.match(host.text(), /› Bound target/);
  host.press("x");
  await command;
  assert.deepEqual(host.switches, [target]);
});

test("范围切换期间迟到的旧范围结果不会替换当前列表", async (t) => {  const data = await world(t);
  await data.save({ id: "here", name: "Here only", activity: NOW - 60_000 });
  await data.save({ id: "elsewhere", name: "Elsewhere only", cwd: `${data.root}/another-project`, activity: NOW - 120_000 });

  const allSessions: SessionInfo[] = await SessionManager.listAll(data.sessionDir);
  const loaded = deferred();
  const release = deferred();
  t.mock.method(SessionManager, "listAll", async () => {
    loaded.resolve();
    await release.promise;
    return allSessions;
  });

  const host = new HistoryHost({ ...data, rows: 16 });
  t.after(() => { host.close(); release.resolve(); });
  const command = host.open();
  await host.waitFor((text) => text.includes("Here only") && !text.includes("Loading"));

  host.press("\t");
  await loaded.promise;
  assert.match(host.text(), /History \(All\)/);
  assert.match(host.text(), /Loading sessions/);

  host.press("\t");
  assert.match(host.text(), /History \(Current Folder\)/);
  assert.match(host.text(), /Here only/);
  assert.doesNotMatch(host.text(), /Elsewhere only/);

  release.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(host.text(), /Here only/, "当前范围列表应保持不变");
  assert.doesNotMatch(host.text(), /Elsewhere only/, "迟到的旧范围结果不应替换当前列表");

  host.press("\u001b");
  await command;
});

test("输入查询时不动选择，随后到达的完整结果仍按会话身份保留选中项", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const data = await world(t);
  await data.save({ id: "newer", name: "Newer task", activity: NOW - 60_000 });
  const older = await data.save({ id: "older", name: "Older task", activity: NOW - 120_000 });

  const read = SessionManager.list.bind(SessionManager);
  const published = deferred();
  const release = deferred();
  t.mock.method(SessionManager, "list", async (...[cwd, dir, progress, signal]: Parameters<typeof SessionManager.list>) => {
    const sessions = await read(cwd, dir, undefined, signal);
    progress?.(1, 2, sessions.slice(1)); // 先发布较旧的会话，稍后再发布完整结果
    published.resolve();
    await release.promise;
    return sessions;
  });

  const host = new HistoryHost({ ...data, rows: 16 });
  t.after(() => { host.close(); release.resolve(); });
  const command = host.open();
  await published.promise;
  assert.match(host.text(), /› Older task/);

  // 输入查询不移动选择；完整结果到达后仍应选中同一个会话，而不是回到第一项。
  type(host, "task");
  release.resolve();
  await host.waitFor((text) => text.includes("Newer task"));
  assert.match(host.text(), /› Older task/);

  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [older]);
});

test("查询后确认恢复可见目标，扩展不注册或替换原生 /resume", async (t) => {
  const data = await world(t);
  const parent = await data.save({ id: "parent-cn", name: "中文父会话 🚀", firstMessage: "父会话起始请求", activity: NOW - 300_000 });
  const child = await data.save({
    id: "child-cn", firstMessage: "子会话 follow-up 请求", activity: NOW - 120_000, parentSession: parent,
  });
  await data.save({ id: "unrelated", name: "Unrelated task", cwd: `${data.root}/another-project`, activity: NOW - 60_000 });

  const host = new HistoryHost({ ...data, rows: 16 });
  t.after(() => host.close());
  assert.deepEqual([...host.commands.keys()], ["history"]);
  assert.equal(host.commands.has("resume"), false, "不得注册或替换原生 /resume");

  const command = host.open();
  await host.waitFor((text) => text.includes("子会话") && !text.includes("Loading"));
  assert.match(frameLine(host, "子会话"), /└─ 子会话/);
  type(host, "\"follow-up\"");
  assert.match(host.text(), /› 子会话/);
  assert.doesNotMatch(host.text(), /中文父会话/);
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [child]);
  assert.equal(host.activeSession.getSessionFile(), child);
});

test("中文与 emoji 查询结果在缩放和主题变化后仍可读且选中项可见", async (t) => {
  const data = await world(t);
  await data.save({ id: "chinese", name: "中文会话 🚀 计划", firstMessage: "部署管线检查", activity: NOW - 60_000 });
  await data.save({ id: "other", name: "Other task", firstMessage: "Unrelated request", activity: NOW - 120_000 });

  const host = new HistoryHost({ ...data, columns: 100, rows: 16 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("中文会话") && !text.includes("Loading"));

  type(host, "部署");
  assert.match(host.text(), /› 中文会话 🚀 计划/);
  assert.doesNotMatch(host.text(), /Other task/);

  host.changeTheme(makeTheme("#ee4488"));
  const selectedLine = host.frame.find((line) => stripAnsi(line).includes("› 中文会话"))!;
  assert.ok(selectedLine.includes(host.theme.getFgAnsi("accent")));
  assert.ok(selectedLine.includes(host.theme.getBgAnsi("selectedBg")));

  for (const [width, height] of [[80, 14], [24, 8], [10, 6], [2, 4]]) {
    host.resize(width, height);
    assert.ok(host.frame.every((line) => visibleWidth(line) <= width), `宽度 ${width} 不应越界`);
    assert.ok(host.frame.length < height, `高度 ${height} 时不应占满终端`);
    assert.ok(host.text().includes("›"), "选中项应保持可见");
  }

  host.press("\u001b");
  await command;
});
