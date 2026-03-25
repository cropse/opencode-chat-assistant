/**
 * Discord-specific message formatting utilities.
 *
 * Discord uses standard Markdown (not Telegram's MarkdownV2), so escaping
 * is much simpler. This module handles Discord's 2000-character message
 * limit and provides EmbedBuilder helpers for status messages.
 */
import type { PlatformFormatConfig } from "../../summary/formatter.js";
import { EmbedBuilder } from "discord.js";

/** Discord's maximum message length */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Regex pattern to match MarkdownV2 escape sequences (backslash + special char).
 * Matches backslash followed by any of the special characters.
 */
const MARKDOWN_V2_ESCAPE_PATTERN = /\\([_*[\]()~`>#\-+=|{}.!])/g;

/**
 * Formats markdown text for Discord's standard Markdown format.
 *
 * Discord uses standard Markdown which is much more permissive than
 * Telegram's MarkdownV2. This function strips MarkdownV2 escape sequences
 * while preserving valid Discord markdown formatting.
 *
 * @param text - The markdown text to format (may contain MarkdownV2 escapes)
 * @returns Standard Markdown text that Discord renders correctly
 */
export function formatMarkdownForDiscord(text: string): string {
  // Strip MarkdownV2 escape backslashes - Discord doesn't need them
  // and they would show up as literal backslashes
  return text.replace(MARKDOWN_V2_ESCAPE_PATTERN, "$1");
}

/**
 * Splits a message into chunks that fit within Discord's message limit.
 *
 * Prefers splitting at newline boundaries for readability. Never splits
 * inside code fences (triple backtick blocks) - if a code block would
 * exceed the limit, it's closed and reopened across chunks.
 *
 * @param text - The message text to split
 * @returns Array of message chunks, each under 2000 characters
 */
export function splitMessageForDiscord(text: string): string[] {
  if (text.length <= DISCORD_MESSAGE_LIMIT) {
    return [text];
  }

  const lines = text.split("\n");
  const chunks: string[] = [];
  let currentChunk = "";
  let insideCodeFence = false;

  for (const line of lines) {
    // Track code fence state
    const trimmedLine = line.trimStart();
    if (trimmedLine.startsWith("```")) {
      // Toggle code fence state
      insideCodeFence = !insideCodeFence;
    }

    const lineWithNewline = currentChunk.length === 0 ? line : `\n${line}`;

    // If adding this line would exceed the limit
    if (currentChunk.length + lineWithNewline.length > DISCORD_MESSAGE_LIMIT) {
      // Handle code fence at boundary
      if (insideCodeFence) {
        // Close the code block, end chunk, reopen on next chunk
        currentChunk += "```";
        chunks.push(currentChunk);
        currentChunk = `\`\`\`\n${line}`;
        insideCodeFence = false;
      } else {
        // If current chunk is empty and single line exceeds limit, force split it
        if (currentChunk.length === 0) {
          chunks.push(line.slice(0, DISCORD_MESSAGE_LIMIT));
          currentChunk = line.slice(DISCORD_MESSAGE_LIMIT);
        } else {
          chunks.push(currentChunk);
          currentChunk = line;
        }
      }
    } else {
      currentChunk += lineWithNewline;
    }
  }

  // Push any remaining content
  if (currentChunk.length > 0) {
    // If we end inside a code fence, close it
    if (insideCodeFence) {
      currentChunk += "```";
    }
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Pre-built platform config for Discord.
 * Pass this to `formatSummaryWithConfig()` when calling from Discord context.
 */
export const DISCORD_FORMAT_CONFIG: PlatformFormatConfig = {
  messageMaxLength: DISCORD_MESSAGE_LIMIT,
  formatMarkdown: formatMarkdownForDiscord,
};

/**
 * Data for building a plain-text status summary message.
 */
export interface StatusSummaryData {
  /** Action that was performed (e.g., "Session → My Session") */
  action: string;
  /** Current project name */
  project?: string;
  /** Current session title */
  session?: string;
  /** Agent display name */
  agent?: string;
  /** Model display name */
  model?: string;
  /** Model variant */
  variant?: string;
  /** Tokens used in context */
  tokensUsed?: number;
  /** Token limit */
  tokensLimit?: number;
}

/**
 * Builds a plain-text status summary for Discord replies.
 * Used after session/project switches to show current state.
 *
 * @param data - Status data to include
 * @returns Formatted multi-line string
 */
export function buildStatusSummary(data: StatusSummaryData): string {
  const lines: string[] = [`✅ **${data.action}**`];

  if (data.project) {
    lines.push(`📁 Project: ${data.project}`);
  }
  if (data.session) {
    lines.push(`💬 Session: ${data.session}`);
  }
  if (data.agent) {
    lines.push(`🤖 Agent: ${data.agent}`);
  }
  if (data.model) {
    const modelLine =
      data.variant && data.variant !== "default"
        ? `🧠 Model: ${data.model} (${data.variant})`
        : `🧠 Model: ${data.model}`;
    lines.push(modelLine);
  }
  if (data.tokensUsed !== undefined) {
    const tokenStr = data.tokensLimit
      ? `${data.tokensUsed.toLocaleString()} / ${data.tokensLimit.toLocaleString()}`
      : data.tokensUsed.toLocaleString();
    lines.push(`📊 Context: ${tokenStr} tokens`);
  }

  return lines.join("\n");
}

/**
 * Status data for creating Discord status embeds.
 */
export interface DiscordStatusData {
  /** Title of the active session */
  sessionTitle?: string;
  /** Name of the current project */
  projectName?: string;
  /** Current model name */
  modelName?: string;
  /** Current agent mode */
  agentName?: string;
  /** Number of tokens used in context */
  tokensUsed?: number;
  /** Maximum token limit */
  tokensLimit?: number;
  /** Count of changed files */
  changedFilesCount?: number;
  /** List of changed file paths */
  changedFiles?: string[];
  /** Current status indicator */
  status?: "idle" | "busy" | "error";
}

/** Embed color constants */
const STATUS_COLORS = {
  idle: 0x00c851, // Green
  busy: 0xff8800, // Orange
  error: 0xff4444, // Red
} as const;

/**
 * Creates a Discord embed for displaying session/project status.
 * Used by the /status slash command and similar status display features.
 *
 * @param data - Status data to display in the embed
 * @returns EmbedBuilder configured with the status information
 */
export function createStatusEmbed(data: DiscordStatusData): EmbedBuilder {
  const color = data.status
    ? (STATUS_COLORS[data.status] ?? STATUS_COLORS.idle)
    : STATUS_COLORS.idle;

  const title = data.sessionTitle ?? "No active session";

  const embed = new EmbedBuilder().setTitle(title).setColor(color).setTimestamp();

  // Add fields for non-undefined values
  if (data.projectName !== undefined) {
    embed.addFields({ name: "Project", value: data.projectName, inline: true });
  }

  if (data.modelName !== undefined) {
    embed.addFields({ name: "Model", value: data.modelName, inline: true });
  }

  if (data.agentName !== undefined) {
    embed.addFields({ name: "Agent", value: data.agentName, inline: true });
  }

  if (data.tokensUsed !== undefined) {
    const tokenText =
      data.tokensLimit !== undefined
        ? `${data.tokensUsed} / ${data.tokensLimit}`
        : String(data.tokensUsed);
    embed.addFields({ name: "Context Tokens", value: tokenText, inline: true });
  }

  if (data.changedFilesCount !== undefined) {
    const fileText =
      data.changedFiles && data.changedFiles.length > 0
        ? `${data.changedFilesCount} files\n${data.changedFiles.slice(0, 5).join(", ")}${data.changedFiles.length > 5 ? "..." : ""}`
        : `${data.changedFilesCount} files`;
    embed.addFields({ name: "Changed Files", value: fileText, inline: false });
  }

  return embed;
}
