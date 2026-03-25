import type { StringSelectMenuInteraction } from "discord.js";
import path from "node:path";
import { setCurrentProject } from "../../../settings/manager.js";
import { getProjects } from "../../../project/manager.js";
import { syncSessionDirectoryCache } from "../../../session/cache-manager.js";
import { clearSession } from "../../../session/manager.js";
import { summaryAggregator } from "../../../summary/aggregator.js";
import { clearAllInteractionState } from "../../../interaction/cleanup.js";
import { getStoredAgent } from "../../../agent/manager.js";
import { getAgentDisplayName } from "../../../agent/types.js";
import { getStoredModel } from "../../../model/manager.js";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../i18n/index.js";
import { buildStatusSummary } from "../formatter.js";
import type { DiscordAdapter } from "../adapter.js";

function shortenProjectName(fullPath: string): string {
  const base = path.basename(fullPath);
  return base || fullPath;
}

export async function handleProjectSelectInteraction(
  interaction: StringSelectMenuInteraction,
  _adapter: DiscordAdapter,
): Promise<void> {
  const customId = interaction.customId;
  if (customId !== "project:select") return;

  const selectedValue = interaction.values?.[0];
  if (!selectedValue) return;

  await interaction.deferUpdate();

  try {
    await syncSessionDirectoryCache();
    const projects = await getProjects();
    const selectedProject = projects.find((p) => p.id === selectedValue);

    if (!selectedProject) {
      await interaction.editReply({ content: t("projects.select_error"), components: [] });
      return;
    }

    setCurrentProject(selectedProject);
    clearSession();
    summaryAggregator.clear();
    clearAllInteractionState("project_switched");

    const projectName = shortenProjectName(selectedProject.name || selectedProject.worktree);
    const agent = getStoredAgent();
    const model = getStoredModel();
    const summary = buildStatusSummary({
      action: `Project → ${projectName}`,
      project: projectName,
      session: "(new session needed)",
      agent: getAgentDisplayName(agent),
      model: model.providerID && model.modelID ? model.modelID : "Auto (agent default)",
      variant: model.variant,
    });

    await interaction.editReply({
      content: summary,
      components: [],
    });
  } catch (err) {
    logger.error("[Discord] Project select error", err);
    await interaction.editReply({ content: t("projects.select_error"), components: [] });
  }
}
