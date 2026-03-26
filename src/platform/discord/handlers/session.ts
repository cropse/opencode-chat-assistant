import type { StringSelectMenuInteraction } from "discord.js";
import { opencodeClient } from "../../../opencode/client.js";
import { getCurrentProject, setDiscordChannelId } from "../../../settings/manager.js";
import { setCurrentSession } from "../../../session/manager.js";
import { ingestSessionInfoForCache } from "../../../session/cache-manager.js";
import { summaryAggregator } from "../../../summary/aggregator.js";
import { clearAllInteractionState } from "../../../interaction/cleanup.js";
import { fetchSessionAgentAndModel, selectAgent, getStoredAgent } from "../../../agent/manager.js";
import { getAgentDisplayName } from "../../../agent/types.js";
import { selectModel, getStoredModel } from "../../../model/manager.js";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../i18n/index.js";
import { buildStatusSummary } from "../formatter.js";
import { registerThreadSession } from "../bot.js";
import type { DiscordAdapter } from "../adapter.js";
import type { AssistantMessage, Part, TextPart } from "@opencode-ai/sdk/v2";
import { questionManager } from "../../../question/manager.js";
import { markQuestionSeen } from "../../../opencode/question-poller.js";
import { showDiscordQuestion } from "./question.js";
import type { Question } from "../../../question/types.js";

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
    const projectName =
      (currentProject.name || currentProject.worktree).split(/[\\/]/).pop() ||
      currentProject.worktree;

    // Fetch recent messages + token count from session history
    const MAX_PREVIEW_MESSAGES = 6;
    const MAX_PREVIEW_CHARS = 150;
    let exchanges: Array<{ role: "user" | "assistant"; text: string }> = [];
    let tokensUsed = 0;
    try {
      const { data: messages } = await opencodeClient.session.messages({
        sessionID: selectedSession.id,
        directory: currentProject.worktree,
      });

      if (messages && messages.length > 0) {
        logger.debug(`[Discord] Session messages count=${messages.length}`);

        // Filter out summary (compacted) assistant messages
        const nonSummary = messages.filter((m) => {
          if (m.info.role === "assistant") {
            return !(m.info as AssistantMessage).summary;
          }
          return true;
        });

        // Get tokensUsed from the LAST non-summary assistant message.
        // tokens.input represents the full context window sent for that API call,
        // so the last message reflects current context usage.
        const assistantMessages = nonSummary.filter((m) => m.info.role === "assistant");
        if (assistantMessages.length > 0) {
          const lastAssistant = assistantMessages[assistantMessages.length - 1];
          const lastInfo = lastAssistant.info as AssistantMessage;
          tokensUsed = (lastInfo.tokens?.input ?? 0) + (lastInfo.tokens?.cache?.read ?? 0);
        }

        // Take last N non-summary messages for preview (covers ~3 user↔assistant exchanges)
        const recentMessages = nonSummary.slice(-MAX_PREVIEW_MESSAGES);
        exchanges = recentMessages.map((m) => {
          const role = m.info.role as "user" | "assistant";
          const textPart = (m.parts as Part[]).find((p): p is TextPart => p.type === "text");
          let text = textPart?.text ?? "";
          if (text.length > MAX_PREVIEW_CHARS) {
            text = `${text.substring(0, MAX_PREVIEW_CHARS)}...`;
          }
          return { role, text };
        });
      }
    } catch (err) {
      logger.debug("[Discord] Could not fetch session history for preview:", err);
    }

    let summary = buildStatusSummary({
      action: `Session → ${selectedSession.title}`,
      project: projectName,
      session: selectedSession.title,
      agent: getAgentDisplayName(agent),
      model: model.providerID && model.modelID ? model.modelID : "Auto (agent default)",
      variant: model.variant,
      tokensUsed: tokensUsed || undefined,
    });

    // Append recent message exchanges using i18n labels
    if (exchanges.length > 0) {
      const lines: string[] = [`\n📋 **${t("sessions.preview.title")}**`];
      for (const ex of exchanges) {
        const label = ex.role === "user" ? t("sessions.preview.you") : t("sessions.preview.agent");
        const content = ex.text || "_…_";
        lines.push(`> **${label}** ${content.split("\n").join("\n> ")}`);
      }
      summary += lines.join("\n");
    } else {
      summary += `\n\n${t("sessions.preview.empty")}`;
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
      setDiscordChannelId(interaction.channelId);
    }

    // Send full status summary into the thread
    await adapter.sendMessage(summary);

    // Check for pending questions on this session and show them
    try {
      const { data: pendingQuestions } = await opencodeClient.question.list({
        directory: currentProject.worktree,
      });

      const questionList = Array.isArray(pendingQuestions) ? pendingQuestions : [];
      for (const q of questionList) {
        const qSessionId = q.sessionID as string;
        if (qSessionId !== selectedSession.id) continue;

        const qId = q.id as string;
        const questions: Question[] = (q.questions as Question[]) || [];
        if (!qId || questions.length === 0) continue;

        logger.info(
          `[Discord] Session switch: found pending question ${qId} for session ${selectedSession.id}`,
        );
        questionManager.startQuestions(questions, qId, selectedSession.id);
        markQuestionSeen(qId);
        await showDiscordQuestion(adapter, selectedSession.id);
        break; // Only show the first pending question
      }
    } catch (err) {
      logger.debug("[Discord] Could not check pending questions on session switch:", err);
    }
  } catch (err) {
    logger.error("[Discord] Session select error", err);
    await interaction.editReply({ content: t("sessions.fetch_error"), components: [] });
  }
}
