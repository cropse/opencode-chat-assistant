/**
 * Discord question handler - renders question polls as Discord buttons
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { questionManager } from "../../../question/manager.js";
import { opencodeClient } from "../../../opencode/client.js";
import { getCurrentProject, getCurrentSession } from "../../../settings/manager.js";
import { summaryAggregator } from "../../../summary/aggregator.js";
import { interactionManager } from "../../../interaction/manager.js";
import { safeBackgroundTask } from "../../../utils/safe-background-task.js";
import { logger } from "../../../utils/logger.js";
import { t } from "../../../i18n/index.js";
import type { DiscordAdapter } from "../adapter.js";
import { markBotQuestionReply } from "../bot.js";
// Discord button label max length
const MAX_BUTTON_LABEL_LENGTH = 80;

// Max buttons per ActionRow (Discord limit)
const MAX_BUTTONS_PER_ROW = 5;

function clearQuestionInteraction(reason: string, sessionId: string): void {
  const state = interactionManager.getSnapshot(sessionId);
  if (state?.kind === "question") {
    interactionManager.clear(reason, sessionId);
  }
}

function syncQuestionInteractionState(
  questionIndex: number,
  messageId: string | null,
  sessionId: string,
): void {
  const metadata: Record<string, unknown> = {
    questionIndex,
    inputMode: "options",
  };

  const requestID = questionManager.getRequestID(sessionId);
  if (requestID) {
    metadata.requestID = requestID;
  }

  if (messageId !== null) {
    metadata.messageId = messageId;
  }

  const state = interactionManager.getSnapshot(sessionId);
  if (state?.kind === "question") {
    interactionManager.transition(
      {
        expectedInput: "callback",
        metadata,
      },
      sessionId,
    );
    return;
  }

  interactionManager.start(
    {
      kind: "question",
      expectedInput: "callback",
      metadata,
    },
    sessionId,
  );
}

/**
 * Format question text for Discord (no markdown, Discord handles formatting)
 */
function formatQuestionText(
  question: {
    header: string;
    question: string;
    multiple?: boolean;
  },
  sessionId: string,
): string {
  const currentIndex = questionManager.getCurrentIndex(sessionId);
  const totalQuestions = questionManager.getTotalQuestions(sessionId);
  const progressText = totalQuestions > 0 ? `${currentIndex + 1}/${totalQuestions}` : "";

  const headerTitle = [progressText, question.header].filter(Boolean).join(" ");
  const header = headerTitle ? `**${headerTitle}**\n\n` : "";
  const multiple = question.multiple ? t("question.multi_hint") : "";
  return `${header}${question.question}${multiple}`;
}

/**
 * Build Discord ActionRow buttons from question options
 */
function buildQuestionButtons(
  questionIndex: number,
  selectedOptions: Set<number>,
  sessionId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const question = questionManager.getCurrentQuestion(sessionId);
  if (!question) return [];

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Create buttons for each option
  const buttons: ButtonBuilder[] = question.options.slice(0, 25).map((opt, idx) => {
    const isSelected = selectedOptions.has(idx);
    const icon = isSelected ? "✅ " : "";
    const label = `${icon}${opt.label}`.substring(0, MAX_BUTTON_LABEL_LENGTH);
    const customId = `question:select:${questionIndex}:${idx}`;

    return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Primary);
  });

  // Group buttons into rows of 5 (Discord limit)
  // Reserve last row for action buttons — cap option rows to 4 rows max
  const maxOptionRows = MAX_BUTTONS_PER_ROW - 1; // 4 rows for options, 1 for actions
  for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
    if (rows.length >= maxOptionRows) break;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      buttons.slice(i, i + MAX_BUTTONS_PER_ROW),
    );
    rows.push(row);
  }

  // Action row — always shown for both single and multiple choice
  const actionRow = new ActionRowBuilder<ButtonBuilder>();

  if (question.multiple) {
    actionRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`question:submit:${questionIndex}`)
        .setLabel(t("question.button.submit"))
        .setStyle(ButtonStyle.Success),
    );
  }

  // "Type my own answer" — always available
  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`question:custom:${questionIndex}`)
      .setLabel(`✏️ ${t("question.button.custom")}`)
      .setStyle(ButtonStyle.Secondary),
  );

  // Cancel
  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`question:cancel:${questionIndex}`)
      .setLabel(t("question.button.cancel"))
      .setStyle(ButtonStyle.Danger),
  );

  rows.push(actionRow);

  return rows;
}

