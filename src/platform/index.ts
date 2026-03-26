import { config } from "../config.js";

/**
 * Platform-agnostic bot lifecycle interface.
 */
export interface PlatformBot {
  start(): Promise<void>;
}

/**
 * Factory function that creates the Discord platform bot.
 *
 * @returns A PlatformBot instance with a start() method
 */
export function createPlatformBot(): PlatformBot {
  return createDiscordPlatformBot();
}

/**
 * Creates a Discord bot lifecycle wrapper.
 * Calls createDiscordBot() and calls autoSubscribeDiscordEvents before login.
 */
function createDiscordPlatformBot(): PlatformBot {
  return {
    start: async () => {
      const { createDiscordBot, autoSubscribeDiscordEvents } = await import("./discord/bot.js");
      const client = createDiscordBot();
      await autoSubscribeDiscordEvents(client);
      await client.login(config.discord.token);
    },
  };
}
