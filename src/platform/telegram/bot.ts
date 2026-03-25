import { Bot, InputFile } from "grammy";
import type { Context, NextFunction } from "grammy";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "../../config.js";
import { authMiddleware } from "./middleware/auth.js";
import { interactionGuardMiddleware } from "./middleware/interaction-guard.js";
import { unknownCommandMiddleware } from "./middleware/unknown-command.js";
import { BOT_COMMANDS } from "./commands/definitions.js";
import { startCommand } from "./commands/start.js";
import { helpCommand } from "./commands/help.js";
import { statusCommand } from "./commands/status.js";
import {
  AGENT_MODE_BUTTON_TEXT_PATTERN,
  MODEL_BUTTON_TEXT_PATTERN,
  VARIANT_BUTTON_TEXT_PATTERN,
} from "../../bot/message-patterns.js";
import { sessionsCommand, handleSessionSelect } from "./commands/sessions.js";
import { newCommand } from "./commands/new.js";
import { projectsCommand, handleProjectSelect } from "./commands/projects.js";
import { abortCommand } from "./commands/abort.js";
import { opencodeStartCommand } from "./commands/opencode-start.js";
import { opencodeStopCommand } from "./commands/opencode-stop.js";
import { renameCommand, handleRenameCancel, handleRenameTextAnswer } from "./commands/rename.js";
import {
  commandsCommand,
  handleCommandsCallback,
  handleCommandTextArguments,
} from "./commands/commands.js";
import { skillsCommand } from "./commands/skills.js";
import {
  handleQuestionCallback,
  showCurrentQuestion,
  handleQuestionTextAnswer,
} from "./handlers/question.js";
import { handlePermissionCallback, showPermissionRequest } from "./handlers/permission.js";
import { handleAgentSelect, showAgentSelectionMenu } from "./handlers/agent.js";
import { handleModelSelect, showModelSelectionMenu } from "./handlers/model.js";
import { handleVariantSelect, showVariantSelectionMenu } from "./handlers/variant.js";
import { handleContextButtonPress, handleCompactConfirm } from "./handlers/context.js";
import { handleInlineMenuCancel } from "./handlers/inline-menu.js";
import { questionManager } from "../../question/manager.js";
import { permissionManager } from "../../permission/manager.js";
import { interactionManager } from "../../interaction/manager.js";
import { clearAllInteractionState } from "../../interaction/cleanup.js";
import { keyboardManager } from "./keyboard-manager.js";
import { subscribeToEvents } from "../../opencode/events.js";
import { summaryAggregator } from "../../summary/aggregator.js";
import { formatSummary, formatToolInfo } from "../../summary/formatter.js";
import { getAssistantParseMode, TELEGRAM_FORMAT_CONFIG } from "./formatter.js";
import { ToolMessageBatcher } from "../../summary/tool-message-batcher.js";
import { getCurrentSession } from "../../session/manager.js";
import { ingestSessionInfoForCache } from "../../session/cache-manager.js";
import { getCurrentProject } from "../../settings/manager.js";
import { logger } from "../../utils/logger.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { pinnedMessageManager } from "./pinned-manager.js";
import { t } from "../../i18n/index.js";
import { processUserPrompt } from "./handlers/prompt.js";
import { handleVoiceMessage } from "./handlers/voice.js";
import { handleDocumentMessage } from "./handlers/document.js";
import { downloadTelegramFile, toDataUri } from "./utils/file-download.js";
import { sendMessageWithMarkdownFallback } from "./utils/send-with-markdown-fallback.js";
import { getModelCapabilities, supportsInput } from "../../model/capabilities.js";
import { getStoredModel } from "../../model/manager.js";
import { opencodeClient } from "../../opencode/client.js";
import { shouldForwardAssistantReply } from "./utils/assistant-reply-forwarding.js";
import { startMessagePolling, stopMessagePolling } from "../../opencode/message-poller.js";
import { fromMessageRef } from "./adapter.js";
import {
  startQuestionPoller,
  stopQuestionPoller,
  markQuestionSeen,
} from "../../opencode/question-poller.js";
import type { FilePartInput } from "@opencode-ai/sdk/v2";

let botInstance: Bot<Context> | null = null;
let chatIdInstance: number | null = null;
let commandsInitialized = false;

// Track the last question/permission requestID that the BOT itself replied to,
// so we can distinguish bot-initiated replies from external (GUI) replies.
let lastBotQuestionReplyID: string | null = null;
let lastBotPermissionReplyID: string | null = null;

export function markBotQuestionReply(requestID: string): void {
  lastBotQuestionReplyID = requestID;
}

export function markBotPermissionReply(requestID: string): void {
  lastBotPermissionReplyID = requestID;
}

const TELEGRAM_DOCUMENT_CAPTION_MAX_LENGTH = 1024;
const SESSION_RETRY_PREFIX = "🔁";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMP_DIR = path.join(__dirname, "..", ".tmp");

