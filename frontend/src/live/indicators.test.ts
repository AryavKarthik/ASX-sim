import { describe, expect, it } from "vitest";

import type { Bar } from "../api";
import { aggregate, bollinger, dailyCandle, ema, macd, rsi, sma, vwap, withToday } from "./indicators";

const T0 = Date.UTC(2026, 10, 17, 10, 0) / 1000; // 10:00 (Sydney wall-clock epoch)

function bars(closes: number[], volume = 100): Bar[] {
  return closes.map((close, i) => ({
    time: T0 + i * 60,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
  }));
}

describe("moving averages", () => {
  it("SMA averages the last n closes and is empty during warm-up", () => {
    expect(sma(bars([1, 2, 3, 4, 5]), 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("EMA starts from the SMA and then weights recent closes more", () => {
    const out = ema(bars([1, 2, 3, 4, 5]), 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBe(2); // seed: SMA of 1,2,3
    expect(out[3]).toBeCloseTo(3); // 4 x 0.5 + 2 x 0.5
    expect(out[4]).toBeCloseTo(4);
  });
});

describe("Bollinger Bands", () => {
  it("are flat on a flat price and widen with volatility", () => {
    const flat = bollinger(bars([10, 10, 10]), 3, 2);
    expect([flat.lower[2], flat.middle[2], flat.upper[2]]).toEqual([10, 10, 10]);

    const moving = bollinger(bars([8, 10, 12]), 3, 2);
    const sd = Math.sqrt(8 / 3); // population SD of 8, 10, 12
    expect(moving.upper[2]).toBeCloseTo(10 + 2 * sd);
    expect(moving.lower[2]).toBeCloseTo(10 - 2 * sd);
  });
});

describe("RSI", () => {
  it("is 100 when price only rises and 0 when it only falls", () => {
    expect(rsi(bars([1, 2, 3, 4, 5, 6]), 3).at(-1)).toBe(100);
    expect(rsi(bars([6, 5, 4, 3, 2, 1]), 3).at(-1)).toBe(0);
  });

  it("matches a hand-worked example with Wilder smoothing", () => {
    // Changes: +1, -1, +2 -> avg gain 1, avg loss 1/3 -> RS 3 -> RSI 75
    const out = rsi(bars([10, 11, 10, 12]), 3);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]).toBeCloseTo(75);
  });
});

describe("MACD", () => {
  it("is zero on a flat price and positive in an uptrend", () => {
    const flat = macd(bars(Array(40).fill(10)));
    expect(flat.macd.at(-1)).toBeCloseTo(0);
    expect(flat.histogram.at(-1)).toBeCloseTo(0);

    const rising = macd(bars(Array.from({ length: 40 }, (_, i) => 10 + i)));
    expect(rising.macd.at(-1)).toBeGreaterThan(0);
    // MACD's first value is bar 26 (index 25); the 9-bar signal needs 8 more -> index 33.
    expect(rising.macd[25]).not.toBeNull();
    expect(rising.macd[24]).toBeNull();
    expect(rising.signal[33]).not.toBeNull();
    expect(rising.signal[32]).toBeNull();
  });
});

describe("VWAP", () => {
  it("weights each bar's typical price by its volume", () => {
    const b: Bar[] = [
      { time: T0, open: 10, high: 11, low: 9, close: 10, volume: 100 }, // typical 10
      { time: T0 + 60, open: 13, high: 14, low: 12, close: 13, volume: 300 }, // typical 13
    ];
    expect(vwap(b)).toEqual([10, (10 * 100 + 13 * 300) / 400]);
  });

  it("starts again each day", () => {
    const nextDay = T0 + 86400;
    const b: Bar[] = [
      { time: T0, open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { time: nextDay, open: 20, high: 20, low: 20, close: 20, volume: 100 },
    ];
    expect(vwap(b)).toEqual([10, 20]);
  });
});

describe("timeframes", () => {
  it("combines 1-minute candles into 5-minute candles", () => {
    const one = bars([10, 11, 12, 13, 14, 15]); // 10:00-10:05
    const five = aggregate(one, 5);

    expect(five).toHaveLength(2);
    expect(five[0]).toMatchObject({ time: T0, open: 10, high: 15, low: 9, close: 14, volume: 500 });
    expect(five[1]).toMatchObject({ time: T0 + 300, open: 15, close: 15, volume: 100 });
    expect(one[0].high).toBe(11); // the input isn't modified
  });

  it("adds today to daily history and folds it into the current week or month", () => {
    const day = (iso: string, close: number): Bar => ({
      time: Date.parse(`${iso}T00:00:00Z`) / 1000,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100,
    });
    const history = [day("2026-11-09", 50)]; // Monday's bar
    const friday = day("2026-11-13", 55);

    expect(withToday(history, friday, "1d")).toHaveLength(2);
    expect(withToday(history, friday, "1wk")).toEqual([{ ...day("2026-11-09", 50), high: 56, close: 55, volume: 200 }]);
    expect(withToday(history, day("2026-11-16", 57), "1wk")).toHaveLength(2); // next week
    expect(withToday(history, day("2026-12-01", 60), "1mo")).toHaveLength(2); // next month
    expect(withToday(history, null, "1d")).toBe(history);
    expect(history[0].close).toBe(50); // history isn't modified
  });

  it("puts 29 Dec 2025 in ISO week 1 of 2026 (same as the backend)", () => {
    const mon = { time: Date.parse("2025-12-29T00:00:00Z") / 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 };
    const fri = { ...mon, time: Date.parse("2026-01-02T00:00:00Z") / 1000 };
    expect(withToday([mon], fri, "1wk")).toHaveLength(1);
  });

  it("builds today's daily candle from intraday candles", () => {
    expect(dailyCandle(bars([10, 12, 11]))).toMatchObject({ open: 10, high: 13, low: 9, close: 11, volume: 300 });
    expect(dailyCandle([])).toBeNull();
  });
});
