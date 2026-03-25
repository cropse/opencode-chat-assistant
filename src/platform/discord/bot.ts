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
import {
  getCurrentProject,
  getCurrentSession,
  getDiscordChannelId,
  setDiscordChannelId,
  setDiscordThreadForSession,
  getDiscordThreadForSession,
  getDiscordThreadMap,
} from "../../settings/manager.js";
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
import { handleSkillsCommand, handleSkillsAutocomplete } from "./commands/skills.js";
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

import { activeSessionManager } from "../../session/active-session-manager.js";
import { interactionManager } from "../../interaction/manager.js";

let clientInstance: Client | null = null;
let adapterInstance: DiscordAdapter | null = null;
const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
let eventSubscriptionAbortController: AbortController | null = null;
let toolMessageBatcherInstance: ToolMessageBatcher | null = null;
/** Maps sessionId → { messageRef, threadId, authorId } for per-session reaction tracking */
const promptTracker = new Map<string, { messageRef: string; threadId: string; authorId: string }>();
let lastBotQuestionReplyID: string | null = null;
let lastBotPermissionReplyID: string | null = null;
let pollerDoneTimer: ReturnType<typeof setTimeout> | null = null;
const POLLER_DONE_DEBOUNCE_MS = 8000;

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
  setDiscordThreadForSession(session.id, threadId);
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
function startTypingIndicator(sessionId: string): void {
  if (!adapterInstance) return;
  stopTypingIndicator(sessionId);
  adapterInstance.sendTyping().catch(() => {
    // Fire and forget
  });
  typingIntervals.set(
    sessionId,
    setInterval(() => {
      if (adapterInstance) {
        adapterInstance.sendTyping().catch(() => {
          // Fire and forget
        });
      }
    }, 8000),
  );
}

/**
 * Stop the typing indicator for a session (or all sessions if no sessionId).
 */
function stopTypingIndicator(sessionId?: string): void {
  if (sessionId !== undefined) {
    const interval = typingIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(sessionId);
    }
  } else {
    // Stop all
    for (const [, interval] of typingIntervals) clearInterval(interval);
    typingIntervals.clear();
  }
}

/**
 * Wire all summaryAggregator callbacks through the DiscordAdapter.
 */
