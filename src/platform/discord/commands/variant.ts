import type { ChatInputCommandInteraction } from "discord.js";
import { DiscordAdapter } from "../adapter.js";
import { showDiscordVariantSelection } from "../handlers/variant.js";

export async function handleVariantCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const client = interaction.client;
  const adapter = new DiscordAdapter(client);
  adapter.setChatId(interaction.channelId);
  await showDiscordVariantSelection(adapter, interaction);
}
