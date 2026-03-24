import type { ChatInputCommandInteraction } from "discord.js";
import { opencodeClient } from "../../../opencode/client.js";
import { getCurrentSession } from "../../../session/manager.js";
import { getStoredModel } from "../../../model/manager.js";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../i18n/index.js";

export async function handleCompactCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply();

  try {
    const session = getCurrentSession();

    if (!session) {
      await interaction.editReply({ content: t("context.no_active_session") });
      return;
    }

    await interaction.editReply({ content: t("context.progress") });

    const storedModel = getStoredModel();

    logger.debug(
      `[Discord] Calling summarize with sessionID=${session.id}, directory=${session.directory}, model=${storedModel.providerID}/${storedModel.modelID}`,
    );

    const { error } = await opencodeClient.session.summarize({
      sessionID: session.id,
      directory: session.directory,
      providerID: storedModel.providerID,
      modelID: storedModel.modelID,
    });

    if (error) {
      logger.error("[Discord] Compact failed:", error);
      await interaction.editReply({ content: t("context.error") });
      return;
    }

    logger.info(`[Discord] Session compacted: ${session.id}`);
    await interaction.editReply({ content: t("context.success") });
  } catch (err) {
    logger.error("[Discord] Compact command error:", err);
    await interaction.editReply({ content: t("context.error") });
  }
}