/**
 * Show the current question to the user
 */
export async function showDiscordQuestion(
  adapter: DiscordAdapter,
  sessionId: string,
): Promise<void> {
  const question = questionManager.getCurrentQuestion(sessionId);

  if (!question) {
    await showPollSummary(adapter, sessionId);
    return;
  }

  logger.debug(
    `[DiscordQuestionHandler] Showing question: ${question.header} - ${question.question}`,
  );

  const text = formatQuestionText(question, sessionId);
  const rows = buildQuestionButtons(
    questionManager.getCurrentIndex(sessionId),
    questionManager.getSelectedOptions(questionManager.getCurrentIndex(sessionId), sessionId),
    sessionId,
  );

  try {
    const messageId = await adapter.sendMessage(text, { replyMarkup: rows });

    logger.debug(`[DiscordQuestionHandler] Message sent, messageId=${messageId}`);

    questionManager.addMessageId(messageId, sessionId);
    questionManager.setActiveMessageId(messageId, sessionId);
    syncQuestionInteractionState(questionManager.getCurrentIndex(sessionId), messageId, sessionId);

    summaryAggregator.stopTypingIndicator();
  } catch (err) {
    questionManager.clear(sessionId);
    clearQuestionInteraction("question_message_send_failed", sessionId);
    logger.error("[DiscordQuestionHandler] Failed to send question message:", err);
    throw err;
  }
}

/**
 * Handle question button interaction
 */
export async function handleQuestionButtonInteraction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interaction: any,
  adapter: DiscordAdapter,
  sessionId: string,
): Promise<void> {
  const customId = interaction?.customId;
  if (!customId || !customId.startsWith("question:")) {
    return;
  }

  const parts = customId.split(":");
  const action = parts[1];
  const questionIndex = parseInt(parts[2], 10);
  const optionIndex = parseInt(parts[3], 10);

  // showModal requires the interaction to NOT be deferred/replied yet
  // so we defer only for non-modal actions
  if (action !== "custom") {
    if (typeof interaction.deferUpdate === "function") {
      await interaction.deferUpdate();
    }
  }

  logger.debug(`[DiscordQuestionHandler] Received button: ${customId}`);

  if (!questionManager.isActive(sessionId)) {
    clearQuestionInteraction("question_inactive_callback", sessionId);
    if (typeof interaction.reply === "function") {
      await interaction.reply({ content: t("question.inactive_callback"), ephemeral: true });
    }
    return;
  }

  if (Number.isNaN(questionIndex) || questionIndex !== questionManager.getCurrentIndex(sessionId)) {
    if (typeof interaction.reply === "function") {
      await interaction.reply({
        content: t("question.inactive_callback"),
        ephemeral: true,
      });
    }
    return;
  }

  try {
    switch (action) {
      case "select":
        {
          if (Number.isNaN(optionIndex)) break;
          await handleSelectOption(adapter, questionIndex, optionIndex, sessionId);
        }
        break;
      case "submit":
        await handleSubmitAnswer(adapter, questionIndex, sessionId);
        break;
      case "custom":
        {
          // Open a Discord Modal so the user can type a free-form answer
          const modal = new ModalBuilder()
            .setCustomId(`question:modal:${questionIndex}`)
            .setTitle(t("question.button.custom"));

          const question = questionManager.getCurrentQuestion(sessionId);
          const placeholder = question?.question.substring(0, 100) ?? "Your answer";

          const textInput = new TextInputBuilder()
            .setCustomId("custom_answer")
            .setLabel(t("question.button.custom"))
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder(placeholder)
            .setRequired(true)
            .setMaxLength(1000);

          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(textInput));

          // showModal must be called on the original interaction (NOT deferUpdate'd)
          // We haven't deferUpdate'd yet at this point — but we did at line ~197.
          // So use followUp for acknowledgement instead.
          if (typeof interaction.showModal === "function") {
            await interaction.showModal(modal);
          }
        }
        break;
      case "cancel":
        await handleCancelPoll(adapter, sessionId);
        break;
    }
  } catch (err) {
    logger.error("[DiscordQuestionHandler] Error handling button:", err);
    if (typeof interaction.reply === "function") {
      await interaction.reply({
        content: t("question.processing_error_callback"),
        ephemeral: true,
      });
    }
  }
}

