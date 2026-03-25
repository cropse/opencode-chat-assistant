import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";

describe("discord config parsing", () => {
  const baseConfig = {
    telegram: { token: "test-telegram-token", allowedUserId: "123456789" },
  };

  it("parses allowedRoleIds as comma-separated string", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { allowedRoleIds: "role1,role2,role3" },
    });

    expect(config.discord.allowedRoleIds).toEqual(["role1", "role2", "role3"]);
  });

  it("parses allowedRoleIds as YAML array", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { allowedRoleIds: ["role1", "role2", "role3"] },
    });

    expect(config.discord.allowedRoleIds).toEqual(["role1", "role2", "role3"]);
  });

  it("parses allowedUserIds as comma-separated string", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { allowedUserIds: "123456789,987654321,111222333" },
    });

    expect(config.discord.allowedUserIds).toEqual([123456789, 987654321, 111222333]);
  });

  it("parses allowedUserIds as YAML array", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { allowedUserIds: [123456789, 987654321] },
    });

    expect(config.discord.allowedUserIds).toEqual([123456789, 987654321]);
  });

  it("parses allowedUserIds as YAML array of strings", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { allowedUserIds: ["123456789", "987654321"] },
    });

    expect(config.discord.allowedUserIds).toEqual([123456789, 987654321]);
  });

  it("returns empty arrays when discord fields not provided", () => {
    const config = buildConfig(baseConfig);

    expect(config.discord.allowedRoleIds).toEqual([]);
    expect(config.discord.allowedUserIds).toEqual([]);
  });

  it("filters empty strings from allowedRoleIds (comma-separated)", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { allowedRoleIds: "role1,,role2," },
    });

    expect(config.discord.allowedRoleIds).toEqual(["role1", "role2"]);
  });

  it("filters empty strings from allowedRoleIds (YAML array)", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { allowedRoleIds: ["role1", "", "role2", ""] },
    });

    expect(config.discord.allowedRoleIds).toEqual(["role1", "role2"]);
  });

  it("uses serverId instead of guildId", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { serverId: "123456789" },
    });

    expect(config.discord.serverId).toBe("123456789");
  });

  it("does not include channelId or guildId in config", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { serverId: "123456789" },
    });

    expect(config.discord).not.toHaveProperty("channelId");
    expect(config.discord).not.toHaveProperty("guildId");
  });
});

describe("config boolean parsing", () => {
  const baseConfig = {
    telegram: {
      token: "test-telegram-token",
      allowedUserId: "123456789",
    },
  };

  it("uses false defaults for hide service message flags", () => {
    const config = buildConfig(baseConfig);

    expect(config.bot.hideThinkingMessages).toBe(false);
    expect(config.bot.hideToolCallMessages).toBe(false);
  });

  it("parses truthy values for hide service message flags", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        hideThinkingMessages: "YES",
        hideToolCallMessages: "1",
      },
    });

    expect(config.bot.hideThinkingMessages).toBe(true);
    expect(config.bot.hideToolCallMessages).toBe(true);
  });

  it("parses falsy values for hide service message flags", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        hideThinkingMessages: "off",
        hideToolCallMessages: "0",
      },
    });

    expect(config.bot.hideThinkingMessages).toBe(false);
    expect(config.bot.hideToolCallMessages).toBe(false);
  });

  it("falls back to defaults on invalid values", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        hideThinkingMessages: "banana",
        hideToolCallMessages: "nope",
      },
    });

    expect(config.bot.hideThinkingMessages).toBe(false);
    expect(config.bot.hideToolCallMessages).toBe(false);
  });

  it("uses markdown as default message format mode", () => {
    const config = buildConfig(baseConfig);

    expect(config.bot.messageFormatMode).toBe("markdown");
  });

  it("parses markdown message format mode", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        messageFormatMode: "MARKDOWN",
      },
    });

    expect(config.bot.messageFormatMode).toBe("markdown");
  });

  it("falls back to markdown on invalid message format mode", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        messageFormatMode: "html",
      },
    });

    expect(config.bot.messageFormatMode).toBe("markdown");
  });

  it("parses supported locale from bot.locale", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        locale: "ru",
      },
    });

    expect(config.bot.locale).toBe("ru");
  });

  it("normalizes regional locale tags", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        locale: "ru-RU",
      },
    });

    expect(config.bot.locale).toBe("ru");
  });

  it("falls back to default locale on unsupported value", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        locale: "fr",
      },
    });

    expect(config.bot.locale).toBe("en");
  });
});

describe("config maxActiveSessions parsing", () => {
  const baseConfig = {
    telegram: { token: "test-telegram-token", allowedUserId: "123456789" },
  };

  it("uses default value of 10 when not specified", () => {
    const config = buildConfig(baseConfig);

    expect(config.bot.maxActiveSessions).toBe(10);
  });

  it("parses custom maxActiveSessions value", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        maxActiveSessions: 5,
      },
    });

    expect(config.bot.maxActiveSessions).toBe(5);
  });

  it("parses maxActiveSessions as string number", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        maxActiveSessions: "20",
      },
    });

    expect(config.bot.maxActiveSessions).toBe(20);
  });

  it("throws error when maxActiveSessions is 0", () => {
    expect(() => {
      buildConfig({
        ...baseConfig,
        bot: {
          maxActiveSessions: 0,
        },
      });
    }).toThrow("bot.maxActiveSessions must be between 1 and 50");
  });

  it("throws error when maxActiveSessions is 51", () => {
    expect(() => {
      buildConfig({
        ...baseConfig,
        bot: {
          maxActiveSessions: 51,
        },
      });
    }).toThrow("bot.maxActiveSessions must be between 1 and 50");
  });

  it("throws error when maxActiveSessions is negative", () => {
    expect(() => {
      buildConfig({
        ...baseConfig,
        bot: {
          maxActiveSessions: -5,
        },
      });
    }).toThrow("bot.maxActiveSessions must be between 1 and 50");
  });

  it("accepts maxActiveSessions of 1 (minimum boundary)", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        maxActiveSessions: 1,
      },
    });

    expect(config.bot.maxActiveSessions).toBe(1);
  });

  it("accepts maxActiveSessions of 50 (maximum boundary)", () => {
    const config = buildConfig({
      ...baseConfig,
      bot: {
        maxActiveSessions: 50,
      },
    });

    expect(config.bot.maxActiveSessions).toBe(50);
  });
});
