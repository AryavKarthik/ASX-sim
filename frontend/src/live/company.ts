// Company data shapes and the ratios worked out from the price on screen.
//
// The server sends only facts that don't depend on today's share price. Combining them with
// the current (delayed, or replayed) price here means the ratios update as the price moves,
// and a demo of an older day never sees ratios built from a later price.

export type Fundamentals = {
  eps: number | null;
  forward_eps: number | null;
  dividend_per_share: number | null;
  book_value_per_share: number | null;
  shares_outstanding: number | null;
  revenue: number | null;
  net_income: number | null;
  profit_margin: number | null;
  return_on_equity: number | null;
  debt_to_equity: number | null;
  payout_ratio: number | null;
  beta: number | null;
  ex_dividend_date: string | null;
  reporting_currency: string | null;
  trading_currency: string | null;
};

export type Company = {
  code: string;
  name: string;
  kind: string; // "equity" | "etf" | "index"
  sector: string | null;
  industry: string | null;
  summary: string | null;
  website: string | null;
  headquarters: string | null;
  employees: number | null;
  fundamentals: Fundamentals;
  price: {
    as_of: string | null;
    last_close: number | null;
    week52_high: number | null;
    week52_low: number | null;
    average_volume_30d: number | null;
    returns: { label: string; pct: number | null }[];
  };
};

export type Ratios = {
  marketCap: number | null;
  pe: number | null;
  forwardPe: number | null;
  dividendYieldPct: number | null;
  priceToBook: number | null;
};

/** Valuation ratios at `price`. A ratio is null when an input is missing or meaningless. */
export function ratios(f: Fundamentals, price: number | null): Ratios {
  const ok = price != null && price > 0;
  const per = (x: number | null) => (ok && x != null && x > 0 ? price / x : null); // losses have no P/E
  return {
    marketCap: ok && f.shares_outstanding != null ? price * f.shares_outstanding : null,
    pe: per(f.eps),
    forwardPe: per(f.forward_eps),
    dividendYieldPct: ok && f.dividend_per_share != null ? (100 * f.dividend_per_share) / price : null,
    priceToBook: per(f.book_value_per_share),
  };
}

/** Where `price` sits between the 52-week low (0) and high (100), clamped. */
export function rangePosition(price: number | null, low: number | null, high: number | null): number | null {
  if (price == null || low == null || high == null || high <= low) return null;
  return Math.min(100, Math.max(0, (100 * (price - low)) / (high - low)));
}

/** 280_884_019_200 -> "280.9b". */
export function compact(n: number | null): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}b`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
}
