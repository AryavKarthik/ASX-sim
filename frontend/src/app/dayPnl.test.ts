import { describe, expect, it } from "vitest";

import type { FillView, PositionView, Quote } from "../live/types";
import { dayPnl, sydneyDate } from "./dayPnl";

const quote = { price: 169.72, change: -0.72 } as Quote; // previous close 170.44
const position = (quantity: number) => ({ symbol: "CBA", quantity }) as PositionView;
const fill = (quantity: number, price: string, time: string): FillView => ({
  order_id: "O1",
  symbol: "CBA",
  side: "buy",
  quantity,
  price,
  fee: "10.00",
  value: "0",
  time,
  liquidity: "continuous",
  settles_on: null,
});

// 14:00 Sydney on Wed 18 Nov 2026 (AEDT, UTC+11).
const TODAY = "2026-11-18T03:00:00+00:00";
const YESTERDAY = "2026-11-17T03:00:00+00:00";

describe("today's P&L on a holding", () => {
  it("measures shares held overnight from yesterday's close", () => {
    expect(dayPnl(position(100), quote, [fill(100, "160.00", YESTERDAY)], "2026-11-18")).toBeCloseTo(-72);
  });

  it("measures shares bought today from what you paid", () => {
    // Bought 10 at 169.82 today: down 10c each, not the whole day's 72c.
    expect(dayPnl(position(10), quote, [fill(10, "169.82", TODAY)], "2026-11-18")).toBeCloseTo(-1);
  });

  it("mixes the two when you added to an overnight holding today", () => {
    const fills = [fill(50, "160.00", YESTERDAY), fill(50, "169.62", TODAY)];
    expect(dayPnl(position(100), quote, fills, "2026-11-18")).toBeCloseTo(50 * -0.72 + 50 * 0.1);
  });

  it("is unknown without a quote", () => {
    expect(dayPnl(position(10), undefined, [], "2026-11-18")).toBeNull();
  });

  it("reads dates in Sydney time", () => {
    expect(sydneyDate("2026-11-17T14:00:00+00:00")).toBe("2026-11-18"); // 1am next day in Sydney
  });
});
