import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { PHASE_HELP, PHASE_LABELS, clockTime, formatDay } from "../format";
import { OrderTicket } from "../live/OrderTicket";
import type { LiveStatus } from "../live/types";
import { INDEX, REFRESH_OPTIONS, priceOf, useMarket } from "./market";
import { type Page, go, stockPath } from "./router";
import { Change, FlashPrice, Icon, LogoMark, money, pct, tone, useFlash } from "./ui";

const NAV: { page: Page; path: string; label: string; icon: string }[] = [
  { page: "home", path: "/", label: "Home", icon: "home" },
  { page: "watchlist", path: "/watchlist", label: "Watchlist", icon: "watchlist" },
  { page: "portfolio", path: "/portfolio", label: "Portfolio", icon: "portfolio" },
  { page: "planner", path: "/planner", label: "Planner", icon: "planner" },
  { page: "coach", path: "/coach", label: "Coach", icon: "coach" },
  { page: "swing", path: "/swing", label: "Practice", icon: "swing" },
  { page: "replay", path: "/replay", label: "Replay", icon: "replay" },
];
const DEMO_SPEEDS = [1, 5, 20];

/** The frame around every page: sidebar, top bar, demo banner and the trade panel. */
export function Shell({ page, children }: { page: Page; children: ReactNode }) {
  const active = page === "stock" ? "watchlist" : page;
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <a className="logo" href="#/" aria-label="ASX-sim home">
          <LogoMark size={38} />
        </a>
        {NAV.map((n) => (
          <a key={n.page} href={`#${n.path}`} className={`nav-item ${active === n.page ? "active" : ""}`} aria-current={active === n.page ? "page" : undefined}>
            <Icon name={n.icon} size={22} />
            <span>{n.label}</span>
          </a>
        ))}
        <div className="nav-spacer" />
        <SettingsMenu />
      </nav>
      <div className="shell-main">
        <TopBar />
        <DemoBanner />
        <main className="page">{children}</main>
      </div>
      <TradeDrawer />
    </div>
  );
}

function TopBar() {
  const { feed } = useMarket();
  const account = feed.account;
  return (
    <header className="topbar">
      <div className="topbar-left">
        <a className="brand-link" href="#/" aria-label="ASX-sim home">
          <span className="wordmark">
            ASX<span>sim</span>
          </span>
          <span className="brand-tag">Trading simulator</span>
        </a>
        <SymbolSearch />
      </div>
      <div className="topbar-right">
        <IndexTicker />
        <MarketStatus status={feed.status} connected={feed.connected} />
        {account && (
          <a className="equity-chip" href="#/portfolio" title="Your account's total value: cash plus holdings. Click for your portfolio.">
            <span className="muted">Equity</span>
            <strong>{money(account.equity)}</strong>
            <span className={tone(account.net_pnl)}>{money(account.net_pnl, true)}</span>
          </a>
        )}
      </div>
    </header>
  );
}

