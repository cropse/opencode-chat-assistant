import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { getRuntimePaths, type RuntimePaths } from "./paths.js";
import {
  getLocale,
  getLocaleOptions,
  resolveSupportedLocale,
  setRuntimeLocale,
  t,
  type Locale,
} from "../i18n/index.js";

const DEFAULT_API_URL = "http://localhost:4096";
const DEFAULT_SERVER_USERNAME = "opencode";

interface EnvValidationResult {
  isValid: boolean;
  reason?: string;
}

interface WizardCollectedValues {
  locale: Locale;
  token: string;
  allowedUserId: string;
  apiUrl?: string;
  serverUsername: string;
  serverPassword?: string;
}

export interface WizardConfigValues {
  telegram: {
    token: string;
    allowedUserId: string;
  };
  opencode?: {
    apiUrl?: string;
    username: string;
    password?: string;
  };
  bot?: {
    locale: Locale;
  };
}

function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateRuntimeConfigValues(values: Record<string, unknown>): EnvValidationResult {
  const platform = values?.platform ? String(values.platform).trim().toLowerCase() : "telegram";

  if (platform === "discord") {
    // Discord mode: validate discord config instead of telegram
    const discord = values?.discord as Record<string, unknown> | undefined;
    if (!discord?.token || String(discord.token).trim().length === 0) {
      return { isValid: false, reason: "Missing discord.token" };
    }
  } else {
    // Telegram mode: validate telegram config
    const telegram = values?.telegram as Record<string, unknown> | undefined;

    if (!telegram?.token || String(telegram.token).trim().length === 0) {
      return { isValid: false, reason: "Missing telegram.token" };
    }

    const userId = telegram?.allowedUserId;
    if (userId === undefined || userId === null) {
      return { isValid: false, reason: "Missing telegram.allowedUserId" };
    }
    // Accept both number and string
    if (typeof userId === "number") {
      if (!Number.isInteger(userId) || userId <= 0) {
        return { isValid: false, reason: "Invalid telegram.allowedUserId" };
      }
    } else if (!isPositiveInteger(String(userId))) {
      return { isValid: false, reason: "Invalid telegram.allowedUserId" };
    }
  }

  const opencode = values?.opencode as Record<string, unknown> | undefined;
  const apiUrl = opencode?.apiUrl ? String(opencode.apiUrl).trim() : undefined;
  if (apiUrl && !isValidHttpUrl(apiUrl)) {
    return { isValid: false, reason: "Invalid opencode.apiUrl" };
  }

  return { isValid: true };
}

export function buildConfigYamlContent(values: WizardConfigValues): string {
  // Build a clean config object (only include non-empty values)
  const configObj: Record<string, unknown> = {};

  // telegram section (always present)
  configObj.telegram = {
    token: values.telegram.token,
    allowedUserId: parseInt(values.telegram.allowedUserId, 10),
  };

  // opencode section
  const opencode: Record<string, unknown> = {};
  if (values.opencode?.apiUrl) opencode.apiUrl = values.opencode.apiUrl;
  if (values.opencode?.username && values.opencode.username !== "opencode") {
    opencode.username = values.opencode.username;
  }
  if (values.opencode?.password) opencode.password = values.opencode.password;
  if (Object.keys(opencode).length > 0) configObj.opencode = opencode;

  // bot section
  if (values.bot?.locale && values.bot.locale !== "en") {
    configObj.bot = { locale: values.bot.locale };
  }

  return stringifyYaml(configObj, { lineWidth: 0 });
}

async function readConfigFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tempFilePath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempFilePath, content, "utf-8");
  await fs.rename(tempFilePath, filePath);
}

