import { priceOf, useMarket } from "../app/market";
import { stockPath } from "../app/router";
import { Change, Label, Price, Sparkline, money, pct, tone } from "../app/ui";
import { formatDay } from "../format";

/** The dashboard: the market today, your account, and your watchlist at a glance. */
export function HomePage() {
  const { feed, watchlist, names, source, trade } = useMarket();
  const rows = watchlist.map((symbol) => {
    const bars = feed.candlesFor(symbol);
    return { symbol, bars, ...priceOf(feed.quotes[symbol], bars) };
  });
  const index = rows.find((r) => r.symbol === "XJO");
  const stocks = rows.filter((r) => r.symbol !== "XJO");
  const moving = stocks.filter((r) => r.pct != null);
  const gainers = [...moving].sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0)).filter((r) => (r.pct ?? 0) > 0).slice(0, 4);
  const losers = [...moving].sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0)).filter((r) => (r.pct ?? 0) < 0).slice(0, 4);
  const up = moving.filter((r) => (r.pct ?? 0) > 0).length;
  const down = moving.filter((r) => (r.pct ?? 0) < 0).length;
  const account = feed.account;
  const startPct = account ? (100 * Number(account.net_pnl)) / Number(account.starting_cash) : null;
  const session = feed.sessionDay ? formatDay(feed.sessionDay) : "";

  return (
    <div className="home">
      <header className="page-head">
        <div>
          <h1>Markets</h1>
          <p className="muted">
            {source.kind === "demo" ? "Demo replay" : "ASX, about 20 minutes delayed"}
            {session && ` · ${session}`}
          </p>
        </div>
      </header>

      <section className="hero-grid">
        <a className="panel hero-card" href={`#${stockPath("XJO")}`}>
          <Label tip="The S&P/ASX 200: the 200 largest companies on the ASX. It's the usual measure of how the Australian market is doing.">
            S&amp;P/ASX 200
          </Label>
          <div className="hero-value">
            <span className="big-price">{index?.price != null ? index.price.toLocaleString("en-AU", { maximumFractionDigits: 1 }) : "—"}</span>
            <Change change={index?.change ?? null} percent={index?.pct ?? null} />
          </div>
          <Sparkline bars={index?.bars ?? []} height={64} className="hero-spark" />
        </a>

        <a className="panel hero-card" href="#/portfolio">
          <Label tip="Equity is everything your account is worth right now: cash plus the current value of your shares.">Your account</Label>
          <div className="hero-value">
            <span className="big-price">{money(account?.equity)}</span>
            <span className={`change ${tone(account?.net_pnl)}`}>
              {money(account?.net_pnl, true)} ({pct(startPct)})
            </span>
          </div>
          <dl className="mini-stats">
            <div>
              <dt>Buying power</dt>
              <dd>{money(account?.buying_power)}</dd>
            </div>
            <div>
              <dt>Holdings</dt>
              <dd>{account?.positions.length ?? 0}</dd>
            </div>
            <div>
              <dt>Unrealised</dt>
              <dd className={tone(account?.unrealised)}>{money(account?.unrealised, true)}</dd>
            </div>
          </dl>
        </a>

        <div className="panel hero-card">
          <Label tip="How many stocks on your watchlist are up or down today.">Your watchlist today</Label>
          <div className="hero-value">
            <span className="big-price">
              <span className="up">{up}</span> <span className="muted thin">up</span> · <span className="down">{down}</span>{" "}
              <span className="muted thin">down</span>
            </span>
          </div>
          <div className="breadth" aria-hidden>
            <i className="up-bar" style={{ flex: up || 0.0001 }} />
            <i className="down-bar" style={{ flex: down || 0.0001 }} />
          </div>
          <a className="text-link" href="#/watchlist">
            Open watchlist →
          </a>
        </div>
      </section>

      <section className="movers-grid">
        <MoverList title="Top gainers" rows={gainers} names={names} empty="Nothing on your watchlist is up yet." />
        <MoverList title="Top losers" rows={losers} names={names} empty="Nothing on your watchlist is down yet." />
      </section>

      <section>
        <div className="section-head">
          <h2>Watchlist</h2>
          <a className="text-link" href="#/watchlist">
            Manage →
          </a>
        </div>
        <div className="stock-grid">
          {stocks.map((r) => (
            <div key={r.symbol} className="panel stock-card">
              <a className="stock-card-link" href={`#${stockPath(r.symbol)}`}>
                <div className="stock-card-top">
                  <div>
                    <strong>{r.symbol}</strong>
                    <span className="muted ellipsis">{names[r.symbol]}</span>
                  </div>
                  <div className="right">
                    <strong>
                      <Price value={r.price} />
                    </strong>
                    <span className={`change ${tone(r.pct)}`}>{pct(r.pct)}</span>
                  </div>
                </div>
                <Sparkline bars={r.bars} height={44} />
              </a>
              <button className="small-button card-trade" onClick={() => trade(r.symbol)}>
                Trade
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function MoverList({
  title,
  rows,
  names,
  empty,
}: {
  title: string;
  rows: { symbol: string; price: number | null; change: number | null; pct: number | null }[];
  names: Record<string, string>;
  empty: string;
}) {
  return (
    <div className="panel">
      <h3 className="panel-title">{title}</h3>
      {rows.length === 0 ? (
        <p className="muted small-text">{empty}</p>
      ) : (
        <ul className="mover-list">
          {rows.map((r) => (
            <li key={r.symbol}>
              <a href={`#${stockPath(r.symbol)}`}>
                <span className="mover-name">
                  <strong>{r.symbol}</strong>
                  <span className="muted ellipsis">{names[r.symbol]}</span>
                </span>
                <span className="mover-price">
                  <Price value={r.price} />
                </span>
                <span className={`pill ${tone(r.pct)}`}>{pct(r.pct)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
