import type { CommandContext, Context } from "grammy";
import { getCurrentProject } from "../../../settings/manager.js";
import {
  clearSession,
  getCurrentSession,
  setCurrentSession,
  type SessionInfo,
} from "../../../session/manager.js";
import { ingestSessionInfoForCache } from "../../../session/cache-manager.js";
import { getAvailableSkills } from "../../../skill/manager.js";
import { opencodeClient } from "../../../opencode/client.js";
import { summaryAggregator } from "../../../summary/aggregator.js";
import { getStoredAgent } from "../../../agent/manager.js";
import { getStoredModel } from "../../../model/manager.js";
import { safeBackgroundTask } from "../../../utils/safe-background-task.js";
import { t } from "../../../i18n/index.js";
import { logger } from "../../../utils/logger.js";
import { sendMessageWithMarkdownFallback } from "../utils/send-with-markdown-fallback.js";

const VERBOSE_KEYWORD = "verbose";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isSessionBusy(sessionId: string, directory: string): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.session.status({ directory });

    if (error || !data) {
      return false;
    }

    const sessionStatus = (data as Record<string, { type?: string }>)[sessionId];
    return sessionStatus?.type === "busy";
  } catch {
    return false;
  }
}

async function ensureSessionForProject(
  ctx: CommandContext<Context>,
  projectDirectory: string,
): Promise<SessionInfo | null> {
  let currentSession = getCurrentSession();

  if (currentSession && currentSession.directory !== projectDirectory) {
    clearSession();
    summaryAggregator.clear();
    await ctx.reply(t("bot.session_reset_project_mismatch"));
    currentSession = null;
  }

  if (currentSession) {
    return currentSession;
  }

  await ctx.reply(t("bot.creating_session"));

  const { data: session, error } = await opencodeClient.session.create({
    directory: projectDirectory,
  });

  if (error || !session) {
    await ctx.reply(t("bot.create_session_error"));
    return null;
  }

  const sessionInfo: SessionInfo = {
    id: session.id,
    title: session.title,
    directory: projectDirectory,
  };

  setCurrentSession(sessionInfo);
  await ingestSessionInfoForCache(session);
  await ctx.reply(t("bot.session_created", { title: session.title }));

  return sessionInfo;
}

async function executeSkill(
  ctx: CommandContext<Context>,
  projectDirectory: string,
  skillName: string,
): Promise<void> {
  await ctx.reply(t("skills.executing", { name: skillName }));

  const session = await ensureSessionForProject(ctx, projectDirectory);
  if (!session) {
    return;
  }

  summaryAggregator.setSession(session.id);
  summaryAggregator.setTypingIndicator(async () => {
    await ctx.api.sendChatAction(ctx.chat!.id, "typing");
  });

  const sessionIsBusy = await isSessionBusy(session.id, session.directory);
  if (sessionIsBusy) {
    await ctx.reply(t("bot.session_busy"));
    return;
  }

  const currentAgent = getStoredAgent();
  const storedModel = getStoredModel();
  const model =
    storedModel.providerID && storedModel.modelID
      ? `${storedModel.providerID}/${storedModel.modelID}`
      : undefined;

  safeBackgroundTask({
    taskName: "session.skill",
    task: () =>
      opencodeClient.session.command({
        sessionID: session.id,
        directory: session.directory,
        command: skillName,
        arguments: "",
        agent: currentAgent,
        model,
        variant: storedModel.variant,
      }),
    onSuccess: ({ error }) => {
      if (error) {
        logger.error("[TelegramSkills] session.command (skill) error:", {
          sessionId: session.id,
          skill: skillName,
        });
        void ctx.api.sendMessage(ctx.chat!.id, t("skills.execute_error")).catch(() => {});
        return;
      }

      logger.info(`[TelegramSkills] Skill executed: session=${session.id}, skill=/${skillName}`);
    },
    onError: (error) => {
      logger.error("[TelegramSkills] session.command (skill) background failure:", error);
      void ctx.api.sendMessage(ctx.chat!.id, t("skills.execute_error")).catch(() => {});
    },
  });
}

// ---------------------------------------------------------------------------
// /skills command handler
//   - No args           → compact list (skill names only)
//   - /skills verbose   → detailed list (names + descriptions)
//   - /skills <name>    → execute skill
// ---------------------------------------------------------------------------

export async function skillsCommand(ctx: CommandContext<Context>) {
  const currentProject = getCurrentProject();

  if (!currentProject) {
    await ctx.reply(t("skills.no_project"));
    return;
  }

  const arg = (ctx.match as string)?.trim();

  try {
    // ---------- Verbose list mode ----------
    if (arg?.toLowerCase() === VERBOSE_KEYWORD) {
      const skills = await getAvailableSkills(currentProject.worktree);

      if (!skills || skills.length === 0) {
        await ctx.reply(t("skills.empty"));
        return;
      }

      const lines = skills.map((skill) => {
        const name = `*${skill.name}*`;
        const description = skill.description || "_No description_";
        return `${name}\n${description}`;
      });

      const message = `🛠 ${t("skills.title")} (${skills.length})\n\n${lines.join("\n\n")}`;

      if (ctx.chat) {
        await sendMessageWithMarkdownFallback({
          api: ctx.api,
          chatId: ctx.chat.id,
          text: message,
          options: {},
          parseMode: "Markdown",
        });
      } else {
        await ctx.reply(message);
      }
      return;
    }

    // ---------- Execute mode ----------
    if (arg) {
      const skills = await getAvailableSkills(currentProject.worktree);

      const normalizedInput = arg.toLowerCase();
      const matched = skills.find(
        (s) =>
          s.name.toLowerCase() === normalizedInput ||
          s.name.toLowerCase().startsWith(normalizedInput),
      );

      if (!matched) {
        await ctx.reply(t("skills.not_found", { name: arg }));
        return;
      }

      await executeSkill(ctx, currentProject.worktree, matched.name);
      return;
    }

    // ---------- Compact list mode (default) ----------
    const skills = await getAvailableSkills(currentProject.worktree);

    if (!skills || skills.length === 0) {
      await ctx.reply(t("skills.empty"));
      return;
    }

    const list = skills.map((s) => `• \`${s.name}\``).join("\n");
    const footer = "\n\nUse `/skills verbose` for details, or `/skills <name>` to execute.";
    const message = `🛠 *${t("skills.title")}* (${skills.length})\n\n${list}${footer}`;

    if (ctx.chat) {
      await sendMessageWithMarkdownFallback({
        api: ctx.api,
        chatId: ctx.chat.id,
        text: message,
        options: {},
        parseMode: "Markdown",
      });
    } else {
      await ctx.reply(message);
    }
  } catch {
    await ctx.reply(t("skills.error"));
  }
}