function prepareDocumentCaption(caption: string): string {
  const normalizedCaption = caption.trim();
  if (!normalizedCaption) {
    return "";
  }

  if (normalizedCaption.length <= TELEGRAM_DOCUMENT_CAPTION_MAX_LENGTH) {
    return normalizedCaption;
  }

  return `${normalizedCaption.slice(0, TELEGRAM_DOCUMENT_CAPTION_MAX_LENGTH - 3)}...`;
}

const toolMessageBatcher = new ToolMessageBatcher({
  intervalSeconds: 5,
  messageMaxLength: TELEGRAM_FORMAT_CONFIG.messageMaxLength,
  sendText: async (sessionId, text) => {
    if (!botInstance || !chatIdInstance) {
      return;
    }

    const currentSession = getCurrentSession();
    if (!currentSession || currentSession.id !== sessionId) {
      return;
    }

    await botInstance.api.sendMessage(chatIdInstance, text, {
      disable_notification: true,
    });
  },
  sendFile: async (sessionId, fileData) => {
    if (!botInstance || !chatIdInstance) {
      return;
    }

    const currentSession = getCurrentSession();
    if (!currentSession || currentSession.id !== sessionId) {
      return;
    }

    const tempFilePath = path.join(TEMP_DIR, fileData.filename);

    try {
      logger.debug(
        `[Bot] Sending code file: ${fileData.filename} (${fileData.buffer.length} bytes, session=${sessionId})`,
      );

      await fs.mkdir(TEMP_DIR, { recursive: true });
      await fs.writeFile(tempFilePath, fileData.buffer);

      await botInstance.api.sendDocument(chatIdInstance, new InputFile(tempFilePath), {
        caption: fileData.caption,
        disable_notification: true,
      });
    } finally {
      await fs.unlink(tempFilePath).catch(() => {});
    }
  },
});

async function ensureCommandsInitialized(ctx: Context, next: NextFunction): Promise<void> {
  if (commandsInitialized || !ctx.from || ctx.from.id !== config.telegram.allowedUserId) {
    await next();
    return;
  }

  if (!ctx.chat) {
    logger.warn("[Bot] Cannot initialize commands: chat context is missing");
    await next();
    return;
  }

  try {
    await ctx.api.setMyCommands(BOT_COMMANDS, {
      scope: {
        type: "chat",
        chat_id: ctx.chat.id,
      },
    });

    commandsInitialized = true;
    logger.debug(`[Bot] Commands initialized for authorized user (chat_id=${ctx.chat.id})`);
  } catch (err) {
    logger.error("[Bot] Failed to set commands:", err);
  }

  await next();
}

