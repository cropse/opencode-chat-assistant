import {
  ChannelType,
  type DMChannel,
  // type EmbedBuilder, // Used for future embed features
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { logger } from "../../utils/logger.js";
import type {
  PlatformAdapter,
  PlatformCallbackQueryOptions,
  PlatformDocumentOptions,
  PlatformInfo,
  PlatformMessageOptions,
  PlatformMessageRef,
} from "../types.js";

export const DISCORD_PLATFORM_INFO: PlatformInfo = {
  platform: "discord",
  messageMaxLength: 2000,
  documentCaptionMaxLength: 2000,
};

/**
 * DiscordAdapter implements PlatformAdapter using discord.js.
 * Chat-bound: setChatId() must be called before any send/edit/delete operations.
 */
export class DiscordAdapter implements PlatformAdapter {
  readonly info: PlatformInfo = DISCORD_PLATFORM_INFO;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: {
    channels: { cache: { get(key: string): unknown }; fetch(key: string): Promise<unknown> };
  };
  private channelId: string = "";
  private threadChannelId: string | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(client: {
    channels: { cache: { get(key: string): unknown }; fetch(key: string): Promise<unknown> };
  }) {
    this.client = client;
  }

  setChatId(chatId: string): void {
    this.channelId = chatId;
    logger.debug(`[DiscordAdapter] Channel bound to ${this.channelId}`);
  }

  setThreadId(threadId: string): void {
    this.threadChannelId = threadId;
    logger.debug(`[DiscordAdapter] Thread bound to ${this.threadChannelId}`);
  }

  clearThreadId(): void {
    this.threadChannelId = null;
    logger.debug("[DiscordAdapter] Thread cleared");
  }

  getThreadId(): string | null {
    return this.threadChannelId;
  }

  /**
   * Returns true if the adapter has a valid channel to send messages to.
   */
  isReady(): boolean {
    return this.channelId !== "";
  }

  /**
   * Create a public thread from a slash command reply message and bind it to this adapter.
   * Call this after interaction.editReply() so the reply message exists.
   * All subsequent sendMessage calls will go into the thread.
   *
   * @param interaction - The slash command interaction whose reply to thread-ify
   * @param name - Thread name (truncated to 100 chars)
   */
  async createThreadFromInteraction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interaction: any,
    name: string,
  ): Promise<string | null> {
    const threadName = name.substring(0, 100);

    // First clear any existing thread so we don't reuse the old one
    this.clearThreadId();

    // Strategy 1: thread from the interaction reply (works for /new deferReply)
    try {
      const reply = await interaction.fetchReply();
      if (reply && typeof reply.startThread === "function" && !reply.flags?.has(64)) {
        const thread = await reply.startThread({ name: threadName, autoArchiveDuration: 60 });
        this.setThreadId(thread.id);
        logger.info(`[DiscordAdapter] Created thread ${thread.id} from interaction reply`);
        return thread.id;
      }
    } catch {
      // Fall through to strategy 2
    }

    // Strategy 2: send a plain message to the channel and thread that
    // (needed for ephemeral replies and select-menu deferUpdate interactions)
    try {
      const channel =
        interaction.channel ?? (await interaction.client?.channels?.fetch(interaction.channelId));
      if (channel && typeof channel.send === "function") {
        const anchor = await channel.send({ content: `🧵 **${threadName}**` });
        const thread = await anchor.startThread({ name: threadName, autoArchiveDuration: 60 });
        this.setThreadId(thread.id);
        logger.info(`[DiscordAdapter] Created thread ${thread.id} from channel anchor message`);
        return thread.id;
      }
    } catch (err) {
      logger.warn("[DiscordAdapter] Failed to create thread from channel anchor:", err);
    }

    logger.warn("[DiscordAdapter] Could not create thread — replies will go to main channel");
    return null;
  }

  /**
   * Rename a Discord thread by its ID.
   *
   * @param threadId - Thread ID
   * @param name - New thread name (truncated to 100 chars)
   * @returns true on success, false on failure or if thread not renameable
   */
  async renameThread(threadId: string, name: string): Promise<boolean> {
    const threadName = name.substring(0, 100);

    try {
      // Try cache first, then fetch if not found
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let channel: any = this.client.channels.cache.get(threadId);
      if (!channel) {
        channel = await this.client.channels.fetch(threadId);
      }

      if (!channel) {
        logger.warn(`[DiscordAdapter] Thread ${threadId} not found`);
        return false;
      }

      // Duck-type check for setName method
      if (typeof (channel as { setName?: unknown }).setName === "function") {
        await (channel as { setName(n: string): Promise<unknown> }).setName(threadName);
        logger.info(`[DiscordAdapter] Renamed thread ${threadId} to "${threadName}"`);
        return true;
      }

      logger.warn(`[DiscordAdapter] Thread ${threadId} does not have setName method`);
      return false;
    } catch (err) {
      const errorStr = String(err);
      if (errorStr.includes("rate limit") || errorStr.includes("429")) {
        logger.warn("[DiscordAdapter] Thread rename rate-limited");
      } else {
        logger.warn("[DiscordAdapter] Failed to rename thread:", err);
      }
      return false;
    }
  }

  private async getTextChannel(): Promise<TextChannel | DMChannel | ThreadChannel> {
    const targetId = this.threadChannelId ?? this.channelId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let channel: any = this.client.channels.cache.get(targetId);
    if (!channel) {
      channel = (await this.client.channels.fetch(targetId)) ?? undefined;
    }
    if (!channel) throw new Error(`Channel ${targetId} not found`);
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.DM &&
      channel.type !== ChannelType.GuildAnnouncement &&
      channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread
    ) {
      throw new Error(`Channel ${targetId} is not a text channel`);
    }
    return channel as TextChannel | DMChannel | ThreadChannel;
  }

  async sendMessage(text: string, options?: PlatformMessageOptions): Promise<PlatformMessageRef> {
    const channel = await this.getTextChannel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendOptions: any = { content: text };

    // Support ActionRow components via replyMarkup for Discord buttons/select menus
    if (options?.replyMarkup) {
      sendOptions.components = options.replyMarkup as unknown[];
    }

    const msg = await channel.send(sendOptions);
    return msg.id;
  }

  async sendDocument(
    file: unknown,
    options?: PlatformDocumentOptions,
  ): Promise<PlatformMessageRef> {
    const channel = await this.getTextChannel();
    const attachment = { attachment: file as Buffer | string, name: "file" };
    const msg = await channel.send({
      content: options?.caption,
      files: [attachment],
    });
    return msg.id;
  }

  async sendPhoto(photo: unknown, options?: PlatformDocumentOptions): Promise<PlatformMessageRef> {
    return this.sendDocument(photo, options);
  }

  async editMessage(
    messageRef: PlatformMessageRef,
    text: string,
    _options?: PlatformMessageOptions,
  ): Promise<void> {
    const channel = await this.getTextChannel();
    const message = await channel.messages.fetch(messageRef);
    await message.edit(text);
  }

  async deleteMessage(messageRef: PlatformMessageRef): Promise<void> {
    const channel = await this.getTextChannel();
    const message = await channel.messages.fetch(messageRef);
    await message.delete();
  }

  async answerCallbackQuery(
    _callbackId: string,
    _options?: PlatformCallbackQueryOptions,
  ): Promise<void> {
    // Discord interactions are handled differently (via deferUpdate/reply in handlers)
    logger.debug(
      `[DiscordAdapter] answerCallbackQuery called — no-op (Discord uses different interaction model)`,
    );
  }

  async sendTyping(): Promise<void> {
    const channel = await this.getTextChannel();
    await channel.sendTyping();
  }

  async setCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    // Discord slash commands are registered separately on guild ready event
    logger.debug(
      `[DiscordAdapter] setCommands called — no-op (slash commands registered on ready): ${commands.length} commands`,
    );
  }

  async getFileUrl(fileId: string): Promise<string> {
    // Discord attachment URLs are passed directly as fileId
    return fileId;
  }

  async addReaction(messageRef: PlatformMessageRef, emoji: string): Promise<void> {
    try {
      const channel = await this.getTextChannel();
      const message = await channel.messages.fetch(messageRef);
      await message.react(emoji);
    } catch (err) {
      logger.debug(`[DiscordAdapter] Failed to add reaction: ${err}`);
    }
  }

  async removeReaction(messageRef: PlatformMessageRef, emoji: string): Promise<void> {
    try {
      const channel = await this.getTextChannel();
      const message = await channel.messages.fetch(messageRef);
      // Remove the bot's own reaction
      const botReaction = message.reactions.cache.get(emoji);
      if (botReaction) {
        await botReaction.users.remove();
      }
    } catch (err) {
      logger.debug(`[DiscordAdapter] Failed to remove reaction: ${err}`);
    }
  }
}
