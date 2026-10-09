import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HistoryHost, NOW, deferred, world } from "./host.ts";
import { SessionFileReader } from "../src/session-details.ts";

// 第二行增强信息（消息数、最后回复模型）的行为测试；沿用 test/host.ts 的公开入口 seam。

function userMessage(text: string, timestamp: number): Record<string, unknown> {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(options: {
  timestamp: number;
  model?: string;
  provider?: string;
  text?: string;
  stopReason?: string;
  content?: unknown[];
}): Record<string, unknown> {
  return {
    role: "assistant",
    content: options.content ?? [{ type: "text", text: options.text ?? "Reply" }],
    api: "openai-responses",
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    stopReason: options.stopReason ?? "stop",
    timestamp: options.timestamp,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function toolResultMessage(timestamp: number): Record<string, unknown> {
  return {
    role: "toolResult", toolCallId: "call-1", toolName: "bash",
    content: [{ type: "text", text: "tool output" }], timestamp,
    // 工具内部嵌套调用记录在工具结果上，不应额外增加消息数。
    nestedCalls: { calls: [{ id: "nested-1", name: "read", status: "ok" }], complete: true },
  };
}

/** 返回标题行与紧随其后的第二行（去掉 ANSI）。 */
function rowLines(host: HistoryHost, title: string): [string, string] {
  const index = host.frame.findIndex((line) => stripAnsi(line).includes(title));
  assert.ok(index >= 0, `未找到会话 ${title}：\n${host.text()}`);
  return [stripAnsi(host.frame[index]), stripAnsi(host.frame[index + 1] ?? "<缺失>")];
}

test("每条会话默认两行，第二行按消息数、provider/model 展示增强信息", async (t) => {
  const data = await world(t);
  await data.save({
    id: "mixed",
    name: "Mixed session",
    messages: [
      userMessage("First request", NOW - 5_000),
      assistantMessage({ timestamp: NOW - 4_000, model: "gpt-4.1-mini", provider: "openai", text: "First reply" }),
      toolResultMessage(NOW - 3_000),
      { role: "bashExecution", command: "ls", output: "files", exitCode: 0, cancelled: false,
        truncated: false, timestamp: NOW - 2_500 },
      { role: "user", content: "Second request", timestamp: NOW - 2_000 },
      assistantMessage({ timestamp: NOW - 1_000, model: "claude-sonnet-4", provider: "anthropic", text: "Second reply" }),
    ],
  });
  const host = new HistoryHost({ ...data, columns: 120 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Mixed session") && text.includes("4 msgs"));

  const [titleLine, infoLine] = rowLines(host, "Mixed session");
  assert.doesNotMatch(titleLine, /msgs/, "第一行不应再显示消息数");
  assert.match(infoLine, /4 msgs · anthropic\/claude-sonnet-4/, "第二行应展示消息数与 provider/model");
  assert.equal(host.text().match(/msgs/g)?.length, 1, "消息数不应重复显示");
  const selectedInfoLine = host.frame[host.frame.findIndex((line) => stripAnsi(line).includes("› Mixed session")) + 1];
  assert.ok(selectedInfoLine.includes(host.theme.getBgAnsi("selectedBg")), "选中项的第二行也应使用选中背景");

  host.press("\u001b");
  await command;
});

test("消息数只统计全历史 user + assistant，含分支、compaction 前记录与仅含工具调用的回复", async (t) => {
  const data = await world(t);
  await data.save({
    id: "branched",
    name: "Branched session",
    messages: [
      userMessage("start", NOW - 9_000),
      assistantMessage({ timestamp: NOW - 8_000, model: "gpt-4.1-mini", provider: "openai",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }] }),
      toolResultMessage(NOW - 7_000),
      userMessage("earlier branch point", NOW - 6_000),
      assistantMessage({ timestamp: NOW - 5_000, model: "gpt-4.1-mini", provider: "openai", text: "main reply" }),
      { role: "system", content: "System note", timestamp: NOW - 4_500 },
      { role: "custom", customType: "ext.note", content: "injected note", display: false, timestamp: NOW - 4_000 },
      userMessage("after compaction", NOW - 3_000),
      assistantMessage({ timestamp: NOW - 2_000, model: "gpt-4.1-mini", provider: "openai", text: "latest main reply" }),
    ],
    extraEntries: [
      { type: "compaction", id: "compaction-1", parentId: "entry-8", timestamp: new Date(NOW).toISOString(),
        summary: "summary", firstKeptEntryId: "entry-5", tokensBefore: 100 },
      { type: "model_change", id: "model-change", parentId: "entry-8", timestamp: new Date(NOW).toISOString(),
        provider: "openai", modelId: "gpt-5" },
      { type: "thinking_level_change", id: "thinking", parentId: "model-change",
        timestamp: new Date(NOW).toISOString(), thinkingLevel: "high" },
      { type: "usage", id: "usage", parentId: "thinking", timestamp: new Date(NOW).toISOString(),
        kind: "cache_warm", provider: "openai", model: "gpt-5", usage: {} },
      { type: "custom", id: "custom-entry", parentId: "usage", timestamp: new Date(NOW).toISOString(),
        customType: "ext.state", data: {} },
      { type: "label", id: "label", parentId: "custom-entry", timestamp: new Date(NOW).toISOString(),
        targetId: "entry-0", label: "start" },
      { type: "custom_message", id: "custom-message", parentId: "label", timestamp: new Date(NOW).toISOString(),
        customType: "ext.injected", content: "extension message", display: false },
      // 其它历史分支：记录顺序在最后，时间戳早于主分支，模型与主分支不同。
      { type: "message", id: "branch-entry", parentId: "entry-1", timestamp: new Date(NOW).toISOString(),
        message: assistantMessage({ timestamp: NOW - 8_500, model: "branch-model", provider: "branch-provider",
          text: "branch reply" }) },
    ],
  });
  const host = new HistoryHost({ ...data, columns: 120 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("7 msgs"));

  const [, infoLine] = rowLines(host, "Branched session");
  assert.match(infoLine, /7 msgs · branch-provider\/branch-model/,
    "应计入全历史 user + assistant（含分支与 compaction 前），并按记录顺序取最后一条 assistant");

  host.press("\u001b");
  await command;
});

test("最后回复模型取记录顺序最后一条 assistant，错误/中止不回退，缺失字段单独标记", async (t) => {
  const data = await world(t);
  await data.save({ id: "pending-model", name: "Waiting for model B", messages: [
    userMessage("first", NOW - 5_000),
    assistantMessage({ timestamp: NOW - 4_000, model: "model-a", provider: "provider-a", text: "A reply" }),
    userMessage("second", NOW - 3_000),
  ], extraEntries: [{
    type: "model_change", id: "switch", parentId: "entry-2", timestamp: new Date(NOW).toISOString(),
    provider: "provider-b", modelId: "model-b",
  }] });
  await data.save({ id: "virtual", name: "Virtual router", entries: [
    { type: "message", id: "v0", parentId: null, timestamp: new Date(NOW).toISOString(),
      message: userMessage("route me", NOW - 5_000) },
    { type: "model_change", id: "v1", parentId: "v0", timestamp: new Date(NOW).toISOString(),
      provider: "router", modelId: "virtual-router" },
    { type: "message", id: "v2", parentId: "v1", timestamp: new Date(NOW).toISOString(),
      message: assistantMessage({ timestamp: NOW - 4_000, model: "claude-sonnet-4", provider: "anthropic",
        text: "physical reply" }) },
    { type: "model_change", id: "v3", parentId: "v2", timestamp: new Date(NOW).toISOString(),
      provider: "router", modelId: "virtual-router" },
    { type: "session_info", id: "v4", parentId: "v3", timestamp: new Date(NOW).toISOString(), name: "Virtual router" },
  ] });
  await data.save({ id: "failed-last", name: "Failed last reply", messages: [
    userMessage("do something", NOW - 5_000),
    assistantMessage({ timestamp: NOW - 4_000, model: "model-ok", provider: "provider-ok", text: "worked" }),
    userMessage("again", NOW - 3_000),
    assistantMessage({ timestamp: NOW - 2_000, model: "model-bad", provider: "provider-bad",
      stopReason: "error", text: "failed" }),
  ] });
  await data.save({ id: "aborted-last", name: "Aborted last reply", messages: [
    userMessage("do something", NOW - 5_000),
    assistantMessage({ timestamp: NOW - 4_000, model: "model-ok", provider: "provider-ok", text: "worked" }),
    assistantMessage({ timestamp: NOW - 3_000, model: "model-stopped", provider: "provider-stopped",
      stopReason: "aborted", text: "stopped" }),
  ] });
  await data.save({ id: "no-assistant", name: "No assistant yet", messages: [
    userMessage("first", NOW - 5_000), userMessage("still waiting", NOW - 3_000),
  ] });
  await data.save({ id: "partial", name: "Partial metadata", messages: [
    userMessage("question", NOW - 5_000), assistantMessage({ timestamp: NOW - 4_000, model: "model-x" }),
  ] });
  await data.save({ id: "missing", name: "Missing metadata", messages: [
    userMessage("question", NOW - 5_000), assistantMessage({ timestamp: NOW - 4_000 }),
  ] });
  await data.save({ id: "empty", name: "Empty history", messages: [] });

  const host = new HistoryHost({ ...data, columns: 120, rows: 40 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("0 msgs") && text.includes("2 msgs · anthropic/claude-sonnet-4")
    && !text.includes("Loading details"));

  assert.match(rowLines(host, "Waiting for model B")[1], /3 msgs · provider-a\/model-a/,
    "后续选择 model B 但尚未产生回复时仍显示最后一次回复的模型");
  assert.match(rowLines(host, "Virtual router")[1], /2 msgs · anthropic\/claude-sonnet-4/,
    "虚拟模型场景应使用 assistant 记录的实际 provider/model");
  assert.match(rowLines(host, "Failed last reply")[1], /4 msgs · provider-bad\/model-bad/,
    "报错的最后一条 assistant 不回退到更早的成功回复");
  assert.match(rowLines(host, "Aborted last reply")[1], /3 msgs · provider-stopped\/model-stopped/,
    "中止的最后一条 assistant 不回退到更早的成功回复");
  assert.match(rowLines(host, "No assistant yet")[1], /2 msgs · No assistant message/);
  assert.match(rowLines(host, "Partial metadata")[1], /2 msgs · unknown\/model-x/);
  assert.match(rowLines(host, "Missing metadata")[1], /2 msgs · unknown\/unknown/);
  assert.match(rowLines(host, "Empty history")[1], /0 msgs · No assistant message/,
    "真实零消息与未就绪的加载态不同");

  host.press("\u001b");
  await command;
});

test("增强信息未就绪时显示加载态，就绪后才替换为真实数据", async (t) => {
  const data = await world(t);
  await data.save({ id: "gated", name: "Gated session" });

  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  const gate = deferred();
  t.mock.method(SessionFileReader, "lines", async function* (path: string, signal?: AbortSignal) {
    await gate.promise;
    yield* realLines(path, signal);
  });

  const host = new HistoryHost({ ...data, columns: 120 });
  t.after(() => { host.close(); gate.resolve(); });
  const command = host.open();
  await host.waitFor((text) => text.includes("Gated session"));

  assert.match(rowLines(host, "Gated session")[1], /Loading details/,
    "列表可用后、增强信息就绪前应显示加载态");
  assert.doesNotMatch(host.text(), /\d+ msgs|unknown|No assistant message/,
    "加载态不得用 0、unknown 或无消息冒充最终结果");

  gate.resolve();
  await host.waitFor((text) => text.includes("2 msgs · openai/gpt-4.1-mini"));
  host.press("\u001b");
  await command;
});

test("单条增强信息读取失败只标记该项，其他会话仍可选择和恢复", async (t) => {
  const data = await world(t);
  const good = await data.save({ id: "good", name: "Good session", activity: NOW - 60_000 });
  const broken = await data.save({ id: "broken", name: "Broken session", activity: NOW - 120_000 });

  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  t.mock.method(SessionFileReader, "lines", async function* (path: string, signal?: AbortSignal) {
    if (path === broken) throw new Error("Controlled read failure");
    yield* realLines(path, signal);
  });

  const host = new HistoryHost({ ...data, columns: 120 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => text.includes("Could not load session details")
    && text.includes("2 msgs · openai/gpt-4.1-mini"));

  assert.match(rowLines(host, "Broken session")[1], /Could not load session details/,
    "失败的会话只标记自己");
  assert.match(rowLines(host, "Good session")[1], /2 msgs · openai\/gpt-4.1-mini/,
    "同批会话不受单条失败影响");

  host.press("\r");
  await command;
  assert.deepEqual(host.switches, [good], "读取失败不影响其他会话的选择与恢复");
});

test("关闭后中止读取且迟到结果不更新旧界面，重新打开重新校验会话内容", async (t) => {
  const data = await world(t);
  const path = await data.save({ id: "changing", name: "Changing session", messages: [
    userMessage("question", NOW - 5_000),
    assistantMessage({ timestamp: NOW - 4_000, model: "model-old", provider: "provider-old", text: "old reply" }),
  ] });

  const realLines = SessionFileReader.lines.bind(SessionFileReader);
  const gate = deferred();
  let seenSignal: AbortSignal | undefined;
  t.mock.method(SessionFileReader, "lines", async function* (file: string, signal?: AbortSignal) {
    seenSignal = signal;
    await gate.promise;
    yield* realLines(file, signal);
  });

  const host = new HistoryHost({ ...data, columns: 120 });
  t.after(() => { host.close(); gate.resolve(); });
  let command = host.open();
  await host.waitFor((text) => text.includes("Changing session"));
  assert.match(rowLines(host, "Changing session")[1], /Loading details/);

  host.press("\u001b");
  await command;
  assert.equal(seenSignal?.aborted, true, "关闭选择器应中止未完成的读取");
  gate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.lateOutput, false, "关闭后迟到的增强信息不得再更新旧界面");
  assert.equal(host.text(), "Original editor");

  // 会话内容在两次打开之间发生变化：重新打开应重新读取，而不是使用陈旧缓存。
  await data.save({ id: "changing", name: "Changing session", messages: [
    userMessage("question", NOW - 4_000),
    assistantMessage({ timestamp: NOW - 3_000, model: "model-old", provider: "provider-old", text: "old reply" }),
    userMessage("follow-up", NOW - 2_000),
    assistantMessage({ timestamp: NOW - 1_000, model: "model-new", provider: "provider-new", text: "new reply" }),
  ] });
  assert.ok((await readFile(path, "utf8")).includes("model-new"), "测试夹具已写入新内容");
  t.mock.restoreAll();

  command = host.open();
  await host.waitFor((text) => text.includes("4 msgs · provider-new/model-new"));
  const [, infoLine] = rowLines(host, "Changing session");
  assert.doesNotMatch(infoLine, /Loading details|model-old/, "重新打开不得沿用上次的加载态或旧数据");
  host.press("\u001b");
  await command;
});

test("双行条目按终端高度滚动，选中项两行完整可见且不越界", async (t) => {
  const data = await world(t);
  for (let i = 1; i <= 10; i++) {
    await data.save({ id: `row-${i}`, name: `Row ${String(i).padStart(2, "0")}`, activity: NOW - i * 60_000 });
  }
  const host = new HistoryHost({ ...data, columns: 60, rows: 12 });
  t.after(() => host.close());
  const command = host.open();
  await host.waitFor((text) => /› Row 01[^\n]*\n[^\n]*2 msgs/.test(text));

  for (let step = 1; step <= 6; step++) {
    const current = `Row ${String(step).padStart(2, "0")}`;
    await host.waitFor((text) => new RegExp(`› ${current}[^\\n]*\\n[^\\n]*2 msgs`).test(text));
    assert.ok(host.frame.every((line) => visibleWidth(line) <= 60), "滚动时不应越界");
    host.press("\u001b[B");
  }

  host.press("\u001b");
  await command;
});
