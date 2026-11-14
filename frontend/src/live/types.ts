// Shapes of the live-mode messages. Mirrors backend/src/asxsim/api/live.py.

import type { Bar, Phase } from "../api";

export type Quote = {
  price: number;
  time: number;
  previous_close: number | null;
  open: number | null;
  day_high: number | null;
  day_low: number | null;
  day_volume: number | null;
  bid: number | null;
  ask: number | null;
  change: number | null;
  change_pct: number | null;
  change_basis: "previous close" | "open";
};

export type LiveStatus = {
  source: "live" | "demo";
  feed: string; // "yahoo-stream" | "yahoo-poll" | "demo"
  fallback_reason: string | null;
  delay_seconds: number | null;
  delay_measured: boolean;
  market_time: string; // ISO, Sydney time
  phase: Phase;
  seconds_since_tick: number | null;
  error: string | null;
};

export type LiveMessage =
  | {
      type: "snapshot";
      source: "live" | "demo";
      session_day: string | null;
      symbols: Record<string, { quote: Quote | null; candles: Bar[] }>;
    }
  | { type: "tick"; symbol: string; live: boolean; quote: Quote; candle: Bar | null }
  | ({ type: "status" } & LiveStatus);

export type Defaults = {
  watchlist: string[];
  max_symbols: number;
  universe: { code: string; name: string }[];
};

export type FeedSource =
  | { kind: "live" }
  | { kind: "demo"; day: string | null; speed: number };
