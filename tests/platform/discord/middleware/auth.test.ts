import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChannelType } from "discord.js";

// Mock config module - must include all required fields from config.ts
vi.mock("../../../../src/config.js", () => ({
  config: {
    opencode: {
      apiUrl: "http://localhost:4096",
      username: "opencode",
      password: "",
    },
    server: {
      logLevel: "error",
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
    discord: {
      token: "DISCORD_TOKEN",
      serverId: "123456789",
      allowedRoleIds: ["role123", "role456"],
      allowedUserIds: [123456789, 987654321],
    },
  },
}));

// Mock logger
vi.mock("../../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe("Discord Auth Middleware", () => {
  beforeEach(async () => {
    // Import and reset state after mocks are set up
    const { __resetSessionOwnerForTests } =
      await import("../../../../src/platform/discord/middleware/auth.js");
    __resetSessionOwnerForTests();
  });

  describe("isAuthorizedDiscordUser", () => {
    it("should authorize guild user with allowed role", async () => {
      const { isAuthorizedDiscordUser } =
        await import("../../../../src/platform/discord/middleware/auth.js");

      // Mock member with role
      const mockRolesCache = new Map<string, boolean>();
      mockRolesCache.set("role123", true);

      const mockMessage = {
        channel: { type: ChannelType.GuildText },
        author: { id: "111222333" },
        member: {
          roles: {
            cache: mockRolesCache,
          },
        },
      };

      expect(isAuthorizedDiscordUser(mockMessage as never)).toBe(true);
    });

    it("should deny guild user without allowed role", async () => {
      const { isAuthorizedDiscordUser } =
        await import("../../../../src/platform/discord/middleware/auth.js");

      const mockRolesCache = new Map<string, boolean>();

      const mockMessage = {
        channel: { type: ChannelType.GuildText },
        author: { id: "111222333" },
        member: {
          roles: {
            cache: mockRolesCache,
          },
        },
      };

      expect(isAuthorizedDiscordUser(mockMessage as never)).toBe(false);
    });

    it("should deny guild user when member is null", async () => {
      const { isAuthorizedDiscordUser } =
        await import("../../../../src/platform/discord/middleware/auth.js");

      const mockMessage = {
        channel: { type: ChannelType.GuildText },
        author: { id: "111222333" },
        member: null,
      };

      expect(isAuthorizedDiscordUser(mockMessage as never)).toBe(false);
    });

    it("should authorize DM user in whitelist", async () => {
      const { isAuthorizedDiscordUser } =
        await import("../../../../src/platform/discord/middleware/auth.js");

      const mockMessage = {
        channel: { type: ChannelType.DM },
        author: { id: "123456789" },
        member: null,
      };

      expect(isAuthorizedDiscordUser(mockMessage as never)).toBe(true);
    });

    it("should deny DM user not in whitelist", async () => {
      const { isAuthorizedDiscordUser } =
        await import("../../../../src/platform/discord/middleware/auth.js");

      const mockMessage = {
        channel: { type: ChannelType.DM },
        author: { id: "999999999" },
        member: null,
      };

      expect(isAuthorizedDiscordUser(mockMessage as never)).toBe(false);
    });

    it("should authorize user with any of multiple allowed roles", async () => {
      const { isAuthorizedDiscordUser } =
        await import("../../../../src/platform/discord/middleware/auth.js");

      const mockRolesCache = new Map<string, boolean>();
      mockRolesCache.set("role456", true);

      const mockMessage = {
        channel: { type: ChannelType.GuildText },
        author: { id: "111222333" },
        member: {
          roles: {
            cache: mockRolesCache,
          },
        },
      };

      expect(isAuthorizedDiscordUser(mockMessage as never)).toBe(true);
    });
  });

  describe("Session Owner Management", () => {
    it("should return null when no session owner is set", async () => {
      const { getSessionOwner } =
        await import("../../../../src/platform/discord/middleware/auth.js");
      expect(getSessionOwner()).toBeNull();
    });

    it("should set and get session owner", async () => {
      const { setSessionOwner, getSessionOwner } =
        await import("../../../../src/platform/discord/middleware/auth.js");

      setSessionOwner("user123");
      expect(getSessionOwner()).toBe("user123");
    });

    it("should clear session owner", async () => {
      const { setSessionOwner, getSessionOwner, clearSessionOwner } =
        await import("../../../../src/platform/discord/middleware/auth.js");

      setSessionOwner("user456");
      expect(getSessionOwner()).toBe("user456");

      clearSessionOwner();
      expect(getSessionOwner()).toBeNull();
    });

    it("should check if user is session owner", async () => {
      const { setSessionOwner, isSessionOwner } =
        await import("../../../../src/platform/discord/middleware/auth.js");

      setSessionOwner("owner789");

      expect(isSessionOwner("owner789")).toBe(true);
      expect(isSessionOwner("other123")).toBe(false);
    });

    it("should return false for isSessionOwner when no owner set", async () => {
      const { isSessionOwner } =
        await import("../../../../src/platform/discord/middleware/auth.js");
      expect(isSessionOwner("anyone")).toBe(false);
    });
  });

  describe("__resetSessionOwnerForTests", () => {
    it("should reset session owner to null", async () => {
      const { setSessionOwner, getSessionOwner, __resetSessionOwnerForTests } =
        await import("../../../../src/platform/discord/middleware/auth.js");

      setSessionOwner("testUser");
      expect(getSessionOwner()).toBe("testUser");

      __resetSessionOwnerForTests();
      expect(getSessionOwner()).toBeNull();
    });
  });
});
