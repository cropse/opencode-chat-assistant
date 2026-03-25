import { Event, ToolState } from "@opencode-ai/sdk/v2";
import type { CodeFileData } from "./formatter.js";
import { normalizePathForDisplay, prepareCodeFile } from "./formatter.js";
import type { Question } from "../question/types.js";
import type { PermissionRequest } from "../permission/types.js";
import type { FileChange } from "../platform/types.js";
import { logger } from "../utils/logger.js";
import { getCurrentProject } from "../settings/manager.js";
import { markMessageProcessed, clearProcessedMessages } from "../opencode/processed-messages.js";

export interface SummaryInfo {
  sessionId: string;
  text: string;
  messageCount: number;
  lastUpdated: number;
}

type MessageCompleteCallback = (sessionId: string, messageText: string) => void;

export interface ToolInfo {
  sessionId: string;
  messageId: string;
  callId: string;
  tool: string;
  state: ToolState;
  input?: { [key: string]: unknown };
  title?: string;
  metadata?: { [key: string]: unknown };
  hasFileAttachment?: boolean;
}

export interface ToolFileInfo extends ToolInfo {
  hasFileAttachment: true;
  fileData: CodeFileData;
}

type ToolCallback = (toolInfo: ToolInfo) => void;

type ToolFileCallback = (fileInfo: ToolFileInfo) => void;

type QuestionCallback = (questions: Question[], requestID: string, sessionId: string) => void;

type QuestionErrorCallback = () => void;

type QuestionExternalReplyCallback = (requestID: string) => void;

type PermissionExternalReplyCallback = (requestID: string) => void;

type ThinkingCallback = (sessionId: string) => void;

export interface TokensInfo {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

type TokensCallback = (tokens: TokensInfo) => void;

type SessionCompactedCallback = (sessionId: string, directory: string) => void;

type SessionErrorCallback = (sessionId: string, message: string) => void;

export interface SessionRetryInfo {
  sessionId: string;
  attempt?: number;
  message: string;
  next?: number;
}

type SessionRetryCallback = (retryInfo: SessionRetryInfo) => void;

type PermissionCallback = (request: PermissionRequest) => void;

type SessionDiffCallback = (sessionId: string, diffs: FileChange[]) => void;

type FileChangeCallback = (change: FileChange) => void;

type ClearedCallback = () => void;

type SessionIdleCallback = (sessionId: string) => void;

interface PreparedToolFileContext {
  fileData: CodeFileData | null;
  fileChange: FileChange | null;
}

interface MessagePartDeltaEvent {
  type: "message.part.delta";
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  };
}

function extractFirstUpdatedFileFromTitle(title: string): string {
  for (const rawLine of title.split("\n")) {
    const line = rawLine.trim();
    if (line.length >= 3 && line[1] === " " && /[AMDURC]/.test(line[0])) {
      return line.slice(2).trim();
    }
  }
  return "";
}

function countDiffChangesFromText(text: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  return { additions, deletions };
}

interface SessionBucket {
  currentMessageParts: Map<string, string[]>;
  pendingParts: Map<string, string[]>;
  messages: Map<string, { role: string }>;
  messageCount: number;
  processedToolStates: Set<string>;
  thinkingFiredForMessages: Set<string>;
  partHashes: Map<string, Set<string>>;
  lastActivity: number;
}

type IsSessionActiveCallback = (sessionId: string) => boolean;

class SummaryAggregator {
  private focusedSessionId: string | null = null;
  private isSessionActiveCallback: IsSessionActiveCallback | null = null;
  private sessionBuckets: Map<string, SessionBucket> = new Map();
  private lastUpdated = 0;
  private onCompleteCallback: MessageCompleteCallback | null = null;
  private onToolCallback: ToolCallback | null = null;
  private onToolFileCallback: ToolFileCallback | null = null;
  private onQuestionCallback: QuestionCallback | null = null;
  private onQuestionErrorCallback: QuestionErrorCallback | null = null;
  private onQuestionExternalReplyCallback: QuestionExternalReplyCallback | null = null;
  private onPermissionExternalReplyCallback: PermissionExternalReplyCallback | null = null;
  private onThinkingCallback: ThinkingCallback | null = null;
  private onTokensCallback: TokensCallback | null = null;
  private onSessionCompactedCallback: SessionCompactedCallback | null = null;
  private onSessionErrorCallback: SessionErrorCallback | null = null;
  private onSessionRetryCallback: SessionRetryCallback | null = null;
  private onPermissionCallback: PermissionCallback | null = null;
  private onSessionDiffCallback: SessionDiffCallback | null = null;
  private onFileChangeCallback: FileChangeCallback | null = null;
  private onClearedCallback: ClearedCallback | null = null;
  private onSessionIdleCallback: SessionIdleCallback | null = null;
  private typingIndicatorCallback: (() => Promise<void>) | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;

