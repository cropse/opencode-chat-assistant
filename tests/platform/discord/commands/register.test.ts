import { describe, it, expect, vi, beforeEach } from "vitest";
import { REST, Routes } from "discord.js";

// Mock only REST and Routes from discord.js, use actual SlashCommandBuilder
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return {
    ...actual,
    REST: vi.fn().mockImplementation(() => ({
      setToken: vi.fn().mockReturnThis(),
      put: vi.fn().mockResolvedValue(undefined),
    })),
    Routes: {
      applicationGuildCommands: vi.fn().mockReturnValue("/guilds/123456/commands"),
    },
  };
});

// Mock config with all required fields to prevent opencode/client.ts init errors
vi.mock("../../../../src/config.js", () => ({
  config: {
    platform: "discord",
    telegram: { token: "", allowedUserId: 0, proxyUrl: "" },
    opencode: { apiUrl: "http://localhost:4096", username: "opencode", password: "" },
    server: { logLevel: "info" },
    bot: {
      sessionsListLimit: 10,
      projectsListLimit: 10,
      modelsListLimit: 10,
      locale: "en",
      serviceMessagesIntervalSec: 5,
      hideThinkingMessages: false,
      hideToolCallMessages: false,
      messageFormatMode: "markdown",
    },
    files: { maxFileSizeKb: 100 },
    stt: { apiUrl: "", apiKey: "", model: "whisper-large-v3-turbo", language: "" },
    discord: {
      token: "test-token",
      serverId: "123456",
      allowedRoleIds: [],
      allowedUserIds: [],
    },
  },
}));

describe("registerSlashCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should register 14 slash commands to guild", async () => {
    const { registerSlashCommands } =
      await import("../../../../src/platform/discord/commands/register.js");

    const mockRest = {
      setToken: vi.fn().mockReturnThis(),
      put: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(REST).mockImplementation(() => mockRest as unknown as REST);

    const clientId = "987654321";
    await registerSlashCommands(clientId);

    // Verify REST was called
    expect(mockRest.put).toHaveBeenCalledTimes(1);
    expect(mockRest.setToken).toHaveBeenCalledWith("test-token");

    // Verify 14 commands were registered
    const putCall = mockRest.put.mock.calls[0];
    expect(putCall).toBeDefined();
    const body = putCall[1] as { body: unknown };
    expect(body.body).toBeDefined();
    expect(Array.isArray(body.body)).toBe(true);
    expect((body.body as unknown[]).length).toBe(14);
  });

  it("should include all expected command names", async () => {
    const { DISCORD_COMMAND_DEFINITIONS } =
      await import("../../../../src/platform/discord/commands/definitions.js");

    const commandNames = DISCORD_COMMAND_DEFINITIONS.map((cmd) => cmd.name);

    const expectedCommands = [
      "status",
      "new",
      "abort",
      "sessions",
      "projects",
      "rename",
      "commands",
      "skills",
      "opencode_start",
      "opencode_stop",
      "help",
      "model",
      "agent",
      "variant",
    ];

    expectedCommands.forEach((name) => {
      expect(commandNames).toContain(name);
    });
  });
});
