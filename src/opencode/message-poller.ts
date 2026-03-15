/**
 * Polls `session.messages()` to detect assistant replies produced outside
 * the Telegram bot (e.g. from the OpenCode GUI or TUI).
 *
 * The SSE event stream may not always deliver `message.part.updated` /
 * `message.updated` events for sessions driven by external clients.
 * This module fills that gap by periodically fetching the message list
 * and forwarding any completed assistant messages that the SSE-based
 * `SummaryAggregator` has not already handled.
 *
 * Deduplication is achieved through `processed-messages.ts`: the aggregator
 * marks every message it delivers via SSE, and the poller skips those IDs.
 */

import { opencodeClient } from "./client.js";
import { isMessageProcessed, markMessageProcessed } from "./processed-messages.js";
import { logger } from "../utils/logger.js";

const DEFAULT_POLL_INTERVAL_MS = 3_000;

type NewAssistantMessageCallback = (sessionId: string, messageText: string) => void;

interface PollerState {
  sessionId: string;
  directory: string;
  timer: ReturnType<typeof setInterval> | null;
  /** IDs already seen (both user and assistant) during the current polling session. */
  knownMessageIds: Set<string>;
  callback: NewAssistantMessageCallback;
  /** Whether the initial snapshot has been successfully loaded. */
  snapshotLoaded: boolean;
}

let state: PollerState | null = null;

/**
 * Perform the initial snapshot: fetch all existing messages and record their
 * IDs so the poller only reacts to *new* messages from this point onward.
 */
async function loadInitialSnapshot(): Promise<void> {
  if (!state) return;

  try {
    const { data: messages, error } = await opencodeClient.session.messages({
      sessionID: state.sessionId,
      directory: state.directory,
    });

    if (error || !messages) {
      logger.warn("[MessagePoller] Failed to load initial message snapshot:", error);
      return;
    }

    for (const msg of messages) {
      state.knownMessageIds.add(msg.info.id);
    }

    state.snapshotLoaded = true;

    logger.info(
      `[MessagePoller] Initial snapshot loaded: ${state.knownMessageIds.size} existing messages`,
    );
  } catch (err) {
    logger.warn("[MessagePoller] Failed to load initial message snapshot:", err);
  }
}

/**
 * One poll cycle: fetch messages, detect new completed assistant replies,
 * and fire the callback for each.
 */
async function poll(): Promise<void> {
  if (!state) return;

  // If the initial snapshot hasn't loaded yet (server was down at startup),
  // retry it instead of polling for new messages.  This prevents flooding
  // the user with historical messages when the server eventually comes up.
  if (!state.snapshotLoaded) {
    await loadInitialSnapshot();
    return;
  }

  try {
    const { data: messages, error } = await opencodeClient.session.messages({
      sessionID: state.sessionId,
      directory: state.directory,
    });

    if (error || !messages) {
      // Transient errors are expected (e.g. server restart); just skip this cycle.
      return;
    }

    for (const msg of messages) {
      const msgId = msg.info.id;

      // Already seen by the poller itself.
      if (state.knownMessageIds.has(msgId)) continue;

      // Mark as seen immediately to prevent re-processing on the next cycle.
      state.knownMessageIds.add(msgId);

      // Already forwarded by the SSE aggregator.
      if (isMessageProcessed(msgId)) continue;

      // Only forward completed assistant messages.
      if (msg.info.role !== "assistant") continue;

      const assistantInfo = msg.info as {
        time: { created: number; completed?: number };
      };

      if (!assistantInfo.time.completed) {
        // Still in progress — remove from known so we re-check next cycle.
        state.knownMessageIds.delete(msgId);
        continue;
      }

      // Extract text from parts.
      const textParts: string[] = [];
      for (const part of msg.parts) {
        if (part.type === "text" && "text" in part) {
          const text = (part as { text: string }).text;
          if (text) textParts.push(text);
        }
      }

      const fullText = textParts.join("\n\n");

      if (fullText.length === 0) continue;

      logger.info(
        `[MessagePoller] Detected new assistant reply via polling: msgId=${msgId}, len=${fullText.length}`,
      );

      // Mark globally so the aggregator doesn't duplicate.
      markMessageProcessed(msgId);

      try {
        state.callback(state.sessionId, fullText);
      } catch (err) {
        logger.error("[MessagePoller] Error in callback:", err);
      }
    }
  } catch (err) {
    // Don't crash on transient network errors.
    logger.debug("[MessagePoller] Poll error (will retry next cycle):", err);
  }
}

/**
 * Start polling for a specific session.
 *
 * If the poller is already running for a different session it will be stopped
 * first.  Calling this for the same session that is already being polled is
 * a no-op (callback is updated in place).
 */
export async function startMessagePolling(
  sessionId: string,
  directory: string,
  callback: NewAssistantMessageCallback,
): Promise<void> {
  // Same session — just update the callback.
  if (state && state.sessionId === sessionId && state.directory === directory) {
    state.callback = callback;
    return;
  }

  stopMessagePolling();

  state = {
    sessionId,
    directory,
    timer: null,
    knownMessageIds: new Set(),
    callback,
    snapshotLoaded: false,
  };

  await loadInitialSnapshot();

  state.timer = setInterval(poll, DEFAULT_POLL_INTERVAL_MS);

  logger.info(
    `[MessagePoller] Started polling session ${sessionId} every ${DEFAULT_POLL_INTERVAL_MS}ms`,
  );
}

/** Stop the poller. Safe to call even if it is not running. */
export function stopMessagePolling(): void {
  if (!state) return;

  if (state.timer) {
    clearInterval(state.timer);
  }

  logger.info(`[MessagePoller] Stopped polling session ${state.sessionId}`);

  state = null;
}

/** Returns `true` when the poller has an active timer. */
export function isPolling(): boolean {
  return state !== null && state.timer !== null;
}