function setupSummaryAggregatorCallbacks(): void {
  if (!adapterInstance) return;

  // Register multi-session active callback — aggregator will route events for all active sessions
  summaryAggregator.setIsSessionActiveCallback((sessionId) =>
    activeSessionManager.isActive(sessionId),
  );

  // Register eviction cleanup
  activeSessionManager.onEvict = (evictedSession) => {
    interactionManager.clear("session_evicted", evictedSession.id);
    questionManager.clear(evictedSession.id);
    toolMessageBatcherInstance?.clearSession(evictedSession.id, "session_evicted");
    stopMessagePolling(evictedSession.id);
    stopTypingIndicator(evictedSession.id);
    promptTracker.delete(evictedSession.id);
    logger.info(`[Discord] Session evicted from active pool: ${evictedSession.id}`);
  };

  toolMessageBatcherInstance = new ToolMessageBatcher({
    intervalSeconds: 5,
    messageMaxLength: DISCORD_FORMAT_CONFIG.messageMaxLength,
    sendText: async (sessionId, text) => {
      if (!adapterInstance?.isReady()) return;

      // Route to thread for this session — no currentSession guard needed
      const threadId = getDiscordThreadForSession(sessionId);
      if (!threadId) return;
      adapterInstance.setThreadId(threadId);

      const parts = formatSummaryWithConfig(text, DISCORD_FORMAT_CONFIG);
      for (const part of parts) {
        await adapterInstance!.sendMessage(part);
      }
      adapterInstance.clearThreadId();
    },
    sendFile: async () => {
      // No-op: Discord does not upload file attachments for tool calls
    },
  });

  summaryAggregator.setOnComplete(async (sessionId, messageText) => {
    stopTypingIndicator(sessionId);
    if (!adapterInstance?.isReady()) return;

    // Only send to Discord if this session has a bound thread
    const threadId = getDiscordThreadForSession(sessionId);
    if (!threadId) return;
    adapterInstance.setThreadId(threadId);

    await toolMessageBatcherInstance?.flushSession(sessionId, "assistant_message_completed");
    const parts = formatSummaryWithConfig(messageText, DISCORD_FORMAT_CONFIG);
    for (const part of parts) {
      await adapterInstance!.sendMessage(part);
    }
    adapterInstance.clearThreadId();
  });

  summaryAggregator.setOnThinking(async (sessionId) => {
    startTypingIndicator(sessionId);
    if (!adapterInstance?.isReady()) return;
    const threadId = getDiscordThreadForSession(sessionId);
    if (!threadId) return;
    adapterInstance.setThreadId(threadId);
    await adapterInstance.sendMessage(t("bot.thinking"));
    adapterInstance.clearThreadId();
  });

  summaryAggregator.setOnSessionError(async (sessionId, error) => {
    stopTypingIndicator(sessionId);
    if (!adapterInstance?.isReady()) return;
    const threadId = getDiscordThreadForSession(sessionId);
    if (!threadId) return;
    adapterInstance.setThreadId(threadId);

    // Use per-session prompt tracker for reaction cleanup
    const tracker = promptTracker.get(sessionId);
    const mention = tracker ? ` <@${tracker.authorId}>` : "";
    await adapterInstance.sendMessage(t("bot.session_error", { message: error }) + mention);
    adapterInstance.clearThreadId();

    if (tracker && adapterInstance) {
      adapterInstance.setThreadId(tracker.threadId);
      await adapterInstance.removeReaction(tracker.messageRef, "⏳").catch(() => {});
      await adapterInstance.removeReaction(tracker.messageRef, "🛑").catch(() => {});
      adapterInstance.clearThreadId();
      promptTracker.delete(sessionId);
    }
  });

  // Session idle = agent truly finished (all turns complete)
  // This is where we clean up reactions and unlock the session
  summaryAggregator.setOnSessionIdle(async (sessionId) => {
    stopTypingIndicator(sessionId);

    // Use per-session prompt tracker
    const tracker = promptTracker.get(sessionId);
    if (!tracker) {
      clearSessionOwner();
      return;
    }
    promptTracker.delete(sessionId);
    clearSessionOwner();

    // Remove ⏳ and 🛑 reactions from the user's prompt message
    if (adapterInstance) {
      adapterInstance.setThreadId(tracker.threadId);
      await adapterInstance.removeReaction(tracker.messageRef, "⏳").catch(() => {});
      await adapterInstance.removeReaction(tracker.messageRef, "🛑").catch(() => {});
      adapterInstance.clearThreadId();
    }

    // Ping the user who sent the prompt to notify them the task is done
    if (tracker && adapterInstance?.isReady()) {
      const pingThreadId = getDiscordThreadForSession(sessionId) ?? tracker.threadId;
      if (pingThreadId) {
        adapterInstance.setThreadId(pingThreadId);
        await adapterInstance.sendMessage(`✅ Done <@${tracker.authorId}>`).catch((err) => {
          logger.error("[Discord] Failed to send done ping:", err);
        });
        adapterInstance.clearThreadId();
      } else {
        logger.warn("[Discord] No thread found for done ping — skipping");
      }
    }
  });

  summaryAggregator.setOnSessionRetry(async (retryInfo) => {
    if (!adapterInstance?.isReady()) return;
    const threadId = getDiscordThreadForSession(retryInfo.sessionId);
    if (!threadId) return;
    adapterInstance.setThreadId(threadId);
    await adapterInstance.sendMessage(t("bot.session_retry", { message: retryInfo.message }));
    adapterInstance.clearThreadId();
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

  summaryAggregator.setOnQuestion(async (questions, requestID, sessionId) => {
    if (!adapterInstance?.isReady()) return;
    const threadId = getDiscordThreadForSession(sessionId);
    if (!threadId) return;
    adapterInstance.setThreadId(threadId);
    await toolMessageBatcherInstance?.flushSession(sessionId, "question_asked");
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
    if (!adapterInstance?.isReady()) return;
    const threadId = getDiscordThreadForSession(request.sessionID);
    if (!threadId) return;
    adapterInstance.setThreadId(threadId);
    await toolMessageBatcherInstance?.flushSession(request.sessionID, "permission_asked");
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

    // Only send to Discord if this session has a bound thread
    const threadId = getDiscordThreadForSession(polledSessionId);
    if (!threadId) return;
    adapterInstance.setThreadId(threadId);

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
        adapterInstance!.clearThreadId();
      },
      onError: (err) => {
        logger.error("[MessagePoller] Failed to send polled message to Discord:", err);
      },
    });

    // Debounce the "done" cleanup: reset timer on every polled message.
    // Only fire after POLLER_DONE_DEBOUNCE_MS of quiet AND session is idle.
    if (pollerDoneTimer) {
      clearTimeout(pollerDoneTimer);
    }
    pollerDoneTimer = setTimeout(() => {
      pollerDoneTimer = null;

      safeBackgroundTask({
        taskName: "message_poller.done_ping",
        task: async () => {
          // Verify the session is actually idle before pinging.
          // If still busy, skip — the next polled message will re-arm the timer.
          const currentSession = getCurrentSession();
          if (currentSession) {
            const busy = await isSessionBusy(currentSession.id, currentSession.directory);
            if (busy) {
              logger.debug("[MessagePoller] Session still busy after debounce, skipping done ping");
              return;
            }
          }

          logger.info("[MessagePoller] Session idle confirmed, cleaning up reactions and pinging");

          const pollerTracker = promptTracker.get(polledSessionId);
          clearSessionOwner();
          stopTypingIndicator(polledSessionId);

          // Remove reactions
          if (pollerTracker && adapterInstance) {
            adapterInstance.setThreadId(pollerTracker.threadId);
            await adapterInstance.removeReaction(pollerTracker.messageRef, "⏳").catch(() => {});
            await adapterInstance.removeReaction(pollerTracker.messageRef, "🛑").catch(() => {});
            adapterInstance.clearThreadId();
            promptTracker.delete(polledSessionId);
          }

          // Send done ping
          if (pollerTracker && adapterInstance?.isReady()) {
            const doneThreadId =
              getDiscordThreadForSession(polledSessionId) ?? pollerTracker.threadId;
            if (doneThreadId) {
              adapterInstance.setThreadId(doneThreadId);
              await adapterInstance.sendMessage(`✅ Done <@${pollerTracker.authorId}>`);
              adapterInstance.clearThreadId();
              logger.info(`[MessagePoller] Sent done ping to <@${pollerTracker.authorId}>`);
            } else {
              logger.warn("[MessagePoller] No thread found for done ping");
            }
          } else {
            logger.debug("[MessagePoller] Skipped done ping: no tracker or adapter not ready");
          }
        },
        onError: (err) => {
          logger.error("[MessagePoller] Done ping task failed:", err);
        },
      });
    }, POLLER_DONE_DEBOUNCE_MS);
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
  // Activate session in active pool (LRU touch — does NOT clear other sessions)
  activeSessionManager.activate(currentSession);
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

    // Restore adapter channel binding from persisted settings
    const savedChannelId = getDiscordChannelId();
    if (savedChannelId && adapterInstance) {
      adapterInstance.setChatId(savedChannelId);
      logger.info(`[Discord] Restored channel binding: ${savedChannelId}`);
    }

    // Restore thread-session mapping from persisted settings
    // Also re-activate sessions in activeSessionManager for multi-session support
    const savedThreadMap = getDiscordThreadMap();
    for (const [sessionId, threadId] of Object.entries(savedThreadMap)) {
      const sessionInfo = { id: sessionId, title: "", directory: "" };
      threadSessionMap.set(threadId, sessionInfo);
      activeSessionManager.activate(sessionInfo);
      logger.debug(`[Discord] Restored thread mapping: session=${sessionId} → thread=${threadId}`);
    }

    // Auto-subscribe to SSE events + start pollers at startup
    // (enables GUI→Discord forwarding without waiting for user interaction)
    const currentProject = getCurrentProject();
    if (currentProject?.worktree) {
      const currentSession = getCurrentSession();
      if (currentSession?.id) {
        summaryAggregator.setSession(currentSession.id);

        // Bind adapter to the current session's thread
        const currentThreadId = getDiscordThreadForSession(currentSession.id);
        if (currentThreadId && adapterInstance) {
          adapterInstance.setThreadId(currentThreadId);
          logger.info(
            `[Discord] Auto-bound to thread ${currentThreadId} for session ${currentSession.id}`,
          );
        }

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

    // Handle autocomplete interactions (must respond within 3s)
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "skills") {
        await handleSkillsAutocomplete(interaction);
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
        return handleSkillsCommand(interaction, {
          adapter: adapterInstance!,
          ensureEventSubscription: (_directory: string) =>
            autoSubscribeDiscordEvents(clientInstance!),
        });
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

      // Activate this thread's session (add/touch in active pool — do NOT clear other sessions)
      setCurrentSession(threadSession);
      activeSessionManager.activate(threadSession);
      summaryAggregator.setSession(threadSession.id);
      await autoSubscribeDiscordEvents(clientInstance!);

      adapter.setChatId(message.channelId);
      adapter.setThreadId(message.channelId);
      // Persist the parent channel ID (not the thread ID) for startup restoration
      const parentChannelId =
        "parentId" in message.channel && message.channel.parentId
          ? message.channel.parentId
          : message.channelId;
      setDiscordChannelId(parentChannelId);
    } else {
      // DM
      if (!isAuthorizedDiscordUser(message)) {
        await message.reply(t("discord.auth.unauthorized_dm"));
        return;
      }
      adapter.setChatId(message.channelId);
      setDiscordChannelId(message.channelId);
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
    // Track per-session for correct reaction cleanup and abort routing
    const activeThreadSession = threadSessionMap.get(message.channelId);
    if (activeThreadSession) {
      promptTracker.set(activeThreadSession.id, {
        messageRef: message.id,
        threadId: message.channelId,
        authorId: message.author.id,
      });
    }
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
    // Only care about 🛑
    if (reaction.emoji.name !== "🛑") return;

    // Find which session owns this message via promptTracker
    let targetSessionId: string | null = null;
    let targetTracker: { messageRef: string; threadId: string; authorId: string } | null = null;
    for (const [sid, tracker] of promptTracker) {
      if (tracker.messageRef === reaction.message.id) {
        targetSessionId = sid;
        targetTracker = tracker;
        break;
      }
    }
    if (!targetSessionId || !targetTracker) return;

    // Auth check — only the session owner or authorized users can abort via reaction
    const currentOwner = getSessionOwner();
    if (currentOwner && currentOwner !== user.id) return;

    logger.info(
      `[Discord] Abort triggered via 🛑 reaction by user ${user.id} for session ${targetSessionId}`,
    );

    // Find the full session info
    const abortSession =
      activeSessionManager.getActiveSessions().find((s) => s.id === targetSessionId) ??
      getCurrentSession();
    if (!abortSession || abortSession.id !== targetSessionId) return;

    try {
      summaryAggregator.clear();
      clearAllInteractionState("abort_reaction", targetSessionId);
      adapterInstance?.clearThreadId();

      await opencodeClient.session.abort({
        sessionID: abortSession.id,
        directory: abortSession.directory,
      });

      // Clean up both reactions
      if (adapterInstance) {
        adapterInstance.setThreadId(targetTracker.threadId);
        await adapterInstance.removeReaction(targetTracker.messageRef, "⏳").catch(() => {});
        await adapterInstance.removeReaction(targetTracker.messageRef, "🛑").catch(() => {});
        adapterInstance.clearThreadId();
      }
      promptTracker.delete(targetSessionId);
      stopTypingIndicator(targetSessionId);
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
  startQuestionPoller(project.worktree, async (questions, requestID, sessionId) => {
    if (!adapterInstance?.isReady()) return;

    // Skip if this question is already being shown
    if (questionManager.isActive() && questionManager.getRequestID() === requestID) return;

    logger.info(
      `[Discord] Question discovered by poller: requestID=${requestID}, questions=${questions.length}`,
    );

    if (questionManager.isActive()) {
      clearAllInteractionState("question_replaced_by_poller");
    }

    const threadId = getDiscordThreadForSession(sessionId);
    if (!threadId) return;
    adapterInstance.setThreadId(threadId);
    await toolMessageBatcherInstance?.flushSession(sessionId, "question_polled");

    questionManager.startQuestions(questions, requestID);
    markQuestionSeen(requestID);
    await showDiscordQuestion(adapterInstance);
  });
}
