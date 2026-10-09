import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** 消息预览需要的用户消息片段；图片只保留存在性，不把图片数据留在内存里。 */
export type UserMessagePart =
  | { type: "text"; text: string }
  | { type: "image" };

/**
 * 最后用户消息的原始内容；纯文本或文本/图片片段数组。
 * 可读转换（技能简化、换行与附件提示）属于消息预览模块。
 */
export type UserMessageContent = string | readonly UserMessagePart[];

/** 单条会话的增强信息：全历史消息数、最后回复模型与最后用户消息。 */
export interface SessionDetails {
  /** 整个持久化历史中角色为 user 或 assistant 的消息数量。 */
  messageCount: number;
  /**
   * 按记录顺序最后一条 assistant 消息记录的 model/provider；
   * 字段缺失时为 null，整个历史没有 assistant 消息时整体为 null。
   */
  lastAssistant: { model: string | null; provider: string | null } | null;
  /**
   * 整个历史按记录顺序最后一条 user 消息的原始内容；
   * 没有 user 消息时为 null，内容缺失（如空字符串）时保留为空内容。
   */
  lastUser: UserMessageContent | null;
}

/**
 * 逐行读取会话 JSONL 的外部依赖 adapter。
 *
 * 生产实现使用文件系统流；测试只在需要控制读取时序或制造单条失败时替换它，
 * 消息数、最后回复模型与最后用户消息的提取逻辑仍走真实实现。
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

/** 提取预览需要的文本与附件存在性；图片数据在此丢弃，后续不再持有。 */
function extractUserContent(value: unknown): UserMessageContent {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: UserMessagePart[] = [];
  for (const part of value) {
    if (!isRecord(part)) continue;
    if (part.type === "image") parts.push({ type: "image" });
    else if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    }
  }
  return parts;
}

/**
 * 读取单条会话的增强信息。
 *
 * 只统计 type 为 message 且角色为 user/assistant 的条目，因此工具结果、system、
 * 直接 bash 执行、扩展自定义消息及其他角色不计入；工具内部嵌套调用记录在工具结果上，
 * 也不会额外增加消息数。最后回复模型取记录顺序中最后一条 assistant，最后用户消息
 * 取记录顺序中最后一条 user：两者都不使用 model_change 等状态记录、不按时间戳重排，
 * 也不限定准备恢复的分支。
 */
export async function readSessionDetails(path: string, signal?: AbortSignal): Promise<SessionDetails> {
  let messageCount = 0;
  let lastAssistant: SessionDetails["lastAssistant"] = null;
  let lastUser: SessionDetails["lastUser"] = null;
  for await (const line of SessionFileReader.lines(path, signal)) {
    const entry = parseLine(line);
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    messageCount++;
    if (role === "user") {
      // 仅含图片等没有正文内容的消息也保留，避免回退到更早的文本。
      lastUser = extractUserContent(message.content);
      continue;
    }
    lastAssistant = {
      model: nonEmptyText(message.model),
      provider: nonEmptyText(message.provider),
    };
  }
  return { messageCount, lastAssistant, lastUser };
}
