import { SlashCommandBuilder } from "discord.js";
import { t } from "../../../i18n/index.js";

/**
 * Centralized Discord bot slash command definitions.
 * Used for guild-scoped command registration via REST API.
 */
export const DISCORD_COMMAND_DEFINITIONS = [
  new SlashCommandBuilder().setName("status").setDescription(t("cmd.description.status")),

  new SlashCommandBuilder().setName("new").setDescription(t("cmd.description.new")),

  new SlashCommandBuilder().setName("abort").setDescription(t("cmd.description.stop")),

  new SlashCommandBuilder().setName("sessions").setDescription(t("cmd.description.sessions")),

  new SlashCommandBuilder().setName("projects").setDescription(t("cmd.description.projects")),

  new SlashCommandBuilder()
    .setName("rename")
    .setDescription(t("cmd.description.rename"))
    .addStringOption((opt) =>
      opt.setName("name").setDescription("New session name").setRequired(true),
    ),

  new SlashCommandBuilder().setName("commands").setDescription(t("cmd.description.commands")),

  new SlashCommandBuilder()
    .setName("skills")
    .setDescription(t("cmd.description.skills"))
    .addStringOption((opt) =>
      opt
        .setName("name")
        .setDescription("Skill name to invoke, or 'verbose' for detailed list")
        .setRequired(false)
        .setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName("opencode_start")
    .setDescription(t("cmd.description.opencode_start")),

  new SlashCommandBuilder()
    .setName("opencode_stop")
    .setDescription(t("cmd.description.opencode_stop")),

  new SlashCommandBuilder().setName("help").setDescription(t("cmd.description.help")),

  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Select AI model")
    .addStringOption((opt) =>
      opt
        .setName("scope")
        .setDescription("Show all catalog models")
        .addChoices({ name: "all", value: "all" })
        .setRequired(false),
    ),

  new SlashCommandBuilder().setName("agent").setDescription("Select agent mode (build/plan)"),

  new SlashCommandBuilder().setName("variant").setDescription("Select model variant"),
];
