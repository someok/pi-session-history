import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HistoryHost, NOW, deferred, world } from "./host.ts";
import { SessionFileReader } from "../src/session-details.ts";

// 大量会话下的渐进浏览、可见项优先与异步竞态测试；沿用 test/host.ts 的公开入口 seam。

const ESCAPE = "\u001b";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const RIGHT = "\u001b[C";
const CTRL_O = "\u000f";
const CTRL_N = "\u000e";
const CTRL_P = "\u0010";
const CTRL_S = "\u0013";
const CTRL_U = "\u0015";

function type(host: HistoryHost, text: string): void {
  for (const char of text) host.press(char);
}

function userMessage(text: string, timestamp: number): Record<string, unknown> {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(timestamp: number): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Reply" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4.1-mini",
    stopReason: "stop",
    timestamp,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

/** 返回标题行与紧随其后的第二行（去掉 ANSI）。 */
function rowLines(host: HistoryHost, title: string): [string, string] {
  const index = host.frame.findIndex((line) => stripAnsi(line).includes(title));
  assert.ok(index >= 0, `未找到会话 ${title}：\n${host.text()}`);
  return [stripAnsi(host.frame[index]), stripAnsi(host.frame[index + 1] ?? "<缺失>")];
}

/** 第二行是否已显示增强信息，而不是加载态。 */
function detailsReady(host: HistoryHost, title: string): boolean {
  const index = host.frame.findIndex((line) => stripAnsi(line).includes(title));
  if (index < 0) return false;
  const line = stripAnsi(host.frame[index + 1] ?? "");
  return !line.includes("Loading details") && line.includes("msgs");
}

/**
 * 推迟列表结果的发布：真实读取完成后才通过真实 progress 回调一次性发布完整结果，
 * 使增强信息的排队顺序与列表顺序一致，同时保留真实查询与渲染链。
 */
function publishOnce(t: TestContext): void {
  const read = SessionManager.list.bind(SessionManager);
  t.mock.method(SessionManager, "list", async (...[cwd, dir, progress, signal]: Parameters<typeof SessionManager.list>) => {
    const sessions = await read(cwd, dir, undefined, signal);
    progress?.(sessions.length, sessions.length, sessions);
    return sessions;
  });
}

/** 推进事件循环，让已排队的微任务与立即回调完成；等待真实进展，不使用固定时长。 */
async function settle(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * 挂起指定会话的逐行读取，模拟慢文件；被抢占时按中止信号结束。
 * 未挂起的会话仍走真实读取，消息数、最后回复模型与最后用户消息不替换。
 */
function holdReads(
  held: readonly string[],
  gate: { promise: Promise<void>; resolve(): void },
  started: string[],
) {
  const heldPaths = new Set(held);
  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  return async function* (path: string, signal?: AbortSignal) {
    if (heldPaths.has(path)) {
      started.push(path);
      await abortable(gate.promise, signal);
    }
    yield* realLines(path, signal);
  };
}

/** 等待 signal 中止或 gate 释放，两者谁先到就以谁为准。 */
function abortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

test("可见项优先：滚动后新可见的会话无需等待不可见项的慢读取", async (t) => {
  const data = await world(t);
  publishOnce(t);
  const paths: string[] = [];
  for (let index = 0; index < 8; index++) {
    paths.push(await data.save({
      id: `ordered-${index}`,
      name: `Ordered session ${index}`,
      activity: NOW - (index + 1) * 60_000,
    }));
  }
  const gate = deferred();
  const started: string[] = [];
  // 除最后一条外全部挂起；滚动到它时必须抢占已不可见的慢读取才能补齐。
  t.mock.method(SessionFileReader, "lines", holdReads(paths.slice(0, 7), gate, started));

  const host = new HistoryHost({ ...data, columns: 120, rows: 18 });
  t.after(() => { host.close(); gate.resolve(); });
  const command = host.open();
  await host.waitFor((text) => text.includes("Ordered session 0") && text.includes("Loading details"));
  // 等至少一条不可见项的慢读取开始，形成“队列被占用”的前提；测试不核对内部并发数。
  for (let turn = 0; turn < 50 && started.length === 0; turn++) await settle(1);
  assert.ok(started.length > 0, `前置条件：慢读取已开始\n${host.text()}`);

  for (let step = 0; step < 7; step++) host.press(DOWN);
  await host.waitFor(() => detailsReady(host, "Ordered session 7"));
  assert.match(rowLines(host, "Ordered session 6")[1], /Loading details/,
    "仍被挂起的邻近会话保持加载态，不阻塞目标项");

  // 释放慢读取并回到顶部：被让位的读取按后台优先级补读，不会永久丢失。
  gate.resolve();
  for (let step = 0; step < 7; step++) host.press(UP);
  await host.waitFor(() => detailsReady(host, "Ordered session 0"));

  host.press(ESCAPE);
  await command;
});

test("加载期间打开全文：目标会话优先补齐，返回后列表状态保持", async (t) => {
  const data = await world(t);
  publishOnce(t);
  const paths: string[] = [];
  for (let index = 0; index < 8; index++) {
    paths.push(await data.save({
      id: `full-${index}`,
      name: `Full session ${index}`,
      activity: NOW - (index + 1) * 60_000,
      ...(index === 7
        ? { messages: [
            { role: "user", content: "FULL MESSAGE BODY", timestamp: NOW - 481_000 },
            { role: "assistant", content: [{ type: "text", text: "Reply" }], api: "openai-responses",
              provider: "openai", model: "gpt-4.1-mini", stopReason: "stop", timestamp: NOW - 480_000,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
          ] }
        : {}),
    }));
  }
  const gate = deferred();
  const started: string[] = [];
  t.mock.method(SessionFileReader, "lines", holdReads(paths.slice(0, 7), gate, started));

  const host = new HistoryHost({ ...data, columns: 120, rows: 18 });
  t.after(() => { host.close(); gate.resolve(); });
  const command = host.open();
  await host.waitFor((text) => text.includes("Full session 0") && text.includes("Loading details"));
  await settle();

  for (let step = 0; step < 7; step++) host.press(DOWN);
  host.press(CTRL_O);
  await host.waitFor((text) => text.includes("Full message") && text.includes("FULL MESSAGE BODY"));
  assert.doesNotMatch(host.text(), /Loading message preview/,
    "全文目标优先读取，不等待不可见项的慢读取");

  // 返回列表后选中项与加载中的邻居保持原状。
  host.press(ESCAPE);
  await host.waitFor((text) => text.includes("Full session 7") && text.includes("History (Current Folder)"));
  assert.match(rowLines(host, "Full session 6")[1], /Loading details/);
  host.press(ESCAPE);
  await command;
});

test("增强信息全部未就绪时列表仍可搜索、选择与恢复", async (t) => {
  const data = await world(t);
  const target = await data.save({ id: "pick-me", name: "Pick target", activity: NOW - 60_000 });
  const other = await data.save({ id: "other-one", name: "Other session", activity: NOW - 120_000 });
  const gate = deferred();
  const started: string[] = [];
  t.mock.method(SessionFileReader, "lines", holdReads([target, other], gate, started));

  const host = new HistoryHost({ ...data, columns: 120, rows: 18 });
  t.after(() => { host.close(); gate.resolve(); });
  const command = host.open();
  await host.waitFor((text) => text.includes("Pick target") && text.includes("Loading details"));

  // 用会话身份的正则避免临时路径中的随机字符造成模糊匹配干扰。
  type(host, "re:^pick-me");
  assert.match(host.text(), /› Pick target/);
  assert.doesNotMatch(host.text(), /Other session/);
  assert.match(rowLines(host, "Pick target")[1], /Loading details/,
    "查询与选择不依赖增强信息就绪");

  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [target]);
});

test("读取未完成时切换查询或筛选，迟到结果不会让不再匹配的条目回来", async (t) => {
  const data = await world(t);
  publishOnce(t);
  await data.save({ id: "named-alpha", name: "Named Alpha", activity: NOW - 60_000 });
  const beta = await data.save({ id: "unnamed-beta", firstMessage: "Unnamed Beta", activity: NOW - 120_000 });
  const delta = await data.save({ id: "unnamed-delta", firstMessage: "Unnamed Delta", activity: NOW - 180_000 });
  const betaGate = deferred();
  const deltaGate = deferred();
  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  t.mock.method(SessionFileReader, "lines", async function* (path: string, signal?: AbortSignal) {
    // 两个未命名会话分别挂起，用于验证查询与筛选切换后的迟到结果。
    if (path === beta) await abortable(betaGate.promise, signal);
    else if (path === delta) await abortable(deltaGate.promise, signal);
    yield* realLines(path, signal);
  });

  const host = new HistoryHost({ ...data, columns: 140, rows: 24 });
  t.after(() => { host.close(); betaGate.resolve(); deltaGate.resolve(); });
  const command = host.open();
  await host.waitFor((text) => text.includes("Unnamed Beta") && text.includes("Unnamed Delta")
    && text.includes("Loading details"));

  // 查询：Beta 不再匹配时读取尚未完成；正则按会话身份匹配，不受临时路径干扰。
  type(host, "re:^named-alpha");
  assert.doesNotMatch(host.text(), /Unnamed Beta/);
  betaGate.resolve();
  await settle();
  assert.doesNotMatch(host.text(), /Unnamed Beta/, "迟到的增强信息不能让不再匹配查询的条目回来");
  assert.ok(detailsReady(host, "Named Alpha"), "当前结果仍按最新状态渲染");

  // 筛选：切到仅已命名后 Delta 被过滤，读取才完成。
  host.press(CTRL_U);
  await host.waitFor((text) => text.includes("Unnamed Beta") && text.includes("Unnamed Delta"));
  host.press(CTRL_N);
  assert.match(host.text(), /Name: Named/);
  assert.doesNotMatch(host.text(), /Unnamed Delta/);
  deltaGate.resolve();
  await settle();
  assert.doesNotMatch(host.text(), /Unnamed Delta/, "迟到的增强信息不能让被筛掉的条目回来");

  // 切回后两个未命名会话重新出现，并使用已经读取到的结果。
  host.press(CTRL_N);
  await host.waitFor((text) => text.includes("Unnamed Beta") && text.includes("Unnamed Delta")
    && !text.includes("Loading details"));

  host.press(ESCAPE);
  await command;
});

test("读取未完成时切换范围，迟到结果不会让当前范围外的条目回来", async (t) => {
  const data = await world(t);
  publishOnce(t);
  const here = await data.save({ id: "here-one", name: "Here session", activity: NOW - 60_000 });
  const there = await data.save({
    id: "there-one",
    name: "Elsewhere session",
    cwd: `${data.root}/another-project`,
    activity: NOW - 120_000,
  });
  const gate = deferred();
  t.mock.method(SessionFileReader, "lines", holdReads([here, there], gate, []));

  const host = new HistoryHost({ ...data, columns: 140, rows: 20 });
  t.after(() => { host.close(); gate.resolve(); });
  const command = host.open();
  await host.waitFor((text) => text.includes("Here session") && text.includes("Loading details"));

  // 两个会话的读取都未完成时切到全部范围，再切回当前目录。
  host.press("\t");
  await host.waitFor((text) => text.includes("History (All)") && text.includes("Elsewhere session"));
  host.press("\t");
  await host.waitFor((text) => text.includes("History (Current Folder)") && !text.includes("Elsewhere session"));

  // 迟到的增强信息不能让范围外的会话重新出现；当前范围的结果正常生效。
  gate.resolve();
  await host.waitFor((text) => text.includes("Here session") && !text.includes("Loading details"));
  assert.doesNotMatch(host.text(), /Elsewhere session/, "迟到结果不能让当前范围外的条目回来");
  assert.match(host.text(), /History \(Current Folder\)/);

  host.press(ESCAPE);
  await command;
});

test("加载中更换全文目标：迟到结果不覆盖另一会话正文", async (t) => {
  const data = await world(t);
  publishOnce(t);
  const first = await data.save({
    id: "first-target",
    name: "First target",
    activity: NOW - 60_000,
    messages: [userMessage("FIRST BODY", NOW - 5_000), assistantMessage(NOW - 4_000)],
  });
  const second = await data.save({
    id: "second-target",
    name: "Second target",
    activity: NOW - 120_000,
    messages: [userMessage("SECOND BODY", NOW - 125_000), assistantMessage(NOW - 124_000)],
  });
  const firstGate = deferred();
  const secondGate = deferred();
  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  t.mock.method(SessionFileReader, "lines", async function* (path: string, signal?: AbortSignal) {
    if (path === first) await abortable(firstGate.promise, signal);
    else if (path === second) await abortable(secondGate.promise, signal);
    yield* realLines(path, signal);
  });

  const host = new HistoryHost({ ...data, columns: 120, rows: 20 });
  t.after(() => { host.close(); firstGate.resolve(); secondGate.resolve(); });
  const command = host.open();
  await host.waitFor((text) => text.includes("First target") && text.includes("Loading details"));

  // 读取未完成时先打开第一项全文，再返回并换上第二项。
  host.press(CTRL_O);
  await host.waitFor((text) => text.includes("Full message") && text.includes("First target")
    && text.includes("Loading message preview"));
  host.press(ESCAPE);
  await host.waitFor((text) => text.includes("History (Current Folder)") && text.includes("› First target"));
  host.press(DOWN);
  host.press(CTRL_O);
  await host.waitFor((text) => text.includes("Full message") && text.includes("Second target")
    && text.includes("Loading message preview"));

  // 第一项的迟到结果只能停留在自己的身份上，不覆盖当前全文。
  firstGate.resolve();
  await settle();
  assert.match(host.text(), /Full message[^\n]*Second target/, "标题仍属当前目标会话");
  assert.doesNotMatch(host.text(), /FIRST BODY/, "迟到结果不得覆盖另一会话正文");

  secondGate.resolve();
  await host.waitFor((text) => text.includes("SECOND BODY"));
  host.press(ESCAPE);
  await host.waitFor((text) => text.includes("History (Current Folder)"));
  host.press(ESCAPE);
  await command;
});

test("关闭后立即重开：上一轮的迟到读取不会进入新一轮交互", async (t) => {
  const data = await world(t);
  publishOnce(t);
  const path = await data.save({ id: "reopen-one", name: "Reopen session", activity: NOW - 60_000 });
  const firstGate = deferred();
  const secondGate = deferred();
  let reads = 0;
  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  t.mock.method(SessionFileReader, "lines", async function* (file: string, signal?: AbortSignal) {
    // 两轮各挂起一次：第一轮关闭后释放，第二轮用于确认新一轮仍在加载。
    if (file === path) {
      const gate = reads++ === 0 ? firstGate : secondGate;
      await abortable(gate.promise, signal);
    }
    yield* realLines(file, signal);
  });

  const host = new HistoryHost({ ...data, columns: 120, rows: 18 });
  t.after(() => { host.close(); firstGate.resolve(); secondGate.resolve(); });
  let command = host.open();
  await host.waitFor((text) => text.includes("Reopen session") && text.includes("Loading details"));
  host.press(ESCAPE);
  await command;

  // 立即重开：重新读取显示加载态，而不是沿用上一轮的结果。
  command = host.open();
  await host.waitFor((text) => text.includes("Reopen session") && text.includes("Loading details"));
  firstGate.resolve();
  await settle();
  assert.match(rowLines(host, "Reopen session")[1], /Loading details/,
    "上一轮的迟到结果不得应用到新一轮");

  secondGate.resolve();
  await host.waitFor(() => detailsReady(host, "Reopen session"));
  host.press(ESCAPE);
  await command;
});

test("组合回归：查询、范围、排序、筛选、路径与双行信息、预览、全文协同工作", async (t) => {
  const data = await world(t);
  publishOnce(t);
  const parent = await data.save({
    id: "parent",
    name: "Parent session",
    activity: NOW - 60_000,
    messages: [
      { role: "user", content: "PARENT BODY", timestamp: NOW - 5_000 },
      { role: "assistant", content: [{ type: "text", text: "Parent reply" }], api: "openai-responses",
        provider: "openai", model: "gpt-4.1-mini", stopReason: "stop", timestamp: NOW - 4_000,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    ],
  });
  const child = await data.save({
    id: "child",
    firstMessage: "CHILD BODY",
    parentSession: parent,
    activity: NOW - 120_000,
  });
  const elsewhere = await data.save({
    id: "elsewhere",
    name: "Elsewhere session",
    cwd: `${data.root}/another-project`,
    activity: NOW - 180_000,
  });

  const host = new HistoryHost({ ...data, columns: 160, rows: 24 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Parent session") && text.includes("CHILD BODY")
    && !text.includes("Loading details"));

  // 双行增强信息与线程层级同时可用。
  assert.match(rowLines(host, "Parent session")[1], /2 msgs · openai\/gpt-4.1-mini/);
  assert.match(rowLines(host, "CHILD BODY")[1], /2 msgs · openai\/gpt-4.1-mini/);

  // Ctrl+P 路径显示、Tab 范围切换、Ctrl+S 三种排序、Ctrl+N 命名筛选。
  host.press(CTRL_P);
  assert.match(host.text(), /p path \(on\)/);
  assert.match(host.text(), /pi-history-test-/);
  host.press(CTRL_P);
  assert.match(host.text(), /p path \(off\)/);
  host.press("\t");
  await host.waitFor((text) => text.includes("Elsewhere session") && text.includes("History (All)")
    && !text.includes("Loading"));
  assert.match(host.text(), /another-project/);
  host.press("\t");
  await host.waitFor((text) => text.includes("History (Current Folder)") && !text.includes("Elsewhere session"));
  host.press(CTRL_S);
  assert.match(host.text(), /Sort: Recent/);
  host.press(CTRL_S);
  assert.match(host.text(), /Sort: Fuzzy/);
  host.press(CTRL_S);
  assert.match(host.text(), /Sort: Threaded/);
  host.press(CTRL_N);
  assert.match(host.text(), /Name: Named/);
  assert.doesNotMatch(host.text(), /CHILD BODY/);
  host.press(CTRL_N);
  await host.waitFor((text) => text.includes("CHILD BODY"));

  // 正则查询、清空查询、展开预览、打开全文并返回。
  type(host, "re:child\\s+body");
  assert.match(host.text(), /› CHILD BODY/);
  assert.doesNotMatch(host.text(), /Parent session/);
  host.press(CTRL_U);
  await host.waitFor((text) => text.includes("Parent session") && text.includes("CHILD BODY"));

  host.press(DOWN); // 清空查询后回到线程视图，向下选中子会话
  assert.match(host.text(), /›\s+└─ CHILD BODY/);
  host.press(RIGHT);
  await host.waitFor((text) => text.includes("CHILD BODY"));
  assert.match(host.text(), /│ CHILD BODY/);
  host.press(CTRL_O);
  await host.waitFor((text) => text.includes("Full message") && text.includes("CHILD BODY"));
  host.press(ESCAPE);
  await host.waitFor((text) => text.includes("History (Current Folder)") && text.includes("│ CHILD BODY")
    && !text.includes("Full message"));

  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [child]);
  assert.equal(host.activeSession.getSessionFile(), child);
});
