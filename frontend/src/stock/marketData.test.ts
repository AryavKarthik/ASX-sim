import { describe, expect, it } from "vitest";

import type { Bar } from "../api";
import type { Quote } from "../live/types";
import { sessionFigures, touchFor } from "./MarketData";

const quote = (bid: number | null, ask: number | null): Quote => ({
  price: 54.72,
  time: 0,
  previous_close: null,
  open: null,
  day_high: null,
  day_low: null,
  day_volume: null,
  bid,
  ask,
  change: null,
  change_pct: null,
  change_basis: "previous close",
});

describe("bid and ask shown", () => {
  it("uses the feed's bid and ask when they sit either side of the price", () => {
    expect(touchFor(quote(54.71, 54.73), 54.72)).toEqual({ bid: 54.71, ask: 54.73, estimated: false });
  });

  it("estimates one price step either side when the feed has none", () => {
    expect(touchFor(quote(null, null), 54.72)).toEqual({ bid: 54.72, ask: 54.73, estimated: true });
  });

  it("estimates when the last bid/ask seen are stale (the price has moved past them)", () => {
    expect(touchFor(quote(53.9, 54.0), 54.72).estimated).toBe(true);
  });

  it("shows nothing without a price", () => {
    expect(touchFor(undefined, null)).toEqual({ bid: null, ask: null, estimated: false });
  });
});

describe("session figures", () => {
  it("adds up volume and turnover and works out VWAP", () => {
    const bars: Bar[] = [
      { time: 0, open: 10, high: 11, low: 9, close: 10, volume: 100 }, // typical price 10
      { time: 60, open: 13, high: 14, low: 12, close: 13, volume: 300 }, // typical price 13
    ];
    expect(sessionFigures(bars)).toEqual({ volume: 400, turnover: 10 * 100 + 13 * 300, vwap: (10 * 100 + 13 * 300) / 400 });
    expect(sessionFigures([])).toEqual({ volume: null, turnover: null, vwap: null });
  });
});
