import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";
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
import type { DiscordAdapter } from "../adapter.js";

const DISCORD_MAX_CONTENT = 1900;
const VERBOSE_KEYWORD = "verbose";

export interface SkillsCommandDeps {
  adapter: DiscordAdapter;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Autocomplete handler (must respond within 3s, max 25 choices)
// ---------------------------------------------------------------------------

export async function handleSkillsAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  try {
    const focused = interaction.options.getFocused();
    const project = getCurrentProject();

    if (!project) {
      await interaction.respond([]);
      return;
    }

    const skills = await getAvailableSkills(project.worktree);
    const query = focused.toLowerCase();

    // Always include "verbose" as a special option
    const choices: { name: string; value: string }[] = [];

    if (VERBOSE_KEYWORD.startsWith(query) || query === "") {
      choices.push({ name: "verbose — show detailed list", value: VERBOSE_KEYWORD });
    }

    const filtered = skills
      .filter((s) => s.name.toLowerCase().includes(query))
      .slice(0, 24) // leave room for "verbose" entry
      .map((s) => ({ name: s.name, value: s.name }));

    choices.push(...filtered);

    await interaction.respond(choices.slice(0, 25));
  } catch (err) {
    logger.debug("[DiscordSkills] Autocomplete error (silent):", err);
    await interaction.respond([]).catch(() => {});
  }
}

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
  adapter: DiscordAdapter,
  projectDirectory: string,
): Promise<SessionInfo | null> {
  let currentSession = getCurrentSession();

  if (currentSession && currentSession.directory !== projectDirectory) {
    logger.warn(
      `[DiscordSkills] Session/project mismatch. sessionDir=${currentSession.directory}, projectDir=${projectDirectory}. Resetting.`,
    );
    clearSession();
    summaryAggregator.clear();
    await adapter.sendMessage(t("bot.session_reset_project_mismatch"));
    currentSession = null;
  }

  if (currentSession) {
    return currentSession;
  }

  await adapter.sendMessage(t("bot.creating_session"));

  const { data: session, error } = await opencodeClient.session.create({
    directory: projectDirectory,
  });

  if (error || !session) {
    await adapter.sendMessage(t("bot.create_session_error"));
    return null;
  }

  const sessionInfo: SessionInfo = {
    id: session.id,
    title: session.title,
    directory: projectDirectory,
  };

  setCurrentSession(sessionInfo);
  await ingestSessionInfoForCache(session);
  await adapter.sendMessage(t("bot.session_created", { title: session.title }));

  return sessionInfo;
}

async function executeSkill(
  adapter: DiscordAdapter,
  deps: SkillsCommandDeps,
  params: { projectDirectory: string; skillName: string },
): Promise<void> {
  await adapter.sendMessage(t("skills.executing", { name: params.skillName }));

  const session = await ensureSessionForProject(adapter, params.projectDirectory);
  if (!session) {
    return;
  }

  await deps.ensureEventSubscription(session.directory);
  summaryAggregator.setSession(session.id);

  const sessionIsBusy = await isSessionBusy(session.id, session.directory);
  if (sessionIsBusy) {
    await adapter.sendMessage(t("bot.session_busy"));
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
        command: params.skillName,
        arguments: "",
        agent: currentAgent,
        model,
        variant: storedModel.variant,
      }),
    onSuccess: ({ error }) => {
      if (error) {
        logger.error("[DiscordSkills] session.command (skill) returned error:", {
          sessionId: session.id,
          skill: params.skillName,
        });
        logger.error("[DiscordSkills] Error details:", error);
        void adapter.sendMessage(t("skills.execute_error")).catch(() => {});
        return;
      }

      logger.info(
        `[DiscordSkills] Skill executed: session=${session.id}, skill=/${params.skillName}`,
      );
    },
    onError: (error) => {
      logger.error("[DiscordSkills] session.command (skill) background failure:", {
        sessionId: session.id,
        skill: params.skillName,
      });
      logger.error("[DiscordSkills] Background failure details:", error);
      void adapter.sendMessage(t("skills.execute_error")).catch(() => {});
    },
  });
}

// ---------------------------------------------------------------------------
// /skills command handler
//   - No args          → compact list (skill names only)
//   - name:"verbose"   → detailed list (names + descriptions)
//   - name:<skill>     → execute skill
// ---------------------------------------------------------------------------

