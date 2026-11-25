import { useEffect, useRef, useState } from "react";

import { INDEX, priceOf, useMarket } from "../app/market";
import { plannerPath } from "../app/router";
import { Change, FlashPrice, Icon, Label, Skeleton, compactNumber, money, pct, tone } from "../app/ui";
import { PriceChart, type PriceChartHandle } from "../components/PriceChart";
import { formatDay, formatPrice } from "../format";
import { compact, rangePosition, ratios } from "../live/company";
import { OrderTicket } from "../live/OrderTicket";
import { MarketData, sessionFigures, touchFor } from "../stock/MarketData";
import { StockDetails } from "../stock/StockDetails";
import { useCompany } from "../stock/useCompany";

/** One stock: price and trends, the chart, the order ticket, market data, and the company. */
export function StockPage({ symbol }: { symbol: string }) {
  const market = useMarket();
  const { feed, names, defaults, watchlist, addToWatchlist, removeFromWatchlist, setFocus, onCandle, onSnapshot, source } = market;
  const chart = useRef<PriceChartHandle>(null);
  const ticketRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const known = defaults.universe.some((u) => u.code === symbol);
  const isIndex = /\bindex\b/i.test(names[symbol] ?? ""); // indexes can be charted but not traded
  const company = useCompany(known ? symbol : null, feed.sessionDay);
  const index = useCompany(known && symbol !== INDEX ? INDEX : null, feed.sessionDay);

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

  useEffect(() => setSide("buy"), [symbol]);

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
  const session = sessionFigures(bars);
  const touch = touchFor(quote, shown.price);

  function openTicket(next: "buy" | "sell") {
    setSide(next);
    ticketRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const stats: { label: string; value: string; tip?: string; className?: string }[] = [
    ...(isIndex
      ? []
      : [
          { label: touch.estimated ? "Bid (est.)" : "Bid", value: touch.bid != null ? formatPrice(touch.bid) : "—", tip: touch.estimated ? "Estimated: one price step below the last trade (Yahoo only sends bids occasionally). What a market sell fills at in the simulator." : "Best price a buyer is offering right now.", className: "bid-text" },
          { label: touch.estimated ? "Ask (est.)" : "Ask", value: touch.ask != null ? formatPrice(touch.ask) : "—", tip: touch.estimated ? "Estimated: one price step above the bid (Yahoo only sends asks occasionally). What a market buy fills at in the simulator." : "Best price a seller is asking right now.", className: "ask-text" },
        ]),
    { label: "Open", value: quote?.open != null ? formatPrice(quote.open) : "—", tip: "The first price of today's session, set by the opening auction." },
    { label: "High", value: quote?.day_high != null ? formatPrice(quote.day_high) : "—" },
    { label: "Low", value: quote?.day_low != null ? formatPrice(quote.day_low) : "—" },
    { label: "Prev close", value: quote?.previous_close != null ? formatPrice(quote.previous_close) : "—", tip: "Yesterday's closing price. Today's change is measured from it." },
    { label: "Volume", value: compactNumber(quote?.day_volume ?? session.volume), tip: "Shares traded today so far." },
  ];
  if (!isIndex) {
    stats.push(
      { label: "Market cap", value: r?.marketCap != null ? `$${compact(r.marketCap)}` : "—", tip: "Price × shares on issue." },
      { label: "P/E", value: r?.pe != null ? `${r.pe.toFixed(1)}×` : "—", tip: "Price ÷ earnings per share. Blank if the company made a loss." },
      { label: "Div yield", value: r?.dividendYieldPct != null ? `${r.dividendYieldPct.toFixed(2)}%` : "—", tip: "Dividends over the last year ÷ price, before franking." },
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
            <span className="exchange-tag">ASX</span>
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
            {data?.name ?? names[symbol]}
            {data?.sector && ` · ${data.sector}`}
            {data?.industry && ` · ${data.industry}`}
          </p>
        </div>
        <div className="stock-quote">
          <FlashPrice value={shown.price} className="big-price" />
          <Change change={shown.change} percent={shown.pct} price={shown.price} />
          <span className="muted small-text">
            {source.kind === "demo" ? "Demo replay" : "Delayed ~20 min"} · {quote ? `since ${quote.change_basis}` : "today"}
          </span>
        </div>
        {!isIndex && (
          <div className="stock-actions">
            <button className="buy-button" onClick={() => openTicket("buy")}>
              Buy
            </button>
            <button className="sell-button" onClick={() => openTicket("sell")} disabled={!position}>
              Sell
            </button>
            <a className="plan-button" href={`#${plannerPath(symbol)}`} title="Work out the risk and reward of a trade in this stock before you place it">
              <Icon name="planner" size={16} /> Plan
            </a>
          </div>
        )}
      </header>

      <section className="key-stats" aria-label="Quote summary">
        {stats.map((s) => (
          <div className="key-stat" key={s.label}>
            <Label tip={s.tip}>{s.label}</Label>
            <strong className={s.className}>{s.value}</strong>
          </div>
        ))}
      </section>

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
        {!week &&
          !company.error &&
          [0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div className="trend" key={i}>
              <Skeleton width={48} height={10} />
              <Skeleton width={56} height={18} />
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

        <aside className="stock-side" ref={ticketRef}>
          {!isIndex && (
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
          )}
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
          <MarketData quote={quote} bars={bars} prints={feed.tradesFor(symbol)} price={shown.price} />
        </aside>
      </div>

      <StockDetails
        symbol={symbol}
        isIndex={isIndex}
        company={data}
        companyError={company.error}
        index={symbol === INDEX ? data : index.data}
        price={shown.price}
        todayPct={shown.pct}
        quote={quote}
        bars={bars}
        account={feed.account}
        demo={source.kind === "demo"}
        onCancel={market.cancelOrder}
      />
    </div>
  );
}