  setTypingIndicator(callback: () => Promise<void>): void {
    this.typingIndicatorCallback = callback;
  }

  setOnComplete(callback: MessageCompleteCallback): void {
    this.onCompleteCallback = callback;
  }

  setOnTool(callback: ToolCallback): void {
    this.onToolCallback = callback;
  }

  setOnToolFile(callback: ToolFileCallback): void {
    this.onToolFileCallback = callback;
  }

  setOnQuestion(callback: QuestionCallback): void {
    this.onQuestionCallback = callback;
  }

  setOnQuestionError(callback: QuestionErrorCallback): void {
    this.onQuestionErrorCallback = callback;
  }

  setOnQuestionExternalReply(callback: QuestionExternalReplyCallback): void {
    this.onQuestionExternalReplyCallback = callback;
  }

  setOnPermissionExternalReply(callback: PermissionExternalReplyCallback): void {
    this.onPermissionExternalReplyCallback = callback;
  }

  setOnThinking(callback: ThinkingCallback): void {
    this.onThinkingCallback = callback;
  }

  setOnTokens(callback: TokensCallback): void {
    this.onTokensCallback = callback;
  }

  setOnSessionCompacted(callback: SessionCompactedCallback): void {
    this.onSessionCompactedCallback = callback;
  }

  setOnSessionError(callback: SessionErrorCallback): void {
    this.onSessionErrorCallback = callback;
  }

  setOnSessionRetry(callback: SessionRetryCallback): void {
    this.onSessionRetryCallback = callback;
  }

  setOnPermission(callback: PermissionCallback): void {
    this.onPermissionCallback = callback;
  }

  setOnSessionDiff(callback: SessionDiffCallback): void {
    this.onSessionDiffCallback = callback;
  }

  setOnFileChange(callback: FileChangeCallback): void {
    this.onFileChangeCallback = callback;
  }

  setOnCleared(callback: ClearedCallback): void {
    this.onClearedCallback = callback;
  }

  setOnSessionIdle(callback: SessionIdleCallback): void {
    this.onSessionIdleCallback = callback;
  }

  setIsSessionActiveCallback(callback: IsSessionActiveCallback): void {
    this.isSessionActiveCallback = callback;
  }

  setFocusedSession(sessionId: string): void {
    this.focusedSessionId = sessionId;
  }

  getFocusedSession(): string | null {
    return this.focusedSessionId;
  }

  private isSessionActive(sessionId: string): boolean {
    if (this.isSessionActiveCallback) {
      return this.isSessionActiveCallback(sessionId);
    }
    // Default: only the focused session is active (backward compatible)
    return sessionId === this.focusedSessionId;
  }

  private getBucket(sessionId: string): SessionBucket {
    let bucket = this.sessionBuckets.get(sessionId);
    if (!bucket) {
      bucket = {
        currentMessageParts: new Map(),
        pendingParts: new Map(),
        messages: new Map(),
        messageCount: 0,
        processedToolStates: new Set(),
        thinkingFiredForMessages: new Set(),
        partHashes: new Map(),
        lastActivity: Date.now(),
      };
      this.sessionBuckets.set(sessionId, bucket);
    }
    bucket.lastActivity = Date.now();
    return bucket;
  }

  private startTypingIndicator(): void {
    if (this.typingTimer) {
      return;
    }

    const sendTyping = () => {
      if (this.typingIndicatorCallback) {
        this.typingIndicatorCallback().catch((err: unknown) => {
          logger.error("Failed to send typing action:", err);
        });
      }
    };

    sendTyping();
    this.typingTimer = setInterval(sendTyping, 4000);
  }

