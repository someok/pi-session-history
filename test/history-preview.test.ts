import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HistoryHost, NOW, deferred, makeTheme, world } from "./host.ts";
import { SessionFileReader } from "../src/session-details.ts";

// 原地消息预览（最后用户消息）的行为测试；沿用 test/host.ts 的公开入口 seam。

const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const UP = "\u001b[A";
const DOWN = "\u001b[B";
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
function skillBlock(name: string, options: { body?: string; args?: string; location?: string } = {}): string {
  const location = options.location ?? `/skills/${name}/SKILL.md`;
  const body = options.body ?? `${name} full instructions`;
  const block = `<skill name="${name}" location="${location}">\nReferences are relative to /skills/${name}.\n\n${body}\n</skill>`;
  return options.args ? `${block}\n\n${options.args}` : block;
}

function image(): Record<string, unknown> {
  return { type: "image", data: "AA==", mimeType: "image/png" };
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
  // 列表末尾会接着空行、位置提示或分隔横线，它们不属于任何会话行。
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

test("列表 → 展开选中项、← 收起，重复操作幂等且 Enter 始终恢复会话", async (t) => {
  const data = await world(t);
  const target = await data.save({ id: "alpha", name: "Alpha task", activity: NOW - 60_000, messages: [
    user("Alpha first request", NOW - 5_000),
    assistant("Alpha reply", NOW - 4_000),
    user("Alpha preview body", NOW - 3_000),
  ] });
  await data.save({ id: "beta", name: "Beta task", activity: NOW - 120_000, messages: [
    user("Beta preview body", NOW - 5_000),
    assistant("Beta reply", NOW - 4_000),
  ] });

  const host = new HistoryHost({ ...data, columns: 80, rows: 24 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Alpha task") && text.includes("Beta task") && !text.includes("Loading"));

  const alpha = () => row(host, "Alpha task", ["Beta task"]);
  assert.equal(alpha().length, 2, "默认只显示两行");
  assert.doesNotMatch(host.text(), /Alpha preview body/);
  assert.match(host.text(), /→\/← preview/, "提示行应说明左右键用于预览");

  host.press(RIGHT);
  assert.deepEqual(alpha().slice(2), ["  │ Alpha preview body"], "→ 展开最后用户消息");
  assert.equal(alpha().filter((line) => line.includes("│")).length, 1, "只有消息体左侧显示竖线标记");
  const selectedPreview = host.frame.find((line) => stripAnsi(line).includes("│ Alpha preview body"))!;
  assert.ok(selectedPreview.includes(host.theme.getBgAnsi("selectedBg")), "选中项的竖线与消息体同样使用选中背景");
  assert.equal(host.placements.length, 1, "展开不应打开其他视图");

  host.press(RIGHT);
  assert.equal(alpha().filter((line) => line.includes("Alpha preview body")).length, 1, "重复展开幂等");

  host.press(LEFT);
  assert.equal(alpha().length, 2, "← 收起预览");
  host.press(LEFT);
  assert.equal(alpha().length, 2, "重复收起幂等");

  host.press(RIGHT);
  await host.waitFor((text) => text.includes("Alpha preview body"));
  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [target], "Enter 始终恢复选中会话");
});

test("查询非空时左右键仍优先展开收起，Ctrl+B/Ctrl+F 仍可编辑查询", async (t) => {
  const data = await world(t);
  await data.save({ id: "editable", name: "Editable task", activity: NOW - 60_000, messages: [
    user("Editable first request", NOW - 5_000),
    assistant("Editable reply", NOW - 4_000),
    user("Editable preview body", NOW - 3_000),
  ] });
  const host = new HistoryHost({ ...data, columns: 100, rows: 20 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Editable task") && !text.includes("Loading"));

  type(host, "editable");
  assert.equal(searchLine(host), "> editable");
  host.press(RIGHT);
  assert.match(host.text(), /Editable preview body/, "查询非空时 → 仍展开预览");
  assert.equal(searchLine(host), "> editable", "→ 不应改动查询");
  host.press(LEFT);
  assert.doesNotMatch(host.text(), /Editable preview body/, "查询非空时 ← 仍收起预览");
  assert.equal(searchLine(host), "> editable", "← 不应改动查询");

  host.press("\u0002"); // Ctrl+B：光标左移
  host.press("X");
  assert.equal(searchLine(host), "> editablXe", "Ctrl+B 仍移动搜索光标");
  host.press("\u0002");
  host.press("\u0006"); // Ctrl+F：光标右移
  host.press("Y");
  assert.equal(searchLine(host), "> editablXYe", "Ctrl+F 仍移动搜索光标");
  host.press("\u0015"); // Ctrl+U：清空查询
  await host.waitFor((text) => text.includes("Editable task"));

  host.press("\u001b");
  await command;
  assert.deepEqual(host.switches, []);
});

test("按记录顺序选取最后 user，仅图片的最后一条仍被选中，无 user 有明确提示", async (t) => {
  const data = await world(t);
  // 列表顺序取最后一条 user/assistant 消息的 timestamp；预览来源取记录顺序。
  // 时间戳更早但记录顺序在后的 user 才是预览来源。
  await data.save({ id: "order", name: "Record order", activity: NOW - 3_950, messages: [
    user("earlier record with later timestamp", NOW - 4_000),
    assistant("reply", NOW - 3_950),
    user("later record with earlier timestamp", NOW - 4_500),
  ], extraEntries: [
    // compaction 记录不是 user 消息，不得充当预览来源。
    { type: "compaction", id: "compaction", parentId: "entry-2", timestamp: new Date(NOW).toISOString(),
      summary: "COMPACTION SUMMARY TEXT", firstKeptEntryId: "entry-1", tokensBefore: 100 },
  ] });
  // 其它历史分支的记录顺序在主分支之后；custom_message 不是 user 消息。
  await data.save({ id: "branch", name: "Late branch", activity: NOW - 4_900, messages: [
    user("main branch text", NOW - 5_000),
    assistant("reply", NOW - 4_900),
  ], extraEntries: [
    { type: "message", id: "branch-entry", parentId: "entry-1", timestamp: new Date(NOW).toISOString(),
      message: user("branch user message", NOW - 6_000) },
    { type: "custom_message", id: "custom-entry", parentId: "branch-entry", timestamp: new Date(NOW).toISOString(),
      customType: "ext.injected", content: "extension injected content", display: false },
  ] });
  await data.save({ id: "image-only", name: "Image only last", activity: NOW - 6_900, messages: [
    user("older text request", NOW - 7_000),
    assistant("reply", NOW - 6_950),
    user([image()], NOW - 6_900),
  ] });
  await data.save({ id: "no-user", name: "Assistant only", activity: NOW - 7_900, messages: [
    assistant("unsolicited reply", NOW - 7_900),
  ] });

  const host = new HistoryHost({ ...data, columns: 100, rows: 30 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Record order") && !text.includes("Loading"));

  host.press(RIGHT);
  assert.deepEqual(preview(host, "Record order", ["Late branch"]),
    ["  │ later record with earlier timestamp"], "应按记录顺序而非时间戳选择最后 user");
  assert.doesNotMatch(host.text(), /earlier record with later timestamp|COMPACTION SUMMARY TEXT/);

  host.press(DOWN);
  host.press(RIGHT);
  assert.deepEqual(preview(host, "Late branch", ["Image only last"]), ["  │ branch user message"],
    "应包含其它历史分支且不把 custom_message 当作 user");
  assert.doesNotMatch(host.text(), /main branch text|extension injected content/);

  host.press(DOWN);
  host.press(RIGHT);
  assert.deepEqual(preview(host, "Image only last", ["Assistant only"]), ["  │ [1 image]"],
    "仅含图片的最后 user 仍被选中，不回退到更早的文本");
  assert.doesNotMatch(host.text(), /older text request/);

  host.press(DOWN);
  host.press(RIGHT);
  assert.deepEqual(preview(host, "Assistant only"), ["  │ No user message"]);

  host.press("\u001b");
  await command;
});

test("已识别的技能注入简化为技能名称，疑似但无法识别的技能块保留文本", async (t) => {
  const data = await world(t);
  await data.save({ id: "skill-args", name: "Skill with request", activity: NOW - 2_000, messages: [
    user(skillBlock("pdf-tools", { body: "SECRET SKILL BODY", args: "extract report.pdf\nkeep this layout" }), NOW - 2_000),
  ] });
  await data.save({ id: "skill-only", name: "Skill only", activity: NOW - 3_000, messages: [
    user(skillBlock("code-review", { body: "SECRET REVIEW BODY" }), NOW - 3_000),
  ] });
  await data.save({ id: "unknown-skill", name: "Unknown skill block", activity: NOW - 4_000, messages: [
    user('<skill name="mystery">unrecognized body</skill>', NOW - 4_000),
  ] });
  const host = new HistoryHost({ ...data, columns: 100, rows: 24 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Skill with request") && !text.includes("Loading"));

  host.press(RIGHT);
  assert.deepEqual(preview(host, "Skill with request", ["Skill only"]), [
    "  │ [skill] pdf-tools",
    "  │ extract report.pdf",
    "  │ keep this layout",
  ], "技能加正文应简化为技能名称并保留用户请求");
  assert.doesNotMatch(host.text(), /SECRET SKILL BODY|References are relative/);

  host.press(DOWN);
  host.press(RIGHT);
  assert.deepEqual(preview(host, "Skill only", ["Unknown skill block"]), ["  │ [skill] code-review"],
    "只有技能时仍显示技能名称");
  assert.doesNotMatch(host.text(), /SECRET REVIEW BODY/);

  host.press(DOWN);
  host.press(RIGHT);
  assert.deepEqual(preview(host, "Unknown skill block"), ['  │ <skill name="mystery">unrecognized body</skill>'],
    "无法识别的疑似技能块保留原文，避免误删正文");

  host.press("\u001b");
  await command;
});

test("技能与图片组合显示技能名称和数量提示，不渲染图片数据", async (t) => {
  const data = await world(t);
  await data.save({ id: "skill-image", name: "Skill with image", activity: NOW - 2_000, messages: [
    user([{ type: "text", text: skillBlock("vision", { body: "SECRET VISION BODY", args: "describe it" }) }, image()], NOW - 2_000),
  ] });
  await data.save({ id: "two-images", name: "Two images", activity: NOW - 3_000, messages: [
    user([image(), image(), { type: "text", text: "two attachments" }], NOW - 3_000),
  ] });
  const host = new HistoryHost({ ...data, columns: 100, rows: 20 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Skill with image") && !text.includes("Loading"));

  host.press(RIGHT);
  assert.deepEqual(preview(host, "Skill with image", ["Two images"]),
    ["  │ [skill] vision", "  │ describe it", "  │ [1 image]"], "技能加附件应同时显示技能名称与附件数量");
  assert.doesNotMatch(host.text(), /SECRET VISION BODY|AA==/);

  host.press(DOWN);
  host.press(RIGHT);
  assert.deepEqual(preview(host, "Two images"), ["  │ two attachments", "  │ [2 images]"],
    "多张图片显示数量提示，不渲染图片数据");
  assert.doesNotMatch(host.text(), /AA==|data:image/);

  host.press("\u001b");
  await command;
});

test("正文与换行保留、按宽度自动换行，最多 6 个显示行且超出时有截断提示", async (t) => {
  const data = await world(t);
  const nineLines = Array.from({ length: 9 }, (_, index) => `preview-line-${index + 1}`).join("\n");
  await data.save({ id: "nine", name: "Nine lines", activity: NOW - 2_000, messages: [
    user(nineLines, NOW - 2_000),
  ] });
  await data.save({ id: "six", name: "Six lines", activity: NOW - 3_000, messages: [
    user(Array.from({ length: 6 }, (_, index) => `exact-line-${index + 1}`).join("\n"), NOW - 3_000),
  ] });
  await data.save({ id: "cjk", name: "CJK line", activity: NOW - 4_000, messages: [
    user("中文内容很长".repeat(8), NOW - 4_000),
  ] });
  const host = new HistoryHost({ ...data, columns: 40, rows: 44 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Nine lines") && !text.includes("Loading"));

  host.press(RIGHT);
  assert.deepEqual(preview(host, "Nine lines", ["Six lines"]), [
    "  │ preview-line-1", "  │ preview-line-2", "  │ preview-line-3",
    "  │ preview-line-4", "  │ preview-line-5", "  │ preview-line-6",
    "  │ … preview truncated",
  ], "超出 6 行时截断并给出提示");
  assert.doesNotMatch(host.text(), /preview-line-7/);

  host.press(DOWN);
  host.press(RIGHT);
  assert.deepEqual(preview(host, "Six lines", ["CJK line"]), [
    "  │ exact-line-1", "  │ exact-line-2", "  │ exact-line-3",
    "  │ exact-line-4", "  │ exact-line-5", "  │ exact-line-6",
  ], "正好 6 行不截断");

  host.press(DOWN);
  host.press(RIGHT);
  const wrapped = preview(host, "CJK line");
  assert.ok(wrapped.length >= 2 && wrapped.length <= 6, `中文正文应按宽度换行：${JSON.stringify(wrapped)}`);
  assert.ok(wrapped.every((line) => visibleWidth(line) <= 40), "换行后不应越界");
  assert.ok(!wrapped.includes("  │ … preview truncated"), "按宽度换行后未超出上限时不显示截断提示");
  assert.ok(host.frame.every((line) => visibleWidth(line) <= 40));

  host.press("\u001b");
  await command;
});

test("允许多项同时展开，移动/搜索/排序/范围切换保持关联，关闭后重置", async (t) => {
  const data = await world(t);
  await data.save({ id: "alpha", name: "Alpha", activity: NOW - 2_000, messages: [
    user("alpha preview text", NOW - 2_000),
  ] });
  await data.save({ id: "beta", name: "Beta", activity: NOW - 3_000, messages: [
    user("beta preview text", NOW - 3_000),
  ] });
  await data.save({ id: "gamma", name: "Gamma", activity: NOW - 4_000, messages: [
    user("gamma preview text", NOW - 4_000),
  ] });
  const host = new HistoryHost({ ...data, columns: 120, rows: 30 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Alpha") && !text.includes("Loading"));

  host.press(RIGHT);
  host.press(DOWN);
  host.press(RIGHT);
  assert.match(host.text(), /alpha preview text/);
  assert.match(host.text(), /beta preview text/);

  host.press(DOWN);
  host.press(UP);
  assert.match(host.text(), /alpha preview text/);
  assert.match(host.text(), /beta preview text/, "移动选中项不应收起其他项");

  host.press(DOWN); // 到 Gamma
  host.press(RIGHT);
  host.press(UP);
  assert.match(host.text(), /gamma preview text/);

  type(host, "gamma");
  assert.match(host.text(), /gamma preview text/, "筛选后仍展开到正确的会话");
  assert.doesNotMatch(host.text(), /alpha preview text|beta preview text/);
  host.press("\u0015");
  await host.waitFor((text) => text.includes("alpha preview text") && text.includes("gamma preview text"));

  host.press("\u0013"); // Ctrl+S：切换排序
  assert.match(host.text(), /alpha preview text/);
  assert.match(host.text(), /gamma preview text/, "排序切换后展开状态按会话身份保留");

  host.press("\t"); // Tab：切换范围
  await host.waitFor((text) => text.includes("History (All)") && !text.includes("Loading"));
  assert.match(host.text(), /alpha preview text/);
  assert.match(host.text(), /gamma preview text/, "范围切换后展开状态按会话身份保留");

  host.press("\u001b");
  await command;

  const reopened = host.open();
  await host.waitFor((text) => text.includes("Alpha") && !text.includes("Loading"));
  assert.doesNotMatch(host.text(), /preview text/, "重新打开默认收起，不沿用上次展开状态");
  host.press("\u001b");
  await reopened;
});

test("变高列表按可用高度滚动，选中项完整可见且上下与分页可用", async (t) => {
  const data = await world(t);
  for (let index = 1; index <= 6; index++) {
    await data.save({
      id: `row-${index}`,
      name: `Row ${String(index).padStart(2, "0")}`,
      activity: NOW - index * 60_000,
      messages: [user(`preview of row ${index}`, NOW - index * 60_000 + 1_000)],
    });
  }
  const host = new HistoryHost({ ...data, columns: 60, rows: 16 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Row 01") && !text.includes("Loading"));
  assert.match(host.text(), /› Row 01/);

  // 收起状态下分页按当前可见的会话条数移动。
  host.press("\u001b[6~"); // PageDown
  assert.doesNotMatch(host.text(), /› Row 01/);
  host.press("\u001b[5~"); // PageUp
  assert.match(host.text(), /› Row 01/);
  host.press(DOWN);
  assert.match(host.text(), /› Row 02/);

  // 展开后行高变化：选中项两行加预览完整可见，输出不越界。
  host.press(UP);
  host.press(RIGHT);
  host.press(DOWN);
  host.press(RIGHT);
  const selected = /› (Row \d\d)/.exec(host.text());
  assert.ok(selected, "展开后选中项应仍可见");
  const [, name] = selected;
  const index = Number(name.slice(5));
  assert.match(host.text(), new RegExp(`› ${name}[^\\n]*\\n[^\\n]*1 msgs[^\\n]*\\n[^\\n]*preview of row ${index}`),
    "选中项的标题、第二行与预览应完整可见");
  assert.ok(host.frame.length < host.terminal.rows, "应为上方会话内容保留空间");
  assert.ok(host.frame.every((line) => visibleWidth(line) <= 60));

  host.resize(30, 10);
  assert.ok(host.frame.every((line) => visibleWidth(line) <= 30));
  assert.ok(host.frame.length < 10);
  assert.match(host.text(), /›/);

  host.press("\u001b");
  await command;
});

test("预览未就绪显示加载态，单条读取失败只影响该项", async (t) => {
  const data = await world(t);
  const broken = await data.save({ id: "broken", name: "Broken preview", activity: NOW - 3_500, messages: [
    user("BROKEN PREVIEW BODY", NOW - 3_500),
  ] });
  await data.save({ id: "good", name: "Good preview", activity: NOW - 2_500, messages: [
    user("GOOD PREVIEW BODY", NOW - 3_000),
    assistant("Good reply", NOW - 2_500),
  ] });

  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  const gate = deferred();
  t.mock.method(SessionFileReader, "lines", async function* (path: string, signal?: AbortSignal) {
    if (path === broken) throw new Error("Controlled preview failure");
    await gate.promise;
    yield* realLines(path, signal);
  });

  const host = new HistoryHost({ ...data, columns: 100, rows: 20 });
  t.after(() => { host.close(); gate.resolve(); });
  const command = host.open();
  await host.waitFor((text) => text.includes("Broken preview") && text.includes("Good preview"));

  host.press(RIGHT);
  await host.waitFor((text) => text.includes("Loading message preview..."));
  assert.doesNotMatch(host.text(), /BROKEN PREVIEW BODY|No user message|preview truncated/,
    "加载态不得用其它结果冒充");

  host.press(DOWN);
  host.press(RIGHT);
  await host.waitFor((text) => text.includes("Could not load message preview."));
  assert.match(host.text(), /Could not load session details/);

  gate.resolve();
  await host.waitFor((text) => text.includes("GOOD PREVIEW BODY") && !text.includes("Loading details"));
  assert.doesNotMatch(host.text(), /BROKEN PREVIEW BODY/, "失败项不显示预览正文");
  assert.match(host.text(), /2 msgs · openai\/gpt-4.1-mini/, "其他会话仍正常读取");

  host.press("\u001b");
  await command;
});

test("关闭后停止读取且迟到结果不更新界面，重新打开重新读取且不另存正文", async (t) => {
  const data = await world(t);
  const path = await data.save({ id: "gated", name: "Gated preview", activity: NOW - 2_000, messages: [
    user("LATE PREVIEW TEXT", NOW - 3_000),
    assistant("Gated reply", NOW - 2_000),
  ] });
  const before = await readFile(path, "utf8");

  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  const gate = deferred();
  let seenSignal: AbortSignal | undefined;
  t.mock.method(SessionFileReader, "lines", async function* (file: string, signal?: AbortSignal) {
    seenSignal = signal;
    await gate.promise;
    yield* realLines(file, signal);
  });

  const host = new HistoryHost({ ...data, columns: 100, rows: 20 });
  t.after(() => { host.close(); gate.resolve(); });
  let command = host.open();
  await host.waitFor((text) => text.includes("Gated preview"));
  host.press(RIGHT);
  await host.waitFor((text) => text.includes("Loading message preview..."));

  host.press("\u001b");
  await command;
  assert.equal(seenSignal?.aborted, true, "关闭选择器应中止未完成的读取");
  gate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.lateOutput, false, "关闭后迟到的预览结果不得再更新旧界面");
  assert.equal(host.text(), "Original editor");

  t.mock.restoreAll();
  command = host.open();
  await host.waitFor((text) => text.includes("2 msgs · openai/gpt-4.1-mini"));
  assert.doesNotMatch(host.text(), /LATE PREVIEW TEXT/, "重新打开默认收起，不沿用上次展开状态");
  host.press(RIGHT);
  await host.waitFor((text) => text.includes("LATE PREVIEW TEXT"));
  host.press("\u001b");
  await command;
  assert.equal(await readFile(path, "utf8"), before, "预览不修改也不另存会话内容");
});

test("展开预览在中文、emoji、窄宽度、缩放和主题变化后不越界", async (t) => {
  const data = await world(t);
  await data.save({ id: "unicode", name: "Unicode preview", activity: NOW - 2_000, messages: [
    user("中文预览🚀 e\u0301 👨‍👩‍👧‍👦 混合文本\n第二行\t制表符\u001b[2J控制", NOW - 2_000),
  ] });
  const host = new HistoryHost({ ...data, columns: 120, rows: 20 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Unicode preview") && !text.includes("Loading"));
  host.press(RIGHT);
  await host.waitFor((text) => text.includes("中文预览🚀"));

  for (const [width, height] of [[40, 12], [20, 10], [9, 8], [2, 5], [120, 20]] as const) {
    host.resize(width, height);
    assert.ok(host.frame.every((line) => visibleWidth(line) <= width), `宽度 ${width} 不应越界`);
    assert.ok(host.frame.every((line) => !stripAnsi(line).includes("\t")), "控制字符不应直接输出");
    assert.ok(host.frame.length < height, `高度 ${height} 时列表应为会话内容保留空间`);
    assert.ok(host.text().includes("›"), "缩放后选中项仍应可见");
  }

  host.changeTheme(makeTheme("#ee4488"));
  assert.ok(host.frame.every((line) => visibleWidth(line) <= host.terminal.columns));
  assert.match(host.text(), /中文预览🚀/);

  host.press("\u001b");
  await command;
});
