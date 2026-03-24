import type { StringSelectMenuInteraction } from "discord.js";
import { opencodeClient } from "../../../opencode/client.js";
import { getCurrentProject } from "../../../settings/manager.js";
import { setCurrentSession } from "../../../session/manager.js";
import { ingestSessionInfoForCache } from "../../../session/cache-manager.js";
import { summaryAggregator } from "../../../summary/aggregator.js";
import { clearAllInteractionState } from "../../../interaction/cleanup.js";
import { fetchSessionAgentAndModel, selectAgent, getStoredAgent } from "../../../agent/manager.js";
import { getAgentDisplayName } from "../../../agent/types.js";
import { selectModel, getStoredModel } from "../../../model/manager.js";
import { discordPinnedMessageManager } from "../pinned-manager.js";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../i18n/index.js";
import { buildStatusSummary } from "../formatter.js";
import type { DiscordAdapter } from "../adapter.js";

export async function handleSessionSelectInteraction(
  interaction: StringSelectMenuInteraction,
  _adapter: DiscordAdapter,
): Promise<void> {
  const customId = interaction.customId;
  if (customId !== "session:select") return;

  const selectedValue = interaction.values?.[0];
  if (!selectedValue) return;

  await interaction.deferUpdate();

  try {
    const currentProject = getCurrentProject();
    if (!currentProject) {
      await interaction.editReply({ content: t("sessions.project_not_selected"), components: [] });
      return;
    }

    // Fetch session details from API
    const { data: sessions, error } = await opencodeClient.session.list({
      directory: currentProject.worktree,
      limit: 25,
    });

    if (error || !sessions) {
      await interaction.editReply({ content: t("sessions.fetch_error"), components: [] });
      return;
    }

    const selectedSession = sessions.find((s: { id: string }) => s.id === selectedValue);
    if (!selectedSession) {
      await interaction.editReply({ content: t("sessions.fetch_error"), components: [] });
      return;
    }

    const sessionInfo = {
      id: selectedSession.id,
      title: selectedSession.title,
      directory: currentProject.worktree,
    };

    setCurrentSession(sessionInfo);
    summaryAggregator.clear();
    summaryAggregator.setSession(selectedSession.id);
    clearAllInteractionState("session_switched");
    await ingestSessionInfoForCache(selectedSession);

    // Restore agent/model from session history
    const sessionState = await fetchSessionAgentAndModel(
      selectedSession.id,
      currentProject.worktree,
    );
    if (sessionState) {
      selectAgent(sessionState.agent);
      if (sessionState.model) {
        selectModel({
          providerID: sessionState.model.providerID,
          modelID: sessionState.model.modelID,
          variant: sessionState.variant || "default",
        });
      }
    }

    // Build status summary
    const agent = getStoredAgent();
    const model = getStoredModel();
    const pinnedState = discordPinnedMessageManager.getState();
    const projectName =
      (currentProject.name || currentProject.worktree).split(/[\\/]/).pop() ||
      currentProject.worktree;

    // Fetch last assistant message for context
    let lastMessagePreview = "";
    try {
      const { data: messages } = await opencodeClient.session.messages({
        sessionID: selectedSession.id,
        directory: currentProject.worktree,
        limit: 5,
      });
      if (messages && messages.length > 0) {
        // Find last assistant message
        const lastAssistant = messages.find(
          (m: { info: { role: string } }) => m.info.role === "assistant",
        );
        if (lastAssistant) {
          // Extract text from parts
          const parts = (lastAssistant as { parts?: Array<{ type: string; text?: string }> }).parts;
          if (parts) {
            const textPart = parts.find((p) => p.type === "text" && p.text);
            if (textPart?.text) {
              const preview = textPart.text.substring(0, 200);
              lastMessagePreview = preview + (textPart.text.length > 200 ? "..." : "");
            }
          }
        }
      }
    } catch {
      // Non-critical — skip if we can't fetch
      logger.debug("[Discord] Could not fetch last message for session preview");
    }

    let summary = buildStatusSummary({
      action: `Session → ${selectedSession.title}`,
      project: projectName,
      session: selectedSession.title,
      agent: getAgentDisplayName(agent),
      model: model.providerID && model.modelID ? model.modelID : "Auto (agent default)",
      variant: model.variant,
      tokensUsed: pinnedState.tokensUsed,
      tokensLimit: pinnedState.tokensLimit,
    });

    if (lastMessagePreview) {
      summary += `\n\n💬 **Last response:**\n> ${lastMessagePreview.split("\n").join("\n> ")}`;
    }

    await interaction.editReply({
      content: summary,
      components: [],
    });
  } catch (err) {
    logger.error("[Discord] Session select error", err);
    await interaction.editReply({ content: t("sessions.fetch_error"), components: [] });
  }
}
