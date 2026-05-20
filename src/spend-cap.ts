// In-memory spend tracking with a per-UTC-day rolling reset. The
// constructor accepts an optional storage adapter; default is purely
// in-memory which is fine for short-lived agent processes. Long-lived
// agents that crash and restart will see their daily counter reset
// because they have nothing persistent to load from — pass a storage
// adapter (sqlite/json file/redis) if you need crash-safe accounting.

import { SpendCapError, type SpendCaps } from "./types.js";

export interface SpendStorage {
  /** Returns the spend recorded for the given UTC-day key. */
  read(dayKey: string): number;
  /** Increments the spend recorded for the given UTC-day key. */
  add(dayKey: string, delta: number): void;
}

/** Default in-process spend storage. Crash = forget. */
class MemoryStorage implements SpendStorage {
  private readonly data = new Map<string, number>();
  read(dayKey: string): number { return this.data.get(dayKey) ?? 0; }
  add(dayKey: string, delta: number): void {
    this.data.set(dayKey, (this.data.get(dayKey) ?? 0) + delta);
  }
}

export const DEFAULT_SPEND_CAPS: Required<SpendCaps> = {
  perCallUsdc: 1.0,
  perDayUsdc: 10.0,
};

export interface SpendCapManagerOptions {
  caps?: SpendCaps;
  storage?: SpendStorage;
  /** Provide a custom clock for tests. Returns Date.now() by default. */
  now?: () => number;
}

export class SpendCapManager {
  private readonly caps: Required<SpendCaps>;
  private readonly storage: SpendStorage;
  private readonly now: () => number;

  constructor(opts: SpendCapManagerOptions = {}) {
    this.caps = {
      perCallUsdc: opts.caps?.perCallUsdc ?? DEFAULT_SPEND_CAPS.perCallUsdc,
      perDayUsdc: opts.caps?.perDayUsdc ?? DEFAULT_SPEND_CAPS.perDayUsdc,
    };
    this.storage = opts.storage ?? new MemoryStorage();
    this.now = opts.now ?? (() => Date.now());
  }

  /** Returns the UTC YYYY-MM-DD key for today. We bucket per UTC day
   *  so callers across time zones get a deterministic reset boundary
   *  at midnight UTC. */
  private dayKey(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /** Validate that a call of `attemptedUsdc` is allowed under both
   *  per-call and per-day caps. Throws SpendCapError if not. Does NOT
   *  charge — call `record()` after the call succeeds. */
  authorize(attemptedUsdc: number, perCallOverrideUsdc?: number): void {
    if (!Number.isFinite(attemptedUsdc) || attemptedUsdc < 0) {
      throw new SpendCapError("per_call_cap_exceeded", attemptedUsdc, 0);
    }

    const perCallCap = perCallOverrideUsdc ?? this.caps.perCallUsdc;
    if (attemptedUsdc > perCallCap) {
      throw new SpendCapError("per_call_cap_exceeded", attemptedUsdc, perCallCap);
    }

    const spentToday = this.storage.read(this.dayKey());
    if (spentToday + attemptedUsdc > this.caps.perDayUsdc) {
      throw new SpendCapError(
        "per_day_cap_exceeded",
        spentToday + attemptedUsdc,
        this.caps.perDayUsdc,
      );
    }
  }

  /** Record a confirmed spend. Call only AFTER the on-chain settle
   *  succeeded — failed settles never reach the cap counter. */
  record(usdc: number): void {
    if (!Number.isFinite(usdc) || usdc < 0) return;
    this.storage.add(this.dayKey(), usdc);
  }

  /** Current spent total for today (UTC). Useful for surfacing
   *  "$2.10 of $10.00 used today" UI. */
  spentTodayUsdc(): number {
    return this.storage.read(this.dayKey());
  }

  /** Remaining budget under the daily cap. */
  remainingTodayUsdc(): number {
    return Math.max(0, this.caps.perDayUsdc - this.spentTodayUsdc());
  }
}
