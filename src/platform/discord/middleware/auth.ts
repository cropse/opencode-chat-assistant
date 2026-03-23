import { ChannelType } from "discord.js";
import type { Message } from "discord.js";
import { config } from "../../../config.js";
import { logger } from "../../../utils/logger.js";

/** Current session operator (Discord user ID). Null = no active operator. */
let currentOperatorId: string | null = null;

/**
 * Check if a Discord message author is authorized to use the bot.
 * - Guild message: user must have at least one role from config.discord.allowedRoleIds
 * - DM message: user ID must be in config.discord.allowedUserIds
 */
export function isAuthorizedDiscordUser(message: Message): boolean {
  const isDM = message.channel.type === ChannelType.DM;

  if (isDM) {
    const userId = parseInt(message.author.id, 10);
    const allowed = config.discord.allowedUserIds.includes(userId);
    if (!allowed) {
      logger.warn(`[Discord Auth] Unauthorized DM from user ${message.author.id}`);
    }
    return allowed;
  }

  // Guild message: check role
  const member = message.member;
  if (!member) return false;

  if (config.discord.allowedRoleIds.length === 0) {
    // If no roles configured, deny all guild users
    return false;
  }

  const hasRole = config.discord.allowedRoleIds.some((roleId) => member.roles.cache.has(roleId));
  if (!hasRole) {
    logger.warn(`[Discord Auth] Unauthorized guild message from user ${message.author.id}`);
  }
  return hasRole;
}

/** Get the current session operator's Discord user ID */
export function getSessionOwner(): string | null {
  return currentOperatorId;
}

/** Set the session operator (when they start working) */
export function setSessionOwner(userId: string): void {
  currentOperatorId = userId;
  logger.debug(`[Discord Auth] Session owner set to ${userId}`);
}

/** Clear the session operator (when session goes idle) */
export function clearSessionOwner(): void {
  currentOperatorId = null;
  logger.debug("[Discord Auth] Session owner cleared");
}

/** Check if a user is the current session operator */
export function isSessionOwner(userId: string): boolean {
  return currentOperatorId === userId;
}

/** Reset session state for testing */
export function __resetSessionOwnerForTests(): void {
  currentOperatorId = null;
}
