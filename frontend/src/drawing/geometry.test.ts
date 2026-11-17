import { describe, expect, it } from "vitest";

import {
  type Drawing,
  type Scales,
  barMapper,
  distanceToSegment,
  extendRight,
  hitTest,
  indexMapper,
  interpolatedX,
  logicalToTime,
  moved,
  parseDrawings,
  shapeOf,
  snapPrice,
  timeToLogical,
} from "./geometry";

const MIN = 60;
const T0 = 36_000; // 10:00
const oneMinute = [0, 1, 2, 3, 4].map((i) => T0 + i * MIN);

describe("anchoring drawings to time, not pixels", () => {
  it("finds the bar position of a time, between bars too", () => {
    expect(timeToLogical(oneMinute, T0 + 2 * MIN)).toBe(2);
    expect(timeToLogical(oneMinute, T0 + 2.5 * MIN)).toBe(2.5);
  });

  it("extrapolates past either end at the edge spacing", () => {
    expect(timeToLogical(oneMinute, T0 + 6 * MIN)).toBe(6);
    expect(timeToLogical(oneMinute, T0 - 2 * MIN)).toBe(-2);
  });

  it("keeps a point in place when the timeframe changes", () => {
    const fiveMinute = [0, 5, 10].map((i) => T0 + i * MIN);
    const drawnAt = T0 + 7 * MIN; // on the 1-minute chart
    expect(timeToLogical(fiveMinute, drawnAt)).toBe(1.4); // 2/5 of the way into the 10:05 bar
  });

  it("round-trips between time and bar position", () => {
    for (const l of [-3, 0, 1.25, 4, 7.5]) {
      expect(timeToLogical(oneMinute, logicalToTime(oneMinute, l))).toBeCloseTo(l);
    }
  });

  it("copes with no data or a single bar", () => {
    expect(timeToLogical([], T0)).toBeNull();
    expect(timeToLogical([T0], T0 + 999)).toBe(0);
    expect(logicalToTime([T0], 3)).toBe(T0);
  });
});

// A screen where each bar is 10px wide and each $1 is 10px tall (price 100 at y = 0).
const scales: Scales = { x: (l) => l * 10, y: (p) => (100 - p) * 10, width: 500 };

describe("converting bar positions to the screen", () => {
  // Like the chart library: whole bars convert, anything in between comes back as 0.
  const library = (bar: number) => (Number.isInteger(bar) ? 100 + bar * 20 : 0);

  it("places a point between two bars, which the chart library can't", () => {
    expect(library(12.4)).toBe(0);
    expect(interpolatedX(library, 12.4)).toBeCloseTo(348);
    expect(interpolatedX(library, 12)).toBe(340);
    expect(interpolatedX(library, -1.5)).toBe(70);
  });

  it("gives up only when the chart can't place the bar at all", () => {
    expect(interpolatedX(() => null, 3.5)).toBeNull();
  });
});

describe("snapping a horizontal line to a real price", () => {
  it("rounds to the ASX price step for that price", () => {
    expect(snapPrice(54.998)).toBe(55);
    expect(snapPrice(55.4319)).toBe(55.43);
    expect(snapPrice(1.2349)).toBe(1.235); // half-cent steps under $2
    expect(snapPrice(0.0512)).toBe(0.051); // tenth-of-a-cent steps under 10c
  });
});

describe("placing drawings on screen", () => {
  it("places a horizontal line at its price", () => {
    expect(shapeOf({ id: "h", kind: "hline", price: 95 }, indexMapper, scales)).toEqual({ kind: "hline", y: 50 });
  });

  it("runs a ray on to the right edge, but stops a trend line at its second point", () => {
    const a = { time: 0, price: 90 };
    const b = { time: 10, price: 95 };
    const trend = shapeOf({ id: "t", kind: "trend", a, b }, indexMapper, scales);
    const ray = shapeOf({ id: "r", kind: "ray", a, b }, indexMapper, scales);
    expect(trend).toMatchObject({ x2: 100, y2: 50 });
    expect(ray).toMatchObject({ x2: 500, y2: -150 }); // continues up at the same slope
  });

  it("doesn't extend a line drawn right to left", () => {
    expect(extendRight(100, 0, 50, 10, 500)).toEqual([50, 10]);
  });
});

describe("picking a drawing with the pointer", () => {
  const drawings: Drawing[] = [
    { id: "h", kind: "hline", price: 95 },
    { id: "t", kind: "trend", a: { time: 0, price: 90 }, b: { time: 10, price: 90 } },
  ];
  const shapes = new Map(drawings.map((d) => [d.id, shapeOf(d, indexMapper, scales)!]));

  it("measures distance to a segment, not the endless line through it", () => {
    expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(distanceToSegment(14, 3, 0, 0, 10, 0)).toBe(5); // past the end: distance to the end
  });

  it("finds the nearest line within a few pixels", () => {
    expect(hitTest(drawings, shapes, 300, 52)).toEqual({ id: "h", handle: null });
    expect(hitTest(drawings, shapes, 50, 98)).toEqual({ id: "t", handle: null });
    expect(hitTest(drawings, shapes, 300, 80)).toBeNull();
  });

  it("prefers an endpoint, so a line's ends can be dragged", () => {
    expect(hitTest(drawings, shapes, 101, 101)).toEqual({ id: "t", handle: "b" });
  });
});

describe("moving drawings", () => {
  const times = [100, 200, 300, 400];
  const mapper = barMapper(times);

  it("moves a horizontal line by price only", () => {
    expect(moved({ id: "h", kind: "hline", price: 10 }, mapper, 5, 0.5, null)).toEqual({ id: "h", kind: "hline", price: 10.5 });
    expect(moved({ id: "h", kind: "hline", price: 10 }, mapper, 0, 0.5037, null)).toMatchObject({ price: 10.5 }); // snapped
  });

  it("moves a whole trend line by bars and price", () => {
    const d: Drawing = { id: "t", kind: "trend", a: { time: 100, price: 10 }, b: { time: 300, price: 12 } };
    expect(moved(d, mapper, 1, -1, null)).toEqual({ id: "t", kind: "trend", a: { time: 200, price: 9 }, b: { time: 400, price: 11 } });
  });

  it("moves just one end when dragging a handle", () => {
    const d: Drawing = { id: "t", kind: "ray", a: { time: 100, price: 10 }, b: { time: 300, price: 12 } };
    expect(moved(d, mapper, 0, 0, "b", { time: 400, price: 15 })).toMatchObject({ a: { time: 100, price: 10 }, b: { time: 400, price: 15 } });
  });
});

describe("loading saved drawings", () => {
  it("keeps valid drawings and drops anything malformed", () => {
    const good = [
      { id: "h", kind: "hline", price: 12.5 },
      { id: "t", kind: "trend", a: { time: 1, price: 2 }, b: { time: 3, price: 4 } },
    ];
    const bad = [{ id: "x", kind: "circle" }, { kind: "hline", price: 1 }, { id: "y", kind: "ray", a: { time: 1 } }, null, "line"];
    expect(parseDrawings([...good, ...bad])).toEqual(good);
    expect(parseDrawings("nonsense")).toEqual([]);
    expect(parseDrawings([{ id: "n", kind: "hline", price: Number.NaN }])).toEqual([]);
  });
});