async function handleSelectOption(
  adapter: DiscordAdapter,
  questionIndex: number,
  optionIndex: number,
  sessionId: string,
): Promise<void> {
  logger.debug(
    `[DiscordQuestionHandler] handleSelectOption: qIndex=${questionIndex}, oIndex=${optionIndex}`,
  );

  const question = questionManager.getCurrentQuestion(sessionId);
  if (!question) {
    logger.debug("[DiscordQuestionHandler] No current question");
    return;
  }

  questionManager.selectOption(questionIndex, optionIndex, sessionId);

  if (question.multiple) {
    // Update the message with new button states
    const text = formatQuestionText(question, sessionId);
    const rows = buildQuestionButtons(
      questionIndex,
      questionManager.getSelectedOptions(questionIndex, sessionId),
      sessionId,
    );

    const activeMessageId = questionManager.getActiveMessageId(sessionId);
    if (activeMessageId) {
      await adapter.editMessage(activeMessageId, text, { replyMarkup: rows });
    }
  } else {
    // Single choice: move to next question
    const answer = questionManager.getSelectedAnswer(questionIndex, sessionId);
    logger.debug(
      `[DiscordQuestionHandler] Selected answer for question ${questionIndex}: ${answer}`,
    );

    // Delete the question message
    const activeMessageId = questionManager.getActiveMessageId(sessionId);
    if (activeMessageId) {
      await adapter.deleteMessage(activeMessageId).catch(() => {});
    }

    await showNextQuestion(adapter, sessionId);
  }
}

async function handleSubmitAnswer(
  adapter: DiscordAdapter,
  questionIndex: number,
  sessionId: string,
): Promise<void> {
  const answer = questionManager.getSelectedAnswer(questionIndex, sessionId);

  if (!answer) {
    if (typeof adapter.sendMessage === "function") {
      await adapter.sendMessage(t("question.select_one_required_callback"));
    }
    return;
  }

  logger.debug(`[DiscordQuestionHandler] Submit answer for question ${questionIndex}: ${answer}`);

  // Delete the question message
  const activeMessageId = questionManager.getActiveMessageId(sessionId);
  if (activeMessageId) {
    await adapter.deleteMessage(activeMessageId).catch(() => {});
  }

  await showNextQuestion(adapter, sessionId);
}

async function handleCancelPoll(adapter: DiscordAdapter, sessionId: string): Promise<void> {
  questionManager.cancel(sessionId);
  clearQuestionInteraction("question_cancelled", sessionId);

  // Edit the message to show cancelled
  const activeMessageId = questionManager.getActiveMessageId(sessionId);
  if (activeMessageId) {
    await adapter.editMessage(activeMessageId, t("question.cancelled"));
  }

  questionManager.clear(sessionId);
}

async function showNextQuestion(adapter: DiscordAdapter, sessionId: string): Promise<void> {
  questionManager.nextQuestion(sessionId);

  if (questionManager.hasNextQuestion(sessionId)) {
    await showDiscordQuestion(adapter, sessionId);
  } else {
    await showPollSummary(adapter, sessionId);
  }
}

async function showPollSummary(adapter: DiscordAdapter, sessionId: string): Promise<void> {
  const answers = questionManager.getAllAnswers(sessionId);
  const totalQuestions = questionManager.getTotalQuestions(sessionId);

  logger.info(
    `[DiscordQuestionHandler] Poll completed: ${answers.length}/${totalQuestions} questions answered`,
  );

  // Send all answers to the OpenCode API
  await sendAllAnswersToAgent(adapter, sessionId);

  if (answers.length === 0) {
    await adapter.sendMessage(t("question.completed_no_answers"));
  } else {
    const summary = formatAnswersSummary(answers);
    await adapter.sendMessage(summary);
  }

  clearQuestionInteraction("question_completed", sessionId);
  questionManager.clear(sessionId);
  logger.debug("[DiscordQuestionHandler] Poll completed and cleared");
}

