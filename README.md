# Sorcery TCG LFG Discord Bot

Simple Discord bot for a Sorcery TCG server that provides `/lfg` queueing by format.

## Features

- `/lfg join format:<constructed|sealed|multiplayer>`
- `/lfg leave`
- `/lfg status`
- `/lfg help`
- `[[card name]]` lookup in any guild channel (supports multiple per message)
- `[[?card name]]` rulings/FAQ lookup in any guild channel
- Queue timeout with auto-cleanup (`QUEUE_TTL_MINUTES`, default `30`)
- Instant matching when enough players join the same format
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
- `EMOJI_AIR`: Card threshold emoji for air (default `🜁`)
- `EMOJI_EARTH`: Card threshold emoji for earth (default `🜃`)
- `EMOJI_FIRE`: Card threshold emoji for fire (default `🜂`)
- `EMOJI_WATER`: Card threshold emoji for water (default `🜄`)

## Run

Development:

```bash
npm run dev
```

Development (test bot / test server using `.env.dev`):

```bash
npm run dev:test
```

Build:

```bash
npm run build
```

Run built code:

```bash
npm start
```

Run built code (test bot / test server using `.env.dev`):

```bash
npm run start:test
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
- Privileged Gateway Intents:
  - `Message Content` (required for `[[card name]]` lookups)

DMs can fail if users disable DMs from server members; bot handles this gracefully.

## Command Behavior

### Channel behavior

- `/lfg` commands can be run in any channel within a guild.
- Public queue/match announcements are posted in `#lfg-sorcery` (or configured channel name).

### `/lfg join format:<constructed|sealed|multiplayer>`

- Adds user to that format queue.
- If already queued in same format: ephemeral response with remaining time.
- If queued in another format: moves user and confirms ephemerally.
- When enough players are waiting for that format (2 for Constructed/Sealed, 4 for Multiplayer):
  - immediately creates a match group,
  - removes all matched players from queue,
  - posts public message in `#lfg-sorcery`:
    - `Match found: @User1, @User2, ... (Format: Multiplayer)`
  - sends all matched users best-effort DM.

### `/lfg leave`

- Removes user from whichever format queue they are in.
- If not queued, returns ephemeral notice.

### `/lfg status`

- Shows only the caller's current queued format and remaining time if queued.
- If not queued, returns an ephemeral notice.

### `/lfg help`

Ephemeral usage summary:

- `/lfg join constructed|sealed|multiplayer`
- `/lfg leave`
- `/lfg status`

### Card lookup by message

- Mention cards in any guild channel with `[[double braces]]`.
- Example: `[[Apprentice Wizard]]`
- Multiple in one message are supported.
- Matching is case-insensitive and supports light misspellings.
- Bot replies in the same channel with card details from `cards.json`.

### Card FAQ by message

- Ask for FAQ with `[[?card name]]`.
- Example: `[[?Past in Flames]]`
- Multiple FAQ lookups in one message are supported.
- Matching is case-insensitive and supports light misspellings.
- Bot replies in the same channel with FAQ/rulings from `faq.csv`.

## Project Structure

```text
src/
  index.ts
  cards/
    faq.ts
    lookup.ts
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
