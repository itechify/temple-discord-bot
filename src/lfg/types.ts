export const FORMATS = ["constructed", "sealed"] as const;

export type LfgFormat = (typeof FORMATS)[number];

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
      opponentUserId: string;
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
}

export interface UserQueueStatus {
  format: LfgFormat;
  remainingMs: number;
}

export interface StatusResult {
  formats: FormatStatus[];
  userStatus: UserQueueStatus | null;
}
