import { Client, GatewayIntentBits, Partials, Events, ChannelType } from "discord.js";
import { DiscordAdapter } from "./adapter.js";
import {
  isAuthorizedDiscordUser,
  setSessionOwner,
  clearSessionOwner,
  getSessionOwner,
} from "./middleware/auth.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { ToolMessageBatcher } from "../../summary/tool-message-batcher.js";
import { formatSummaryWithConfig, formatToolInfo } from "../../summary/formatter.js";
import { DISCORD_FORMAT_CONFIG } from "./formatter.js";
import { discordPinnedMessageManager } from "./pinned-manager.js";
import { registerSlashCommands } from "./commands/register.js";
import { subscribeToEvents, stopEventListening } from "../../opencode/events.js";
import { getCurrentProject, getCurrentSession } from "../../settings/manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { opencodeClient } from "../../opencode/client.js";
import { getStoredAgent } from "../../agent/manager.js";
import { getStoredModel } from "../../model/manager.js";
import { ingestSessionInfoForCache } from "../../session/cache-manager.js";
import { setCurrentSession } from "../../session/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { resolveInteractionGuardDecision } from "../../interaction/guard.js";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import { formatErrorDetails } from "../../utils/error-format.js";
import { startMessagePolling, stopMessagePolling } from "../../opencode/message-poller.js";
import {
  startQuestionPoller,
  stopQuestionPoller,
  markQuestionSeen,
} from "../../opencode/question-poller.js";
import { permissionManager } from "../../permission/manager.js";

// Command handlers
import { handleStatusCommand } from "./commands/status.js";
import { handleNewCommand } from "./commands/new.js";
import { handleAbortCommand } from "./commands/abort.js";
import { handleSessionsCommand } from "./commands/sessions.js";
import { handleProjectsCommand } from "./commands/projects.js";
import { handleRenameCommand } from "./commands/rename.js";
import { handleCommandsCommand } from "./commands/commands.js";
import { handleSkillsCommand } from "./commands/skills.js";
import { handleOpencodeStartCommand } from "./commands/opencode-start.js";
import { handleOpencodeStopCommand } from "./commands/opencode-stop.js";
import { handleHelpCommand } from "./commands/help.js";
import { handleModelCommand } from "./commands/model.js";
import { handleAgentCommand } from "./commands/agent.js";
import { handleVariantCommand } from "./commands/variant.js";

// Interaction handlers
import {
  showDiscordQuestion,
  handleQuestionButtonInteraction,
  handleQuestionModalSubmit,
} from "./handlers/question.js";
import {
  showDiscordPermissionRequest,
  handlePermissionButtonInteraction,
} from "./handlers/permission.js";
import { questionManager } from "../../question/manager.js";

let clientInstance: Client | null = null;
let adapterInstance: DiscordAdapter | null = null;
let typingInterval: ReturnType<typeof setInterval> | null = null;
let eventSubscriptionAbortController: AbortController | null = null;
let toolMessageBatcherInstance: ToolMessageBatcher | null = null;
let lastPromptMessageRef: string | null = null;
let lastBotQuestionReplyID: string | null = null;
let lastBotPermissionReplyID: string | null = null;

/**
 * Maps Discord thread IDs → the session they were created for.
 * Populated by /new and /sessions. Only threads in this map
 * will receive prompts from the bot.
 */
const threadSessionMap = new Map<string, import("../../session/manager.js").SessionInfo>();

/**
 * Register a thread as belonging to a specific session.
 * Called by /new and /sessions after createThreadFromInteraction().
 */
export function registerThreadSession(
  threadId: string,
  session: import("../../session/manager.js").SessionInfo,
): void {
  threadSessionMap.set(threadId, session);
  logger.debug(`[Discord] Thread ${threadId} registered for session ${session.id}`);
}

/**
 * Mark a question reply as bot-initiated (to distinguish from external GUI replies).
 */
export function markBotQuestionReply(requestID: string): void {
  lastBotQuestionReplyID = requestID;
}

/**
 * Mark a permission reply as bot-initiated (to distinguish from external GUI replies).
 */
