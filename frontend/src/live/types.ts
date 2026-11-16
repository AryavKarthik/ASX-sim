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

export type OrderKind = "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";

export type OrderView = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: OrderKind;
  display_type: OrderKind;
  quantity: number;
  limit_price: string | null;
  trigger_price: string | null;
  trail_amount: string | null;
  trail_percent: string | null;
  time_in_force: "day" | "gtc";
  expires_on: string | null;
  created_at: string;
  session: string;
  status: "pending" | "queued" | "working" | "filled" | "cancelled" | "expired" | "rejected";
  auction: "open" | "close" | null;
  filled: number;
  average_price: string | null;
  fees: string;
  message: string | null;
};

export type FillView = {
  order_id: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: string;
  fee: string;
  value: string;
  time: string;
  liquidity: string;
  settles_on: string | null;
};

export type PositionView = {
  symbol: string;
  quantity: number;
  average_price: string;
  last_price: string | null;
  market_value: string | null;
  unrealised: string | null;
  unrealised_pct: number | null;
  realised: string;
};

export type AccountView = {
  starting_cash: string;
  cash: string;
  settled_cash: string;
  pending_settlement: { date: string; amount: string }[];
  buying_power: string;
  market_value: string;
  equity: string;
  unrealised: string;
  realised: string;
  fees: string;
  net_pnl: string;
  positions: PositionView[];
  orders: OrderView[];
  fills: FillView[];
  brokerage: { flat: string; percent: string; minimum: string };
};

export type CommandResult =
  | { type: "result"; request_id: string; action: string; ok: true; order?: OrderView }
  | { type: "result"; request_id: string; action: string; ok: false; error: string };

export type OrderCommand = {
  symbol: string;
  side: "buy" | "sell";
  type: OrderKind;
  quantity: number;
  limit_price?: string;
  trigger_price?: string;
  trail_amount?: string;
  trail_percent?: string;
  time_in_force?: "day" | "gtc";
};

export type LiveMessage =
  | {
      type: "snapshot";
      source: "live" | "demo";
      session_day: string | null;
      symbols: Record<string, { quote: Quote | null; candles: Bar[] }>;
      account: AccountView;
    }
  | { type: "tick"; symbol: string; live: boolean; quote: Quote; candle: Bar | null }
  | { type: "account"; account: AccountView; fills: FillView[] }
  | CommandResult
  | ({ type: "status" } & LiveStatus);

export type Defaults = {
  watchlist: string[];
  max_symbols: number;
  universe: { code: string; name: string }[];
};

export type FeedSource =
  | { kind: "live" }
  | { kind: "demo"; day: string | null; speed: number };
