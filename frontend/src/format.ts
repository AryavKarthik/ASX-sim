import type { Phase } from "./api";

export const PHASE_LABELS: Record<Phase, string> = {
  pre_open: "Pre-open",
  opening_auction: "Opening auction",
  open: "Open",
  pre_cspa: "Pre-close",
  closing_auction: "Closing auction",
  post_close: "Closed",
  adjust: "Closed",
  adjust_on: "Closed",
  purge_orders: "Closed",
  closed: "Closed",
};

export const PHASE_HELP: Record<Phase, string> = {
  pre_open: "Orders can be placed and queue up, but nothing trades yet.",
  opening_auction: "All queued orders are matched at a single opening price.",
  open: "Normal trading: orders fill as soon as they cross.",
  pre_cspa: "Orders queue for the closing auction; nothing trades.",
  closing_auction: "Queued orders are matched at a single closing price.",
  post_close: "The market has closed for the day.",
  adjust: "The market has closed for the day.",
  adjust_on: "The market has closed for the day.",
  purge_orders: "The market has closed for the day.",
  closed: "The market is closed.",
};

/** "2026-11-13" -> "Fri 13 Nov 2026" (parsed as a calendar date, not a moment). */
export function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Clock from the server's ISO time, already in Sydney time: "10:01:00". */
export function clockTime(iso: string): string {
  return iso.slice(11, 19);
}

/** Decimals to show: cents above $2, tenths of a cent below, plus one more for midpoint trades. */
function decimalsFor(price: number): number {
  const base = Math.abs(price) < 2 ? 3 : 2;
  const scaled = price * 10 ** base;
  return Math.abs(scaled - Math.round(scaled)) > 1e-6 ? base + 1 : base;
}

export function formatPrice(price: number): string {
  return `$${price.toFixed(decimalsFor(price))}`;
}

export function formatChange(last: number, reference: number): { text: string; up: boolean } {
  const change = last - reference;
  const pct = (change / reference) * 100;
  const sign = change >= 0 ? "+" : "−";
  const decimals = Math.max(decimalsFor(last), decimalsFor(reference));
  return {
    text: `${sign}${Math.abs(change).toFixed(decimals)} (${sign}${Math.abs(pct).toFixed(2)}%)`,
    up: change >= 0,
  };
}
