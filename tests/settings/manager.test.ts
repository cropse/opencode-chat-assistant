import { describe, expect, it, afterEach } from "vitest";
import {
  getActiveSessionsMap,
  setActiveSessionsMap,
  clearActiveSessions,
  __resetSettingsForTests,
  SessionInfo,
} from "../../src/settings/manager.js";

describe("settings/manager", () => {
  afterEach(() => {
    __resetSettingsForTests();
  });

  describe("activeSessions persistence", () => {
    it("returns empty map by default", () => {
      const map = getActiveSessionsMap();
      expect(map).toEqual({});
    });

    it("stores and retrieves active sessions map", () => {
      const sessions: Record<string, SessionInfo> = {
        "session-1": {
          id: "session-1",
          title: "My Session 1",
          directory: "/path/to/session1",
        },
        "session-2": {
          id: "session-2",
          title: "My Session 2",
          directory: "/path/to/session2",
        },
      };

      setActiveSessionsMap(sessions);
      const retrieved = getActiveSessionsMap();

      expect(retrieved).toEqual(sessions);
      expect(retrieved).toBe(sessions);
    });

    it("clears active sessions", () => {
      const sessions: Record<string, SessionInfo> = {
        "session-1": {
          id: "session-1",
          title: "My Session 1",
          directory: "/path/to/session1",
        },
      };

      setActiveSessionsMap(sessions);
      expect(getActiveSessionsMap()).toEqual(sessions);

      clearActiveSessions();
      expect(getActiveSessionsMap()).toEqual({});
    });

    it("overwrites previous active sessions when setting new map", () => {
      const sessions1: Record<string, SessionInfo> = {
        "session-1": {
          id: "session-1",
          title: "Session 1",
          directory: "/path/1",
        },
      };

      setActiveSessionsMap(sessions1);
      expect(getActiveSessionsMap()).toEqual(sessions1);

      const sessions2: Record<string, SessionInfo> = {
        "session-2": {
          id: "session-2",
          title: "Session 2",
          directory: "/path/2",
        },
      };

      setActiveSessionsMap(sessions2);
      expect(getActiveSessionsMap()).toEqual(sessions2);
    });
  });
});
