import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type Bar, fetchDays } from "../api";
import { PriceChart, type PriceChartHandle } from "../components/PriceChart";
import { PHASE_HELP, PHASE_LABELS, clockTime, formatDay, formatPrice } from "../format";
import { AccountPanel } from "./AccountPanel";
import { ActivityTabs } from "./ActivityTabs";
import { PerformancePanel } from "./PerformancePanel";
import { OrderTicket } from "./OrderTicket";
import type { Defaults, FeedSource, JournalEntry, LiveStatus, OrderCommand } from "./types";
import { useLiveFeed } from "./useLiveFeed";
import { Watchlist, displayQuote } from "./Watchlist";

const STORAGE_KEY = "asxsim.watchlist";
const REFRESH_KEY = "asxsim.refresh";
const DEMO_SPEEDS = [1, 5, 20];
// How often prices are redrawn. The trading engine still sees every price either way.
const REFRESH_OPTIONS = [
  { ms: 0, label: "Live" },
  { ms: 5_000, label: "5s" },
  { ms: 30_000, label: "30s" },
];
const DEFAULT_REFRESH = 30_000;

function loadRefresh(): number {
  try {
    const saved = Number(window.localStorage.getItem(REFRESH_KEY));
    return REFRESH_OPTIONS.some((o) => o.ms === saved) && window.localStorage.getItem(REFRESH_KEY) !== null
      ? saved
      : DEFAULT_REFRESH;
  } catch {
    return DEFAULT_REFRESH;
  }
}

function loadWatchlist(): string[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) && parsed.every((s) => typeof s === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function saveWatchlist(symbols: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols));
  } catch {
    // Storage blocked (private window): the list just won't be remembered.
  }
}

function formatDelay(status: LiveStatus | null): string {
  if (!status || status.source === "demo") return "";
  if (!status.delay_measured || status.delay_seconds == null) return "Delayed ~20 min";
  const total = Math.round(status.delay_seconds);
  return `Delayed ${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

function feedLine(status: LiveStatus | null, connected: boolean, demoDay: string | null, speed: number) {
  if (!connected) return { tone: "warn", text: "Connecting to the price feed…" };
  if (!status) return { tone: "warn", text: "Loading today's session…" };
  if (status.error) return { tone: "down", text: status.error };
  if (status.source === "demo") {
    return {
      tone: "info",
      text: `Demo: replaying ${demoDay ? formatDay(demoDay) : "a recorded day"} as if live (${speed}×). Not today's market.`,
    };
  }
  const age = status.seconds_since_tick;
  if (age == null && status.feed !== "yahoo-poll") {
    return status.phase === "open"
      ? { tone: "warn", text: "Connected. Waiting for the first live price…" }
      : { tone: "info", text: "Connected to the delayed feed. Prices will stream once the ASX opens." };
  }
  const fresh = age != null ? ` · last update ${age < 2 ? "just now" : `${Math.round(age)}s ago`}` : "";
  if (status.feed === "yahoo-poll") {
    return {
      tone: "warn",
      text: `Fallback: checking prices every 15s (${status.fallback_reason ?? "stream unavailable"})${fresh}`,
    };
  }
  return { tone: "up", text: `Streaming delayed prices as they update${fresh}` };
}

