/**
 * Discord permission handler - renders permission requests as Discord buttons
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { permissionManager } from "../../../permission/manager.js";
import { opencodeClient } from "../../../opencode/client.js";
import { getCurrentProject, getCurrentSession } from "../../../settings/manager.js";
import { summaryAggregator } from "../../../summary/aggregator.js";
import { interactionManager } from "../../../interaction/manager.js";
import { safeBackgroundTask } from "../../../utils/safe-background-task.js";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../i18n/index.js";
import type { DiscordAdapter } from "../adapter.js";
import type { PermissionRequest } from "../../../permission/types.js";
import { markBotPermissionReply } from "../bot.js";

// Permission type display names
const PERMISSION_NAME_KEYS: Record<
  string,
  | "permission.name.bash"
  | "permission.name.edit"
  | "permission.name.write"
  | "permission.name.read"
  | "permission.name.webfetch"
  | "permission.name.websearch"
  | "permission.name.glob"
  | "permission.name.grep"
  | "permission.name.list"
  | "permission.name.task"
  | "permission.name.lsp"
> = {
  bash: "permission.name.bash",
  edit: "permission.name.edit",
  write: "permission.name.write",
  read: "permission.name.read",
  webfetch: "permission.name.webfetch",
  websearch: "permission.name.websearch",
  glob: "permission.name.glob",
  grep: "permission.name.grep",
  list: "permission.name.list",
  task: "permission.name.task",
  lsp: "permission.name.lsp",
};

// Permission type emojis
const PERMISSION_EMOJIS: Record<string, string> = {
  bash: "⚡",
  edit: "✏️",
  write: "📝",
  read: "📖",
  webfetch: "🌐",
  websearch: "🔍",
  glob: "📁",
  grep: "🔎",
  list: "📂",
  task: "⚙️",
  lsp: "🔧",
};

function clearPermissionInteraction(reason: string, sessionId: string): void {
  const state = interactionManager.getSnapshot(sessionId);
  if (state?.kind === "permission") {
    interactionManager.clear(reason, sessionId);
  }
}

function syncPermissionInteractionState(
  sessionId: string,
  metadata: Record<string, unknown> = {},
): void {
  const pendingCount = permissionManager.getPendingCount();

  if (pendingCount === 0) {
    clearPermissionInteraction("permission_no_pending_requests", sessionId);
    return;
  }

  const nextMetadata: Record<string, unknown> = {
    pendingCount,
    ...metadata,
  };

  const state = interactionManager.getSnapshot(sessionId);
  if (state?.kind === "permission") {
    interactionManager.transition(
      {
        expectedInput: "callback",
        metadata: nextMetadata,
      },
      sessionId,
    );
    return;
  }

  interactionManager.start(
    {
      kind: "permission",
      expectedInput: "callback",
      metadata: nextMetadata,
    },
    sessionId,
  );
}

/**
 * Format permission request text
 */
function formatPermissionText(request: PermissionRequest): string {
  const emoji = PERMISSION_EMOJIS[request.permission] || "🔐";
  const nameKey = PERMISSION_NAME_KEYS[request.permission];
  const name = nameKey ? t(nameKey) : request.permission;

  let text = t("permission.header", { emoji, name });

  // Show patterns (commands/files)
  if (request.patterns.length > 0) {
    request.patterns.forEach((pattern) => {
      text += `\`${pattern}\`\n`;
    });
  }

  return text;
}

/**
 * Build Discord ActionRow with permission buttons (Allow/Always Allow/Reject)
 */
function buildPermissionButtons(requestId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`permission:once:${requestId}`)
      .setLabel(t("permission.button.allow"))
      .setStyle(ButtonStyle.Success),
  );

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`permission:always:${requestId}`)
      .setLabel(t("permission.button.always"))
      .setStyle(ButtonStyle.Primary),
  );

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`permission:reject:${requestId}`)
      .setLabel(t("permission.button.reject"))
      .setStyle(ButtonStyle.Danger),
  );

  return [row];
}

/**
 * Show permission request message with buttons
 */
