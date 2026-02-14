import {
  type CleanupResult,
  FORMATS,
  type JoinResult,
  type LeaveResult,
  type LfgFormat,
  PLAYERS_PER_MATCH,
  type QueueEntry,
  type StatusResult,
} from "./types";

export class LfgQueue {
  private readonly queues = new Map<string, QueueEntry[]>();

  constructor(private readonly ttlMs: number) {}

  cleanup(now = Date.now()): CleanupResult {
    const expiredEntries: QueueEntry[] = [];

    for (const format of FORMATS) {
      const key = this.queueKeyAllGuilds(format);
      for (const [fullKey, entries] of this.queues.entries()) {
        if (!fullKey.endsWith(key)) {
          continue;
        }

        const activeEntries = entries.filter((entry) => {
          const active = entry.expiresAt > now;
          if (!active) {
            expiredEntries.push(entry);
          }
          return active;
        });

        if (activeEntries.length === 0) {
          this.queues.delete(fullKey);
        } else {
          this.queues.set(fullKey, activeEntries);
        }
      }
    }

    return { expiredEntries };
  }

  join(guildId: string, userId: string, format: LfgFormat, now = Date.now()): JoinResult {
    this.cleanup(now);

    const existing = this.findUser(guildId, userId);
    if (existing && existing.entry.format === format) {
      return {
        kind: "already_queued",
        format,
        remainingMs: Math.max(0, existing.entry.expiresAt - now),
      };
    }

    let movedFrom: LfgFormat | undefined;
    if (existing) {
      movedFrom = existing.entry.format;
      existing.entries.splice(existing.index, 1);
      if (existing.entries.length === 0) {
        this.queues.delete(this.queueKey(guildId, existing.entry.format));
      }
    }

    const targetQueue = this.getOrCreateQueue(guildId, format);
    const requiredPlayers = PLAYERS_PER_MATCH[format];
    if (targetQueue.length + 1 >= requiredPlayers) {
      const matchedEntries = targetQueue.splice(0, requiredPlayers - 1);
      if (targetQueue.length === 0) {
        this.queues.delete(this.queueKey(guildId, format));
      }
      return {
        kind: "matched",
        format,
        matchedUserIds: matchedEntries.map((entry) => entry.userId),
        movedFrom,
      };
    }

    const expiresAt = now + this.ttlMs;
    targetQueue.push({
      guildId,
      userId,
      format,
      joinedAt: now,
      expiresAt,
    });

    return {
      kind: "queued",
      format,
      movedFrom,
      expiresAt,
    };
  }

  leave(guildId: string, userId: string, now = Date.now()): LeaveResult {
    this.cleanup(now);

    const existing = this.findUser(guildId, userId);
    if (!existing) {
      return { kind: "not_queued" };
    }

    existing.entries.splice(existing.index, 1);
    if (existing.entries.length === 0) {
      this.queues.delete(this.queueKey(guildId, existing.entry.format));
    }

    return {
      kind: "removed",
      format: existing.entry.format,
    };
  }

  status(guildId: string, userId: string, format?: LfgFormat, now = Date.now()): StatusResult {
    this.cleanup(now);

    const formats = (format ? [format] : [...FORMATS]).map((item) => {
      const queue = this.queues.get(this.queueKey(guildId, item)) ?? [];
      const oldest = queue.reduce<number | null>((current, entry) => {
        if (current === null) {
          return entry.joinedAt;
        }
        return Math.min(current, entry.joinedAt);
      }, null);

      return {
        format: item,
        count: queue.length,
        oldestWaitMs: oldest === null ? null : Math.max(0, now - oldest),
        queuedUserIds: queue.map((entry) => entry.userId),
      };
    });

    const existing = this.findUser(guildId, userId);

    return {
      formats,
      userStatus: existing
        ? {
            format: existing.entry.format,
            remainingMs: Math.max(0, existing.entry.expiresAt - now),
          }
        : null,
    };
  }

  private findUser(
    guildId: string,
    userId: string,
  ): {
    index: number;
    entries: QueueEntry[];
    entry: QueueEntry;
  } | null {
    for (const format of FORMATS) {
      const key = this.queueKey(guildId, format);
      const entries = this.queues.get(key);
      if (!entries || entries.length === 0) {
        continue;
      }

      const index = entries.findIndex((entry) => entry.userId === userId);
      if (index === -1) {
        continue;
      }

      return {
        index,
        entries,
        entry: entries[index],
      };
    }

    return null;
  }

  private getOrCreateQueue(guildId: string, format: LfgFormat): QueueEntry[] {
    const key = this.queueKey(guildId, format);
    const existing = this.queues.get(key);
    if (existing) {
      return existing;
    }

    const created: QueueEntry[] = [];
    this.queues.set(key, created);
    return created;
  }

  private queueKey(guildId: string, format: LfgFormat): string {
    return `${guildId}:${format}`;
  }

  private queueKeyAllGuilds(format: LfgFormat): string {
    return `:${format}`;
  }
}