export function markBotPermissionReply(requestID: string): void {
  lastBotPermissionReplyID = requestID;
}

/**
 * Start the typing indicator — sends typing every 8 seconds (Discord typing expires at 10s).
 */
function startTypingIndicator(): void {
  if (!adapterInstance) return;
  stopTypingIndicator();
  adapterInstance.sendTyping().catch(() => {
    // Fire and forget
  });
  typingInterval = setInterval(() => {
    if (adapterInstance) {
      adapterInstance.sendTyping().catch(() => {
        // Fire and forget
      });
    }
  }, 8000);
}

/**
 * Stop the typing indicator.
 */
function stopTypingIndicator(): void {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }
}

/**
 * Wire all summaryAggregator callbacks through the DiscordAdapter.
 */
function setupSummaryAggregatorCallbacks(): void {
  if (!adapterInstance) return;

  toolMessageBatcherInstance = new ToolMessageBatcher({
    intervalSeconds: 5,
    messageMaxLength: DISCORD_FORMAT_CONFIG.messageMaxLength,
    sendText: async (sessionId, text) => {
      const currentSession = getCurrentSession();
      if (!currentSession || currentSession.id !== sessionId) return;
      if (!adapterInstance?.isReady()) return;
      const parts = formatSummaryWithConfig(text, DISCORD_FORMAT_CONFIG);
      for (const part of parts) {
        await adapterInstance!.sendMessage(part);
      }
    },
    sendFile: async () => {
      // No-op: Discord does not upload file attachments for tool calls
    },
  });

  summaryAggregator.setOnComplete(async (sessionId, messageText) => {
    stopTypingIndicator();
    if (!adapterInstance?.isReady()) return;
    await toolMessageBatcherInstance?.flushSession(sessionId, "assistant_message_completed");
    const parts = formatSummaryWithConfig(messageText, DISCORD_FORMAT_CONFIG);
    for (const part of parts) {
      await adapterInstance!.sendMessage(part);
    }
    adapterInstance?.clearThreadId();
    clearSessionOwner(); // Session complete — unlock

    // Remove ⏳ and 🛑 reactions from the user's prompt message
    if (lastPromptMessageRef && adapterInstance) {
      await adapterInstance.removeReaction(lastPromptMessageRef, "⏳").catch(() => {});
      await adapterInstance.removeReaction(lastPromptMessageRef, "🛑").catch(() => {});
      lastPromptMessageRef = null;
    }
  });

  summaryAggregator.setOnTool(async (toolInfo) => {
    const currentSession = getCurrentSession();
    if (!currentSession || currentSession.id !== toolInfo.sessionId) return;
    const message = formatToolInfo(toolInfo);
    if (message) {
      toolMessageBatcherInstance?.enqueue(toolInfo.sessionId, message);
    }
  });

  summaryAggregator.setOnThinking(async (sessionId) => {
    startTypingIndicator();
    const currentSession = getCurrentSession();
    if (!currentSession || currentSession.id !== sessionId) return;
    if (!adapterInstance?.isReady()) return;
    await adapterInstance.sendMessage(t("bot.thinking"));
  });

  summaryAggregator.setOnSessionError(async (sessionId, error) => {
    stopTypingIndicator();
    if (!adapterInstance?.isReady()) return;
    await adapterInstance.sendMessage(t("bot.session_error", { message: error }));
    adapterInstance?.clearThreadId();
    clearSessionOwner();

    // Remove ⏳ and 🛑 reactions from the user's prompt message
    if (lastPromptMessageRef && adapterInstance) {
      await adapterInstance.removeReaction(lastPromptMessageRef, "⏳").catch(() => {});
      await adapterInstance.removeReaction(lastPromptMessageRef, "🛑").catch(() => {});
      lastPromptMessageRef = null;
    }
  });

  summaryAggregator.setOnSessionRetry(async (retryInfo) => {
    await adapterInstance!.sendMessage(t("bot.session_retry", { message: retryInfo.message }));
  });

  summaryAggregator.setOnTokens(async (tokens) => {
    await discordPinnedMessageManager.onTokensUpdated(tokens.input + tokens.output, 0);
  });

  summaryAggregator.setOnSessionDiff(async (_sessionId, fileChanges) => {
    await discordPinnedMessageManager.onFilesChanged(fileChanges);
  });

  summaryAggregator.setOnCleared(() => {
    toolMessageBatcherInstance?.clearAll("summary_aggregator_clear");
    stopMessagePolling();
    stopQuestionPoller();
  });

  summaryAggregator.setOnQuestion(async (questions, requestID) => {
    if (!adapterInstance) return;
    const currentSession = getCurrentSession();
    if (currentSession) {
      await toolMessageBatcherInstance?.flushSession(currentSession.id, "question_asked");
    }
    if (questionManager.isActive()) {
      logger.warn("[Discord] Replacing active poll with a new one");
      clearAllInteractionState("question_replaced_by_new_poll");
    }
    logger.info(`[Discord] Received ${questions.length} questions, requestID=${requestID}`);
    questionManager.startQuestions(questions, requestID);
    markQuestionSeen(requestID);
    await showDiscordQuestion(adapterInstance);
  });

  summaryAggregator.setOnPermission(async (request) => {
    if (!adapterInstance) return;
    const currentSession = getCurrentSession();
    if (currentSession) {
      await toolMessageBatcherInstance?.flushSession(currentSession.id, "permission_asked");
    }
    logger.info(
      `[Discord] Permission request: type=${request.permission}, requestID=${request.id}`,
    );
    await showDiscordPermissionRequest(adapterInstance, request);
  });

  // Handle question answered externally (e.g., from GUI) — "first answer wins"
  summaryAggregator.setOnQuestionExternalReply((requestID) => {
    if (lastBotQuestionReplyID === requestID) {
      lastBotQuestionReplyID = null;
      logger.debug(`[Discord] Ignoring question.replied for bot's own reply: ${requestID}`);
      return;
    }

    if (!questionManager.isActive()) return;

    const activeRequestID = questionManager.getRequestID();
    if (activeRequestID && activeRequestID !== requestID) return;

    logger.info(
      `[Discord] Question answered externally (GUI): requestID=${requestID}, dismissing Discord poll`,
    );

    const messageIds = questionManager.getMessageIds();
    for (const messageId of messageIds) {
      if (adapterInstance) {
        adapterInstance.editMessage(messageId, t("question.answered_externally")).catch((err) => {
          logger.debug(`[Discord] Failed to edit question message ${messageId}:`, err);
        });
      }
    }

    clearAllInteractionState("question_answered_externally");
  });

  // Handle permission answered externally (e.g., from GUI)
  summaryAggregator.setOnPermissionExternalReply((requestID) => {
    if (lastBotPermissionReplyID === requestID) {
      lastBotPermissionReplyID = null;
      logger.debug(`[Discord] Ignoring permission.replied for bot's own reply: ${requestID}`);
      return;
    }

    if (!permissionManager.isActive()) return;

    logger.info(
      `[Discord] Permission answered externally (GUI): requestID=${requestID}, dismissing Discord buttons`,
    );

    const messageId = permissionManager.getMessageId();
    if (messageId && adapterInstance) {
      adapterInstance.editMessage(messageId, t("permission.answered_externally")).catch((err) => {
        logger.debug(`[Discord] Failed to edit permission message ${messageId}:`, err);
      });
    }

    permissionManager.clear();
    clearAllInteractionState("permission_answered_externally");
  });

  // Handle session compacted — reload context tokens in pinned embed
  summaryAggregator.setOnSessionCompacted(async (sessionId, directory) => {
    logger.info(`[Discord] Session compacted: ${sessionId}, reloading context`);
    await discordPinnedMessageManager.onSessionCompacted(sessionId, directory);
  });
}