export async function showDiscordPermissionRequest(
  adapter: DiscordAdapter,
  request: PermissionRequest,
  sessionId: string,
): Promise<void> {
  logger.debug(`[DiscordPermissionHandler] Showing permission request: ${request.permission}`);

  const text = formatPermissionText(request);
  const rows = buildPermissionButtons(request.id);

  try {
    const messageId = await adapter.sendMessage(text, { replyMarkup: rows });

    logger.debug(`[DiscordPermissionHandler] Message sent, messageId=${messageId}`);
    permissionManager.startPermission(request, messageId);

    syncPermissionInteractionState(sessionId, {
      requestID: request.id,
      messageId,
    });

    summaryAggregator.stopTypingIndicator();
  } catch (err) {
    logger.error("[DiscordPermissionHandler] Failed to send permission message:", err);
    throw err;
  }
}

/**
 * Handle permission button interaction
 */
export async function handlePermissionButtonInteraction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interaction: any,
  adapter: DiscordAdapter,
  sessionId: string,
): Promise<void> {
  const customId = interaction?.customId;
  if (!customId || !customId.startsWith("permission:")) {
    return;
  }

  // Acknowledge the interaction
  if (typeof interaction.deferUpdate === "function") {
    await interaction.deferUpdate();
  }

  logger.debug(`[DiscordPermissionHandler] Received button: ${customId}`);

  if (!permissionManager.isActive()) {
    clearPermissionInteraction("permission_inactive_callback", sessionId);
    if (typeof interaction.reply === "function") {
      await interaction.reply({
        content: t("permission.inactive_callback"),
        ephemeral: true,
      });
    }
    return;
  }

  const parts = customId.split(":");
  const action = parts[1];
  const requestId = parts[2];

  // Map action to reply type
  let reply: "once" | "always" | "reject";
  switch (action) {
    case "once":
      reply = "once";
      break;
    case "always":
      reply = "always";
      break;
    case "reject":
      reply = "reject";
      break;
    default:
      if (typeof interaction.reply === "function") {
        await interaction.reply({
          content: t("permission.processing_error_callback"),
          ephemeral: true,
        });
      }
      return;
  }

  await handlePermissionReply(interaction, adapter, reply, requestId, sessionId);
}

async function handlePermissionReply(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interaction: any,
  adapter: DiscordAdapter,
  reply: "once" | "always" | "reject",
  requestId: string,
  sessionId: string,
): Promise<void> {
  const currentProject = getCurrentProject();
  const currentSession = getCurrentSession();
  const directory = currentSession?.directory ?? currentProject?.worktree;

  if (!directory) {
    permissionManager.clear();
    clearPermissionInteraction("permission_invalid_runtime_context", sessionId);

    if (typeof interaction.reply === "function") {
      await interaction.reply({
        content: t("permission.no_active_request_callback"),
        ephemeral: true,
      });
    }
    return;
  }

  // Reply labels for user feedback
  const replyLabels: Record<string, string> = {
    once: t("permission.reply.once"),
    always: t("permission.reply.always"),
    reject: t("permission.reply.reject"),
  };

  // Acknowledge with ephemeral reply
  if (typeof interaction.reply === "function") {
    await interaction.reply({
      content: replyLabels[reply],
      ephemeral: true,
    });
  }

  // Delete the permission message
  const messageId = permissionManager.getMessageId();
  if (messageId) {
    await adapter.deleteMessage(messageId).catch(() => {});
  }

  // Stop typing indicator
  summaryAggregator.stopTypingIndicator();

  logger.info(
    `[DiscordPermissionHandler] Sending permission reply: ${reply}, requestID=${requestId}`,
  );

  // Mark as bot-initiated so external reply detection ignores it
  markBotPermissionReply(requestId);

  // CRITICAL: Fire-and-forget!
  safeBackgroundTask({
    taskName: "permission.reply",
    task: () =>
      opencodeClient.permission.reply({
        requestID: requestId,
        directory,
        reply,
      }),
    onSuccess: ({ error }) => {
      if (error) {
        logger.error("[DiscordPermissionHandler] Failed to send permission reply:", error);
      } else {
        logger.info("[DiscordPermissionHandler] Permission reply sent successfully");
      }
    },
  });

  // Remove the handled permission
  permissionManager.removeByMessageId(messageId);

  if (!permissionManager.isActive()) {
    clearPermissionInteraction("permission_replied", sessionId);
    return;
  }

  syncPermissionInteractionState(sessionId, {
    lastRepliedRequestID: requestId,
  });
}
