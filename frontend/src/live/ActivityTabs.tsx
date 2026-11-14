import { useState } from "react";

import type { AccountView, CommandResult, OrderCommand } from "./types";

type Tab = "positions" | "orders" | "fills";

function marketTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour12: false });
}

function money(value: string | null, signed = false): string {
  if (value == null) return "—";
  const n = Number(value);
  const text = Math.abs(n).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
  return signed ? `${n >= 0 ? "+" : "−"}${text}` : n < 0 ? `−${text}` : text;
}

function tone(value: string | null): string {
  const n = Number(value ?? 0);
  return n > 0 ? "up" : n < 0 ? "down" : "";
}

const STATUS_LABEL: Record<string, string> = {
  queued: "Waiting for auction",
  working: "Working",
  filled: "Filled",
  cancelled: "Cancelled",
  expired: "Expired",
  rejected: "Rejected",
};

type Props = {
  account: AccountView | null;
  onSelect: (symbol: string) => void;
  onCancel: (orderId: string) => Promise<CommandResult>;
  onOrder: (order: OrderCommand) => Promise<CommandResult>;
};

/** Positions, orders and fills, below the chart. */
export function ActivityTabs({ account, onSelect, onCancel, onOrder }: Props) {
  const [tab, setTab] = useState<Tab>("positions");
  const [error, setError] = useState<string | null>(null);
  const positions = account?.positions ?? [];
  const orders = account?.orders ?? [];
  const fills = account?.fills ?? [];
  const openCount = orders.filter((o) => o.status === "working" || o.status === "queued").length;

  async function run(action: Promise<CommandResult>) {
    const reply = await action;
    setError(reply.ok ? null : reply.error);
  }

  return (
    <section className="activity card">
      <div className="tabs-row" role="tablist">
        <button className={tab === "positions" ? "active" : ""} onClick={() => setTab("positions")}>
          Positions ({positions.length})
        </button>
        <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>
          Orders{openCount ? ` (${openCount} open)` : ""}
        </button>
        <button className={tab === "fills" ? "active" : ""} onClick={() => setTab("fills")}>
          Fills ({fills.length})
        </button>
      </div>
      {error && <p className="error small-text">{error}</p>}

      <div className="table-wrap">
        {tab === "positions" &&
          (positions.length === 0 ? (
            <p className="muted empty">No holdings yet. Buy something from the ticket on the right.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Stock</th>
                  <th>Qty</th>
                  <th>Avg cost</th>
                  <th>Last</th>
                  <th>Value</th>
                  <th>Unrealised</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol} onClick={() => onSelect(p.symbol)} className="clickable">
                    <td className="strong">{p.symbol}</td>
                    <td>{p.quantity.toLocaleString("en-AU")}</td>
                    <td>${p.average_price}</td>
                    <td>{p.last_price ? `$${p.last_price}` : "—"}</td>
                    <td>{money(p.market_value)}</td>
                    <td className={tone(p.unrealised)}>
                      {money(p.unrealised, true)}
                      {p.unrealised_pct != null ? ` (${p.unrealised_pct.toFixed(2)}%)` : ""}
                    </td>
                    <td>
                      <button
                        className="small-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void run(onOrder({ symbol: p.symbol, side: "sell", type: "market", quantity: p.quantity }));
                        }}
                      >
                        Sell all
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}

        {tab === "orders" &&
          (orders.length === 0 ? (
            <p className="muted empty">No orders yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Stock</th>
                  <th>Side</th>
                  <th>Type</th>
                  <th>Filled</th>
                  <th>Price</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const open = o.status === "working" || o.status === "queued";
                  return (
                    <tr key={o.id} title={o.message ?? undefined}>
                      <td>{marketTime(o.created_at)}</td>
                      <td className="strong clickable" onClick={() => onSelect(o.symbol)}>
                        {o.symbol}
                      </td>
                      <td className={o.side === "buy" ? "up" : "down"}>{o.side.toUpperCase()}</td>
                      <td>{o.type === "limit" ? `Limit $${o.limit_price}` : "Market"}</td>
                      <td>
                        {o.filled.toLocaleString("en-AU")} / {o.quantity.toLocaleString("en-AU")}
                      </td>
                      <td>{o.average_price ? `$${o.average_price}` : "—"}</td>
                      <td>
                        {STATUS_LABEL[o.status] ?? o.status}
                        {o.message && <span className="muted tiny block">{o.message}</span>}
                      </td>
                      <td>
                        {open && (
                          <button className="small-button" onClick={() => void run(onCancel(o.id))}>
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}

        {tab === "fills" &&
          (fills.length === 0 ? (
            <p className="muted empty">No fills yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Stock</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Price</th>
                  <th>Value</th>
                  <th>Fee</th>
                  <th>How</th>
                </tr>
              </thead>
              <tbody>
                {fills.map((f, i) => (
                  <tr key={`${f.order_id}-${i}`}>
                    <td>{marketTime(f.time)}</td>
                    <td className="strong">{f.symbol}</td>
                    <td className={f.side === "buy" ? "up" : "down"}>{f.side.toUpperCase()}</td>
                    <td>{f.quantity.toLocaleString("en-AU")}</td>
                    <td>${f.price}</td>
                    <td>{money(f.value)}</td>
                    <td>{money(f.fee)}</td>
                    <td className="muted">{f.liquidity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>
    </section>
  );
}
