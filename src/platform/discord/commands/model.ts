import type { ChatInputCommandInteraction } from "discord.js";
import { DiscordAdapter } from "../adapter.js";
import { showDiscordModelSelection } from "../handlers/model.js";

export async function handleModelCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const scope = interaction.options.getString("scope");
  const showAll = scope === "all";

  const client = interaction.client;
  const adapter = new DiscordAdapter(client);
  adapter.setChatId(interaction.channelId);
  await showDiscordModelSelection(adapter, interaction, showAll);
}
