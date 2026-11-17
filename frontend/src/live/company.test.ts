import { describe, expect, it } from "vitest";

import { type Fundamentals, compact, rangePosition, ratios } from "./company";

const BHP: Fundamentals = {
  eps: 2.77,
  forward_eps: 3.7,
  dividend_per_share: 1.72,
  book_value_per_share: 14.26,
  shares_outstanding: 5_000_000_000,
  revenue: null,
  net_income: null,
  profit_margin: null,
  return_on_equity: null,
  debt_to_equity: null,
  payout_ratio: null,
  beta: null,
  ex_dividend_date: null,
  reporting_currency: "USD",
  trading_currency: "AUD",
};

describe("ratios from the price on screen", () => {
  it("combines per-share facts with the current price", () => {
    const r = ratios(BHP, 55.4);
    expect(r.pe).toBeCloseTo(20);
    expect(r.marketCap).toBe(277_000_000_000);
    expect(r.dividendYieldPct).toBeCloseTo(3.105, 2);
    expect(r.priceToBook).toBeCloseTo(3.885, 2);
  });

  it("moves with the price", () => {
    expect(ratios(BHP, 27.7).pe).toBeCloseTo(10);
    expect(ratios(BHP, 27.7).dividendYieldPct).toBeCloseTo(6.21, 2);
  });

  it("gives nothing without a price, and no P/E for a loss-making company", () => {
    expect(ratios(BHP, null)).toEqual({ marketCap: null, pe: null, forwardPe: null, dividendYieldPct: null, priceToBook: null });
    expect(ratios({ ...BHP, eps: -0.4 }, 10).pe).toBeNull();
    expect(ratios({ ...BHP, dividend_per_share: 0 }, 10).dividendYieldPct).toBe(0);
  });
});

describe("52-week range", () => {
  it("places the price between the low and the high", () => {
    expect(rangePosition(50, 40, 60)).toBe(50);
    expect(rangePosition(70, 40, 60)).toBe(100); // a new high today
    expect(rangePosition(30, 40, 60)).toBe(0);
    expect(rangePosition(50, 60, 60)).toBeNull();
    expect(rangePosition(null, 40, 60)).toBeNull();
  });
});

describe("compact numbers", () => {
  it("abbreviates large figures", () => {
    expect(compact(280_884_019_200)).toBe("280.9b");
    expect(compact(1_500_000_000_000)).toBe("1.50t");
    expect(compact(7_921_425)).toBe("7.9m");
    expect(compact(38_833)).toBe("38.8k");
    expect(compact(null)).toBe("—");
  });
});
