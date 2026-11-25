import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROKERAGE as B,
  analyse,
  breakeven,
  defaultLevels,
  fee,
  outcome,
  problems,
  rLevels,
  riskBudget,
  sharesForRisk,
  snap,
} from "./risk";

const PERCENT = { flat: 0, percent: "0.001", minimum: "5" }; // 0.1%, $5 minimum

describe("fee", () => {
  it("charges the flat fee, or a percentage with a minimum", () => {
    expect(fee(10_000, B)).toBe(10);
    expect(fee(0, B)).toBe(0);
    expect(fee(10_000, PERCENT)).toBe(10);
    expect(fee(1_000, PERCENT)).toBe(5); // minimum
  });
});

describe("outcome", () => {
  it("counts brokerage on the buy and the sell", () => {
    // 100 shares bought at $10, sold at $11: +$100 less $20 brokerage.
    expect(outcome(10, 11, 100, B)).toBeCloseTo(80);
    expect(outcome(10, 9.5, 100, B)).toBeCloseTo(-70);
  });
});

describe("sharesForRisk", () => {
  it("sizes so the stop loses no more than the risk, fees included", () => {
    // Risk $200 with a 50c stop: 360 shares lose $180 + $20 fees = $200.
    const sized = sharesForRisk(10, 9.5, 200, B);
    expect(sized.shares).toBe(360);
    expect(-outcome(10, 9.5, sized.shares, B)).toBeLessThanOrEqual(200);
    expect(-outcome(10, 9.5, sized.shares + 1, B)).toBeGreaterThan(200);
  });

  it("is capped by the cash available", () => {
    const sized = sharesForRisk(10, 9.9, 1_000, B, 2_010);
    expect(sized).toEqual({ shares: 200, limitedBy: "cash" });
  });

  it("returns nothing for a stop above the entry or no risk", () => {
    expect(sharesForRisk(10, 10.5, 200, B).shares).toBe(0);
    expect(sharesForRisk(10, 9.5, 0, B).shares).toBe(0);
    expect(sharesForRisk(10, 9.5, 15, B).shares).toBe(0); // fees alone exceed the risk
  });
});

describe("riskBudget", () => {
  it("reads a percentage of equity or a dollar amount", () => {
    expect(riskBudget("percent", 1, 50_000)).toBe(500);
    expect(riskBudget("dollars", 250, 50_000)).toBe(250);
    expect(riskBudget("percent", -1, 50_000)).toBe(0);
  });
});

describe("analyse", () => {
  it("works out the loss, gain and reward-to-risk", () => {
    const a = analyse(10, 9.5, 11, 360, B);
    expect(a.value).toBe(3600);
    expect(a.loss).toBeCloseTo(200);
    expect(a.gain).toBeCloseTo(340);
    expect(a.ratio).toBeCloseTo(1.7);
    expect(a.stopPct).toBeCloseTo(5);
    expect(a.targetPct).toBeCloseTo(10);
  });

  it("leaves out a side that isn't set or doesn't make sense", () => {
    const a = analyse(10, null, 9, 100, B);
    expect(a.loss).toBeNull();
    expect(a.gain).toBeNull();
    expect(a.ratio).toBeNull();
  });
});

describe("breakeven", () => {
  it("is the first price step that covers brokerage both ways", () => {
    // 100 shares at $10 with $20 of fees needs 20c a share.
    expect(breakeven(10, 100, B)).toBeCloseTo(10.2);
    expect(outcome(10, breakeven(10, 100, B), 100, B)).toBeGreaterThanOrEqual(0);
  });
});

describe("levels", () => {
  it("snaps to ASX price steps", () => {
    expect(snap(45.123)).toBeCloseTo(45.12);
    expect(snap(1.2349)).toBeCloseTo(1.235);
  });

  it("starts a plan at 2% risk for 4% reward", () => {
    const l = defaultLevels(50);
    expect(l).toEqual({ entry: 50, stop: 49, target: 52 });
  });

  it("keeps the stop and target either side of a tiny price", () => {
    const l = defaultLevels(0.012);
    expect(l.stop).toBeLessThan(l.entry);
    expect(l.target).toBeGreaterThan(l.entry);
  });

  it("finds R multiples", () => {
    expect(rLevels(10, 9.5, [1, 2]).map((l) => l.price)).toEqual([10.5, 11]);
    expect(rLevels(10, 10.5, [1])).toEqual([]);
  });

  it("explains a plan that doesn't make sense", () => {
    expect(problems(null, null, null)).toHaveLength(1);
    expect(problems(10, 11, 12)[0]).toMatch(/stop-loss must be below/);
    expect(problems(10, 9, 9.5)[0]).toMatch(/target must be above/);
    expect(problems(10, 9, 12)).toEqual([]);
  });
});
