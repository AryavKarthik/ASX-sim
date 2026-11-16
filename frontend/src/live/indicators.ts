// Technical indicators and timeframe aggregation, computed from candles in the browser so the
// chart can redraw them on every update. Each function returns one value per input bar, with
// null where there isn't enough history yet ("warm-up").

import type { Bar } from "../api";

export type Series = (number | null)[];

/** Simple moving average of closes over `period` bars. */
export function sma(bars: Bar[], period: number): Series {
  const out: Series = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` values. */
export function emaOf(values: Series, period: number): Series {
  const k = 2 / (period + 1);
  const out: Series = [];
  let prev: number | null = null;
  let seed: number[] = [];
  for (const v of values) {
    if (v == null) {
      out.push(null);
      continue;
    }
    if (prev == null) {
      seed.push(v);
      if (seed.length === period) {
        prev = seed.reduce((a, b) => a + b, 0) / period;
        seed = [];
        out.push(prev);
      } else {
        out.push(null);
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function ema(bars: Bar[], period: number): Series {
  return emaOf(
    bars.map((b) => b.close),
    period,
  );
}

/** Bollinger Bands: SMA ± `width` population standard deviations. */
export function bollinger(bars: Bar[], period = 20, width = 2): { upper: Series; middle: Series; lower: Series } {
  const middle = sma(bars, period);
  const upper: Series = [];
  const lower: Series = [];
  for (let i = 0; i < bars.length; i++) {
    const m = middle[i];
    if (m == null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (bars[j].close - m) ** 2;
    const sd = Math.sqrt(variance / period);
    upper.push(m + width * sd);
    lower.push(m - width * sd);
  }
  return { upper, middle, lower };
}

/** RSI with Wilder's smoothing (0-100). Above 70 is often called overbought, below 30 oversold. */
export function rsi(bars: Bar[], period = 14): Series {
  const out: Series = bars.map(() => null);
  if (bars.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = bars[i].close - bars[i - 1].close;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < bars.length; i++) {
    const change = bars[i].close - bars[i - 1].close;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = value();
  }
  return out;
}

/** MACD (12, 26, 9): fast EMA - slow EMA, its signal EMA, and the histogram between them. */
export function macd(bars: Bar[], fast = 12, slow = 26, signal = 9): { macd: Series; signal: Series; histogram: Series } {
  const f = ema(bars, fast);
  const s = ema(bars, slow);
  const line: Series = f.map((v, i) => (v == null || s[i] == null ? null : v - (s[i] as number)));
  const sig = emaOf(line, signal);
  return {
    macd: line,
    signal: sig,
    histogram: line.map((v, i) => (v == null || sig[i] == null ? null : v - (sig[i] as number))),
  };
}

/**
 * VWAP: the average price paid today, weighted by volume, using each bar's typical price
 * (high + low + close) / 3. Resets at the start of each Sydney trading day.
 */
export function vwap(bars: Bar[], dayOf: (time: number) => string = utcDay): Series {
  const out: Series = [];
  let day = "";
  let pv = 0;
  let vol = 0;
  for (const bar of bars) {
    const d = dayOf(bar.time);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    pv += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    vol += bar.volume;
    out.push(vol > 0 ? pv / vol : null);
  }
  return out;
}

// Candle times are already Sydney wall-clock epochs, so the UTC date of the epoch is the
// Sydney trading day.
function utcDay(time: number): string {
  return new Date(time * 1000).toISOString().slice(0, 10);
}

/** Combine 1-minute candles into `minutes`-minute candles (5, 15, 60...). */
export function aggregate(bars: Bar[], minutes: number): Bar[] {
  if (minutes <= 1) return bars;
  const size = minutes * 60;
  const out: Bar[] = [];
  for (const bar of bars) {
    const start = Math.floor(bar.time / size) * size;
    const last = out[out.length - 1];
    if (last && last.time === start) {
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
      last.volume += bar.volume;
    } else {
      out.push({ ...bar, time: start });
    }
  }
  return out;
}

/** Which weekly/monthly bar a daily time falls in (mirrors the backend's period_key). */
function periodKey(time: number, interval: "1d" | "1wk" | "1mo"): string {
  const d = new Date(time * 1000);
  if (interval === "1d") return d.toISOString().slice(0, 10);
  if (interval === "1mo") return d.toISOString().slice(0, 7);
  // ISO week: the Thursday of this week decides the year; count weeks from that year's first.
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return `${thursday.getUTCFullYear()}-W${Math.ceil(((thursday.getTime() - yearStart) / 86400000 + 1) / 7)}`;
}

/**
 * Add today's daily candle to history: a new bar, or folded into the current week/month.
 * Returns a new array; history is never modified.
 */
export function withToday(history: Bar[], today: Bar | null, interval: "1d" | "1wk" | "1mo"): Bar[] {
  if (!today) return history;
  const last = history[history.length - 1];
  if (!last || periodKey(last.time, interval) !== periodKey(today.time, interval)) return [...history, today];
  return [
    ...history.slice(0, -1),
    {
      time: last.time,
      open: last.open,
      high: Math.max(last.high, today.high),
      low: Math.min(last.low, today.low),
      close: today.close,
      volume: last.volume + today.volume,
    },
  ];
}

/** One daily candle from a day's intraday candles (to extend daily history with today). */
export function dailyCandle(intraday: Bar[]): Bar | null {
  if (intraday.length === 0) return null;
  const day = Math.floor(intraday[0].time / 86400) * 86400;
  return {
    time: day,
    open: intraday[0].open,
    high: Math.max(...intraday.map((b) => b.high)),
    low: Math.min(...intraday.map((b) => b.low)),
    close: intraday[intraday.length - 1].close,
    volume: intraday.reduce((sum, b) => sum + b.volume, 0),
  };
}
