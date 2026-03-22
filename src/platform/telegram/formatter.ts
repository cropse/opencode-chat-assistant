/**
 * Telegram-specific message formatting utilities.
 *
 * This module contains formatting logic specific to Telegram's MarkdownV2 format
 * and Telegram's message size limits. Move to the shared formatter if other
 * platforms need the same functionality.
 */
import { convert } from "telegram-markdown-v2";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

/** Telegram's maximum message length */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Telegram's maximum caption length for documents */
export const TELEGRAM_DOCUMENT_CAPTION_MAX_LENGTH = 1024;

/**
 * Detects if a line starts with a code fence (```).
 */
function isCodeFenceLine(line: string): boolean {
  return line.trimStart().startsWith("```");
}

/**
 * Detects if a line is a horizontal rule (---, ***, ___).
 */
function isHorizontalRuleLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) {
    return false;
  }

  return /^([-*_])(?:\s*\1){2,}$/.test(normalized);
}

/**
 * Detects if a line starts with a Markdown heading.
 */
function isHeadingLine(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/.test(line);
}

/**
 * Converts a heading line to bold text (Telegram MarkdownV2 doesn't support headings).
 */
function normalizeHeadingLine(line: string): string {
  const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
  if (!match) {
    return line;
  }

  return `**${match[1]}**`;
}

/**
 * Converts checklist items to visual checkboxes.
 */
function normalizeChecklistLine(line: string): string | null {
  const match = line.match(/^(\s*)(?:[-+*]|\d+\.)\s+\[( |x|X)\]\s+(.*)$/);
  if (!match) {
    return null;
  }

  const marker = match[2].toLowerCase() === "x" ? "✅" : "🔲";
  return `${match[1]}${marker} ${match[3]}`;
}

/**
 * Preprocesses markdown to be compatible with Telegram MarkdownV2.
 *
 * This handles Telegram's limited MarkdownV2 support by:
 * - Converting headings to bold text
 * - Converting horizontal rules to visual separators
 * - Converting checklist items to visual checkboxes
 * - Handling quote continuation properly
 */
export function preprocessMarkdownForTelegram(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let inCodeFence = false;
  let inQuote = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (isCodeFenceLine(line)) {
      inCodeFence = !inCodeFence;
      inQuote = false;
      output.push(line);
      continue;
    }

    if (inCodeFence) {
      output.push(line);
      continue;
    }

    if (!line.trim()) {
      inQuote = false;
      output.push(line);
      continue;
    }

    if (isHeadingLine(line)) {
      output.push(normalizeHeadingLine(line));
      inQuote = false;
      continue;
    }

    if (isHorizontalRuleLine(line)) {
      output.push("──────────");
      inQuote = false;
      continue;
    }

    const trimmedLeft = line.trimStart();
    if (trimmedLeft.startsWith(">")) {
      inQuote = true;
      const quoteContent = trimmedLeft.replace(/^>\s?/, "");
      const normalizedChecklistInQuote = normalizeChecklistLine(quoteContent);
      output.push(
        normalizedChecklistInQuote ? `> ${normalizedChecklistInQuote.trimStart()}` : trimmedLeft,
      );
      continue;
    }

    const normalizedChecklist = normalizeChecklistLine(line);
    if (normalizedChecklist) {
      output.push(inQuote ? `> ${normalizedChecklist.trimStart()}` : normalizedChecklist);
      continue;
    }

    if (inQuote) {
      output.push(`> ${trimmedLeft}`);
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

/**
 * Formats markdown text for Telegram MarkdownV2 format.
 *
 * Uses the telegram-markdown-v2 library to escape special characters
 * and convert markdown syntax to Telegram's format.
 *
 * @param text - The markdown text to format
 * @returns The formatted text ready for Telegram, or original text on error
 */
export function formatMarkdownForTelegram(text: string): string {
  try {
    const preprocessed = preprocessMarkdownForTelegram(text);
    return convert(preprocessed, "keep");
  } catch (error) {
    logger.warn("[Formatter] Failed to convert markdown summary, falling back to raw text", error);
    return text;
  }
}

/**
 * Returns the parse mode for assistant messages based on config.
 *
 * Returns "MarkdownV2" if MESSAGE_FORMAT_MODE is "markdown",
 * undefined if "raw" (plain text).
 */
export function getAssistantParseMode(): "MarkdownV2" | undefined {
  if (config.bot.messageFormatMode === "markdown") {
    return "MarkdownV2";
  }

  return undefined;
}