export function LiveView({ defaults }: { defaults: Defaults }) {
  const [symbols, setSymbols] = useState<string[]>(() => {
    const saved = loadWatchlist()?.filter((s) => defaults.universe.some((u) => u.code === s));
    return saved && saved.length > 0 ? saved.slice(0, defaults.max_symbols) : defaults.watchlist;
  });
  const [selected, setSelected] = useState(symbols[0]);
  const [source, setSource] = useState<FeedSource>({ kind: "live" });
  const [refreshMs, setRefreshMs] = useState<number>(loadRefresh);
  const [view, setView] = useState<"chart" | "performance">("chart");

  function chooseRefresh(ms: number) {
    setRefreshMs(ms);
    try {
      window.localStorage.setItem(REFRESH_KEY, String(ms));
    } catch {
      // Storage blocked: the choice just won't be remembered.
    }
  }
  const [demoDays, setDemoDays] = useState<string[]>([]);
  const chart = useRef<PriceChartHandle>(null);
  const selectedRef = useRef(selected);

  const names = useMemo(
    () => Object.fromEntries(defaults.universe.map((u) => [u.code, u.name])),
    [defaults.universe],
  );

  useEffect(() => {
    saveWatchlist(symbols);
    if (!symbols.includes(selected)) setSelected(symbols[0]);
  }, [symbols, selected]);

  useEffect(() => {
    fetchDays().then(setDemoDays).catch(() => setDemoDays([]));
  }, []);

  const onCandle = useCallback((symbol: string, candle: Bar) => {
    if (symbol === selectedRef.current) chart.current?.append([candle]);
  }, []);
  const feed = useLiveFeed(
    symbols,
    source,
    onCandle,
    () => {
      chart.current?.reset(feed.candlesFor(selectedRef.current));
    },
    refreshMs,
  );

  useEffect(() => {
    selectedRef.current = selected;
    chart.current?.reset(feed.candlesFor(selected));
    // feed.candlesFor reads a ref, so re-running on selection change is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const { status, quotes, connected, sessionDay, account, command } = feed;
  const placeOrder = useCallback((order: OrderCommand) => command("order", order), [command]);
  const cancelOrder = useCallback((orderId: string) => command("cancel", { order_id: orderId }), [command]);
  const requestAnalytics = useCallback(() => command("analytics", {}), [command]);
  const saveJournal = useCallback(
    (tradeId: string, fields: Partial<JournalEntry>) => command("journal", { trade_id: tradeId, fields }),
    [command],
  );
  const resetAccount = useCallback(
    (startingCash: string) => command("reset_account", { starting_cash: startingCash }),
    [command],
  );
  const quote = quotes[selected];
  const shown = displayQuote(quote, feed.candlesFor(selected));
  const up = (shown.pct ?? 0) >= 0;
  const phase = status?.phase ?? "closed";
  const halted = status?.halted ?? [];
  const selectedHalted = halted.includes(selected);
  const marketQuiet = status?.source === "live" && phase !== "open" && status.seconds_since_tick == null;
  const line = feedLine(status, connected, sessionDay, source.kind === "demo" ? source.speed : 1);

  return (
    <div className="live">
      <Watchlist
        symbols={symbols}
        names={names}
        quotes={quotes}
        ticks={feed.ticks}
        halted={halted}
        candlesFor={feed.candlesFor}
        selected={selected}
        maxSymbols={defaults.max_symbols}
        onSelect={setSelected}
        onAdd={(s) => setSymbols((list) => [...list, s])}
        onRemove={(s) => setSymbols((list) => list.filter((x) => x !== s))}
        onReset={() => setSymbols(defaults.watchlist)}
      />

      <section className="live-main">
        <header className="replay-header card">
          <div className="instrument">
            <span className="code">{selected}</span>
            <span className="muted">{names[selected]}</span>
          </div>
          <div className="quote">
            <span className="price">{shown.price != null ? formatPrice(shown.price) : "—"}</span>
            {shown.pct != null && (
              <span
                className={up ? "up" : "down"}
                title={quote ? `Change since ${quote.change_basis}` : "Change since the session's open"}
              >
                {quote?.change != null ? `${up ? "+" : "−"}${Math.abs(quote.change).toFixed(quote.price < 2 ? 3 : 2)} ` : ""}(
                {up ? "+" : "−"}
                {Math.abs(shown.pct).toFixed(2)}%)
              </span>
            )}
            {quote?.day_low != null && quote.day_high != null && (
              <span className="muted small-inline">
                Range {formatPrice(quote.day_low)}–{formatPrice(quote.day_high)}
              </span>
            )}
            {quote?.day_volume != null && (
              <span className="muted small-inline">Vol {quote.day_volume.toLocaleString("en-AU")}</span>
            )}
          </div>
          <div className="clock-block">
            {selectedHalted && (
              <span className="halt-badge" title="No trades for 15+ minutes while the rest of the market is trading, so this looks like a trading halt (usually ahead of a company announcement). Yahoo doesn't publish halts, so this is inferred.">
                Halted
              </span>
            )}
            {status?.source === "live" && <span className="delay-badge">{formatDelay(status)}</span>}
            {status?.source === "demo" && <span className="delay-badge demo">Demo</span>}
            <span className="clock" title="The delayed market's clock: real time minus the data delay">
              {status ? clockTime(status.market_time) : "--:--:--"}
            </span>
            <span className={`phase phase-${phase}`} title={PHASE_HELP[phase]}>
              {PHASE_LABELS[phase]}
            </span>
          </div>
        </header>

        <div className="tabs-row view-switch" role="tablist" aria-label="Main view">
          <button className={view === "chart" ? "active" : ""} onClick={() => setView("chart")}>
            Chart
          </button>
          <button className={view === "performance" ? "active" : ""} onClick={() => setView("performance")}>
            Performance
          </button>
        </div>

        {view === "performance" && (
          <section className="card performance-card">
            <PerformancePanel account={account} request={requestAnalytics} />
          </section>
        )}

        {/* The chart stays mounted (just hidden) so it keeps updating while you look at stats. */}
        <section className="chart-card card" style={view === "chart" ? undefined : { display: "none" }}>
          <PriceChart ref={chart} symbol={selected} sessionDay={sessionDay} />
          {marketQuiet && (
            <div className="overlay top">
              <strong>The ASX is closed</strong>
              <span>
                With the ~20 minute delay, live trading runs from about 10:20am to 4:30pm Sydney time on
                trading days.
              </span>
              {sessionDay && <span className="muted">Showing the last session: {formatDay(sessionDay)}.</span>}
            </div>
          )}
        </section>

        <footer className="controls card">
          <span className={`feed-dot ${line.tone}`} aria-hidden />
          <span className="feed-text">{line.text}</span>
          {feed.closedReason && <span className="error">{feed.closedReason}</span>}
          <div className="speeds refresh" role="group" aria-label="How often prices refresh">
            <span className="muted small-inline">Refresh</span>
            {REFRESH_OPTIONS.map((o) => (
              <button
                key={o.ms}
                className={refreshMs === o.ms ? "active" : ""}
                onClick={() => chooseRefresh(o.ms)}
                title={o.ms === 0 ? "Redraw on every price update" : `Redraw prices every ${o.label}`}
              >
                {o.label}
              </button>
            ))}
          </div>

          <div className="spacer" />
          {source.kind === "live" ? (
            <button onClick={() => setSource({ kind: "demo", day: demoDays[0] ?? null, speed: 5 })} disabled={demoDays.length === 0}>
              Try the demo
            </button>
          ) : (
            <>
              <select
                value={source.day ?? ""}
                onChange={(e) => setSource({ ...source, day: e.target.value })}
                aria-label="Demo day"
              >
                {demoDays.map((d) => (
                  <option key={d} value={d}>
                    {formatDay(d)}
                  </option>
                ))}
              </select>
              <div className="speeds" role="group" aria-label="Demo speed">
                {DEMO_SPEEDS.map((s) => (
                  <button key={s} className={source.speed === s ? "active" : ""} onClick={() => setSource({ ...source, speed: s })}>
                    {s}×
                  </button>
                ))}
              </div>
              <button className="primary" onClick={() => setSource({ kind: "live" })}>
                Back to live
              </button>
            </>
          )}
        </footer>

        <ActivityTabs
          account={account}
          onSelect={setSelected}
          onCancel={cancelOrder}
          onOrder={placeOrder}
          journalOptions={defaults.journal}
          onJournalSave={saveJournal}
        />
      </section>

      <aside className="trade-column">
        <OrderTicket
          symbol={selected}
          name={names[selected] ?? ""}
          quote={quote}
          lastPrice={shown.price}
          account={account}
          phase={phase}
          halted={selectedHalted}
          journalOptions={defaults.journal}
          onSubmit={placeOrder}
        />
        <AccountPanel account={account} source={source.kind} onReset={resetAccount} />
      </aside>
    </div>
  );
}
