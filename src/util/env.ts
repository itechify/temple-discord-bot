import dotenv from "dotenv";

const envFile = process.env.ENV_FILE?.trim();
dotenv.config(envFile ? { path: envFile } : undefined);

export interface Env {
  DISCORD_TOKEN: string;
  CLIENT_ID: string;
  GUILD_ID?: string;
  QUEUE_TTL_MINUTES: number;
  LFG_CHANNEL_NAME: string;
  LFG_LEADERBOARD_PATH: string;
  EMOJI_AIR: string;
  EMOJI_EARTH: string;
  EMOJI_FIRE: string;
  EMOJI_WATER: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function integerWithDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

export function loadEnv(): Env {
  return {
    DISCORD_TOKEN: required("DISCORD_TOKEN"),
    CLIENT_ID: required("CLIENT_ID"),
    GUILD_ID: process.env.GUILD_ID,
    QUEUE_TTL_MINUTES: integerWithDefault("QUEUE_TTL_MINUTES", 30),
    LFG_CHANNEL_NAME: process.env.LFG_CHANNEL_NAME?.trim() || "lfg-sorcery",
    LFG_LEADERBOARD_PATH:
      process.env.LFG_LEADERBOARD_PATH?.trim() || "./data/lfg-leaderboard.json",
    EMOJI_AIR: process.env.EMOJI_AIR?.trim() || "🜁",
    EMOJI_EARTH: process.env.EMOJI_EARTH?.trim() || "🜃",
    EMOJI_FIRE: process.env.EMOJI_FIRE?.trim() || "🜂",
    EMOJI_WATER: process.env.EMOJI_WATER?.trim() || "🜄",
  };
}
