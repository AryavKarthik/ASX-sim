import { type FormEvent, useEffect, useState } from "react";

import type { Phase } from "../api";
import { formatPrice } from "../format";
import { estimatedTouch, isValidPrice, nearestValid, priceDecimals, tickSize } from "./ticks";
import type { AccountView, CommandResult, OrderCommand, OrderKind, Quote } from "./types";

const MIN_FIRST_PURCHASE = 500;
const ORDER_PHASES: Phase[] = ["pre_open", "open", "pre_cspa", "adjust_on"];
const OPEN_STATUSES = ["pending", "queued", "working"];

const KINDS: { value: OrderKind; label: string }[] = [
  { value: "market", label: "Market" },
  { value: "limit", label: "Limit" },
  { value: "stop", label: "Stop (stop-loss)" },
  { value: "stop_limit", label: "Stop-limit" },
  { value: "trailing_stop", label: "Trailing stop" },
];

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

function phaseNote(phase: Phase, conditional: boolean): string | null {
  if (conditional && ORDER_PHASES.includes(phase)) {
    return phase === "open" ? null : "Your conditional order will start watching once normal trading begins.";
  }
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

/** Positive number from a text field, or null. */
function num(text: string): number | null {
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function OrderTicket({ symbol, name, quote, lastPrice, account, phase, onSubmit }: Props) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [kind, setKind] = useState<OrderKind>("market");
  const [quantity, setQuantity] = useState("");
  const [limit, setLimit] = useState("");
  const [trigger, setTrigger] = useState("");
  const [trail, setTrail] = useState("");
  const [trailUnit, setTrailUnit] = useState<"$" | "%">("%");
  const [tif, setTif] = useState<"day" | "gtc">("day");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // A new stock starts with a fresh ticket.
  useEffect(() => {
    setQuantity("");
    setLimit("");
    setTrigger("");
    setResult(null);
  }, [symbol]);

  const needsLimit = kind === "limit" || kind === "stop_limit";
  const needsTrigger = kind === "stop" || kind === "stop_limit";
  const isTrailing = kind === "trailing_stop";
  const conditional = needsTrigger || isTrailing;

  const touch = lastPrice != null ? estimatedTouch(lastPrice, quote?.bid ?? null, quote?.ask ?? null) : null;
  const marketPrice = touch ? (side === "buy" ? touch[1] : touch[0]) : null;
  const qty = Number(quantity);
  const qtyValid = Number.isInteger(qty) && qty > 0;
  const limitNum = num(limit);
  const triggerNum = num(trigger);
  const trailNum = num(trail);
  const trailDistance =
    trailNum == null || lastPrice == null ? null : trailUnit === "$" ? trailNum : (lastPrice * trailNum) / 100;
  // Rounded to a valid price step the same way the server does (down for sells, up for buys).
  const trailTrigger =
    trailDistance == null || lastPrice == null
      ? null
      : side === "sell"
        ? nearestValid(Math.max(lastPrice - trailDistance, 0.001))[0]
        : nearestValid(lastPrice + trailDistance)[1];

  // The price this order would roughly trade at, for the cost estimate.
  const price = needsLimit ? limitNum : needsTrigger ? triggerNum : isTrailing ? trailTrigger : marketPrice;
  const value = price != null && qtyValid ? price * qty : 0;
  const fee = brokerageFor(value, account);
  const held = account?.positions.find((p) => p.symbol === symbol)?.quantity ?? 0;
  const reservedSells = (account?.orders ?? [])
    .filter((o) => o.symbol === symbol && o.side === "sell" && OPEN_STATUSES.includes(o.status))
    .reduce((sum, o) => sum + o.quantity - o.filled, 0);
  const canSell = held - reservedSells;
  const buyingPower = Number(account?.buying_power ?? 0);
  const acceptsOrders = ORDER_PHASES.includes(phase);

  const problems: string[] = [];
  const priceProblem = (label: string, text: string, n: number | null) => {
    if (text === "") return;
    if (n == null || !isValidPrice(n)) {
      const [down, up] = nearestValid(n ?? 0);
      problems.push(`${label} $${text} isn't a valid ASX price step. Try ${formatPrice(down)} or ${formatPrice(up)}.`);
    }
  };
  if (quantity !== "" && !qtyValid) problems.push("Quantity must be a whole number of shares.");
  if (needsLimit) priceProblem("Limit", limit, limitNum);
  if (needsTrigger) {
    priceProblem("Trigger", trigger, triggerNum);
    if (triggerNum != null && lastPrice != null) {
      if (side === "sell" && triggerNum >= lastPrice) {
        problems.push(`A sell stop's trigger must be below the current price (${formatPrice(lastPrice)}).`);
      }
      if (side === "buy" && triggerNum <= lastPrice) {
        problems.push(`A buy stop's trigger must be above the current price (${formatPrice(lastPrice)}).`);
      }
    }
  }
  if (isTrailing && trail !== "" && trailNum == null) problems.push("Enter a trail above zero.");
  if (isTrailing && trailUnit === "%" && trailNum != null && trailNum > 50) {
    problems.push("The trail percentage must be 50% or less.");
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

  const fieldsReady =
    (!needsLimit || (limitNum != null && isValidPrice(limitNum))) &&
    (!needsTrigger || (triggerNum != null && isValidPrice(triggerNum))) &&
    (!isTrailing || trailNum != null);
  const ready =
    acceptsOrders && qtyValid && fieldsReady && problems.length === 0 && lastPrice != null && !busy;

  function setMax() {
    if (side === "sell") {
      setQuantity(String(Math.max(canSell, 0)));
    } else if (price) {
      const affordable = Math.floor((buyingPower - brokerageFor(buyingPower, account)) / price);
      setQuantity(String(Math.max(affordable, 0)));
    }
  }

  function switchKind(next: OrderKind) {
    setKind(next);
    if (next === "market") setTif("day");
    const start = lastPrice != null ? lastPrice.toFixed(priceDecimals(lastPrice)) : "";
    if ((next === "limit" || next === "stop_limit") && limit === "") setLimit(start);
    if (next === "trailing_stop" && trail === "") setTrail("1");
  }

  function explain(): string | null {
    const verb = side === "buy" ? "Buys" : "Sells";
    const qtyText = qtyValid ? `${qty.toLocaleString("en-AU")} ` : "";
    switch (kind) {
      case "stop":
        return triggerNum
          ? `${verb} ${qtyText}${symbol} at market if it trades at or ${side === "sell" ? "below" : "above"} ${formatPrice(triggerNum)}.`
          : null;
      case "stop_limit":
        return triggerNum && limitNum
          ? `When ${symbol} trades at or ${side === "sell" ? "below" : "above"} ${formatPrice(triggerNum)}, places a limit to ${side} at ${formatPrice(limitNum)}. It may not fill if the price moves past your limit.`
          : null;
      case "trailing_stop":
        return trailNum && trailTrigger != null
          ? `${verb} at market if ${symbol} ${side === "sell" ? "falls" : "rises"} ${trailUnit === "$" ? formatPrice(trailNum) : `${trailNum}%`} from its ${side === "sell" ? "highest" : "lowest"} price since you placed it. The trigger starts near ${formatPrice(trailTrigger)}.`
          : null;
      default:
        return null;
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
      type: kind,
      quantity: qty,
      time_in_force: kind === "market" ? "day" : tif,
      ...(needsLimit ? { limit_price: limit } : {}),
      ...(needsTrigger ? { trigger_price: trigger } : {}),
      ...(isTrailing ? (trailUnit === "$" ? { trail_amount: trail } : { trail_percent: trail }) : {}),
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
    } else if (order?.status === "pending") {
      setResult({ ok: true, text: "Order placed: waiting for its trigger price." });
    } else if (order?.status === "queued") {
      setResult({ ok: true, text: `Order placed: waiting for the ${order.auction === "close" ? "closing" : "opening"} auction.` });
    } else {
      setResult({ ok: true, text: "Order placed: working in the market." });
    }
    setQuantity("");
  }

  const note = phaseNote(phase, conditional);
  const explanation = explain();
  const stepHint =
    lastPrice != null ? `Price step at this price: ${+(tickSize(lastPrice) * 100).toFixed(1)}c` : "";
  const priceLabel =
    kind === "market"
      ? `Est. price (${side === "buy" ? "ask" : "bid"})`
      : needsLimit
        ? "Limit price"
        : "Est. trigger price";

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

      <label>
        Order type
        <select value={kind} onChange={(e) => switchKind(e.target.value as OrderKind)}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>

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

      {needsTrigger && (
        <label>
          Trigger price
          <input
            inputMode="decimal"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder={side === "sell" ? "below the current price" : "above the current price"}
          />
        </label>
      )}

      {needsLimit && (
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

      {isTrailing && (
        <label>
          Trail by
          <div className="input-row">
            <input
              inputMode="decimal"
              value={trail}
              onChange={(e) => setTrail(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder={trailUnit === "%" ? "e.g. 2" : "e.g. 0.50"}
            />
            <div className="segmented small unit" role="group" aria-label="Trail unit">
              <button type="button" className={trailUnit === "%" ? "active" : ""} onClick={() => setTrailUnit("%")}>
                %
              </button>
              <button type="button" className={trailUnit === "$" ? "active" : ""} onClick={() => setTrailUnit("$")}>
                $
              </button>
            </div>
          </div>
        </label>
      )}

      {kind !== "market" && (
        <div className="segmented small" role="group" aria-label="How long the order lasts">
          <button type="button" className={tif === "day" ? "active" : ""} onClick={() => setTif("day")}>
            Day only
          </button>
          <button type="button" className={tif === "gtc" ? "active" : ""} onClick={() => setTif("gtc")}>
            Good till cancelled
          </button>
        </div>
      )}

      {explanation && <p className="small-text muted">{explanation}</p>}

      <dl className="estimate">
        <dt>{priceLabel}</dt>
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
        Fills use the delayed prices shown, as if live. Stops are broker-side conditional orders: they trigger on
        the last traded price. GTC orders last up to 30 days.
      </p>
    </form>
  );
}
