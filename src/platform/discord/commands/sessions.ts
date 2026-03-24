import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { opencodeClient } from "../../../opencode/client.js";
import { getCurrentProject, getCurrentSession } from "../../../settings/manager.js";
import { t } from "../../../i18n/index.js";
import { logger } from "../../../utils/logger.js";

const MAX_SELECT_OPTIONS = 25;

export async function handleSessionsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const currentProject = getCurrentProject();

    if (!currentProject) {
      await interaction.editReply({ content: t("sessions.project_not_selected") });
      return;
    }

    const { data: sessions, error } = await opencodeClient.session.list({
      directory: currentProject.worktree,
      limit: MAX_SELECT_OPTIONS,
    });

    if (error || !sessions) {
      throw error || new Error("No data received from server");
    }

    if (sessions.length === 0) {
      await interaction.editReply({ content: t("sessions.empty") });
      return;
    }

    const currentSessionInfo = getCurrentSession();

    const options: StringSelectMenuOptionBuilder[] = sessions
      .slice(0, MAX_SELECT_OPTIONS)
      .map((session: { id: string; title: string; time?: { created?: number } }) => {
        const date = new Date(session.time?.created ?? Date.now()).toLocaleDateString();
        const label = session.title.substring(0, 80);
        const isDefault = currentSessionInfo?.id === session.id;

        return new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setDescription(date)
          .setValue(session.id)
          .setDefault(isDefault);
      });

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("session:select")
        .setPlaceholder("Select a session")
        .addOptions(options),
    );

    await interaction.editReply({
      content: `📋 **Sessions** (${sessions.length})`,
      components: [row],
    });
  } catch (err) {
    logger.error("[Discord] Sessions command error", err);
    await interaction.editReply({ content: t("sessions.fetch_error") });
  }
}
