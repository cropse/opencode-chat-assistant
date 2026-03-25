import type { Api, InputFile } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type {
  PlatformAdapter,
  PlatformCallbackQueryOptions,
  PlatformDocumentOptions,
  PlatformInfo,
  PlatformMessageOptions,
  PlatformMessageRef,
} from "../types.js";

const TELEGRAM_FILE_URL_BASE = "https://api.telegram.org/file/bot";

export const TELEGRAM_PLATFORM_INFO: PlatformInfo = {
  platform: "telegram",
  messageMaxLength: 4096,
  documentCaptionMaxLength: 1024,
};

/**
 * Convert Telegram numeric message ID to PlatformMessageRef (string)
 */
export function toMessageRef(id: number): PlatformMessageRef {
  return String(id);
}

/**
 * Convert PlatformMessageRef (string) back to Telegram numeric message ID
 */
export function fromMessageRef(ref: PlatformMessageRef): number {
  return parseInt(ref, 10);
}

/**
 * TelegramAdapter implements PlatformAdapter using grammY Api.
 * Chat-bound: setChatId() must be called before any send/edit/delete operations.
 */
export class TelegramAdapter implements PlatformAdapter {
  readonly info: PlatformInfo = TELEGRAM_PLATFORM_INFO;
  private api: Api;
  private chatId: number = 0;

  constructor(api: Api) {
    this.api = api;
  }

  setChatId(chatId: string): void {
    this.chatId = parseInt(chatId, 10);
    logger.debug(`[TelegramAdapter] Chat bound to ${this.chatId}`);
  }

  async sendMessage(text: string, options?: PlatformMessageOptions): Promise<PlatformMessageRef> {
    const result = await this.api.sendMessage(this.chatId, text, {
      parse_mode: options?.parseMode,
      reply_markup: options?.replyMarkup as never,
      reply_to_message_id: options?.replyToMessageRef
        ? fromMessageRef(options.replyToMessageRef)
        : undefined,
      link_preview_options: options?.disableWebPagePreview ? { is_disabled: true } : undefined,
    });
    return toMessageRef(result.message_id);
  }

  async sendDocument(
    file: unknown,
    options?: PlatformDocumentOptions,
  ): Promise<PlatformMessageRef> {
    const result = await this.api.sendDocument(this.chatId, file as InputFile, {
      caption: options?.caption,
      parse_mode: options?.parseMode,
    });
    return toMessageRef(result.message_id);
  }

  async sendPhoto(photo: unknown, options?: PlatformDocumentOptions): Promise<PlatformMessageRef> {
    const result = await this.api.sendPhoto(this.chatId, photo as InputFile, {
      caption: options?.caption,
      parse_mode: options?.parseMode,
    });
    return toMessageRef(result.message_id);
  }

  async editMessage(
    messageRef: PlatformMessageRef,
    text: string,
    options?: PlatformMessageOptions,
  ): Promise<void> {
    await this.api.editMessageText(this.chatId, fromMessageRef(messageRef), text, {
      parse_mode: options?.parseMode,
      reply_markup: options?.replyMarkup as never,
      link_preview_options: options?.disableWebPagePreview ? { is_disabled: true } : undefined,
    });
  }

  async deleteMessage(messageRef: PlatformMessageRef): Promise<void> {
    await this.api.deleteMessage(this.chatId, fromMessageRef(messageRef));
  }

  async answerCallbackQuery(
    callbackId: string,
    options?: PlatformCallbackQueryOptions,
  ): Promise<void> {
    await this.api.answerCallbackQuery(callbackId, {
      text: options?.text,
      show_alert: options?.showAlert,
    });
  }

  async sendTyping(): Promise<void> {
    await this.api.sendChatAction(this.chatId, "typing");
  }

  async setCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.api.setMyCommands(commands);
  }

  async getFileUrl(fileId: string): Promise<string> {
    const file = await this.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error(`File path not available for fileId: ${fileId}`);
    }

    return `${TELEGRAM_FILE_URL_BASE}${config.telegram.token}/${file.file_path}`;
  }

  async addReaction(messageRef: PlatformMessageRef, emoji: string): Promise<void> {
    try {
      await this.api.setMessageReaction(this.chatId, fromMessageRef(messageRef), [
        { type: "emoji", emoji: emoji as "👍" },
      ]);
    } catch (err) {
      logger.debug(`[TelegramAdapter] Failed to add reaction: ${err}`);
    }
  }

  async removeReaction(messageRef: PlatformMessageRef, _emoji: string): Promise<void> {
    try {
      await this.api.setMessageReaction(this.chatId, fromMessageRef(messageRef), []);
    } catch (err) {
      logger.debug(`[TelegramAdapter] Failed to remove reaction: ${err}`);
    }
  }
}
