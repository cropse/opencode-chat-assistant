/**
 * Tests for session.updated event → Discord thread auto-rename.
 *
 * Verifies that when OpenCode generates a session title (session.updated event),
 * the bot auto-renames the bound Discord thread.
 *
 * Architecture:
 * - createDiscordBot() wires session.updated → adapter.renameThread()
 * - summaryAggregator.handleSessionUpdated() fires callback only when
 *   isSessionActiveCallback(sessionId) returns true
 * - isSessionActiveCallback → activeSessionManager.isActive(sessionId)
 * - So each test must: (1) reset singletons, (2) activate session in
 *   activeSessionManager, (3) fire session.updated via processEvent()
 */

import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import type { Event } from "@opencode-ai/sdk/v2";

// ─── vi.hoisted() — stable mock references across hoisting ────────────────────
// vi.hoisted() is evaluated in module-evaluation order alongside vi.mock() calls,
// so all references are stable before any mock factory runs.
// Assign to a single variable, then spread into the destructured names.

const mocks = vi.hoisted(() => ({
  mockRenameThread: vi.fn(),
  mockIsReady: vi.fn(),
  mockGetDiscordThreadForSession: vi.fn(),
  mockGetCurrentSession: vi.fn(),
  mockSetCurrentSession: vi.fn(),
}));

// ─── Discord.js ───────────────────────────────────────────────────────────────
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return {
    ...actual,
    Client: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      login: vi.fn().mockResolvedValue(undefined),
      emit: vi.fn(),
    })),
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
    },
    Partials: { Channel: "Channel" },
    Events: {
      ClientReady: "ready",
      InteractionCreate: "interactionCreate",
      MessageCreate: "messageCreate",
    },
    ChannelType: { DM: 1, GuildText: 0 },
  };
});

// ─── Discord adapter ──────────────────────────────────────────────────────────
vi.mock("../../../src/platform/discord/adapter.js", () => ({
  DiscordAdapter: vi.fn().mockImplementation(() => ({
    sendMessage: vi.fn().mockResolvedValue("msg-123"),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    setChatId: vi.fn(),
    sendDocument: vi.fn().mockResolvedValue("file-123"),
    sendEmbed: vi.fn().mockResolvedValue("embed-123"),
    renameThread: mocks.mockRenameThread,
    isReady: mocks.mockIsReady,
  })),
}));

// ─── Auth middleware ─────────────────────────────────────────────────────────
vi.mock("../../../src/platform/discord/middleware/auth.js", () => ({
  isAuthorizedDiscordUser: vi.fn().mockReturnValue(true),
  setSessionOwner: vi.fn(),
  clearSessionOwner: vi.fn(),
  getSessionOwner: vi.fn().mockReturnValue(null),
}));

// ─── Pinned manager ───────────────────────────────────────────────────────────
vi.mock("../../../src/platform/discord/pinned-manager.js", () => ({
  discordPinnedMessageManager: {
    initialize: vi.fn(),
    onSessionChanged: vi.fn().mockResolvedValue(undefined),
    onSessionIdle: vi.fn().mockResolvedValue(undefined),
    onFilesChanged: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue({ messageRef: null }),
  },
}));

// ─── Slash command registration ──────────────────────────────────────────────
vi.mock("../../../src/platform/discord/commands/register.js", () => ({
  registerSlashCommands: vi.fn().mockResolvedValue(undefined),
}));

// ─── OpenCode SSE ─────────────────────────────────────────────────────────────
vi.mock("../../../src/opencode/events.js", () => ({
  subscribeToEvents: vi.fn().mockResolvedValue(undefined),
  stopEventListening: vi.fn(),
}));

// ─── OpenCode client ──────────────────────────────────────────────────────────
vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      status: vi.fn().mockResolvedValue({ data: {} }),
      create: vi.fn().mockResolvedValue({ data: { id: "session-123", title: "Test Session" } }),
      prompt: vi.fn().mockResolvedValue({ data: {} }),
    },
  },
}));

