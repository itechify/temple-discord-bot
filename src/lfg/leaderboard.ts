import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FORMATS, type LfgFormat } from "./types";

interface MatchCounter {
  guildId: string;
  userId: string;
  totalCount: number;
  byFormat: Record<LfgFormat, number>;
}

interface LeaderboardStoreData {
  counters: MatchCounter[];
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

export class LfgLeaderboardStore {
  private data: LeaderboardStoreData = { counters: [] };
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
        };
      }

      if (!Array.isArray(parsed.events)) {
        return { counters: [] };
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
      return { counters: [] };
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
    }

    return { counters: [...counts.values()] };
  }
}