async function ensureEventSubscription(directory: string): Promise<void> {
  if (!directory) {
    logger.error("No directory found for event subscription");
    return;
  }

  // Ensure aggregator has bot reference for typing indicators
  if (botInstance && chatIdInstance) {
    summaryAggregator.setTypingIndicator(async () => {
      if (botInstance && chatIdInstance) {
        await botInstance.api.sendChatAction(chatIdInstance, "typing");
      }
    });
  }

  toolMessageBatcher.setIntervalSeconds(config.bot.serviceMessagesIntervalSec);
  summaryAggregator.setOnCleared(() => {
    toolMessageBatcher.clearAll("summary_aggregator_clear");
    stopMessagePolling();
    stopQuestionPoller();
  });

  summaryAggregator.setOnComplete(async (sessionId, messageText) => {
    if (!botInstance || !chatIdInstance) {
      logger.error("Bot or chat ID not available for sending message");
      return;
    }

    const currentSession = getCurrentSession();
    const currentProject = getCurrentProject();

    const shouldForward = await shouldForwardAssistantReply({
      sessionId,
      currentSessionId: currentSession?.id,
      currentProjectDirectory: currentProject?.worktree,
      sessionExistsInProject: async (targetSessionId, directory) => {
        const { data: sessionInfo, error } = await opencodeClient.session.get({
          sessionID: targetSessionId,
          directory,
        });

        if (error || !sessionInfo) {
          return false;
        }

        logger.debug(
          `[Bot] Forwarding assistant reply from project-matched session: ${targetSessionId} (${sessionInfo.title})`,
        );
        return true;
      },
    });

    if (!shouldForward) {
      return;
    }

    await toolMessageBatcher.flushSession(sessionId, "assistant_message_completed");

    try {
      const parts = formatSummary(messageText, undefined, TELEGRAM_FORMAT_CONFIG);
      const assistantParseMode = getAssistantParseMode();

      logger.debug(
        `[Bot] Sending completed message to Telegram (chatId=${chatIdInstance}, parts=${parts.length})`,
      );

      for (let i = 0; i < parts.length; i++) {
        const isLastPart = i === parts.length - 1;
        const keyboard =
          isLastPart && keyboardManager.isInitialized() ? keyboardManager.getKeyboard() : undefined;
        const options = keyboard ? { reply_markup: keyboard } : undefined;

        await sendMessageWithMarkdownFallback({
          api: botInstance.api,
          chatId: chatIdInstance,
          text: parts[i],
          options,
          parseMode: assistantParseMode,
        });
      }
    } catch (err) {
      logger.error("Failed to send message to Telegram:", err);
      // Stop processing events after critical error to prevent infinite loop
      logger.error("[Bot] CRITICAL: Stopping event processing due to error");
      summaryAggregator.clear();
    }
  });

  summaryAggregator.setOnTool(async (toolInfo) => {
    if (!botInstance || !chatIdInstance) {
      logger.error("Bot or chat ID not available for sending tool notification");
      return;
    }

    const currentSession = getCurrentSession();
    if (!currentSession || currentSession.id !== toolInfo.sessionId) {
      return;
    }

    const shouldIncludeToolInfoInFileCaption =
      toolInfo.hasFileAttachment &&
      (toolInfo.tool === "write" || toolInfo.tool === "edit" || toolInfo.tool === "apply_patch");

    if (config.bot.hideToolCallMessages || shouldIncludeToolInfoInFileCaption) {
      return;
    }

    try {
      const message = formatToolInfo(toolInfo);
      if (message) {
        toolMessageBatcher.enqueue(toolInfo.sessionId, message);
      }
    } catch (err) {
      logger.error("Failed to send tool notification to Telegram:", err);
    }
  });

  summaryAggregator.setOnToolFile(async (fileInfo) => {
    if (!botInstance || !chatIdInstance) {
      logger.error("Bot or chat ID not available for sending file");
      return;
    }

    const currentSession = getCurrentSession();
    if (!currentSession || currentSession.id !== fileInfo.sessionId) {
      return;
    }

    try {
      const toolMessage = formatToolInfo(fileInfo);
      const caption = prepareDocumentCaption(toolMessage || fileInfo.fileData.caption);

      toolMessageBatcher.enqueueFile(fileInfo.sessionId, {
        ...fileInfo.fileData,
        caption,
      });
    } catch (err) {
      logger.error("Failed to send file to Telegram:", err);
    }
  });

  summaryAggregator.setOnQuestion(async (questions, requestID, _sessionId) => {
    if (!botInstance || !chatIdInstance) {
      logger.error("Bot or chat ID not available for showing questions");
      return;
    }

    const currentSession = getCurrentSession();
    if (currentSession) {
      await toolMessageBatcher.flushSession(currentSession.id, "question_asked");
    }

    if (questionManager.isActive()) {
      logger.warn("[Bot] Replacing active poll with a new one");

      const previousMessageIds = questionManager.getMessageIds();
      for (const messageId of previousMessageIds) {
        await botInstance.api
          .deleteMessage(chatIdInstance, fromMessageRef(messageId))
          .catch(() => {});
      }

      clearAllInteractionState("question_replaced_by_new_poll");
    }

    logger.info(`[Bot] Received ${questions.length} questions from agent, requestID=${requestID}`);
    markQuestionSeen(requestID);
    questionManager.startQuestions(questions, requestID);
    await showCurrentQuestion(botInstance.api, chatIdInstance);
  });

  summaryAggregator.setOnQuestionError(async () => {
    logger.info(`[Bot] Question tool failed, clearing active poll and deleting messages`);

    // Delete all messages from the invalid poll
    const messageIds = questionManager.getMessageIds();
    for (const messageId of messageIds) {
      if (chatIdInstance) {
        await botInstance?.api
          .deleteMessage(chatIdInstance, fromMessageRef(messageId))
          .catch((err) => {
            logger.error(`[Bot] Failed to delete question message ${messageId}:`, err);
          });
      }
    }

    clearAllInteractionState("question_error");
  });

  // Handle question answered externally (e.g., from GUI) — "first answer wins"
  summaryAggregator.setOnQuestionExternalReply((requestID) => {
    // If the bot itself sent this reply, ignore (not external)
    if (lastBotQuestionReplyID === requestID) {
      lastBotQuestionReplyID = null;
      logger.debug(`[Bot] Ignoring question.replied for bot's own reply: ${requestID}`);
      return;
    }

    if (!questionManager.isActive()) return;

    // Check if this reply is for our active question
    const activeRequestID = questionManager.getRequestID();
    if (activeRequestID && activeRequestID !== requestID) return;

    logger.info(
      `[Bot] Question answered externally (GUI): requestID=${requestID}, dismissing Telegram poll`,
    );

    // Edit Telegram messages to show "answered externally" and remove buttons
    const messageIds = questionManager.getMessageIds();
    logger.debug(
      `[Bot] External reply: messageIds=${JSON.stringify(messageIds)}, botInstance=${!!botInstance}, chatId=${chatIdInstance}`,
    );
    for (const messageId of messageIds) {
      if (botInstance && chatIdInstance) {
        botInstance.api
          .editMessageText(
            chatIdInstance,
            fromMessageRef(messageId),
            t("question.answered_externally"),
          )
          .then(() => {
            logger.info(
              `[Bot] Edited question message ${messageId}: replaced with "answered externally"`,
            );
          })
          .catch((err) => {
            logger.debug(`[Bot] Failed to edit question message ${messageId}:`, err);
          });
      }
    }

    clearAllInteractionState("question_answered_externally");
  });

  // Handle permission answered externally (e.g., from GUI)
  summaryAggregator.setOnPermissionExternalReply((requestID) => {
    // If the bot itself sent this reply, ignore (not external)
    if (lastBotPermissionReplyID === requestID) {
      lastBotPermissionReplyID = null;
      logger.debug(`[Bot] Ignoring permission.replied for bot's own reply: ${requestID}`);
      return;
    }

    if (!permissionManager.isActive()) return;

    logger.info(
      `[Bot] Permission handled externally (GUI): requestID=${requestID}, dismissing Telegram buttons`,
    );

    const messageIds = permissionManager.getMessageIds();
    for (const messageId of messageIds) {
      if (botInstance && chatIdInstance) {
        botInstance.api
          .editMessageText(
            chatIdInstance,
            fromMessageRef(messageId),
            t("permission.answered_externally"),
          )
          .catch((err) => {
            logger.debug(`[Bot] Failed to edit permission message ${messageId}:`, err);
          });
      }
    }

    clearAllInteractionState("permission_answered_externally");
  });

  summaryAggregator.setOnPermission(async (request) => {
    if (!botInstance || !chatIdInstance) {
      logger.error("Bot or chat ID not available for showing permission request");
      return;
    }

    await toolMessageBatcher.flushSession(request.sessionID, "permission_asked");

    logger.info(
      `[Bot] Received permission request from agent: type=${request.permission}, requestID=${request.id}`,
    );
    await showPermissionRequest(botInstance.api, chatIdInstance, request);
  });

  summaryAggregator.setOnThinking(async (sessionId) => {
    if (config.bot.hideThinkingMessages) {
      return;
    }

    if (!botInstance || !chatIdInstance) {
      return;
    }

    const currentSession = getCurrentSession();
    if (!currentSession || currentSession.id !== sessionId) {
      return;
    }

    logger.debug("[Bot] Agent started thinking");

    toolMessageBatcher.enqueue(sessionId, t("bot.thinking"));
  });

  summaryAggregator.setOnTokens(async (tokens) => {
    if (!pinnedMessageManager.isInitialized()) {
      return;
    }

    try {
      logger.debug(`[Bot] Received tokens: input=${tokens.input}, output=${tokens.output}`);

      // Update keyboardManager SYNCHRONOUSLY before any await
      // This ensures keyboard has correct context when onComplete sends the reply
      const contextSize = tokens.input + tokens.cacheRead;
      const contextLimit = pinnedMessageManager.getContextLimit();
      if (contextLimit > 0) {
        keyboardManager.updateContext(contextSize, contextLimit);
      }

      await pinnedMessageManager.onMessageComplete(tokens);
    } catch (err) {
      logger.error("[Bot] Error updating pinned message with tokens:", err);
    }
  });

  summaryAggregator.setOnSessionCompacted(async (sessionId, directory) => {
    if (!pinnedMessageManager.isInitialized()) {
      return;
    }

    try {
      logger.info(`[Bot] Session compacted, reloading context: ${sessionId}`);
      await pinnedMessageManager.onSessionCompacted(sessionId, directory);
    } catch (err) {
      logger.error("[Bot] Error reloading context after compaction:", err);
    }
  });

  summaryAggregator.setOnSessionError(async (sessionId, message) => {
    if (!botInstance || !chatIdInstance) {
      return;
    }

    const currentSession = getCurrentSession();
    if (!currentSession || currentSession.id !== sessionId) {
      return;
    }

    await toolMessageBatcher.flushSession(sessionId, "session_error");

    const normalizedMessage = message.trim() || t("common.unknown_error");
    const truncatedMessage =
      normalizedMessage.length > 3500
        ? `${normalizedMessage.slice(0, 3497)}...`
        : normalizedMessage;

    await botInstance.api
      .sendMessage(chatIdInstance, t("bot.session_error", { message: truncatedMessage }))
      .catch((err) => {
        logger.error("[Bot] Failed to send session.error message:", err);
      });
  });

  summaryAggregator.setOnSessionRetry(async ({ sessionId, message }) => {
    if (!botInstance || !chatIdInstance) {
      return;
    }

    const currentSession = getCurrentSession();
    if (!currentSession || currentSession.id !== sessionId) {
      return;
    }

    const normalizedMessage = message.trim() || t("common.unknown_error");
    const truncatedMessage =
      normalizedMessage.length > 3500
        ? `${normalizedMessage.slice(0, 3497)}...`
        : normalizedMessage;

    const retryMessage = t("bot.session_retry", { message: truncatedMessage });
    toolMessageBatcher.enqueueUniqueByPrefix(sessionId, retryMessage, SESSION_RETRY_PREFIX);
  });

  summaryAggregator.setOnSessionDiff(async (_sessionId, diffs) => {
    if (!pinnedMessageManager.isInitialized()) {
      return;
    }

    try {
      await pinnedMessageManager.onSessionDiff(diffs);
    } catch (err) {
      logger.error("[Bot] Error updating session diff:", err);
    }
  });

  summaryAggregator.setOnFileChange((change) => {
    if (!pinnedMessageManager.isInitialized()) {
      return;
    }
    pinnedMessageManager.addFileChange(change);
  });

  pinnedMessageManager.setOnKeyboardUpdate(async (tokensUsed, tokensLimit) => {
    try {
      logger.debug(`[Bot] Updating keyboard with context: ${tokensUsed}/${tokensLimit}`);
      keyboardManager.updateContext(tokensUsed, tokensLimit);
      // Don't send automatic keyboard updates - keyboard will update naturally with user messages
    } catch (err) {
      logger.error("[Bot] Error updating keyboard context:", err);
    }
  });

  logger.info(`[Bot] Subscribing to OpenCode events for project: ${directory}`);
  subscribeToEvents(directory, (event) => {
    if (event.type === "session.created" || event.type === "session.updated") {
      const info = (
        event.properties as { info?: { directory?: string; time?: { updated?: number } } }
      ).info;

      if (info?.directory) {
        safeBackgroundTask({
          taskName: `session.cache.${event.type}`,
          task: () => ingestSessionInfoForCache(info),
        });
      }
    }

    summaryAggregator.processEvent(event);
  }).catch((err) => {
    logger.error("Failed to subscribe to events:", err);
  });

  // Start (or re-sync) the message poller for the current session.
  // This catches assistant replies from the GUI that the SSE aggregator may miss.
  const pollerSession = getCurrentSession();
  if (pollerSession?.id) {
    startPollerForSession(pollerSession.id, directory);
  }
}

