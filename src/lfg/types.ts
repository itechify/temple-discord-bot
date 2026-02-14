export const FORMATS = ["constructed", "sealed", "multiplayer"] as const;

export type LfgFormat = (typeof FORMATS)[number];
export const PLAYERS_PER_MATCH: Record<LfgFormat, number> = {
  constructed: 2,
  sealed: 2,
  multiplayer: 4,
};

export interface QueueEntry {
  guildId: string;
  userId: string;
  format: LfgFormat;
  joinedAt: number;
  expiresAt: number;
}

export interface CleanupResult {
  expiredEntries: QueueEntry[];
}

export type JoinResult =
  | {
      kind: "already_queued";
      format: LfgFormat;
      remainingMs: number;
    }
  | {
      kind: "queued";
      format: LfgFormat;
      movedFrom?: LfgFormat;
      expiresAt: number;
    }
  | {
      kind: "matched";
      format: LfgFormat;
      matchedUserIds: string[];
      movedFrom?: LfgFormat;
    };

export type LeaveResult =
  | {
      kind: "not_queued";
    }
  | {
      kind: "removed";
      format: LfgFormat;
    };

export interface FormatStatus {
  format: LfgFormat;
  count: number;
  oldestWaitMs: number | null;
  queuedUserIds: string[];
}

export interface UserQueueStatus {
  format: LfgFormat;
  remainingMs: number;
}

export interface StatusResult {
  formats: FormatStatus[];
  userStatus: UserQueueStatus | null;
}
