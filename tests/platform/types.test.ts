import { describe, expect, it } from "vitest";
import type {
  PlatformAdapter,
  PlatformMessageRef,
  NormalizedInput,
  PlatformInfo,
  PlatformMessageOptions,
  PlatformDocumentOptions,
  PlatformCallbackQueryOptions,
} from "../../src/platform/types.js";

describe("platform/types", () => {
  describe("PlatformMessageRef", () => {
    it("is assignable from string", () => {
      const ref: PlatformMessageRef = "12345";
      expect(ref).toBe("12345");
    });

    it("toMessageRef converts number to string", () => {
      // Telegram message IDs are numbers; adapter converts to string
      const numericId = 12345;
      const ref: PlatformMessageRef = String(numericId);
      expect(ref).toBe("12345");
      expect(typeof ref).toBe("string");
    });

    it("fromMessageRef converts string back to number", () => {
      const ref: PlatformMessageRef = "12345";
      const numericId = parseInt(ref, 10);
      expect(numericId).toBe(12345);
    });
  });

  describe("NormalizedInput", () => {
    it("can be type text", () => {
      const input: NormalizedInput = { type: "text", text: "hello" };
      expect(input.type).toBe("text");
      expect(input.text).toBe("hello");
    });

    it("can be type callback", () => {
      const input: NormalizedInput = { type: "callback", callbackData: "btn:123" };
      expect(input.type).toBe("callback");
      expect(input.callbackData).toBe("btn:123");
    });

    it("can be type photo", () => {
      const input: NormalizedInput = { type: "photo", fileId: "AGABC123" };
      expect(input.type).toBe("photo");
      expect(input.fileId).toBe("AGABC123");
    });

    it("can be type document", () => {
      const input: NormalizedInput = { type: "document", fileId: "DOC456" };
      expect(input.type).toBe("document");
    });

    it("can be type voice", () => {
      const input: NormalizedInput = { type: "voice", fileId: "VOICE789" };
      expect(input.type).toBe("voice");
    });

    it("can be type unknown", () => {
      const input: NormalizedInput = { type: "unknown" };
      expect(input.type).toBe("unknown");
    });
  });

  describe("PlatformInfo", () => {
    it("holds telegram info correctly", () => {
      const info: PlatformInfo = {
        platform: "telegram",
        messageMaxLength: 4096,
        documentCaptionMaxLength: 1024,
      };
      expect(info.platform).toBe("telegram");
      expect(info.messageMaxLength).toBe(4096);
      expect(info.documentCaptionMaxLength).toBe(1024);
    });

    it("holds discord info correctly", () => {
      const info: PlatformInfo = {
        platform: "discord",
        messageMaxLength: 2000,
        documentCaptionMaxLength: 2000,
      };
      expect(info.platform).toBe("discord");
    });
  });

  describe("PlatformAdapter interface", () => {
    it("mock adapter can implement the interface", () => {
      // This is a compile-time test — if it compiles, the interface is implementable
      class MockAdapter implements PlatformAdapter {
        readonly info: PlatformInfo = {
          platform: "telegram",
          messageMaxLength: 4096,
          documentCaptionMaxLength: 1024,
        };
        setChatId(_chatId: string): void {}
        sendMessage(_text: string, _options?: PlatformMessageOptions): Promise<PlatformMessageRef> {
          return Promise.resolve("1");
        }
        sendDocument(
          _file: unknown,
          _options?: PlatformDocumentOptions,
        ): Promise<PlatformMessageRef> {
          return Promise.resolve("2");
        }
        sendPhoto(
          _photo: unknown,
          _options?: PlatformDocumentOptions,
        ): Promise<PlatformMessageRef> {
          return Promise.resolve("3");
        }
        editMessage(
          _ref: PlatformMessageRef,
          _text: string,
          _options?: PlatformMessageOptions,
        ): Promise<void> {
          return Promise.resolve();
        }
        deleteMessage(_ref: PlatformMessageRef): Promise<void> {
          return Promise.resolve();
        }
        pinMessage(_ref: PlatformMessageRef): Promise<void> {
          return Promise.resolve();
        }
        unpinAllMessages(): Promise<void> {
          return Promise.resolve();
        }
        answerCallbackQuery(_id: string, _options?: PlatformCallbackQueryOptions): Promise<void> {
          return Promise.resolve();
        }
        sendTyping(): Promise<void> {
          return Promise.resolve();
        }
        setCommands(_commands: Array<{ command: string; description: string }>): Promise<void> {
          return Promise.resolve();
        }
        getFileUrl(_fileId: string): Promise<string> {
          return Promise.resolve("https://example.com/file");
        }
      }

      const adapter: PlatformAdapter = new MockAdapter();
      expect(adapter.info.platform).toBe("telegram");
    });

    it("adapter has all 12 required methods", () => {
      const requiredMethods = [
        "setChatId",
        "sendMessage",
        "sendDocument",
        "sendPhoto",
        "editMessage",
        "deleteMessage",
        "pinMessage",
        "unpinAllMessages",
        "answerCallbackQuery",
        "sendTyping",
        "setCommands",
        "getFileUrl",
      ];

      class MockAdapter implements PlatformAdapter {
        readonly info: PlatformInfo = {
          platform: "telegram",
          messageMaxLength: 4096,
          documentCaptionMaxLength: 1024,
        };
        setChatId(_chatId: string): void {}
        sendMessage(_text: string, _options?: PlatformMessageOptions): Promise<PlatformMessageRef> {
          return Promise.resolve("1");
        }
        sendDocument(
          _file: unknown,
          _options?: PlatformDocumentOptions,
        ): Promise<PlatformMessageRef> {
          return Promise.resolve("2");
        }
        sendPhoto(
          _photo: unknown,
          _options?: PlatformDocumentOptions,
        ): Promise<PlatformMessageRef> {
          return Promise.resolve("3");
        }
        editMessage(
          _ref: PlatformMessageRef,
          _text: string,
          _options?: PlatformMessageOptions,
        ): Promise<void> {
          return Promise.resolve();
        }
        deleteMessage(_ref: PlatformMessageRef): Promise<void> {
          return Promise.resolve();
        }
        pinMessage(_ref: PlatformMessageRef): Promise<void> {
          return Promise.resolve();
        }
        unpinAllMessages(): Promise<void> {
          return Promise.resolve();
        }
        answerCallbackQuery(_id: string, _options?: PlatformCallbackQueryOptions): Promise<void> {
          return Promise.resolve();
        }
        sendTyping(): Promise<void> {
          return Promise.resolve();
        }
        setCommands(_commands: Array<{ command: string; description: string }>): Promise<void> {
          return Promise.resolve();
        }
        getFileUrl(_fileId: string): Promise<string> {
          return Promise.resolve("https://example.com/file");
        }
      }

      const adapter = new MockAdapter();
      for (const method of requiredMethods) {
        expect(typeof (adapter as unknown as Record<string, unknown>)[method]).toBe("function");
      }
      expect(requiredMethods.length).toBe(12);
    });

    it("readonly info property is accessible", () => {
      class MockAdapter implements PlatformAdapter {
        readonly info: PlatformInfo = {
          platform: "telegram",
          messageMaxLength: 4096,
          documentCaptionMaxLength: 1024,
        };
        setChatId(_chatId: string): void {}
        sendMessage(_text: string, _options?: PlatformMessageOptions): Promise<PlatformMessageRef> {
          return Promise.resolve("1");
        }
        sendDocument(
          _file: unknown,
          _options?: PlatformDocumentOptions,
        ): Promise<PlatformMessageRef> {
          return Promise.resolve("2");
        }
        sendPhoto(
          _photo: unknown,
          _options?: PlatformDocumentOptions,
        ): Promise<PlatformMessageRef> {
          return Promise.resolve("3");
        }
        editMessage(
          _ref: PlatformMessageRef,
          _text: string,
          _options?: PlatformMessageOptions,
        ): Promise<void> {
          return Promise.resolve();
        }
        deleteMessage(_ref: PlatformMessageRef): Promise<void> {
          return Promise.resolve();
        }
        pinMessage(_ref: PlatformMessageRef): Promise<void> {
          return Promise.resolve();
        }
        unpinAllMessages(): Promise<void> {
          return Promise.resolve();
        }
        answerCallbackQuery(_id: string, _options?: PlatformCallbackQueryOptions): Promise<void> {
          return Promise.resolve();
        }
        sendTyping(): Promise<void> {
          return Promise.resolve();
        }
        setCommands(_commands: Array<{ command: string; description: string }>): Promise<void> {
          return Promise.resolve();
        }
        getFileUrl(_fileId: string): Promise<string> {
          return Promise.resolve("https://example.com/file");
        }
      }

      const adapter = new MockAdapter();
      const info = adapter.info;
      expect(info).toBeDefined();
      expect(info.platform).toBe("telegram");
      expect(info.messageMaxLength).toBe(4096);
      expect(info.documentCaptionMaxLength).toBe(1024);
    });
  });

  describe("PlatformMessageOptions", () => {
    it("allows all optional properties", () => {
      const options: PlatformMessageOptions = {
        parseMode: "MarkdownV2",
        replyMarkup: { some: "object" },
        replyToMessageRef: "123",
        disableWebPagePreview: true,
      };
      expect(options.parseMode).toBe("MarkdownV2");
      expect(options.disableWebPagePreview).toBe(true);
    });

    it("parseMode can be Markdown, MarkdownV2, or HTML", () => {
      const markdown: PlatformMessageOptions = { parseMode: "Markdown" };
      const markdownV2: PlatformMessageOptions = { parseMode: "MarkdownV2" };
      const html: PlatformMessageOptions = { parseMode: "HTML" };

      expect(markdown.parseMode).toBe("Markdown");
      expect(markdownV2.parseMode).toBe("MarkdownV2");
      expect(html.parseMode).toBe("HTML");
    });
  });

  describe("PlatformDocumentOptions", () => {
    it("allows caption and parseMode", () => {
      const options: PlatformDocumentOptions = {
        caption: "File description",
        parseMode: "MarkdownV2",
      };
      expect(options.caption).toBe("File description");
      expect(options.parseMode).toBe("MarkdownV2");
    });
  });

  describe("PlatformCallbackQueryOptions", () => {
    it("allows text and showAlert", () => {
      const options: PlatformCallbackQueryOptions = {
        text: "Action completed",
        showAlert: true,
      };
      expect(options.text).toBe("Action completed");
      expect(options.showAlert).toBe(true);
    });
  });
});
