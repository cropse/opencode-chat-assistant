import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { SkillInfo } from "./types.js";

const getAuth = () => {
  if (!config.opencode.password) {
    return undefined;
  }
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

/**
 * Get list of available skills from OpenCode API
 * @param directory Optional project directory
 * @returns Array of available skills
 */
export async function getAvailableSkills(directory?: string): Promise<SkillInfo[]> {
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
      logger.error(
        `[SkillManager] Failed to fetch skills: ${response.status} ${response.statusText}`,
      );
      return [];
    }

    const skills = (await response.json()) as SkillInfo[];
    logger.debug(`[SkillManager] Fetched ${skills.length} available skills`);
    return skills;
  } catch (err) {
    logger.error("[SkillManager] Error fetching skills:", err);
    return [];
  }
}
