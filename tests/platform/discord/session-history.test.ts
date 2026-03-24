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

/**
 * Extracted pure logic from session.ts — extracting last preview and token count
 * from a list of session messages.
 */
function extractSessionHistory(messages: MockMessage[]): {
  lastMessagePreview: string;
  tokensUsed: number;
} {
  let lastMessagePreview = "";
  let tokensUsed = 0;

  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      const info = msg.info as MockAssistantInfo;
      if (!info.summary) {
        const total = (info.tokens?.input ?? 0) + (info.tokens?.cache?.read ?? 0);
        if (total > tokensUsed) tokensUsed = total;
      }
    }
  }

  const assistantMessages = messages.filter(
    (m) => m.info.role === "assistant" && !(m.info as MockAssistantInfo).summary,
  );
  const lastAssistant = assistantMessages[assistantMessages.length - 1];

  if (lastAssistant) {
    const textPart = lastAssistant.parts.find((p): p is MockTextPart => p.type === "text");
    if (textPart?.text) {
      const raw = textPart.text;
      lastMessagePreview = raw.substring(0, 200) + (raw.length > 200 ? "..." : "");
    }
  }

  return { lastMessagePreview, tokensUsed };
}

describe("extractSessionHistory", () => {
  it("returns empty preview and 0 tokens for empty messages", () => {
    const result = extractSessionHistory([]);
    expect(result.lastMessagePreview).toBe("");
    expect(result.tokensUsed).toBe(0);
  });

  it("returns 0 tokens when only user messages exist", () => {
    const messages: MockMessage[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ];
    const result = extractSessionHistory(messages);
    expect(result.tokensUsed).toBe(0);
    expect(result.lastMessagePreview).toBe("");
  });

  it("extracts tokens as input + cache.read from assistant message", () => {
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 1000, cache: { read: 500 } } },
        parts: [{ type: "text", text: "Hello!" }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.tokensUsed).toBe(1500);
  });

  it("takes peak token count across multiple assistant messages", () => {
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 500, cache: { read: 0 } } },
        parts: [{ type: "text", text: "First response" }],
      },
      {
        info: { role: "assistant", tokens: { input: 2000, cache: { read: 800 } } },
        parts: [{ type: "text", text: "Second response" }],
      },
      {
        info: { role: "assistant", tokens: { input: 1000, cache: { read: 0 } } },
        parts: [{ type: "text", text: "Third response" }],
      },
    ];
    const result = extractSessionHistory(messages);
    // Peak is second message: 2000 + 800 = 2800
    expect(result.tokensUsed).toBe(2800);
  });

  it("returns the LAST assistant message as preview, not the first", () => {
    const messages: MockMessage[] = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "Hi" }],
      },
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [{ type: "text", text: "First assistant reply" }],
      },
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "Follow-up" }],
      },
      {
        info: { role: "assistant", tokens: { input: 200 } },
        parts: [
          { type: "text", text: "Last assistant reply — this is the Greeting session response" },
        ],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.lastMessagePreview).toBe(
      "Last assistant reply — this is the Greeting session response",
    );
  });

  it("skips summary assistant messages for both tokens and preview", () => {
    const messages: MockMessage[] = [
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
    expect(result.tokensUsed).toBe(300); // not 9999
    expect(result.lastMessagePreview).toBe("Real reply"); // not summary
  });

  it("truncates long preview text to 200 chars with ellipsis", () => {
    const longText = "a".repeat(300);
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [{ type: "text", text: longText }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.lastMessagePreview).toBe("a".repeat(200) + "...");
  });

  it("does not add ellipsis for text exactly 200 chars", () => {
    const text = "b".repeat(200);
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [{ type: "text", text }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.lastMessagePreview).toBe(text);
    expect(result.lastMessagePreview).not.toContain("...");
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
    expect(result.lastMessagePreview).toBe("The real answer");
  });

  it("handles assistant message with no text part", () => {
    const messages: MockMessage[] = [
      {
        info: { role: "assistant", tokens: { input: 100 } },
        parts: [{ type: "tool_call" }],
      },
    ];
    const result = extractSessionHistory(messages);
    expect(result.lastMessagePreview).toBe("");
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
});