/**
 * Start the message poller for the given session. The poller detects
 * completed assistant replies that the SSE aggregator did not pick up
 * (e.g. messages originating from the OpenCode GUI) and forwards them
 * to Telegram.
 */
function startPollerForSession(sessionId: string, directory: string): void {
  startMessagePolling(sessionId, directory, (polledSessionId, messageText) => {
    if (!botInstance || !chatIdInstance) return;

    const parts = formatSummary(messageText, undefined, TELEGRAM_FORMAT_CONFIG);
    const parseMode = getAssistantParseMode();
    const bot = botInstance;
    const chatId = chatIdInstance;

    logger.info(
      `[MessagePoller] Forwarding polled assistant reply to Telegram (session=${polledSessionId}, parts=${parts.length})`,
    );

    safeBackgroundTask({
      taskName: "message_poller.forward",
      task: async () => {
        for (let i = 0; i < parts.length; i++) {
          const isLast = i === parts.length - 1;
          const keyboard =
            isLast && keyboardManager.isInitialized() ? keyboardManager.getKeyboard() : undefined;
          const options = keyboard ? { reply_markup: keyboard } : undefined;

          await sendMessageWithMarkdownFallback({
            api: bot.api,
            chatId,
            text: parts[i],
            options,
            parseMode,
          });
        }
      },
      onError: (err) => {
        logger.error("[MessagePoller] Failed to send polled message to Telegram:", err);
      },
    });
  }).catch((err: unknown) => {
    logger.warn("[MessagePoller] Failed to start polling:", err);
  });
}

