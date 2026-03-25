import { Question, QuestionState, QuestionAnswer } from "./types.js";
import type { PlatformMessageRef } from "../platform/types.js";
import { logger } from "../utils/logger.js";

function createEmptyState(): QuestionState {
  return {
    questions: [],
    currentIndex: 0,
    selectedOptions: new Map(),
    customAnswers: new Map(),
    customInputQuestionIndex: null,
    activeMessageId: null,
    messageIds: [],
    isActive: false,
    requestID: null,
  };
}

function getState(states: Map<string, QuestionState>, sessionId: string): QuestionState {
  let state = states.get(sessionId);
  if (!state) {
    state = createEmptyState();
    states.set(sessionId, state);
  }
  return state;
}

function setState(
  states: Map<string, QuestionState>,
  sessionId: string,
  state: QuestionState,
): void {
  states.set(sessionId, state);
}

class QuestionManager {
  private states: Map<string, QuestionState> = new Map();

  startQuestions(questions: Question[], requestID: string, sessionId: string = "default"): void {
    const state = getState(this.states, sessionId);
    logger.debug(
      `[QuestionManager] startQuestions called: session=${sessionId}, isActive=${state.isActive}, currentQuestions=${state.questions.length}, newQuestions=${questions.length}, requestID=${requestID}`,
    );

    if (state.isActive) {
      logger.info(
        `[QuestionManager] Poll already active for session ${sessionId}! Forcing reset before starting new poll.`,
      );
      // Force-reset the previous poll before starting a new one
      this.clear(sessionId);
    }

    logger.info(
      `[QuestionManager] Starting new poll for session ${sessionId} with ${questions.length} questions, requestID=${requestID}`,
    );

    setState(this.states, sessionId, {
      questions,
      currentIndex: 0,
      selectedOptions: new Map(),
      customAnswers: new Map(),
      customInputQuestionIndex: null,
      activeMessageId: null,
      messageIds: [],
      isActive: true,
      requestID,
    });
  }

  getRequestID(sessionId: string = "default"): string | null {
    const state = getState(this.states, sessionId);
    return state.requestID;
  }

  getCurrentQuestion(sessionId: string = "default"): Question | null {
    const state = getState(this.states, sessionId);
    if (state.currentIndex >= state.questions.length) {
      return null;
    }
    return state.questions[state.currentIndex];
  }

  selectOption(questionIndex: number, optionIndex: number, sessionId: string = "default"): void {
    const state = getState(this.states, sessionId);
    if (!state.isActive) {
      return;
    }

    const question = state.questions[questionIndex];
    if (!question) {
      return;
    }

    const selected = state.selectedOptions.get(questionIndex) || new Set();

    if (question.multiple) {
      if (selected.has(optionIndex)) {
        selected.delete(optionIndex);
      } else {
        selected.add(optionIndex);
      }
    } else {
      selected.clear();
      selected.add(optionIndex);
    }

    state.selectedOptions.set(questionIndex, selected);

    logger.debug(
      `[QuestionManager] Selected options for question ${questionIndex} in session ${sessionId}: ${Array.from(selected).join(", ")}`,
    );
  }

  getSelectedOptions(questionIndex: number, sessionId: string = "default"): Set<number> {
    const state = getState(this.states, sessionId);
    return state.selectedOptions.get(questionIndex) || new Set();
  }

  getSelectedAnswer(questionIndex: number, sessionId: string = "default"): string {
    const state = getState(this.states, sessionId);
    const question = state.questions[questionIndex];
    if (!question) {
      return "";
    }

    const selected = state.selectedOptions.get(questionIndex) || new Set();
    const options = Array.from(selected)
      .map((idx) => question.options[idx])
      .filter((opt) => opt)
      .map((opt) => `* ${opt.label}: ${opt.description}`);

    return options.join("\n");
  }

  setCustomAnswer(questionIndex: number, answer: string, sessionId: string = "default"): void {
    const state = getState(this.states, sessionId);
    logger.debug(
      `[QuestionManager] Custom answer received for question ${questionIndex} in session ${sessionId}: ${answer}`,
    );
    state.customAnswers.set(questionIndex, answer);
  }

  getCustomAnswer(questionIndex: number, sessionId: string = "default"): string | undefined {
    const state = getState(this.states, sessionId);
    return state.customAnswers.get(questionIndex);
  }

  hasCustomAnswer(questionIndex: number, sessionId: string = "default"): boolean {
    const state = getState(this.states, sessionId);
    return state.customAnswers.has(questionIndex);
  }

