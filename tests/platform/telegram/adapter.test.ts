import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fromMessageRef,
  TELEGRAM_PLATFORM_INFO,
  TelegramAdapter,
  toMessageRef,
} from "../../../src/platform/telegram/adapter.js";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: {
      token: "TEST_TOKEN",
      allowedUserId: 123,
      proxyUrl: "",
    },
    opencode: {
      apiUrl: "http://localhost:4096",
      username: "opencode",
      password: "",
    },
    server: {
      logLevel: "error",
    },
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
    files: {
      maxFileSizeKb: 100,
    },
    stt: {
      apiUrl: "",
      apiKey: "",
      model: "whisper-large-v3-turbo",
      language: "",
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

type MockApi = {
  sendMessage: ReturnType<typeof vi.fn>;
  sendDocument: ReturnType<typeof vi.fn>;
  sendPhoto: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  pinChatMessage: ReturnType<typeof vi.fn>;
  unpinAllChatMessages: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
  sendChatAction: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
  getFile: ReturnType<typeof vi.fn>;
};

function createMockApi(): MockApi {
  return {
    sendMessage: vi.fn(),
    sendDocument: vi.fn(),
    sendPhoto: vi.fn(),
    editMessageText: vi.fn(),
    deleteMessage: vi.fn(),
    pinChatMessage: vi.fn(),
    unpinAllChatMessages: vi.fn(),
    answerCallbackQuery: vi.fn(),
    sendChatAction: vi.fn(),
    setMyCommands: vi.fn(),
    getFile: vi.fn(),
  };
}

describe("platform/telegram/adapter", () => {
  let api: MockApi;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    api = createMockApi();
    adapter = new TelegramAdapter(
      api as unknown as ConstructorParameters<typeof TelegramAdapter>[0],
    );
    adapter.setChatId("777");
  });

  it("exports telegram platform info constants", () => {
    expect(TELEGRAM_PLATFORM_INFO).toEqual({
      platform: "telegram",
      messageMaxLength: 4096,
      documentCaptionMaxLength: 1024,
    });
    expect(adapter.info).toEqual(TELEGRAM_PLATFORM_INFO);
  });

  it("toMessageRef converts numeric id to string", () => {
    expect(toMessageRef(12345)).toBe("12345");
  });

  it("fromMessageRef converts string ref to number", () => {
    expect(fromMessageRef("12345")).toBe(12345);
  });

  it("sendMessage delegates to api.sendMessage with parsed options", async () => {
    api.sendMessage.mockResolvedValueOnce({ message_id: 81 });

    const messageRef = await adapter.sendMessage("hello", {
      parseMode: "MarkdownV2",
      replyMarkup: { keyboard: [[{ text: "ok" }]] },
      replyToMessageRef: "42",
      disableWebPagePreview: true,
    });

    expect(api.sendMessage).toHaveBeenCalledWith(777, "hello", {
      parse_mode: "MarkdownV2",
      reply_markup: { keyboard: [[{ text: "ok" }]] },
      reply_to_message_id: 42,
      link_preview_options: { is_disabled: true },
    });
    expect(messageRef).toBe("81");
  });

  it("sendDocument delegates to api.sendDocument", async () => {
    api.sendDocument.mockResolvedValueOnce({ message_id: 82 });

    const messageRef = await adapter.sendDocument("file.bin", {
      caption: "doc",
      parseMode: "HTML",
    });

    expect(api.sendDocument).toHaveBeenCalledWith(777, "file.bin", {
      caption: "doc",
      parse_mode: "HTML",
    });
    expect(messageRef).toBe("82");
  });

  it("sendPhoto delegates to api.sendPhoto", async () => {
    api.sendPhoto.mockResolvedValueOnce({ message_id: 83 });

    const messageRef = await adapter.sendPhoto("image.png", {
      caption: "photo",
      parseMode: "Markdown",
    });

    expect(api.sendPhoto).toHaveBeenCalledWith(777, "image.png", {
      caption: "photo",
      parse_mode: "Markdown",
    });
    expect(messageRef).toBe("83");
  });

  it("editMessage delegates to api.editMessageText with parsed message ref", async () => {
    api.editMessageText.mockResolvedValueOnce({});

    await adapter.editMessage("91", "updated", {
      parseMode: "MarkdownV2",
      replyMarkup: { inline_keyboard: [[{ text: "x", callback_data: "x" }]] },
      disableWebPagePreview: true,
    });

    expect(api.editMessageText).toHaveBeenCalledWith(777, 91, "updated", {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: [[{ text: "x", callback_data: "x" }]] },
      link_preview_options: { is_disabled: true },
    });
  });

  it("deleteMessage delegates to api.deleteMessage", async () => {
    api.deleteMessage.mockResolvedValueOnce(true);

    await adapter.deleteMessage("55");

    expect(api.deleteMessage).toHaveBeenCalledWith(777, 55);
  });

  it("answerCallbackQuery delegates to api.answerCallbackQuery", async () => {
    api.answerCallbackQuery.mockResolvedValueOnce(true);

    await adapter.answerCallbackQuery("cb-1", {
      text: "done",
      showAlert: true,
    });

    expect(api.answerCallbackQuery).toHaveBeenCalledWith("cb-1", {
      text: "done",
      show_alert: true,
    });
  });

  it("sendTyping delegates to api.sendChatAction typing", async () => {
    api.sendChatAction.mockResolvedValueOnce(true);

    await adapter.sendTyping();

    expect(api.sendChatAction).toHaveBeenCalledWith(777, "typing");
  });

  it("setCommands delegates to api.setMyCommands", async () => {
    api.setMyCommands.mockResolvedValueOnce(true);
    const commands = [{ command: "status", description: "Status" }];

    await adapter.setCommands(commands);

    expect(api.setMyCommands).toHaveBeenCalledWith(commands);
  });

  it("getFileUrl calls api.getFile and returns telegram file URL", async () => {
    api.getFile.mockResolvedValueOnce({ file_path: "documents/doc.txt" });

    const url = await adapter.getFileUrl("file-1");

    expect(api.getFile).toHaveBeenCalledWith("file-1");
    expect(url).toBe("https://api.telegram.org/file/botTEST_TOKEN/documents/doc.txt");
  });

  it("getFileUrl throws when file_path is missing", async () => {
    api.getFile.mockResolvedValueOnce({});

    await expect(adapter.getFileUrl("file-2")).rejects.toThrow(
      "File path not available for fileId: file-2",
    );
  });
});
