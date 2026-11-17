import { useEffect, useRef, useState } from "react";

import { priceOf, useMarket } from "../app/market";
import { Change, Icon, Label, Price, compactNumber, money, pct, tone } from "../app/ui";
import { PriceChart, type PriceChartHandle } from "../components/PriceChart";
import { formatDay, formatPrice } from "../format";
import { compact, rangePosition, ratios } from "../live/company";
import { CompanyPanel, useCompany } from "../live/CompanyPanel";
import { OrderTicket } from "../live/OrderTicket";

type Tab = "about" | "position";

const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for trigger",
  queued: "Waiting for auction",
  working: "Working",
};

/** One stock: its price and trends, the chart, the order ticket, and everything about it. */
export function StockPage({ symbol }: { symbol: string }) {
  const market = useMarket();
  const { feed, names, defaults, watchlist, addToWatchlist, removeFromWatchlist, setFocus, onCandle, onSnapshot, source } = market;
  const chart = useRef<PriceChartHandle>(null);
  const ticketRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>("about");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const known = defaults.universe.some((u) => u.code === symbol);
  const isIndex = /\bindex\b/i.test(names[symbol] ?? ""); // indexes can be charted but not traded
  const company = useCompany(known ? symbol : null, feed.sessionDay);

  // Stream this stock while its page is open, and keep the chart fed.
  useEffect(() => {
    setFocus(symbol);
    return () => setFocus(null);
  }, [symbol, setFocus]);

  useEffect(() => {
    chart.current?.reset(feed.candlesFor(symbol));
    const offCandle = onCandle((s, candle) => {
      if (s === symbol) chart.current?.append([candle]);
    });
    const offSnapshot = onSnapshot(() => chart.current?.reset(feed.candlesFor(symbol)));
    return () => {
      offCandle();
      offSnapshot();
    };
    // candlesFor reads a ref, so it needn't be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, onCandle, onSnapshot]);

  useEffect(() => {
    setTab("about");
    setSide("buy");
  }, [symbol]);

  if (!known) {
    return (
      <div className="panel empty-page">
        <h1>{symbol}</h1>
        <p className="muted">That isn't an ASX code ASX-sim knows. Try the search bar at the top.</p>
      </div>
    );
  }

  const quote = feed.quotes[symbol];
  const bars = feed.candlesFor(symbol);
  const shown = priceOf(quote, bars);
  const phase = feed.status?.phase ?? "closed";
  const halted = (feed.status?.halted ?? []).includes(symbol);
  const watching = watchlist.includes(symbol);
  const data = company.data;
  const r = data ? ratios(data.fundamentals, shown.price) : null;
  const week = data?.price;
  const range52 = rangePosition(shown.price, week?.week52_low ?? null, week?.week52_high ?? null);
  const closedQuiet = feed.status?.source === "live" && phase !== "open" && feed.status.seconds_since_tick == null;
  const position = feed.account?.positions.find((p) => p.symbol === symbol);
  const openOrders = (feed.account?.orders ?? []).filter((o) => o.symbol === symbol && ["pending", "queued", "working"].includes(o.status));
  const trades = (feed.account?.trades ?? []).filter((t) => t.symbol === symbol);

  function openTicket(next: "buy" | "sell") {
    setSide(next);
    ticketRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const stats: { label: string; value: string; tip?: string }[] = [
    { label: "Open", value: quote?.open != null ? formatPrice(quote.open) : "—", tip: "The first price of today's session, set by the opening auction." },
    { label: "High", value: quote?.day_high != null ? formatPrice(quote.day_high) : "—" },
    { label: "Low", value: quote?.day_low != null ? formatPrice(quote.day_low) : "—" },
    { label: "Prev close", value: quote?.previous_close != null ? formatPrice(quote.previous_close) : "—", tip: "Yesterday's closing price. Today's change is measured from it." },
    { label: "Volume", value: compactNumber(quote?.day_volume ?? (bars.length ? bars.reduce((sum, b) => sum + b.volume, 0) : null)), tip: "Shares traded today so far." },
    { label: "Avg volume", value: compactNumber(week?.average_volume_30d), tip: "Average shares traded per day over the last 30 trading days. Today's volume well above this means unusual interest." },
  ];
  if (!isIndex) {
    stats.push(
      { label: "Market cap", value: r?.marketCap != null ? `$${compact(r.marketCap)}` : "—", tip: "What the whole company is worth at this share price: price × shares on issue." },
      { label: "P/E", value: r?.pe != null ? `${r.pe.toFixed(1)}×` : "—", tip: "Price ÷ earnings per share. Roughly how many years of current profit you pay for. Blank if the company made a loss." },
      { label: "Div yield", value: r?.dividendYieldPct != null ? `${r.dividendYieldPct.toFixed(2)}%` : "—", tip: "Dividends paid over the last year ÷ price, before franking credits." },
    );
  }

  return (
    <div className="stock-page">
      <header className="stock-head">
        <div className="stock-title">
          <a className="back-link" href="#/watchlist">
            <Icon name="back" size={16} /> Watchlist
          </a>
          <div className="title-row">
            <h1>{symbol}</h1>
            <button
              className={`icon-button star ${watching ? "on" : ""}`}
              onClick={() => (watching ? removeFromWatchlist(symbol) : addToWatchlist(symbol))}
              title={watching ? "Remove from watchlist" : "Add to watchlist"}
              aria-pressed={watching}
            >
              <Icon name="star" size={20} filled={watching} />
            </button>
            {halted && (
              <span className="halt-badge" title="No trades for 15+ minutes while the market is open, so this looks like a trading halt. Inferred: Yahoo doesn't publish halts.">
                Halted
              </span>
            )}
          </div>
          <p className="muted">
            {names[symbol]}
            {data?.sector && ` · ${data.sector}`}
            {data?.industry && ` · ${data.industry}`}
          </p>
        </div>
        <div className="stock-quote">
          <span className="big-price">
            <Price value={shown.price} />
          </span>
          <Change change={shown.change} percent={shown.pct} price={shown.price} />
          <span className="muted small-text">{quote ? `Today, since ${quote.change_basis}` : "Today"}</span>
        </div>
        {!isIndex && (
          <div className="stock-actions">
            <button className="buy-button" onClick={() => openTicket("buy")}>
              Buy
            </button>
            <button className="sell-button" onClick={() => openTicket("sell")} disabled={!position}>
              Sell
            </button>
          </div>
        )}
      </header>

      <section className="trend-strip panel" aria-label="Trends">
        <div className="trend">
          <Label tip="Change since yesterday's close.">Today</Label>
          <span className={`trend-value ${tone(shown.pct)}`}>{pct(shown.pct)}</span>
        </div>
        {(week?.returns ?? []).map((t) => (
          <div className="trend" key={t.label}>
            <Label>{t.label}</Label>
            <span className={`trend-value ${tone(t.pct)}`}>{pct(t.pct, true, 1)}</span>
          </div>
        ))}
        {week?.week52_low != null && week.week52_high != null && (
          <div className="trend range52">
            <Label tip="The lowest and highest prices of the past year, and where today's price sits between them.">52-week range</Label>
            <div className="range-cell wide">
              <span>{formatPrice(week.week52_low)}</span>
              <div className="range-track">{range52 != null && <i style={{ left: `${range52}%` }} />}</div>
              <span>{formatPrice(week.week52_high)}</span>
            </div>
          </div>
        )}
        {!week && !company.error && <span className="muted small-text">Loading trends…</span>}
      </section>

      <section className="key-stats" aria-label="Key statistics">
        {stats.map((s) => (
          <div className="key-stat" key={s.label}>
            <Label tip={s.tip}>{s.label}</Label>
            <strong>{s.value}</strong>
          </div>
        ))}
      </section>

      <div className="stock-grid-main">
        <section className="panel chart-panel">
          {closedQuiet && (
            <p className="chart-notice">
              The ASX is closed. Live trading runs from about 10:20am to 4:30pm Sydney time (with the delay).
              {feed.sessionDay && ` Showing ${formatDay(feed.sessionDay)}.`}
            </p>
          )}
          <PriceChart ref={chart} symbol={symbol} sessionDay={feed.sessionDay} />
        </section>

        {!isIndex && (
          <aside className="stock-side" ref={ticketRef}>
            <div className="panel ticket-panel">
              <OrderTicket
                key={`${symbol}-${side}`}
                symbol={symbol}
                name={names[symbol] ?? ""}
                quote={quote}
                lastPrice={shown.price}
                account={feed.account}
                phase={phase}
                halted={halted}
                journalOptions={defaults.journal}
                onSubmit={market.placeOrder}
                initialSide={side}
                compact
              />
            </div>
            {position && (
              <div className="panel position-mini">
                <h3 className="panel-title">Your position</h3>
                <dl className="mini-stats">
                  <div>
                    <dt>Shares</dt>
                    <dd>{position.quantity.toLocaleString("en-AU")}</dd>
                  </div>
                  <div>
                    <dt>Avg cost</dt>
                    <dd>${position.average_price}</dd>
                  </div>
                  <div>
                    <dt>Unrealised</dt>
                    <dd className={tone(position.unrealised)}>{money(position.unrealised, true)}</dd>
                  </div>
                </dl>
              </div>
            )}
          </aside>
        )}
      </div>

      <section className="panel stock-details">
        <div className="page-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "about"} className={tab === "about" ? "active" : ""} onClick={() => setTab("about")}>
            About &amp; fundamentals
          </button>
          {!isIndex && (
            <button role="tab" aria-selected={tab === "position"} className={tab === "position" ? "active" : ""} onClick={() => setTab("position")}>
              Your activity{trades.length + openOrders.length > 0 ? ` (${trades.length + openOrders.length})` : ""}
            </button>
          )}
        </div>
        {tab === "about" && (
          <CompanyPanel symbol={symbol} sessionDay={feed.sessionDay} price={shown.price} demo={source.kind === "demo"} company={company} showPrice={false} />
        )}
        {tab === "position" && (
          <div className="activity-tab">
            <h3 className="panel-title">Open orders</h3>
            {openOrders.length === 0 ? (
              <p className="muted small-text">No open orders for {symbol}.</p>
            ) : (
              <table className="data-table compact">
                <tbody>
                  {openOrders.map((o) => (
                    <tr key={o.id}>
                      <td className={o.side === "buy" ? "up" : "down"}>{o.side.toUpperCase()}</td>
                      <td>
                        {o.quantity.toLocaleString("en-AU")} × {o.display_type.replace("_", " ")}
                        {o.limit_price && ` $${o.limit_price}`}
                        {o.trigger_price && ` (trigger $${o.trigger_price})`}
                      </td>
                      <td className="muted">{STATUS_LABEL[o.status] ?? o.status}</td>
                      <td className="row-actions">
                        <button className="small-button" onClick={() => void market.cancelOrder(o.id)}>
                          Cancel
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h3 className="panel-title">Your trades in {symbol}</h3>
            {trades.length === 0 ? (
              <p className="muted small-text">You haven't traded {symbol} yet.</p>
            ) : (
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th className="num">Shares</th>
                    <th className="num">Entry</th>
                    <th className="num">Exit</th>
                    <th className="num">Net P&amp;L</th>
                    <th className="num">R</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id}>
                      <td>{t.status === "open" ? "Open" : "Closed"}</td>
                      <td className="num">{t.entry_quantity.toLocaleString("en-AU")}</td>
                      <td className="num">${t.average_entry}</td>
                      <td className="num">{t.average_exit ? `$${t.average_exit}` : "—"}</td>
                      <td className={`num ${tone(t.status === "open" ? t.unrealised : t.net_pnl)}`}>
                        {money(t.status === "open" ? t.unrealised : t.net_pnl, true)}
                      </td>
                      <td className="num">{t.r_multiple == null ? "—" : `${t.r_multiple.toFixed(2)}R`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted tiny">Review these trades in Portfolio → Journal.</p>
          </div>
        )}
      </section>
    </div>
  );
}