  nextQuestion(sessionId: string = "default"): void {
    const state = getState(this.states, sessionId);
    state.currentIndex++;
    state.customInputQuestionIndex = null;
    state.activeMessageId = null;

    logger.debug(
      `[QuestionManager] Moving to next question in session ${sessionId}: ${state.currentIndex}/${state.questions.length}`,
    );
  }

  hasNextQuestion(sessionId: string = "default"): boolean {
    const state = getState(this.states, sessionId);
    return state.currentIndex < state.questions.length;
  }

  getCurrentIndex(sessionId: string = "default"): number {
    const state = getState(this.states, sessionId);
    return state.currentIndex;
  }

  getTotalQuestions(sessionId: string = "default"): number {
    const state = getState(this.states, sessionId);
    return state.questions.length;
  }

  // Overload for backward compatibility: addMessageId(messageId: number) — original signature
  addMessageId(messageId: number | PlatformMessageRef, sessionId?: string): void;
  // Overload for new API: addMessageId(messageId, sessionId)
  addMessageId(messageId: number | PlatformMessageRef, sessionId?: string): void {
    const sid = sessionId ?? "default";
    const state = getState(this.states, sid);
    state.messageIds.push(messageId as PlatformMessageRef);
  }

  setActiveMessageId(messageId: number | PlatformMessageRef | null, sessionId?: string): void {
    const sid = sessionId ?? "default";
    const state = getState(this.states, sid);
    state.activeMessageId = messageId as PlatformMessageRef;
  }

  getActiveMessageId(sessionId?: string): PlatformMessageRef | null {
    const state = getState(this.states, sessionId ?? "default");
    return state.activeMessageId;
  }

  isActiveMessage(
    messageId: number | PlatformMessageRef | null,
    sessionId: string = "default",
  ): boolean {
    const state = getState(this.states, sessionId);
    return state.isActive && state.activeMessageId !== null && messageId === state.activeMessageId;
  }

  startCustomInput(questionIndex: number, sessionId: string = "default"): void {
    const state = getState(this.states, sessionId);
    if (!state.isActive || !state.questions[questionIndex]) {
      return;
    }

    state.customInputQuestionIndex = questionIndex;
  }

  clearCustomInput(sessionId: string = "default"): void {
    const state = getState(this.states, sessionId);
    state.customInputQuestionIndex = null;
  }

  isWaitingForCustomInput(questionIndex: number, sessionId: string = "default"): boolean {
    const state = getState(this.states, sessionId);
    return state.customInputQuestionIndex === questionIndex;
  }

  getMessageIds(sessionId: string = "default"): PlatformMessageRef[] {
    const state = getState(this.states, sessionId);
    return [...state.messageIds];
  }

  isActive(sessionId: string = "default"): boolean {
    const state = getState(this.states, sessionId);
    logger.debug(
      `[QuestionManager] isActive check for session ${sessionId}: ${state.isActive}, questions=${state.questions.length}, currentIndex=${state.currentIndex}`,
    );
    return state.isActive;
  }

  cancel(sessionId: string = "default"): void {
    const state = getState(this.states, sessionId);
    logger.info(`[QuestionManager] Poll cancelled for session ${sessionId}`);
    state.isActive = false;
    state.customInputQuestionIndex = null;
    state.activeMessageId = null;
  }

  /**
   * Clear question state.
   * If sessionId is provided, clears only that session's state.
   * If sessionId is undefined, clears ALL sessions.
   */
  clear(sessionId?: string): void {
    if (sessionId !== undefined) {
      const cleared = createEmptyState();
      setState(this.states, sessionId, cleared);
      logger.debug(`[QuestionManager] Cleared question state for session ${sessionId}`);
    } else {
      this.states.clear();
      logger.debug(`[QuestionManager] Cleared question state for all sessions`);
    }
  }

  getAllAnswers(sessionId: string = "default"): QuestionAnswer[] {
    const state = getState(this.states, sessionId);
    const answers: QuestionAnswer[] = [];

    for (let i = 0; i < state.questions.length; i++) {
      const question = state.questions[i];
      const selectedAnswer = this.getSelectedAnswer(i, sessionId);
      const customAnswer = this.getCustomAnswer(i, sessionId);

      const finalAnswer = customAnswer || selectedAnswer;

      if (finalAnswer) {
        answers.push({
          question: question.question,
          answer: finalAnswer,
        });
      }
    }

    return answers;
  }
}

export const questionManager = new QuestionManager();
