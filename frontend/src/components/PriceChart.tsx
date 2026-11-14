import {
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";

import type { Bar } from "../api";

export type PriceChartHandle = {
  /** Replace everything on the chart (used for the first snapshot). */
  reset: (bars: Bar[]) => void;
  /** Add bars that have just finished. */
  append: (bars: Bar[]) => void;
};

const UP = "#26a69a";
const DOWN = "#ef5350";
// Until this many bars exist, keep stretching them to fill the chart; after that the chart
// scrolls like a live feed (and you can zoom or pan freely).
const FIT_UNTIL_BARS = 120;

type Series = {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
};

const toCandle = (b: Bar) => ({
  time: b.time as UTCTimestamp,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
});

const toVolume = (b: Bar) => ({
  time: b.time as UTCTimestamp,
  value: b.volume,
  color: b.close >= b.open ? `${UP}66` : `${DOWN}66`,
});

/** Candlesticks with volume underneath, drawn by TradingView Lightweight Charts. */
export function PriceChart({ ref }: { ref: Ref<PriceChartHandle> }) {
  const container = useRef<HTMLDivElement>(null);
  const series = useRef<Series | null>(null);
  const barCount = useRef(0);

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
      timeScale: { borderColor: "#2a3441", timeVisible: true, secondsVisible: false },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
    });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.28 } });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    series.current = { chart, candles, volume };
    return () => {
      chart.remove();
      series.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      reset(bars) {
        const s = series.current;
        if (!s) return;
        // Shares under $2 can trade at fractions of a cent (and midpoint trades go finer).
        const cheap = bars.length > 0 && bars[0].close < 2;
        s.candles.applyOptions({
          priceFormat: { type: "price", precision: cheap ? 4 : 3, minMove: cheap ? 0.0001 : 0.001 },
        });
        s.candles.setData(bars.map(toCandle));
        s.volume.setData(bars.map(toVolume));
        barCount.current = bars.length;
        s.chart.timeScale().fitContent();
      },
      append(bars) {
        const s = series.current;
        if (!s || bars.length === 0) return;
        for (const bar of bars) {
          s.candles.update(toCandle(bar));
          s.volume.update(toVolume(bar));
        }
        barCount.current += bars.length;
        if (barCount.current <= FIT_UNTIL_BARS) s.chart.timeScale().fitContent();
      },
    }),
    [],
  );

  return <div className="chart" ref={container} />;
}
