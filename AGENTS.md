# AGENTS.md

Instructions for AI agents working on this project.

## About the project

**opencode-telegram-bot** is a Telegram bot that acts as a mobile client for [OpenCode](https://opencode.ai).
It lets a user run and monitor coding tasks on a local machine through Telegram.

- Product scope, features, and task list: [PRODUCT.md](./PRODUCT.md)
- Concept and design boundaries: [CONCEPT.md](./CONCEPT.md)
- Contribution rules: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Localization guide: [docs/LOCALIZATION_GUIDE.md](./docs/LOCALIZATION_GUIDE.md)

### Design principles

- Single-user, single-session, private-chat interaction model.
- No open ports or exposed APIs. The bot connects outward to Telegram API and local OpenCode server only.
- Telegram reply keyboard is a core UX element (model/agent/variant/context controls).
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

| Package                | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `grammy`               | Telegram Bot API framework (https://grammy.dev/) |
| `@grammyjs/menu`       | Inline keyboards and menus                       |
| `@opencode-ai/sdk`     | Official OpenCode Server SDK (v2 API)            |
| `yaml`                 | YAML configuration loading                       |
| `better-sqlite3`       | Session directory cache fallback                 |
| `socks-proxy-agent`    | SOCKS proxy support for Telegram API             |
| `https-proxy-agent`    | HTTP/HTTPS proxy support for Telegram API        |
| `telegram-markdown-v2` | Markdown escaping for Telegram MarkdownV2        |

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
5. Bot Layer                — src/bot/ (middleware, commands, handlers, utils)
6. OpenCode Client Layer    — src/opencode/client.ts, events.ts
7. State Managers           — src/settings/, src/session/, src/project/, src/model/,
                              src/agent/, src/variant/, src/keyboard/, src/pinned/,
                              src/interaction/, src/question/, src/permission/, src/rename/
8. Summary Pipeline         — src/summary/aggregator.ts, formatter.ts, tool-message-batcher.ts
9. Process Manager          — src/process/manager.ts, types.ts
10. I18n                    — src/i18n/ (en, de, es, ru, zh)
11. STT                     — src/stt/client.ts
12. Utilities               — src/utils/logger.ts, error-format.ts, safe-background-task.ts
```

### Data flow

```
Telegram User
  |
  v
grammY Bot (long polling via getUpdates)
  |
  |-- Middleware chain: [debug log] -> [auth] -> [ensureCommands] -> [interactionGuard]
  |
  |-- Commands: /status, /new, /abort, /sessions, /projects, /rename, /commands, /opencode_start, /opencode_stop, /help
  |-- Reply keyboard hears: agent button, model button, variant button, context button
  |-- Callback queries: session select, project select, question, permission, agent, model, variant, compact confirm, rename cancel, commands
  |-- Message handlers: text prompts, voice/audio (STT), photos, documents
  |
  v
Managers + OpenCode Client
  |-- session.create / session.prompt / session.abort
  |-- project.list / project.current
  |-- model catalog + state file
  |-- agent list
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
  |-- question.asked -> onQuestion (show inline buttons)
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
Telegram Bot API -> Telegram User
```

### Startup sequence

```
1. src/index.ts or src/cli.ts
2. resolveRuntimeMode() — "sources" (git repo) or "installed" (npm global)
3. setRuntimeMode() — sets env var OPENCODE_TELEGRAM_RUNTIME_MODE
4. [if installed] ensureRuntimeConfigForStart() — runs setup wizard if config.yaml missing
5. startBotApp():
   a. loadSettings() — read settings.json
   b. processManager.initialize() — restore PID if previously running
   c. reconcileStoredModelSelection() — validate stored model against catalog
   d. warmupSessionDirectoryCache() — load session directories from API + fallbacks
   e. createBot() — register middleware, commands, handlers
   f. bot.start() — begin long polling
```

---

## Directory structure

### Source (`src/`)

```
src/
  index.ts                  — Entry point for npm/npx execution (sources mode)
  cli.ts                    — CLI entry point (#!/usr/bin/env node, installed mode)
  config.ts                 — Centralized config loader from config.yaml

  app/
    start-bot-app.ts        — Application bootstrap and initialization

  bot/
    index.ts                — Bot creation, middleware chain, event wiring (859 lines, main orchestrator)
    message-patterns.ts     — Regex patterns for reply keyboard button detection

    commands/
      definitions.ts        — Centralized command list (BotCommandI18nDefinition[])
      start.ts              — /start command (welcome message)
      help.ts               — /help command (command list)
      status.ts             — /status command (server health, project, session, model info)
      new.ts                — /new command (create new session)
      abort.ts              — /abort command (interrupt current task)
      sessions.ts           — /sessions command (list + switch sessions, pagination)
      projects.ts           — /projects command (list + switch projects, pagination)
      rename.ts             — /rename command (rename current session)
      commands.ts           — /commands command (browse/run custom commands + built-ins)
      opencode-start.ts     — /opencode_start command (start server process)
      opencode-stop.ts      — /opencode_stop command (stop server process)
      models.ts             — Model-related command helpers

    handlers/
      prompt.ts             — Core prompt processing (project/session check, create session, fire-and-forget prompt)
      question.ts           — Question callback + text answer handling (multi-question polls)
      permission.ts         — Permission request display + callback handling (allow/always/reject)
      model.ts              — Model selection inline menu
      agent.ts              — Agent mode selection inline menu
      variant.ts            — Model variant selection inline menu
      context.ts            — Context button press + compact confirmation
      voice.ts              — Voice/audio message handling (STT transcription -> prompt)
      document.ts           — Document message handling (PDF, text files -> prompt)
      inline-menu.ts        — Generic inline menu cancel handler

    middleware/
      auth.ts               — User ID whitelist check (silently ignores unauthorized)
      interaction-guard.ts  — Block input during active interactions (contextual messages)
      unknown-command.ts    — Fallback for unrecognized slash commands

    utils/
      keyboard.ts           — Reply keyboard builder (createMainKeyboard)
      commands.ts           — Command registration helpers
      file-download.ts      — Telegram file download + data URI conversion
      send-with-markdown-fallback.ts — Send with MarkdownV2, fallback to plain text on parse error

  opencode/
    client.ts               — SDK client singleton (createOpencodeClient with optional Basic auth)
    events.ts               — SSE event subscription with exponential backoff reconnection

  settings/
    manager.ts              — Persistent settings.json storage (project, session, agent, model, pinned, server process, session cache)

  session/
    manager.ts              — Thin wrapper for session info persistence (get/set/clear via settings)
    cache-manager.ts        — Session directory cache (API sync + SQLite fallback + filesystem fallback)

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

  keyboard/
    manager.ts              — Reply keyboard state, debounced updates (2s min interval), context/model/agent display
    types.ts                — KeyboardState interface (contextInfo, currentModel, currentAgent, variantName)

  pinned/
    manager.ts              — Pinned status message (session title, project, model, context tokens, changed files)
    types.ts                — PinnedMessageState, FileChange types

  interaction/
    manager.ts              — Interaction state machine (start/transition/clear, expiration, allowed commands)
    types.ts                — InteractionKind, ExpectedInput, BlockReason, GuardDecision types
    guard.ts                — Input validation against active interaction constraints
    cleanup.ts              — Atomic cleanup of all interaction-related state (question + permission + rename + interaction)

  question/
    manager.ts              — Multi-question poll state machine (option selection, custom input, multi-question navigation)
    types.ts                — Question, QuestionOption, QuestionAnswer types

  permission/
    manager.ts              — Permission request tracking by Telegram message ID
    types.ts                — PermissionRequest, PermissionReply types

  rename/
    manager.ts              — Session rename flow state (waiting for name, session info, message ID)

  process/
    manager.ts              — OpenCode server process start/stop (platform-specific: Windows taskkill vs Unix signals)
    types.ts                — ProcessState, ProcessOperationResult, ProcessManagerInterface

  summary/
    aggregator.ts           — SSE event processing, fires typed callbacks (onComplete, onTool, onQuestion, etc.)
    formatter.ts            — Message splitting for Telegram limits, MarkdownV2 formatting, code file preparation
    tool-message-batcher.ts — Batched tool message delivery with configurable interval, text packing

  stt/
    client.ts               — Whisper-compatible STT client (multipart POST to /audio/transcriptions, 60s timeout)

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
    index.ts                — Platform factory: createPlatformBot("telegram" | "discord")

    telegram/
      adapter.ts            — TelegramAdapter implementing PlatformAdapter (uses grammY Api)
      bot.ts                — Telegram bot orchestrator, SSE wiring, event handlers (main orchestrator)
      formatter.ts          — Telegram MarkdownV2 formatting, TELEGRAM_MESSAGE_LIMIT, TELEGRAM_FORMAT_CONFIG
      pinned-manager.ts     — Pinned status message management with debounce
      keyboard-manager.ts   — Reply keyboard state and debounced updates
      commands/             — 14 Telegram command handlers (/status, /new, /abort, etc.)
      handlers/             — Inline callbacks (question, permission, model, agent, variant, context)
      middleware/           — Auth (user ID whitelist), interaction guard, unknown command

    discord/
      adapter.ts            — DiscordAdapter implementing PlatformAdapter (uses discord.js Client)
      bot.ts                — Discord bot orchestrator, SSE wiring, slash command routing
      formatter.ts          — Discord Markdown formatting (2000 char limit), EmbedBuilder helpers
      pinned-manager.ts     — Pinned status embed manager with debounce
      commands/             — 14 Discord slash command handlers + guild registration
      handlers/             — Button interactions (question/permission) + select menus (model/agent/variant)
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
  bot/
    commands/                        — Tests for each command handler
    handlers/                        — Tests for question, permission, voice, document, inline-menu
    middleware/                       — Tests for interaction-guard, unknown-command
    utils/                           — Tests for keyboard, commands, file-download, send-with-markdown-fallback
    message-patterns.test.ts
  interaction/manager.test.ts, guard.test.ts, cleanup.test.ts
  model/manager.test.ts, types.test.ts, capabilities.test.ts
  opencode/events.test.ts
  permission/ (via handlers)
  process/manager.test.ts
  project/manager.test.ts
  question/manager.test.ts
  rename/manager.test.ts
  runtime/mode.test.ts, paths.test.ts, bootstrap.test.ts
  session/cache-manager.test.ts
  stt/client.test.ts
  summary/aggregator.test.ts, formatter.test.ts, tool-message-batcher.test.ts
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
- User-facing Telegram messages must be localized through i18n (`t()` function).

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

The command list is centralized in `src/bot/commands/definitions.ts`.

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
- The same source is used for Telegram `setMyCommands` and help/docs.
- Do not duplicate command lists elsewhere.
- Register the command handler in `src/bot/index.ts` via `bot.command("name", handler)`.

### Adding a new handler

1. Create handler file in `src/bot/handlers/` or `src/bot/commands/`.
2. Export handler function(s).
3. Import and register in `src/bot/index.ts`.
4. If it involves an interactive flow, use `interactionManager.start()` and handle cleanup.
5. Add i18n keys to `src/i18n/en.ts` (canonical), then to all other locale files.
6. Add tests in `tests/bot/handlers/` or `tests/bot/commands/`.

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

`session.prompt()` is called via `safeBackgroundTask()` — the handler does NOT await it. This is critical: if the handler blocks on `session.prompt`, grammY cannot call `getUpdates`, which blocks receiving callback queries (button presses) during task execution. Results arrive via SSE events.

### Event loop yielding

In `src/opencode/events.ts`, each SSE event processing yields to the event loop via `setImmediate()` before dispatching. This prevents SSE event floods from starving grammY's polling loop.

### Keyboard update debouncing

`keyboardManager` debounces keyboard sends with a 2-second minimum interval to avoid Telegram rate limits (~1 msg/sec/chat).

### Tool message batching

`ToolMessageBatcher` collects tool call notifications over a configurable interval (default 5s) and sends them as batched messages to reduce Telegram API calls.

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
| `pinnedMessageId`       | `number`                    | Telegram message ID of pinned status message   |
| `serverProcess`         | `ServerProcessInfo`         | PID and start time of managed OpenCode server  |
| `sessionDirectoryCache` | `SessionDirectoryCacheInfo` | Cached session directories for project listing |

Write operations use a sequential queue (`settingsWriteQueue`) to prevent concurrent file writes.

### In-memory state

| Manager                | State                                                          | Purpose                  |
| ---------------------- | -------------------------------------------------------------- | ------------------------ |
| `interactionManager`   | Active interaction (kind, expected input, expiration)          | Input flow control       |
| `questionManager`      | Question list, current index, selected options, custom answers | Multi-question polls     |
| `permissionManager`    | Permission requests keyed by Telegram message ID               | Permission reply routing |
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

| Event Type                | Handler                          | Purpose                                                 |
| ------------------------- | -------------------------------- | ------------------------------------------------------- |
| `message.updated`         | `handleMessageUpdated`           | Track assistant message lifecycle (created → completed) |
| `message.part.updated`    | `handleMessagePartUpdated`       | Text chunks, reasoning (thinking), tool calls           |
| `session.status`          | `handleSessionStatus`            | Detect retry status                                     |
| `session.idle`            | `handleSessionIdle`              | Stop typing indicator                                   |
| `session.compacted`       | `handleSessionCompacted`         | Reload context after compaction                         |
| `session.error`           | `handleSessionError`             | Show error to user                                      |
| `session.diff`            | `handleSessionDiff`              | Update pinned message file changes                      |
| `session.created/updated` | Direct handler in `bot/index.ts` | Ingest session info for cache                           |
| `question.asked`          | `handleQuestionAsked`            | Show question poll to user                              |
| `permission.asked`        | `handlePermissionAsked`          | Show permission request to user                         |

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

- `ensureTestEnvironment()` — sets required env vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`).
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

| Key                              | Required | Default                  | Purpose                              |
| -------------------------------- | :------: | ------------------------ | ------------------------------------ |
| `telegram.token`                 |   Yes    | —                        | Bot token from @BotFather            |
| `telegram.allowedUserId`         |   Yes    | —                        | Numeric Telegram user ID             |
| `telegram.proxyUrl`              |    No    | —                        | Proxy for Telegram API (socks5/http) |
| `opencode.apiUrl`                |    No    | `http://localhost:4096`  | OpenCode server URL                  |
| `opencode.username`              |    No    | `opencode`               | Server auth username                 |
| `opencode.password`              |    No    | —                        | Server auth password                 |
| `bot.locale`                     |    No    | `en`                     | Bot UI language (en/de/es/ru/zh)     |
| `bot.sessionsListLimit`          |    No    | `10`                     | Sessions per page                    |
| `bot.projectsListLimit`          |    No    | `10`                     | Projects per page                    |
| `bot.modelsListLimit`            |    No    | `10`                     | Models per page                      |
| `bot.serviceMessagesIntervalSec` |    No    | `5`                      | Tool message batching interval       |
| `bot.hideThinkingMessages`       |    No    | `false`                  | Hide thinking indicators             |
| `bot.hideToolCallMessages`       |    No    | `false`                  | Hide tool call messages              |
| `bot.messageFormatMode`          |    No    | `markdown`               | `markdown` or `raw`                  |
| `files.maxFileSizeKb`            |    No    | `100`                    | Max file size for document sending   |
| `stt.apiUrl`                     |    No    | —                        | Whisper-compatible API base URL      |
| `stt.apiKey`                     |    No    | —                        | STT API key                          |
| `stt.model`                      |    No    | `whisper-large-v3-turbo` | STT model name                       |
| `stt.language`                   |    No    | —                        | Language hint for STT                |
| `server.logLevel`                |    No    | `info`                   | Log level                            |

### Runtime modes

| Mode        | Entry                        | App home                  | Usage       |
| ----------- | ---------------------------- | ------------------------- | ----------- |
| `sources`   | `src/index.ts` (npm run dev) | Current working directory | Development |
| `installed` | `dist/cli.js` (npx / global) | Platform app data dir     | Production  |

### Platform paths (installed mode)

- **Windows:** `%APPDATA%\opencode-telegram-bot\config.yaml`
- **macOS:** `~/Library/Application Support/opencode-telegram-bot/config.yaml`
- **Linux:** `~/.config/opencode-telegram-bot/config.yaml`

Override with `OPENCODE_TELEGRAM_HOME` env var.

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

1. Add entry to `COMMAND_DEFINITIONS` in `src/bot/commands/definitions.ts`.
2. Create handler in `src/bot/commands/<name>.ts`.
3. Register with `bot.command("<name>", handler)` in `src/bot/index.ts`.
4. Add i18n key `cmd.description.<name>` to all locale files.
5. Add tests in `tests/bot/commands/<name>.test.ts`.

**Add a new interactive flow:**

1. Create manager in `src/<feature>/manager.ts` with state tracking.
2. Start interaction via `interactionManager.start({ kind, expectedInput, allowedCommands })`.
3. Handle callbacks/text in `src/bot/handlers/<feature>.ts`.
4. Register cleanup in `src/interaction/cleanup.ts` (`clearAllInteractionState`).
5. Handle the flow in `src/bot/index.ts` callback query handler and/or text handler.

**Add a new locale:**
Follow [docs/LOCALIZATION_GUIDE.md](./docs/LOCALIZATION_GUIDE.md).

**Add a new SSE event handler:**

1. Add case in `SummaryAggregator.processEvent()` switch statement.
2. Add callback type and setter in the aggregator.
3. Wire callback in `src/bot/index.ts` `ensureEventSubscription()`.