async function ensureSettingsFile(settingsFilePath: string): Promise<void> {
  try {
    await fs.access(settingsFilePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
  await fs.writeFile(settingsFilePath, "{}\n", "utf-8");
}

async function askVisible(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const maskedRl = rl as readline.Interface & {
      stdoutMuted?: boolean;
      _writeToOutput?: (value: string) => void;
    };

    maskedRl._writeToOutput = (value: string): void => {
      if (maskedRl.stdoutMuted) {
        if (value.includes("\n") || value.includes("\r")) {
          process.stdout.write(value);
          return;
        }

        if (value.length > 0) {
          process.stdout.write("*");
        }
        return;
      }

      process.stdout.write(value);
    };

    maskedRl.stdoutMuted = false;

    rl.question(question, (answer) => {
      maskedRl.stdoutMuted = false;
      process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });

    maskedRl.stdoutMuted = true;
  });
}

async function askToken(): Promise<string> {
  for (;;) {
    const token = await askHidden(t("runtime.wizard.ask_token"));

    if (!token) {
      process.stdout.write(t("runtime.wizard.token_required"));
      continue;
    }

    if (!token.includes(":")) {
      process.stdout.write(t("runtime.wizard.token_invalid"));
      continue;
    }

    return token;
  }
}

async function askLocale(): Promise<Locale> {
  const localeOptions = getLocaleOptions();
  const defaultLocale = getLocale();
  const defaultLocaleOption =
    localeOptions.find((localeOption) => localeOption.code === defaultLocale) ?? localeOptions[0];
  const optionsText = localeOptions
    .map((localeOption, index) => `${index + 1} - ${localeOption.label} (${localeOption.code})`)
    .join("\n");

  const prompt = t("runtime.wizard.ask_language", {
    options: optionsText,
    defaultLocale: `${defaultLocaleOption.label} (${defaultLocaleOption.code})`,
  });

  for (;;) {
    const answer = await askVisible(prompt);

    if (!answer) {
      return defaultLocaleOption.code;
    }

    if (/^\d+$/.test(answer)) {
      const index = Number.parseInt(answer, 10) - 1;
      if (index >= 0 && index < localeOptions.length) {
        return localeOptions[index].code;
      }
    }

    const localeByCode = resolveSupportedLocale(answer);
    if (localeByCode) {
      return localeByCode;
    }

    process.stdout.write(t("runtime.wizard.language_invalid"));
  }
}

async function askAllowedUserId(): Promise<string> {
  for (;;) {
    const allowedUserId = await askVisible(t("runtime.wizard.ask_user_id"));

    if (!isPositiveInteger(allowedUserId)) {
      process.stdout.write(t("runtime.wizard.user_id_invalid"));
      continue;
    }

    return allowedUserId;
  }
}

async function askApiUrl(): Promise<string | undefined> {
  const prompt = t("runtime.wizard.ask_api_url", { defaultUrl: DEFAULT_API_URL });

  for (;;) {
    const apiUrl = await askVisible(prompt);

    if (!apiUrl) {
      return undefined;
    }

    if (!isValidHttpUrl(apiUrl)) {
      process.stdout.write(t("runtime.wizard.api_url_invalid"));
      continue;
    }

    return apiUrl;
  }
}

async function askServerUsername(): Promise<string> {
  const prompt = t("runtime.wizard.ask_server_username", {
    defaultUsername: DEFAULT_SERVER_USERNAME,
  });

  const username = await askVisible(prompt);
  if (!username) {
    return DEFAULT_SERVER_USERNAME;
  }

  return username;
}

async function askServerPassword(): Promise<string | undefined> {
  const password = await askHidden(t("runtime.wizard.ask_server_password"));
  if (!password) {
    return undefined;
  }

  return password;
}