/**
 * Start the message poller for the given session. The poller detects
 * completed assistant replies that the SSE aggregator did not pick up
 * (e.g. messages originating from the OpenCode GUI) and forwards them
 * to Discord.
 */
function startDiscordPollerForSession(sessionId: string, directory: string): void {
  startMessagePolling(sessionId, directory, (polledSessionId, messageText) => {
    if (!adapterInstance || !adapterInstance.isReady()) return;

    logger.info(
      `[MessagePoller] Forwarding polled assistant reply to Discord (session=${polledSessionId})`,
    );

    const parts = formatSummaryWithConfig(messageText, DISCORD_FORMAT_CONFIG);
    safeBackgroundTask({
      taskName: "message_poller.discord_forward",
      task: async () => {
        for (const part of parts) {
          await adapterInstance!.sendMessage(part);
        }
      },
      onError: (err) => {
        logger.error("[MessagePoller] Failed to send polled message to Discord:", err);
      },
    });
  }).catch((err: unknown) => {
    logger.warn("[MessagePoller] Failed to start polling:", err);
  });
}

/**
 * Check if session is busy before sending a prompt.
 */
async function isSessionBusy(sessionId: string, directory: string): Promise<boolean> {
  try {
    const { data } = await opencodeClient.session.status({ directory });
    if (!data) return false;
    const sessionStatus = (data as Record<string, { type?: string }>)[sessionId];
    return sessionStatus?.type === "busy";
  } catch {
    return false;
  }
}

