import dotenv from "dotenv";

dotenv.config();

export interface Env {
  DISCORD_TOKEN: string;
  CLIENT_ID: string;
  GUILD_ID?: string;
  QUEUE_TTL_MINUTES: number;
  LFG_CHANNEL_NAME: string;
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
  };
}
