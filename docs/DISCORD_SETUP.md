# Discord Platform Setup Guide

This guide walks through creating a Discord bot for OpenCode and configuring it to use the Discord platform.

## Prerequisites

- Discord account and a server where you have administrator access
- Node.js 20+ installed
- OpenCode server running (`opencode serve`)

---

## Step 1: Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** in the top right
3. Name it (e.g., "OpenCode Bot") and click **Create**
4. Note the **Application ID** from the General Information page — you'll need it for the invite URL

---

## Step 2: Create a Bot User

1. In your application, go to the **Bot** tab on the left sidebar
2. Click **Reset Token** and copy the token — save it, you can only see it once
3. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** (required for reading message text)
   - **Server Members Intent** (required for role checking)
4. Click **Save Changes**

---

## Step 3: Invite the Bot to Your Server

Build the invite URL by replacing `YOUR_APP_ID`:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&permissions=274877991936&scope=bot%20applications.commands
```

Required permissions included in `274877991936`:

- View Channels
- Send Messages
- Read Message History
- Add Reactions
- Manage Messages (for pinning status messages)
- Use Application Commands (for slash commands)

Open this URL in your browser, select your server, and click **Authorize**.

---

## Step 4: Get Your Server ID

1. Open Discord Settings → **Advanced** → Enable **Developer Mode**
2. Right-click your server icon in the sidebar
3. Click **Copy Server ID**

You'll use this as `discord.guildId` in your config.

---

## Step 5: Set Up Role-Based Access

Create a Discord role for users who can interact with the bot:

1. Go to your server **Settings** → **Roles** → **Create Role**
2. Name it something like "OpenCode" or "Developer"
3. Enable Developer Mode if not already on, then right-click the role → **Copy Role ID**
4. Assign this role to team members who should have bot access

For DM (direct message) access, you need user IDs:

1. Right-click a user's name in the server → **Copy User ID**

---

## Step 6: Configure config.yaml

Add the Discord platform settings to your `config.yaml`:

```yaml
# Select Discord platform
platform: discord

discord:
  # Bot token from Step 2
  token: "YOUR_BOT_TOKEN_HERE"

  # Server/Guild ID from Step 4
  guildId: "YOUR_SERVER_ID"

  # (Optional) Restrict to a specific channel
  # channelId: "CHANNEL_ID"

  # Role IDs allowed to use the bot in channels (comma-separated)
  allowedRoleIds: "ROLE_ID_1,ROLE_ID_2"

  # (Optional) User IDs allowed to DM the bot directly (comma-separated)
  # allowedUserIds: "USER_ID_1,USER_ID_2"
```

---

## Step 7: Start the Bot

```bash
# From the project directory
npm run dev

# Or with environment variable override
PLATFORM=discord npm run dev
```

On startup, the bot will:

1. Connect to Discord via Gateway WebSocket
2. Register all 14 slash commands to your server (appears instantly)
3. Log: `[Discord] Logged in as YourBot#1234`

---

## Available Commands

All commands are Discord slash commands (type `/` in any channel):

| Command           | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `/status`         | Server health, current project, session, and model info |
| `/new`            | Create a new OpenCode session                           |
| `/abort`          | Abort the current task                                  |
| `/sessions`       | Browse and switch between recent sessions               |
| `/projects`       | Switch between OpenCode projects                        |
| `/rename [name]`  | Rename the current session                              |
| `/commands`       | Browse and run custom commands                          |
| `/skills`         | Browse available skills                                 |
| `/opencode_start` | Start the OpenCode server remotely                      |
| `/opencode_stop`  | Stop the OpenCode server remotely                       |
| `/help`           | Show available commands                                 |
| `/model`          | Select AI model                                         |
| `/agent`          | Select agent mode (build/plan)                          |
| `/variant`        | Select model variant                                    |

To send a prompt to the AI agent, simply type a regular text message in the channel (no slash command needed).

---

## Access Control

### Channel Access (Role-Based)

Users must have a role matching one of the IDs in `allowedRoleIds` to interact with the bot in server channels.

### DM Access (Whitelist)

Users whose numeric ID is in `allowedUserIds` can DM the bot directly. Note that slash commands don't appear in DMs for guild-scoped bots — DM users send plain text prompts.

### Session Owner Lock

Only one user can control the active session at a time. If a session is in progress, other users see: "Session is busy — @user is currently working." The lock releases automatically when the session goes idle.

---

## Troubleshooting

**Slash commands not appearing**

- Commands are guild-scoped and should appear instantly after bot login
- Check that the bot has the "Use Application Commands" permission in your server
- Try kicking and re-inviting the bot with the invite URL from Step 3

**"You don't have the required role" error**

- Verify the role ID in `allowedRoleIds` matches the role ID in your server
- Make sure the user has been assigned the role (not just the role exists)
- Enable Developer Mode and re-copy the role ID to ensure no extra spaces

**"You are not authorized for DM access" error**

- Add the user's numeric ID to `allowedUserIds` in config.yaml
- User IDs are numeric (e.g., `123456789012345678`), not usernames

**Bot doesn't respond to messages**

- Verify the Message Content Intent is enabled in the Bot tab
- Check that `guildId` matches your server ID exactly

**"Channel not found" error**

- If using `channelId`, verify it's the correct channel ID
- Remove `channelId` to allow bot in all channels the role can access