function SymbolSearch() {
  const { defaults } = useMarket();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const starts = defaults.universe.filter((u) => u.code.startsWith(q));
    const named = defaults.universe.filter((u) => !u.code.startsWith(q) && u.name.toUpperCase().includes(q));
    return [...starts, ...named].slice(0, 8);
  }, [query, defaults.universe]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function choose(code: string) {
    go(stockPath(code));
    setQuery("");
    setOpen(false);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (matches[0]) choose(matches[0].code);
  }

  return (
    <div className="search" ref={box}>
      <form onSubmit={submit} role="search">
        <Icon name="search" size={18} />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          placeholder="Search ASX code or company"
          aria-label="Search for a stock"
        />
      </form>
      {open && matches.length > 0 && (
        <ul className="search-results" role="listbox">
          {matches.map((m) => (
            <li key={m.code}>
              <button type="button" onClick={() => choose(m.code)}>
                <strong>{m.code}</strong>
                <span className="muted">{m.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The ASX 200 in the top bar, as broker sites show the main index. */
function IndexTicker() {
  const { feed } = useMarket();
  const shown = priceOf(feed.quotes[INDEX], feed.candlesFor(INDEX));
  const flash = useFlash(shown.price);
  return (
    <a className="index-ticker" href={`#${stockPath(INDEX)}`} title="S&P/ASX 200 index">
      <span className="muted">ASX 200</span>
      <strong className={`flash-target ${flash}`}>
        {shown.price != null ? shown.price.toLocaleString("en-AU", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "—"}
      </strong>
      <span className={tone(shown.pct)}>{pct(shown.pct)}</span>
    </a>
  );
}

function feedText(status: LiveStatus | null, connected: boolean): string {
  if (!connected) return "Connecting to the price feed…";
  if (!status) return "Loading today's session…";
  if (status.error) return status.error;
  if (status.source === "demo") return "Demo: a recorded day replayed as if live. Not today's market.";
  if (status.feed === "yahoo-poll") return `Fallback: checking prices every 15s (${status.fallback_reason ?? "stream unavailable"})`;
  const age = status.seconds_since_tick;
  if (age == null) return status.phase === "open" ? "Waiting for the first live price…" : "Prices stream once the ASX opens.";
  return `Streaming delayed prices · last update ${age < 2 ? "just now" : `${Math.round(age)}s ago`}`;
}

function MarketStatus({ status, connected }: { status: LiveStatus | null; connected: boolean }) {
  const phase = status?.phase ?? "closed";
  const delay = status?.delay_seconds;
  const delayText =
    status?.source === "demo" ? "Demo" : delay != null ? `Delayed ${Math.round(delay / 60)} min` : "Delayed ~20 min";
  return (
    <div className={`market-status phase-${phase}`} title={`${PHASE_HELP[phase]}\n${feedText(status, connected)}`}>
      <span className={`dot ${connected ? "" : "off"}`} aria-hidden />
      <strong>{PHASE_LABELS[phase]}</strong>
      <span className="clock">{status ? clockTime(status.market_time) : "--:--:--"}</span>
      <span className={`delay ${status?.source === "demo" ? "demo" : ""}`}>{delayText}</span>
    </div>
  );
}

function DemoBanner() {
  const { source, setSource, demoDays } = useMarket();
  if (source.kind !== "demo") return null;
  return (
    <div className="demo-banner">
      <span>
        <strong>Demo mode</strong> · replaying {source.day ? formatDay(source.day) : "a recorded day"} as if live, with a separate practice account.
      </span>
      <select value={source.day ?? ""} onChange={(e) => setSource({ ...source, day: e.target.value })} aria-label="Demo day">
        {demoDays.map((d) => (
          <option key={d} value={d}>
            {formatDay(d)}
          </option>
        ))}
      </select>
      <div className="segmented-small" role="group" aria-label="Demo speed">
        {DEMO_SPEEDS.map((s) => (
          <button key={s} className={source.speed === s ? "active" : ""} onClick={() => setSource({ ...source, speed: s })}>
            {s}×
          </button>
        ))}
      </div>
      <button className="primary small" onClick={() => setSource({ kind: "live" })}>
        Back to live
      </button>
    </div>
  );
}

function SettingsMenu() {
  const { refreshMs, setRefreshMs, source, setSource, demoDays } = useMarket();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  return (
    <div className="settings" ref={box}>
      <button className={`nav-item ${open ? "active" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="settings" size={22} />
        <span>Settings</span>
      </button>
      {open && (
        <div className="settings-panel" role="dialog" aria-label="Settings">
          <h4>Price refresh</h4>
          <p className="muted small-text">How often prices redraw. Orders always see every price.</p>
          <div className="segmented-small">
            {REFRESH_OPTIONS.map((o) => (
              <button key={o.ms} className={refreshMs === o.ms ? "active" : ""} onClick={() => setRefreshMs(o.ms)}>
                {o.label}
              </button>
            ))}
          </div>
          <h4>Market data</h4>
          <p className="muted small-text">
            {source.kind === "live"
              ? "Live ASX prices, about 20 minutes delayed. Outside market hours, try a recorded day instead."
              : "You're in demo mode, replaying a recorded day."}
          </p>
          {source.kind === "live" ? (
            <button
              className="primary small"
              disabled={demoDays.length === 0}
              onClick={() => {
                setSource({ kind: "demo", day: demoDays[0] ?? null, speed: 5 });
                setOpen(false);
              }}
            >
              Try the demo
            </button>
          ) : (
            <button className="small" onClick={() => setSource({ kind: "live" })}>
              Back to live
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The trade panel that slides in from the right (from Portfolio and Watchlist rows). */
function TradeDrawer() {
  const { tradeTarget, closeTrade, feed, names, defaults, placeOrder } = useMarket();
  useEffect(() => {
    if (!tradeTarget) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeTrade();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tradeTarget, closeTrade]);
  if (!tradeTarget) return null;
  const { symbol, side, prefill, opened } = tradeTarget;
  const quote = feed.quotes[symbol];
  const shown = priceOf(quote, feed.candlesFor(symbol));
  return (
    <>
      <div className="drawer-backdrop" onClick={closeTrade} />
      <aside className="drawer" aria-label={`Trade ${symbol}`}>
        <header className="drawer-head">
          <div>
            <a href={`#${stockPath(symbol)}`} onClick={closeTrade} className="drawer-symbol">
              {symbol}
            </a>
            <span className="muted">{names[symbol]}</span>
          </div>
          <button className="icon-button" onClick={closeTrade} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="drawer-price">
          <FlashPrice value={shown.price} className="big-price" />
          <Change change={shown.change} percent={shown.pct} price={shown.price} />
        </div>
        <OrderTicket
          key={`${symbol}-${side}-${opened}`}
          symbol={symbol}
          name={names[symbol] ?? ""}
          quote={quote}
          lastPrice={shown.price}
          account={feed.account}
          phase={feed.status?.phase ?? "closed"}
          halted={(feed.status?.halted ?? []).includes(symbol)}
          journalOptions={defaults.journal}
          onSubmit={placeOrder}
          initialSide={side}
          prefill={prefill}
          compact
        />
      </aside>
    </>
  );
}
