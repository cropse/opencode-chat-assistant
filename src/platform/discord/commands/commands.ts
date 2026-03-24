/**
 * Discord /commands handler - command selection, confirmation, and execution
 */
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ButtonInteraction,
} from "discord.js";
import { opencodeClient } from "../../../opencode/client.js";
import { getCurrentProject } from "../../../settings/manager.js";
import {
  getCurrentSession,
  setCurrentSession,
  clearSession,
  type SessionInfo,
} from "../../../session/manager.js";
import { ingestSessionInfoForCache } from "../../../session/cache-manager.js";
import { interactionManager } from "../../../interaction/manager.js";
import type { InteractionState } from "../../../interaction/types.js";
import { summaryAggregator } from "../../../summary/aggregator.js";
import { getStoredAgent } from "../../../agent/manager.js";
import { getStoredModel } from "../../../model/manager.js";
import { safeBackgroundTask } from "../../../utils/safe-background-task.js";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../i18n/index.js";
import type { DiscordAdapter } from "../adapter.js";

// Discord limits
const MAX_SELECT_OPTIONS = 25;
const MAX_OPTION_LABEL_LENGTH = 100;
const MAX_OPTION_DESCRIPTION_LENGTH = 100;

interface CommandItem {
  name: string;
  description?: string;
}

interface CommandsListMetadata {
  flow: "commands";
  stage: "list";
  projectDirectory: string;
  commands: CommandItem[];
}

interface CommandsConfirmMetadata {
  flow: "commands";
  stage: "confirm";
  projectDirectory: string;
  commandName: string;
}

type CommandsMetadata = CommandsListMetadata | CommandsConfirmMetadata;

export interface ExecuteCommandDeps {
  adapter: DiscordAdapter;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

function normalizeDirectoryForCommandApi(directory: string): string {
  return directory.replace(/\\/g, "/");
}

function parseCommandItems(value: unknown): CommandItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const commands: CommandItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const commandName = (item as { name?: unknown }).name;
    if (typeof commandName !== "string" || !commandName.trim()) {
      return null;
    }

    const description = (item as { description?: unknown }).description;
    commands.push({
      name: commandName,
      description: typeof description === "string" ? description : undefined,
    });
  }

  return commands;
}

function parseCommandsMetadata(state: InteractionState | null): CommandsMetadata | null {
  if (!state || state.kind !== "custom") {
    return null;
  }

  const flow = state.metadata.flow;
  const stage = state.metadata.stage;
  const projectDirectory = state.metadata.projectDirectory;

  if (flow !== "commands" || typeof projectDirectory !== "string") {
    return null;
  }

  if (stage === "list") {
    const commands = parseCommandItems(state.metadata.commands);
    if (!commands) {
      return null;
    }

    return {
      flow,
      stage,
      projectDirectory,
      commands,
    };
  }

  if (stage === "confirm") {
    const commandName = state.metadata.commandName;
    if (typeof commandName !== "string" || !commandName.trim()) {
      return null;
    }

    return {
      flow,
      stage,
      projectDirectory,
      commandName,
    };
  }

  return null;
}

function clearCommandsInteraction(reason: string): void {
  const metadata = parseCommandsMetadata(interactionManager.getSnapshot());
  if (metadata) {
    interactionManager.clear(reason);
  }
}

async function getCommandList(projectDirectory: string): Promise<CommandItem[]> {
  const { data, error } = await opencodeClient.command.list({
    directory: normalizeDirectoryForCommandApi(projectDirectory),
  });

  if (error || !data) {
    throw error || new Error("No command data received");
  }

  return data
    .filter((command) => typeof command.name === "string" && command.name.trim().length > 0)
    .map((command) => ({
      name: command.name,
      description: command.description,
    }));
}

async function isSessionBusy(sessionId: string, directory: string): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.session.status({ directory });

    if (error || !data) {
      logger.warn("[DiscordCommands] Failed to check session status before command:", error);
      return false;
    }

    const sessionStatus = (data as Record<string, { type?: string }>)[sessionId];
    if (!sessionStatus) {
      return false;
    }

    return sessionStatus.type === "busy";
  } catch (err) {
    logger.warn("[DiscordCommands] Error checking session status before command:", err);
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
      `[DiscordCommands] Session/project mismatch detected. sessionDirectory=${currentSession.directory}, projectDirectory=${projectDirectory}. Resetting session context.`,
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

async function executeCommand(
  adapter: DiscordAdapter,
  deps: ExecuteCommandDeps,
  params: { projectDirectory: string; commandName: string },
): Promise<void> {
  const args = "";
  await adapter.sendMessage(`${t("commands.executing_prefix")}\n/${params.commandName}`);

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
    taskName: "session.command",
    task: () =>
      opencodeClient.session.command({
        sessionID: session.id,
        directory: session.directory,
        command: params.commandName,
        arguments: args,
        agent: currentAgent,
        model,
        variant: storedModel.variant,
      }),
    onSuccess: ({ error }) => {
      if (error) {
        logger.error("[DiscordCommands] OpenCode API returned an error for session.command", {
          sessionId: session.id,
          command: params.commandName,
          args,
        });
        logger.error("[DiscordCommands] session.command error details:", error);
        void adapter.sendMessage(t("commands.execute_error")).catch(() => {});
        return;
      }

      logger.info(
        `[DiscordCommands] session.command completed: session=${session.id}, command=/${params.commandName}`,
      );
    },
    onError: (error) => {
      logger.error("[DiscordCommands] session.command background task failed", {
        sessionId: session.id,
        command: params.commandName,
        args,
      });
      logger.error("[DiscordCommands] session.command background failure details:", error);
      void adapter.sendMessage(t("commands.execute_error")).catch(() => {});
    },
  });
}

