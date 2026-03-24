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
import { registerThreadSession } from "../bot.js";
import type { DiscordAdapter } from "../adapter.js";

export async function handleSessionSelectInteraction(
  interaction: StringSelectMenuInteraction,
  adapter: DiscordAdapter,
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

    // Fetch last assistant message + token count from session history
    let lastMessagePreview = "";
    let tokensUsed = 0;
    try {
      const { data: messages } = await opencodeClient.session.messages({
        sessionID: selectedSession.id,
        directory: currentProject.worktree,
      });

      if (messages && messages.length > 0) {
        // Walk messages for tokens (take peak input+cache.read from assistant messages)
        for (const msg of messages) {
          if (msg.info?.role === "assistant") {
            const info = msg.info as {
              summary?: boolean;
              tokens?: { input?: number; cache?: { read?: number } };
            };
            if (!info.summary) {
              const input = info.tokens?.input ?? 0;
              const cacheRead = info.tokens?.cache?.read ?? 0;
              const total = input + cacheRead;
              if (total > tokensUsed) tokensUsed = total;
            }
          }
        }

        // Find last non-summary assistant message for preview
        const lastAssistant = messages.find(
          (m) => m.info?.role === "assistant" && !(m.info as Record<string, unknown>).summary,
        );
        if (lastAssistant) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const parts = (lastAssistant as any).parts as
            | Array<{ type: string; text?: string; content?: string }>
            | undefined;
          if (parts) {
            const textPart = parts.find((p) => p.type === "text" && (p.text || p.content));
            const raw = textPart?.text ?? textPart?.content ?? "";
            if (raw) {
              lastMessagePreview = raw.substring(0, 200) + (raw.length > 200 ? "..." : "");
            }
          }
        }
      }
    } catch {
      logger.debug("[Discord] Could not fetch session history for preview");
    }

    let summary = buildStatusSummary({
      action: `Session → ${selectedSession.title}`,
      project: projectName,
      session: selectedSession.title,
      agent: getAgentDisplayName(agent),
      model: model.providerID && model.modelID ? model.modelID : "Auto (agent default)",
      variant: model.variant,
      tokensUsed: tokensUsed || undefined,
      tokensLimit: pinnedState.tokensLimit || undefined,
    });

    if (lastMessagePreview) {
      summary += `\n\n💬 **Last response:**\n> ${lastMessagePreview.split("\n").join("\n> ")}`;
    }

    // Minimal anchor in main channel — thread will hold the real status
    await interaction.editReply({
      content: `🧵 **${selectedSession.title}**`,
      components: [],
    });

    // Create thread from the reply, then send status inside it
    const threadId = await adapter.createThreadFromInteraction(interaction, selectedSession.title);
    if (threadId) {
      registerThreadSession(threadId, {
        id: selectedSession.id,
        title: selectedSession.title,
        directory: currentProject.worktree,
      });
    }

    // Send full status summary into the thread
    await adapter.sendMessage(summary);
  } catch (err) {
    logger.error("[Discord] Session select error", err);
    await interaction.editReply({ content: t("sessions.fetch_error"), components: [] });
  }
}
