import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter, DISCORD_PLATFORM_INFO } from "../../../src/platform/discord/adapter.js";
import type {
  PlatformCallbackQueryOptions,
  PlatformMessageOptions,
} from "../../../src/platform/types.js";

// Mock discord.js
vi.mock("discord.js", () => ({
  ChannelType: {
    GuildText: 0,
    DM: 1,
    GuildAnnouncement: 10,
  },
}));

// Helper to create mock Discord client with channel
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockClient(channel?: unknown): any {
  // Ensure channel has correct type for Discord text channels (GuildText = 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textChannel: any = channel ?? { type: 0, send: vi.fn(), messages: { fetch: vi.fn() } };
  textChannel.type = 0; // Ensure GuildText type
  return {
    channels: {
      cache: { get: vi.fn().mockReturnValue(textChannel) },
      fetch: vi.fn().mockResolvedValue(textChannel),
    },
  };
}

describe("platform/discord/adapter", () => {
  describe("DISCORD_PLATFORM_INFO", () => {
    it("exports correct platform identifier", () => {
      expect(DISCORD_PLATFORM_INFO.platform).toBe("discord");
    });

    it("exports messageMaxLength of 2000", () => {
      expect(DISCORD_PLATFORM_INFO.messageMaxLength).toBe(2000);
    });

    it("exports documentCaptionMaxLength of 2000", () => {
      expect(DISCORD_PLATFORM_INFO.documentCaptionMaxLength).toBe(2000);
    });
  });

  describe("DiscordAdapter implements PlatformAdapter", () => {
    it("DiscordAdapter has readonly info property", () => {
      const adapter = new DiscordAdapter(createMockClient());
      expect(adapter.info).toBe(DISCORD_PLATFORM_INFO);
    });

    it("DiscordAdapter has all required PlatformAdapter methods", () => {
      const adapter = new DiscordAdapter(createMockClient());

      // Verify all methods exist
      expect(typeof adapter.setChatId).toBe("function");
      expect(typeof adapter.sendMessage).toBe("function");
      expect(typeof adapter.sendDocument).toBe("function");
      expect(typeof adapter.sendPhoto).toBe("function");
      expect(typeof adapter.editMessage).toBe("function");
      expect(typeof adapter.deleteMessage).toBe("function");
      expect(typeof adapter.answerCallbackQuery).toBe("function");
      expect(typeof adapter.sendTyping).toBe("function");
      expect(typeof adapter.setCommands).toBe("function");
      expect(typeof adapter.getFileUrl).toBe("function");
    });

    it("setChatId returns void (sync)", () => {
      const adapter = new DiscordAdapter(createMockClient());
      const result = adapter.setChatId("123");
      expect(result).toBeUndefined();
    });
  });

  describe("setChatId", () => {
    it("stores channel ID for later use", () => {
      const adapter = new DiscordAdapter(createMockClient());
      adapter.setChatId("channel-123");
      // The ID is stored internally; we verify via sendMessage behavior
    });
  });

  describe("sendMessage", () => {
    it("sends message to channel and returns message ID", async () => {
      const mockMessage = { id: "msg-456" };
      const mockChannel = {
        type: 0, // GuildText
        send: vi.fn().mockResolvedValue(mockMessage),
      };
      const mockClient = {
        channels: {
          cache: { get: vi.fn().mockReturnValue(mockChannel) },
          fetch: vi.fn(),
        },
      };

      const adapter = new DiscordAdapter(mockClient);
      adapter.setChatId("channel-123");
      const result = await adapter.sendMessage("Hello, world!");

      expect(result).toBe("msg-456");
      expect(mockChannel.send).toHaveBeenCalledWith({ content: "Hello, world!" });
    });

    it("fetches channel if not in cache", async () => {
      const mockMessage = { id: "msg-789" };
      const mockChannel = {
        type: 0, // GuildText
        send: vi.fn().mockResolvedValue(mockMessage),
      };
      const mockClient = {
        channels: {
          cache: { get: vi.fn().mockReturnValue(undefined) },
          fetch: vi.fn().mockResolvedValue(mockChannel),
        },
      };

      const adapter = new DiscordAdapter(mockClient);
      adapter.setChatId("channel-123");
      const result = await adapter.sendMessage("Test message");

      expect(result).toBe("msg-789");
      expect(mockClient.channels.fetch).toHaveBeenCalledWith("channel-123");
    });

    it("throws error if channel not found", async () => {
      const mockClient = {
        channels: {
          cache: { get: vi.fn().mockReturnValue(undefined) },
          fetch: vi.fn().mockResolvedValue(undefined),
        },
      };

      const adapter = new DiscordAdapter(mockClient);
      adapter.setChatId("invalid-channel");

      await expect(adapter.sendMessage("test")).rejects.toThrow(
        "Channel invalid-channel not found",
      );
    });
  });

  describe("sendDocument", () => {
    it("sends document with caption and returns message ID", async () => {
      const mockMessage = { id: "doc-msg-123" };
      const mockChannel = {
        type: 0, // GuildText
        send: vi.fn().mockResolvedValue(mockMessage),
      };
      const mockClient = {
        channels: {
          cache: { get: vi.fn().mockReturnValue(mockChannel) },
          fetch: vi.fn(),
        },
      };

      const adapter = new DiscordAdapter(mockClient);
      adapter.setChatId("channel-123");
      const result = await adapter.sendDocument(Buffer.from("test content"), {
        caption: "Test caption",
      });

      expect(result).toBe("doc-msg-123");
      expect(mockChannel.send).toHaveBeenCalledWith({
        content: "Test caption",
        files: [{ attachment: Buffer.from("test content"), name: "file" }],
      });
    });

    it("sends document without caption", async () => {
      const mockMessage = { id: "doc-msg-456" };
      const mockChannel = {
        type: 0, // GuildText
        send: vi.fn().mockResolvedValue(mockMessage),
      };
      const mockClient = {
        channels: {
          cache: { get: vi.fn().mockReturnValue(mockChannel) },
          fetch: vi.fn(),
        },
      };

      const adapter = new DiscordAdapter(mockClient);
      adapter.setChatId("channel-123");
      const result = await adapter.sendDocument("/path/to/file.txt");

      expect(result).toBe("doc-msg-456");
      expect(mockChannel.send).toHaveBeenCalledWith({
        content: undefined,
        files: [{ attachment: "/path/to/file.txt", name: "file" }],
      });
    });
  });

  describe("sendPhoto", () => {
    it("delegates to sendDocument", async () => {
      const mockMessage = { id: "photo-msg-123" };
      const mockChannel = {
        type: 0, // GuildText
        send: vi.fn().mockResolvedValue(mockMessage),
      };
      const mockClient = {
        channels: {
          cache: { get: vi.fn().mockReturnValue(mockChannel) },
          fetch: vi.fn(),
        },
      };

      const adapter = new DiscordAdapter(mockClient);
      adapter.setChatId("channel-123");
      const result = await adapter.sendPhoto(Buffer.from("photo data"), { caption: "A photo" });

      expect(result).toBe("photo-msg-123");
      expect(mockChannel.send).toHaveBeenCalledWith({
        content: "A photo",
        files: [{ attachment: Buffer.from("photo data"), name: "file" }],
      });
    });
  });

  describe("editMessage", () => {
    it("edits existing message", async () => {
      const mockMessage = {
        edit: vi.fn().mockResolvedValue(undefined),
      };
      const mockChannel = {
        type: 0, // GuildText
        messages: {
          fetch: vi.fn().mockResolvedValue(mockMessage),
        },
      };
      const mockClient = {
        channels: {
          cache: { get: vi.fn().mockReturnValue(mockChannel) },
          fetch: vi.fn(),
        },
      };

      const adapter = new DiscordAdapter(mockClient);
      adapter.setChatId("channel-123");
      await adapter.editMessage("msg-123", "Updated text");

      expect(mockChannel.messages.fetch).toHaveBeenCalledWith("msg-123");
      expect(mockMessage.edit).toHaveBeenCalledWith("Updated text");
    });

    it("passes options through (even though Discord doesn't support all parse modes)", async () => {
      const mockMessage = {
        edit: vi.fn().mockResolvedValue(undefined),
      };
      const mockChannel = {
        type: 0, // GuildText
        messages: {
          fetch: vi.fn().mockResolvedValue(mockMessage),
        },
      };
      const mockClient = {
        channels: {
          cache: { get: vi.fn().mockReturnValue(mockChannel) },
          fetch: vi.fn(),
        },
      };

      const adapter = new DiscordAdapter(mockClient);
      adapter.setChatId("channel-123");
      const options: PlatformMessageOptions = {
        parseMode: "MarkdownV2",
        replyMarkup: {},
      };
      await adapter.editMessage("msg-123", "Updated text", options);

      // Discord edit doesn't support options in current implementation
      expect(mockMessage.edit).toHaveBeenCalledWith("Updated text");
    });
  });

  describe("deleteMessage", () => {
    it("deletes message by ID", async () => {
      const mockMessage = {
        delete: vi.fn().mockResolvedValue(undefined),
      };
      const mockChannel = {
        type: 0, // GuildText
        messages: {
          fetch: vi.fn().mockResolvedValue(mockMessage),
        },
      };
      const mockClient = {
        channels: {
          cache: { get: vi.fn().mockReturnValue(mockChannel) },
          fetch: vi.fn(),
        },
      };

      const adapter = new DiscordAdapter(mockClient);
      adapter.setChatId("channel-123");
      await adapter.deleteMessage("msg-123");

      expect(mockChannel.messages.fetch).toHaveBeenCalledWith("msg-123");
      expect(mockMessage.delete).toHaveBeenCalled();
    });
  });

  describe("answerCallbackQuery", () => {
    it("is no-op (Discord uses different interaction model)", async () => {
      const adapter = new DiscordAdapter(createMockClient());
      adapter.setChatId("channel-123");

      // Should not throw
      const options: PlatformCallbackQueryOptions = { text: "Test", showAlert: true };
      await expect(adapter.answerCallbackQuery("callback-123", options)).resolves.toBeUndefined();
    });
  });

  describe("sendTyping", () => {
    it("sends typing indicator to channel", async () => {
      const mockChannel = {
        sendTyping: vi.fn().mockResolvedValue(undefined),
      };
      const adapter = new DiscordAdapter(createMockClient(mockChannel));
      adapter.setChatId("channel-123");
      await adapter.sendTyping();

      expect(mockChannel.sendTyping).toHaveBeenCalled();
    });
  });

  describe("setCommands", () => {
    it("is no-op (slash commands registered on ready)", async () => {
      const adapter = new DiscordAdapter(createMockClient());
      adapter.setChatId("channel-123");

      const commands = [
        { command: "status", description: "Show status" },
        { command: "help", description: "Show help" },
      ];
      await expect(adapter.setCommands(commands)).resolves.toBeUndefined();
    });
  });

  describe("getFileUrl", () => {
    it("returns fileId as-is (Discord uses attachment URLs directly)", async () => {
      const adapter = new DiscordAdapter(createMockClient());

      const result = await adapter.getFileUrl("attachment-url-123");
      expect(result).toBe("attachment-url-123");
    });
  });

  describe("channel type validation", () => {
    it("rejects non-text channels", async () => {
      // Simulate a channel that is not a text channel (e.g., voice channel)
      const mockChannel = {
        type: 2, // Voice channel type
        send: vi.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockClient: any = {
        channels: {
          cache: { get: vi.fn().mockReturnValue(mockChannel) },
          fetch: vi.fn(),
        },
      };

      const adapter = new DiscordAdapter(mockClient);
      adapter.setChatId("voice-channel-123");

      await expect(adapter.sendMessage("test")).rejects.toThrow("is not a text channel");
    });
  });
});
