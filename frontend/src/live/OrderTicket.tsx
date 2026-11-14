import { type FormEvent, useEffect, useState } from "react";

import type { Phase } from "../api";
import { formatPrice } from "../format";
import { estimatedTouch, isValidPrice, nearestValid, priceDecimals, tickSize } from "./ticks";
import type { AccountView, CommandResult, OrderCommand, Quote } from "./types";

const MIN_FIRST_PURCHASE = 500;
const ORDER_PHASES: Phase[] = ["pre_open", "open", "pre_cspa", "adjust_on"];

type Props = {
  symbol: string;
  name: string;
  quote: Quote | undefined;
  lastPrice: number | null;
  account: AccountView | null;
  phase: Phase;
  onSubmit: (order: OrderCommand) => Promise<CommandResult>;
};

function money(value: number): string {
  return value.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}

function brokerageFor(value: number, account: AccountView | null): number {
  if (!account || value <= 0) return 0;
  const { flat, percent, minimum } = account.brokerage;
  return Math.max(Number(flat) + value * Number(percent), Number(minimum));
}

function phaseNote(phase: Phase): string | null {
  switch (phase) {
    case "pre_open":
      return "Pre-open: your order waits for the opening auction and fills at the opening price.";
    case "pre_cspa":
      return "Pre-close: your order waits for the closing auction at about 4:10pm.";
    case "adjust_on":
      return "After the close: your order is for the next trading day's opening auction.";
    case "opening_auction":
    case "closing_auction":
      return "The auction is matching right now. Try again in a few seconds.";
    case "open":
      return null;
    default:
      return "The market is closed. Orders can be placed from 7:00am (delayed market time).";
  }
}

