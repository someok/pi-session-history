import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** 单条会话的增强信息：全历史消息数与最后回复模型。 */
export interface SessionStats {
  /** 整个持久化历史中角色为 user 或 assistant 的消息数量。 */
  messageCount: number;
  /**
   * 按记录顺序最后一条 assistant 消息记录的 model/provider；
   * 字段缺失时为 null，整个历史没有 assistant 消息时整体为 null。
   */
  lastAssistant: { model: string | null; provider: string | null } | null;
}

/**
 * 逐行读取会话 JSONL 的外部依赖 adapter。
 *
 * 生产实现使用文件系统流；测试只在需要控制读取时序或制造单条失败时替换它，
 * 计数与最后回复模型的提取逻辑仍走真实实现。
 */
export class SessionFileReader {
  static async *lines(path: string, signal?: AbortSignal): AsyncGenerator<string> {
    const stream = createReadStream(path, { encoding: "utf8", signal });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of reader) yield line;
    } finally {
      reader.close();
      stream.destroy();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // 与 pi 原生读取一致：跳过损坏行，其余历史仍然可用。
    return null;
  }
}

/**
 * 读取单条会话的增强信息。
 *
 * 只统计 type 为 message 且角色为 user/assistant 的条目，因此工具结果、system、
 * 直接 bash 执行、扩展自定义消息及其他角色不计入；工具内部嵌套调用记录在工具结果上，
 * 也不会额外增加消息数。最后回复模型取记录顺序中最后一条 assistant，不使用
 * model_change 等状态记录、不按时间戳重排，也不限定准备恢复的分支。
 */
export async function readSessionStats(path: string, signal?: AbortSignal): Promise<SessionStats> {
  let messageCount = 0;
  let lastAssistant: SessionStats["lastAssistant"] = null;
  for await (const line of SessionFileReader.lines(path, signal)) {
    const entry = parseLine(line);
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    messageCount++;
    if (role !== "assistant") continue;
    lastAssistant = {
      model: nonEmptyText(message.model),
      provider: nonEmptyText(message.provider),
    };
  }
  return { messageCount, lastAssistant };
}
