import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { SkillInfo } from "./types.js";

const CACHE_TTL_MS = 30_000; // 30 seconds

interface SkillCache {
  skills: SkillInfo[];
  timestamp: number;
  directory: string | undefined;
}

let skillCache: SkillCache | null = null;

const getAuth = () => {
  if (!config.opencode.password) {
    return undefined;
  }
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

/**
 * Get list of available skills from OpenCode API.
 * Results are cached for 30s to support Discord autocomplete (3s timeout).
 * @param directory Optional project directory
 * @returns Array of available skills
 */
export async function getAvailableSkills(directory?: string): Promise<SkillInfo[]> {
  const now = Date.now();
  if (
    skillCache &&
    skillCache.directory === directory &&
    now - skillCache.timestamp < CACHE_TTL_MS
  ) {
    logger.debug(`[SkillManager] Returning ${skillCache.skills.length} cached skills`);
    return skillCache.skills;
  }

  try {
    const url = new URL("/skill", config.opencode.apiUrl);
    if (directory) {
      url.searchParams.set("directory", directory);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const auth = getAuth();
    if (auth) {
      headers.Authorization = auth;
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const errorMsg = `Failed to fetch skills: ${response.status} ${response.statusText}`;
      logger.error(`[SkillManager] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const skills = (await response.json()) as SkillInfo[];
    logger.debug(`[SkillManager] Fetched ${skills.length} available skills`);

    skillCache = { skills, timestamp: now, directory };

    return skills;
  } catch (err) {
    // On error, return stale cache if available
    if (skillCache && skillCache.directory === directory) {
      logger.warn("[SkillManager] Fetch failed, returning stale cache");
      return skillCache.skills;
    }
    logger.error("[SkillManager] Error fetching skills:", err);
    throw err;
  }
}

/** Clear the skills cache (useful for tests) */
export function clearSkillCache(): void {
  skillCache = null;
}