/**
 * Send a user prompt to OpenCode (fire-and-forget).
 */
async function sendPrompt(
  adapter: DiscordAdapter,
  text: string,
  fileParts: FilePartInput[] = [],
): Promise<void> {
  const project = getCurrentProject();
  if (!project) {
    await adapter.sendMessage(t("bot.project_not_selected"));
    return;
  }

  let currentSession = getCurrentSession();

  // Session/project mismatch check
  if (currentSession && currentSession.directory !== project.worktree) {
    logger.warn(
      `[Discord] Session/project mismatch: sessionDirectory=${currentSession.directory}, projectDirectory=${project.worktree}`,
    );
    stopEventListening();
    summaryAggregator.clear();
    clearAllInteractionState("session_mismatch_reset");
    await adapter.sendMessage(t("bot.session_reset_project_mismatch"));
    return;
  }

  if (!currentSession) {
    await adapter.sendMessage(t("bot.creating_session"));

    const { data: session, error } = await opencodeClient.session.create({
      directory: project.worktree,
    });

    if (error || !session) {
      await adapter.sendMessage(t("bot.create_session_error"));
      return;
    }

    logger.info(`[Discord] Created new session: id=${session.id}, title="${session.title}"`);

    currentSession = {
      id: session.id,
      title: session.title,
      directory: project.worktree,
    };
    setCurrentSession(currentSession);
    await ingestSessionInfoForCache(session);
    await discordPinnedMessageManager.onSessionChanged(
      session.id,
      session.title,
      project.name || project.worktree,
    );
    await adapter.sendMessage(t("bot.session_created", { title: session.title }));
  } else {
    logger.info(`[Discord] Using existing session: ${currentSession.id}`);
    // Ensure pinned message exists
    if (!discordPinnedMessageManager.getState().messageRef) {
      await discordPinnedMessageManager.onSessionChanged(
        currentSession.id,
        currentSession.title,
        project.name || project.worktree,
      );
    }
  }

  await autoSubscribeDiscordEvents(clientInstance!);
  summaryAggregator.setSession(currentSession.id);

  const sessionIsBusy = await isSessionBusy(currentSession.id, currentSession.directory);
  if (sessionIsBusy) {
    await adapter.sendMessage(t("bot.session_busy"));
    return;
  }

  const currentAgent = getStoredAgent();
  const storedModel = getStoredModel();

  // Build parts
  const parts: Array<TextPartInput | FilePartInput> = [];
  if (text.trim().length > 0) {
    parts.push({ type: "text", text });
  }
  parts.push(...fileParts);

  const promptOptions: {
    sessionID: string;
    directory: string;
    parts: Array<TextPartInput | FilePartInput>;
    agent?: string;
    model?: { providerID: string; modelID: string };
    variant?: string;
  } = {
    sessionID: currentSession.id,
    directory: currentSession.directory,
    parts,
    agent: currentAgent,
  };

  if (storedModel.providerID && storedModel.modelID) {
    promptOptions.model = {
      providerID: storedModel.providerID,
      modelID: storedModel.modelID,
    };
    if (storedModel.variant) {
      promptOptions.variant = storedModel.variant;
    }
  }

  safeBackgroundTask({
    taskName: "session.prompt",
    task: () => opencodeClient.session.prompt(promptOptions),
    onSuccess: (result) => {
      const promptError = (result as { error?: unknown })?.error;
      if (promptError) {
        const details = formatErrorDetails(promptError as Error, 6000);
        logger.error("[Discord] session.prompt error:", details);
        void adapter.sendMessage(t("bot.prompt_send_error")).catch(() => {});
      }
    },
    onError: (err) => {
      const details = formatErrorDetails(err as Error, 6000);
      logger.error("[Discord] session.prompt background failure:", details);
      void adapter.sendMessage(t("bot.prompt_send_error")).catch(() => {});
    },
  });
}