export async function handleSkillsCommand(
  interaction: ChatInputCommandInteraction,
  deps?: SkillsCommandDeps,
): Promise<void> {
  await interaction.deferReply();

  try {
    const currentProject = getCurrentProject();

    if (!currentProject) {
      await interaction.editReply({ content: t("skills.no_project") });
      return;
    }

    const nameArg = interaction.options.getString("name");

    // ---------- Execute or verbose mode ----------
    if (nameArg) {
      const normalizedInput = nameArg.toLowerCase().trim();

      // Verbose list mode
      if (normalizedInput === VERBOSE_KEYWORD) {
        await sendVerboseList(interaction, currentProject.worktree);
        return;
      }

      // Execute mode — find matching skill
      const skills = await getAvailableSkills(currentProject.worktree);
      const matched = skills.find(
        (s) =>
          s.name.toLowerCase() === normalizedInput ||
          s.name.toLowerCase().startsWith(normalizedInput),
      );

      if (!matched) {
        await interaction.editReply({
          content: t("skills.not_found", { name: nameArg }),
        });
        return;
      }

      if (!deps) {
        logger.error("[DiscordSkills] Skill execution requested but deps not provided");
        await interaction.editReply({ content: t("skills.execute_error") });
        return;
      }

      await interaction.editReply({
        content: t("skills.executing", { name: matched.name }),
      });

      await executeSkill(deps.adapter, deps, {
        projectDirectory: currentProject.worktree,
        skillName: matched.name,
      });
      return;
    }

    // ---------- Compact list mode (default): just skill names ----------
    await sendCompactList(interaction, currentProject.worktree);
  } catch (err) {
    logger.error("[Discord] Skills command error", err);
    await interaction.editReply({ content: t("skills.error") });
  }
}

// ---------------------------------------------------------------------------
// List formatting
// ---------------------------------------------------------------------------

async function sendCompactList(
  interaction: ChatInputCommandInteraction,
  directory: string,
): Promise<void> {
  const skills = await getAvailableSkills(directory);

  if (!skills || skills.length === 0) {
    await interaction.editReply({ content: t("skills.empty") });
    return;
  }

  const header = `🛠 **${t("skills.title")}** (${skills.length})\n\n`;
  const list = skills.map((s) => `• \`${s.name}\``).join("\n");
  const footer = `\n\n_Use_ \`/skills verbose\` _for details, or_ \`/skills <name>\` _to execute._`;

  const message = `${header}${list}${footer}`;

  if (message.length <= DISCORD_MAX_CONTENT) {
    await interaction.editReply({ content: message });
    return;
  }

  // Chunk if somehow the list is huge
  const chunks: string[] = [];
  let currentChunk = header;

  for (const skill of skills) {
    const entry = `• \`${skill.name}\`\n`;
    if (currentChunk.length + entry.length > DISCORD_MAX_CONTENT) {
      chunks.push(currentChunk.trimEnd());
      currentChunk = "";
    }
    currentChunk += entry;
  }

  if (chunks.length === 0) {
    currentChunk += footer;
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trimEnd());
  }

  await interaction.editReply({ content: chunks[0] });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i] });
  }
}

async function sendVerboseList(
  interaction: ChatInputCommandInteraction,
  directory: string,
): Promise<void> {
  const skills = await getAvailableSkills(directory);

  if (!skills || skills.length === 0) {
    await interaction.editReply({ content: t("skills.empty") });
    return;
  }

  const header = `🛠 **${t("skills.title")}** (${skills.length})\n\n`;
  const chunks: string[] = [];
  let currentChunk = header;

  for (const skill of skills) {
    const name = `**${skill.name}**`;
    const description = skill.description || "_No description_";
    let entry = `${name}\n${description}\n\n`;

    if (entry.length > DISCORD_MAX_CONTENT) {
      const maxDescLen = DISCORD_MAX_CONTENT - name.length - 52;
      const truncatedDesc = description.slice(0, Math.max(0, maxDescLen)) + "...";
      entry = `${name}\n${truncatedDesc}\n\n`;
    }

    if (currentChunk.length + entry.length > DISCORD_MAX_CONTENT) {
      chunks.push(currentChunk.trimEnd());
      currentChunk = "";
    }
    currentChunk += entry;
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trimEnd());
  }

  await interaction.editReply({ content: chunks[0] || header });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i] });
  }
}
