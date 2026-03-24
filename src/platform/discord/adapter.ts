import {
  ChannelType,
  type DMChannel,
  type EmbedBuilder,
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

  /**
   * Send a message with an embed (Discord-specific).
   */
  async sendEmbed(embed: EmbedBuilder): Promise<PlatformMessageRef> {
    const channel = await this.getTextChannel();
    const msg = await channel.send({ embeds: [embed] });
    return msg.id;
  }

  /**
   * Edit a message to update its embed (Discord-specific).
   */
  async editEmbed(messageRef: PlatformMessageRef, embed: EmbedBuilder): Promise<void> {
    const channel = await this.getTextChannel();
    const message = await channel.messages.fetch(messageRef);
    await message.edit({ embeds: [embed] });
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

  async pinMessage(messageRef: PlatformMessageRef): Promise<void> {
    const channel = await this.getTextChannel();
    const message = await channel.messages.fetch(messageRef);
    await message.pin();
  }

  async unpinAllMessages(): Promise<void> {
    const channel = await this.getTextChannel();
    const pinned = await channel.messages.fetchPinned();
    await Promise.all(pinned.map((msg) => msg.unpin()));
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
}
