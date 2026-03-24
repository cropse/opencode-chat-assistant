import { REST, Routes } from "discord.js";
import { config } from "../../../config.js";
import { logger } from "../../../utils/logger.js";
import { DISCORD_COMMAND_DEFINITIONS } from "./definitions.js";

/**
 * Register slash commands to the Discord guild via REST API.
 * Called from the bot's ready event handler after client login.
 *
 * @param clientId - The Discord application/client ID (from client.application?.id after login)
 */
export async function registerSlashCommands(clientId: string): Promise<void> {
  const rest = new REST().setToken(config.discord.token);
  const commands = DISCORD_COMMAND_DEFINITIONS.map((cmd) => cmd.toJSON());

  await rest.put(Routes.applicationGuildCommands(clientId, config.discord.serverId), {
    body: commands,
  });

  logger.info(
    `[Discord] Registered ${commands.length} slash commands to guild ${config.discord.serverId}`,
  );
}