async function sendAllAnswersToAgent(adapter: DiscordAdapter, sessionId: string): Promise<void> {
  const currentProject = getCurrentProject();
  const currentSession = getCurrentSession();
  const requestID = questionManager.getRequestID(sessionId);
  const totalQuestions = questionManager.getTotalQuestions(sessionId);
  const directory = currentSession?.directory ?? currentProject?.worktree;

  if (!directory) {
    logger.error("[DiscordQuestionHandler] No project for sending answers");
    await adapter.sendMessage(t("question.no_active_project"));
    return;
  }

  if (!requestID) {
    logger.error("[DiscordQuestionHandler] No requestID for sending answers");
    await adapter.sendMessage(t("question.no_active_request"));
    return;
  }

  // Collect answers for all questions
  const allAnswers: string[][] = [];

  for (let i = 0; i < totalQuestions; i++) {
    const customAnswer = questionManager.getCustomAnswer(i, sessionId);
    const selectedAnswer = questionManager.getSelectedAnswer(i, sessionId);

    const answer = customAnswer || selectedAnswer || "";

    if (answer) {
      const answerParts = answer.split("\n").filter((part) => part.trim());
      allAnswers.push(answerParts);
    } else {
      allAnswers.push([]);
    }
  }

  logger.info(
    `[DiscordQuestionHandler] Sending all ${totalQuestions} answers to agent via question.reply: requestID=${requestID}`,
  );

  // Mark as bot-initiated so external reply detection ignores it
  markBotQuestionReply(requestID);

  // CRITICAL: Fire-and-forget!
  safeBackgroundTask({
    taskName: "question.reply",
    task: () =>
      opencodeClient.question.reply({
        requestID,
        directory,
        answers: allAnswers,
      }),
    onSuccess: ({ error }) => {
      if (error) {
        logger.error("[DiscordQuestionHandler] Failed to send answers via question.reply:", error);
      } else {
        logger.info(
          "[DiscordQuestionHandler] All answers sent to agent successfully via question.reply",
        );
      }
    },
  });
}

function formatAnswersSummary(answers: Array<{ question: string; answer: string }>): string {
  let summary = t("question.summary.title");

  answers.forEach((item, index) => {
    summary += t("question.summary.question", {
      index: index + 1,
      question: item.question,
    });
    summary += t("question.summary.answer", { answer: item.answer });
  });

  return summary;
}

/**
 * Handle modal submit interaction for custom answer input
 */
export async function handleQuestionModalSubmit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interaction: any,
  adapter: DiscordAdapter,
  sessionId: string,
): Promise<void> {
  const customId = interaction?.customId;
  if (!customId || !customId.startsWith("question:modal:")) return;

  const questionIndex = parseInt(customId.split(":")[2], 10);
  if (Number.isNaN(questionIndex)) return;

  // Acknowledge the modal submission
  if (typeof interaction.deferUpdate === "function") {
    await interaction.deferUpdate();
  } else if (typeof interaction.reply === "function") {
    await interaction.reply({ content: "✅", ephemeral: true });
  }

  const customAnswer = interaction?.fields?.getTextInputValue("custom_answer") ?? "";
  if (!customAnswer.trim()) return;

  logger.info(
    `[DiscordQuestionHandler] Modal custom answer for question ${questionIndex}: ${customAnswer.substring(0, 80)}...`,
  );

  questionManager.setCustomAnswer(questionIndex, customAnswer.trim(), sessionId);

  // Delete the question message and advance
  const activeMessageId = questionManager.getActiveMessageId(sessionId);
  if (activeMessageId) {
    await adapter.deleteMessage(activeMessageId).catch(() => {});
  }

  await showNextQuestion(adapter, sessionId);
}
