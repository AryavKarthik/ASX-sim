import { useState } from "react";

import { dayPnl } from "../app/dayPnl";
import { JournalPanel } from "./JournalPanel";
import type { AccountView, CommandResult, JournalEntry, JournalOptions, OrderCommand, OrderView, Quote } from "./types";

export type ActivityTab = "positions" | "orders" | "fills" | "journal";
type Tab = ActivityTab;

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

function describeType(o: OrderView): string {
  switch (o.display_type) {
    case "market":
      return "Market";
    case "limit":
      return `Limit $${o.limit_price}`;
    case "stop":
      return `Stop $${o.trigger_price}`;
    case "stop_limit":
      return `Stop $${o.trigger_price} → limit $${o.limit_price}`;
    case "trailing_stop": {
      const trail = o.trail_amount ? `$${o.trail_amount}` : `${o.trail_percent}%`;
      return o.status === "pending" ? `Trailing ${trail} (now $${o.trigger_price})` : `Trailing ${trail}`;
    }
  }
}

function settleDay(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for trigger",
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
  journalOptions: JournalOptions;
  onJournalSave: (tradeId: string, fields: Partial<JournalEntry>) => Promise<CommandResult>;
  /** Show one tab, chosen by the page (hides the built-in tab row). */
  tab?: ActivityTab;
  onTrade?: (symbol: string, side: "buy" | "sell") => void;
  names?: Record<string, string>;
  /** Live quotes, for each holding's change today. */
  quotes?: Record<string, Quote>;
  sessionDay?: string | null;
};

/** Positions, orders, fills and the trade journal, below the chart. */
export function ActivityTabs({ account, onSelect, onCancel, onOrder, journalOptions, onJournalSave, tab: fixedTab, onTrade, names = {}, quotes = {}, sessionDay = null }: Props) {
  const [chosen, setTab] = useState<Tab>("positions");
  const tab = fixedTab ?? chosen;
  const [error, setError] = useState<string | null>(null);
  const positions = account?.positions ?? [];
  const orders = account?.orders ?? [];
  const fills = account?.fills ?? [];
  const openCount = orders.filter((o) => ["pending", "queued", "working"].includes(o.status)).length;

  const equity = Number(account?.equity ?? 0);
  const dayChange = (symbol: string, _quantity: number): number | null => {
    const position = positions.find((p) => p.symbol === symbol);
    return position ? dayPnl(position, quotes[symbol], account?.fills ?? [], sessionDay) : null;
  };

  async function run(action: Promise<CommandResult>) {
    const reply = await action;
    setError(reply.ok ? null : reply.error);
  }

  return (
    <section className={`activity ${fixedTab ? "embedded" : "card"}`}>
      <div className="tabs-row" role="tablist" hidden={fixedTab != null}>
        <button className={tab === "positions" ? "active" : ""} onClick={() => setTab("positions")}>
          Positions ({positions.length})
        </button>
        <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>
          Orders{openCount ? ` (${openCount} open)` : ""}
        </button>
        <button className={tab === "fills" ? "active" : ""} onClick={() => setTab("fills")}>
          Fills ({fills.length})
        </button>
        <button className={tab === "journal" ? "active" : ""} onClick={() => setTab("journal")}>
          Journal ({account?.trades.length ?? 0})
        </button>
      </div>
      {error && <p className="error small-text">{error}</p>}

      <div className="table-wrap">
        {tab === "journal" && (
          <JournalPanel
            trades={account?.trades ?? []}
            options={journalOptions}
            onSave={onJournalSave}
            onSelectSymbol={onSelect}
          />
        )}
        {tab === "positions" &&
          (positions.length === 0 ? (
            <p className="muted empty">No holdings yet. Open a stock from your watchlist or the search bar, then press Buy.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Stock</th>
                  <th className="num">Shares</th>
                  <th className="num">Avg cost</th>
                  <th className="num">Last</th>
                  <th className="num" title="Today's profit or loss: shares held overnight from yesterday's close, shares bought today from what you paid">Day change</th>
                  <th className="num">Market value</th>
                  <th className="num" title="Share of your account's total value">Weight</th>
                  <th className="num">Unrealised P&amp;L</th>
                  <th className="num">Realised P&amp;L</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol} onClick={() => onSelect(p.symbol)} className="clickable">
                    <td>
                      <span className="cell-symbol">{p.symbol}</span>
                      <span className="cell-name">{names[p.symbol] ?? ""}</span>
                    </td>
                    <td className="num">{p.quantity.toLocaleString("en-AU")}</td>
                    <td className="num">${p.average_price}</td>
                    <td className="num">{p.last_price ? `$${p.last_price}` : "—"}</td>
                    <td className={`num ${tone(String(dayChange(p.symbol, p.quantity) ?? 0))}`}>
                      {dayChange(p.symbol, p.quantity) == null ? "—" : money(String(dayChange(p.symbol, p.quantity)), true)}
                      {(() => {
                        // As a percentage of what the holding was worth at the start of today.
                        const change = dayChange(p.symbol, p.quantity);
                        const base = Number(p.market_value ?? 0) - (change ?? 0);
                        if (change == null || !base) return null;
                        const percent = (100 * change) / base;
                        return (
                          <span className="cell-sub">
                            {percent >= 0 ? "+" : ""}
                            {percent.toFixed(2)}%
                          </span>
                        );
                      })()}
                    </td>
                    <td className="num">
                      {money(p.market_value)}
                      <span className="cell-sub muted">cost {money(String(Number(p.average_price) * p.quantity))}</span>
                    </td>
                    <td className="num">{equity && p.market_value ? `${((100 * Number(p.market_value)) / equity).toFixed(1)}%` : "—"}</td>
                    <td className={`num ${tone(p.unrealised)}`}>
                      {money(p.unrealised, true)}
                      {p.unrealised_pct != null && <span className="cell-sub">{p.unrealised_pct >= 0 ? "+" : ""}{p.unrealised_pct.toFixed(2)}%</span>}
                    </td>
                    <td className={`num ${tone(p.realised)}`}>{money(p.realised, true)}</td>
                    <td className="row-actions">
                      {onTrade && (
                        <button
                          className="small-button trade-button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onTrade(p.symbol, "buy");
                          }}
                        >
                          Trade
                        </button>
                      )}
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
                  const open = ["pending", "queued", "working"].includes(o.status);
                  return (
                    <tr key={o.id} title={o.message ?? undefined}>
                      <td>{marketTime(o.created_at)}</td>
                      <td className="strong clickable" onClick={() => onSelect(o.symbol)}>
                        {o.symbol}
                      </td>
                      <td className={o.side === "buy" ? "up" : "down"}>{o.side.toUpperCase()}</td>
                      <td>
                        {describeType(o)}
                        {o.time_in_force === "gtc" && <span className="tag">GTC</span>}
                      </td>
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
                  <th>Settles</th>
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
                    <td className="muted">{settleDay(f.settles_on)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>
    </section>
  );
}
