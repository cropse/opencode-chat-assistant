# OpenCode Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **Fork of [grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) by [Ruslan Grinev](https://github.com/grinev).**
> This fork is developed and maintained with AI assistance (OpenCode + Claude).

OpenCode Telegram Bot is a secure Telegram client for [OpenCode](https://opencode.ai) CLI that runs on your local machine.

Run AI coding tasks, monitor progress, switch models, and manage sessions from your phone.

No open ports, no exposed APIs. The bot communicates with your local OpenCode server and the Telegram Bot API only.

Platforms: macOS, Windows, Linux

Languages: English (`en`), Deutsch (`de`), Español (`es`), Русский (`ru`), 简体中文 (`zh`)

<p align="center">
  <img src="assets/screencast.gif" width="45%" alt="OpenCode Telegram Bot screencast" />
</p>

## What This Fork Adds

This fork builds on the [original project](https://github.com/grinev/opencode-telegram-bot) and adds the following enhancements:

### External Reply Sync

When you (or another agent) reply to a session from the OpenCode TUI/GUI while the bot is running, the bot detects and forwards those replies to Telegram automatically. No messages are missed, even if they happen outside the bot.

- **Message Poller** — REST polling detects assistant replies created outside the bot
- **Question Poller** — catches pending questions that SSE events may miss
- **Deduplication** — prevents duplicate delivery between SSE and polling
- **Auto SSE Subscription** — automatically subscribes to server events at startup

### Model Picker Pagination

The original model picker could break when the user had many models (Telegram keyboard size limit). This fork paginates the model list with configurable page size (`MODELS_LIST_LIMIT`).

### Markdown Formatting

Assistant replies, question prompts, permission requests, and status messages now use Telegram MarkdownV2 formatting with automatic fallback to plain text if parsing fails.

### Setup Wizard for Source Mode

Users who `git clone` this repo now get the same interactive setup wizard on first launch that `npx` users get. No need to manually create `.env`.

---

## Features (from upstream)

All original features from the upstream project are included:

- **Remote coding** — send prompts to OpenCode from anywhere, receive complete results with code sent as files
- **Session management** — create new sessions or continue existing ones, just like in the TUI
- **Live status** — pinned message with current project, model, context usage, and changed files list, updated in real time
- **Model switching** — pick models from OpenCode favorites and recent history directly in the chat
- **Agent modes** — switch between Plan and Build modes on the fly
- **Model variants** — select reasoning mode variants per model
- **Custom Commands** — run OpenCode custom commands (and built-ins like `init`/`review`) from an inline menu
- **Interactive Q&A** — answer agent questions and approve permissions via inline buttons
- **Voice prompts** — send voice/audio messages, transcribe via Whisper-compatible API
- **File attachments** — send images, PDF documents, and text-based files to OpenCode
- **Context control** — compact context when it gets too large, right from the chat
- **Input flow control** — only one interactive flow active at a time, with contextual hints
- **Security** — strict user ID whitelist; no one else can access your bot
- **Localization** — UI in 5 languages (`BOT_LOCALE`)

Planned features are listed in [PRODUCT.md](PRODUCT.md#current-task-list).

## Prerequisites

- **Node.js 20+** — [download](https://nodejs.org)
- **OpenCode** — install from [opencode.ai](https://opencode.ai) or [GitHub](https://github.com/sst/opencode)
- **Telegram Bot** — you'll create one during setup (takes 1 minute)

## Installation

### 1. Create a Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`
2. Follow the prompts to choose a name and username
3. Copy the **bot token** you receive (e.g. `123456:ABC-DEF1234...`)

You'll also need your **Telegram User ID** — send any message to [@userinfobot](https://t.me/userinfobot) and it will reply with your numeric ID.

### 2. Start OpenCode Server

```bash
opencode serve
```

> The bot connects to the OpenCode API at `http://localhost:4096` by default.

### 3. Clone & Run

```bash
git clone https://github.com/IH-Chung/opencode-telegram-bot.git
cd opencode-telegram-bot
npm install
npm run dev
```

On first launch, an interactive wizard will guide you through the configuration:

1. **Language** — select your preferred UI language
2. **Bot Token** — paste the token from @BotFather
3. **User ID** — your numeric Telegram user ID
4. **API URL** — OpenCode server URL (default: `http://localhost:4096`)
5. **Server credentials** — username and password (optional)

The `.env` file is saved to the project root. Subsequent launches skip the wizard.

## Supported Platforms

| Platform | Status                                       |
| -------- | -------------------------------------------- |
| macOS    | Fully supported                              |
| Windows  | Fully supported                              |
| Linux    | Fully supported (tested on Ubuntu 24.04 LTS) |

## Bot Commands

| Command           | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `/status`         | Server health, current project, session, and model info |
| `/new`            | Create a new session                                    |
| `/abort`          | Abort the current task                                  |
| `/sessions`       | Browse and switch between recent sessions               |
| `/projects`       | Switch between OpenCode projects                        |
| `/rename`         | Rename the current session                              |
| `/commands`       | Browse and run custom commands                          |
| `/opencode_start` | Start the OpenCode server remotely                      |
| `/opencode_stop`  | Stop the OpenCode server remotely                       |
| `/help`           | Show available commands                                 |

Any regular text message is sent as a prompt to the coding agent. Voice/audio messages are transcribed and sent as prompts when STT is configured.

Model, agent, variant, and context controls are available from the persistent reply keyboard at the bottom of the chat.

> `/opencode_start` and `/opencode_stop` are emergency commands for restarting a stuck server while away from your computer. Under normal usage, start `opencode serve` yourself.

## Configuration

### Localization

- Supported locales: `en`, `de`, `es`, `ru`, `zh`
- The setup wizard asks for language first
- Change locale later with `BOT_LOCALE`

### Environment Variables

The `.env` file location depends on how you run the bot:

- **From source (git clone):** project root directory (created by setup wizard on first launch)
- **macOS (installed):** `~/Library/Application Support/opencode-telegram-bot/.env`
- **Windows (installed):** `%APPDATA%\opencode-telegram-bot\.env`
- **Linux (installed):** `~/.config/opencode-telegram-bot/.env`

| Variable                        | Description                                                                               | Required | Default                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- | :------: | ------------------------ |
| `TELEGRAM_BOT_TOKEN`            | Bot token from @BotFather                                                                 |   Yes    | —                        |
| `TELEGRAM_ALLOWED_USER_ID`      | Your numeric Telegram user ID                                                             |   Yes    | —                        |
| `TELEGRAM_PROXY_URL`            | Proxy URL for Telegram API (SOCKS5/HTTP)                                                  |    No    | —                        |
| `OPENCODE_API_URL`              | OpenCode server URL                                                                       |    No    | `http://localhost:4096`  |
| `OPENCODE_SERVER_USERNAME`      | Server auth username                                                                      |    No    | `opencode`               |
| `OPENCODE_SERVER_PASSWORD`      | Server auth password                                                                      |    No    | —                        |
| `OPENCODE_MODEL_PROVIDER`       | Default model provider                                                                    |   Yes    | `opencode`               |
| `OPENCODE_MODEL_ID`             | Default model ID                                                                          |   Yes    | `big-pickle`             |
| `BOT_LOCALE`                    | Bot UI language (e.g. `en`, `de`, `es`, `ru`, `zh`)                                       |    No    | `en`                     |
| `SESSIONS_LIST_LIMIT`           | Sessions per page in `/sessions`                                                          |    No    | `10`                     |
| `PROJECTS_LIST_LIMIT`           | Projects per page in `/projects`                                                          |    No    | `10`                     |
| `MODELS_LIST_LIMIT`             | Models per page in model picker                                                           |    No    | `10`                     |
| `SERVICE_MESSAGES_INTERVAL_SEC` | Tool message batching interval; keep `>=2` to avoid Telegram rate limits, `0` = immediate |    No    | `5`                      |
| `HIDE_THINKING_MESSAGES`        | Hide thinking indicator messages                                                          |    No    | `false`                  |
| `HIDE_TOOL_CALL_MESSAGES`       | Hide tool-call service messages                                                           |    No    | `false`                  |
| `MESSAGE_FORMAT_MODE`           | Reply formatting: `markdown` (MarkdownV2) or `raw`                                        |    No    | `markdown`               |
| `CODE_FILE_MAX_SIZE_KB`         | Max file size (KB) to send as document                                                    |    No    | `100`                    |
| `STT_API_URL`                   | Whisper-compatible API base URL (enables voice transcription)                             |    No    | —                        |
| `STT_API_KEY`                   | API key for your STT provider                                                             |    No    | —                        |
| `STT_MODEL`                     | STT model name                                                                            |    No    | `whisper-large-v3-turbo` |
| `STT_LANGUAGE`                  | Language hint for STT (empty = auto-detect)                                               |    No    | —                        |
| `LOG_LEVEL`                     | Log level (`debug`, `info`, `warn`, `error`)                                              |    No    | `info`                   |

> **Keep your `.env` file private.** It contains your bot token. Never commit it to version control.

### Voice and Audio Transcription (Optional)

If `STT_API_URL` and `STT_API_KEY` are set, the bot will accept voice/audio messages, transcribe them, and send the text to OpenCode as a prompt.

Supported providers (Whisper-compatible):

| Provider     | `STT_API_URL`                    | `STT_MODEL`               |
| ------------ | -------------------------------- | ------------------------- |
| **OpenAI**   | `https://api.openai.com/v1`      | `whisper-1`               |
| **Groq**     | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo`  |
| **Together** | `https://api.together.xyz/v1`    | `openai/whisper-large-v3` |

### Model Configuration

The model picker uses OpenCode local model state (`favorite` + `recent`):

- Favorites are shown first, then recent (no duplicates)
- Current model is marked with a checkmark
- Default model from `.env` is always included in favorites
- Models are paginated (`MODELS_LIST_LIMIT`, default 10 per page)

To add favorites: open OpenCode TUI, go to model selection, press **Cmd+F / Ctrl+F** on the model.

## Security

The bot enforces a strict **user ID whitelist**. Only the Telegram user whose numeric ID matches `TELEGRAM_ALLOWED_USER_ID` can interact with the bot. Messages from any other user are silently ignored.

Since the bot runs locally and connects outward only (Telegram API + local OpenCode server), there is no external attack surface.

## Development

### Available Scripts

| Script                  | Description                          |
| ----------------------- | ------------------------------------ |
| `npm run dev`           | Build and start                      |
| `npm run dev:watch`     | Run with auto-restart on file change |
| `npm run build`         | Compile TypeScript                   |
| `npm start`             | Run compiled code                    |
| `npm run lint`          | ESLint check (zero warnings policy)  |
| `npm run format`        | Format code with Prettier            |
| `npm test`              | Run tests (Vitest)                   |
| `npm run test:coverage` | Tests with coverage report           |

> `dev:watch` auto-restarts on file save — recommended during development. For production or long-running sessions, use `npm run dev` to avoid mid-task connection interruptions.

## Troubleshooting

**Bot doesn't respond to messages**

- Verify `TELEGRAM_ALLOWED_USER_ID` matches your actual user ID (check with [@userinfobot](https://t.me/userinfobot))
- Verify the bot token is correct

**"OpenCode server is not available"**

- Make sure `opencode serve` is running
- Check `OPENCODE_API_URL` (default: `http://localhost:4096`)

**No models in model picker**

- Add models to favorites in OpenCode TUI (Ctrl+F on a model)
- Verify `OPENCODE_MODEL_PROVIDER` and `OPENCODE_MODEL_ID` in `.env`

## Contributing

Please follow commit and release note conventions in [CONTRIBUTING.md](CONTRIBUTING.md).

## Based On

This project is a fork of **[grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot)**, originally created by [Ruslan Grinev](https://github.com/grinev).

The original project provides the core architecture, bot framework, session management, and overall design. This fork adds enhancements (external reply sync, model pagination, Markdown formatting, source-mode setup wizard) on top of that foundation.

**All code in this fork — including the enhancements listed above — was developed with AI assistance using [OpenCode](https://opencode.ai) and Claude.**

For the original upstream project, visit: https://github.com/grinev/opencode-telegram-bot

## License

[MIT](LICENSE)

Original work by [Ruslan Grinev](https://github.com/grinev) | Fork modifications by IH-Chung
