import { useMarket } from "../app/market";
import { go, stockPath } from "../app/router";
import { Label, money, pct, tone } from "../app/ui";
import { AccountPanel } from "../live/AccountPanel";
import { type ActivityTab, ActivityTabs } from "../live/ActivityTabs";
import { PerformancePanel } from "../live/PerformancePanel";

const TABS: { key: ActivityTab | "performance"; label: string }[] = [
  { key: "positions", label: "Positions" },
  { key: "orders", label: "Orders" },
  { key: "fills", label: "History" },
  { key: "journal", label: "Journal" },
  { key: "performance", label: "Performance" },
];

// Distinct, calm colours for the allocation bar (cash is always the neutral grey).
const SLICE_COLOURS = ["#3987e5", "#9085e9", "#2bb3a3", "#c98500", "#d55181", "#5aa9e6", "#a3a948", "#e07b53"];

/** Your holdings, profit and loss, orders, history, journal and performance. */
export function PortfolioPage({ tab = "positions" }: { tab?: string }) {
  const market = useMarket();
  const { feed, source, names, defaults } = market;
  const account = feed.account;
  const active = (TABS.some((t) => t.key === tab) ? tab : "positions") as ActivityTab | "performance";

  if (!account) return <p className="muted">Loading your portfolio…</p>;

  const equity = Number(account.equity);
  const netPct = (100 * Number(account.net_pnl)) / Number(account.starting_cash);
  const openOrders = account.orders.filter((o) => ["pending", "queued", "working"].includes(o.status)).length;
  const counts: Partial<Record<string, number>> = {
    positions: account.positions.length,
    orders: openOrders,
    journal: account.trades.length,
  };
  const slices = account.positions
    .map((p) => ({ symbol: p.symbol, value: Number(p.market_value ?? 0) }))
    .sort((a, b) => b.value - a.value);
  const cash = Number(account.cash);

  const stats: { label: string; value: string; className?: string; sub?: string; tip: string }[] = [
    { label: "Equity", value: money(account.equity), tip: "Everything your account is worth right now: cash plus the current value of your shares." },
    {
      label: "Total P&L",
      value: money(account.net_pnl, true),
      className: tone(account.net_pnl),
      sub: `${pct(netPct)} since you started with ${money(account.starting_cash)}`,
      tip: "Profit or loss since the account started, after brokerage: equity minus starting cash.",
    },
    { label: "Unrealised P&L", value: money(account.unrealised, true), className: tone(account.unrealised), tip: "Profit or loss on shares you still hold, at today's prices. It isn't locked in until you sell." },
    { label: "Realised P&L", value: money(account.realised, true), className: tone(account.realised), tip: "Profit or loss locked in by selling shares." },
    { label: "Cash", value: money(account.cash), tip: "Money in the account not invested in shares." },
    { label: "Buying power", value: money(account.buying_power), tip: "How much you can spend on new orders: cash less money set aside for your open buy orders." },
    { label: "Fees paid", value: money(account.fees), tip: "Total brokerage paid on all your trades." },
  ];

  return (
    <div className="portfolio-page">
      <header className="page-head">
        <div>
          <h1>
            Portfolio <span className={`account-badge ${source.kind}`}>{source.kind === "demo" ? "Demo account" : "Practice account"}</span>
          </h1>
          <p className="muted">Simulated money · prices about 20 minutes delayed</p>
        </div>
      </header>

      <section className="summary-strip panel">
        {stats.map((s) => (
          <div key={s.label} className="summary-item">
            <Label tip={s.tip}>{s.label}</Label>
            <strong className={s.className}>{s.value}</strong>
            {s.sub && <span className="muted tiny">{s.sub}</span>}
          </div>
        ))}
      </section>

      <div className="portfolio-grid">
        <section className="panel portfolio-main">
          <div className="page-tabs" role="tablist">
            {TABS.map((t) => (
              <a key={t.key} role="tab" aria-selected={active === t.key} className={active === t.key ? "active" : ""} href={`#/portfolio/${t.key}`}>
                {t.label}
                {counts[t.key] ? <span className="count">{counts[t.key]}</span> : null}
              </a>
            ))}
          </div>
          {active === "performance" ? (
            <PerformancePanel account={account} request={market.requestAnalytics} />
          ) : (
            <ActivityTabs
              tab={active}
              account={account}
              names={names}
              onSelect={(symbol) => go(stockPath(symbol))}
              onCancel={market.cancelOrder}
              onOrder={market.placeOrder}
              onTrade={(symbol, side) => market.trade(symbol, side)}
              journalOptions={defaults.journal}
              onJournalSave={market.saveJournal}
            />
          )}
        </section>

        <aside className="portfolio-side">
          <section className="panel">
            <h3 className="panel-title">
              <Label tip="How your account is split between shares and cash, by current value.">Allocation</Label>
            </h3>
            <div className="allocation-bar" aria-hidden>
              {slices.map((s, i) => (
                <i key={s.symbol} style={{ flex: s.value, background: SLICE_COLOURS[i % SLICE_COLOURS.length] }} title={s.symbol} />
              ))}
              <i style={{ flex: Math.max(cash, 0), background: "#3a4453" }} title="Cash" />
            </div>
            <ul className="allocation-list">
              {slices.map((s, i) => (
                <li key={s.symbol}>
                  <i style={{ background: SLICE_COLOURS[i % SLICE_COLOURS.length] }} />
                  <a href={`#${stockPath(s.symbol)}`}>{s.symbol}</a>
                  <span className="muted">{money(s.value)}</span>
                  <strong>{equity ? `${((100 * s.value) / equity).toFixed(1)}%` : "—"}</strong>
                </li>
              ))}
              <li>
                <i style={{ background: "#3a4453" }} />
                <span>Cash</span>
                <span className="muted">{money(cash)}</span>
                <strong>{equity ? `${((100 * cash) / equity).toFixed(1)}%` : "—"}</strong>
              </li>
            </ul>
          </section>
          <AccountPanel account={account} source={source.kind} onReset={market.resetAccount} />
        </aside>
      </div>
    </div>
  );
}
