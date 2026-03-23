import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createPlatformBot, type PlatformBot } from "../../src/platform/index.js";

vi.mock("../../src/platform/telegram/bot.js", () => ({
  createBot: vi.fn(),
  autoSubscribeEvents: vi.fn(),
}));

describe("platform/index", () => {
  describe("createPlatformBot", () => {
    it("returns a PlatformBot with start() method for telegram", async () => {
      const platformBot = createPlatformBot("telegram");
      expect(typeof platformBot.start).toBe("function");
    });

    it("telegram factory calls createBot and autoSubscribeEvents", async () => {
      const mockBot = {
        api: {
          getWebhookInfo: vi.fn().mockResolvedValue({ url: undefined }),
          deleteWebhook: vi.fn(),
        },
        start: vi.fn(),
      };

      const { createBot, autoSubscribeEvents } = await import("../../src/platform/telegram/bot.js");
      vi.mocked(createBot).mockReturnValue(mockBot as never);
      vi.mocked(autoSubscribeEvents).mockResolvedValue(undefined);

      const platformBot = createPlatformBot("telegram");
      await platformBot.start();

      expect(createBot).toHaveBeenCalledTimes(1);
      expect(autoSubscribeEvents).toHaveBeenCalledTimes(1);
      expect(autoSubscribeEvents).toHaveBeenCalledWith(mockBot);
      expect(mockBot.start).toHaveBeenCalledTimes(1);
    });

    it("telegram factory removes webhook if present", async () => {
      const mockBot = {
        api: {
          getWebhookInfo: vi.fn().mockResolvedValue({ url: "https://example.com/webhook" }),
          deleteWebhook: vi.fn(),
        },
        start: vi.fn(),
      };

      const { createBot, autoSubscribeEvents } = await import("../../src/platform/telegram/bot.js");
      vi.mocked(createBot).mockReturnValue(mockBot as never);
      vi.mocked(autoSubscribeEvents).mockResolvedValue(undefined);

      const platformBot = createPlatformBot("telegram");
      await platformBot.start();

      expect(mockBot.api.deleteWebhook).toHaveBeenCalledTimes(1);
    });

    it("throws Error with correct message for unknown platform", () => {
      expect(() => createPlatformBot("unknown" as "telegram")).toThrow("Unknown platform: unknown");
    });
  });

  describe("PlatformBot interface", () => {
    it("start() returns Promise<void>", async () => {
      const mockBot = {
        api: {
          getWebhookInfo: vi.fn().mockResolvedValue({ url: undefined }),
          deleteWebhook: vi.fn(),
        },
        start: vi.fn(),
      };

      const { createBot, autoSubscribeEvents } = await import("../../src/platform/telegram/bot.js");
      vi.mocked(createBot).mockReturnValue(mockBot as never);
      vi.mocked(autoSubscribeEvents).mockResolvedValue(undefined);

      const platformBot: PlatformBot = createPlatformBot("telegram");
      const result = platformBot.start();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });
});
