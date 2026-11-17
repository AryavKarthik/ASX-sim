import type { Bar } from "../api";

export type SwingOrder = {
  id: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop";
  quantity: number;
  price: string | null;
  placed_on: number;
  status: "working" | "filled" | "cancelled" | "rejected";
  filled_on: number | null;
  fill_price: string | null;
  fee: string;
  pnl: string | null;
  note: string | null;
  time: number | null; // chart time of the fill
};

export type SwingSummary = {
  return_pct: number;
  buy_hold_pct: number;
  max_drawdown_pct: number;
  closed_trades: number;
  wins: number;
  win_rate: number | null;
  fees: string;
  days_invested_pct: number | null;
};

/** Everything the server shows about a session: never a bar after the current day. */
export type SwingState = {
  id: string;
  symbol: string | null; // null while a blind session is running
  name: string;
  blind: boolean;
  hidden: boolean;
  finished: boolean;
  day: number;
  total_days: number;
  date: string | null;
  start_date: string | null;
  first_index: number;
  bars: Bar[];
  close: string;
  cash: string;
  free_cash: string;
  starting_cash: string;
  equity: string;
  position: {
    quantity: number;
    free_quantity: number;
    average_price: string | null;
    market_value: string;
    unrealised: string;
  };
  orders: SwingOrder[];
  curve: { time: number; equity: number; buy_hold: number }[];
  brokerage: { flat: string; percent: string; minimum: string };
  summary: SwingSummary;
  filled?: SwingOrder[];
};

export type SwingOptions = {
  stocks: { code: string; name: string }[];
  periods: { label: string; days: number }[];
};

export type SavedSession = {
  id: string;
  name: string;
  start_date: string | null;
  day: number;
  total_days: number;
  finished: boolean;
  return_pct: number;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { detail?: unknown };
  if (!response.ok) {
    const detail = body.detail;
    throw new Error(typeof detail === "string" ? detail : `${response.status} ${response.statusText}`);
  }
  return body;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const swingApi = {
  options: () => call<SwingOptions>("/api/swing/options"),
  saved: async () => (await call<{ sessions: SavedSession[] }>("/api/swing/sessions")).sessions,
  create: (body: { symbol: string | null; start: string | null; days: number; cash: string; blind: boolean }) =>
    call<SwingState>("/api/swing/sessions", post(body)),
  read: (id: string) => call<SwingState>(`/api/swing/sessions/${id}`),
  advance: (id: string, days: number) => call<SwingState>(`/api/swing/sessions/${id}/advance`, post({ days })),
  order: (id: string, body: { side: string; type: string; quantity: number; price: string | null }) =>
    call<SwingState>(`/api/swing/sessions/${id}/orders`, post(body)),
  cancel: (id: string, orderId: number) =>
    call<SwingState>(`/api/swing/sessions/${id}/orders/${orderId}`, { method: "DELETE" }),
};
