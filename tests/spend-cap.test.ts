import { describe, it, expect } from "vitest";
import { SpendCapManager, DEFAULT_SPEND_CAPS } from "../src/spend-cap.js";
import { SpendCapError } from "../src/types.js";

describe("SpendCapManager", () => {
  it("authorizes a call under both caps", () => {
    const m = new SpendCapManager();
    expect(() => m.authorize(0.5)).not.toThrow();
  });

  it("throws SpendCapError when per-call cap is exceeded", () => {
    const m = new SpendCapManager({ caps: { perCallUsdc: 0.1 } });
    expect(() => m.authorize(0.2)).toThrow(SpendCapError);
    try {
      m.authorize(0.2);
    } catch (err) {
      const e = err as SpendCapError;
      expect(e.reason).toBe("per_call_cap_exceeded");
      expect(e.capUsdc).toBe(0.1);
      expect(e.attemptedUsdc).toBe(0.2);
    }
  });

  it("per-call override is respected", () => {
    const m = new SpendCapManager({ caps: { perCallUsdc: 0.1 } });
    expect(() => m.authorize(5.0, /* override */ 10.0)).not.toThrow();
  });

  it("throws when the daily cap would be exceeded by the cumulative spend", () => {
    const m = new SpendCapManager({ caps: { perCallUsdc: 5, perDayUsdc: 10 } });
    // 7 + 5 = 12 > 10 cap.
    m.record(7);
    expect(() => m.authorize(5)).toThrow(SpendCapError);
    try {
      m.authorize(5);
    } catch (err) {
      const e = err as SpendCapError;
      expect(e.reason).toBe("per_day_cap_exceeded");
      expect(e.capUsdc).toBe(10);
    }
  });

  it("authorize() does NOT charge the daily counter", () => {
    const m = new SpendCapManager();
    m.authorize(0.5);
    m.authorize(0.5);
    expect(m.spentTodayUsdc()).toBe(0);
  });

  it("record() accumulates within the UTC day", () => {
    const m = new SpendCapManager();
    m.record(0.10);
    m.record(0.20);
    m.record(0.05);
    expect(m.spentTodayUsdc()).toBeCloseTo(0.35, 6);
  });

  it("resets when the UTC day rolls over", () => {
    let nowMs = Date.parse("2026-01-01T23:59:00Z");
    const m = new SpendCapManager({
      caps: { perDayUsdc: 1.00 },
      now: () => nowMs,
    });
    m.record(0.80);
    expect(m.spentTodayUsdc()).toBeCloseTo(0.80, 6);
    nowMs = Date.parse("2026-01-02T00:01:00Z");
    expect(m.spentTodayUsdc()).toBe(0);
    expect(m.remainingTodayUsdc()).toBeCloseTo(1.00, 6);
  });

  it("DEFAULT_SPEND_CAPS exposes sensible production defaults", () => {
    expect(DEFAULT_SPEND_CAPS.perCallUsdc).toBe(1.0);
    expect(DEFAULT_SPEND_CAPS.perDayUsdc).toBe(10.0);
  });

  it("rejects NaN / negative attempts", () => {
    const m = new SpendCapManager();
    expect(() => m.authorize(NaN)).toThrow(SpendCapError);
    expect(() => m.authorize(-1)).toThrow(SpendCapError);
  });

  it("remainingTodayUsdc never goes negative", () => {
    const m = new SpendCapManager({ caps: { perDayUsdc: 1.0 } });
    // Force a manual over-spend (e.g. concurrency race) and assert the
    // getter floors at zero rather than returning negative.
    m.record(1.5);
    expect(m.remainingTodayUsdc()).toBe(0);
  });
});
