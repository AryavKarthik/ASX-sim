import { type FormEvent, useState } from "react";

import type { Bar } from "../api";
import { formatPrice } from "../format";
import type { Quote } from "./types";

type Props = {
  symbols: string[];
  names: Record<string, string>;
  quotes: Record<string, Quote>;
  ticks: Record<string, number>;
  halted: string[];
  candlesFor: (symbol: string) => Bar[];
  selected: string;
  maxSymbols: number;
  onSelect: (symbol: string) => void;
  onAdd: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onReset: () => void;
};

/** Price and change for a symbol: from its live quote, else from the session's candles. */
export function displayQuote(quote: Quote | undefined, candles: Bar[]) {
  if (quote) return { price: quote.price, pct: quote.change_pct };
  if (candles.length === 0) return { price: null, pct: null };
  const first = candles[0].open;
  const last = candles[candles.length - 1].close;
  return { price: last, pct: first ? ((last - first) / first) * 100 : null };
}

export function Watchlist(props: Props) {
  const { symbols, names, quotes, ticks, halted, candlesFor, selected, maxSymbols } = props;
  const [draft, setDraft] = useState("");
  const code = draft.trim().toUpperCase();
  const canAdd = code in names && !symbols.includes(code) && symbols.length < maxSymbols;

  function add(event: FormEvent) {
    event.preventDefault();
    if (!canAdd) return;
    props.onAdd(code);
    setDraft("");
  }

  return (
    <aside className="watchlist card">
      <div className="watchlist-head">
        <strong>Watchlist</strong>
        <span className="muted small-inline">
          {symbols.length}/{maxSymbols}
        </span>
      </div>

      <ul>
        {symbols.map((symbol) => {
          const { price, pct } = displayQuote(quotes[symbol], candlesFor(symbol));
          const up = (pct ?? 0) >= 0;
          return (
            <li
              key={`${symbol}-${ticks[symbol] ?? 0}`}
              className={`${symbol === selected ? "selected" : ""} ${ticks[symbol] ? (up ? "flash-up" : "flash-down") : ""}`}
              onClick={() => props.onSelect(symbol)}
            >
              <div className="wl-name">
                <span className="wl-code">
                  {symbol}
                  {halted.includes(symbol) && (
                    <span className="halt-badge small" title="No trades for 15+ minutes while the rest of the market is trading, so this looks like a trading halt (usually ahead of a company announcement). Yahoo doesn't publish halts, so this is inferred.">
                      Halted
                    </span>
                  )}
                </span>
                <span className="muted wl-full">{names[symbol] ?? ""}</span>
              </div>
              <div className="wl-quote">
                <span>{price != null ? formatPrice(price) : "—"}</span>
                <span className={pct == null ? "muted" : up ? "up" : "down"}>
                  {pct == null ? "" : `${up ? "+" : "−"}${Math.abs(pct).toFixed(2)}%`}
                </span>
              </div>
              <button
                className="wl-remove"
                title={`Remove ${symbol}`}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onRemove(symbol);
                }}
                disabled={symbols.length <= 1}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>

      <form className="wl-add" onSubmit={add}>
        <input
          list="asx-universe"
          placeholder={symbols.length >= maxSymbols ? "Watchlist full" : "Add ASX code"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={symbols.length >= maxSymbols}
          spellCheck={false}
          autoComplete="off"
        />
        <datalist id="asx-universe">
          {Object.entries(names).map(([c, n]) => (
            <option key={c} value={c}>
              {n}
            </option>
          ))}
        </datalist>
        <button type="submit" disabled={!canAdd}>
          Add
        </button>
      </form>
      <button className="ghost small-button" onClick={props.onReset}>
        Reset to default list
      </button>
    </aside>
  );
}
