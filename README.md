# OpenCode Chat Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

OpenCode Chat Assistant is a secure Discord bot client for [OpenCode](https://opencode.ai) CLI that runs on your local machine.

Run AI coding tasks, monitor progress, switch models, and manage sessions from Discord.

No open ports, no exposed APIs. The bot connects outward to the Discord Gateway and your local OpenCode server only.

Platforms: macOS, Windows, Linux

Languages: English (`en`), Deutsch (`de`), Español (`es`), Русский (`ru`), 简体中文 (`zh`)

## What This Bot Does

### External Reply Sync

When you (or another agent) replies to a session from the OpenCode TUI/GUI while the bot is running, the bot detects and forwards those replies to Discord automatically. No messages are missed, even if they happen outside the bot.

- **Message Poller** — REST polling detects assistant replies created outside the bot
- **Question Poller** — catches pending questions that SSE events may miss
- **Deduplication** — prevents duplicate delivery between SSE and polling
- **Auto SSE Subscription** — automatically subscribes to server events at startup

### Model Picker Pagination

The model picker paginates the model list with configurable page size (`bot.modelsListLimit`) to handle users with many models.

### Markdown Formatting

Assistant replies, question prompts, permission requests, and status messages use Discord markdown formatting for better readability.

### Setup Wizard for Source Mode

Users who `git clone` this repo get the same interactive setup wizard on first launch that `npx` users get. No need to manually create `config.yaml`.

---

**Core features:**

- **Remote coding** — send prompts to OpenCode from anywhere, receive complete results with code sent as files
- **Session management** — create new sessions or continue existing ones, just like in the TUI
- **Live status** — pinned embed with current project, model, context usage, and changed files list, updated in real time
- **Model switching** — pick models from OpenCode favorites and recent history directly in the chat
- **Agent modes** — switch between Plan and Build modes on the fly
- **Model variants** — select reasoning mode variants per model
- **Custom Commands** — run OpenCode custom commands (and built-ins like `init`/`review`) from a menu
- **Skills** — browse and run agent skills from Discord
- **Interactive Q&A** — answer agent questions and approve permissions via buttons
- **File attachments** — send images, PDF documents, and text-based files to OpenCode
- **Context control** — compact context when it gets too large, right from the chat
- **Input flow control** — only one interactive flow active at a time, with contextual hints
- **Security** — role-based access for channels; DM whitelist for direct messages
- **Localization** — UI in 5 languages (`bot.locale`)

Planned features are listed in [PRODUCT.md](PRODUCT.md#current-task-list).

## Prerequisites

- **Node.js 20+** — [download](https://nodejs.org)
- **OpenCode** — install from [opencode.ai](https://opencode.ai) or [GitHub](https://github.com/sst/opencode)

## Installation

### 1. Start OpenCode Server

```bash
opencode serve
```

> The bot connects to the OpenCode API at `http://localhost:4096` by default.

### 2. Clone & Run

```bash
git clone https://github.com/IH-Chung/opencode-chat-assistant.git
cd opencode-chat-assistant
npm install
npm run dev
```

On first launch, an interactive wizard will guide you through the configuration:

1. **Language** — select your preferred UI language
2. **Bot Token** — paste the token from Discord Developer Portal
3. **Server ID** — your Discord server ID (for slash command registration)
4. **Role IDs** — roles that can use the bot in channels
5. **User IDs** — (optional) users who can DM the bot
6. **API URL** — OpenCode server URL (default: `http://localhost:4096`)
7. **Server credentials** — username and password (optional)

The `config.yaml` file is saved to the project root. Subsequent launches skip the wizard.

For detailed Discord setup instructions, see [docs/DISCORD_SETUP.md](docs/DISCORD_SETUP.md).

## Supported Platforms

| Platform | Status                                       |
| -------- | -------------------------------------------- |
| macOS    | Fully supported                              |
| Windows  | Fully supported                              |
| Linux    | Fully supported (tested on Ubuntu 24.04 LTS) |

## Slash Commands

| Command           | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `/status`         | Server health, current project, session, and model info |
| `/new`            | Create a new session                                    |
| `/abort`          | Abort the current task                                  |
| `/sessions`       | Browse and switch between recent sessions               |
| `/projects`       | Switch between OpenCode projects                        |
| `/rename`         | Rename the current session                              |
| `/commands`       | Browse and run custom commands                          |
| `/skills`         | Browse and run agent skills                             |
| `/opencode_start` | Start the OpenCode server remotely                      |
| `/opencode_stop`  | Stop the OpenCode server remotely                       |
| `/model`          | Select AI model                                         |
| `/agent`          | Select agent mode (build/plan)                          |
| `/variant`        | Select model variant (reasoning mode)                   |
| `/help`           | Show available commands                                 |

Any regular text message is sent as a prompt to the coding agent. Model, agent, variant, and context controls are available via slash commands and buttons.

> `/opencode_start` and `/opencode_stop` are emergency commands for restarting a stuck server while away from your computer. Under normal usage, start `opencode serve` yourself.

## Configuration

### Localization

- Supported locales: `en`, `de`, `es`, `ru`, `zh`
- The setup wizard asks for language first
- Change locale later with `bot.locale`

### Configuration Reference

The `config.yaml` file location depends on how you run the bot:

- **From source (git clone):** `config.yaml` in project root directory (created by setup wizard on first launch)
- **macOS (installed):** `~/Library/Application Support/opencode-chat-assistant/config.yaml`
- **Windows (installed):** `%APPDATA%\opencode-chat-assistant\config.yaml`
- **Linux (installed):** `~/.config/opencode-chat-assistant/config.yaml`

| Key                              | Description                                                        | Required | Default                 |
| -------------------------------- | ------------------------------------------------------------------ | :------: | ----------------------- |
| `discord.token`                  | Bot token from Discord Developer Portal                            |   Yes    | —                       |
| `discord.serverId`               | Discord server ID for slash command registration                   |   Yes    | —                       |
| `discord.allowedRoleIds`         | Role IDs for channel access (YAML list or comma-separated)         |    No    | —                       |
| `discord.allowedUserIds`         | User IDs for DM access (YAML list or comma-separated)              |    No    | —                       |
| `opencode.apiUrl`                | OpenCode server URL                                                |    No    | `http://localhost:4096` |
| `opencode.username`              | Server auth username                                               |    No    | `opencode`              |
| `opencode.password`              | Server auth password                                               |    No    | —                       |
| `bot.locale`                     | Bot UI language (supported locale code, e.g. `en`, `de`)           |    No    | `en`                    |
| `bot.sessionsListLimit`          | Sessions per page in `/sessions`                                   |    No    | `10`                    |
| `bot.projectsListLimit`          | Projects per page in `/projects`                                   |    No    | `10`                    |
| `bot.modelsListLimit`            | Models per page in model picker                                    |    No    | `10`                    |
| `bot.maxActiveSessions`          | Max concurrent active sessions (1–50)                              |    No    | `10`                    |
| `bot.serviceMessagesIntervalSec` | Service messages interval (thinking + tool calls), `0` = immediate |    No    | `5`                     |
| `bot.hideThinkingMessages`       | Hide `💭 Thinking...` service messages                             |    No    | `false`                 |
| `bot.hideToolCallMessages`       | Hide tool-call service messages (`💻 bash ...`, `📖 read ...`)     |    No    | `false`                 |
| `bot.messageFormatMode`          | Assistant reply formatting: `markdown` or `raw`                    |    No    | `markdown`              |
| `files.maxFileSizeKb`            | Max file size (KB) to send as document                             |    No    | `100`                   |
| `server.logLevel`                | Log level (`debug`, `info`, `warn`, `error`)                       |    No    | `info`                  |

> **Keep your `config.yaml` file private.** It contains your bot token. Never commit it to version control.

### Model Configuration

The model picker uses OpenCode local model state (`favorite` + `recent`):

- Favorites are shown first, then recent
- Models already in favorites are not duplicated in recent
- Current model is marked with `✅`
- If no model is selected, OpenCode uses the agent's default model

To add a model to favorites, open OpenCode TUI (`opencode`), go to model selection, and press **Cmd+F/Ctrl+F** on the model.

## Security

The bot uses a two-tier authorization system:

1. **Channel access** — users with a configured role (`discord.allowedRoleIds`) can send prompts in server channels
2. **DM access** — specific user IDs (`discord.allowedUserIds`) can interact via direct messages
3. **Session owner lock** — only one operator at a time; others see a "session busy" message

Since the bot runs locally and connects outward only (Discord Gateway + local OpenCode server), there is no external attack surface.

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

**Bot doesn't respond to commands**

- Verify `discord.token` is valid and the bot is in your server
- Verify `discord.serverId` matches your server ID (enable Developer Mode in Discord, right-click server, Copy ID)
- Check the bot has `applications.commands` scope

**"OpenCode server is not available"**

- Make sure `opencode serve` is running
- Check `opencode.apiUrl` (default: `http://localhost:4096`)

**No models in model picker**

- Add models to favorites in OpenCode TUI (Ctrl+F on a model)

**Commands not appearing in Discord**

- Ensure slash commands are registered (bot registers on startup)
- Try restarting the bot
- Check Discord Developer Portal for command registration errors

## Contributing

Please follow commit and release note conventions in [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgments

Originally inspired by [opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) by [Ruslan Grinev](https://github.com/grinev). This project has since been rewritten as a Discord-native client with significant additions.

**Developed with AI assistance using [OpenCode](https://opencode.ai) and Claude.**

## License

[MIT](LICENSE)

Originally inspired by [Ruslan Grinev](https://github.com/grinev)'s work | Developed by IH-Chung
