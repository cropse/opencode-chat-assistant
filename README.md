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

When you (or another agent) replies to a session from the OpenCode TUI/GUI while the bot is running, the bot detects and forwards those replies to Telegram automatically. No messages are missed, even if they happen outside the bot.

- **Message Poller** — REST polling detects assistant replies created outside the bot
- **Question Poller** — catches pending questions that SSE events may miss
- **Deduplication** — prevents duplicate delivery between SSE and polling
- **Auto SSE Subscription** — automatically subscribes to server events at startup

### Model Picker Pagination

The original model picker could break when the user had many models (Telegram keyboard size limit). This fork paginates the model list with configurable page size (`bot.modelsListLimit`).

### Markdown Formatting

Assistant replies, question prompts, permission requests, and status messages now use Telegram MarkdownV2 formatting with automatic fallback to plain text if parsing fails.

### Setup Wizard for Source Mode

Users who `git clone` this repo now get the same interactive setup wizard on first launch that `npx` users get. No need to manually create `config.yaml`.

### Discord Platform Support

This fork adds Discord as a second supported platform alongside Telegram. Use Discord for team/community access with role-based authorization.

- **Role-based access** — users with a configured Discord role can send prompts in channels
- **DM whitelist** — specific user IDs can interact with the bot via direct messages
- **Session owner lock** — one operator at a time, others see "session busy" message
- **14 slash commands** — all bot functions available as `/command` in Discord
- **Status embed** — pinned message with session info, model, and token usage

See [Discord Setup Guide](docs/DISCORD_SETUP.md) for step-by-step instructions.

---

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
- Localization — UI in 5 languages (`bot.locale`)

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

The `config.yaml` file is saved to the project root. Subsequent launches skip the wizard.

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
- Change locale later with `bot.locale`

### Configuration Reference

The `config.yaml` file location depends on how you run the bot:

- **From source (git clone):** `config.yaml` in project root directory (created by setup wizard on first launch)
- **macOS (installed):** `~/Library/Application Support/opencode-telegram-bot/config.yaml`
- **Windows (installed):** `%APPDATA%\opencode-telegram-bot\config.yaml`
- **Linux (installed):** `~/.config/opencode-telegram-bot/config.yaml`

| Key                              | Description                                                                                                  | Required | Default                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | :------: | ------------------------ |
| `telegram.token`                 | Bot token from @BotFather                                                                                    |   Yes    | —                        |
| `telegram.allowedUserId`         | Your numeric Telegram user ID                                                                                |   Yes    | —                        |
| `telegram.proxyUrl`              | Proxy URL for Telegram API (SOCKS5/HTTP)                                                                     |    No    | —                        |
| `opencode.apiUrl`                | OpenCode server URL                                                                                          |    No    | `http://localhost:4096`  |
| `opencode.username`              | Server auth username                                                                                         |    No    | `opencode`               |
| `opencode.password`              | Server auth password                                                                                         |    No    | —                        |
| `bot.locale`                     | Bot UI language (supported locale code, e.g. `en`, `de`, `es`, `ru`, `zh`)                                   |    No    | `en`                     |
| `bot.sessionsListLimit`          | Sessions per page in `/sessions`                                                                             |    No    | `10`                     |
| `bot.projectsListLimit`          | Projects per page in `/projects`                                                                             |    No    | `10`                     |
| `bot.modelsListLimit`            | Models per page in model picker                                                                              |    No    | `10`                     |
| `bot.serviceMessagesIntervalSec` | Service messages interval (thinking + tool calls); keep `>=2` to avoid Telegram rate limits, `0` = immediate |    No    | `5`                      |
| `bot.hideThinkingMessages`       | Hide `💭 Thinking...` service messages                                                                       |    No    | `false`                  |
| `bot.hideToolCallMessages`       | Hide tool-call service messages (`💻 bash ...`, `📖 read ...`, etc.)                                         |    No    | `false`                  |
| `bot.messageFormatMode`          | Assistant reply formatting mode: `markdown` (Telegram MarkdownV2) or `raw`                                   |    No    | `markdown`               |
| `files.maxFileSizeKb`            | Max file size (KB) to send as document                                                                       |    No    | `100`                    |
| `stt.apiUrl`                     | Whisper-compatible API base URL (enables voice/audio transcription)                                          |    No    | —                        |
| `stt.apiKey`                     | API key for your STT provider                                                                                |    No    | —                        |
| `stt.model`                      | STT model name passed to `/audio/transcriptions`                                                             |    No    | `whisper-large-v3-turbo` |
| `stt.language`                   | Optional language hint (empty = provider auto-detect)                                                        |    No    | —                        |
| `server.logLevel`                | Log level (`debug`, `info`, `warn`, `error`)                                                                 |    No    | `info`                   |

### Discord Platform Configuration

| Key                      |   Required   | Description                                                       |
| ------------------------ | :----------: | ----------------------------------------------------------------- |
| `platform`               |      No      | `"telegram"` (default) or `"discord"`                             |
| `discord.token`          | When discord | Bot token from Discord Developer Portal                           |
| `discord.serverId`       | When discord | Discord server ID (Enable Developer Mode, right-click server)     |
| `discord.allowedRoleIds` | When discord | Role IDs for channel access (YAML list or comma-separated string) |
| `discord.allowedUserIds` |      No      | User IDs for DM access (YAML list or comma-separated string)      |

See [docs/DISCORD_SETUP.md](docs/DISCORD_SETUP.md) for step-by-step Discord setup instructions.

> **Keep your `config.yaml` file private.** It contains your bot token. Never commit it to version control.

### Voice and Audio Transcription (Optional)

If `stt.apiUrl` and `stt.apiKey` are set, the bot will accept voice/audio messages, transcribe them, and send the text to OpenCode as a prompt.

Supported providers (Whisper-compatible):

| Provider     | `stt.apiUrl`                     | `stt.model`               |
| ------------ | -------------------------------- | ------------------------- |
| **OpenAI**   | `https://api.openai.com/v1`      | `whisper-1`               |
| **Groq**     | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo`  |
| **Together** | `https://api.together.xyz/v1`    | `openai/whisper-large-v3` |

### Model Configuration

The model picker uses OpenCode local model state (`favorite` + `recent`):

- Favorites are shown first, then recent
- Models already in favorites are not duplicated in recent
- Current model is marked with `✅`
- If no model is selected, OpenCode uses the agent's default model

To add a model to favorites, open OpenCode TUI (`opencode`), go to model selection, and press **Cmd+F/Ctrl+F** on the model.

## Security

The bot enforces a strict **user ID whitelist**. Only the Telegram user whose numeric ID matches `telegram.allowedUserId` can interact with the bot. Messages from any other user are silently ignored.

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

- Verify `telegram.allowedUserId` matches your actual user ID (check with [@userinfobot](https://t.me/userinfobot))
- Verify the bot token is correct

**"OpenCode server is not available"**

- Make sure `opencode serve` is running
- Check `opencode.apiUrl` (default: `http://localhost:4096`)

**No models in model picker**

- Add models to favorites in OpenCode TUI (Ctrl+F on a model)

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