/**
 * Create the Discord bot client and register all event handlers.
 */
export function createDiscordBot(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  clientInstance = client;
  adapterInstance = new DiscordAdapter(client);
  discordPinnedMessageManager.initialize(adapterInstance);
  setupSummaryAggregatorCallbacks();

  client.on(Events.ClientReady, async (readyClient) => {
    logger.info(`[Discord] Logged in as ${readyClient.user.tag}`);
    await registerSlashCommands(readyClient.application.id);

    // Auto-subscribe to SSE events + start pollers at startup
    // (enables GUI→Discord forwarding without waiting for user interaction)
    const currentProject = getCurrentProject();
    if (currentProject?.worktree) {
      const currentSession = getCurrentSession();
      if (currentSession?.id) {
        summaryAggregator.setSession(currentSession.id);
        logger.info(`[Discord] Auto-set aggregator session: ${currentSession.id}`);
      }
      await autoSubscribeDiscordEvents(clientInstance!);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    // Handle modal submissions (custom question answers)
    if (interaction.isModalSubmit()) {
      const customId = interaction.customId;
      if (customId.startsWith("question:modal:")) {
        await handleQuestionModalSubmit(interaction, adapterInstance!);
      }
      return;
    }

    // Handle button interactions (questions, permissions, agent selection, commands)
    if (interaction.isButton()) {
      const customId = interaction.customId;
      if (customId.startsWith("question:")) {
        await handleQuestionButtonInteraction(interaction, adapterInstance!);
      } else if (customId.startsWith("permission:")) {
        await handlePermissionButtonInteraction(interaction, adapterInstance!);
      } else if (customId.startsWith("agent:")) {
        const { handleAgentButtonInteraction } = await import("./handlers/agent.js");
        await handleAgentButtonInteraction(interaction, adapterInstance!);
      } else if (customId.startsWith("command:")) {
        const { handleCommandButtonInteraction } = await import("./commands/commands.js");
        await handleCommandButtonInteraction(interaction, adapterInstance!, {
          adapter: adapterInstance!,
          ensureEventSubscription: (_directory: string) =>
            autoSubscribeDiscordEvents(clientInstance!),
        });
      }
      return;
    }

    // Handle select menu interactions (sessions, projects, models, variants, commands)
    if (interaction.isStringSelectMenu()) {
      const customId = interaction.customId;
      if (customId === "session:select") {
        const { handleSessionSelectInteraction } = await import("./handlers/session.js");
        await handleSessionSelectInteraction(interaction, adapterInstance!);
      } else if (customId === "project:select") {
        const { handleProjectSelectInteraction } = await import("./handlers/project.js");
        await handleProjectSelectInteraction(interaction, adapterInstance!);
      } else if (customId.startsWith("model:select")) {
        const { handleModelSelectInteraction } = await import("./handlers/model.js");
        await handleModelSelectInteraction(interaction, adapterInstance!);
      } else if (customId === "variant:select") {
        const { handleVariantSelectInteraction } = await import("./handlers/variant.js");
        await handleVariantSelectInteraction(interaction, adapterInstance!);
      } else if (customId === "command:select") {
        const { handleCommandSelectInteraction } = await import("./commands/commands.js");
        await handleCommandSelectInteraction(interaction, adapterInstance!);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const commandName = interaction.commandName;

    switch (commandName) {
      case "status":
        return handleStatusCommand(interaction);
      case "new":
        return handleNewCommand(interaction, {
          ensureEventSubscription: (_directory: string) =>
            autoSubscribeDiscordEvents(clientInstance!),
          adapter: adapterInstance!,
        });
      case "abort":
        return handleAbortCommand(interaction);
      case "sessions":
        return handleSessionsCommand(interaction);
      case "projects":
        return handleProjectsCommand(interaction);
      case "rename":
        return handleRenameCommand(interaction);
      case "commands":
        return handleCommandsCommand(interaction, {
          adapter: adapterInstance!,
          ensureEventSubscription: (_directory: string) =>
            autoSubscribeDiscordEvents(clientInstance!),
        });
      case "skills":
        return handleSkillsCommand(interaction);
      case "opencode_start":
        return handleOpencodeStartCommand(interaction);
      case "opencode_stop":
        return handleOpencodeStopCommand(interaction);
      case "help":
        return handleHelpCommand(interaction);
      case "model":
        return handleModelCommand(interaction);
      case "agent":
        return handleAgentCommand(interaction);
      case "variant":
        return handleVariantCommand(interaction);
      default:
        await interaction.reply({ content: "Unknown command", ephemeral: true });
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    const adapter = adapterInstance!;

    // Guild text channels: only slash commands are accepted — ignore plain messages
    if (
      message.channel.type === ChannelType.GuildText ||
      message.channel.type === ChannelType.GuildAnnouncement
    ) {
      return;
    }

    // DM channels: check auth by user ID
    const isThread =
      message.channel.type === ChannelType.PublicThread ||
      message.channel.type === ChannelType.PrivateThread;

    if (isThread) {
      // Thread: only accept messages in threads we created
      const threadSession = threadSessionMap.get(message.channelId);
      if (!threadSession) {
        // Not a bot-managed thread — ignore silently
        return;
      }

      // Auth check
      if (!isAuthorizedDiscordUser(message)) {
        await message.reply(t("discord.auth.unauthorized_channel"));
        return;
      }

      // Switch to this thread's session if it differs from current
      const currentSession = getCurrentSession();
      if (!currentSession || currentSession.id !== threadSession.id) {
        setCurrentSession(threadSession);
        summaryAggregator.clear();
        summaryAggregator.setSession(threadSession.id);
        clearAllInteractionState("thread_session_switch");
        await autoSubscribeDiscordEvents(clientInstance!);
      }

      adapter.setChatId(message.channelId);
      adapter.setThreadId(message.channelId);
    } else {
      // DM
      if (!isAuthorizedDiscordUser(message)) {
        await message.reply(t("discord.auth.unauthorized_dm"));
        return;
      }
      adapter.setChatId(message.channelId);
    }

    // Session owner lock
    const currentOwner = getSessionOwner();
    if (currentOwner && currentOwner !== message.author.id) {
      await message.reply(t("discord.auth.session_busy", { user: `<@${currentOwner}>` }));
      return;
    }

    // Set this user as the operator
    setSessionOwner(message.author.id);

    const text = message.content.trim();
    if (!text) return;

    // Interaction guard — block prompts while a question/permission is pending
    const guardDecision = resolveInteractionGuardDecision({ type: "text", text });
    if (!guardDecision.allow) {
      const kind = guardDecision.state?.kind;
      const reason = guardDecision.reason;
      let hint: string;
      if (kind === "question") {
        hint =
          reason === "command_not_allowed"
            ? t("question.blocked.command_not_allowed")
            : t("question.blocked.expected_answer");
      } else if (kind === "permission") {
        hint =
          reason === "command_not_allowed"
            ? t("permission.blocked.command_not_allowed")
            : t("permission.blocked.expected_reply");
      } else {
        hint = t("interaction.blocked.finish_current");
      }
      await message.reply(hint);
      return;
    }

    // Check if session is busy BEFORE creating thread or reacting
    const existingSession = getCurrentSession();
    if (existingSession) {
      const busy = await isSessionBusy(existingSession.id, existingSession.directory);
      if (busy) {
        await message.reply(t("bot.session_busy"));
        return;
      }
    }

    // Add ⏳ + 🛑 reactions to indicate processing (🛑 can be clicked to abort)
    lastPromptMessageRef = message.id;
    try {
      await message.react("⏳");
      await message.react("🛑");
    } catch {
      // Silent fail — bot may not have Add Reactions permission
    }

    // Fire-and-forget prompt processing
    safeBackgroundTask({
      taskName: "discord.prompt",
      task: async () => {
        try {
          await sendPrompt(adapter, text);
        } catch (err) {
          logger.error("[Discord] Prompt error", err);
          await adapter.sendMessage(t("error.generic")).catch(() => {});
        }
      },
      onError: (err: unknown) => {
        logger.error("[Discord] Prompt background error", err);
      },
    });
  });

  // Reaction-based abort — clicking 🛑 on the active prompt message interrupts the task
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    // Ignore bot reactions
    if (user.bot) return;
    // Only care about 🛑 on the currently-processing message
    if (reaction.emoji.name !== "🛑") return;
    if (!lastPromptMessageRef || reaction.message.id !== lastPromptMessageRef) return;

    // Auth check — only the session owner or authorized users can abort via reaction
    const currentOwner = getSessionOwner();
    if (currentOwner && currentOwner !== user.id) return;

    logger.info(`[Discord] Abort triggered via 🛑 reaction by user ${user.id}`);

    const currentSession = getCurrentSession();
    if (!currentSession) return;

    try {
      stopEventListening();
      summaryAggregator.clear();
      clearAllInteractionState("abort_reaction");
      adapterInstance?.clearThreadId();

      await opencodeClient.session.abort({
        sessionID: currentSession.id,
        directory: currentSession.directory,
      });

      // Clean up both reactions
      if (adapterInstance) {
        await adapterInstance.removeReaction(lastPromptMessageRef, "⏳").catch(() => {});
        await adapterInstance.removeReaction(lastPromptMessageRef, "🛑").catch(() => {});
      }
      lastPromptMessageRef = null;
      clearSessionOwner();

      await adapterInstance?.sendMessage(t("stop.success"));
    } catch (err) {
      logger.error("[Discord] Reaction abort error:", err);
      await adapterInstance?.sendMessage(t("stop.warn_unconfirmed"));
    }
  });

  return client;
}

/**
 * Subscribe to SSE events for the current project.
 * Idempotent — safe to call multiple times.
 */
export async function autoSubscribeDiscordEvents(_client: Client): Promise<void> {
  const project = getCurrentProject();
  if (!project) return;

  // Cancel previous subscription if any
  if (eventSubscriptionAbortController) {
    eventSubscriptionAbortController.abort();
  }

  const abort = new AbortController();
  eventSubscriptionAbortController = abort;

  safeBackgroundTask({
    taskName: "discord.sse",
    task: async () => {
      await subscribeToEvents(project.worktree, (event) => {
        summaryAggregator.processEvent(event);
      });
    },
    onError: (err: unknown) => {
      logger.error("[Discord] SSE subscription error", err);
    },
  });

  // Start (or re-sync) the message poller for the current session.
  // This catches assistant replies from the GUI that the SSE aggregator may miss.
  const pollerSession = getCurrentSession();
  if (pollerSession?.id) {
    startDiscordPollerForSession(pollerSession.id, project.worktree);
  }

  // Start question poller to discover questions from GUI that SSE might miss.
  startQuestionPoller(project.worktree, async (questions, requestID) => {
    if (!adapterInstance) return;

    // Skip if this question is already being shown
    if (questionManager.isActive() && questionManager.getRequestID() === requestID) return;

    logger.info(
      `[Discord] Question discovered by poller: requestID=${requestID}, questions=${questions.length}`,
    );

    if (questionManager.isActive()) {
      clearAllInteractionState("question_replaced_by_poller");
    }

    const currentSession = getCurrentSession();
    if (currentSession) {
      await toolMessageBatcherInstance?.flushSession(currentSession.id, "question_polled");
    }

    questionManager.startQuestions(questions, requestID);
    markQuestionSeen(requestID);
    await showDiscordQuestion(adapterInstance);
  });
}
