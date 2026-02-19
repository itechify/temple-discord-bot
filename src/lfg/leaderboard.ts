import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FORMATS, type LfgFormat } from "./types";

interface MatchCounter {
  guildId: string;
  userId: string;
  totalCount: number;
  byFormat: Record<LfgFormat, number>;
}

interface RecentMatch {
  guildId: string;
  format: LfgFormat;
  userIds: string[];
  matchedAt: number;
}

interface LeaderboardStoreData {
  counters: MatchCounter[];
  recentMatches: RecentMatch[];
}

interface LegacyMatchEvent {
  guildId: string;
  userId: string;
  format: LfgFormat;
  matchedAt: number;
}

export interface LeaderboardRow {
  userId: string;
  matchCount: number;
}

export interface UserMatchSummary {
  totalCount: number;
  byFormat: Record<LfgFormat, number>;
}

export class LfgLeaderboardStore {
  private data: LeaderboardStoreData = { counters: [], recentMatches: [] };
  private index = new Map<string, MatchCounter>();

  constructor(private readonly dataPath: string) {
    this.data = this.load();
    this.rebuildIndex();
  }

  recordMatch(guildId: string, userIds: string[], format: LfgFormat, matchedAt = Date.now()): void {
    void matchedAt;
    if (userIds.length === 0) {
      return;
    }

    for (const userId of userIds) {
      const key = this.counterKey(guildId, userId);
      const existing = this.index.get(key);

      if (existing) {
        existing.totalCount += 1;
        existing.byFormat[format] += 1;
        continue;
      }

      const created: MatchCounter = {
        guildId,
        userId,
        totalCount: 1,
        byFormat: {
          constructed: 0,
          sealed: 0,
          multiplayer: 0,
        },
      };
      created.byFormat[format] = 1;
      this.data.counters.push(created);
      this.index.set(key, created);
    }

    this.data.recentMatches.push({
      guildId,
      format,
      userIds: [...userIds],
      matchedAt,
    });
    if (this.data.recentMatches.length > 5000) {
      this.data.recentMatches.splice(0, this.data.recentMatches.length - 5000);
    }

    this.save();
  }

  getLeaderboard(guildId: string, format?: LfgFormat, limit = 10): LeaderboardRow[] {
    return this.data.counters
      .filter((counter) => counter.guildId === guildId)
      .map((counter) => ({
        userId: counter.userId,
        matchCount: format ? counter.byFormat[format] : counter.totalCount,
      }))
      .filter((row) => row.matchCount > 0)
      .sort((a, b) => b.matchCount - a.matchCount || a.userId.localeCompare(b.userId))
      .slice(0, Math.max(1, limit))
      .map((row) => ({ userId: row.userId, matchCount: row.matchCount }));
  }

  getUserSummary(guildId: string, userId: string): UserMatchSummary {
    const counter = this.index.get(this.counterKey(guildId, userId));
    if (!counter) {
      return {
        totalCount: 0,
        byFormat: { constructed: 0, sealed: 0, multiplayer: 0 },
      };
    }

    return {
      totalCount: counter.totalCount,
      byFormat: { ...counter.byFormat },
    };
  }

  getRecentMatches(guildId: string, limit = 10): RecentMatch[] {
    return this.data.recentMatches
      .filter((match) => match.guildId === guildId)
      .sort((a, b) => b.matchedAt - a.matchedAt)
      .slice(0, Math.max(1, limit))
      .map((match) => ({ ...match, userIds: [...match.userIds] }));
  }

  private load(): LeaderboardStoreData {
    try {
      const raw = readFileSync(this.dataPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LeaderboardStoreData & { events: LegacyMatchEvent[] }>;
      if (Array.isArray(parsed.counters)) {
        return {
          counters: parsed.counters
            .filter(
              (counter): counter is MatchCounter =>
                typeof counter?.guildId === "string" &&
                typeof counter?.userId === "string" &&
                typeof counter?.totalCount === "number" &&
                counter?.byFormat !== null &&
                typeof counter?.byFormat === "object",
            )
            .map((counter) => ({
              guildId: counter.guildId,
              userId: counter.userId,
              totalCount: counter.totalCount,
              byFormat: this.normalizeByFormat(counter.byFormat),
            })),
          recentMatches: Array.isArray(parsed.recentMatches)
            ? parsed.recentMatches.filter(
                (match): match is RecentMatch =>
                  typeof match?.guildId === "string" &&
                  typeof match?.format === "string" &&
                  Array.isArray(match?.userIds) &&
                  match.userIds.every((userId: unknown) => typeof userId === "string") &&
                  typeof match?.matchedAt === "number",
              )
            : [],
        };
      }

      if (!Array.isArray(parsed.events)) {
        return { counters: [], recentMatches: [] };
      }

      const events = parsed.events.filter(
        (event): event is LegacyMatchEvent =>
          typeof event?.guildId === "string" &&
          typeof event?.userId === "string" &&
          typeof event?.format === "string" &&
          typeof event?.matchedAt === "number",
      );

      return this.aggregateLegacyEvents(events);
    } catch {
      return { counters: [], recentMatches: [] };
    }
  }

  private save(): void {
    const directory = path.dirname(this.dataPath);
    mkdirSync(directory, { recursive: true });

    const tempPath = `${this.dataPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.data));
    renameSync(tempPath, this.dataPath);
  }

  private rebuildIndex(): void {
    this.index.clear();
    for (const counter of this.data.counters) {
      this.index.set(this.counterKey(counter.guildId, counter.userId), counter);
    }
  }

  private counterKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  private normalizeByFormat(input: Partial<Record<LfgFormat, number>>): Record<LfgFormat, number> {
    return {
      constructed: typeof input.constructed === "number" ? input.constructed : 0,
      sealed: typeof input.sealed === "number" ? input.sealed : 0,
      multiplayer: typeof input.multiplayer === "number" ? input.multiplayer : 0,
    };
  }

  private aggregateLegacyEvents(events: LegacyMatchEvent[]): LeaderboardStoreData {
    const counts = new Map<string, MatchCounter>();
    const recentMatches: RecentMatch[] = [];

    for (const event of events) {
      if (!FORMATS.includes(event.format)) {
        continue;
      }

      const key = this.counterKey(event.guildId, event.userId);
      const existing = counts.get(key);
      if (existing) {
        existing.totalCount += 1;
        existing.byFormat[event.format] += 1;
        continue;
      }

      const created: MatchCounter = {
        guildId: event.guildId,
        userId: event.userId,
        totalCount: 1,
        byFormat: {
          constructed: 0,
          sealed: 0,
          multiplayer: 0,
        },
      };
      created.byFormat[event.format] = 1;
      counts.set(key, created);

      recentMatches.push({
        guildId: event.guildId,
        format: event.format,
        userIds: [event.userId],
        matchedAt: event.matchedAt,
      });
    }

    return { counters: [...counts.values()], recentMatches };
  }
}
