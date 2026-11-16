// Types and calls for the FastAPI backend. Shapes mirror backend/src/asxsim/api/app.py.

export type Bar = {
  time: number; // Sydney wall-clock time as epoch seconds (see backend _local_epoch)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Phase =
  | "pre_open"
  | "opening_auction"
  | "open"
  | "pre_cspa"
  | "closing_auction"
  | "post_close"
  | "adjust"
  | "adjust_on"
  | "purge_orders"
  | "closed";

export type ReplayState = {
  symbol: string;
  name: string;
  day: string;
  now: string; // ISO time with Sydney offset, e.g. 2026-11-13T10:01:00+11:00
  phase: Phase;
  speed: number;
  playing: boolean;
  finished: boolean;
  bars_visible: number;
  last_price: number | null;
  open_price: number | null;
};

export type Security = { code: string; name: string };

export type ServerMessage =
  | { type: "snapshot" | "update"; state: ReplayState; bars: Bar[] }
  | { type: "error"; message: string };

export type Command = { action: "play" | "pause" | "step" } | { action: "speed"; value: number };

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export type HistoryInterval = "1d" | "1wk" | "1mo";

/** Daily/weekly/monthly bars before `until` (the session day, so today comes from live candles). */
export async function fetchHistory(symbol: string, interval: HistoryInterval, until: string | null): Promise<Bar[]> {
  const params = new URLSearchParams({ symbol, interval });
  if (until) params.set("until", until);
  return (await getJson<{ bars: Bar[] }>(`/api/live/history?${params}`)).bars;
}

export async function fetchDays(): Promise<string[]> {
  return (await getJson<{ days: string[] }>("/api/replay/days")).days;
}

export function fetchSymbols(day: string): Promise<Security[]> {
  return getJson<Security[]>(`/api/replay/symbols?day=${encodeURIComponent(day)}`);
}

export function createSession(
  symbol: string,
  day: string,
): Promise<{ session_id: string; state: ReplayState }> {
  return getJson("/api/replay/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol, day }),
  });
}

export function replaySocketUrl(sessionId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/api/replay/sessions/${sessionId}/ws`;
}
