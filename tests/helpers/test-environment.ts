import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function getDefaultTestHome(): string {
  const workerId = process.env.VITEST_WORKER_ID || "0";
  const preferredPath = path.join(process.cwd(), ".tmp", "test-home", `${process.pid}-${workerId}`);

  try {
    fs.mkdirSync(preferredPath, { recursive: true });
    return preferredPath;
  } catch {
    const fallbackPath = path.join(
      os.tmpdir(),
      "opencode-telegram-bot",
      "test-home",
      `${process.pid}-${workerId}`,
    );
    fs.mkdirSync(fallbackPath, { recursive: true });
    return fallbackPath;
  }
}

const TEST_ENV_DEFAULTS: Record<string, string> = {
  OPENCODE_TELEGRAM_HOME: getDefaultTestHome(),
};

export function ensureTestEnvironment(): void {
  for (const [key, value] of Object.entries(TEST_ENV_DEFAULTS)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  const configPath = path.join(process.env.OPENCODE_TELEGRAM_HOME!, "config.yaml");
  if (!fs.existsSync(configPath)) {
    const dummyConfig = `
telegram:
  token: "test-telegram-token"
  allowedUserId: 123456789
opencode:
  apiUrl: "http://localhost:4096"
server:
  logLevel: "error"
`;
    fs.writeFileSync(configPath, dummyConfig, "utf-8");
  }
}