export function OrderTicket({ symbol, name, quote, lastPrice, account, phase, onSubmit }: Props) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit">("market");
  const [quantity, setQuantity] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // A new stock starts with a fresh ticket.
  useEffect(() => {
    setQuantity("");
    setLimit("");
    setResult(null);
  }, [symbol]);

  const touch = lastPrice != null ? estimatedTouch(lastPrice, quote?.bid ?? null, quote?.ask ?? null) : null;
  const marketPrice = touch ? (side === "buy" ? touch[1] : touch[0]) : null;
  const qty = Number(quantity);
  const qtyValid = Number.isInteger(qty) && qty > 0;
  const limitNum = Number(limit);
  const limitValid = type === "market" || (limit !== "" && isValidPrice(limitNum));
  const price = type === "limit" ? (limitValid ? limitNum : null) : marketPrice;
  const value = price != null && qtyValid ? price * qty : 0;
  const fee = brokerageFor(value, account);
  const held = account?.positions.find((p) => p.symbol === symbol)?.quantity ?? 0;
  const reservedSells = (account?.orders ?? [])
    .filter((o) => o.symbol === symbol && o.side === "sell" && (o.status === "working" || o.status === "queued"))
    .reduce((sum, o) => sum + o.quantity - o.filled, 0);
  const canSell = held - reservedSells;
  const buyingPower = Number(account?.buying_power ?? 0);
  const acceptsOrders = ORDER_PHASES.includes(phase);

  const problems: string[] = [];
  if (quantity !== "" && !qtyValid) problems.push("Quantity must be a whole number of shares.");
  if (type === "limit" && limit !== "" && !isValidPrice(limitNum)) {
    const [down, up] = nearestValid(limitNum);
    problems.push(`$${limit} isn't a valid ASX price step. Try ${formatPrice(down)} or ${formatPrice(up)}.`);
  }
  if (qtyValid && side === "buy" && value + fee > buyingPower) {
    problems.push(`Not enough buying power: needs ${money(value + fee)}, you have ${money(buyingPower)}.`);
  }
  if (qtyValid && side === "buy" && held === 0 && value > 0 && value < MIN_FIRST_PURCHASE) {
    problems.push(`A first purchase must be at least ${money(MIN_FIRST_PURCHASE)} (ASX minimum parcel).`);
  }
  if (qtyValid && side === "sell" && qty > canSell) {
    problems.push(
      canSell <= 0
        ? `You don't hold any ${symbol} to sell. Short selling isn't enabled.`
        : `You can sell at most ${canSell} ${symbol}.`,
    );
  }

  const ready = acceptsOrders && qtyValid && limitValid && problems.length === 0 && lastPrice != null && !busy;

  function setMax() {
    if (side === "sell") {
      setQuantity(String(Math.max(canSell, 0)));
    } else if (price) {
      const affordable = Math.floor((buyingPower - brokerageFor(buyingPower, account)) / price);
      setQuantity(String(Math.max(affordable, 0)));
    }
  }

  function switchType(next: "market" | "limit") {
    setType(next);
    if (next === "limit" && limit === "" && lastPrice != null) {
      setLimit(lastPrice.toFixed(priceDecimals(lastPrice)));
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setResult(null);
    const reply = await onSubmit({
      symbol,
      side,
      type,
      quantity: qty,
      ...(type === "limit" ? { limit_price: limit } : {}),
    });
    setBusy(false);
    if (!reply.ok) {
      setResult({ ok: false, text: reply.error });
      return;
    }
    const order = reply.order;
    if (order?.status === "filled") {
      const verb = order.side === "buy" ? "Bought" : "Sold";
      setResult({ ok: true, text: `${verb} ${order.filled} ${order.symbol} at $${order.average_price}` });
    } else if (order && order.filled > 0) {
      setResult({ ok: true, text: `Filled ${order.filled} of ${order.quantity} at $${order.average_price}. ${order.message ?? ""}` });
    } else if (order?.status === "queued") {
      setResult({ ok: true, text: `Order placed: waiting for the ${order.auction === "close" ? "closing" : "opening"} auction.` });
    } else {
      setResult({ ok: true, text: "Order placed: working in the market." });
    }
    setQuantity("");
  }

  const note = phaseNote(phase);
  const stepHint =
    lastPrice != null ? `Price step at this price: ${+(tickSize(lastPrice) * 100).toFixed(1)}c` : "";

  return (
    <form className="ticket card" onSubmit={submit}>
      <div className="ticket-head">
        <strong>Trade {symbol}</strong>
        <span className="muted small-inline">{name}</span>
      </div>

      <div className="segmented" role="group" aria-label="Buy or sell">
        <button type="button" className={side === "buy" ? "buy active" : ""} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button type="button" className={side === "sell" ? "sell active" : ""} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>

      <div className="segmented small" role="group" aria-label="Order type">
        <button type="button" className={type === "market" ? "active" : ""} onClick={() => switchType("market")}>
          Market
        </button>
        <button type="button" className={type === "limit" ? "active" : ""} onClick={() => switchType("limit")}>
          Limit
        </button>
      </div>

      <label>
        Quantity (shares)
        <div className="input-row">
          <input
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="e.g. 100"
          />
          <button type="button" onClick={setMax} disabled={lastPrice == null}>
            Max
          </button>
        </div>
      </label>

      {type === "limit" && (
        <label>
          Limit price
          <input
            inputMode="decimal"
            value={limit}
            onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="0.00"
          />
          <span className="hint muted">{stepHint}</span>
        </label>
      )}

      <dl className="estimate">
        <dt>{type === "market" ? `Est. price (${side === "buy" ? "ask" : "bid"})` : "Limit price"}</dt>
        <dd>{price != null ? formatPrice(price) : "—"}</dd>
        <dt>Value</dt>
        <dd>{value ? money(value) : "—"}</dd>
        <dt>Brokerage</dt>
        <dd>{value ? money(fee) : "—"}</dd>
        <dt>{side === "buy" ? "Total cost" : "You receive"}</dt>
        <dd>
          <strong>{value ? money(side === "buy" ? value + fee : value - fee) : "—"}</strong>
        </dd>
        <dt>{side === "buy" ? "Buying power" : "Shares you can sell"}</dt>
        <dd>{side === "buy" ? money(buyingPower) : canSell}</dd>
      </dl>

      {note && <p className="ticket-note">{note}</p>}
      {problems.map((p) => (
        <p key={p} className="error small-text">
          {p}
        </p>
      ))}

      <button type="submit" className={`primary submit-${side}`} disabled={!ready}>
        {busy ? "Placing…" : `${side === "buy" ? "Buy" : "Sell"} ${qtyValid ? qty.toLocaleString("en-AU") : ""} ${symbol}`}
      </button>

      {result && <p className={result.ok ? "up small-text" : "error small-text"}>{result.text}</p>}
      <p className="muted tiny">
        Fills use the delayed prices shown, as if live. Market orders cross the spread and can only take part of
        the volume that trades.
      </p>
    </form>
  );
}
