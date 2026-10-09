import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HistoryHost, NOW, deferred, makeTheme, world } from "./host.ts";
import { SessionFileReader } from "../src/session-details.ts";

// Ctrl+O 只读消息全文视图的行为测试；沿用 test/host.ts 的公开入口 seam。

const CTRL_O = "\u000f";
const ESCAPE = "\u001b";
const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";
const CURSOR_MARKER = "\u001b_pi:c\u0007";

function user(content: unknown, timestamp: number): Record<string, unknown> {
  return { role: "user", content, timestamp };
}

function assistant(text: string, timestamp: number): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4.1-mini",
    stopReason: "stop",
    timestamp,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

/** pi 技能命令的展开格式：技能块加上用户请求 args。 */
function skillBlock(name: string, options: { body?: string; args?: string } = {}): string {
  const body = options.body ?? `${name} full instructions`;
  const block = `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n${body}\n</skill>`;
  return options.args ? `${block}\n\n${options.args}` : block;
}

function image(): Record<string, unknown> {
  return { type: "image", data: "AA==", mimeType: "image/png" };
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`).join("\n");
}

function type(host: HistoryHost, text: string): void {
  for (const char of text) host.press(char);
}

/** 可见的搜索框内容；去掉光标标记与行尾填充。 */
function searchLine(host: HistoryHost): string {
  const line = host.frame.find((candidate) => stripAnsi(candidate).startsWith(">"));
  assert.ok(line, `应渲染搜索框：\n${host.text()}`);
  return stripAnsi(line).replaceAll(CURSOR_MARKER, "").trimEnd();
}

/** 取某条会话从标题行到下一个已知标题前的可见行。 */
function row(host: HistoryHost, title: string, others: readonly string[] = []): string[] {
  const start = host.frame.findIndex((line) => stripAnsi(line).includes(title));
  assert.ok(start >= 0, `未找到会话 ${title}：\n${host.text()}`);
  const isLayoutLine = (text: string) => {
    const trimmed = text.trim();
    return trimmed === "" || /^[─]+$/.test(trimmed) || /^\(\d+\/\d+\)$/.test(trimmed);
  };
  let end = host.frame.length;
  for (let index = start + 1; index < host.frame.length; index++) {
    const text = stripAnsi(host.frame[index]);
    if (isLayoutLine(text) || others.some((other) => text.includes(other))) {
      end = index;
      break;
    }
  }
  return host.frame.slice(start, end)
    .map((line) => stripAnsi(line).replaceAll(CURSOR_MARKER, "").trimEnd());
}

/** 展开行的预览行（跳过标题行与第二行增强信息）。 */
function preview(host: HistoryHost, title: string, others: readonly string[] = []): string[] {
  return row(host, title, others).slice(2);
}

/** 把选中项移动到指定会话；不依赖同活动时间会话间的稳定顺序。 */
function select(host: HistoryHost, title: string): void {
  const isSelected = () => new RegExp(`› ${title}`).test(host.text());
  for (let step = 0; step < 20 && !isSelected(); step++) host.press(DOWN);
  for (let step = 0; step < 20 && !isSelected(); step++) host.press(UP);
  assert.ok(isSelected(), `未选中会话 ${title}：\n${host.text()}`);
}

/** 全文视图当前可见的正文行；测试正文由固定宽度的 line-NN 构成。 */
function messageLines(host: HistoryHost): string[] {
  return host.frame
    .map((line) => stripAnsi(line).replaceAll(CURSOR_MARKER, "").trim())
    .filter((line) => /^line-\d\d$/.test(line));
}

function expectFits(host: HistoryHost, width: number, height: number): void {
  assert.ok(host.frame.every((line) => visibleWidth(line) <= width), `宽度 ${width} 不应越界：\n${host.text()}`);
  assert.ok(host.frame.length < height, `高度 ${height} 时全文应为会话内容保留空间：\n${host.text()}`);
}

test("列表 Ctrl+O 直接打开选中会话全文，不受 6 行上限，Esc 返回后 Enter 仍恢复该会话", async (t) => {
  const data = await world(t);
  const alpha = await data.save({ id: "alpha", name: "Alpha task", activity: NOW - 60_000, messages: [
    user("Alpha first request", NOW - 5_000),
    assistant("Alpha reply", NOW - 4_000),
    user(numberedLines(12), NOW - 3_000),
  ] });
  await data.save({ id: "beta", name: "Beta task", activity: NOW - 120_000, messages: [
    user("beta body", NOW - 5_000),
  ] });

  const host = new HistoryHost({ ...data, columns: 80, rows: 24 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Alpha task") && text.includes("Beta task") && !text.includes("Loading"));

  assert.equal(row(host, "Alpha task", ["Beta task"]).length, 2, "默认不展开也能打开全文");
  select(host, "Alpha task");
  host.press(CTRL_O);
  assert.match(host.text(), /Full message/, "全文视图应有明确标题");
  assert.match(host.text(), /Alpha task/, "全文视图应标明正在阅读的会话");
  assert.doesNotMatch(host.text(), /Beta task/, "全文视图不显示其它会话");
  assert.doesNotMatch(host.text(), /→\/← preview/, "全文视图替换列表并给出自己的提示");
  assert.doesNotMatch(host.text(), /Ctrl\+O full message/, "全文完整显示时不出现截断提示");
  assert.deepEqual(messageLines(host), Array.from({ length: 12 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`),
    "全文不受 6 行上限，完整显示所有正文行");
  expectFits(host, 80, 24);

  host.press(ESCAPE);
  assert.equal(row(host, "Alpha task", ["Beta task"]).length, 2, "返回列表后仍保持收起状态");
  assert.match(host.text(), /→\/← preview/, "Esc 返回列表");
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [alpha], "列表 Enter 仍恢复选中会话");
});

