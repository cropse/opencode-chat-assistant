import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createPlatformBot } from "../../src/platform/index.js";

// Mock config module to provide required config values
vi.mock("../../src/config.js", () => ({
  config: {
    platform: "telegram",
    telegram: {
      token: "test-telegram-token",
      allowedUserId: 123456789,
      proxyUrl: "",
    },
    opencode: {
      apiUrl: "http://localhost:4096",
      username: "opencode",
      password: "",
    },
    server: {
      logLevel: "info",
    },
    bot: {
      sessionsListLimit: 10,
      projectsListLimit: 10,
      modelsListLimit: 10,
      locale: "en",
      serviceMessagesIntervalSec: 5,
      hideThinkingMessages: false,
      hideToolCallMessages: false,
      messageFormatMode: "markdown",
    },
    files: {
      maxFileSizeKb: 100,
    },
    stt: {
      apiUrl: "",
      apiKey: "",
      model: "whisper-large-v3-turbo",
      language: "",
    },
    discord: {
      token: "test-discord-token",
      guildId: "",
      channelId: "",
      allowedRoleIds: [],
      allowedUserIds: [],
    },
  },
}));

// Mock discord bot module
vi.mock("../../src/platform/discord/bot.js", () => ({
  createDiscordBot: vi.fn(),
  autoSubscribeDiscordEvents: vi.fn().mockResolvedValue(undefined),
}));

// Mock discord.js Client for type compatibility
vi.mock("discord.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    login: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    once: vi.fn(),
  })),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    DirectMessages: 4,
    MessageContent: 8,
  },
  Partials: {
    Channel: 1,
  },
  Events: {
    ClientReady: "ready",
    InteractionCreate: "interactionCreate",
    MessageCreate: "messageCreate",
  },
  ChannelType: {
    DM: 1,
    GuildText: 0,
  },
}));

describe("platform/integration", () => {
  describe("createPlatformBot dispatch", () => {
    it("returns PlatformBot with start() for telegram platform", async () => {
      const platformBot = createPlatformBot("telegram");
      expect(platformBot).toBeDefined();
      expect(typeof platformBot.start).toBe("function");
    });

    it("returns PlatformBot with start() for discord platform", async () => {
      const platformBot = createPlatformBot("discord");
      expect(platformBot).toBeDefined();
      expect(typeof platformBot.start).toBe("function");
    });

    it("discord start() calls createDiscordBot, autoSubscribeDiscordEvents, and client.login", async () => {
      const mockClient = {
        login: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        once: vi.fn(),
      };

      const { createDiscordBot, autoSubscribeDiscordEvents } =
        await import("../../src/platform/discord/bot.js");
      vi.mocked(createDiscordBot).mockReturnValue(mockClient as never);

      const platformBot = createPlatformBot("discord");
      await platformBot.start();

      expect(createDiscordBot).toHaveBeenCalledTimes(1);
      expect(autoSubscribeDiscordEvents).toHaveBeenCalledTimes(1);
      expect(autoSubscribeDiscordEvents).toHaveBeenCalledWith(mockClient);
      expect(mockClient.login).toHaveBeenCalledTimes(1);
      expect(mockClient.login).toHaveBeenCalledWith("test-discord-token");
    });

    it("throws for unknown platform", () => {
      expect(() => createPlatformBot("unknown" as "telegram")).toThrow("Unknown platform: unknown");
    });
  });
});
