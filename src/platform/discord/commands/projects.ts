import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { getProjects } from "../../../project/manager.js";
import { syncSessionDirectoryCache } from "../../../session/cache-manager.js";
import { getCurrentProject } from "../../../settings/manager.js";
import { t } from "../../../i18n/index.js";
import { logger } from "../../../utils/logger.js";
import path from "node:path";

const MAX_SELECT_OPTIONS = 25;

export async function handleProjectsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    await syncSessionDirectoryCache();
    const projects = await getProjects();

    if (projects.length === 0) {
      await interaction.editReply({ content: t("projects.empty") });
      return;
    }

    const currentProject = getCurrentProject();

    const options: StringSelectMenuOptionBuilder[] = projects
      .slice(0, MAX_SELECT_OPTIONS)
      .map((project) => {
        const name = project.name || path.basename(project.worktree) || project.worktree;
        const label = name.substring(0, 100);
        const description = project.worktree.substring(0, 100);
        const isDefault = currentProject?.id === project.id;

        return new StringSelectMenuOptionBuilder()
          .setLabel(label)
          .setDescription(description)
          .setValue(project.id)
          .setDefault(isDefault);
      });

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("project:select")
        .setPlaceholder("Select a project")
        .addOptions(options),
    );

    const currentName = currentProject
      ? currentProject.name || path.basename(currentProject.worktree) || currentProject.worktree
      : "None";

    await interaction.editReply({
      content: `📁 **Projects** (${projects.length})\nCurrent: ${currentName}`,
      components: [row],
    });
  } catch (err) {
    logger.error("[Discord] Projects command error", err);
    await interaction.editReply({ content: t("projects.fetch_error") });
  }
}