// ─── Settings manager ─────────────────────────────────────────────────────────
vi.mock("../../../src/settings/manager.js", () => ({
  getCurrentProject: vi.fn().mockReturnValue({
    id: "project-123",
    name: "Test Project",
    worktree: "/test/project",
  }),
  getCurrentSession: mocks.mockGetCurrentSession,
  getDiscordThreadForSession: mocks.mockGetDiscordThreadForSession,
}));

// ─── Session manager ─────────────────────────────────────────────────────────
vi.mock("../../../src/session/manager.js", () => ({
  setCurrentSession: mocks.mockSetCurrentSession,
}));

// ─── Cache manager ───────────────────────────────────────────────────────────
vi.mock("../../../src/session/cache-manager.js", () => ({
  ingestSessionInfoForCache: vi.fn().mockResolvedValue(undefined),
  warmupSessionDirectoryCache: vi.fn().mockResolvedValue(undefined),
  __resetSessionDirectoryCacheForTests: vi.fn(),
}));

// ─── Interaction cleanup ─────────────────────────────────────────────────────
vi.mock("../../../src/interaction/cleanup.js", () => ({
  clearAllInteractionState: vi.fn(),
}));

// ─── Agent manager ───────────────────────────────────────────────────────────
vi.mock("../../../src/agent/manager.js", () => ({
  getStoredAgent: vi.fn().mockReturnValue("build"),
}));

// ─── Model manager ────────────────────────────────────────────────────────────
vi.mock("../../../src/model/manager.js", () => ({
  getStoredModel: vi.fn().mockReturnValue({
    providerID: "test-provider",
    modelID: "test-model",
    variant: "default",
  }),
}));

// ─── Logger ──────────────────────────────────────────────────────────────────
vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Safe background task ────────────────────────────────────────────────────
vi.mock("../../../src/utils/safe-background-task.js", () => ({
  safeBackgroundTask: vi.fn((options) => {
    options.task().catch((err: unknown) => options.onError?.(err));
  }),
}));

// ─── Error format ────────────────────────────────────────────────────────────
vi.mock("../../../src/utils/error-format.js", () => ({
  formatErrorDetails: vi.fn().mockReturnValue("mocked error details"),
}));