async function collectWizardValues(): Promise<WizardCollectedValues> {
  const locale = await askLocale();
  setRuntimeLocale(locale);
  const selectedLocaleOption =
    getLocaleOptions().find((localeOption) => localeOption.code === locale) ?? null;

  process.stdout.write("\n");
  process.stdout.write(
    t("runtime.wizard.language_selected", {
      language:
        selectedLocaleOption !== null
          ? `${selectedLocaleOption.label} (${selectedLocaleOption.code})`
          : locale,
    }),
  );
  process.stdout.write("\n");
  process.stdout.write(t("runtime.wizard.start"));
  process.stdout.write("\n");

  const token = await askToken();
  const allowedUserId = await askAllowedUserId();
  const apiUrl = await askApiUrl();
  const serverUsername = await askServerUsername();
  const serverPassword = await askServerPassword();

  process.stdout.write("\n");

  return {
    locale,
    token,
    allowedUserId,
    apiUrl,
    serverUsername,
    serverPassword,
  };
}

function ensureInteractiveTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(t("runtime.wizard.tty_required"));
  }
}

function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)/);
    if (!match) continue;
    let value = match[2];
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

async function migrateEnvToYaml(envFilePath: string, configFilePath: string): Promise<boolean> {
  const envContent = await readConfigFileIfExists(envFilePath);
  if (envContent === null) {
    return false;
  }

  // Parse .env manually (simple KEY=VALUE parser, no dotenv dependency)
  const envValues = parseEnvContent(envContent);

  // Map flat env keys to nested YAML structure
  const configObj: Record<string, Record<string, unknown>> = {};

  // telegram section
  const telegram: Record<string, unknown> = {};
  if (envValues.TELEGRAM_BOT_TOKEN) telegram.token = envValues.TELEGRAM_BOT_TOKEN;
  if (envValues.TELEGRAM_ALLOWED_USER_ID) {
    const parsed = parseInt(envValues.TELEGRAM_ALLOWED_USER_ID, 10);
    telegram.allowedUserId = Number.isNaN(parsed) ? envValues.TELEGRAM_ALLOWED_USER_ID : parsed;
  }
  if (envValues.TELEGRAM_PROXY_URL) telegram.proxyUrl = envValues.TELEGRAM_PROXY_URL;
  if (Object.keys(telegram).length > 0) configObj.telegram = telegram;

  // opencode section
  const opencode: Record<string, unknown> = {};
  if (envValues.OPENCODE_API_URL) opencode.apiUrl = envValues.OPENCODE_API_URL;
  if (envValues.OPENCODE_SERVER_USERNAME) opencode.username = envValues.OPENCODE_SERVER_USERNAME;
  if (envValues.OPENCODE_SERVER_PASSWORD) opencode.password = envValues.OPENCODE_SERVER_PASSWORD;
  if (Object.keys(opencode).length > 0) configObj.opencode = opencode;

  // server section
  const server: Record<string, unknown> = {};
  if (envValues.LOG_LEVEL) server.logLevel = envValues.LOG_LEVEL;
  if (Object.keys(server).length > 0) configObj.server = server;

  // bot section
  const bot: Record<string, unknown> = {};
  if (envValues.BOT_LOCALE) bot.locale = envValues.BOT_LOCALE;
  if (envValues.SESSIONS_LIST_LIMIT)
    bot.sessionsListLimit = parseInt(envValues.SESSIONS_LIST_LIMIT, 10);
  if (envValues.PROJECTS_LIST_LIMIT)
    bot.projectsListLimit = parseInt(envValues.PROJECTS_LIST_LIMIT, 10);
  if (envValues.MODELS_LIST_LIMIT) bot.modelsListLimit = parseInt(envValues.MODELS_LIST_LIMIT, 10);
  if (envValues.SERVICE_MESSAGES_INTERVAL_SEC)
    bot.serviceMessagesIntervalSec = parseInt(envValues.SERVICE_MESSAGES_INTERVAL_SEC, 10);
  if (envValues.HIDE_THINKING_MESSAGES)
    bot.hideThinkingMessages =
      envValues.HIDE_THINKING_MESSAGES.toLowerCase() === "true" ||
      envValues.HIDE_THINKING_MESSAGES === "1";
  if (envValues.HIDE_TOOL_CALL_MESSAGES)
    bot.hideToolCallMessages =
      envValues.HIDE_TOOL_CALL_MESSAGES.toLowerCase() === "true" ||
      envValues.HIDE_TOOL_CALL_MESSAGES === "1";
  if (envValues.MESSAGE_FORMAT_MODE) bot.messageFormatMode = envValues.MESSAGE_FORMAT_MODE;
  if (Object.keys(bot).length > 0) configObj.bot = bot;

  // files section
  const files: Record<string, unknown> = {};
  if (envValues.CODE_FILE_MAX_SIZE_KB)
    files.maxFileSizeKb = parseInt(envValues.CODE_FILE_MAX_SIZE_KB, 10);
  if (Object.keys(files).length > 0) configObj.files = files;

  // stt section
  const stt: Record<string, unknown> = {};
  if (envValues.STT_API_URL) stt.apiUrl = envValues.STT_API_URL;
  if (envValues.STT_API_KEY) stt.apiKey = envValues.STT_API_KEY;
  if (envValues.STT_MODEL) stt.model = envValues.STT_MODEL;
  if (envValues.STT_LANGUAGE) stt.language = envValues.STT_LANGUAGE;
  if (Object.keys(stt).length > 0) configObj.stt = stt;

  // Write config.yaml
  const yamlContent = stringifyYaml(configObj, { lineWidth: 0 });
  await writeFileAtomically(configFilePath, yamlContent);

  // Rename .env to .env.bak
  await fs.rename(envFilePath, `${envFilePath}.bak`);

  return true;
}

