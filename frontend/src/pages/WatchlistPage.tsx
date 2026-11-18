import { type FormEvent, useState } from "react";

import { priceOf, useMarket } from "../app/market";
import { go, stockPath } from "../app/router";
import { Icon, Price, Sparkline, compactNumber, pct, tone } from "../app/ui";
import { touchFor } from "../stock/MarketData";

type SortKey = "symbol" | "price" | "pct" | "volume";

/** Every stock you're watching, in one clean table. Click a row to open the stock. */
export function WatchlistPage() {
  const { feed, watchlist, names, defaults, addToWatchlist, removeFromWatchlist, resetWatchlist, trade } = useMarket();
  const [draft, setDraft] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const code = draft.trim().toUpperCase();
  const canAdd = code in names && !watchlist.includes(code) && watchlist.length < defaults.max_symbols;
  const halted = feed.status?.halted ?? [];

  const rows = watchlist.map((symbol) => {
    const bars = feed.candlesFor(symbol);
    const quote = feed.quotes[symbol];
    return { symbol, bars, quote, ...priceOf(quote, bars) };
  });
  if (sort) {
    const value = (r: (typeof rows)[number]): number | string =>
      sort.key === "symbol" ? r.symbol : sort.key === "price" ? (r.price ?? -Infinity) : sort.key === "pct" ? (r.pct ?? -Infinity) : (r.quote?.day_volume ?? -1);
    rows.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const order = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -order : order;
    });
  }

  function add(event: FormEvent) {
    event.preventDefault();
    if (!canAdd) return;
    addToWatchlist(code);
    setDraft("");
  }

  function header(key: SortKey, label: string, className = "") {
    const active = sort?.key === key;
    return (
      <th className={`sortable ${className}`}>
        <button onClick={() => setSort(active ? (sort.desc ? null : { key, desc: true }) : { key, desc: key !== "symbol" })}>
          {label}
          {active && <span aria-hidden>{sort.desc ? " ↓" : " ↑"}</span>}
        </button>
      </th>
    );
  }

  return (
    <div className="watchlist-page">
      <header className="page-head">
        <div>
          <h1>Watchlist</h1>
          <p className="muted">
            {watchlist.length} of {defaults.max_symbols} stocks · click a stock to see its chart and trends
          </p>
        </div>
        <form className="add-symbol" onSubmit={add}>
          <input list="universe" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add an ASX code, e.g. CBA" aria-label="Add a stock" />
          <datalist id="universe">
            {defaults.universe
              .filter((u) => !watchlist.includes(u.code))
              .map((u) => (
                <option key={u.code} value={u.code}>
                  {u.name}
                </option>
              ))}
          </datalist>
          <button className="primary" type="submit" disabled={!canAdd}>
            <Icon name="plus" size={16} /> Add
          </button>
          <button type="button" className="ghost" onClick={resetWatchlist} title="Go back to the default list">
            Reset
          </button>
        </form>
      </header>

      <div className="panel table-panel">
        <table className="data-table">
          <thead>
            <tr>
              {header("symbol", "Stock")}
              {header("price", "Last", "num")}
              <th className="num">Bid</th>
              <th className="num">Ask</th>
              <th className="num">Change</th>
              {header("pct", "Change %", "num")}
              <th className="range-col">Day range</th>
              {header("volume", "Volume", "num")}
              <th className="spark-col">Today</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const low = r.quote?.day_low;
              const high = r.quote?.day_high;
              const position = low != null && high != null && high > low && r.price != null ? ((r.price - low) / (high - low)) * 100 : null;
              return (
                <tr key={r.symbol} className="clickable" onClick={() => go(stockPath(r.symbol))}>
                  <td>
                    <span className="cell-symbol">
                      {r.symbol}
                      {halted.includes(r.symbol) && <span className="halt-badge small">Halted</span>}
                    </span>
                    <span className="cell-name">{names[r.symbol]}</span>
                  </td>
                  <td className="num strong">
                    <Price value={r.price} />
                  </td>
                  <td className="num bid-text" title={touchFor(r.quote, r.price).estimated ? "Estimated from the last trade" : undefined}>
                    {r.symbol === "XJO" || touchFor(r.quote, r.price).bid == null ? "—" : touchFor(r.quote, r.price).bid?.toFixed((r.price ?? 0) < 2 ? 3 : 2)}
                  </td>
                  <td className="num ask-text" title={touchFor(r.quote, r.price).estimated ? "Estimated from the last trade" : undefined}>
                    {r.symbol === "XJO" || touchFor(r.quote, r.price).ask == null ? "—" : touchFor(r.quote, r.price).ask?.toFixed((r.price ?? 0) < 2 ? 3 : 2)}
                  </td>
                  <td className={`num ${tone(r.change)}`}>
                    {r.change == null ? "—" : `${r.change > 0 ? "+" : r.change < 0 ? "−" : ""}${Math.abs(r.change).toFixed(r.price != null && r.price < 2 ? 3 : 2)}`}
                  </td>
                  <td className="num">
                    <span className={`pill ${tone(r.pct)}`}>{pct(r.pct)}</span>
                  </td>
                  <td className="range-col">
                    {position == null ? (
                      <span className="muted">—</span>
                    ) : (
                      <div className="range-cell" title={`Low $${low} · High $${high}`}>
                        <span className="muted">{low?.toFixed(2)}</span>
                        <div className="range-track">
                          <i style={{ left: `${position}%` }} />
                        </div>
                        <span className="muted">{high?.toFixed(2)}</span>
                      </div>
                    )}
                  </td>
                  <td className="num muted">{compactNumber(r.quote?.day_volume)}</td>
                  <td className="spark-col">
                    <Sparkline bars={r.bars} height={30} />
                  </td>
                  <td className="row-actions">
                    {r.symbol !== "XJO" && (
                      <button
                        className="small-button trade-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          trade(r.symbol);
                        }}
                      >
                        Trade
                      </button>
                    )}
                    <button
                      className="icon-button"
                      title={`Remove ${r.symbol}`}
                      aria-label={`Remove ${r.symbol}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFromWatchlist(r.symbol);
                      }}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="muted empty">Your watchlist is empty. Add a stock above.</p>}
      </div>
    </div>
  );
}
