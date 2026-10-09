import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UserMessageContent } from "./session-details.ts";

/**
 * 消息预览与全文视图共用的可读内容口径：保留用户正文，把已识别的技能注入
 * 简化为技能名称，把图片附件转换为数量提示；不渲染图片数据，也不调用模型。
 */

/** 原地预览最多展示的终端显示行数；截断提示不计入该上限。 */
export const MAX_PREVIEW_LINES = 6;

/** 最后用户消息的可读内容。 */
export interface MessagePreview {
  /** 保留换行与正文；技能注入已简化为 `[skill] name`。 */
  text: string;
  /** 图片附件数量；不保留图片数据。 */
  imageCount: number;
}

/**
 * 终端控制字符替换为空格，保留换行：避免用户正文里的控制序列影响布局，
 * 也不让 tab 破坏按显示宽度计算的换行。
 */
function sanitize(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ");
}

/**
 * 单个文本内容块的可读文本。
 *
 * 只有符合 pi 技能命令展开格式（公开 parseSkillBlock 语义）的块才简化为技能名称，
 * 其余疑似技能块整段保留，避免过度清理而丢失用户正文。
 */
function readableText(text: string): string {
  const skill = parseSkillBlock(text);
  if (!skill) return text;
  return skill.userMessage ? `[skill] ${skill.name}\n${skill.userMessage}` : `[skill] ${skill.name}`;
}

/** 把最后用户消息的原始内容转换为可读预览。 */
export function toMessagePreview(content: UserMessageContent): MessagePreview {
  const parts = typeof content === "string" ? [content] : content;
  const texts: string[] = [];
  let imageCount = 0;
  for (const part of parts) {
    if (typeof part === "string") {
      texts.push(sanitize(part));
      continue;
    }
    if (part.type === "image") {
      imageCount++;
      continue;
    }
    texts.push(sanitize(part.text));
  }
  return { text: texts.map(readableText).join("\n").trimEnd(), imageCount };
}

/** 附件的数量提示；不渲染图片或图片数据。 */
function imageHint(count: number): string {
  return count === 1 ? "[1 image]" : `[${count} images]`;
}

/** 附件数量提示行；没有附件时为空。 */
function attachmentLines(preview: MessagePreview): string[] {
  return preview.imageCount > 0 ? [imageHint(preview.imageCount)] : [];
}

/** 正文按终端显示宽度换行后的全部显示行，不施加行数上限。 */
function wrappedTextLines(preview: MessagePreview, width: number): string[] {
  return preview.text ? wrapTextWithAnsi(preview.text, Math.max(1, width)) : [];
}

/** 消息换行后的显示行，区分正文与附件提示，便于预览窗口固定附件行。 */
export interface WrappedMessage {
  /** 正文按显示宽度换行后的全部行。 */
  textLines: string[];
  /** 附件数量提示行；固定在预览末尾，不参与正文滚动。 */
  attachmentLines: string[];
}

/** 把消息内容换行为显示行，供原地预览的滚动窗口与全文视图使用。 */
export function wrapMessage(preview: MessagePreview, width: number): WrappedMessage {
  return {
    textLines: wrappedTextLines(preview, width),
    attachmentLines: attachmentLines(preview),
  };
}

/**
 * 消息全文视图使用的显示行：与预览相同的正文、技能名称与附件提示口径，
 * 但不施加 6 行上限。
 */
export function wrapMessageLines(preview: MessagePreview, width: number): string[] {
  const wrapped = wrapMessage(preview, width);
  return [...wrapped.textLines, ...wrapped.attachmentLines];
}
