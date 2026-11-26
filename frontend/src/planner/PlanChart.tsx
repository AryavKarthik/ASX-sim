// The risk planner's chart: candles with the plan drawn on top. Entry, stop, target and a
// "what if" line can each be dragged up or down; the area between entry and target is shaded
// green (what you could make) and between entry and stop red (what you could lose), like the
// long-position tool on broker charting platforms.

import {
  CandlestickSeries,
  type IChartApi,
  type IPriceLine,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  LineStyle,
  type SeriesAttachedParameter,
  type Time,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { Bar } from "../api";
import { ZoomControls, attachZoom } from "../components/ZoomControls";
import { DEFAULT_BAR_SPACING, MAX_BAR_SPACING, MIN_BAR_SPACING, steppedSpacing } from "../components/zoom";
import { snap } from "./risk";

export type LevelKey = "entry" | "stop" | "target" | "whatIf";
export type Levels = Record<LevelKey, number | null>;

const UP = "#089981";
const DOWN = "#f23645";
export const LEVEL_STYLE: Record<LevelKey, { color: string; title: string }> = {
  entry: { color: "#2f6bff", title: "Entry" },
  stop: { color: DOWN, title: "Stop" },
  target: { color: UP, title: "Target" },
  whatIf: { color: "#9aa3ad", title: "What if" },
};
const ORDER: LevelKey[] = ["stop", "target", "entry", "whatIf"]; // later wins when lines overlap
const GRAB_PX = 7;

/** Paints the profit and loss zones behind the candles. */
class Zones implements ISeriesPrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPrimitivePaneView[];

  constructor(
    private readonly series: () => ISeriesApi<"Candlestick"> | null,
    private readonly levels: () => Levels,
  ) {
    this.views = [{ zOrder: () => "bottom", renderer: () => this.renderer() }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = null;
  }

  redraw(): void {
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private renderer(): IPrimitivePaneRenderer {
    const series = this.series();
    const { entry, stop, target } = this.levels();
    const y = (p: number | null) => (p == null || !series ? null : series.priceToCoordinate(p));
    const yEntry = y(entry);
    const yStop = entry != null && stop != null && stop < entry ? y(stop) : null;
    const yTarget = entry != null && target != null && target > entry ? y(target) : null;
    return {
      draw: (target) =>
        target.useBitmapCoordinateSpace(({ context: ctx, verticalPixelRatio: vr, bitmapSize }) => {
          if (yEntry == null) return;
          const band = (from: number, to: number, colour: string) => {
            const top = Math.min(from, to) * vr;
            ctx.fillStyle = colour;
            ctx.fillRect(0, top, bitmapSize.width, Math.abs(to - from) * vr);
          };
          if (yTarget != null) band(yEntry, yTarget, `${UP}24`);
          if (yStop != null) band(yEntry, yStop, `${DOWN}24`);
        }),
    };
  }
}

type Props = {
  bars: Bar[];
  /** Show clock times on the axis (intraday) rather than dates. */
  intraday: boolean;
  levels: Levels;
  onChange: (key: LevelKey, price: number) => void;
  /** Controls shown before the zoom buttons (the timeframes). */
  toolbar?: ReactNode;
  /** Text at the right of the toolbar. */
  hint?: ReactNode;
};

/** A short day fills the chart; a long history opens on its most recent bars. */
function frame(chart: IChartApi, count: number, intraday: boolean) {
  const show = intraday ? 90 : 120;
  if (count <= show) chart.timeScale().fitContent();
  else chart.timeScale().setVisibleLogicalRange({ from: count - show, to: count + 6 });
}

export function PlanChart({ bars, intraday, levels, onChange, toolbar, hint }: Props) {
  const [spacing, setSpacing] = useState(DEFAULT_BAR_SPACING);
  const view = useRef({ count: bars.length, intraday });
  view.current = { count: bars.length, intraday };
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lines = useRef<Partial<Record<LevelKey, IPriceLine>>>({});
  const zones = useRef<Zones | null>(null);
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const framed = useRef("");

  // Create the chart and the dragging once.
  useEffect(() => {
    const container = box.current!;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#7d848e",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: true, // TradingView attribution, required by the licence
      },
      grid: { vertLines: { color: "#16191d" }, horzLines: { color: "#16191d" } },
      rightPriceScale: { borderColor: "#24282e", scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: "#24282e", secondsVisible: false, rightOffset: 6 },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      priceLineVisible: false,
      lastValueVisible: true,
      // Keep every plan line on screen, even far from today's prices.
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const base = original();
        const prices = Object.values(levelsRef.current).filter((p): p is number => p != null && p > 0);
        if (!base && prices.length === 0) return null;
        const min = Math.min(...prices, base?.priceRange.minValue ?? Infinity);
        const max = Math.max(...prices, base?.priceRange.maxValue ?? -Infinity);
        return { priceRange: { minValue: min, maxValue: max } };
      },
    });
    chart.timeScale().applyOptions({ minBarSpacing: MIN_BAR_SPACING, maxBarSpacing: MAX_BAR_SPACING });
    // The planner only re-frames when the timeframe changes, so any zoom already stays put.
    const detachZoom = attachZoom(chart, container, () => undefined, setSpacing);
    chartRef.current = chart;
    seriesRef.current = series;
    const layer = new Zones(() => seriesRef.current, () => levelsRef.current);
    series.attachPrimitive(layer);
    zones.current = layer;

    // ----- dragging the lines -----
    let dragging: LevelKey | null = null;
    let swallow = false;
    const localY = (e: PointerEvent) => e.clientY - container.getBoundingClientRect().top;
    const nearest = (y: number): LevelKey | null => {
      let best: LevelKey | null = null;
      let bestGap = GRAB_PX;
      for (const key of ORDER) {
        const price = levelsRef.current[key];
        const at = price == null ? null : series.priceToCoordinate(price);
        if (at == null) continue;
        const gap = Math.abs(at - y);
        if (gap <= bestGap) {
          best = key;
          bestGap = gap;
        }
      }
      return best;
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const key = nearest(localY(e));
      if (!key) return; // not on a line: let the chart pan as usual
      e.stopPropagation();
      e.preventDefault();
      swallow = true;
      dragging = key;
      container.classList.add("dragging");
      window.addEventListener("pointermove", onDrag);
      window.addEventListener("pointerup", onUp);
    };
    const onSwallow = (e: Event) => {
      if (!swallow) return;
      e.stopPropagation();
      if (e.type === "mousedown") swallow = false;
    };
    const onDrag = (e: PointerEvent) => {
      if (!dragging) return;
      const price = series.coordinateToPrice(localY(e));
      if (price != null && price > 0) changeRef.current(dragging, snap(price));
    };
    const onUp = () => {
      dragging = null;
      swallow = false;
      container.classList.remove("dragging");
      window.removeEventListener("pointermove", onDrag);
      window.removeEventListener("pointerup", onUp);
    };
    const onHover = (e: PointerEvent) => {
      if (dragging) return;
      container.classList.toggle("over-line", nearest(localY(e)) != null);
    };
    container.addEventListener("pointerdown", onDown, { capture: true });
    for (const kind of ["mousedown", "touchstart"] as const) container.addEventListener(kind, onSwallow, { capture: true });
    container.addEventListener("pointermove", onHover);

    return () => {
      detachZoom();
      onUp();
      container.removeEventListener("pointerdown", onDown, { capture: true });
      for (const kind of ["mousedown", "touchstart"] as const) container.removeEventListener(kind, onSwallow, { capture: true });
      container.removeEventListener("pointermove", onHover);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lines.current = {};
    };
  }, []);

  // Candles. Re-frame only when the kind of chart changes, so a drag or new candle doesn't jump.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    chart.timeScale().applyOptions({ timeVisible: intraday });
    const cheap = bars.length > 0 && bars[bars.length - 1].close < 2;
    series.applyOptions({ priceFormat: { type: "price", precision: cheap ? 3 : 2, minMove: cheap ? 0.001 : 0.01 } });
    series.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    const kind = `${intraday}:${bars.length > 0 ? bars[0].time : ""}`;
    if (bars.length > 0 && framed.current !== kind) {
      framed.current = kind;
      // After layout, so the chart knows its width.
      requestAnimationFrame(() => frame(chart, bars.length, intraday));
    }
  }, [bars, intraday]);

  // The plan's lines and zones.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const key of ORDER) {
      const price = levels[key];
      const existing = lines.current[key];
      if (price == null || price <= 0) {
        if (existing) series.removePriceLine(existing);
        delete lines.current[key];
        continue;
      }
      const style = LEVEL_STYLE[key];
      const options = {
        price,
        color: style.color,
        lineWidth: (key === "whatIf" ? 1 : 2) as 1 | 2,
        lineStyle: key === "whatIf" ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: style.title,
      };
      if (existing) existing.applyOptions(options);
      else lines.current[key] = series.createPriceLine(options);
    }
    zones.current?.redraw();
  }, [levels]);

  function stepZoom(direction: 1 | -1) {
    const timeScale = chartRef.current?.timeScale();
    if (!timeScale) return;
    const next = steppedSpacing(timeScale.options().barSpacing, direction);
    timeScale.applyOptions({ barSpacing: next });
    setSpacing(next);
  }

  function resetZoom() {
    const chart = chartRef.current;
    if (!chart) return;
    frame(chart, view.current.count, view.current.intraday);
    setSpacing(chart.timeScale().options().barSpacing);
  }

  return (
    <>
      <div className="chart-toolbar">
        <div className="toolbar-left">
          {toolbar}
          <ZoomControls spacing={spacing} onStep={stepZoom} onReset={resetZoom} />
        </div>
        {hint}
      </div>
      <div className="plan-chart" ref={box} />
    </>
  );
}