test("Ctrl+O 与展开状态无关，切换选中项后打开的是当前选中会话，返回保留展开", async (t) => {
  const data = await world(t);
  await data.save({ id: "alpha", name: "Alpha task", activity: NOW - 60_000, messages: [
    user("alpha preview body", NOW - 5_000),
  ] });
  await data.save({ id: "beta", name: "Beta task", activity: NOW - 120_000, messages: [
    user("beta full body ".repeat(6), NOW - 5_000),
  ] });

  const host = new HistoryHost({ ...data, columns: 80, rows: 20 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Alpha task") && text.includes("Beta task") && !text.includes("Loading"));

  // 已展开时 Ctrl+O 仍打开全文，且返回后展开状态保留。
  select(host, "Alpha task");
  host.press(RIGHT);
  assert.deepEqual(preview(host, "Alpha task", ["Beta task"]), ["  │ alpha preview body"]);
  host.press(CTRL_O);
  assert.match(host.text(), /alpha preview body/);
  host.press(ESCAPE);
  assert.deepEqual(preview(host, "Alpha task", ["Beta task"]), ["  │ alpha preview body"], "返回后展开状态保留");

  // 移动选中项后打开全文，操作对象是新的选中会话。
  select(host, "Beta task");
  assert.match(host.text(), /› Beta task/);
  host.press(CTRL_O);
  assert.match(host.text(), /beta full body/);
  assert.doesNotMatch(host.text(), /alpha preview body/, "全文只显示当前选中会话的正文");

  host.press(ESCAPE);
  assert.deepEqual(preview(host, "Alpha task", ["Beta task"]), ["  │ alpha preview body"], "其它会话的展开状态不受影响");
  assert.equal(row(host, "Beta task", ["Alpha task"]).filter((line) => line.includes("│")).length, 0,
    "未展开过的会话返回后仍收起");
  assert.equal(searchLine(host), ">", "全文操作不改动搜索框");
  host.press(ESCAPE);
  await command;
  assert.deepEqual(host.switches, []);
});

test("全文沿用预览的最后 user、技能简化与图片提示口径，无 user 与读取失败反馈一致", async (t) => {
  const data = await world(t);
  await data.save({ id: "skill", name: "Skill task", activity: NOW - 2_000, messages: [
    user(skillBlock("pdf-tools", { body: "SECRET SKILL BODY", args: "extract report.pdf" }), NOW - 2_000),
    assistant("ASSISTANT SECRET", NOW - 2_000),
  ] });
  const images = await data.save({ id: "images", name: "Image task", activity: NOW - 3_000, messages: [
    user([image(), image()], NOW - 3_000),
  ] });
  await data.save({ id: "no-user", name: "No user task", activity: NOW - 4_000, messages: [
    assistant("unsolicited reply", NOW - 4_000),
  ] });
  const broken = await data.save({ id: "broken", name: "Broken task", activity: NOW - 5_000, messages: [
    user("BROKEN FULL BODY", NOW - 5_000),
  ] });
  await data.save({ id: "empty", name: "Empty task", activity: NOW - 6_000, messages: [
    user("", NOW - 6_000),
  ] });
  const before = await readFile(images, "utf8");

  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  t.mock.method(SessionFileReader, "lines", async function* (path: string, signal?: AbortSignal) {
    if (path === broken) throw new Error("Controlled full message failure");
    yield* realLines(path, signal);
  });

  const host = new HistoryHost({ ...data, columns: 100, rows: 24 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Skill task") && !text.includes("Loading"));

  host.press(CTRL_O);
  assert.match(host.text(), /\[skill\] pdf-tools/);
  assert.match(host.text(), /extract report\.pdf/);
  assert.doesNotMatch(host.text(), /SECRET SKILL BODY|References are relative|ASSISTANT SECRET/,
    "全文不重新塞回技能注入正文与其它角色消息");

  host.press(ESCAPE);
  select(host, "Image task");
  host.press(CTRL_O);
  assert.match(host.text(), /\[2 images\]/, "图片只提示数量");
  assert.doesNotMatch(host.text(), /AA==|data:image/, "不渲染图片数据");

  host.press(ESCAPE);
  select(host, "No user task");
  host.press(CTRL_O);
  assert.match(host.text(), /No user message/);

  host.press(ESCAPE);
  select(host, "Broken task");
  host.press(CTRL_O);
  assert.match(host.text(), /Could not load message preview\./);
  assert.doesNotMatch(host.text(), /BROKEN FULL BODY/, "读取失败不冒充正文");

  host.press(ESCAPE);
  select(host, "Empty task");
  host.press(CTRL_O);
  assert.match(host.text(), /\(empty message\)/, "空正文仍给出可退出的反馈");
  assert.doesNotMatch(host.text(), /No user message/);

  host.press(ESCAPE);
  host.press(ESCAPE);
  await command;
  assert.equal(await readFile(images, "utf8"), before, "全文视图不修改也不另存会话内容");
});

test("全文超屏时上下键逐行、PageUp/PageDown 分页，缩放后重新排版且不越界", async (t) => {
  const data = await world(t);
  await data.save({ id: "long", name: "Long task", activity: NOW - 2_000, messages: [
    user(numberedLines(40), NOW - 2_000),
  ] });

  const host = new HistoryHost({ ...data, columns: 40, rows: 22 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Long task") && !text.includes("Loading"));

  host.press(CTRL_O);
  assert.deepEqual(messageLines(host), Array.from({ length: 14 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`),
    "高终端一次可见超过 6 行正文");
  assert.match(host.text(), /\(1\/40\)/, "内容超出时显示位置提示");
  expectFits(host, 40, 22);

  host.resize(40, 12);
  assert.deepEqual(messageLines(host), Array.from({ length: 6 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`),
    "缩放后按新的可用高度重新排版");
  expectFits(host, 40, 12);

  host.press(DOWN);
  assert.deepEqual(messageLines(host), Array.from({ length: 6 }, (_, index) => `line-${String(index + 2).padStart(2, "0")}`),
    "↓ 逐行滚动");
  assert.match(host.text(), /\(2\/40\)/);

  host.press(PAGE_DOWN);
  assert.deepEqual(messageLines(host), Array.from({ length: 6 }, (_, index) => `line-${String(index + 8).padStart(2, "0")}`),
    "PageDown 按可见行数翻页");
  assert.match(host.text(), /\(8\/40\)/);

  for (let press = 0; press < 5; press++) host.press(PAGE_DOWN);
  assert.match(host.text(), /line-40/, "可以遍历到正文末尾");
  assert.match(host.text(), /\(35\/40\)/, "到达末尾后夹紧偏移");
  host.press(PAGE_DOWN);
  assert.match(host.text(), /\(35\/40\)/, "到底后继续 PageDown 不再滚动");

  host.press(UP);
  assert.match(host.text(), /\(34\/40\)/);
  for (let press = 0; press < 6; press++) host.press(PAGE_UP);
  assert.match(host.text(), /\(1\/40\)/, "回到顶部后继续 PageUp 不再滚动");
  expectFits(host, 40, 12);

  host.press(ESCAPE);
  host.press(ESCAPE);
  await command;
});

test("Esc 返回后搜索、范围、筛选、选中、展开、焦点与可见位置完全一致", async (t) => {
  const data = await world(t);
  for (let index = 1; index <= 6; index++) {
    await data.save({
      id: `row-${index}`,
      name: `Row ${String(index).padStart(2, "0")}`,
      activity: NOW - index * 2_000,
      messages: [user(`preview of row ${index}`, NOW - index * 2_000)],
    });
  }

  const host = new HistoryHost({ ...data, columns: 60, rows: 13 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Row 01") && text.includes("(1/6)") && !text.includes("Loading"));

  type(host, "row");
  select(host, "Row 01");
  host.press(RIGHT);
  select(host, "Row 02");
  host.press(RIGHT);
  select(host, "Row 03");
  host.press("\u0013"); // Ctrl+S：切换排序
  host.press("\u000e"); // Ctrl+N：仅已命名筛选
  host.press("\u0010"); // Ctrl+P：显示路径
  await host.waitFor((text) => !text.includes("Loading"));
  const before = [...host.frame];
  assert.match(host.text(), /› Row 03/, "先滚动到列表中部的选中项");

  host.press(CTRL_O);
  assert.match(host.text(), /Full message/);
  host.press(ESCAPE);
  assert.deepEqual(host.frame, before, "返回后列表状态、焦点与可见位置逐行一致");

  host.press("\r");
  await command;
  assert.equal(host.switches.length, 1, "返回后 Enter 仍恢复原选中会话");
});

test("全文只读：Enter、字符、删除与列表动作都不会改变界面或恢复会话", async (t) => {
  const data = await world(t);
  const alpha = await data.save({ id: "alpha", name: "Alpha task", activity: NOW - 60_000, messages: [
    user("alpha full body", NOW - 60_000),
  ] });
  await data.save({ id: "beta", name: "Beta task", activity: NOW - 120_000, messages: [
    user("beta body", NOW - 120_000),
  ] });

  const host = new HistoryHost({ ...data, columns: 80, rows: 20 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Alpha task") && !text.includes("Loading"));

  select(host, "Alpha task");
  host.press(CTRL_O);
  assert.match(host.text(), /Full message/);
  const view = [...host.frame];
  for (const key of ["\r", "x", "\u007f", "\u0013", "\u000e", "\u0010", "\u0004", CTRL_O, RIGHT, LEFT, "\t", "\u0015"]) {
    host.press(key);
  }
  assert.deepEqual(host.frame, view, "只读视图按键不改变正文与界面");
  assert.deepEqual(host.switches, []);
  assert.deepEqual(host.notifications, []);

  host.press(ESCAPE);
  assert.equal(searchLine(host), ">", "全文中的字符输入不进入搜索框");
  assert.match(host.text(), /› Alpha task/, "全文按键不移动列表选中项");
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [alpha], "返回列表后 Enter 仍恢复正确会话");
});

test("加载未完成也能打开并就地补齐；返回后迟到结果不重开旧视图，重开显示新选中项", async (t) => {
  const data = await world(t);
  const gatedOpen = await data.save({ id: "open", name: "Gated open", activity: NOW - 2_000, messages: [
    user("GATED OPEN BODY", NOW - 2_000),
  ] });
  const gatedBack = await data.save({ id: "back", name: "Gated back", activity: NOW - 3_000, messages: [
    user("GATED BACK BODY", NOW - 3_000),
  ] });
  const ready = await data.save({ id: "ready", name: "Ready task", activity: NOW - 4_000, messages: [
    user("READY BODY", NOW - 4_000),
  ] });

  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  const gates = new Map([[gatedOpen, deferred()], [gatedBack, deferred()]]);
  t.mock.method(SessionFileReader, "lines", async function* (path: string, signal?: AbortSignal) {
    await gates.get(path)?.promise;
    yield* realLines(path, signal);
  });

  const host = new HistoryHost({ ...data, columns: 80, rows: 20 });
  t.after(() => { host.close(); for (const gate of gates.values()) gate.resolve(); });
  const command = host.open();
  await host.waitFor((text) => text.includes("Gated open") && text.includes("Ready task"));

  // 读取未完成就打开全文：先给出加载态，读取完成后就地补齐。
  select(host, "Gated open");
  host.press(CTRL_O);
  await host.waitFor((text) => text.includes("Loading message preview..."));
  assert.match(host.text(), /Full message/);
  assert.doesNotMatch(host.text(), /GATED OPEN BODY|No user message/);
  gates.get(gatedOpen)!.resolve();
  await host.waitFor((text) => text.includes("GATED OPEN BODY"));
  host.press(ESCAPE);

  // 读取未完成就返回：迟到结果只更新列表，不重开旧全文视图。
  select(host, "Gated back");
  assert.match(host.text(), /› Gated back/);
  host.press(CTRL_O);
  await host.waitFor((text) => text.includes("Loading message preview..."));
  host.press(ESCAPE);
  assert.match(host.text(), /→\/← preview/);
  gates.get(gatedBack)!.resolve();
  await host.waitFor((text) => !text.includes("Loading"));
  assert.doesNotMatch(host.text(), /Full message/, "迟到结果不抢回旧视图");
  assert.match(host.text(), /› Gated back/, "返回后选中项仍是打开全文的那条");
  host.press(RIGHT);
  await host.waitFor((text) => text.includes("GATED BACK BODY"));
  assert.doesNotMatch(host.text(), /Full message/, "正文只在列表中就绪");

  // 切换选中项后重开全文：内容属于新的选中会话。
  select(host, "Ready task");
  host.press(CTRL_O);
  assert.match(host.text(), /READY BODY/);
  assert.doesNotMatch(host.text(), /GATED BACK BODY/);
  host.press(ESCAPE);
  select(host, "Gated back");
  host.press(CTRL_O);
  assert.match(host.text(), /GATED BACK BODY/);

  host.press(ESCAPE);
  host.press(ESCAPE);
  await command;
});

test("全文在中文、emoji、窄宽度、小高度、缩放与主题变化后滚动正确且不越界", async (t) => {
  const data = await world(t);
  const body = Array.from({ length: 30 }, (_, index) => `第${index + 1}行中文🚀 e\u0301 👨‍👩‍👧‍👦\t制表符`).join("\n");
  await data.save({ id: "unicode", name: "Unicode task", activity: NOW - 2_000, messages: [
    user(body, NOW - 2_000),
  ] });

  const host = new HistoryHost({ ...data, columns: 120, rows: 20 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Unicode task") && !text.includes("Loading"));

  host.press(CTRL_O);
  assert.match(host.text(), /第1行中文🚀/, "全文保留中文与 emoji 正文");
  assert.ok(host.frame.every((line) => !stripAnsi(line).includes("\t")), "控制字符不应直接输出");

  for (const [width, height] of [[40, 12], [20, 10], [9, 8], [2, 5], [120, 24]] as const) {
    host.resize(width, height);
    expectFits(host, width, height);
    host.press(DOWN);
    host.press(PAGE_DOWN);
    expectFits(host, width, height);
  }

  host.resize(120, 24);
  assert.match(host.text(), /Full message/, "缩放后仍在全文视图");
  assert.match(host.text(), /scroll/, "全文视图提示仍在");
  for (let press = 0; press < 4; press++) host.press(PAGE_DOWN);
  assert.match(host.text(), /第30行中文🚀/, "缩放到高终端后仍能滚动到末尾");

  host.changeTheme(makeTheme("#ee4488"));
  expectFits(host, 120, 24);
  assert.match(host.text(), /第30行中文🚀/, "主题变化不影响全文内容");

  host.press(ESCAPE);
  host.press(ESCAPE);
  await command;
});