  stopTypingIndicator(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  processEvent(event: Event): void {
    const eventType = (event as { type: string }).type;
    if (eventType === "message.part.delta") {
      this.handleMessagePartDelta(event as unknown as MessagePartDeltaEvent);
      return;
    }

    // Log all question-related events for debugging
    if (event.type.startsWith("question.")) {
      logger.info(
        `[Aggregator] Question event: ${event.type}`,
        JSON.stringify(event.properties, null, 2),
      );
    }

    // Log all session-related events for debugging
    if (event.type.startsWith("session.")) {
      logger.debug(
        `[Aggregator] Session event: ${event.type}`,
        JSON.stringify(event.properties, null, 2),
      );
    }

    switch (event.type) {
      case "message.updated":
        this.handleMessageUpdated(event);
        break;
      case "message.part.updated":
        this.handleMessagePartUpdated(event);
        break;
      case "session.status":
        this.handleSessionStatus(event);
        break;
      case "session.idle":
        this.handleSessionIdle(event);
        break;
      case "session.compacted":
        this.handleSessionCompacted(event);
        break;
      case "session.error":
        this.handleSessionError(event);
        break;
      case "question.asked":
        this.handleQuestionAsked(event);
        break;
      case "question.replied":
        logger.info(`[Aggregator] Question replied: requestID=${event.properties.requestID}`);
        if (this.onQuestionExternalReplyCallback) {
          const cb = this.onQuestionExternalReplyCallback;
          const reqID = event.properties.requestID as string;
          setImmediate(() => cb(reqID));
        }
        break;
      case "question.rejected":
        logger.info(`[Aggregator] Question rejected: requestID=${event.properties.requestID}`);
        if (this.onQuestionExternalReplyCallback) {
          const cb = this.onQuestionExternalReplyCallback;
          const reqID = event.properties.requestID as string;
          setImmediate(() => cb(reqID));
        }
        break;
      case "session.diff":
        this.handleSessionDiff(event);
        break;
      case "permission.asked":
        this.handlePermissionAsked(event);
        break;
      case "permission.replied":
        logger.info(`[Aggregator] Permission replied: requestID=${event.properties.requestID}`);
        if (this.onPermissionExternalReplyCallback) {
          const cb = this.onPermissionExternalReplyCallback;
          const reqID = event.properties.requestID as string;
          setImmediate(() => cb(reqID));
        }
        break;
      default:
        logger.debug(`[Aggregator] Unhandled event type: ${event.type}`);
        break;
    }
  }

  setSession(sessionId: string): void {
    this.focusedSessionId = sessionId;
  }

  /**
   * Pre-creates a bucket for a session so it's ready to receive events.
   * Does NOT clear other sessions' buckets.
   */
  activateSession(sessionId: string): void {
    this.getBucket(sessionId);
  }

  clear(): void {
    this.stopTypingIndicator();
    this.focusedSessionId = null;
    this.sessionBuckets.clear();
    this.lastUpdated = 0;

    // Reset the deduplication tracker so the next session starts fresh.
    clearProcessedMessages();

    if (this.onClearedCallback) {
      try {
        this.onClearedCallback();
      } catch (err) {
        logger.error("[Aggregator] Error in clear callback:", err);
      }
    }
  }

  private handleMessageUpdated(
    event: Event & {
      type: "message.updated";
    },
  ): void {
    const { info } = event.properties;

    logger.debug(
      `[Aggregator] message.updated: role=${info.role}, sessionID=${info.sessionID}, currentSession=${this.focusedSessionId}`,
    );

    if (!this.isSessionActive(info.sessionID)) {
      logger.debug(
        `[Aggregator] Skipping message.updated — session not active (event=${info.sessionID}, focused=${this.focusedSessionId})`,
      );
      return;
    }

    const messageID = info.id;
    const bucket = this.getBucket(info.sessionID);

    bucket.messages.set(messageID, { role: info.role });

    if (info.role === "assistant") {
      if (!bucket.currentMessageParts.has(messageID)) {
        bucket.currentMessageParts.set(messageID, []);
        bucket.messageCount++;
        this.startTypingIndicator();
      }

      const pending = bucket.pendingParts.get(messageID) || [];
      const current = bucket.currentMessageParts.get(messageID) || [];
      bucket.currentMessageParts.set(messageID, [...current, ...pending]);
      bucket.pendingParts.delete(messageID);

      const assistantMessage = info as { time?: { created: number; completed?: number } };
      const time = assistantMessage.time;

      if (time?.completed) {
        const parts = bucket.currentMessageParts.get(messageID) || [];
        const lastPart = parts[parts.length - 1] || "";

        logger.debug(
          `[Aggregator] Message part completed: messageId=${messageID}, textLength=${lastPart.length}, totalParts=${parts.length}, session=${this.focusedSessionId}`,
        );

        // Extract and report tokens BEFORE onComplete so keyboard context is updated
        const assistantInfo = info as {
          tokens?: {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          };
        };

        if (this.onTokensCallback && assistantInfo.tokens) {
          const tokens: TokensInfo = {
            input: assistantInfo.tokens.input,
            output: assistantInfo.tokens.output,
            reasoning: assistantInfo.tokens.reasoning,
            cacheRead: assistantInfo.tokens.cache?.read || 0,
            cacheWrite: assistantInfo.tokens.cache?.write || 0,
          };
          logger.debug(
            `[Aggregator] Tokens: input=${tokens.input}, output=${tokens.output}, reasoning=${tokens.reasoning}`,
          );
          // Call synchronously so keyboardManager is updated before onComplete sends the reply
          this.onTokensCallback(tokens);
        }

        if (this.onCompleteCallback && lastPart.length > 0) {
          // Mark as processed BEFORE the callback so the message poller skips it.
          markMessageProcessed(messageID);
          this.onCompleteCallback(info.sessionID, lastPart);
        }

        bucket.currentMessageParts.delete(messageID);
        bucket.messages.delete(messageID);
        bucket.partHashes.delete(messageID);

        logger.debug(
          `[Aggregator] Message completed cleanup: remaining messages=${bucket.currentMessageParts.size}`,
        );

        if (bucket.currentMessageParts.size === 0) {
          logger.debug("[Aggregator] No more active messages, stopping typing indicator");
          this.stopTypingIndicator();
        }
      }

      this.lastUpdated = Date.now();
    }
  }

  private handleMessagePartUpdated(
    event: Event & {
      type: "message.part.updated";
    },
  ): void {
    const { part } = event.properties;

    logger.debug(
      `[Aggregator] message.part.updated: type=${part.type}, sessionID=${part.sessionID}, currentSession=${this.focusedSessionId}`,
    );

    if (!this.isSessionActive(part.sessionID)) {
      return;
    }

    const messageID = part.messageID;
    const bucket = this.getBucket(part.sessionID);
    const messageInfo = bucket.messages.get(messageID);

    if (part.type === "reasoning") {
      // Fire the thinking callback once per message on the first reasoning part.
      // This is the signal that the model is actually doing extended thinking.
      if (!bucket.thinkingFiredForMessages.has(messageID) && this.onThinkingCallback) {
        bucket.thinkingFiredForMessages.add(messageID);
        const callback = this.onThinkingCallback;
        const sessionID = part.sessionID;
        setImmediate(() => {
          if (typeof callback === "function") {
            callback(sessionID);
          }
        });
      }
    } else if (part.type === "text" && "text" in part && part.text) {
      const partHash = this.hashString(part.text);

      if (!bucket.partHashes.has(messageID)) {
        bucket.partHashes.set(messageID, new Set());
      }

      const hashes = bucket.partHashes.get(messageID)!;

      if (hashes.has(partHash)) {
        return;
      }

      hashes.add(partHash);

      if (messageInfo && messageInfo.role === "assistant") {
        if (!bucket.currentMessageParts.has(messageID)) {
          bucket.currentMessageParts.set(messageID, []);
          this.startTypingIndicator();
        }

        const parts = bucket.currentMessageParts.get(messageID)!;
        parts.push(part.text);
      } else {
        if (!bucket.pendingParts.has(messageID)) {
          bucket.pendingParts.set(messageID, []);
        }

        const pending = bucket.pendingParts.get(messageID)!;
        pending.push(part.text);
      }
    } else if (part.type === "tool") {
      const state = part.state;
      const input = "input" in state ? (state.input as { [key: string]: unknown }) : undefined;
      const title = "title" in state ? state.title : undefined;

      logger.debug(
        `[Aggregator] Tool event: callID=${part.callID}, tool=${part.tool}, status=${"status" in state ? state.status : "unknown"}`,
      );

      if (part.tool === "question") {
        logger.debug(`[Aggregator] Question tool part update:`, JSON.stringify(part, null, 2));

        // If the question tool fails, clear the active poll
        // so the agent can recreate it with corrected data
        if ("status" in state && state.status === "error") {
          logger.info(
            `[Aggregator] Question tool failed with error, clearing active poll. callID=${part.callID}`,
          );
          if (this.onQuestionErrorCallback) {
            setImmediate(() => {
              this.onQuestionErrorCallback!();
            });
          }
          return;
        }

        // NOTE: Questions are now handled via "question.asked" event, not via tool part updates.
        // This ensures we have access to the requestID needed for question.reply().
      }

      if ("status" in state && state.status === "completed") {
        logger.debug(
          `[Aggregator] Tool completed: callID=${part.callID}, tool=${part.tool}`,
          JSON.stringify(state, null, 2),
        );

        const completedKey = `completed-${part.callID}`;
        const toolBucket = this.getBucket(part.sessionID);

        if (!toolBucket.processedToolStates.has(completedKey)) {
          toolBucket.processedToolStates.add(completedKey);

          const preparedFileContext = this.prepareToolFileContext(
            part.tool,
            input,
            title,
            state.metadata as { [key: string]: unknown } | undefined,
          );

          const toolData: ToolInfo = {
            sessionId: part.sessionID,
            messageId: messageID,
            callId: part.callID,
            tool: part.tool,
            state: part.state,
            input,
            title,
            metadata: state.metadata as { [key: string]: unknown },
            hasFileAttachment: !!preparedFileContext.fileData,
          };

          logger.debug(
            `[Aggregator] Sending tool notification to Telegram: tool=${part.tool}, title=${title || "N/A"}`,
          );

          if (this.onToolCallback) {
            this.onToolCallback(toolData);
          }

          if (preparedFileContext.fileData && this.onToolFileCallback) {
            logger.debug(
              `[Aggregator] Sending ${part.tool} file: ${preparedFileContext.fileData.filename} (${preparedFileContext.fileData.buffer.length} bytes)`,
            );
            this.onToolFileCallback({
              ...toolData,
              hasFileAttachment: true,
              fileData: preparedFileContext.fileData,
            });
          }

          if (preparedFileContext.fileChange && this.onFileChangeCallback) {
            this.onFileChangeCallback(preparedFileContext.fileChange);
          }
        }
      }
    }

    this.lastUpdated = Date.now();
  }

  private handleMessagePartDelta(event: MessagePartDeltaEvent): void {
    const { sessionID, messageID, field, delta } = event.properties;

    if (!this.isSessionActive(sessionID)) {
      return;
    }

    if (field !== "text" || !delta) {
      return;
    }

    const deltaBucket = this.getBucket(sessionID);
    const messageInfo = deltaBucket.messages.get(messageID);
    if (messageInfo && messageInfo.role === "assistant") {
      if (!deltaBucket.currentMessageParts.has(messageID)) {
        deltaBucket.currentMessageParts.set(messageID, []);
        this.startTypingIndicator();
      }

      const parts = deltaBucket.currentMessageParts.get(messageID)!;
      if (parts.length === 0) {
        parts.push(delta);
      } else {
        const lastPartIndex = parts.length - 1;
        parts[lastPartIndex] = `${parts[lastPartIndex]}${delta}`;
      }
    } else {
      if (!deltaBucket.pendingParts.has(messageID)) {
        deltaBucket.pendingParts.set(messageID, []);
      }

      const pending = deltaBucket.pendingParts.get(messageID)!;
      if (pending.length === 0) {
        pending.push(delta);
      } else {
        const lastPartIndex = pending.length - 1;
        pending[lastPartIndex] = `${pending[lastPartIndex]}${delta}`;
      }
    }

    this.lastUpdated = Date.now();
  }

  private prepareToolFileContext(
    tool: string,
    input: { [key: string]: unknown } | undefined,
    title: string | undefined,
    metadata: { [key: string]: unknown } | undefined,
  ): PreparedToolFileContext {
    if (tool === "write" && input) {
      const filePath =
        typeof input.filePath === "string" ? normalizePathForDisplay(input.filePath) : "";
      const hasContent = typeof input.content === "string";
      const content = hasContent ? (input.content as string) : "";

      if (!filePath || !hasContent) {
        return { fileData: null, fileChange: null };
      }

      return {
        fileData: prepareCodeFile(content, filePath, "write"),
        fileChange: {
          file: filePath,
          additions: content.split("\n").length,
          deletions: 0,
        },
      };
    }

    if (tool === "edit" && metadata) {
      const editMetadata = metadata as {
        diff?: unknown;
        filediff?: { file?: string; additions?: number; deletions?: number };
      };
      const filePath = editMetadata.filediff?.file
        ? normalizePathForDisplay(editMetadata.filediff.file)
        : "";
      const diffText = typeof editMetadata.diff === "string" ? editMetadata.diff : "";

      if (!filePath || !diffText) {
        return { fileData: null, fileChange: null };
      }

      return {
        fileData: prepareCodeFile(diffText, filePath, "edit"),
        fileChange: {
          file: filePath,
          additions: editMetadata.filediff?.additions || 0,
          deletions: editMetadata.filediff?.deletions || 0,
        },
      };
    }

    if (tool === "apply_patch") {
      const patchMetadata = metadata as
        | {
            filediff?: { file?: string; additions?: number; deletions?: number };
            diff?: string;
          }
        | undefined;

      const filePathFromInput =
        input && typeof input.filePath === "string"
          ? normalizePathForDisplay(input.filePath)
          : input && typeof input.path === "string"
            ? normalizePathForDisplay(input.path)
            : "";
      const filePathFromTitle = title ? extractFirstUpdatedFileFromTitle(title) : "";

      const filePath =
        (patchMetadata?.filediff?.file && normalizePathForDisplay(patchMetadata.filediff.file)) ||
        filePathFromInput ||
        normalizePathForDisplay(filePathFromTitle);
      const diffText =
        typeof patchMetadata?.diff === "string"
          ? patchMetadata.diff
          : input && typeof input.patchText === "string"
            ? input.patchText
            : "";

      if (!filePath) {
        return { fileData: null, fileChange: null };
      }

      const fileChange = patchMetadata?.filediff
        ? {
            file: filePath,
            additions: patchMetadata.filediff.additions || 0,
            deletions: patchMetadata.filediff.deletions || 0,
          }
        : diffText
          ? (() => {
              const changes = countDiffChangesFromText(diffText);
              return {
                file: filePath,
                additions: changes.additions,
                deletions: changes.deletions,
              };
            })()
          : null;

      return {
        fileData: diffText ? prepareCodeFile(diffText, filePath, "edit") : null,
        fileChange,
      };
    }

    return { fileData: null, fileChange: null };
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  private handleSessionStatus(
    event: Event & {
      type: "session.status";
    },
  ): void {
    const { sessionID, status } = event.properties as {
      sessionID: string;
      status?: {
        type?: string;
        attempt?: number;
        message?: string;
        next?: number;
      };
    };

    if (!this.isSessionActive(sessionID)) {
      return;
    }

    if (status?.type !== "retry" || !this.onSessionRetryCallback) {
      return;
    }

    const callback = this.onSessionRetryCallback;
    const message = status.message?.trim() || "Unknown retry error";

    logger.warn(
      `[Aggregator] Session retry: session=${sessionID}, attempt=${status.attempt ?? "n/a"}, message=${message}`,
    );

    setImmediate(() => {
      callback({
        sessionId: sessionID,
        attempt: status.attempt,
        message,
        next: status.next,
      });
    });
  }

  private handleSessionIdle(
    event: Event & {
      type: "session.idle";
    },
  ): void {
    const { sessionID } = event.properties;

    if (!this.isSessionActive(sessionID)) {
      return;
    }

    logger.info(`[Aggregator] Session became idle: ${sessionID}`);

    // Stop typing indicator when session goes idle
    this.stopTypingIndicator();

    // Notify listeners that the session is idle (agent truly finished)
    if (this.onSessionIdleCallback) {
      const cb = this.onSessionIdleCallback;
      setImmediate(() => cb(sessionID));
    }
  }

  private handleSessionCompacted(
    event: Event & {
      type: "session.compacted";
    },
  ): void {
    const properties = event.properties as { sessionID: string };
    const { sessionID } = properties;

    if (!this.isSessionActive(sessionID)) {
      return;
    }

    logger.info(`[Aggregator] Session compacted: ${sessionID}`);

    // Reload context from history after compaction
    if (this.onSessionCompactedCallback) {
      setImmediate(() => {
        const project = getCurrentProject();
        if (project) {
          this.onSessionCompactedCallback!(sessionID, project.worktree);
        }
      });
    }
  }

  private handleSessionError(
    event: Event & {
      type: "session.error";
    },
  ): void {
    const { sessionID, error } = event.properties as {
      sessionID: string;
      error?: {
        name?: string;
        message?: string;
        data?: { message?: string };
      };
    };

    if (!this.isSessionActive(sessionID)) {
      return;
    }

    const message =
      error?.data?.message || error?.message || error?.name || "Unknown session error";

    logger.warn(`[Aggregator] Session error: ${sessionID}: ${message}`);
    this.stopTypingIndicator();

    if (this.onSessionErrorCallback) {
      const callback = this.onSessionErrorCallback;
      setImmediate(() => {
        callback(sessionID, message);
      });
    }
  }

  private handleQuestionAsked(
    event: Event & {
      type: "question.asked";
    },
  ): void {
    const { id, sessionID, questions } = event.properties;

    if (!this.isSessionActive(sessionID)) {
      logger.info(
        `[Aggregator] Question from non-active session: ${sessionID} (focused: ${this.focusedSessionId}), showing anyway for cross-client sync`,
      );
    }

    logger.info(`[Aggregator] Question asked: requestID=${id}, questions=${questions.length}`);

    if (this.onQuestionCallback) {
      const callback = this.onQuestionCallback;
      setImmediate(async () => {
        try {
          await callback(questions as Question[], id, sessionID);
        } catch (err) {
          logger.error("[Aggregator] Error in question callback:", err);
        }
      });
    }
  }

  private handleSessionDiff(event: Event): void {
    const properties = event.properties as {
      sessionID: string;
      diff: Array<{ file: string; additions: number; deletions: number }>;
    };

    if (!this.isSessionActive(properties.sessionID)) {
      return;
    }

    logger.debug(`[Aggregator] Session diff: ${properties.diff.length} files changed`);

    if (this.onSessionDiffCallback) {
      const diffs: FileChange[] = properties.diff.map((d) => ({
        file: d.file,
        additions: d.additions,
        deletions: d.deletions,
      }));

      const callback = this.onSessionDiffCallback;
      setImmediate(() => {
        callback(properties.sessionID, diffs);
      });
    }
  }

  private handlePermissionAsked(
    event: Event & {
      type: "permission.asked";
    },
  ): void {
    const request = event.properties;

    if (!this.isSessionActive(request.sessionID)) {
      logger.info(
        `[Aggregator] Permission from non-active session: ${request.sessionID} (focused: ${this.focusedSessionId}), showing anyway for cross-client sync`,
      );
    }

    logger.info(
      `[Aggregator] Permission asked: requestID=${request.id}, type=${request.permission}, patterns=${request.patterns.length}`,
    );

    if (this.onPermissionCallback) {
      const callback = this.onPermissionCallback;
      setImmediate(async () => {
        try {
          await callback(request as PermissionRequest);
        } catch (err) {
          logger.error("[Aggregator] Error in permission callback:", err);
        }
      });
    }
  }
}

export const summaryAggregator = new SummaryAggregator();
