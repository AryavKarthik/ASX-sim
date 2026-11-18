import { type IChartApi, type ISeriesApi, LineSeries, type UTCTimestamp, createChart } from "lightweight-charts";
import { useEffect, useRef } from "react";

// Categorical slots 1 and 2 of the reference palette, dark steps; validated against the
// panel surface #121923 (CVD ΔE 26.8, contrast >= 3:1).
const ACCOUNT = "#3987e5";
const BENCHMARK = "#d95926";

type Point = { time: number; equity: number };

/** Strictly increasing times, as the chart requires (two closes in one second keep the last). */
function prepare(points: Point[]) {
  const byTime = new Map<number, number>();
  for (const p of points) byTime.set(Math.floor(p.time), p.equity);
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

type Labels = { account: string; benchmark: string; benchmarkTitle: string };
const ASX200: Labels = {
  account: "Your account",
  benchmark: "ASX 200, if you'd invested the same starting cash",
  benchmarkTitle: "ASX 200",
};

type Props = {
  curve: Point[];
  benchmark: Point[];
  /** What the two lines are called (defaults to your account vs the ASX 200). */
  labels?: Labels;
  /** Draw equity as a continuous line (daily values) instead of steps at each closed trade. */
  smooth?: boolean;
};

/** Your equity over time against a benchmark rescaled to the same starting cash (one $ axis). */
export function EquityChart({ curve, benchmark, labels = ASX200, smooth = false }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const series = useRef<{ chart: IChartApi; account: ISeriesApi<"Line">; index: ISeriesApi<"Line"> } | null>(null);

  useEffect(() => {
    const chart = createChart(container.current!, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#7d848e",
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "#16191d" } },
      rightPriceScale: { borderColor: "#24282e" },
      timeScale: { borderColor: "#24282e", timeVisible: true, secondsVisible: false },
      localization: {
        priceFormatter: (p: number) => p.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }),
      },
    });
    const index = chart.addSeries(LineSeries, {
      color: BENCHMARK,
      lineWidth: 2,
      title: labels.benchmarkTitle,
      priceLineVisible: false,
    });
    const account = chart.addSeries(LineSeries, {
      color: ACCOUNT,
      lineWidth: 2,
      title: "You",
      priceLineVisible: false,
      lineType: smooth ? 0 : 1, // steps: equity changes when trades close
    });
    series.current = { chart, account, index };
    return () => {
      chart.remove();
      series.current = null;
    };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.account.setData(prepare(curve));
    s.index.setData(prepare(benchmark));
    s.chart.timeScale().fitContent();
  }, [curve, benchmark]);

  return (
    <div className="equity">
      <div className="legend" aria-label="Legend">
        <span>
          <i style={{ background: ACCOUNT }} /> {labels.account}
        </span>
        {benchmark.length > 0 && (
          <span>
            <i style={{ background: BENCHMARK }} /> {labels.benchmark}
          </span>
        )}
      </div>
      <div className="equity-chart" ref={container} />
    </div>
  );
}
