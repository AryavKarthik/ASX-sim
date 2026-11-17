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
  halted: string[]; // stocks that look halted (inferred from a gap in trading)
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
  auction: "open" | "close" | "resume" | null;
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
  trades: TradeView[];
};

export type JournalEntry = {
  setup: string | null;
  thesis: string;
  planned_stop: string | null;
  planned_target: string | null;
  confidence: number | null;
  emotions: string[];
  followed_plan: boolean | null;
  went_well: string;
  to_improve: string;
  rating: number | null;
  updated_at: string | null;
};

export type TradeView = {
  id: string;
  symbol: string;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  holding_minutes: number;
  entry_quantity: number;
  exit_quantity: number;
  open_quantity: number;
  average_entry: string;
  average_exit: string | null;
  gross_pnl: string;
  fees: string;
  net_pnl: string;
  unrealised: string | null;
  r_multiple: number | null;
  journal: JournalEntry;
};

export type JournalOptions = { setups: string[]; emotions: string[] };

export type GroupStats = {
  trades: number;
  win_rate: number | null;
  net_pnl: number | null;
  average_r: number | null;
};

export type Analytics = {
  summary: {
    starting_cash: number;
    equity: number;
    net_pnl: number;
    total_return_pct: number | null;
    realised: number;
    unrealised: number;
    fees: number;
    fees_pct_of_gross_profit: number | null;
    benchmark_return_pct: number | null;
  };
  trades: {
    closed: number;
    open: number;
    wins: number;
    losses: number;
    win_rate: number | null;
    average_win: number | null;
    average_loss: number | null;
    payoff_ratio: number | null;
    profit_factor: number | null;
    expectancy: number | null;
    average_r: number | null;
    best: number | null;
    worst: number | null;
    average_holding_minutes: number | null;
  };
  risk: {
    max_drawdown: number;
    max_drawdown_pct: number;
    sharpe: number | null;
    sharpe_days_needed: number;
  };
  curve: { time: number; equity: number }[];
  benchmark: { time: number; equity: number }[];
  by_setup: ({ label: string } & GroupStats)[];
  by_time: ({ label: string } & GroupStats)[];
  by_symbol: ({ label: string } & GroupStats)[];
  discipline: {
    planned_pct: number | null;
    reviewed: number;
    followed: GroupStats;
    broke: GroupStats;
  };
};

/** What the order ticket can send as the trade's plan. */
export type TradePlan = {
  setup?: string;
  thesis?: string;
  planned_stop?: string;
  planned_target?: string;
  confidence?: number;
};

export type CoachStatus = {
  available: boolean; // false until an API key is in .env
  chat_model: string;
  review_model: string;
  spent_usd: number; // estimated spend this calendar month
  budget_usd: number;
  calls: number;
};

export type CommandResult =
  | { type: "result"; request_id: string; action: string; ok: true; order?: OrderView; analytics?: Analytics; coach?: CoachStatus }
  | { type: "result"; request_id: string; action: string; ok: false; error: string; coach?: CoachStatus };

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
  plan?: TradePlan;
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
  | { type: "coach"; request_id: string; delta: string }
  | ({ type: "status" } & LiveStatus);

export type Defaults = {
  watchlist: string[];
  max_symbols: number;
  universe: { code: string; name: string }[];
  journal: JournalOptions;
  coach: CoachStatus;
};

export type FeedSource =
  | { kind: "live" }
  | { kind: "demo"; day: string | null; speed: number };
