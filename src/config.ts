import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getRuntimePaths } from "./runtime/paths.js";
import { normalizeLocale, setRuntimeLocale, type Locale } from "./i18n/index.js";

const runtimePaths = getRuntimePaths();

export type Platform = "telegram" | "discord";

function parseCommaSeparatedNumbers(value: string): number[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

export type MessageFormatMode = "raw" | "markdown";

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce((acc: unknown, part: string) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

function getStringValue(
  raw: Record<string, unknown>,
  key: string,
  required: boolean = true,
): string {
  const value = getNestedValue(raw, key);
  if (required && (value === undefined || value === null || value === "")) {
    throw new Error(
      `Missing required configuration: ${key} (expected in ${runtimePaths.configFilePath})`,
    );
  }
  return value !== undefined && value !== null ? String(value) : "";
}

function getOptionalPositiveIntValue(
  raw: Record<string, unknown>,
  key: string,
  defaultValue: number,
): number {
  const value = getNestedValue(raw, key);
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const parsedValue = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    return defaultValue;
  }

  return parsedValue;
}

function getOptionalNonNegativeIntValue(
  raw: Record<string, unknown>,
  key: string,
  defaultValue: number,
): number {
  const value = getNestedValue(raw, key);
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const parsedValue = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (Number.isNaN(parsedValue) || parsedValue < 0) {
    return defaultValue;
  }

  return parsedValue;
}

function getOptionalLocaleValue(
  raw: Record<string, unknown>,
  key: string,
  defaultValue: Locale,
): Locale {
  const value = getNestedValue(raw, key);
  return normalizeLocale(
    value !== undefined && value !== null ? String(value) : null,
    defaultValue,
  );
}

function getOptionalBooleanValue(
  raw: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
): boolean {
  const value = getNestedValue(raw, key);
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function getOptionalMessageFormatModeValue(
  raw: Record<string, unknown>,
  key: string,
  defaultValue: MessageFormatMode,
): MessageFormatMode {
  const value = getNestedValue(raw, key);
  if (value === undefined || value === null) {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "raw" || normalized === "markdown") {
    return normalized as MessageFormatMode;
  }

  return defaultValue;
}

export function buildConfig(raw: Record<string, unknown>) {
  const platform: Platform =
    (getStringValue(raw, "platform", false).toLowerCase() as Platform) || "telegram";

  // When platform is discord, telegram fields are optional
  const telegramRequired = platform === "telegram";

  return {
    platform,
    telegram: {
      token: getStringValue(raw, "telegram.token", telegramRequired),
      allowedUserId: parseInt(getStringValue(raw, "telegram.allowedUserId", telegramRequired), 10),
      proxyUrl: getStringValue(raw, "telegram.proxyUrl", false),
    },
    opencode: {
      apiUrl: getStringValue(raw, "opencode.apiUrl", false) || "http://localhost:4096",
      username: getStringValue(raw, "opencode.username", false) || "opencode",
      password: getStringValue(raw, "opencode.password", false),
    },
    server: {
      logLevel: getStringValue(raw, "server.logLevel", false) || "info",
    },
    bot: {
      sessionsListLimit: getOptionalPositiveIntValue(raw, "bot.sessionsListLimit", 10),
      projectsListLimit: getOptionalPositiveIntValue(raw, "bot.projectsListLimit", 10),
      modelsListLimit: getOptionalPositiveIntValue(raw, "bot.modelsListLimit", 10),
      locale: getOptionalLocaleValue(raw, "bot.locale", "en"),
      serviceMessagesIntervalSec: getOptionalNonNegativeIntValue(
        raw,
        "bot.serviceMessagesIntervalSec",
        5,
      ),
      hideThinkingMessages: getOptionalBooleanValue(raw, "bot.hideThinkingMessages", false),
      hideToolCallMessages: getOptionalBooleanValue(raw, "bot.hideToolCallMessages", false),
      messageFormatMode: getOptionalMessageFormatModeValue(
        raw,
        "bot.messageFormatMode",
        "markdown",
      ),
    },
    files: {
      maxFileSizeKb: getOptionalPositiveIntValue(raw, "files.maxFileSizeKb", 100),
    },
    stt: {
      apiUrl: getStringValue(raw, "stt.apiUrl", false),
      apiKey: getStringValue(raw, "stt.apiKey", false),
      model: getStringValue(raw, "stt.model", false) || "whisper-large-v3-turbo",
      language: getStringValue(raw, "stt.language", false),
    },
    discord: {
      token: getStringValue(raw, "discord.token", false),
      guildId: getStringValue(raw, "discord.guildId", false),
      channelId: getStringValue(raw, "discord.channelId", false),
      allowedRoleIds: (() => {
        const roleIdsRaw = getStringValue(raw, "discord.allowedRoleIds", false);
        return roleIdsRaw
          ? roleIdsRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      })(),
      allowedUserIds: (() => {
        const userIdsRaw = getStringValue(raw, "discord.allowedUserIds", false);
        return userIdsRaw ? parseCommaSeparatedNumbers(userIdsRaw) : [];
      })(),
    },
  };
}

let rawConfig: Record<string, unknown> = {};
try {
  const fileContent = readFileSync(runtimePaths.configFilePath, "utf-8");
  rawConfig = (parseYaml(fileContent) as Record<string, unknown>) || {};
} catch {
  // Ignore file not found, rawConfig remains {}
}

export const config = buildConfig(rawConfig);

setRuntimeLocale(config.bot.locale);
