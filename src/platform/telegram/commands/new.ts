import { CommandContext, Context } from "grammy";
import { opencodeClient } from "../../../opencode/client.js";
import { setCurrentSession, SessionInfo } from "../../../session/manager.js";
import { ingestSessionInfoForCache } from "../../../session/cache-manager.js";
import { getCurrentProject } from "../../../settings/manager.js";
import { clearAllInteractionState } from "../../../interaction/cleanup.js";
import { summaryAggregator } from "../../../summary/aggregator.js";
import { pinnedMessageManager } from "../pinned-manager.js";
import { keyboardManager } from "../keyboard-manager.js";
import { getStoredAgent, getAgentDefaultModel } from "../../../agent/manager.js";
import { getStoredModel, selectModel } from "../../../model/manager.js";
import { formatVariantForButton } from "../../../variant/manager.js";
import { createMainKeyboard } from "../utils/keyboard.js";
import { sendSessionPreview } from "./sessions.js";
import { safeBackgroundTask } from "../../../utils/safe-background-task.js";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../i18n/index.js";

export interface NewCommandDeps {
  ensureEventSubscription: (directory: string) => Promise<void>;
}

export async function newCommand(ctx: CommandContext<Context>, deps: NewCommandDeps) {
  try {
    const currentProject = getCurrentProject();

    if (!currentProject) {
      await ctx.reply(t("new.project_not_selected"));
      return;
    }

    logger.debug("[Bot] Creating new session for directory:", currentProject.worktree);

    const { data: session, error } = await opencodeClient.session.create({
      directory: currentProject.worktree,
    });

    if (error || !session) {
      throw error || new Error("No data received from server");
    }

    logger.info(
      `[Bot] Created new session via /new command: id=${session.id}, title="${session.title}", project=${currentProject.worktree}`,
    );

    const sessionInfo: SessionInfo = {
      id: session.id,
      title: session.title,
      directory: currentProject.worktree,
    };
    setCurrentSession(sessionInfo);
    summaryAggregator.clear();
    summaryAggregator.setSession(session.id);
    clearAllInteractionState("session_created");
    await ingestSessionInfoForCache(session);

    // Start SSE event subscription for the new session's directory
    safeBackgroundTask({
      taskName: "new.ensureEventSubscription",
      task: () => deps.ensureEventSubscription(currentProject.worktree),
    });

    // Initialize pinned message manager and create pinned message
    if (!pinnedMessageManager.isInitialized()) {
      pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
    }

    // Initialize keyboard manager if not already
    keyboardManager.initialize(ctx.api, ctx.chat.id);

    try {
      await pinnedMessageManager.onSessionChange(session.id, session.title);
    } catch (err) {
      logger.error("[Bot] Error creating pinned message:", err);
    }

    // Reset to default agent and its configured model for new session
    const currentAgent = getStoredAgent();
    const agentDefaultModel = await getAgentDefaultModel(currentAgent);
    if (agentDefaultModel) {
      selectModel({
        providerID: agentDefaultModel.providerID,
        modelID: agentDefaultModel.modelID,
        variant: "default",
      });
    }

    const currentModel = getStoredModel();
    const contextInfo = pinnedMessageManager.getContextInfo();
    const variantName = formatVariantForButton(currentModel.variant || "default");
    const keyboard = createMainKeyboard(
      currentAgent,
      currentModel,
      contextInfo ?? undefined,
      variantName,
    );

    await ctx.reply(t("new.created", { title: session.title }), {
      reply_markup: keyboard,
    });

    // Send session preview (consistent with /sessions behavior)
    if (ctx.chat) {
      const chatId = ctx.chat.id;
      safeBackgroundTask({
        taskName: "new.sendPreview",
        task: () =>
          sendSessionPreview(
            ctx.api,
            chatId,
            null,
            session.title,
            session.id,
            currentProject.worktree,
          ),
      });
    }
  } catch (error) {
    logger.error("[Bot] Error creating session:", error);
    await ctx.reply(t("new.create_error"));
  }
}
