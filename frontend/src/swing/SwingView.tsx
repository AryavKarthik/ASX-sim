import { type FormEvent, useEffect, useMemo, useState } from "react";

import { formatPrice } from "../format";
import { EquityChart } from "../live/EquityChart";
import { DailyChart, type FillMarker } from "./DailyChart";
import { type SavedSession, type SwingOptions, type SwingOrder, type SwingState, swingApi } from "./types";

const dollars = (text: string | number, signed = false) => {
  const n = Number(text);
  const body = Math.abs(n).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
  return n < 0 ? `−${body}` : signed ? `+${body}` : body;
};
const signedPct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
const tone = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");

const SWING_LABELS = {
  account: "Your account",
  benchmark: "Buy and hold: all your cash in the stock on day 1",
  benchmarkTitle: "Buy & hold",
};

/** Practise swing trading: step through months of daily bars without seeing what's next. */
export function SwingView() {
  const [state, setState] = useState<SwingState | null>(null);
  return state ? <Session initial={state} onExit={() => setState(null)} /> : <Setup onStart={setState} />;
}

function Setup({ onStart }: { onStart: (s: SwingState) => void }) {
  const [options, setOptions] = useState<SwingOptions | null>(null);
  const [saved, setSaved] = useState<SavedSession[]>([]);
  const [symbol, setSymbol] = useState("");
  const [days, setDays] = useState(126);
  const [start, setStart] = useState("");
  const [cash, setCash] = useState("50000");
  const [blind, setBlind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    swingApi.options().then(setOptions).catch((e: Error) => setError(e.message));
    swingApi.saved().then(setSaved).catch(() => setSaved([]));
  }, []);

  async function run(action: () => Promise<SwingState>) {
    setBusy(true);
    setError(null);
    try {
      onStart(await action());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const code = blind ? null : symbol.trim().toUpperCase() || null;
    void run(() => swingApi.create({ symbol: code, start: blind ? null : start || null, days, cash, blind }));
  }

  return (
    <div className="swing-setup">
      <form className="setup card" onSubmit={submit}>
        <h1>Swing practice</h1>
        <p className="muted">
          Trade a stock over months or years of real daily prices, one trading day at a time. You only ever see up to
          "today's" close; your orders fill on the following days.
        </p>
        <label className="check">
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
          <span>
            <strong>Blind practice</strong>: a mystery stock from a random date, with the name and dates hidden until
            the end. The fairest test, because you can't lean on what you remember.
          </span>
        </label>
        {!blind && (
          <>
            <label>
              Stock
              <input
                list="swing-stocks"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="ASX code, e.g. BHP (leave empty for a surprise)"
              />
              <datalist id="swing-stocks">
                {options?.stocks.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </datalist>
            </label>
            <label>
              Start date
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              <span className="muted tiny">Leave empty for a random date.</span>
            </label>
          </>
        )}
        <label>
          How long
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {(options?.periods ?? [{ label: "6 months", days: 126 }]).map((p) => (
              <option key={p.days} value={p.days}>
                {p.label} ({p.days} trading days)
              </option>
            ))}
          </select>
        </label>
        <label>
          Starting cash ($)
          <input inputMode="numeric" value={cash} onChange={(e) => setCash(e.target.value.replace(/[^0-9]/g, ""))} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Loading price history…" : "Start practising"}
        </button>
      </form>

      {saved.length > 0 && (
        <section className="card saved">
          <h4>Pick up where you left off</h4>
          <ul>
            {saved.map((s) => (
              <li key={s.id}>
                <button disabled={busy} onClick={() => void run(() => swingApi.read(s.id))}>
                  <strong>{s.name}</strong>
                  <span className="muted">
                    {s.start_date ? `from ${s.start_date} · ` : ""}
                    {s.finished ? "finished" : `day ${s.day} of ${s.total_days}`}
                  </span>
                  <span className={tone(s.return_pct)}>{signedPct(s.return_pct)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function orderText(o: SwingOrder): string {
  const what = `${o.side === "buy" ? "Buy" : "Sell"} ${o.quantity}`;
  if (o.type === "market") return `${what} at market`;
  return `${what} ${o.type} $${o.price}`;
}

function Session({ initial, onExit }: { initial: SwingState; onExit: () => void }) {
  const [s, setS] = useState(initial);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<"market" | "limit" | "stop">("market");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(action: () => Promise<SwingState>, done?: (next: SwingState) => string | null) {
    if (busy) return;
    setBusy(true);
    try {
      const next = await action();
      setS(next);
      const text = done?.(next) ?? null;
      setMessage(text ? { ok: true, text } : null);
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
    setBusy(false);
  }

  const step = (days: number) =>
    run(
      () => swingApi.advance(s.id, days),
      (next) => {
        const fills = next.filled ?? [];
        if (fills.length === 0) return null;
        return fills
          .map((f) => `${f.side === "buy" ? "Bought" : "Sold"} ${f.quantity} at $${f.fill_price}${f.pnl ? ` (${dollars(f.pnl, true)})` : ""}`)
          .join(" · ");
      },
    );

  function place(event: FormEvent) {
    event.preventDefault();
    const qty = Number(quantity);
    void run(
      () => swingApi.order(s.id, { side, type: kind, quantity: qty, price: kind === "market" ? null : price }),
      () => {
        setQuantity("");
        setPrice("");
        return kind === "market"
          ? "Order placed: it fills at the next day's open."
          : `Order placed: it waits until the price reaches $${price}.`;
      },
    );
  }

  const close = Number(s.close);
  const fills: FillMarker[] = useMemo(
    () =>
      s.orders
        .filter((o) => o.status === "filled" && o.time != null)
        .map((o) => ({ time: o.time as number, side: o.side, text: `${o.side === "buy" ? "B" : "S"} ${o.quantity}` })),
    [s.orders],
  );
  const curve = useMemo(() => s.curve.map((p) => ({ time: p.time, equity: p.equity })), [s.curve]);
  const hold = useMemo(() => s.curve.map((p) => ({ time: p.time, equity: p.buy_hold })), [s.curve]);
  const working = s.orders.filter((o) => o.status === "working");
  const history = s.orders.filter((o) => o.status !== "working");
  const sum = s.summary;
  const edge = sum.return_pct - sum.buy_hold_pct;
  const fee = Number(s.brokerage.flat);
  const maxBuy = Math.max(0, Math.floor((Number(s.free_cash) - fee) / (kind === "market" ? close : Number(price) || close)));
  const max = side === "buy" ? maxBuy : s.position.free_quantity;

  return (
    <div className="swing">
      <section className="swing-main">
        <header className="card swing-head">
          <div>
            <h2>
              {s.symbol ?? "???"} <span className="muted">{s.name}</span>
            </h2>
            <span className="muted small-text">
              Day {s.day} of {s.total_days}
              {s.date ? ` · ${s.date}` : " · dates hidden"} · last close <strong>{formatPrice(close)}</strong>
            </span>
          </div>
          <div className="swing-steps">
            {!s.finished && (
              <>
                <button className="primary" disabled={busy} onClick={() => void step(1)} title="Move to the next trading day">
                  Next day ▸
                </button>
                <button disabled={busy} onClick={() => void step(5)} title="Move forward one trading week">
                  +1 week
                </button>
                <button disabled={busy} onClick={() => void step(21)} title="Move forward about one month">
                  +1 month
                </button>
              </>
            )}
            <button onClick={onExit}>{s.finished ? "New session" : "Exit"}</button>
          </div>
        </header>

        {s.finished && (
          <div className={`card swing-result ${edge >= 0 ? "good" : "bad"}`}>
            <strong>
              Finished: you made {signedPct(sum.return_pct)}; buying and holding made {signedPct(sum.buy_hold_pct)}.
            </strong>
            <span>
              {edge >= 0
                ? `You beat buy and hold by ${edge.toFixed(2)} percentage points.`
                : `Buy and hold beat you by ${Math.abs(edge).toFixed(2)} percentage points. That's common: most active trading loses to simply holding.`}
              {s.blind && s.symbol ? ` The stock was ${s.symbol} (${s.name}), starting ${s.start_date}.` : ""}
            </span>
          </div>
        )}

        <section className="card swing-chart">
          <DailyChart bars={s.bars} fills={fills} resetKey={`${s.id}-${s.hidden}`} />
        </section>

        <section className="card performance-card">
          <div className="tiles">
            <div className="tile" title="Your account now compared with your starting cash, after brokerage">
              <span className="tile-label">Your return</span>
              <span className={`tile-value ${tone(sum.return_pct)}`}>{signedPct(sum.return_pct)}</span>
              <span className="tile-sub">equity {dollars(s.equity)}</span>
            </div>
            <div className="tile" title="What you'd have made putting all your cash in the stock on day 1 and doing nothing. Dividends are ignored for both.">
              <span className="tile-label">Buy and hold</span>
              <span className={`tile-value ${tone(sum.buy_hold_pct)}`}>{signedPct(sum.buy_hold_pct)}</span>
              <span className="tile-sub">{edge >= 0 ? "you're ahead by" : "you're behind by"} {Math.abs(edge).toFixed(2)} pts</span>
            </div>
            <div className="tile" title="The biggest fall in your equity from an earlier high">
              <span className="tile-label">Max drawdown</span>
              <span className={`tile-value ${sum.max_drawdown_pct > 0 ? "down" : ""}`}>−{sum.max_drawdown_pct.toFixed(2)}%</span>
            </div>
            <div className="tile" title="Completed sells that made money after brokerage on both sides">
              <span className="tile-label">Win rate</span>
              <span className="tile-value">{sum.win_rate == null ? "—" : `${sum.win_rate}%`}</span>
              <span className="tile-sub">
                {sum.wins} of {sum.closed_trades} sells
              </span>
            </div>
            <div className="tile" title="Share of days you held shares. Time out of the market is a decision too.">
              <span className="tile-label">Time invested</span>
              <span className="tile-value">{sum.days_invested_pct == null ? "—" : `${sum.days_invested_pct}%`}</span>
              <span className="tile-sub">brokerage {dollars(sum.fees)}</span>
            </div>
          </div>
          {s.curve.length > 1 && <EquityChart curve={curve} benchmark={hold} labels={SWING_LABELS} smooth />}
        </section>
      </section>

      <aside className="trade-column">
        {!s.finished && (
          <form className="card ticket" onSubmit={place}>
            <strong>Place an order</strong>
            <div className="segmented" role="group" aria-label="Buy or sell">
              <button type="button" className={side === "buy" ? "active buy" : ""} onClick={() => setSide("buy")}>
                Buy
              </button>
              <button type="button" className={side === "sell" ? "active sell" : ""} onClick={() => setSide("sell")}>
                Sell
              </button>
            </div>
            <label>
              Order type
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="market">Market: at the next open</option>
                <option value="limit">Limit: at my price or better</option>
                <option value="stop">Stop: if the price {side === "sell" ? "falls" : "rises"} to my level</option>
              </select>
            </label>
            {kind !== "market" && (
              <label>
                {kind === "limit" ? "Limit" : "Stop"} price ($)
                <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={close.toFixed(2)} />
              </label>
            )}
            <label>
              Quantity (shares)
              <span className="with-button">
                <input inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 100" />
                <button type="button" onClick={() => setQuantity(String(max))} disabled={max <= 0}>
                  Max
                </button>
              </span>
            </label>
            <button className="primary" type="submit" disabled={busy || !Number(quantity) || (kind !== "market" && !Number(price))}>
              {side === "buy" ? "Buy" : "Sell"}
            </button>
            <p className="muted tiny">
              You decide after the close. Orders fill on later days and stay open until they fill or you cancel them. If
              the price gaps past a stop, it fills at the open: worse than your stop, as in real life. Brokerage{" "}
              {dollars(fee)} an order.
            </p>
          </form>
        )}
        {message && <p className={`card swing-message ${message.ok ? "ok" : "error"}`}>{message.text}</p>}

        <section className="card account">
          <strong>Account</strong>
          <dl>
            <dt>Equity</dt>
            <dd>{dollars(s.equity)}</dd>
            <dt>Cash</dt>
            <dd>{dollars(s.cash)}</dd>
            <dt>Shares held</dt>
            <dd>{s.position.quantity.toLocaleString()}</dd>
            {s.position.average_price && (
              <>
                <dt>Average cost</dt>
                <dd>${Number(s.position.average_price).toFixed(3)}</dd>
                <dt>Unrealised</dt>
                <dd className={tone(Number(s.position.unrealised))}>{dollars(s.position.unrealised, true)}</dd>
              </>
            )}
          </dl>
        </section>

        <section className="card account">
          <strong>Open orders ({working.length})</strong>
          {working.length === 0 ? (
            <p className="muted small-text">None.</p>
          ) : (
            <ul className="swing-orders">
              {working.map((o) => (
                <li key={o.id}>
                  <span>{orderText(o)}</span>
                  <button disabled={busy} onClick={() => void run(() => swingApi.cancel(s.id, o.id))}>
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          )}
          {history.length > 0 && (
            <>
              <strong>History</strong>
              <ul className="swing-orders">
                {history.slice(0, 12).map((o) => (
                  <li key={o.id} title={o.note ?? undefined}>
                    <span>
                      {o.status === "filled"
                        ? `${o.side === "buy" ? "Bought" : "Sold"} ${o.quantity} @ $${o.fill_price}`
                        : `${orderText(o)} · ${o.status}`}
                    </span>
                    {o.pnl && <span className={tone(Number(o.pnl))}>{dollars(o.pnl, true)}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </aside>
    </div>
  );
}
