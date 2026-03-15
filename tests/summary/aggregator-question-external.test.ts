import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";
import { summaryAggregator } from "../../src/summary/aggregator.js";
import { clearProcessedMessages } from "../../src/opencode/processed-messages.js";

const mocked = vi.hoisted(() => ({
  getCurrentProjectMock: vi.fn(),
}));

vi.mock("../../src/settings/manager.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/settings/manager.js")>(
    "../../src/settings/manager.js",
  );
  return {
    ...actual,
    getCurrentProject: mocked.getCurrentProjectMock,
  };
});

function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("question external reply handling", () => {
  const SESSION_ID = "test-session-1";
  const REQUEST_ID = "que_test123abc";

  beforeEach(() => {
    mocked.getCurrentProjectMock.mockReset();
    mocked.getCurrentProjectMock.mockReturnValue({ id: "p1", worktree: "D:/repo", name: "repo" });
    clearProcessedMessages();
    summaryAggregator.clear();
    summaryAggregator.setSession(SESSION_ID);
    // Suppress unhandled callbacks
    summaryAggregator.setOnCleared(() => {});
    summaryAggregator.setOnTool(() => {});
    summaryAggregator.setOnToolFile(() => {});
    summaryAggregator.setOnThinking(() => {});
    summaryAggregator.setOnSessionError(() => {});
    summaryAggregator.setOnSessionRetry(() => {});
  });

  it("fires onQuestion callback when question.asked event arrives for current session", async () => {
    const onQuestion = vi.fn();
    summaryAggregator.setOnQuestion(onQuestion);

    summaryAggregator.processEvent({
      type: "question.asked",
      properties: {
        id: REQUEST_ID,
        sessionID: SESSION_ID,
        questions: [
          {
            question: "Which color?",
            options: [
              { label: "Red", value: "Red" },
              { label: "Blue", value: "Blue" },
              { label: "Green", value: "Green" },
            ],
          },
        ],
      },
    } as unknown as Event);

    await flushSetImmediate();

    expect(onQuestion).toHaveBeenCalledTimes(1);
    expect(onQuestion).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ question: "Which color?" })]),
      REQUEST_ID,
    );
  });

  it("fires onQuestion even for different session (cross-client sync)", async () => {
    const onQuestion = vi.fn();
    summaryAggregator.setOnQuestion(onQuestion);

    summaryAggregator.processEvent({
      type: "question.asked",
      properties: {
        id: REQUEST_ID,
        sessionID: "other-session",
        questions: [{ question: "test?" }],
      },
    } as unknown as Event);

    await flushSetImmediate();

    expect(onQuestion).toHaveBeenCalledTimes(1);
  });

  it("fires onQuestionExternalReply when question.replied event arrives", async () => {
    const onExternalReply = vi.fn();
    summaryAggregator.setOnQuestionExternalReply(onExternalReply);

    summaryAggregator.processEvent({
      type: "question.replied",
      properties: {
        requestID: REQUEST_ID,
      },
    } as unknown as Event);

    await flushSetImmediate();

    expect(onExternalReply).toHaveBeenCalledTimes(1);
    expect(onExternalReply).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("fires onQuestionExternalReply when question.rejected event arrives", async () => {
    const onExternalReply = vi.fn();
    summaryAggregator.setOnQuestionExternalReply(onExternalReply);

    summaryAggregator.processEvent({
      type: "question.rejected",
      properties: {
        requestID: REQUEST_ID,
      },
    } as unknown as Event);

    await flushSetImmediate();

    expect(onExternalReply).toHaveBeenCalledTimes(1);
    expect(onExternalReply).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("fires onPermissionExternalReply when permission.replied event arrives", async () => {
    const onPermExternalReply = vi.fn();
    summaryAggregator.setOnPermissionExternalReply(onPermExternalReply);

    summaryAggregator.processEvent({
      type: "permission.replied",
      properties: {
        requestID: "perm_test456",
      },
    } as unknown as Event);

    await flushSetImmediate();

    expect(onPermExternalReply).toHaveBeenCalledTimes(1);
    expect(onPermExternalReply).toHaveBeenCalledWith("perm_test456");
  });
});

describe("bot's own reply vs external reply discrimination", () => {
  // This test verifies the logic in bot/index.ts where markBotQuestionReply
  // sets a flag that the external reply handler checks.
  // We test the aggregator side here (that it fires the callback).
  // The bot/index.ts side checks lastBotQuestionReplyID before acting.

  it("fires callback for ALL question.replied events (bot filters in handler)", async () => {
    const onExternalReply = vi.fn();
    summaryAggregator.setOnQuestionExternalReply(onExternalReply);

    // First question.replied (from bot's own answer)
    summaryAggregator.processEvent({
      type: "question.replied",
      properties: { requestID: "que_bot_answered" },
    } as unknown as Event);

    await flushSetImmediate();

    // Second question.replied (from GUI answer)
    summaryAggregator.processEvent({
      type: "question.replied",
      properties: { requestID: "que_gui_answered" },
    } as unknown as Event);

    await flushSetImmediate();

    // Aggregator fires for BOTH — the bot/index.ts handler discriminates
    expect(onExternalReply).toHaveBeenCalledTimes(2);
    expect(onExternalReply).toHaveBeenNthCalledWith(1, "que_bot_answered");
    expect(onExternalReply).toHaveBeenNthCalledWith(2, "que_gui_answered");
  });
});
