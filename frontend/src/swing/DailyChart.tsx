import {
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  LineSeries,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import type { Bar } from "../api";
import { sma } from "../live/indicators";

const UP = "#26a69a";
const DOWN = "#ef5350";
// Same validated categorical slots as the live chart's moving averages.
const SMA20 = "#c98500";
const SMA50 = "#9085e9";
const VISIBLE_BARS = 160;

export type FillMarker = { time: number; side: "buy" | "sell"; text: string };

type Parts = {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  fast: ISeriesApi<"Line">;
  slow: ISeriesApi<"Line">;
  markers: ISeriesMarkersPluginApi<Time>;
};

function line(bars: Bar[], values: (number | null)[]) {
  return bars.flatMap((b, i) => (values[i] == null ? [] : [{ time: b.time as UTCTimestamp, value: values[i] as number }]));
}

/** Daily candles with volume, 20- and 50-day averages, and arrows where your orders filled. */
export function DailyChart({ bars, fills, resetKey }: { bars: Bar[]; fills: FillMarker[]; resetKey: string }) {
  const container = useRef<HTMLDivElement>(null);
  const parts = useRef<Parts | null>(null);
  const framed = useRef("");

  useEffect(() => {
    const chart = createChart(container.current!, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#9aa4b2",
        fontFamily: "Inter, system-ui, sans-serif",
        attributionLogo: true, // TradingView attribution, required by the licence
      },
      grid: { vertLines: { color: "#1c2430" }, horzLines: { color: "#1c2430" } },
      rightPriceScale: { borderColor: "#2a3441" },
      timeScale: { borderColor: "#2a3441", timeVisible: false },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
    });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const average = (color: string, title: string) =>
      chart.addSeries(LineSeries, { color, title, lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false });
    parts.current = {
      chart,
      candles,
      volume,
      fast: average(SMA20, "SMA 20"),
      slow: average(SMA50, "SMA 50"),
      markers: createSeriesMarkers(candles, []),
    };
    return () => {
      chart.remove();
      parts.current = null;
    };
  }, []);

  useEffect(() => {
    const p = parts.current;
    if (!p) return;
    p.candles.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    p.volume.setData(
      bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? `${UP}66` : `${DOWN}66` })),
    );
    p.fast.setData(line(bars, sma(bars, 20)));
    p.slow.setData(line(bars, sma(bars, 50)));
    const marks: SeriesMarker<Time>[] = [...fills]
      .sort((a, b) => a.time - b.time)
      .map((f) => ({
        time: f.time as UTCTimestamp,
        position: f.side === "buy" ? "belowBar" : "aboveBar",
        shape: f.side === "buy" ? "arrowUp" : "arrowDown",
        color: f.side === "buy" ? UP : DOWN,
        text: f.text,
      }));
    p.markers.setMarkers(marks);
    // Frame the recent bars when a session opens (or its dates are revealed); afterwards
    // new days scroll in and any zoom or pan you set is kept.
    if (framed.current !== resetKey && bars.length > 0) {
      framed.current = resetKey;
      p.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - VISIBLE_BARS), to: bars.length + 8 });
    }
  }, [bars, fills, resetKey]);

  return (
    <div className="daily-chart">
      <div className="legend" aria-label="Legend">
        <span>
          <i style={{ background: SMA20 }} /> 20-day average
        </span>
        <span>
          <i style={{ background: SMA50 }} /> 50-day average
        </span>
        <span>
          <b className="up">▲</b> you bought
        </span>
        <span>
          <b className="down">▼</b> you sold
        </span>
      </div>
      <div className="chart" ref={container} />
    </div>
  );
}