// ─── Imports (must come AFTER all vi.mock() calls) ────────────────────────────
import { summaryAggregator } from "../../../src/summary/aggregator.js";
import { activeSessionManager } from "../../../src/session/active-session-manager.js";
import { createDiscordBot } from "../../../src/platform/discord/bot.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Fire a session.updated event for the given session. */
const fireSessionUpdated = (sessionId: string, title: string): void => {
  summaryAggregator.processEvent({
    type: "session.updated",
    properties: {
      info: {
        id: sessionId,
        title,
        slug: title.toLowerCase().replace(/\s+/g, "-"),
        projectID: "p1",
        directory: "/test/project",
        version: "1",
        time: { created: Date.now(), updated: Date.now() },
      },
    },
  } as unknown as Event);
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("session.updated → Discord thread auto-rename", () => {
  beforeAll(async () => {
    // MUST set mock defaults BEFORE createDiscordBot() — the bot's
    // setupSummaryAggregatorCallbacks() checks adapterInstance?.isReady()
    // and exits early if falsy.
    mocks.mockIsReady.mockReturnValue(true);
    await createDiscordBot();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    // Reset aggregator buckets only
    summaryAggregator.clear();

    // Reset active session manager pool
    activeSessionManager.reset();

    // Default mock return values — MUST reset ALL to prevent cross-test contamination
    // (vi.clearAllMocks() only clears call history, not mock implementations)
    mocks.mockIsReady.mockReturnValue(true);
    mocks.mockGetCurrentSession.mockReturnValue({
      id: "session-123",
      title: "Old Title",
      directory: "/test/project",
    });
    mocks.mockGetDiscordThreadForSession.mockReturnValue("thread-abc");
  });

  // ── Case 1: renames Discord thread with correct id + title ────────────────

  it("calls adapter.renameThread() with correct threadId and new title", async () => {
    mocks.mockGetCurrentSession.mockReturnValue(null); // no current session in settings
    activeSessionManager.activate({
      id: "session-123",
      title: "Old Title",
      directory: "/test/project",
    });

    fireSessionUpdated("session-123", "New Title");

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.mockRenameThread).toHaveBeenCalledTimes(1);
    expect(mocks.mockRenameThread).toHaveBeenCalledWith("thread-abc", "New Title");
  });

  // ── Case 2: setCurrentSession called when updated session is current ──────

  it("calls setCurrentSession() when the updated session matches getCurrentSession()", async () => {
    mocks.mockGetCurrentSession.mockReturnValue({
      id: "session-123",
      title: "Old Title",
      directory: "/test/project",
    });
    activeSessionManager.activate({
      id: "session-123",
      title: "Old Title",
      directory: "/test/project",
    });

    fireSessionUpdated("session-123", "Renamed Session");

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.mockSetCurrentSession).toHaveBeenCalledTimes(1);
    expect(mocks.mockSetCurrentSession).toHaveBeenCalledWith({
      id: "session-123",
      title: "Renamed Session",
      directory: "/test/project",
    });
  });

  // ── Case 3: activeSessionManager.activate() called with updated title ──────

  it("calls activeSessionManager.activate() with updated session title", async () => {
    mocks.mockGetCurrentSession.mockReturnValue(null);
    const origActivate = activeSessionManager.activate.bind(activeSessionManager);
    const mockActivate = vi.fn((session) => origActivate(session));
    activeSessionManager.activate = mockActivate;

    activeSessionManager.activate({ id: "session-123", title: "Old", directory: "/test" });
    fireSessionUpdated("session-123", "Updated Title");

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockActivate).toHaveBeenCalledTimes(2);
    // Second call carries the new title (directory falls back to "" when getCurrentSession() returns null)
    expect(mockActivate).toHaveBeenLastCalledWith({
      id: "session-123",
      title: "Updated Title",
      directory: "",
    });

    // Restore original
    activeSessionManager.activate = origActivate;
  });

  // ── Case 4: skips rename when no Discord thread is bound ─────────────────

  it("does NOT call adapter.renameThread() when no thread is bound to session", async () => {
    mocks.mockGetDiscordThreadForSession.mockReturnValue(undefined); // no thread
    activeSessionManager.activate({ id: "session-123", title: "Old", directory: "/test" });

    fireSessionUpdated("session-123", "New Title");

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.mockRenameThread).not.toHaveBeenCalled();
    expect(mocks.mockSetCurrentSession).not.toHaveBeenCalled();
  });

  // ── Case 5: skips rename when adapter is not ready ───────────────────────

  it("does NOT call adapter.renameThread() when adapter is not ready", async () => {
    mocks.mockIsReady.mockReturnValue(false); // not ready
    activeSessionManager.activate({ id: "session-123", title: "Old", directory: "/test" });

    fireSessionUpdated("session-123", "New Title");

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.mockRenameThread).not.toHaveBeenCalled();
  });

  // ── Case 6: does NOT call setCurrentSession when session mismatch ─────────

  it("does NOT call setCurrentSession() when updated session does not match current", async () => {
    mocks.mockGetCurrentSession.mockReturnValue({
      id: "other-session", // different from "session-123"
      title: "Some Other Session",
      directory: "/other/project",
    });
    activeSessionManager.activate({ id: "session-123", title: "Old", directory: "/test" });

    fireSessionUpdated("session-123", "Renamed");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.mockSetCurrentSession).not.toHaveBeenCalled();
    // But renameThread SHOULD still be called (thread IS bound)
    expect(mocks.mockRenameThread).toHaveBeenCalledWith("thread-abc", "Renamed");
  });
});
