# Sorcery TCG LFG Discord Bot

Simple Discord bot for a Sorcery TCG server that provides `/lfg` queueing by format.

## Features

- `/lfg join format:<constructed|sealed>`
- `/lfg leave`
- `/lfg status [format]`
- `/lfg help`
- Queue timeout with auto-cleanup (`QUEUE_TTL_MINUTES`, default `30`)
- Instant matching when a second user joins the same format
- Best-effort DM notifications for matches and queue expiry
- Public bot announcements are posted in `#lfg-sorcery` (configurable)

## Tech Stack

- Node.js
- TypeScript
- discord.js v14
- dotenv
- In-memory queues (`Map`) with periodic cleanup

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your env file:

```bash
cp .env.example .env
```

3. Fill `.env` values:

- `DISCORD_TOKEN`: Bot token
- `CLIENT_ID`: Discord application client ID
- `GUILD_ID`: Dev guild ID (recommended for fast slash command registration)
- `QUEUE_TTL_MINUTES`: Queue TTL in minutes (default `30`)
- `LFG_CHANNEL_NAME`: Must match channel name (default `lfg-sorcery`)

## Run

Development:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Run built code:

```bash
npm start
```

## Required Discord Bot Permissions / Scopes

Use OAuth2 URL Generator with:

- Scopes:
  - `bot`
  - `applications.commands`
- Bot permissions:
  - `Send Messages`
  - `Use Slash Commands`
  - `View Channels`
  - `Read Message History` (optional but useful)

DMs can fail if users disable DMs from server members; bot handles this gracefully.

## Command Behavior

### Channel behavior

- `/lfg` commands can be run in any channel within a guild.
- Public queue/match announcements are posted in `#lfg-sorcery` (or configured channel name).

### `/lfg join format:<constructed|sealed>`

- Adds user to that format queue.
- If already queued in same format: ephemeral response with remaining time.
- If queued in another format: moves user and confirms ephemerally.
- If someone else is waiting in that same format:
  - immediately matches both,
  - removes both from queue,
  - posts public message in `#lfg-sorcery`:
    - `Match found: @User1 vs @User2 (Format: Constructed)`
  - sends both users best-effort DM.

### `/lfg leave`

- Removes user from whichever format queue they are in.
- If not queued, returns ephemeral notice.

### `/lfg status [format]`

- Shows counts per format (or one format if provided).
- Shows oldest waiting duration per format.
- Shows caller's current queued format and remaining time if queued.
- Does not list usernames.

### `/lfg help`

Ephemeral usage summary:

- `/lfg join constructed|sealed`
- `/lfg leave`
- `/lfg status [format]`

## Project Structure

```text
src/
  index.ts
  commands/
    lfg.ts
  lfg/
    queue.ts
    types.ts
  util/
    env.ts
    logger.ts
```

## Notes

- Storage is in-memory only. Restarting the bot clears queues.
- `GUILD_ID` set: registers guild commands on startup for fast updates.
- `GUILD_ID` unset: registers global commands (Discord propagation may take up to ~1 hour).
