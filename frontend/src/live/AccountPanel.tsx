import { useState } from "react";

import type { AccountView, CommandResult } from "./types";

function money(value: string | number | null | undefined, signed = false): string {
  if (value == null) return "—";
  const n = Number(value);
  const text = Math.abs(n).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
  if (!signed) return n < 0 ? `−${text}` : text;
  return `${n >= 0 ? "+" : "−"}${text}`;
}

function tone(value: string | number): string {
  const n = Number(value);
  return n > 0 ? "up" : n < 0 ? "down" : "";
}

type Props = {
  account: AccountView | null;
  source: "live" | "demo";
  onReset: (startingCash: string) => Promise<CommandResult>;
};

/** Account summary: what you're worth, what you can spend, and how today is going. */
export function AccountPanel({ account, source, onReset }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [cash, setCash] = useState("50000");
  const [error, setError] = useState<string | null>(null);

  if (!account) return <section className="account card muted">Loading account…</section>;

  async function reset() {
    const reply = await onReset(cash);
    if (reply.ok) {
      setConfirming(false);
      setError(null);
    } else {
      setError(reply.error);
    }
  }

  return (
    <section className="account card">
      <div className="ticket-head">
        <strong>{source === "demo" ? "Demo account" : "Your account"}</strong>
        <span className="muted small-inline">started with {money(account.starting_cash)}</span>
      </div>
      <dl className="estimate">
        <dt>Equity</dt>
        <dd>
          <strong>{money(account.equity)}</strong>
        </dd>
        <dt>Net P&amp;L</dt>
        <dd className={tone(account.net_pnl)}>{money(account.net_pnl, true)}</dd>
        <dt>Cash</dt>
        <dd>{money(account.cash)}</dd>
        <dt>Buying power</dt>
        <dd>{money(account.buying_power)}</dd>
        <dt>Holdings value</dt>
        <dd>{money(account.market_value)}</dd>
        <dt>Unrealised</dt>
        <dd className={tone(account.unrealised)}>{money(account.unrealised, true)}</dd>
        <dt>Realised</dt>
        <dd className={tone(account.realised)}>{money(account.realised, true)}</dd>
        <dt>Fees paid</dt>
        <dd>{money(account.fees)}</dd>
      </dl>

      {source === "demo" && <p className="muted tiny">Demo trades use a separate account that resets each demo.</p>}

      {!confirming ? (
        <button className="ghost small-button" onClick={() => setConfirming(true)}>
          Reset account…
        </button>
      ) : (
        <div className="reset-box">
          <p className="small-text">
            This clears all holdings, orders and history. Start again with:
          </p>
          <div className="input-row">
            <input inputMode="numeric" value={cash} onChange={(e) => setCash(e.target.value.replace(/[^\d]/g, ""))} />
            <button className="danger" onClick={reset}>
              Reset
            </button>
            <button className="ghost" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </div>
          {error && <p className="error small-text">{error}</p>}
        </div>
      )}
    </section>
  );
}
