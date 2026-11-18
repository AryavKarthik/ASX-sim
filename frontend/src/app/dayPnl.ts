// Today's profit or loss on a holding, the way brokers show it: shares held overnight are
// measured from yesterday's close, shares bought today from what you paid for them.

import type { FillView, PositionView, Quote } from "../live/types";

/** The Sydney calendar date of a timestamp, as YYYY-MM-DD. */
export function sydneyDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
}

export function dayPnl(position: PositionView, quote: Quote | undefined, fills: FillView[], sessionDay: string | null): number | null {
  if (!quote || quote.change == null) return null;
  const price = quote.price;
  const boughtToday = fills.filter((f) => f.symbol === position.symbol && f.side === "buy" && sessionDay != null && sydneyDate(f.time) === sessionDay);
  const shares = boughtToday.reduce((sum, f) => sum + f.quantity, 0);
  const todayShares = Math.min(shares, position.quantity);
  const todayCost = shares ? boughtToday.reduce((sum, f) => sum + Number(f.price) * f.quantity, 0) / shares : 0;
  const overnight = position.quantity - todayShares;
  return overnight * quote.change + todayShares * (price - todayCost);
}
