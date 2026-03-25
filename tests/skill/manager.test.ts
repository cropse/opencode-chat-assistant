import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Create the mock function
const fetchMock = vi.fn();

vi.mock("../../src/config.js", () => ({
  config: {
    opencode: {
      apiUrl: "http://localhost:4096",
      username: "opencode",
      password: undefined,
    },
    server: {
      logLevel: "error",
    },
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { getAvailableSkills, clearSkillCache } from "../../src/skill/manager.js";
import type { SkillInfo } from "../../src/skill/types.js";

describe("skill/manager", () => {
  beforeEach(() => {
    // Reset and setup the mock
    fetchMock.mockReset();
    clearSkillCache();

    // Mock global fetch - must be done in beforeEach to override native fetch
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("returns array of SkillInfo on success", async () => {
    const mockSkills: SkillInfo[] = [
      { name: "skill-1", description: "First skill" },
      { name: "skill-2", description: "Second skill", location: "/path/to/skill" },
    ];

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => mockSkills,
    } as unknown as Response);

    const result = await getAvailableSkills();

    expect(result).toEqual(mockSkills);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4096/skill",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns empty array when API returns empty array", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as unknown as Response);

    const result = await getAvailableSkills();

    expect(result).toEqual([]);
  });

  it("throws when fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network error"));

    await expect(getAvailableSkills()).rejects.toThrow("Network error");
  });

  it("throws when response is not ok", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as unknown as Response);

    await expect(getAvailableSkills()).rejects.toThrow("500");
  });

  it("passes directory query param when provided", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    } as unknown as Response);

    await getAvailableSkills("/my/project");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4096/skill?directory=%2Fmy%2Fproject",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
