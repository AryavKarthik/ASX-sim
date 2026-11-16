import { useEffect, useState } from "react";

import { EquityChart } from "./EquityChart";
import type { AccountView, Analytics, CommandResult, GroupStats } from "./types";

type Props = {
  account: AccountView | null;
  request: () => Promise<CommandResult>;
};

function money(n: number | null, signed = false): string {
  if (n == null) return "—";
  const text = Math.abs(n).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
  if (signed) return `${n >= 0 ? "+" : "−"}${text}`;
  return n < 0 ? `−${text}` : text;
}

function pct(n: number | null, signed = false): string {
  if (n == null) return "—";
  return `${signed && n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
}

function tone(n: number | null): string {
  return n == null ? "" : n > 0 ? "up" : n < 0 ? "down" : "";
}

function Tile({ label, value, sub, help, valueClass = "" }: { label: string; value: string; sub?: string; help: string; valueClass?: string }) {
  return (
    <div className="tile" title={help}>
      <span className="tile-label">{label}</span>
      <span className={`tile-value ${valueClass}`}>{value}</span>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  );
}

function GroupTable({ title, rows }: { title: string; rows: ({ label: string } & GroupStats)[] }) {
  return (
    <section className="group card-inner">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="muted small-text">No closed trades yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th />
              <th>Trades</th>
              <th>Win rate</th>
              <th>Net P&amp;L</th>
              <th>Avg R</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="strong">{r.label}</td>
                <td>{r.trades}</td>
                <td>{r.win_rate == null ? "—" : `${r.win_rate}%`}</td>
                <td className={tone(r.net_pnl)}>{money(r.net_pnl, true)}</td>
                <td className={tone(r.average_r)}>{r.average_r == null ? "—" : `${r.average_r.toFixed(2)}R`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** How your trading is going: headline numbers, equity vs the ASX 200, and what works for you. */
export function PerformancePanel({ account, request }: Props) {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Recalculate when the account changes (a fill, a review), at most once a second.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      request().then((reply) => {
        if (reply.ok && reply.analytics) {
          setData(reply.analytics);
          setError(null);
        } else if (!reply.ok) {
          setError(reply.error);
        }
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [account, request]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Working out your stats…</p>;

  const { summary: s, trades: t, risk: r, discipline: d } = data;
  const beat = s.benchmark_return_pct != null && s.total_return_pct != null ? s.total_return_pct - s.benchmark_return_pct : null;

  return (
    <div className="performance">
      <div className="tiles">
        <Tile
          label="Net P&L"
          value={money(s.net_pnl, true)}
          valueClass={tone(s.net_pnl)}
          sub={`${pct(s.total_return_pct, true)} on ${money(s.starting_cash)}`}
          help="Equity now minus your starting cash, after all brokerage"
        />
        <Tile
          label="vs ASX 200"
          value={beat == null ? "—" : pct(beat, true)}
          valueClass={tone(beat)}
          sub={s.benchmark_return_pct == null ? "needs index data" : `ASX 200 ${pct(s.benchmark_return_pct, true)} since you started`}
          help="Your return minus the ASX 200's over the same period. Positive means you beat just buying the index."
        />
        <Tile
          label="Win rate"
          value={t.win_rate == null ? "—" : `${t.win_rate}%`}
          sub={`${t.wins} won · ${t.losses} lost${t.open ? ` · ${t.open} open` : ""}`}
          help="Share of closed trades that made money after fees. A low win rate can still be profitable if wins are bigger than losses."
        />
        <Tile
          label="Profit factor"
          value={t.profit_factor == null ? "—" : t.profit_factor.toFixed(2)}
          valueClass={t.profit_factor == null ? "" : t.profit_factor >= 1 ? "up" : "down"}
          sub={`avg win ${money(t.average_win)} · avg loss ${money(t.average_loss)}`}
          help="Total won ÷ total lost. Above 1 means you make more than you lose; 1.5+ is solid."
        />
        <Tile
          label="Expectancy"
          value={money(t.expectancy, true)}
          valueClass={tone(t.expectancy)}
          sub="per trade, after fees"
          help="Average net P&L per closed trade: what each new trade is worth to you, on average."
        />
        <Tile
          label="Average R"
          value={t.average_r == null ? "—" : `${t.average_r > 0 ? "+" : ""}${t.average_r.toFixed(2)}R`}
          valueClass={tone(t.average_r)}
          sub="trades with a planned stop"
          help="Average profit or loss in units of the risk you planned. +0.5R means you make half your planned risk per trade on average."
        />
        <Tile
          label="Max drawdown"
          value={money(-r.max_drawdown)}
          valueClass={r.max_drawdown > 0 ? "down" : ""}
          sub={`${pct(-r.max_drawdown_pct)} from a high`}
          help="The biggest fall in your equity from a previous high. Shows how painful your worst run has been."
        />
        <Tile
          label="Sharpe ratio"
          value={r.sharpe == null ? "—" : r.sharpe.toFixed(2)}
          sub={r.sharpe == null ? `needs ${r.sharpe_days_needed}+ trading days` : "annualised, vs 0%"}
          help="Return per unit of day-to-day volatility, annualised. Above 1 is good; it needs several days of history."
        />
        <Tile
          label="Fees paid"
          value={money(s.fees)}
          sub={s.fees_pct_of_gross_profit == null ? "" : `${s.fees_pct_of_gross_profit}% of gross profit`}
          help="Total brokerage. For day traders, fees can eat a large share of profits."
        />
      </div>

      <section className="card-inner">
        <h4>Equity</h4>
        {data.curve.length < 2 ? (
          <p className="muted small-text">Your equity curve appears once you've closed a trade.</p>
        ) : (
          <EquityChart curve={data.curve} benchmark={data.benchmark} />
        )}
      </section>

      <div className="groups">
        <GroupTable title="By setup" rows={data.by_setup} />
        <GroupTable title="By time of day (entry)" rows={data.by_time} />
        <GroupTable title="By stock" rows={data.by_symbol} />
        <section className="group card-inner">
          <h4>Discipline</h4>
          <p className="small-text">
            {d.planned_pct == null ? "No closed trades yet." : `${d.planned_pct}% of trades had a written plan · ${d.reviewed} reviewed`}
          </p>
          <table>
            <thead>
              <tr>
                <th />
                <th>Trades</th>
                <th>Net P&amp;L</th>
                <th>Avg R</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Followed my plan", d.followed],
                ["Broke my plan", d.broke],
              ].map(([label, g]) => {
                const stats = g as GroupStats;
                return (
                  <tr key={label as string}>
                    <td className="strong">{label as string}</td>
                    <td>{stats.trades}</td>
                    <td className={tone(stats.net_pnl)}>{money(stats.net_pnl, true)}</td>
                    <td className={tone(stats.average_r)}>{stats.average_r == null ? "—" : `${stats.average_r.toFixed(2)}R`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted tiny">Mark "followed my plan" in each trade's journal review to fill this in.</p>
        </section>
      </div>
    </div>
  );
}
