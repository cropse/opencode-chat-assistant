import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";

describe("discord config parsing", () => {
  const baseConfig = {
    telegram: { token: "test-telegram-token", allowedUserId: "123456789" },
  };

  it("parses allowedRoleIds as comma-separated array", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { allowedRoleIds: "role1,role2,role3" },
    });

    expect(config.discord.allowedRoleIds).toEqual(["role1", "role2", "role3"]);
  });

  it("parses allowedUserIds as comma-separated number array", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { allowedUserIds: "123456789,987654321,111222333" },
    });

    expect(config.discord.allowedUserIds).toEqual([123456789, 987654321, 111222333]);
  });

  it("returns empty arrays when discord fields not provided", () => {
    const config = buildConfig(baseConfig);

    expect(config.discord.allowedRoleIds).toEqual([]);
    expect(config.discord.allowedUserIds).toEqual([]);
  });

  it("filters empty strings from allowedRoleIds", () => {
    const config = buildConfig({
      ...baseConfig,
      discord: { allowedRoleIds: "role1,,role2," },
    });

    expect(config.discord.allowedRoleIds).toEqual(["role1", "role2"]);
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
