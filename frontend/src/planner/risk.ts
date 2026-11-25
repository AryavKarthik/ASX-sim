// The risk planner's maths: what a long trade can make or lose, and how many shares to buy so
// that hitting the stop loses only what you chose to risk. Brokerage is counted on the way in
// and on the way out, as the simulator charges it.

import { nearestValid, tickSize } from "../live/ticks";

export type Brokerage = { flat: string | number; percent: string | number; minimum: string | number };

/** The simulator's default: $10 a trade (backend/src/asxsim/trading/brokerage.py). */
export const DEFAULT_BROKERAGE: Brokerage = { flat: 10, percent: 0, minimum: 0 };

/** The ASX minimum for a first purchase of a stock (a "marketable parcel"). */
export const MIN_PARCEL = 500;

const cents = (n: number) => Math.round(n * 100) / 100;

/** Brokerage on one order of this value, rounded to the cent like the server. */
export function fee(value: number, b: Brokerage): number {
  if (value <= 0) return 0;
  return cents(Math.max(Number(b.flat) + value * Number(b.percent), Number(b.minimum)));
}

/** Profit or loss, after brokerage both ways, of buying at `entry` and selling at `exit`. */
export function outcome(entry: number, exit: number, shares: number, b: Brokerage): number {
  if (shares <= 0) return 0;
  return cents((exit - entry) * shares - fee(entry * shares, b) - fee(exit * shares, b));
}

/** The nearest valid ASX price step. */
export function snap(price: number): number {
  const [down, up] = nearestValid(price);
  return price - down <= up - price ? down : up;
}

/** Largest whole n in [0, max] where ok(n) holds, for ok that is true up to a point. */
function largest(max: number, ok: (n: number) => boolean): number {
  let lo = 0;
  let hi = Math.max(0, Math.floor(max));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export type Sizing = { shares: number; limitedBy: "risk" | "cash" | null };

/**
 * Shares to buy so that a fill at the stop loses at most `risk` dollars (brokerage included),
 * and the purchase fits in `cash` if given.
 */
export function sharesForRisk(entry: number, stop: number, risk: number, b: Brokerage, cash?: number): Sizing {
  const perShare = entry - stop;
  if (!(perShare > 0) || !(risk > 0) || !(entry > 0)) return { shares: 0, limitedBy: null };
  const byRisk = largest(risk / perShare, (n) => -outcome(entry, stop, n, b) <= risk + 1e-9);
  if (cash == null) return { shares: byRisk, limitedBy: "risk" };
  const byCash = largest(cash / entry, (n) => n * entry + fee(n * entry, b) <= cash + 1e-9);
  return byCash < byRisk ? { shares: byCash, limitedBy: "cash" } : { shares: byRisk, limitedBy: "risk" };
}

/** Dollars to risk from the planner's "1%" or "$200" setting. */
export function riskBudget(mode: "percent" | "dollars", value: number, equity: number): number {
  if (!(value > 0)) return 0;
  return mode === "percent" ? (equity * value) / 100 : value;
}

export type Analysis = {
  shares: number;
  value: number; // what the shares cost, before brokerage
  buyFee: number;
  loss: number | null; // positive dollars lost if the stop fills (brokerage included)
  gain: number | null; // dollars made if the target fills, after brokerage
  ratio: number | null; // gain ÷ loss
  breakeven: number | null; // the exit price that just covers brokerage
  stopPct: number | null; // how far the stop is below the entry, in %
  targetPct: number | null; // how far the target is above the entry, in %
};

export function analyse(entry: number | null, stop: number | null, target: number | null, shares: number, b: Brokerage): Analysis {
  const ok = entry != null && entry > 0 && shares > 0;
  const value = ok ? entry * shares : 0;
  const buyFee = fee(value, b);
  const stopOk = ok && stop != null && stop > 0 && stop < entry;
  const targetOk = ok && target != null && target > entry;
  const loss = stopOk ? -outcome(entry, stop, shares, b) : null;
  const gain = targetOk ? outcome(entry, target, shares, b) : null;
  return {
    shares: ok ? shares : 0,
    value,
    buyFee,
    loss,
    gain,
    ratio: loss != null && gain != null && loss > 0 ? gain / loss : null,
    breakeven: ok ? breakeven(entry, shares, b) : null,
    stopPct: stopOk ? ((entry - stop) / entry) * 100 : null,
    targetPct: targetOk ? ((target - entry) / entry) * 100 : null,
  };
}

/** The lowest valid price step that sells for at least what the trade cost, fees included. */
export function breakeven(entry: number, shares: number, b: Brokerage): number {
  let price = snap(entry + (fee(entry * shares, b) * 2) / shares);
  // Fees can depend on the exit value, so step until it really covers them.
  for (let i = 0; i < 1000 && outcome(entry, price, shares, b) < -1e-6; i++) price = snap(price + tickSize(price));
  return price;
}

/** Problems that stop the plan from making sense, in plain English. */
export function problems(entry: number | null, stop: number | null, target: number | null): string[] {
  const out: string[] = [];
  if (entry == null || !(entry > 0)) return ["Enter an entry price."];
  if (stop != null && stop >= entry) out.push("The stop-loss must be below the entry price (this planner is for buying, not short selling).");
  if (target != null && target <= entry) out.push("The target must be above the entry price.");
  return out;
}

/** Starting levels for a new plan: entry at the price, stop 2% below, target 4% above (2:1). */
export function defaultLevels(price: number): { entry: number; stop: number; target: number } {
  const entry = snap(price);
  let stop = snap(entry * 0.98);
  let target = snap(entry * 1.04);
  if (stop >= entry) stop = snap(entry - tickSize(entry));
  if (target <= entry) target = snap(entry + tickSize(entry));
  return { entry, stop, target };
}

/** Prices at whole multiples of the risk ("R"): 1R up is a gain the size of the planned loss. */
export function rLevels(entry: number, stop: number, multiples: number[]): { r: number; price: number }[] {
  const perShare = entry - stop;
  if (!(perShare > 0)) return [];
  return multiples.map((r) => ({ r, price: snap(entry + r * perShare) })).filter((l) => l.price > 0);
}
