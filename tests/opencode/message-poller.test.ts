import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  startMessagePolling,
  stopMessagePolling,
  isPolling,
} from "../../src/opencode/message-poller.js";
import {
  markMessageProcessed,
  clearProcessedMessages,
} from "../../src/opencode/processed-messages.js";

// Mock the opencode client
vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      messages: vi.fn(),
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { opencodeClient } = await import("../../src/opencode/client.js");

describe("message-poller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearProcessedMessages();
    stopMessagePolling();
  });

  afterEach(() => {
    stopMessagePolling();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is not polling initially", () => {
    expect(isPolling()).toBe(false);
  });

  it("starts polling and loads initial snapshot", async () => {
    const mockMessages = vi.mocked(opencodeClient.session.messages);
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: {
            id: "msg-existing",
            role: "assistant",
            sessionID: "ses-1",
            time: { created: 1000, completed: 2000 },
          },
          parts: [
            {
              type: "text",
              text: "old reply",
              id: "p1",
              sessionID: "ses-1",
              messageID: "msg-existing",
            },
          ],
        },
      ],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    const callback = vi.fn();
    await startMessagePolling("ses-1", "/test", callback);

    expect(isPolling()).toBe(true);
    expect(mockMessages).toHaveBeenCalledWith({
      sessionID: "ses-1",
      directory: "/test",
    });
    // The existing message should NOT trigger the callback (it was in the initial snapshot)
    expect(callback).not.toHaveBeenCalled();
  });

  it("detects new completed assistant messages", async () => {
    const mockMessages = vi.mocked(opencodeClient.session.messages);

    // Initial snapshot: empty
    mockMessages.mockResolvedValueOnce({
      data: [],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    const callback = vi.fn();
    await startMessagePolling("ses-1", "/test", callback);

    // Next poll: one new completed assistant message
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: {
            id: "msg-new",
            role: "assistant",
            sessionID: "ses-1",
            time: { created: 3000, completed: 4000 },
          },
          parts: [
            { type: "text", text: "new reply", id: "p2", sessionID: "ses-1", messageID: "msg-new" },
          ],
        },
      ],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    await vi.advanceTimersByTimeAsync(3100);

    expect(callback).toHaveBeenCalledWith("ses-1", "new reply");
  });

  it("skips messages already processed by the SSE aggregator", async () => {
    const mockMessages = vi.mocked(opencodeClient.session.messages);

    // Initial snapshot: empty
    mockMessages.mockResolvedValueOnce({
      data: [],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    const callback = vi.fn();
    await startMessagePolling("ses-1", "/test", callback);

    // Mark the message as already processed (simulating SSE aggregator)
    markMessageProcessed("msg-sse");

    // Next poll: the SSE-processed message appears
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: {
            id: "msg-sse",
            role: "assistant",
            sessionID: "ses-1",
            time: { created: 3000, completed: 4000 },
          },
          parts: [
            { type: "text", text: "sse reply", id: "p3", sessionID: "ses-1", messageID: "msg-sse" },
          ],
        },
      ],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    await vi.advanceTimersByTimeAsync(3100);

    expect(callback).not.toHaveBeenCalled();
  });

  it("skips user messages", async () => {
    const mockMessages = vi.mocked(opencodeClient.session.messages);

    // Initial snapshot: empty
    mockMessages.mockResolvedValueOnce({
      data: [],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    const callback = vi.fn();
    await startMessagePolling("ses-1", "/test", callback);

    // Next poll: user message (not assistant)
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: { id: "msg-user", role: "user", sessionID: "ses-1", time: { created: 3000 } },
          parts: [
            {
              type: "text",
              text: "user prompt",
              id: "p4",
              sessionID: "ses-1",
              messageID: "msg-user",
            },
          ],
        },
      ],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    await vi.advanceTimersByTimeAsync(3100);

    expect(callback).not.toHaveBeenCalled();
  });

  it("stops polling", async () => {
    const mockMessages = vi.mocked(opencodeClient.session.messages);
    mockMessages.mockResolvedValueOnce({
      data: [],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    const callback = vi.fn();
    await startMessagePolling("ses-1", "/test", callback);
    expect(isPolling()).toBe(true);

    stopMessagePolling();
    expect(isPolling()).toBe(false);
  });

  it("restarts when called with a different session", async () => {
    const mockMessages = vi.mocked(opencodeClient.session.messages);

    // First session
    mockMessages.mockResolvedValueOnce({
      data: [],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    const callback1 = vi.fn();
    await startMessagePolling("ses-1", "/test", callback1);
    expect(isPolling()).toBe(true);

    // Second session
    mockMessages.mockResolvedValueOnce({
      data: [],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    const callback2 = vi.fn();
    await startMessagePolling("ses-2", "/test", callback2);
    expect(isPolling()).toBe(true);

    // Poll with new message for ses-2
    mockMessages.mockResolvedValueOnce({
      data: [
        {
          info: {
            id: "msg-ses2",
            role: "assistant",
            sessionID: "ses-2",
            time: { created: 5000, completed: 6000 },
          },
          parts: [
            {
              type: "text",
              text: "ses2 reply",
              id: "p5",
              sessionID: "ses-2",
              messageID: "msg-ses2",
            },
          ],
        },
      ],
      error: undefined,
      request: new Request("http://test"),
      response: new Response(),
    } as never);

    await vi.advanceTimersByTimeAsync(3100);

    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledWith("ses-2", "ses2 reply");
  });
});
