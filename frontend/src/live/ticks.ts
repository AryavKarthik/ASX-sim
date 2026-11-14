// ASX price steps, mirroring backend/src/asxsim/market/ticks.py (ASIC MIR Rule 9.4.1).
// Used for instant feedback in the order ticket; the server re-checks everything.

/** Work in tenths of a cent (integers) to avoid floating-point surprises. */
const MILLS = 1000;

function toMills(price: number): number {
  return Math.round(price * MILLS);
}

/** Step size in tenths of a cent for the band `price` is in. */
function stepMills(mills: number): number {
  if (mills < 100) return 1; // below 10c: 0.1c
  if (mills < 2000) return 5; // 10c to under $2: 0.5c
  return 10; // $2 and above: 1c
}

export function tickSize(price: number): number {
  return stepMills(toMills(price)) / MILLS;
}

export function isValidPrice(price: number): boolean {
  const mills = toMills(price);
  if (!Number.isFinite(price) || mills <= 0) return false;
  if (Math.abs(price * MILLS - mills) > 1e-6) return false; // finer than 0.1c
  return mills % stepMills(mills) === 0;
}

export function nearestValid(price: number): [number, number] {
  const mills = Math.floor(price * MILLS + 1e-6);
  const step = stepMills(Math.max(mills, 1));
  const down = Math.max(step, Math.floor(mills / step) * step);
  const up = Math.ceil((price * MILLS - 1e-6) / step) * step;
  return [down / MILLS, Math.max(up, down) / MILLS];
}

/** The bid/ask the server assumes when the feed has none: one tick around the last trade. */
export function estimatedTouch(last: number, bid: number | null, ask: number | null): [number, number] {
  if (bid != null && ask != null && bid < ask) return [bid, ask];
  const lastMills = Math.round(last * MILLS * 100) / 100; // tolerate float noise
  const step = stepMills(Math.floor(lastMills));
  const bidMills = Math.floor(lastMills / step + 1e-9) * step;
  const askMills = bidMills + stepMills(bidMills);
  return [bidMills / MILLS, askMills / MILLS];
}

export function priceDecimals(price: number): number {
  return price < 2 ? 3 : 2;
}
