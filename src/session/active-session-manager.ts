/**
 * ActiveSessionManager - LRU pool for tracking active sessions.
 *
 * Manages a bounded pool of sessions using LRU (Least Recently Used) eviction.
 * Map preserves insertion order in JavaScript - first entry is oldest, last is newest.
 *
 * On activate(): delete-then-insert to move session to end (most recent).
 * On eviction: when size > maxActiveSessions, delete first entry (oldest).
 */

import type { SessionInfo } from "./manager.js";

const DEFAULT_MAX_ACTIVE_SESSIONS = 10;

/**
 * Manages active sessions with LRU eviction policy.
 * In-memory only - does not persist to disk.
 */
class ActiveSessionManager {
  private sessions: Map<string, SessionInfo> = new Map();
  private maxSessions: number;
  public onEvict: ((session: SessionInfo) => void) | null = null;

  constructor(maxActiveSessions: number = DEFAULT_MAX_ACTIVE_SESSIONS) {
    this.maxSessions = maxActiveSessions;
  }

  /**
   * Add or touch a session, moving it to most-recent position.
   * If pool exceeds limit, evicts the oldest (least recently used) session.
   */
  activate(session: SessionInfo): void {
    // Delete first if exists (touch/re-activate), then insert at end
    const existed = this.sessions.has(session.id);
    this.sessions.delete(session.id);
    this.sessions.set(session.id, session);

    // Only evict if we're adding a NEW session and exceeded limit
    if (!existed && this.sessions.size > this.maxSessions) {
      // First entry is oldest (Map preserves insertion order)
      const oldest = this.sessions.keys().next().value;
      if (oldest) {
        const evictedSession = this.sessions.get(oldest);
        this.sessions.delete(oldest);
        if (evictedSession && this.onEvict) {
          this.onEvict(evictedSession);
        }
      }
    }
  }

  /**
   * Remove a specific session from the pool.
   */
  deactivate(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Check if a session is in the active pool.
   */
  isActive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get all active sessions, most-recently-activated first.
   */
  getActiveSessions(): SessionInfo[] {
    // Convert to array, reverse to get most-recent first
    return Array.from(this.sessions.values()).reverse();
  }

  /**
   * Get the current count of active sessions.
   */
  getCount(): number {
    return this.sessions.size;
  }

  /**
   * Remove all sessions from the pool.
   */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Reset state for tests. Clears all sessions, resets onEvict, and optionally changes limit.
   */
  reset(maxActiveSessions?: number): void {
    this.sessions.clear();
    this.onEvict = null;
    if (maxActiveSessions !== undefined) {
      this.maxSessions = maxActiveSessions;
    } else {
      this.maxSessions = DEFAULT_MAX_ACTIVE_SESSIONS;
    }
  }
}

import { config } from "../config.js";

export const activeSessionManager = new ActiveSessionManager(
  config?.bot?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS,
);
