import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SessionInfo } from "../../src/session/manager.js";

// We'll import after we create the module - for now tests will fail
// which is exactly what we want in TDD red phase

describe("ActiveSessionManager", () => {
  // Helper to create test sessions
  const createSession = (id: string, title = `Session ${id}`): SessionInfo => ({
    id,
    title,
    directory: `/tmp/sessions/${id}`,
  });

  describe("activate()", () => {
    it("should add session to pool", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      const session = createSession("session-1");
      activeSessionManager.activate(session);

      expect(activeSessionManager.isActive("session-1")).toBe(true);
      expect(activeSessionManager.getCount()).toBe(1);
    });

    it("should re-activate (touch) existing session - moves it to front", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      const sessionA = createSession("session-a");
      const sessionB = createSession("session-b");
      const sessionC = createSession("session-c");

      activeSessionManager.activate(sessionA);
      activeSessionManager.activate(sessionB);
      activeSessionManager.activate(sessionC);

      // Now re-activate A - it should move to the front
      activeSessionManager.activate(sessionA);

      const sessions = activeSessionManager.getActiveSessions();
      expect(sessions).toHaveLength(3);
      // Order should be B, C, A (most recently used first)
      expect(sessions[0].id).toBe("session-a"); // A was touched last
      expect(sessions[1].id).toBe("session-c");
      expect(sessions[2].id).toBe("session-b");
    });
  });

  describe("isActive()", () => {
    it("should return true for added session", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      const session = createSession("active-session");
      activeSessionManager.activate(session);

      expect(activeSessionManager.isActive("active-session")).toBe(true);
    });

    it("should return false for unknown session", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      expect(activeSessionManager.isActive("unknown-session")).toBe(false);
    });
  });

  describe("getActiveSessions()", () => {
    it("should return most-recently-activated first", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      const sessionA = createSession("first");
      const sessionB = createSession("second");
      const sessionC = createSession("third");

      activeSessionManager.activate(sessionA);
      activeSessionManager.activate(sessionB);
      activeSessionManager.activate(sessionC);

      const sessions = activeSessionManager.getActiveSessions();
      expect(sessions).toHaveLength(3);
      // Most recently activated first
      expect(sessions[0].id).toBe("third");
      expect(sessions[1].id).toBe("second");
      expect(sessions[2].id).toBe("first");
    });

    it("should return empty array when no sessions", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      const sessions = activeSessionManager.getActiveSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe("LRU eviction", () => {
    it("should evict oldest session when limit exceeded", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(2);

      const sessionA = createSession("a");
      const sessionB = createSession("b");
      const sessionC = createSession("c");

      activeSessionManager.activate(sessionA);
      activeSessionManager.activate(sessionB);
      activeSessionManager.activate(sessionC); // Should evict A

      expect(activeSessionManager.isActive("a")).toBe(false);
      expect(activeSessionManager.isActive("b")).toBe(true);
      expect(activeSessionManager.isActive("c")).toBe(true);
      expect(activeSessionManager.getCount()).toBe(2);
    });

    it("should fire onEvict callback with evicted session", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(2);

      const evictedSessions: SessionInfo[] = [];
      activeSessionManager.onEvict = (session: SessionInfo) => {
        evictedSessions.push(session);
      };

      const sessionA = createSession("a");
      const sessionB = createSession("b");
      const sessionC = createSession("c");

      activeSessionManager.activate(sessionA);
      activeSessionManager.activate(sessionB);
      activeSessionManager.activate(sessionC); // Evicts A

      expect(evictedSessions).toHaveLength(1);
      expect(evictedSessions[0].id).toBe("a");
    });

    it("should not evict when re-activating existing session", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(2);

      const evictedSessions: SessionInfo[] = [];
      activeSessionManager.onEvict = (session: SessionInfo) => {
        evictedSessions.push(session);
      };

      const sessionA = createSession("a");
      const sessionB = createSession("b");

      activeSessionManager.activate(sessionA);
      activeSessionManager.activate(sessionB);
      // Re-activate A (touches it, no eviction)
      activeSessionManager.activate(sessionA);

      expect(evictedSessions).toHaveLength(0);
      expect(activeSessionManager.getCount()).toBe(2);
    });
  });

  describe("deactivate()", () => {
    it("should remove specific session", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      const sessionA = createSession("a");
      const sessionB = createSession("b");

      activeSessionManager.activate(sessionA);
      activeSessionManager.activate(sessionB);
      activeSessionManager.deactivate("a");

      expect(activeSessionManager.isActive("a")).toBe(false);
      expect(activeSessionManager.isActive("b")).toBe(true);
      expect(activeSessionManager.getCount()).toBe(1);
    });

    it("should be idempotent - deactivating non-existent session does nothing", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      const sessionA = createSession("a");
      activeSessionManager.activate(sessionA);

      // Should not throw
      expect(() => activeSessionManager.deactivate("non-existent")).not.toThrow();
      expect(activeSessionManager.getCount()).toBe(1);
    });
  });

  describe("getCount()", () => {
    it("should return correct count after operations", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      expect(activeSessionManager.getCount()).toBe(0);

      activeSessionManager.activate(createSession("a"));
      expect(activeSessionManager.getCount()).toBe(1);

      activeSessionManager.activate(createSession("b"));
      expect(activeSessionManager.getCount()).toBe(2);

      activeSessionManager.deactivate("a");
      expect(activeSessionManager.getCount()).toBe(1);
    });
  });

  describe("clear()", () => {
    it("should remove all sessions", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      activeSessionManager.activate(createSession("a"));
      activeSessionManager.activate(createSession("b"));
      activeSessionManager.activate(createSession("c"));

      activeSessionManager.clear();

      expect(activeSessionManager.getCount()).toBe(0);
      expect(activeSessionManager.getActiveSessions()).toEqual([]);
    });
  });

  describe("reset()", () => {
    it("should clear all state and optionally change limit", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(5);

      activeSessionManager.activate(createSession("a"));
      activeSessionManager.activate(createSession("b"));

      activeSessionManager.reset(2);

      expect(activeSessionManager.getCount()).toBe(0);
    });

    it("should use default limit when not specified", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");

      // Reset without parameter should use default (10)
      activeSessionManager.reset();

      // Fill up to 10 - no eviction should occur
      for (let i = 0; i < 10; i++) {
        activeSessionManager.activate(createSession(`session-${i}`));
      }

      expect(activeSessionManager.getCount()).toBe(10);

      // Add one more - should trigger eviction
      activeSessionManager.activate(createSession("session-10"));
      expect(activeSessionManager.getCount()).toBe(10);
      expect(activeSessionManager.isActive("session-0")).toBe(false);
    });
  });

  describe("onEvict callback", () => {
    it("should be null by default", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(10);

      expect(activeSessionManager.onEvict).toBeNull();
    });

    it("should be callable when set", async () => {
      const { activeSessionManager } = await import("../../src/session/active-session-manager.js");
      activeSessionManager.reset(1);

      const callback = vi.fn();
      activeSessionManager.onEvict = callback;

      activeSessionManager.activate(createSession("a"));
      activeSessionManager.activate(createSession("b")); // Should evict A

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    });
  });
});
