import { describe, expect, it } from "vitest";

/**
 * Pure helper that mirrors the session history extraction logic in
 * src/platform/discord/handlers/session.ts.
 *
 * Keeping this logic testable in isolation so regressions like
 * "wrong last message", "always 0 tokens", or "wrong message order"
 * are caught before manual QA.
 */

interface MockTextPart {
  type: "text";
  text: string;
}

interface MockOtherPart {
  type: string;
}

type MockPart = MockTextPart | MockOtherPart;

interface MockAssistantInfo {
  role: "assistant";
  summary?: boolean;
  tokens?: {
    input: number;
    cache?: { read: number };
  };
}

interface MockUserInfo {
  role: "user";
}

type MockMessage = {
  info: MockAssistantInfo | MockUserInfo;
  parts: MockPart[];
};

interface ExchangePreview {
  role: "user" | "assistant";
  text: string;
}

/** Maximum number of recent messages to show (covers ~3 user↔assistant exchanges). */
const MAX_PREVIEW_MESSAGES = 6;

/** Maximum characters per individual message preview. */
const MAX_PREVIEW_CHARS = 150;

/**
 * Extracted pure logic from session.ts — extracting recent conversation
 * exchanges and token count from a list of session messages.
 *
 * Returns up to MAX_PREVIEW_MESSAGES recent non-summary messages as
 * exchange previews (both user and assistant), plus the token count
 * from the last non-summary assistant message.
 */
function extractSessionHistory(messages: MockMessage[]): {
  exchanges: ExchangePreview[];
  tokensUsed: number;
} {
  // Filter out summary assistant messages
  const nonSummary = messages.filter((m) => {
    if (m.info.role === "assistant") {
      return !(m.info as MockAssistantInfo).summary;
    }
    return true;
  });

  // Get tokensUsed from the LAST non-summary assistant message
  let tokensUsed = 0;
  const assistantMessages = nonSummary.filter((m) => m.info.role === "assistant");
  if (assistantMessages.length > 0) {
    const last = assistantMessages[assistantMessages.length - 1];
    const info = last.info as MockAssistantInfo;
    tokensUsed = (info.tokens?.input ?? 0) + (info.tokens?.cache?.read ?? 0);
  }

  // Take last N non-summary messages for preview
  const recentMessages = nonSummary.slice(-MAX_PREVIEW_MESSAGES);

  const exchanges: ExchangePreview[] = recentMessages.map((m) => {
    const role = m.info.role as "user" | "assistant";
    const textPart = m.parts.find((p): p is MockTextPart => p.type === "text");
    let text = textPart?.text ?? "";
    if (text.length > MAX_PREVIEW_CHARS) {
      text = text.substring(0, MAX_PREVIEW_CHARS) + "...";
    }
    return { role, text };
  });

  return { exchanges, tokensUsed };
}

