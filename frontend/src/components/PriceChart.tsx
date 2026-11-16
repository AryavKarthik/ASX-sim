import {
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  LineStyle,
  type SeriesType,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";

import { type Bar, type HistoryInterval, fetchHistory } from "../api";
import {
  type Series as Values,
  aggregate,
  bollinger,
  dailyCandle,
  ema,
  macd,
  rsi,
  sma,
  vwap,
  withToday,
} from "../live/indicators";

export type PriceChartHandle = {
  /** Replace the day's 1-minute candles (used for the first snapshot and symbol changes). */
  reset: (bars: Bar[]) => void;
  /** Add or update 1-minute candles. */
  append: (bars: Bar[]) => void;
};

const UP = "#26a69a";
const DOWN = "#ef5350";
// Indicator colours: categorical slots validated against the chart surface #121923
// (dataviz validate_palette: CVD ΔE >= 13, contrast >= 3:1). Bollinger Bands are one
// entity drawn as a neutral dashed envelope; MACD/signal reuse the validated blue/orange pair.
const COLOURS = { sma20: "#c98500", ema9: "#9085e9", vwap: "#d55181", bb: "#8b96a5", line: "#3987e5", signal: "#d95926" };

type Timeframe = "1m" | "5m" | "15m" | "1h" | HistoryInterval;
const TIMEFRAMES: { key: Timeframe; label: string; minutes?: number }[] = [
  { key: "1m", label: "1m", minutes: 1 },
  { key: "5m", label: "5m", minutes: 5 },
  { key: "15m", label: "15m", minutes: 15 },
  { key: "1h", label: "1h", minutes: 60 },
  { key: "1d", label: "D" },
  { key: "1wk", label: "W" },
  { key: "1mo", label: "M" },
];

type IndicatorKey = "sma20" | "ema9" | "vwap" | "bb" | "rsi" | "macd";
const INDICATORS: { key: IndicatorKey; label: string; help: string; intradayOnly?: boolean }[] = [
  { key: "ema9", label: "EMA 9", help: "9-bar exponential moving average: a fast trend line that reacts quickly to new prices." },
  { key: "sma20", label: "SMA 20", help: "20-bar simple moving average: the average close of the last 20 bars, a slower trend line." },
  { key: "vwap", label: "VWAP", help: "Volume-weighted average price today: the average price everyone has paid. Day traders watch whether price is above or below it.", intradayOnly: true },
  { key: "bb", label: "Bollinger", help: "Bollinger Bands: the 20-bar average ± 2 standard deviations. Wide bands = volatile; price at a band is stretched." },
  { key: "rsi", label: "RSI", help: "Relative Strength Index (14): momentum from 0 to 100. Above 70 is often called overbought, below 30 oversold." },
  { key: "macd", label: "MACD", help: "MACD (12, 26, 9): the gap between a fast and a slow moving average, with a signal line. Crossovers hint at momentum shifts." },
];

const TF_KEY = "asxsim.chart.timeframe";
const IND_KEY = "asxsim.chart.indicators";

function load<T>(key: string, fallback: T, valid: (v: unknown) => boolean): T {
  try {
    const raw = window.localStorage.getItem(key);
    const value: unknown = raw == null ? null : JSON.parse(raw);
    return value != null && valid(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the choice just won't be remembered.
  }
}

// Early in a session there are only a few candles: draw them at a normal width from the left
// instead of stretching two candles across the whole chart. Between these counts, stretch to
// fill the chart; after that it scrolls like a live feed (and you can zoom or pan freely).
const FIT_FROM_BARS = 40;
const FIT_UNTIL_BARS = 120;
const DEFAULT_BAR_SPACING = 8;
const LONG_VIEW_BARS = 150; // daily/weekly/monthly open on roughly this many recent bars

function frame(chart: IChartApi, count: number) {
  if (count >= FIT_FROM_BARS && count <= FIT_UNTIL_BARS) {
    chart.timeScale().fitContent();
  } else if (count < FIT_FROM_BARS) {
    const visibleBars = Math.floor(chart.timeScale().width() / DEFAULT_BAR_SPACING);
    chart.timeScale().applyOptions({ barSpacing: DEFAULT_BAR_SPACING });
    chart.timeScale().scrollToPosition(Math.max(2, visibleBars - count - 1), false);
  }
}

type Core = { chart: IChartApi; candles: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram"> };
type Studies = Partial<Record<string, ISeriesApi<SeriesType>>>;

const toCandle = (b: Bar) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });
const toVolume = (b: Bar) => ({
  time: b.time as UTCTimestamp,
  value: b.volume,
  color: b.close >= b.open ? `${UP}66` : `${DOWN}66`,
});
function toLine(bars: Bar[], values: Values) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const v = values[i];
    if (v != null) out.push({ time: bars[i].time as UTCTimestamp, value: v });
  }
  return out;
}