async function validateExistingConfig(configFilePath: string): Promise<EnvValidationResult> {
  const content = await readConfigFileIfExists(configFilePath);
  if (content === null) {
    return { isValid: false, reason: "Missing config.yaml" };
  }

  try {
    const parsed = parseYaml(content) as Record<string, unknown>;
    return validateRuntimeConfigValues(parsed);
  } catch {
    return { isValid: false, reason: "Invalid YAML syntax" };
  }
}

async function runWizardAndPersist(runtimePaths: RuntimePaths): Promise<void> {
  ensureInteractiveTty();
  const wizardValues = await collectWizardValues();

  const configValues: WizardConfigValues = {
    telegram: {
      token: wizardValues.token,
      allowedUserId: wizardValues.allowedUserId,
    },
    opencode: {
      apiUrl: wizardValues.apiUrl,
      username: wizardValues.serverUsername,
      password: wizardValues.serverPassword,
    },
    bot: {
      locale: wizardValues.locale,
    },
  };

  const yamlContent = buildConfigYamlContent(configValues);
  await writeFileAtomically(runtimePaths.configFilePath, yamlContent);
  await ensureSettingsFile(runtimePaths.settingsFilePath);

  process.stdout.write(
    t("runtime.wizard.saved", {
      configPath: runtimePaths.configFilePath,
      settingsPath: runtimePaths.settingsFilePath,
    }),
  );
}

export async function ensureRuntimeConfigForStart(): Promise<void> {
  const runtimePaths = getRuntimePaths();

  // Auto-migrate .env → config.yaml if needed
  const envFilePath = path.join(runtimePaths.appHome, ".env");
  const migrated = await migrateEnvToYaml(envFilePath, runtimePaths.configFilePath);
  if (migrated) {
    // Use a simple console.log here since logger may not be initialized yet
    // Actually, we can't use console.log due to eslint rules. Just proceed silently.
    // The info will be logged at app startup.
  }

  const validationResult = await validateExistingConfig(runtimePaths.configFilePath);
  if (validationResult.isValid) {
    await ensureSettingsFile(runtimePaths.settingsFilePath);
    return;
  }

  process.stdout.write(t("runtime.wizard.not_configured_starting"));
  await runWizardAndPersist(runtimePaths);
}

export async function runConfigWizardCommand(): Promise<void> {
  const runtimePaths = getRuntimePaths();
  await runWizardAndPersist(runtimePaths);
}