describe("extractSessionHistory", () => {
  it("returns empty exchanges and 0 tokens for empty messages", () => {
    const result = extractSessionHistory([]);
    expect(result.exchanges).toEqual([]);
    expect(result.tokensUsed).toBe(0);
  });

  it("returns single user exchange with 0 tokens for user-only messages", () => {
    const messages: MockMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ];
    const result = extractSessionHistory(messages);
    expect(result.exchanges).toEqual([{ role: "user", text: "hello" }]);
    expect(result.tokensUsed).toBe(0);
  });

  it("returns single assistant exchange with tokens", () => {
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 1000, cache: { read: 500 } } },
        parts: [{ type: "text", text: "Hello!" }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.exchanges).toEqual([{ role: "assistant", text: "Hello!" }]);
    expect(result.tokensUsed).toBe(1500);
  });

  it("returns both user and assistant messages in a full exchange", () => {
    const messages: MockMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Hi there" }] },
      {
        info: { role: "assistant", tokens: { input: 200 } },
        parts: [{ type: "text", text: "Hello! How can I help?" }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.exchanges).toEqual([
      { role: "user", text: "Hi there" },
      { role: "assistant", text: "Hello! How can I help?" },
    ]);
    expect(result.tokensUsed).toBe(200);
  });

  it("returns multiple exchanges (2 full pairs)", () => {
    const messages: MockMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "First question" }] },
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [{ type: "text", text: "First answer" }],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "Follow-up" }] },
      {
        info: { role: "assistant", tokens: { input: 200 } },
        parts: [{ type: "text", text: "Second answer" }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.exchanges).toHaveLength(4);
    expect(result.exchanges[0]).toEqual({ role: "user", text: "First question" });
    expect(result.exchanges[1]).toEqual({ role: "assistant", text: "First answer" });
    expect(result.exchanges[2]).toEqual({ role: "user", text: "Follow-up" });
    expect(result.exchanges[3]).toEqual({ role: "assistant", text: "Second answer" });
  });

  it("limits to last 6 messages when conversation is longer", () => {
    const messages: MockMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Msg 1" }] },
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [{ type: "text", text: "Reply 1" }],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "Msg 2" }] },
      {
        info: { role: "assistant", tokens: { input: 200 } },
        parts: [{ type: "text", text: "Reply 2" }],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "Msg 3" }] },
      {
        info: { role: "assistant", tokens: { input: 300 } },
        parts: [{ type: "text", text: "Reply 3" }],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "Msg 4" }] },
      {
        info: { role: "assistant", tokens: { input: 400 } },
        parts: [{ type: "text", text: "Reply 4" }],
      },
    ];
    const result = extractSessionHistory(messages);
    // Should only include last 6: Msg 2, Reply 2, Msg 3, Reply 3, Msg 4, Reply 4
    expect(result.exchanges).toHaveLength(6);
    expect(result.exchanges[0]).toEqual({ role: "user", text: "Msg 2" });
    expect(result.exchanges[5]).toEqual({ role: "assistant", text: "Reply 4" });
  });

  it("takes tokens from LAST assistant message, not peak", () => {
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 500, cache: { read: 0 } } },
        parts: [{ type: "text", text: "First response" }],
      },
      {
        info: { role: "assistant", tokens: { input: 2000, cache: { read: 800 } } },
        parts: [{ type: "text", text: "Second response (peak)" }],
      },
      {
        info: { role: "assistant", tokens: { input: 1000, cache: { read: 0 } } },
        parts: [{ type: "text", text: "Third response" }],
      },
    ];
    const result = extractSessionHistory(messages);
    // LAST assistant message: input=1000, cache=0 → 1000 (NOT peak 2800)
    expect(result.tokensUsed).toBe(1000);
  });

  it("skips summary assistant messages entirely", () => {
    const messages: MockMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Question" }] },
      {
        info: { role: "assistant", summary: true, tokens: { input: 9999 } },
        parts: [{ type: "text", text: "Summary: blah blah" }],
      },
      {
        info: { role: "assistant", summary: false, tokens: { input: 300 } },
        parts: [{ type: "text", text: "Real reply" }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.tokensUsed).toBe(300);
    // Summary message should NOT appear in exchanges
    expect(result.exchanges).toHaveLength(2);
    expect(result.exchanges[0]).toEqual({ role: "user", text: "Question" });
    expect(result.exchanges[1]).toEqual({ role: "assistant", text: "Real reply" });
  });

  it("truncates each message to 150 chars with ellipsis", () => {
    const longText = "a".repeat(300);
    const messages: MockMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: longText }] },
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [{ type: "text", text: longText }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.exchanges[0].text).toBe("a".repeat(150) + "...");
    expect(result.exchanges[1].text).toBe("a".repeat(150) + "...");
  });

  it("does not add ellipsis for text exactly 150 chars", () => {
    const text = "b".repeat(150);
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [{ type: "text", text }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.exchanges[0].text).toBe(text);
    expect(result.exchanges[0].text).not.toContain("...");
  });

  it("extracts text from TextPart — not from non-text parts", () => {
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [
          { type: "tool_call" }, // non-text part — should be ignored
          { type: "text", text: "The real answer" },
        ],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.exchanges[0].text).toBe("The real answer");
  });

  it("handles assistant message with no text part — returns empty text", () => {
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [{ type: "tool_call" }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0]).toEqual({ role: "assistant", text: "" });
    expect(result.tokensUsed).toBe(100);
  });

  it("handles missing cache in tokens gracefully", () => {
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 750 } }, // no cache field
        parts: [{ type: "text", text: "No cache tokens" }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.tokensUsed).toBe(750);
  });

  it("handles user message with no text part — returns empty text", () => {
    const messages: MockMessage[] = [
      {
        info: { role: "user" },
        parts: [{ type: "file" }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0]).toEqual({ role: "user", text: "" });
  });

  it("only non-summary messages count toward the 6-message limit", () => {
    const messages: MockMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Old question" }] },
      {
        info: { role: "assistant", summary: true, tokens: { input: 9999 } },
        parts: [{ type: "text", text: "Summary" }],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "Q1" }] },
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [{ type: "text", text: "A1" }],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "Q2" }] },
      {
        info: { role: "assistant", tokens: { input: 200 } },
        parts: [{ type: "text", text: "A2" }],
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "Q3" }] },
      {
        info: { role: "assistant", tokens: { input: 300 } },
        parts: [{ type: "text", text: "A3" }],
      },
    ];
    const result = extractSessionHistory(messages);
    // 7 non-summary messages → last 6: Q1, A1, Q2, A2, Q3, A3
    // (Old question is trimmed; Summary is excluded entirely)
    expect(result.exchanges).toHaveLength(6);
    expect(result.exchanges[0]).toEqual({ role: "user", text: "Q1" });
    expect(result.exchanges[5]).toEqual({ role: "assistant", text: "A3" });
    expect(result.tokensUsed).toBe(300); // last assistant = A3
  });
});