/**
 * Auto-subscribe to SSE events at startup if a saved project exists.
 * This enables GUI→Telegram forwarding without waiting for user interaction.
 *
 * Also sets the session in the aggregator and starts the message poller
 * so that GUI-originated messages are detected immediately.
 */
export async function autoSubscribeEvents(bot: Bot<Context>): Promise<void> {
  const currentProject = getCurrentProject();
  if (!currentProject?.worktree) {
    logger.debug("[Bot] No saved project — skipping auto SSE subscription");
    return;
  }

  // In a single-user private chat, chatId equals the user ID
  const chatId = config.telegram.allowedUserId;

  botInstance = bot;
  chatIdInstance = chatId;
  summaryAggregator.setTypingIndicator(async () => {
    if (botInstance && chatIdInstance) {
      await botInstance.api.sendChatAction(chatIdInstance, "typing");
    }
  });

  // Set the session in the aggregator so SSE message events are not dropped.
  const currentSession = getCurrentSession();
  if (currentSession?.id) {
    summaryAggregator.setSession(currentSession.id);
    logger.info(`[Bot] Auto-set aggregator session: ${currentSession.id}`);

    // Start polling for GUI-originated messages in this session.
    startPollerForSession(currentSession.id, currentProject.worktree);
  }

  // Start question poller to discover questions from GUI that SSE might miss.
  startQuestionPoller(currentProject.worktree, async (questions, requestID, sessionId) => {
    if (!botInstance || !chatIdInstance) return;

    // Skip if this question is already being shown
    if (questionManager.isActive() && questionManager.getRequestID() === requestID) return;

    logger.info(
      `[Bot] Question discovered by poller: requestID=${requestID}, session=${sessionId}, questions=${questions.length}`,
    );

    if (questionManager.isActive()) {
      const previousMessageIds = questionManager.getMessageIds();
      for (const messageId of previousMessageIds) {
        await botInstance.api
          .deleteMessage(chatIdInstance, fromMessageRef(messageId))
          .catch(() => {});
      }
      clearAllInteractionState("question_replaced_by_poller");
    }

    const currentSession = getCurrentSession();
    if (currentSession) {
      await toolMessageBatcher.flushSession(currentSession.id, "question_polled");
    }

    questionManager.startQuestions(questions, requestID);
    await showCurrentQuestion(botInstance.api, chatIdInstance);
  });

  logger.info(`[Bot] Auto-subscribing to SSE events for project: ${currentProject.worktree}`);

  try {
    await ensureEventSubscription(currentProject.worktree);
    logger.info("[Bot] SSE auto-subscription established");
  } catch (err) {
    logger.warn("[Bot] SSE auto-subscription failed (will retry on first user message):", err);
  }
}

