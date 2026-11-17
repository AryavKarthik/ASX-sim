// Chart drawings and the maths that places them on screen.
//
// A drawing is anchored to (time, price), not to pixels or to a bar number, so it stays put
// when you zoom, scroll, switch timeframe or new candles arrive. Times that fall between
// bars (a line drawn on 1-minute candles, viewed on 5-minute ones) are placed by
// interpolation, and times past either end of the data by extrapolation at the edge
// spacing, so a trend line drawn last week still points the right way today.

import { nearestValid } from "../live/ticks";

export type Point = { time: number; price: number };

export type Drawing =
  | { id: string; kind: "hline"; price: number }
  | { id: string; kind: "trend"; a: Point; b: Point }
  | { id: string; kind: "ray"; a: Point; b: Point }; // a trend line that runs on to the right

export type Tool = "hline" | "trend" | "ray";

/** Converts between drawing time and the chart's bar position ("logical" index). */
export type Mapper = {
  toLogical: (time: number) => number | null;
  toTime: (logical: number) => number;
};

/** Fractional bar position of `time` among sorted bar `times`. */
export function timeToLogical(times: readonly number[], time: number): number | null {
  const n = times.length;
  if (n === 0) return null;
  if (n === 1) return 0;
  if (time <= times[0]) return (time - times[0]) / (times[1] - times[0] || 1);
  if (time >= times[n - 1]) return n - 1 + (time - times[n - 1]) / (times[n - 1] - times[n - 2] || 1);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  return lo + (time - times[lo]) / (times[hi] - times[lo] || 1);
}

/** The inverse of `timeToLogical`. */
export function logicalToTime(times: readonly number[], logical: number): number {
  const n = times.length;
  if (n === 0) return 0;
  if (n === 1) return times[0];
  if (logical <= 0) return times[0] + logical * (times[1] - times[0]);
  if (logical >= n - 1) return times[n - 1] + (logical - (n - 1)) * (times[n - 1] - times[n - 2]);
  const i = Math.floor(logical);
  return times[i] + (logical - i) * (times[i + 1] - times[i]);
}

/** A mapper over the bars on screen. */
export function barMapper(times: readonly number[]): Mapper {
  return { toLogical: (t) => timeToLogical(times, t), toTime: (l) => logicalToTime(times, l) };
}

/** A mapper where the drawing's "time" is the bar position itself (fixed bar lists). */
export const indexMapper: Mapper = { toLogical: (t) => t, toTime: (l) => l };

/**
 * Screen x for a fractional bar position. The chart library only converts whole bar numbers
 * (it returns 0 for anything in between), so place the point between its two neighbours.
 */
export function interpolatedX(toCoordinate: (bar: number) => number | null, logical: number): number | null {
  const bar = Math.floor(logical);
  const x0 = toCoordinate(bar);
  const fraction = logical - bar;
  if (x0 == null || fraction === 0) return x0;
  const x1 = toCoordinate(bar + 1);
  return x1 == null ? x0 : x0 + fraction * (x1 - x0);
}

/** The nearest valid ASX price (whole cents above $2), so a line sits on a real price. */
export function snapPrice(price: number): number {
  if (!(price > 0)) return price;
  const [down, up] = nearestValid(price);
  return price - down <= up - price ? down : up;
}

export type Scales = {
  x: (logical: number) => number | null;
  y: (price: number) => number | null;
  width: number; // of the price pane, in pixels
};

export type Shape =
  | { kind: "hline"; y: number }
  | { kind: "segment"; ax: number; ay: number; bx: number; by: number; x2: number; y2: number };

/** Where a drawing appears on screen, or null if it can't be placed (no data yet). */
export function shapeOf(d: Drawing, mapper: Mapper, scales: Scales): Shape | null {
  if (d.kind === "hline") {
    const y = scales.y(d.price);
    return y == null ? null : { kind: "hline", y };
  }
  const la = mapper.toLogical(d.a.time);
  const lb = mapper.toLogical(d.b.time);
  if (la == null || lb == null) return null;
  const ax = scales.x(la);
  const bx = scales.x(lb);
  const ay = scales.y(d.a.price);
  const by = scales.y(d.b.price);
  if (ax == null || bx == null || ay == null || by == null) return null;
  let [x2, y2] = [bx, by];
  if (d.kind === "ray") [x2, y2] = extendRight(ax, ay, bx, by, scales.width);
  return { kind: "segment", ax, ay, bx, by, x2, y2 };
}

/** Where the line through a and b meets the right edge (or b, if it points left or straight up). */
export function extendRight(ax: number, ay: number, bx: number, by: number, width: number): [number, number] {
  if (bx <= ax || width <= bx) return [bx, by];
  const slope = (by - ay) / (bx - ax);
  return [width, by + slope * (width - bx)];
}

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export type Hit = { id: string; handle: "a" | "b" | null };

/**
 * The drawing under the pointer: an endpoint handle first (so a selected line's ends can be
 * dragged), then the nearest line within `tolerance` pixels.
 */
export function hitTest(
  drawings: readonly Drawing[],
  shapes: ReadonlyMap<string, Shape>,
  x: number,
  y: number,
  tolerance = 6,
): Hit | null {
  for (const d of drawings) {
    const s = shapes.get(d.id);
    if (s?.kind !== "segment") continue;
    if (Math.hypot(x - s.ax, y - s.ay) <= tolerance + 2) return { id: d.id, handle: "a" };
    if (Math.hypot(x - s.bx, y - s.by) <= tolerance + 2) return { id: d.id, handle: "b" };
  }
  let best: Hit | null = null;
  let bestDistance = tolerance;
  for (const d of drawings) {
    const s = shapes.get(d.id);
    if (!s) continue;
    const distance = s.kind === "hline" ? Math.abs(y - s.y) : distanceToSegment(x, y, s.ax, s.ay, s.x2, s.y2);
    if (distance <= bestDistance) {
      best = { id: d.id, handle: null };
      bestDistance = distance;
    }
  }
  return best;
}

/** A drawing moved by a change in bar position and price (or one endpoint moved to `to`). */
export function moved(d: Drawing, mapper: Mapper, dLogical: number, dPrice: number, handle: "a" | "b" | null, to?: Point): Drawing {
  if (d.kind === "hline") return { ...d, price: snapPrice(d.price + dPrice) };
  if (handle && to) return { ...d, [handle]: to };
  const shift = (p: Point): Point => {
    const l = mapper.toLogical(p.time);
    return { time: l == null ? p.time : mapper.toTime(l + dLogical), price: p.price + dPrice };
  };
  return { ...d, a: shift(d.a), b: shift(d.b) };
}

/** Drawings read back from storage: anything malformed is dropped rather than breaking the chart. */
export function parseDrawings(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const point = (p: unknown): p is Point =>
    typeof p === "object" && p !== null && finite((p as Point).time) && finite((p as Point).price);
  return raw.filter((d): d is Drawing => {
    if (typeof d !== "object" || d === null || typeof (d as Drawing).id !== "string") return false;
    const x = d as Record<string, unknown>;
    if (x.kind === "hline") return finite(x.price);
    return (x.kind === "trend" || x.kind === "ray") && point(x.a) && point(x.b);
  });
}
