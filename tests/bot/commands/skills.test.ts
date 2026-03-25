import { describe, expect, it, vi, beforeEach } from "vitest";
import { skillsCommand } from "../../../src/platform/telegram/commands/skills.js";
import * as settingsManager from "../../../src/settings/manager.js";
import * as skillManager from "../../../src/skill/manager.js";
import * as sendWithMarkdownFallback from "../../../src/platform/telegram/utils/send-with-markdown-fallback.js";

describe("bot/commands/skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows 'no project' message when no project selected", async () => {
    vi.spyOn(settingsManager, "getCurrentProject").mockReturnValue(undefined);

    const replyMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = { reply: replyMock };

    await skillsCommand(ctx);

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock).toHaveBeenCalledWith(
      "⚠️ No project selected. Use /projects to select a project first.",
    );
  });

  it("shows skills list when skills are available", async () => {
    const mockProject = {
      id: "proj_123",
      name: "Test Project",
      worktree: "/path/to/project",
    };
    vi.spyOn(settingsManager, "getCurrentProject").mockReturnValue(mockProject);

    const mockSkills = [
      { name: "Skill One", description: "Description one" },
      { name: "Skill Two", description: "Description two" },
    ];
    vi.spyOn(skillManager, "getAvailableSkills").mockResolvedValue(mockSkills);

    vi.spyOn(sendWithMarkdownFallback, "sendMessageWithMarkdownFallback").mockResolvedValue(
      undefined,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = {
      chat: { id: 123 },
      api: {},
      reply: vi.fn(),
    };

    await skillsCommand(ctx);

    expect(sendWithMarkdownFallback.sendMessageWithMarkdownFallback).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendWithMarkdownFallback.sendMessageWithMarkdownFallback).mock.calls[0];
    expect(call[0].text).toContain("Available Skills");
    expect(call[0].text).toContain("`Skill One`");
    expect(call[0].text).toContain("`Skill Two`");
    expect(call[0].text).toContain("/skills verbose");
  });

  it("shows 'empty' message when no skills available", async () => {
    const mockProject = {
      id: "proj_123",
      name: "Test Project",
      worktree: "/path/to/project",
    };
    vi.spyOn(settingsManager, "getCurrentProject").mockReturnValue(mockProject);
    vi.spyOn(skillManager, "getAvailableSkills").mockResolvedValue([]);

    const replyMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = { reply: replyMock };

    await skillsCommand(ctx);

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock).toHaveBeenCalledWith("🛠 No skills available for this project.");
  });

  it("shows error message on fetch failure", async () => {
    const mockProject = {
      id: "proj_123",
      name: "Test Project",
      worktree: "/path/to/project",
    };
    vi.spyOn(settingsManager, "getCurrentProject").mockReturnValue(mockProject);
    vi.spyOn(skillManager, "getAvailableSkills").mockRejectedValue(new Error("Network error"));

    const replyMock = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = { reply: replyMock };

    await skillsCommand(ctx);

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock).toHaveBeenCalledWith("🔴 Failed to load skills.");
  });
});