const line = (color: string, title: string, extra: object = {}) => ({
  color,
  lineWidth: 2 as const,
  title,
  priceLineVisible: false,
  crosshairMarkerVisible: false,
  ...extra,
});

type Props = { ref: Ref<PriceChartHandle>; symbol: string; sessionDay: string | null };

/** Candlesticks with volume, timeframes and indicators, drawn by TradingView Lightweight Charts. */
export function PriceChart({ ref, symbol, sessionDay }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const core = useRef<Core | null>(null);
  const studies = useRef<Studies>({});
  const intraday = useRef<Bar[]>([]);
  const history = useRef<Bar[] | null>(null); // long-timeframe bars before today; null = loading
  const lastCount = useRef(0);

  const [timeframe, setTimeframe] = useState<Timeframe>(() =>
    load(TF_KEY, "1m", (v) => TIMEFRAMES.some((t) => t.key === v)),
  );
  const [active, setActive] = useState<IndicatorKey[]>(() =>
    load(IND_KEY, ["vwap"], (v) => Array.isArray(v) && v.every((k) => INDICATORS.some((i) => i.key === k))),
  );
  const [historyError, setHistoryError] = useState<string | null>(null);

  const minutes = TIMEFRAMES.find((t) => t.key === timeframe)?.minutes;
  const intradayView = minutes != null;
  const shown = active.filter((k) => intradayView || !INDICATORS.find((i) => i.key === k)?.intradayOnly);

  // Kept in refs so the imperative handle (created once) always draws the current choice.
  const view = useRef({ minutes, timeframe, shown });
  view.current = { minutes, timeframe, shown };

  /** The bars for the chosen timeframe, from today's 1-minute candles (+ history). */
  function bars(): Bar[] {
    const v = view.current;
    if (v.minutes != null) return aggregate(intraday.current, v.minutes);
    if (history.current == null) return [];
    return withToday(history.current, dailyCandle(intraday.current), v.timeframe as HistoryInterval);
  }

  function draw(reframe: boolean) {
    const c = core.current;
    if (!c) return;
    const data = bars();
    c.candles.setData(data.map(toCandle));
    c.volume.setData(data.map(toVolume));

    const s = studies.current;
    const set = (key: string, values: Values) => s[key]?.setData(toLine(data, values));
    if (s.sma20) set("sma20", sma(data, 20));
    if (s.ema9) set("ema9", ema(data, 9));
    if (s.vwap) set("vwap", vwap(data));
    if (s.bbUpper) {
      const bb = bollinger(data);
      set("bbUpper", bb.upper);
      set("bbMiddle", bb.middle);
      set("bbLower", bb.lower);
    }
    if (s.rsi) set("rsi", rsi(data));
    if (s.macd) {
      const m = macd(data);
      set("macd", m.macd);
      set("signal", m.signal);
      s.histogram?.setData(
        data.flatMap((b, i) => {
          const h = m.histogram[i];
          return h == null ? [] : [{ time: b.time as UTCTimestamp, value: h, color: h >= 0 ? `${UP}99` : `${DOWN}99` }];
        }),
      );
    }

    if (view.current.minutes != null) {
      if (reframe || data.length !== lastCount.current) {
        if (reframe && data.length > FIT_UNTIL_BARS) c.chart.timeScale().fitContent();
        else frame(c.chart, data.length);
      }
    } else if (reframe && data.length > 0) {
      c.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - LONG_VIEW_BARS), to: data.length + 3 });
    }
    lastCount.current = data.length;
  }

  // Create the chart once.
  useEffect(() => {
    const chart = createChart(container.current!, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#9aa4b2",
        fontFamily: "Inter, system-ui, sans-serif",
        attributionLogo: true, // TradingView attribution, required by the licence
        panes: { separatorColor: "#2a3441" },
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
    core.current = { chart, candles, volume };
    return () => {
      chart.remove();
      core.current = null;
      studies.current = {};
    };
  }, []);

  // Rebuild the indicator series (and their panes) when the selection or timeframe changes.
  const shownKey = shown.join(",");
  useEffect(() => {
    const c = core.current;
    if (!c) return;
    for (const series of Object.values(studies.current)) if (series) c.chart.removeSeries(series);
    for (let i = c.chart.panes().length - 1; i > 0; i--) c.chart.removePane(i);
    const s: Studies = {};
    const on = new Set(shown);
    if (on.has("bb")) {
      const band = { lineWidth: 1 as const, lineStyle: LineStyle.Dashed, lastValueVisible: false };
      s.bbUpper = c.chart.addSeries(LineSeries, line(COLOURS.bb, "", band));
      s.bbMiddle = c.chart.addSeries(LineSeries, line(COLOURS.bb, "BB 20", { lineWidth: 1 }));
      s.bbLower = c.chart.addSeries(LineSeries, line(COLOURS.bb, "", band));
    }
    if (on.has("sma20")) s.sma20 = c.chart.addSeries(LineSeries, line(COLOURS.sma20, "SMA 20"));
    if (on.has("ema9")) s.ema9 = c.chart.addSeries(LineSeries, line(COLOURS.ema9, "EMA 9"));
    if (on.has("vwap")) s.vwap = c.chart.addSeries(LineSeries, line(COLOURS.vwap, "VWAP"));
    let pane = 1;
    if (on.has("rsi")) {
      const r = c.chart.addSeries(
        LineSeries,
        line(COLOURS.line, "RSI 14", {
          autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
          priceFormat: { type: "price", precision: 1, minMove: 0.1 },
        }),
        pane,
      );
      for (const level of [70, 30])
        r.createPriceLine({ price: level, color: "#5a6676", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "" });
      s.rsi = r;
      pane += 1;
    }
    if (on.has("macd")) {
      const fmt = { priceFormat: { type: "price" as const, precision: 3, minMove: 0.001 } };
      s.histogram = c.chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, ...fmt }, pane);
      s.macd = c.chart.addSeries(LineSeries, line(COLOURS.line, "MACD", fmt), pane);
      s.signal = c.chart.addSeries(LineSeries, line(COLOURS.signal, "Signal", fmt), pane);
      pane += 1;
    }
    // Price gets three shares of the height, each indicator panel one.
    c.chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));
    studies.current = s;
    draw(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  // Load long-term history when needed. It stops before the session day: today's bar is built
  // from the delayed candles, and a demo never sees its own day (or later) in history.
  useEffect(() => {
    core.current?.chart.timeScale().applyOptions({ timeVisible: intradayView });
    setHistoryError(null);
    if (intradayView) {
      draw(true);
      return;
    }
    history.current = null;
    draw(false);
    if (!symbol) return;
    let current = true;
    fetchHistory(symbol, timeframe as HistoryInterval, sessionDay)
      .then((b) => {
        if (!current) return;
        history.current = b;
        draw(true);
      })
      .catch((e: Error) => current && setHistoryError(e.message));
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe, sessionDay, intradayView]);

  useImperativeHandle(
    ref,
    () => ({
      reset(next) {
        const c = core.current;
        if (!c) return;
        // Shares under $2 can trade at fractions of a cent (and midpoint trades go finer).
        const cheap = next.length > 0 && next[0].close < 2;
        c.candles.applyOptions({
          priceFormat: { type: "price", precision: cheap ? 4 : 3, minMove: cheap ? 0.0001 : 0.001 },
        });
        intraday.current = [...next];
        draw(true);
      },
      append(next) {
        if (next.length === 0) return;
        const day = intraday.current;
        for (const bar of next) {
          // A bar with the same time as the last one is an update to the forming candle.
          if (day.length > 0 && day[day.length - 1].time === bar.time) day[day.length - 1] = bar;
          else if (day.length === 0 || bar.time > day[day.length - 1].time) day.push(bar);
        }
        draw(false);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function toggle(key: IndicatorKey) {
    const next = active.includes(key) ? active.filter((k) => k !== key) : [...active, key];
    setActive(next);
    save(IND_KEY, next);
  }

  function chooseTimeframe(key: Timeframe) {
    setTimeframe(key);
    save(TF_KEY, key);
  }

  return (
    <div className={`price-chart panes-${shown.filter((k) => k === "rsi" || k === "macd").length}`}>
      <div className="chart-toolbar">
        <div className="tf" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.key}
              className={timeframe === t.key ? "active" : ""}
              onClick={() => chooseTimeframe(t.key)}
              title={t.minutes ? `${t.minutes}-minute candles from today's session` : `${t.key === "1d" ? "Daily" : t.key === "1wk" ? "Weekly" : "Monthly"} candles with long-term history`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="studies" role="group" aria-label="Indicators">
          {INDICATORS.map((i) => {
            const off = i.intradayOnly && !intradayView;
            const colour = i.key === "rsi" || i.key === "macd" ? COLOURS.line : COLOURS[i.key];
            return (
              <button
                key={i.key}
                className={active.includes(i.key) && !off ? "active" : ""}
                disabled={off}
                aria-pressed={active.includes(i.key)}
                onClick={() => toggle(i.key)}
                title={off ? "VWAP resets every day, so it's only shown on intraday timeframes." : i.help}
              >
                <i style={{ background: colour }} />
                {i.label}
              </button>
            );
          })}
        </div>
      </div>
      {historyError && <p className="error small-text chart-note">Couldn't load history: {historyError}</p>}
      {!intradayView && history.current == null && !historyError && <p className="muted small-text chart-note">Loading history…</p>}
      <div className="chart" ref={container} />
    </div>
  );
}
