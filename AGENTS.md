# AGENTS.md

Instructions for AI agents working on this project.

## About the project

**opencode-chat-assistant** is a Discord bot that acts as a chat client for [OpenCode](https://opencode.ai).
It lets a user run and monitor coding tasks on a local machine through Discord.

- Product scope, features, and task list: [PRODUCT.md](./PRODUCT.md)
- Concept and design boundaries: [CONCEPT.md](./CONCEPT.md)
- Contribution rules: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Localization guide: [docs/LOCALIZATION_GUIDE.md](./docs/LOCALIZATION_GUIDE.md)

### Design principles

- Single-user, single-session, private-chat interaction model.
- No open ports or exposed APIs. The bot connects outward to Discord Gateway and local OpenCode server only.
- Discord slash commands and buttons are the primary UX (model/agent/variant/context controls).
- Only one interactive flow active at a time (question, permission, rename, inline menu, commands).
- Platforms: macOS, Windows, Linux. All three must be supported.

## Technology stack

- **Language:** TypeScript 5.x (strict mode)
- **Runtime:** Node.js 20+
- **Package manager:** npm
- **Module system:** ESM (`"type": "module"`, NodeNext resolution)
- **Build:** `tsc` (output to `dist/`)
- **Configuration:** YAML (`config.yaml` via `yaml`)
- **Logging:** custom level-based logger (`debug`, `info`, `warn`, `error`)

### Core dependencies

| Package            | Purpose                               |
| ------------------ | ------------------------------------- |
| `discord.js`       | Discord Bot API framework             |
| `@opencode-ai/sdk` | Official OpenCode Server SDK (v2 API) |
| `yaml`             | YAML configuration loading            |
| `better-sqlite3`   | Session directory cache fallback      |

### Dev dependencies

| Package                               | Purpose              |
| ------------------------------------- | -------------------- |
| `vitest`                              | Test framework       |
| `@vitest/coverage-v8`                 | Coverage reports     |
| `typescript`                          | Compiler             |
| `eslint` + `@typescript-eslint/*`     | Linting              |
| `prettier` + `eslint-config-prettier` | Formatting           |
| `tsx`                                 | TypeScript execution |

### Quality tooling config

- **TypeScript:** `tsconfig.json` — strict mode, ES2022 target, NodeNext modules
- **ESLint:** `.eslintrc.cjs` — `no-console: error` (except in `logger.ts`), `no-explicit-any: warn`
- **Prettier:** `.prettierrc` — double quotes, trailing commas, 100 char width, 2-space indent
- **Vitest:** `vitest.config.ts` — node env, setup file at `tests/setup.ts`, clearMocks/restoreMocks/mockReset

---

## Architecture

### High-level layers

```
1. CLI / Entry Points       — src/cli.ts, src/index.ts, src/cli/args.ts
2. Runtime / Bootstrap      — src/runtime/mode.ts, paths.ts, bootstrap.ts
3. Configuration            — src/config.ts
4. Application Bootstrap    — src/app/start-bot-app.ts
5. Platform Layer           — src/platform/index.ts (Discord bot)
6. OpenCode Client Layer    — src/opencode/client.ts, events.ts, message-poller.ts, question-poller.ts
7. State Managers           — src/settings/, src/session/, src/project/, src/model/,
                               src/agent/, src/variant/, src/interaction/, src/question/,
                               src/permission/, src/rename/, src/skill/
8. Summary Pipeline         — src/summary/aggregator.ts, formatter.ts, tool-message-batcher.ts
9. Process Manager          — src/process/manager.ts, types.ts
10. I18n                    — src/i18n/ (en, de, es, ru, zh)
11. Utilities               — src/utils/logger.ts, error-format.ts, safe-background-task.ts
```

### Data flow

```
Discord User
  |
  v
Discord.js Client (Gateway WebSocket)
  |
  |-- Slash commands: /status, /new, /abort, /sessions, /projects, /rename, /commands, /skills, /opencode_start, /opencode_stop, /help
  |-- Button interactions: session select, project select, question, permission, agent, model, variant, compact confirm, commands
  |-- Message handlers: text prompts, photos, documents
  |
  v
Managers + OpenCode Client
  |-- session.create / session.prompt / session.abort
  |-- project.list / project.current
  |-- model catalog + state file
  |-- agent list
  |-- skill list
  |
  v
OpenCode Server (localhost:4096)
  |
  v
SSE Events (subscribeToEvents)
  |
  v
SummaryAggregator.processEvent()
  |-- message.updated / message.part.updated -> onComplete (send assistant reply)
  |-- message.part.updated (tool) -> onTool / onToolFile (send tool notifications + code files)
  |-- question.asked -> onQuestion (show buttons)
  |-- permission.asked -> onPermission (show allow/reject buttons)
  |-- session.status (retry) -> onSessionRetry (show retry message)
  |-- session.error -> onSessionError (show error)
  |-- session.idle -> stop typing indicator
  |-- session.compacted -> onSessionCompacted (reload context)
  |-- session.diff -> onSessionDiff (update pinned message)
  |-- message.part.updated (reasoning) -> onThinking (show thinking indicator)
  |-- message.updated (tokens) -> onTokens (update pinned + keyboard context)
  |
  v
ToolMessageBatcher (debounced, configurable interval)
  |
  v
Discord API -> Discord User
```

### Startup sequence

```
1. src/index.ts or src/cli.ts
2. resolveRuntimeMode() — "sources" (git repo) or "installed" (npm global)
3. setRuntimeMode() — sets env var OPENCODE_CHAT_ASSISTANT_RUNTIME_MODE
4. [if installed] ensureRuntimeConfigForStart() — runs setup wizard if config.yaml missing
5. startBotApp():
   a. loadSettings() — read settings.json
   b. processManager.initialize() — restore PID if previously running
   c. reconcileStoredModelSelection() — validate stored model against catalog
   d. warmupSessionDirectoryCache() — load session directories from API + fallbacks
   e. createPlatformBot() — create Discord bot, register middleware, commands, handlers
   f. bot.start() — connect to Discord Gateway
```

---

## Directory structure

### Source (`src/`)

```
src/
  index.ts                  — Entry point for npm/npx execution (sources mode)
  cli.ts                    — CLI entry point (#!/usr/bin/env node, installed mode)
  cli/args.ts               — CLI argument parsing
  config.ts                 — Centralized config loader from config.yaml

  app/
    start-bot-app.ts        — Application bootstrap and initialization

  opencode/
    client.ts               — SDK client singleton (createOpencodeClient with optional Basic auth)
    events.ts               — SSE event subscription with exponential backoff reconnection
    message-poller.ts       — REST polling for external reply detection
    question-poller.ts      — Polling for pending questions
    processed-messages.ts   — Deduplication for SSE + polling

  settings/
    manager.ts              — Persistent settings.json storage (project, session, agent, model, pinned, server process, session cache)

  session/
    manager.ts              — Thin wrapper for session info persistence (get/set/clear via settings)
    cache-manager.ts        — Session directory cache (API sync + SQLite fallback + filesystem fallback)
    active-session-manager.ts — Active session owner tracking

  project/
    manager.ts              — Project listing (API + cache merge, git worktree filtering, sorted by lastUpdated)

  model/
    manager.ts              — Model selection, catalog validation, favorite/recent lists from OpenCode state file
    types.ts                — ModelInfo type, formatting utilities (formatModelForButton, formatModelForDisplay)
    capabilities.ts         — Model capability detection (image/PDF/audio/video input) with in-memory caching

  agent/
    manager.ts              — Agent mode (plan/build) selection, session history sync, default fallback
    types.ts                — AgentInfo type, emoji/display name formatting

  variant/
    manager.ts              — Model variant (reasoning mode) management, validation, formatting
    types.ts                — Re-exports VariantInfo from model/types.ts

  skill/
    manager.ts              — Skill listing and selection
    types.ts                — SkillInfo type

  interaction/
    manager.ts              — Interaction state machine (start/transition/clear, expiration, allowed commands)
    types.ts                — InteractionKind, ExpectedInput, BlockReason, GuardDecision types
    guard.ts                — Input validation against active interaction constraints
    cleanup.ts              — Atomic cleanup of all interaction-related state (question + permission + rename + interaction)

  question/
    manager.ts              — Multi-question poll state machine (option selection, custom input, multi-question navigation)
    types.ts                — Question, QuestionOption, QuestionAnswer types

  permission/
    manager.ts              — Permission request tracking by message ID
    types.ts                — PermissionRequest, PermissionReply types

  rename/
    manager.ts              — Session rename flow state (waiting for name, session info, message ID)

  process/
    manager.ts              — OpenCode server process start/stop (platform-specific: Windows taskkill vs Unix signals)
    types.ts                — ProcessState, ProcessOperationResult, ProcessManagerInterface

  summary/
    aggregator.ts           — SSE event processing, fires typed callbacks (onComplete, onTool, onQuestion, etc.)
    formatter.ts            — Message splitting for Discord limits, markdown formatting, code file preparation
    tool-message-batcher.ts — Batched tool message delivery with configurable interval, text packing

  runtime/
    mode.ts                 — Runtime mode resolver (sources vs installed), --mode CLI flag parsing
    paths.ts                — Platform-aware path resolver (appHome, config.yaml, settings.json, logs, run dirs)
    bootstrap.ts            — Interactive setup wizard (locale, token, user ID, API URL, credentials)

  i18n/
    index.ts                — Locale registry, t() translation function, interpolation, locale resolution
    en.ts                   — English dictionary (canonical, defines I18nKey type)
    de.ts                   — German dictionary
    es.ts                   — Spanish dictionary
    ru.ts                   — Russian dictionary
    zh.ts                   — Simplified Chinese dictionary

  utils/
    logger.ts               — Level-based logger (respects LOG_LEVEL, timestamp prefix)
    error-format.ts         — Error detail extraction (stack traces, JSON, truncation)
    safe-background-task.ts — Fire-and-forget async task runner with success/error hooks

  platform/
    types.ts                — PlatformAdapter interface, PlatformInfo, FileChange, TokensInfo (shared)
    index.ts                — Platform factory: createPlatformBot() returns Discord bot

    discord/
      adapter.ts            — DiscordAdapter implementing PlatformAdapter (uses discord.js Client)
      bot.ts                — Discord bot orchestrator, SSE wiring, slash command routing
      formatter.ts          — Discord Markdown formatting (2000 char limit), EmbedBuilder helpers
      pinned-manager.ts     — Pinned status embed manager with debounce
      keyboard-manager.ts   — Reply keyboard state and debounced updates
      commands/             — Discord slash command handlers + guild registration
        definitions.ts      — Centralized command list (BotCommandI18nDefinition[])
        register.ts         — Slash command registration
        abort.ts, agent.ts, commands.ts, compact.ts, help.ts, model.ts, new.ts,
        opencode-start.ts, opencode-stop.ts, projects.ts, rename.ts, sessions.ts,
        skills.ts, status.ts, variant.ts
      handlers/             — Button interactions + select menus
        agent.ts, model.ts, permission.ts, project.ts, question.ts, session.ts, variant.ts
      middleware/
        auth.ts             — Role check (guild), DM whitelist, session owner lock
```

### Tests (`tests/`)

```
tests/
  setup.ts                           — Global setup: ensureTestEnvironment + resetSingletonState
  helpers/
    test-environment.ts              — Sets required env vars for tests
    reset-singleton-state.ts         — Resets all singleton managers between tests
  config.test.ts
  cli/args.test.ts
  i18n/index.test.ts
  agent/types.test.ts
  interaction/cleanup.test.ts, guard.test.ts, manager.test.ts
  model/capabilities.test.ts, manager.test.ts, types.test.ts
  opencode/events.test.ts, message-poller.test.ts, processed-messages.test.ts, question-poller.test.ts
  platform/discord/adapter.test.ts, bot.test.ts, formatter.test.ts
  platform/discord/commands/register.test.ts
  platform/discord/handlers/agent.test.ts, model.test.ts, permission.test.ts, question.test.ts, variant.test.ts
  platform/discord/middleware/auth.test.ts
  platform/discord/session-history.test.ts
  platform/index.test.ts, integration.test.ts, types.test.ts
  process/manager.test.ts
  project/manager.test.ts
  question/manager.test.ts
  rename/manager.test.ts
  runtime/bootstrap.test.ts, mode.test.ts, paths.test.ts
  session/active-session-manager.test.ts, cache-manager.test.ts
  settings/manager.test.ts
  skill/manager.test.ts
  summary/aggregator.test.ts, aggregator-question-external.test.ts, formatter.test.ts, tool-message-batcher.test.ts
  utils/error-format.test.ts
```

### Scripts (`scripts/`)

```
scripts/
  generate-release-notes.mjs        — Auto-generate release notes from git log
  release-notes-preview.mjs         — Preview release notes before publishing
  release-prepare.mjs               — Prepare release (version bump, changelog)
```

---

## AI agent behavior rules

### Communication

- **Response language:** Reply in the same language the user uses in their questions.
- **Clarifications:** If plan confirmation is needed, use the `question` tool. Do not make major decisions (architecture changes, mass deletion, risky changes) without explicit confirmation.

### Git

- **Commits:** Never create commits automatically. Commit only when the user explicitly asks.
- **Conventional Commits:** `<type>(<scope>): <description>` (see [CONTRIBUTING.md](./CONTRIBUTING.md))

### Windows / PowerShell

- Keep in mind the runtime environment is Windows.
- Avoid fragile one-liners that can break in PowerShell.
- Use absolute paths when working with file tools (`read`, `write`, `edit`).

---

## Coding rules

### Language

- Code, identifiers, comments, and in-code documentation must be in English.
- User-facing messages must be localized through i18n (`t()` function).

### Code style

- Use TypeScript strict mode.
- Use ESLint + Prettier (run `npm run lint` and `npm run format`).
- Prefer `const` over `let`.
- Use clear names and avoid unnecessary abbreviations.
- Keep functions small and focused.
- Prefer `async/await` over chained `.then()`.
- Use `.js` extension in all relative imports (ESM requirement).

### Error handling

- Use `try/catch` around async operations.
- Log errors with context (session ID, operation type, etc.).
- Send understandable error messages to users via `t()` i18n keys.
- Never expose stack traces to users.
- Use `safeBackgroundTask()` for fire-and-forget async work.

### Bot commands

The command list is centralized in `src/platform/discord/commands/definitions.ts`.

```typescript
const COMMAND_DEFINITIONS: BotCommandI18nDefinition[] = [
  { command: "status", descriptionKey: "cmd.description.status" },
  { command: "new", descriptionKey: "cmd.description.new" },
  { command: "abort", descriptionKey: "cmd.description.stop" },
  { command: "sessions", descriptionKey: "cmd.description.sessions" },
  { command: "projects", descriptionKey: "cmd.description.projects" },
  { command: "rename", descriptionKey: "cmd.description.rename" },
  { command: "commands", descriptionKey: "cmd.description.commands" },
  { command: "opencode_start", descriptionKey: "cmd.description.opencode_start" },
  { command: "opencode_stop", descriptionKey: "cmd.description.opencode_stop" },
  { command: "help", descriptionKey: "cmd.description.help" },
];
```

Important:

- When adding a command, update `definitions.ts` only.
- The same source is used for Discord slash command registration and help/docs.
- Do not duplicate command lists elsewhere.
- Register the command handler in `src/platform/discord/bot.ts`.

### Adding a new handler

1. Create handler file in `src/platform/discord/handlers/` or `src/platform/discord/commands/`.
2. Export handler function(s).
3. Import and register in `src/platform/discord/bot.ts`.
4. If it involves an interactive flow, use `interactionManager.start()` and handle cleanup.
5. Add i18n keys to `src/i18n/en.ts` (canonical), then to all other locale files.
6. Add tests in `tests/platform/discord/handlers/` or `tests/platform/discord/commands/`.

### Logging

The project uses `src/utils/logger.ts` with level-based logging.

Levels:

- **DEBUG** - detailed diagnostics (callbacks, keyboard build, SSE internals, polling flow)
- **INFO** - key lifecycle events (session/task start/finish, status changes)
- **WARN** - recoverable issues (timeouts, retries, unauthorized attempts)
- **ERROR** - critical failures requiring attention

```typescript
import { logger } from "../utils/logger.js";

logger.debug("[Component] Detailed operation", details);
logger.info("[Component] Important event occurred");
logger.warn("[Component] Recoverable problem", error);
logger.error("[Component] Critical failure", error);
```

Important:

- Do not use raw `console.log` / `console.error` directly in feature code; use `logger`.
- Put internal diagnostics under `debug`.
- Keep important operational events under `info`.
- Default level is `info`.
- Prefix log messages with `[ComponentName]` for grep-ability.

---

## Key patterns

### Singleton managers

All managers are module-level singletons (not classes with `new`). They export standalone functions or a singleton object:

```typescript
// Function-based (settings, session, project):
export function getCurrentProject(): ProjectInfo | undefined { ... }
export function setCurrentProject(info: ProjectInfo): void { ... }

// Object-based (interaction, question, permission, rename, keyboard, pinned):
export const interactionManager = { start(), getSnapshot(), transition(), clear(), ... };
export const questionManager = { startQuestions(), getCurrentQuestion(), ... };
```

State is reset between tests via `tests/helpers/reset-singleton-state.ts`.

### Interaction flow control

The interaction system ensures only one interactive flow is active at a time:

1. Start: `interactionManager.start({ kind, expectedInput, allowedCommands })`.
2. Guard: `interactionGuardMiddleware` calls `resolveInteractionGuardDecision(ctx)` for every incoming update.
3. Block: If input doesn't match expectations, a contextual hint is sent.
4. Cleanup: `clearAllInteractionState(reason)` atomically clears question + permission + rename + interaction state.
5. Allowed utility commands during interactions: `/help`, `/status`, `/abort`.

Interaction kinds: `"inline"` | `"permission"` | `"question"` | `"rename"` | `"custom"`.

### Fire-and-forget prompt dispatch

`session.prompt()` is called via `safeBackgroundTask()` — the handler does NOT await it. This is critical: if the handler blocks on `session.prompt`, Discord cannot process incoming interactions (button presses, slash commands) during task execution. Results arrive via SSE events.

### Event loop yielding

In `src/opencode/events.ts`, each SSE event processing yields to the event loop via `setImmediate()` before dispatching. This prevents SSE event floods from starving the Discord bot framework's event loop.

### Keyboard update debouncing

`keyboardManager` debounces keyboard sends with a 2-second minimum interval to reduce Discord API call frequency.

### Tool message batching

`ToolMessageBatcher` collects tool call notifications over a configurable interval (default 5s) and sends them as batched messages to reduce Discord API call frequency.

---

## State management

### Persistent state (`settings.json`)

Managed by `src/settings/manager.ts`. Survives bot restarts.

| Field                   | Type                        | Purpose                                        |
| ----------------------- | --------------------------- | ---------------------------------------------- |
| `currentProject`        | `ProjectInfo`               | Selected project (id, worktree, name)          |
| `currentSession`        | `SessionInfo`               | Active session (id, title, directory)          |
| `currentAgent`          | `string`                    | Agent mode name (e.g., "build", "plan")        |
| `currentModel`          | `ModelInfo`                 | Selected model (providerID, modelID, variant)  |
| `pinnedMessageId`       | `number`                    | Discord message ID of pinned status message    |
| `serverProcess`         | `ServerProcessInfo`         | PID and start time of managed OpenCode server  |
| `sessionDirectoryCache` | `SessionDirectoryCacheInfo` | Cached session directories for project listing |

Write operations use a sequential queue (`settingsWriteQueue`) to prevent concurrent file writes.

### In-memory state

| Manager                | State                                                          | Purpose                  |
| ---------------------- | -------------------------------------------------------------- | ------------------------ |
| `interactionManager`   | Active interaction (kind, expected input, expiration)          | Input flow control       |
| `questionManager`      | Question list, current index, selected options, custom answers | Multi-question polls     |
| `permissionManager`    | Permission requests keyed by message ID                        | Permission reply routing |
| `renameManager`        | Waiting flag, session info, message ID                         | Rename flow state        |
| `keyboardManager`      | Current agent/model/variant/context display state              | Reply keyboard rendering |
| `pinnedMessageManager` | Session title, tokens, file changes, message ID                | Pinned status message    |
| `summaryAggregator`    | Message parts, processed tools, typing timer                   | SSE event accumulation   |
| `toolMessageBatcher`   | Queued text/file messages per session                          | Batched delivery         |

### Manager interdependencies

```
settingsManager ← root dependency (all managers persist through it)
  ├── sessionManager (thin wrapper)
  ├── modelManager (stores current model)
  ├── agentManager (stores current agent)
  └── pinnedMessageManager (stores pinned message ID)

interactionManager
  ├── questionManager (cleared together)
  ├── permissionManager (cleared together)
  └── renameManager (cleared together)
  → clearAllInteractionState() clears all four atomically

modelManager → used by keyboardManager, variantManager, pinnedMessageManager
agentManager → used by keyboardManager
variantManager → reads/writes modelManager

summaryAggregator → fires callbacks to questionManager, permissionManager, pinnedMessageManager
pinnedMessageManager → triggers keyboardManager updates via callback
```

---

## OpenCode SDK usage

The project uses `@opencode-ai/sdk/v2` (v2 API).

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { Event, FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";

// Client singleton (src/opencode/client.ts)
export const opencodeClient = createOpencodeClient({
  baseUrl: config.opencode.apiUrl,
  headers: config.opencode.password ? { Authorization: getAuth() } : undefined,
});

// Common API calls used in the project:
await opencodeClient.project.list();
await opencodeClient.session.create({ directory });
await opencodeClient.session.prompt({ sessionID, directory, parts, model, agent, variant });
await opencodeClient.session.abort({ sessionID, directory });
await opencodeClient.session.status({ directory });
await opencodeClient.session.list({ directory });
await opencodeClient.session.rename({ sessionID, directory, title });
await opencodeClient.session.compact({ sessionID, directory });

// SSE events
const result = await opencodeClient.event.subscribe({ directory }, { signal });
for await (const event of result.stream) { ... }

// Questions and permissions
await opencodeClient.question.reply({ id: requestID, answer });
await opencodeClient.permission.reply({ id: requestID, allow });
```

### SSE event types handled

| Event Type                | Handler                                     | Purpose                                                 |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `message.updated`         | `handleMessageUpdated`                      | Track assistant message lifecycle (created → completed) |
| `message.part.updated`    | `handleMessagePartUpdated`                  | Text chunks, reasoning (thinking), tool calls           |
| `session.status`          | `handleSessionStatus`                       | Detect retry status                                     |
| `session.idle`            | `handleSessionIdle`                         | Stop typing indicator                                   |
| `session.compacted`       | `handleSessionCompacted`                    | Reload context after compaction                         |
| `session.error`           | `handleSessionError`                        | Show error to user                                      |
| `session.diff`            | `handleSessionDiff`                         | Update pinned message file changes                      |
| `session.created/updated` | Direct handler in `platform/discord/bot.ts` | Ingest session info for cache                           |
| `question.asked`          | `handleQuestionAsked`                       | Show question poll to user                              |
| `permission.asked`        | `handlePermissionAsked`                     | Show permission request to user                         |

---

## I18n system

### Structure

- Canonical dictionary: `src/i18n/en.ts` (exports `I18nDictionary` type and `I18nKey` type)
- Other locales: `de.ts`, `es.ts`, `ru.ts`, `zh.ts` (must implement all keys from `en.ts`)
- Registry: `src/i18n/index.ts` (LOCALE_DEFINITIONS array, `t()` function)

### Usage

```typescript
import { t } from "../i18n/index.js";

// Simple key
t("bot.thinking"); // "Thinking..."

// With interpolation
t("bot.session_created", { title: "My Session" }); // "Session created: My Session"

// With explicit locale
t("help.title", {}, "de");
```

### Adding a new locale

Follow [docs/LOCALIZATION_GUIDE.md](./docs/LOCALIZATION_GUIDE.md):

1. Create `src/i18n/<locale>.ts` implementing all keys from `en.ts`.
2. Import and register in `src/i18n/index.ts` (add to `LOCALE_DEFINITIONS`).
3. Update `README.md` and `config.yaml.example`.
4. Run build + lint + test.

---

## Testing

### What to test

- Unit tests for business logic, formatters, managers, runtime helpers.
- Integration-style tests around OpenCode SDK interaction using mocks.
- Focus on critical paths; avoid over-testing trivial code.

### Test structure

- Tests live in `tests/` (organized by module, mirroring `src/` structure).
- Use descriptive test names.
- Follow Arrange-Act-Assert.
- Use `vi.mock()` for external dependencies.

### Test setup

`tests/setup.ts` runs before every test:

- `ensureTestEnvironment()` — sets required env vars (`OPENCODE_CHAT_ASSISTANT_HOME`).
- `resetSingletonState()` — resets all singleton managers to fresh state.
- `afterEach` — restores mocks, unstubs envs/globals, uses real timers.

### Running tests

```bash
npm test              # Run all tests
npm run test:coverage # Run with coverage report
npm run lint          # ESLint (zero warnings policy)
npm run build         # TypeScript compilation
```

---

## Configuration

### Configuration (config.yaml)

| Key                              | Required | Default                 | Purpose                                 |
| -------------------------------- | :------: | ----------------------- | --------------------------------------- |
| `discord.token`                  |   Yes    | —                       | Bot token from Discord Developer Portal |
| `discord.serverId`               |   Yes    | —                       | Discord server ID                       |
| `discord.allowedRoleIds`         |    No    | —                       | Role IDs for channel access             |
| `discord.allowedUserIds`         |    No    | —                       | User IDs for DM access                  |
| `opencode.apiUrl`                |    No    | `http://localhost:4096` | OpenCode server URL                     |
| `opencode.username`              |    No    | `opencode`              | Server auth username                    |
| `opencode.password`              |    No    | —                       | Server auth password                    |
| `bot.locale`                     |    No    | `en`                    | Bot UI language (en/de/es/ru/zh)        |
| `bot.sessionsListLimit`          |    No    | `10`                    | Sessions per page                       |
| `bot.projectsListLimit`          |    No    | `10`                    | Projects per page                       |
| `bot.modelsListLimit`            |    No    | `10`                    | Models per page                         |
| `bot.serviceMessagesIntervalSec` |    No    | `5`                     | Tool message batching interval          |
| `bot.hideThinkingMessages`       |    No    | `false`                 | Hide thinking indicators                |
| `bot.hideToolCallMessages`       |    No    | `false`                 | Hide tool call messages                 |
| `bot.messageFormatMode`          |    No    | `markdown`              | `markdown` or `raw`                     |
| `files.maxFileSizeKb`            |    No    | `100`                   | Max file size for document sending      |
| `server.logLevel`                |    No    | `info`                  | Log level                               |

### Runtime modes

| Mode        | Entry                        | App home                  | Usage       |
| ----------- | ---------------------------- | ------------------------- | ----------- |
| `sources`   | `src/index.ts` (npm run dev) | Current working directory | Development |
| `installed` | `dist/cli.js` (npx / global) | Platform app data dir     | Production  |

### Platform paths (installed mode)

- **Windows:** `%APPDATA%\opencode-chat-assistant\config.yaml`
- **macOS:** `~/Library/Application Support/opencode-chat-assistant/config.yaml`
- **Linux:** `~/.config/opencode-chat-assistant/config.yaml`

Override with `OPENCODE_CHAT_ASSISTANT_HOME` env var.

---

## Workflow

1. Read [PRODUCT.md](./PRODUCT.md) to understand scope and status.
2. Inspect existing code before adding or changing components.
3. Align major architecture changes (including new dependencies) with the user first.
4. Add or update tests for new functionality.
5. After code changes, run quality checks: `npm run build`, `npm run lint`, and `npm test`.
6. Update checkboxes in `PRODUCT.md` when relevant tasks are completed.
7. Keep code clean, consistent, and maintainable.

### Common tasks

**Add a new bot command:**

1. Add entry to `COMMAND_DEFINITIONS` in `src/platform/discord/commands/definitions.ts`.
2. Create handler in `src/platform/discord/commands/<name>.ts`.
3. Register the command handler in `src/platform/discord/bot.ts`.
4. Add i18n key `cmd.description.<name>` to all locale files.
5. Add tests in `tests/platform/discord/commands/<name>.test.ts`.

**Add a new interactive flow:**

1. Create manager in `src/<feature>/manager.ts` with state tracking.
2. Start interaction via `interactionManager.start({ kind, expectedInput, allowedCommands })`.
3. Handle callbacks/text in `src/platform/discord/handlers/<feature>.ts`.
4. Register cleanup in `src/interaction/cleanup.ts` (`clearAllInteractionState`).
5. Handle the flow in `src/platform/discord/bot.ts` interaction handler.

**Add a new locale:**
Follow [docs/LOCALIZATION_GUIDE.md](./docs/LOCALIZATION_GUIDE.md).

**Add a new SSE event handler:**

1. Add case in `SummaryAggregator.processEvent()` switch statement.
2. Add callback type and setter in the aggregator.
3. Wire callback in `src/platform/discord/bot.ts` `ensureEventSubscription()`.
