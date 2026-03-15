import type { CommandContext, Context } from "grammy";
import { getCurrentProject } from "../../settings/manager.js";
import { getAvailableSkills } from "../../skill/manager.js";
import { t } from "../../i18n/index.js";
import { sendMessageWithMarkdownFallback } from "../utils/send-with-markdown-fallback.js";

export async function skillsCommand(ctx: CommandContext<Context>) {
  const currentProject = getCurrentProject();

  if (!currentProject) {
    await ctx.reply(t("skills.no_project"));
    return;
  }

  try {
    const skills = await getAvailableSkills(currentProject.worktree);

    if (!skills || skills.length === 0) {
      await ctx.reply(t("skills.empty"));
      return;
    }

    const lines = skills.map((skill) => {
      const name = `*${skill.name}*`;
      const description = skill.description || "";
      return `${name}\n${description}`;
    });

    const message = `🛠 ${t("skills.title")}\n\n${lines.join("\n\n")}`;

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