/**
 * Main /commands handler - shows select menu with all available commands
 */
export async function handleCommandsCommand(
  interaction: ChatInputCommandInteraction,
  _deps?: ExecuteCommandDeps,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const currentProject = getCurrentProject();
    if (!currentProject) {
      await interaction.editReply({ content: t("bot.project_not_selected") });
      return;
    }

    const commands = await getCommandList(currentProject.worktree);
    if (commands.length === 0) {
      await interaction.editReply({ content: t("commands.empty") });
      return;
    }

    // Build select menu options (Discord limit 25)
    const cappedCommands = commands.slice(0, MAX_SELECT_OPTIONS);
    const options = cappedCommands.map((cmd) => {
      const description = cmd.description?.trim() || t("commands.no_description");
      return new StringSelectMenuOptionBuilder()
        .setLabel(`/${cmd.name}`.substring(0, MAX_OPTION_LABEL_LENGTH))
        .setValue(cmd.name)
        .setDescription(description.substring(0, MAX_OPTION_DESCRIPTION_LENGTH));
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId("command:select")
      .setPlaceholder(t("commands.select"))
      .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.editReply({
      content: t("commands.select"),
      components: [row],
    });

    // Store interaction state for flow tracking
    interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: {
        flow: "commands",
        stage: "list",
        projectDirectory: currentProject.worktree,
        commands: cappedCommands,
      },
    });
  } catch (error) {
    logger.error("[DiscordCommands] Error fetching commands list:", error);
    await interaction.editReply({ content: t("commands.fetch_error") });
  }
}

/**
 * Handle command selection from the select menu
 */
export async function handleCommandSelectInteraction(
  interaction: StringSelectMenuInteraction,
  adapter: DiscordAdapter,
): Promise<void> {
  const customId = interaction.customId;
  if (customId !== "command:select") return;

  const selectedValue = interaction.values?.[0];
  if (!selectedValue) return;

  await interaction.deferUpdate();

  const metadata = parseCommandsMetadata(interactionManager.getSnapshot());

  if (!metadata || metadata.stage !== "list") {
    await interaction.editReply({
      content: t("commands.inactive_callback"),
      components: [],
    });
    return;
  }

  // Find the selected command
  const selectedCommand = metadata.commands.find((cmd) => cmd.name === selectedValue);
  if (!selectedCommand) {
    await interaction.editReply({
      content: t("commands.inactive_callback"),
      components: [],
    });
    return;
  }

  // Build confirmation buttons
  const executeButton = new ButtonBuilder()
    .setCustomId("command:execute")
    .setLabel(t("commands.button.execute"))
    .setStyle(ButtonStyle.Success);

  const cancelButton = new ButtonBuilder()
    .setCustomId("command:cancel")
    .setLabel(t("commands.button.cancel"))
    .setStyle(ButtonStyle.Secondary);

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    executeButton,
    cancelButton,
  );

  // Transition to confirm stage
  interactionManager.transition({
    expectedInput: "callback",
    metadata: {
      flow: "commands",
      stage: "confirm",
      projectDirectory: metadata.projectDirectory,
      commandName: selectedCommand.name,
    },
  });

  await interaction.editReply({
    content: t("commands.confirm", { command: `/${selectedCommand.name}` }),
    components: [buttonRow],
  });
}

/**
 * Handle Execute/Cancel button clicks
 */
export async function handleCommandButtonInteraction(
  interaction: ButtonInteraction,
  adapter: DiscordAdapter,
  deps: ExecuteCommandDeps,
): Promise<void> {
  const customId = interaction.customId;

  if (customId === "command:cancel") {
    clearCommandsInteraction("commands_cancelled");
    await interaction.update({
      content: t("commands.cancelled_callback"),
      components: [],
    });
    return;
  }

  if (customId === "command:execute") {
    const metadata = parseCommandsMetadata(interactionManager.getSnapshot());

    if (!metadata || metadata.stage !== "confirm") {
      await interaction.update({
        content: t("commands.inactive_callback"),
        components: [],
      });
      return;
    }

    clearCommandsInteraction("commands_execute_clicked");
    await interaction.update({
      content: t("commands.execute_callback"),
      components: [],
    });

    await executeCommand(adapter, deps, {
      projectDirectory: metadata.projectDirectory,
      commandName: metadata.commandName,
    });
    return;
  }
}
