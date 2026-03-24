import type { ChatInputCommandInteraction } from "discord.js";
import { DiscordAdapter } from "../adapter.js";
import { showDiscordAgentSelection } from "../handlers/agent.js";

export async function handleAgentCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const client = interaction.client;
  const adapter = new DiscordAdapter(client);
  adapter.setChatId(interaction.channelId);
  await showDiscordAgentSelection(adapter, interaction);
}
