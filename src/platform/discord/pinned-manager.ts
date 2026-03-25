import { logger } from "../../utils/logger.js";
import {
  getPinnedMessageId,
  setPinnedMessageId,
  clearPinnedMessageId,
} from "../../settings/manager.js";
import { createStatusEmbed, type DiscordStatusData } from "./formatter.js";
import type { FileChange } from "../types.js";
import type { DiscordAdapter } from "./adapter.js";
import { opencodeClient } from "../../opencode/client.js";
import type { AssistantMessage } from "@opencode-ai/sdk/v2";

interface DiscordPinnedState {
  messageRef: string | null;
  sessionTitle: string;
  projectName: string;
  modelName: string;
  agentName: string;
  tokensUsed: number;
  tokensLimit: number;
  changedFiles: FileChange[];
  status: "idle" | "busy" | "error";
}

/**
 * DiscordPinnedMessageManager tracks a pinned status embed showing session,
 * project, model, agent, tokens, and changed files. Updates are debounced
 * with a 2-second minimum interval to avoid Discord rate limits.
 */
export class DiscordPinnedMessageManager {
  private adapter: DiscordAdapter | null = null;
  private state: DiscordPinnedState = {
    messageRef: null,
    sessionTitle: "No active session",
    projectName: "",
    modelName: "",
    agentName: "",
    tokensUsed: 0,
    tokensLimit: 0,
    changedFiles: [],
    status: "idle",
  };
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateTime = 0;
  private readonly MIN_UPDATE_INTERVAL = 2000; // 2 seconds

  /**
   * Initialize manager with DiscordAdapter and restore pinned message ID from settings.
   */
  initialize(adapter: DiscordAdapter): void {
    this.adapter = adapter;

    // Restore pinned message ID from settings
    const savedMessageRef = getPinnedMessageId();
    if (savedMessageRef) {
      this.state.messageRef = savedMessageRef;
    }

    logger.debug("[DiscordPinnedManager] Initialized");
  }

  /**
   * Called when session changes — creates new pinned embed.
   */
  async onSessionChanged(
    _sessionId: string,
    sessionTitle: string,
    projectName: string,
  ): Promise<void> {
    logger.info(`[DiscordPinnedManager] Session changed: ${sessionTitle}, project: ${projectName}`);

    // Reset state for new session
    this.state.tokensUsed = 0;
    this.state.sessionTitle = sessionTitle || "No active session";
    this.state.projectName = projectName || "";
    this.state.changedFiles = [];
    this.state.status = "idle";

    // Unpin old message and create new one
    await this.unpinOldMessage();
    await this.createPinnedEmbed();
  }

  /**
   * Called when tokens update (from SSE aggregator callbacks).
   */
  async onTokensUpdated(tokensUsed: number, tokensLimit: number): Promise<void> {
    this.state.tokensUsed = tokensUsed;
    if (tokensLimit > 0) {
      this.state.tokensLimit = tokensLimit;
    }
    logger.debug(`[DiscordPinnedManager] Tokens updated: ${tokensUsed}/${this.state.tokensLimit}`);
    await this.scheduleUpdate();
  }

  /**
   * Called when files change (from SSE aggregator callbacks).
   */
  async onFilesChanged(files: FileChange[]): Promise<void> {
    this.state.changedFiles = files;
    logger.debug(`[DiscordPinnedManager] Files changed: ${files.length} files`);
    await this.scheduleUpdate();
  }

  /**
   * Called when model changes.
   */
  async onModelChanged(modelName: string): Promise<void> {
    this.state.modelName = modelName || "";
    logger.debug(`[DiscordPinnedManager] Model changed: ${modelName}`);
    await this.scheduleUpdate();
  }

  /**
   * Called when agent changes.
   */
  async onAgentChanged(agentName: string): Promise<void> {
    this.state.agentName = agentName || "";
    logger.debug(`[DiscordPinnedManager] Agent changed: ${agentName}`);
    await this.scheduleUpdate();
  }

  /**
   * Called when session goes idle.
   */
  async onSessionIdle(): Promise<void> {
    this.state.status = "idle";
    logger.debug("[DiscordPinnedManager] Session idle");
    await this.scheduleUpdate();
  }

  /**
   * Called when session becomes busy (processing).
   */
  async onSessionBusy(): Promise<void> {
    this.state.status = "busy";
    await this.scheduleUpdate();
  }

  /**
   * Called when session has an error.
   */
  async onSessionError(): Promise<void> {
    this.state.status = "error";
    await this.scheduleUpdate();
  }

  /**
   * Called when session is compacted — reload context tokens from history.
   */
  async onSessionCompacted(sessionId: string, directory: string): Promise<void> {
    logger.info(`[DiscordPinnedManager] Session compacted, reloading context: ${sessionId}`);

    try {
      const { data: messages, error } = await opencodeClient.session.messages({
        sessionID: sessionId,
        directory,
      });

      if (error || !messages) {
        logger.warn(
          "[DiscordPinnedManager] Failed to load session history after compaction:",
          error,
        );
        return;
      }

      // Find the last non-summary assistant message for current context size
      let lastContextSize = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role === "assistant") {
          const info = msg.info as AssistantMessage;
          if (info.summary) continue;
          const input = info.tokens?.input ?? 0;
          const cacheRead = info.tokens?.cache?.read ?? 0;
          lastContextSize = input + cacheRead;
          break;
        }
      }

      this.state.tokensUsed = lastContextSize;
      logger.info(
        `[DiscordPinnedManager] Reloaded context after compaction: ${lastContextSize} tokens`,
      );

