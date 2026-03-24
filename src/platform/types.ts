// Platform-agnostic message reference (Telegram uses number internally, stored as string)
export type PlatformMessageRef = string;

// Platform identifier + capability info
export type PlatformInfo = {
  platform: "telegram" | "discord";
  messageMaxLength: number;
  documentCaptionMaxLength: number;
};

// Normalized input type for interaction guard (platform-agnostic input classification)
export type NormalizedInput = {
  type: "text" | "callback" | "photo" | "document" | "voice" | "unknown";
  text?: string; // For type "text"
  callbackData?: string; // For type "callback"
  fileId?: string; // For type "photo" | "document" | "voice"
};

// Options for sending/editing messages
export type PlatformMessageOptions = {
  parseMode?: "MarkdownV2" | "Markdown" | "HTML";
  replyMarkup?: unknown; // Platform-specific keyboard/buttons (opaque to shared code)
  replyToMessageRef?: PlatformMessageRef;
  disableWebPagePreview?: boolean;
};

// Options for sending documents/files
export type PlatformDocumentOptions = {
  caption?: string;
  parseMode?: "MarkdownV2" | "Markdown" | "HTML";
};

// Options for answering callback queries
export type PlatformCallbackQueryOptions = {
  text?: string;
  showAlert?: boolean;
};

// The core platform adapter interface — chat-bound (chatId set at construction, not per call)
export interface PlatformAdapter {
  readonly info: PlatformInfo;

  // Set the active chat (called when a new message arrives to bind adapter to that chat)
  setChatId(chatId: string): void;

  // Send a new text message to the bound chat
  sendMessage(text: string, options?: PlatformMessageOptions): Promise<PlatformMessageRef>;

  // Send a document/file to the bound chat
  sendDocument(
    file: unknown, // Platform-specific file type (InputFile for Telegram, Buffer for Discord)
    options?: PlatformDocumentOptions,
  ): Promise<PlatformMessageRef>;

  // Send a photo to the bound chat
  sendPhoto(
    photo: unknown, // Platform-specific photo type
    options?: PlatformDocumentOptions,
  ): Promise<PlatformMessageRef>;

  // Edit an existing message's text
  editMessage(
    messageRef: PlatformMessageRef,
    text: string,
    options?: PlatformMessageOptions,
  ): Promise<void>;

  // Delete a message
  deleteMessage(messageRef: PlatformMessageRef): Promise<void>;

  // Pin a message in the chat
  pinMessage(messageRef: PlatformMessageRef): Promise<void>;

  // Unpin all messages in the chat
  unpinAllMessages(): Promise<void>;

  // Answer a callback query (acknowledge button press)
  answerCallbackQuery(callbackId: string, options?: PlatformCallbackQueryOptions): Promise<void>;

  // Send typing indicator
  sendTyping(): Promise<void>;

  // Set bot commands visible to the user
  setCommands(commands: Array<{ command: string; description: string }>): Promise<void>;

  // Get a downloadable URL for a file by its platform file ID
  getFileUrl(fileId: string): Promise<string>;

  // Add a reaction emoji to a message
  addReaction(messageRef: PlatformMessageRef, emoji: string): Promise<void>;

  // Remove a reaction emoji from a message
  removeReaction(messageRef: PlatformMessageRef, emoji: string): Promise<void>;
}

/**
 * Token information from AssistantMessage
 */
export interface TokensInfo {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * File change info from OpenCode session diff
 */
export interface FileChange {
  file: string;
  additions: number;
  deletions: number;
}