export function createBot(): Bot<Context> {
  clearAllInteractionState("bot_startup");
  toolMessageBatcher.setIntervalSeconds(config.bot.serviceMessagesIntervalSec);
  logger.debug(
    `[ToolBatcher] Service messages interval: ${config.bot.serviceMessagesIntervalSec}s`,
  );

  const botOptions: ConstructorParameters<typeof Bot<Context>>[1] = {};

  if (config.telegram.proxyUrl) {
    const proxyUrl = config.telegram.proxyUrl;
    const agent = proxyUrl.startsWith("socks")
      ? new SocksProxyAgent(proxyUrl)
      : new HttpsProxyAgent(proxyUrl);

    if (proxyUrl.startsWith("socks")) {
      logger.info(`[Bot] Using SOCKS proxy: ${proxyUrl.replace(/\/\/.*@/, "//***@")}`);
    } else {
      logger.info(`[Bot] Using HTTP/HTTPS proxy: ${proxyUrl.replace(/\/\/.*@/, "//***@")}`);
    }

    botOptions.client = {
      baseFetchConfig: {
        agent,
        compress: true,
      },
    };
  }

  const bot = new Bot(config.telegram.token, botOptions);

  // Heartbeat for diagnostics: verify the event loop is not blocked
  let heartbeatCounter = 0;
  setInterval(() => {
    heartbeatCounter++;
    if (heartbeatCounter % 6 === 0) {
      // Log every 30 seconds (5 sec * 6)
      logger.debug(`[Bot] Heartbeat #${heartbeatCounter} - event loop alive`);
    }
  }, 5000);

  // Log all API calls for diagnostics
  let lastGetUpdatesTime = Date.now();
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === "getUpdates") {
      const now = Date.now();
      const timeSinceLast = now - lastGetUpdatesTime;
      logger.debug(`[Bot API] getUpdates called (${timeSinceLast}ms since last)`);
      lastGetUpdatesTime = now;
    } else if (method === "sendMessage") {
      logger.debug(`[Bot API] sendMessage to chat ${(payload as { chat_id?: number }).chat_id}`);
    }
    return prev(method, payload, signal);
  });

  bot.use((ctx, next) => {
    const hasCallbackQuery = !!ctx.callbackQuery;
    const hasMessage = !!ctx.message;
    const callbackData = ctx.callbackQuery?.data || "N/A";
    logger.debug(
      `[DEBUG] Incoming update: hasCallbackQuery=${hasCallbackQuery}, hasMessage=${hasMessage}, callbackData=${callbackData}`,
    );
    return next();
  });

  bot.use(authMiddleware);
  bot.use(ensureCommandsInitialized);
  bot.use(interactionGuardMiddleware);

  const blockMenuWhileInteractionActive = async (ctx: Context): Promise<boolean> => {
    const activeInteraction = interactionManager.getSnapshot();
    if (!activeInteraction) {
      return false;
    }

    logger.debug(
      `[Bot] Blocking menu open while interaction active: kind=${activeInteraction.kind}, expectedInput=${activeInteraction.expectedInput}`,
    );
    await ctx.reply(t("interaction.blocked.finish_current"));
    return true;
  };

  bot.command("start", startCommand);
  bot.command("help", helpCommand);
  bot.command("status", statusCommand);
  bot.command("opencode_start", opencodeStartCommand);
  bot.command("opencode_stop", opencodeStopCommand);
  bot.command("projects", projectsCommand);
  bot.command("sessions", sessionsCommand);
  bot.command("new", (ctx) => {
    botInstance = bot;
    chatIdInstance = ctx.chat.id;
    summaryAggregator.setTypingIndicator(async () => {
      if (botInstance && chatIdInstance) {
        await botInstance.api.sendChatAction(chatIdInstance, "typing");
      }
    });
    return newCommand(ctx, { ensureEventSubscription });
  });
  bot.command("abort", abortCommand);
  bot.command("rename", renameCommand);
  bot.command("commands", commandsCommand);
  bot.command("skills", skillsCommand);

  bot.on("message:text", unknownCommandMiddleware);

  bot.on("callback_query:data", async (ctx) => {
    logger.debug(`[Bot] Received callback_query:data: ${ctx.callbackQuery?.data}`);
    logger.debug(`[Bot] Callback context: from=${ctx.from?.id}, chat=${ctx.chat?.id}`);

    if (ctx.chat) {
      botInstance = bot;
      chatIdInstance = ctx.chat.id;
    }

    try {
      const handledInlineCancel = await handleInlineMenuCancel(ctx);
      const handledSession = await handleSessionSelect(ctx, { ensureEventSubscription });
      const handledProject = await handleProjectSelect(ctx);
      const handledQuestion = await handleQuestionCallback(ctx);
      const handledPermission = await handlePermissionCallback(ctx);
      const handledAgent = await handleAgentSelect(ctx);
      const handledModel = await handleModelSelect(ctx);
      const handledVariant = await handleVariantSelect(ctx);
      const handledCompactConfirm = await handleCompactConfirm(ctx);
      const handledRenameCancel = await handleRenameCancel(ctx);
      const handledCommands = await handleCommandsCallback(ctx, { bot, ensureEventSubscription });

      logger.debug(
        `[Bot] Callback handled: inlineCancel=${handledInlineCancel}, session=${handledSession}, project=${handledProject}, question=${handledQuestion}, permission=${handledPermission}, agent=${handledAgent}, model=${handledModel}, variant=${handledVariant}, compactConfirm=${handledCompactConfirm}, rename=${handledRenameCancel}, commands=${handledCommands}`,
      );

      if (
        !handledInlineCancel &&
        !handledSession &&
        !handledProject &&
        !handledQuestion &&
        !handledPermission &&
        !handledAgent &&
        !handledModel &&
        !handledVariant &&
        !handledCompactConfirm &&
        !handledRenameCancel &&
        !handledCommands
      ) {
        logger.debug("Unknown callback query:", ctx.callbackQuery?.data);
        await ctx.answerCallbackQuery({ text: t("callback.unknown_command") });
      }
    } catch (err) {
      logger.error("[Bot] Error handling callback:", err);
      clearAllInteractionState("callback_handler_error");
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    }
  });

  // Handle Reply Keyboard button press (agent mode indicator)
  bot.hears(AGENT_MODE_BUTTON_TEXT_PATTERN, async (ctx) => {
    logger.debug(`[Bot] Agent mode button pressed: ${ctx.message?.text}`);

    try {
      if (await blockMenuWhileInteractionActive(ctx)) {
        return;
      }

      await showAgentSelectionMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing agent menu:", err);
      await ctx.reply(t("error.load_agents"));
    }
  });

  // Handle Reply Keyboard button press (model selector)
  // Model button text is produced by formatModelForButton() and always starts with "🤖 ".
  bot.hears(MODEL_BUTTON_TEXT_PATTERN, async (ctx) => {
    logger.debug(`[Bot] Model button pressed: ${ctx.message?.text}`);

    try {
      if (await blockMenuWhileInteractionActive(ctx)) {
        return;
      }

      await showModelSelectionMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing model menu:", err);
      await ctx.reply(t("error.load_models"));
    }
  });

  // Handle Reply Keyboard button press (context button)
  bot.hears(/^📊(?:\s|$)/, async (ctx) => {
    logger.debug(`[Bot] Context button pressed: ${ctx.message?.text}`);

    try {
      if (await blockMenuWhileInteractionActive(ctx)) {
        return;
      }

      await handleContextButtonPress(ctx);
    } catch (err) {
      logger.error("[Bot] Error handling context button:", err);
      await ctx.reply(t("error.context_button"));
    }
  });

  // Handle Reply Keyboard button press (variant selector)
  // Keep support for both legacy "💭" and current "💡" prefix.
  bot.hears(VARIANT_BUTTON_TEXT_PATTERN, async (ctx) => {
    logger.debug(`[Bot] Variant button pressed: ${ctx.message?.text}`);

    try {
      if (await blockMenuWhileInteractionActive(ctx)) {
        return;
      }

      await showVariantSelectionMenu(ctx);
    } catch (err) {
      logger.error("[Bot] Error showing variant menu:", err);
      await ctx.reply(t("error.load_variants"));
    }
  });

  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message?.text;
    if (text) {
      const isCommand = text.startsWith("/");
      logger.debug(
        `[Bot] Received text message: ${isCommand ? `command="${text}"` : `prompt (length=${text.length})`}, chatId=${ctx.chat.id}`,
      );
    }
    await next();
  });

  // Remove any previously set global commands to prevent unauthorized users from seeing them
  safeBackgroundTask({
    taskName: "bot.clearGlobalCommands",
    task: async () => {
      try {
        await Promise.all([
          bot.api.setMyCommands([], { scope: { type: "default" } }),
          bot.api.setMyCommands([], { scope: { type: "all_private_chats" } }),
        ]);
        return { success: true as const };
      } catch (error) {
        return { success: false as const, error };
      }
    },
    onSuccess: (result) => {
      if (result.success) {
        logger.debug("[Bot] Cleared global commands (default and all_private_chats scopes)");
        return;
      }

      logger.warn("[Bot] Could not clear global commands:", result.error);
    },
  });

  // Voice and audio message handlers (STT transcription -> prompt)
  const voicePromptDeps = { bot, ensureEventSubscription };

  bot.on("message:voice", async (ctx) => {
    logger.debug(`[Bot] Received voice message, chatId=${ctx.chat.id}`);
    botInstance = bot;
    chatIdInstance = ctx.chat.id;
    await handleVoiceMessage(ctx, voicePromptDeps);
  });

  bot.on("message:audio", async (ctx) => {
    logger.debug(`[Bot] Received audio message, chatId=${ctx.chat.id}`);
    botInstance = bot;
    chatIdInstance = ctx.chat.id;
    await handleVoiceMessage(ctx, voicePromptDeps);
  });

  // Photo message handler
  bot.on("message:photo", async (ctx) => {
    logger.debug(`[Bot] Received photo message, chatId=${ctx.chat.id}`);

    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) {
      return;
    }

    const caption = ctx.message.caption || "";

    try {
      // Get the largest photo (last element in array)
      const largestPhoto = photos[photos.length - 1];

      // Check model capabilities
      const storedModel = getStoredModel();
      const capabilities = await getModelCapabilities(storedModel.providerID, storedModel.modelID);

      if (!supportsInput(capabilities, "image")) {
        logger.warn(
          `[Bot] Model ${storedModel.providerID}/${storedModel.modelID} doesn't support image input`,
        );
        await ctx.reply(t("bot.photo_model_no_image"));

        // Fall back to caption-only if present
        if (caption.trim().length > 0) {
          botInstance = bot;
          chatIdInstance = ctx.chat.id;
          const promptDeps = { bot, ensureEventSubscription };
          await processUserPrompt(ctx, caption, promptDeps);
        }
        return;
      }

      // Download photo
      await ctx.reply(t("bot.photo_downloading"));
      const downloadedFile = await downloadTelegramFile(ctx.api, largestPhoto.file_id);

      // Convert to data URI (Telegram always converts photos to JPEG)
      const dataUri = toDataUri(downloadedFile.buffer, "image/jpeg");

      // Create file part
      const filePart: FilePartInput = {
        type: "file",
        mime: "image/jpeg",
        filename: "photo.jpg",
        url: dataUri,
      };

      logger.info(`[Bot] Sending photo (${downloadedFile.buffer.length} bytes) with prompt`);

      botInstance = bot;
      chatIdInstance = ctx.chat.id;

      // Send via processUserPrompt with file part
      const promptDeps = { bot, ensureEventSubscription };
      await processUserPrompt(ctx, caption, promptDeps, [filePart]);
    } catch (err) {
      logger.error("[Bot] Error handling photo message:", err);
      await ctx.reply(t("bot.photo_download_error"));
    }
  });

  // Document message handler (PDF and text files)
  bot.on("message:document", async (ctx) => {
    logger.debug(`[Bot] Received document message, chatId=${ctx.chat.id}`);
    botInstance = bot;
    chatIdInstance = ctx.chat.id;
    const deps = { bot, ensureEventSubscription };
    await handleDocumentMessage(ctx, deps);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message?.text;
    if (!text) {
      return;
    }

    botInstance = bot;
    chatIdInstance = ctx.chat.id;

    if (text.startsWith("/")) {
      return;
    }

    if (questionManager.isActive()) {
      await handleQuestionTextAnswer(ctx);
      return;
    }

    const handledRename = await handleRenameTextAnswer(ctx);
    if (handledRename) {
      return;
    }

    const promptDeps = { bot, ensureEventSubscription };
    const handledCommandArgs = await handleCommandTextArguments(ctx, promptDeps);
    if (handledCommandArgs) {
      return;
    }

    await processUserPrompt(ctx, text, promptDeps);

    logger.debug("[Bot] message:text handler completed (prompt sent in background)");
  });

  bot.catch((err) => {
    logger.error("[Bot] Unhandled error in bot:", err);
    clearAllInteractionState("bot_unhandled_error");
    if (err.ctx) {
      logger.error(
        "[Bot] Error context - update type:",
        err.ctx.update ? Object.keys(err.ctx.update) : "unknown",
      );
    }
  });

  return bot;
}