      await this.scheduleUpdate();
    } catch (err) {
      logger.error("[DiscordPinnedManager] Error reloading context after compaction:", err);
    }
  }

  /**
   * Schedule a debounced update with 2-second minimum interval.
   */
  private async scheduleUpdate(): Promise<void> {
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdateTime;

    if (timeSinceLastUpdate >= this.MIN_UPDATE_INTERVAL) {
      // Enough time has passed — update now
      await this.doUpdate();
      this.lastUpdateTime = now;
    } else {
      // Schedule for later
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(async () => {
        this.debounceTimer = null;
        await this.doUpdate();
        this.lastUpdateTime = Date.now();
      }, this.MIN_UPDATE_INTERVAL - timeSinceLastUpdate);
    }
  }

  /**
   * Execute the actual update (create or edit embed).
   */
  private async doUpdate(): Promise<void> {
    if (!this.adapter) {
      logger.warn("[DiscordPinnedManager] Adapter not initialized");
      return;
    }

    try {
      if (this.state.messageRef) {
        await this.updatePinnedEmbed();
      } else {
        await this.createPinnedEmbed();
      }
    } catch (err) {
      logger.error("[DiscordPinnedManager] Error updating pinned embed:", err);
    }
  }

  /**
   * Build status data from current state for createStatusEmbed.
   */
  private buildStatusData(): DiscordStatusData {
    return {
      sessionTitle: this.state.sessionTitle,
      projectName: this.state.projectName || undefined,
      modelName: this.state.modelName || undefined,
      agentName: this.state.agentName || undefined,
      tokensUsed: this.state.tokensUsed || undefined,
      tokensLimit: this.state.tokensLimit || undefined,
      changedFilesCount: this.state.changedFiles.length || undefined,
      changedFiles:
        this.state.changedFiles.length > 0 ? this.state.changedFiles.map((f) => f.file) : undefined,
      status: this.state.status,
    };
  }

  /**
   * Create and pin a new status embed.
   */
  private async createPinnedEmbed(): Promise<void> {
    if (!this.adapter) {
      logger.warn("[DiscordPinnedManager] Adapter not initialized");
      return;
    }

    try {
      const data = this.buildStatusData();
      const embed = createStatusEmbed(data);

      // Send embed as a message
      const messageRef = await this.adapter.sendEmbed(embed);

      this.state.messageRef = messageRef;
      this.lastUpdateTime = Date.now();

      // Save to settings for persistence
      setPinnedMessageId(messageRef);

      // Pin the message
      await this.adapter.pinMessage(messageRef);

      logger.info(`[DiscordPinnedManager] Created and pinned embed: ${messageRef}`);
    } catch (err) {
      logger.error("[DiscordPinnedManager] Error creating pinned embed:", err);
    }
  }

  /**
   * Update existing pinned embed.
   */
  private async updatePinnedEmbed(): Promise<void> {
    if (!this.adapter || !this.state.messageRef) {
      return;
    }

    try {
      const data = this.buildStatusData();
      const embed = createStatusEmbed(data);
      await this.adapter.editEmbed(this.state.messageRef, embed);
      this.lastUpdateTime = Date.now();

      logger.debug(`[DiscordPinnedManager] Updated pinned embed: ${this.state.messageRef}`);
    } catch (err: unknown) {
      // Handle "Unknown Message" (Discord API error 10008) or "message not found" — recreate
      const isMessageGone =
        (err instanceof Error && err.message.includes("Unknown Message")) ||
        (err instanceof Error && err.message.includes("message not found")) ||
        (typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: unknown }).code === 10008);

      if (isMessageGone) {
        logger.warn("[DiscordPinnedManager] Pinned message was deleted, recreating...");
        this.state.messageRef = null;
        clearPinnedMessageId();
        try {
          await this.createPinnedEmbed();
        } catch (recreateErr) {
          logger.warn("[DiscordPinnedManager] Failed to recreate pinned embed:", recreateErr);
        }
        return;
      }

      logger.error("[DiscordPinnedManager] Error updating pinned embed:", err);
    }
  }

  /**
   * Unpin old message before creating new one.
   */
  private async unpinOldMessage(): Promise<void> {
    if (!this.adapter) {
      return;
    }

    try {
      await this.adapter.unpinAllMessages().catch(() => {});

      this.state.messageRef = null;
      clearPinnedMessageId();

      logger.debug("[DiscordPinnedManager] Unpinned old messages");
    } catch (err) {
      logger.error("[DiscordPinnedManager] Error unpinning messages:", err);
    }
  }

  /**
   * Get current state (for debugging/status).
   */
  getState(): DiscordPinnedState {
    return { ...this.state };
  }

  /**
   * Check if manager is initialized.
   */
  isInitialized(): boolean {
    return this.adapter !== null;
  }

  /**
   * Clear pinned message (when switching projects).
   */
  async clear(): Promise<void> {
    if (!this.adapter) {
      // Just reset state if not initialized
      this.state.messageRef = null;
      this.state.tokensUsed = 0;
      this.state.tokensLimit = 0;
      this.state.changedFiles = [];
      this.state.status = "idle";
      clearPinnedMessageId();
      return;
    }

    try {
      // Unpin all messages
      await this.adapter.unpinAllMessages().catch(() => {});

      // Reset state
      this.state.messageRef = null;
      this.state.sessionTitle = "No active session";
      this.state.projectName = "";
      this.state.modelName = "";
      this.state.agentName = "";
      this.state.tokensUsed = 0;
      this.state.tokensLimit = 0;
      this.state.changedFiles = [];
      this.state.status = "idle";
      clearPinnedMessageId();

      logger.info("[DiscordPinnedManager] Cleared pinned embed state");
    } catch (err) {
      logger.error("[DiscordPinnedManager] Error clearing pinned embed:", err);
    }
  }
}

export const discordPinnedMessageManager = new DiscordPinnedMessageManager();
