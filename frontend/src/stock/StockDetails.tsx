// The detail tabs under a stock's chart, laid out the way broker apps present a company:
// overview statistics, financials, dividends, analyst views, the company itself, and your
// own activity in the stock.

import { type ReactNode, useState } from "react";

import type { Bar } from "../api";
import { Label, compactNumber, money, pct, tone } from "../app/ui";
import { formatPrice } from "../format";
import { type Company, compact, ratios } from "../live/company";
import type { AccountView, CommandResult, Quote } from "../live/types";
import { sessionFigures } from "./MarketData";

type Tab = "overview" | "financials" | "dividends" | "analysts" | "company" | "activity";

type Props = {
  symbol: string;
  isIndex: boolean;
  company: Company | null;
  companyError: string | null;
  index: Company | null; // the ASX 200, for relative performance
  price: number | null;
  todayPct: number | null;
  quote: Quote | undefined;
  bars: Bar[];
  account: AccountView | null;
  demo: boolean;
  onCancel: (orderId: string) => Promise<CommandResult>;
};

type Row = { label: string; value: ReactNode; tip?: string; className?: string };

function StatRows({ rows }: { rows: Row[] }) {
  return (
    <dl className="stat-rows">
      {rows.map((r) => (
        <div key={r.label}>
          <dt>
            <Label tip={r.tip}>{r.label}</Label>
          </dt>
          <dd className={r.className}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Group({ title, children, tip }: { title: string; children: ReactNode; tip?: string }) {
  return (
    <section className="stat-group">
      <h4>
        <Label tip={tip}>{title}</Label>
      </h4>
      {children}
    </section>
  );
}

const dash = "—";
const priceText = (n: number | null | undefined) => (n == null ? dash : formatPrice(n));
const ratio = (n: number | null | undefined, digits = 1) => (n == null ? dash : `${n.toFixed(digits)}×`);
const share = (n: number | null | undefined, digits = 1) => (n == null ? dash : `${(100 * n).toFixed(digits)}%`);
const signedShare = (n: number | null | undefined) => (n == null ? dash : pct(100 * n, true, 1));
const vsPrice = (price: number | null, level: number | null) => (price == null || level == null || !level ? null : 100 * (price / level - 1));

export function StockDetails(props: Props) {
  const { isIndex, company } = props;
  const [tab, setTab] = useState<Tab>("overview");
  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: "overview", label: "Overview", show: true },
    { key: "financials", label: "Financials", show: !isIndex },
    { key: "dividends", label: "Dividends", show: !isIndex },
    { key: "analysts", label: "Analysts", show: !isIndex },
    { key: "company", label: isIndex ? "About" : "Company", show: true },
    { key: "activity", label: "Your activity", show: !isIndex },
  ];

  return (
    <section className="panel stock-details">
      <div className="page-tabs" role="tablist">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
      </div>
      {props.companyError && tab !== "activity" && <p className="error small-text">Couldn't load company information: {props.companyError}</p>}
      {!company && !props.companyError && tab !== "activity" && <p className="muted">Loading {props.symbol}…</p>}
      {company && tab === "overview" && <Overview {...props} company={company} />}
      {company && tab === "financials" && <Financials company={company} />}
      {company && tab === "dividends" && <Dividends company={company} price={props.price} />}
      {company && tab === "analysts" && <AnalystView company={company} price={props.price} demo={props.demo} />}
      {company && tab === "company" && <CompanyFacts company={company} />}
      {tab === "activity" && <Activity {...props} />}
    </section>
  );
}

function Overview({ company, index, price, todayPct, quote, bars, isIndex, symbol }: Props & { company: Company }) {
  const f = company.fundamentals;
  const r = ratios(f, price);
  const p = company.price;
  const session = sessionFigures(bars);
  const above50 = vsPrice(price, p.sma50);
  const above200 = vsPrice(price, p.sma200);
  const trend =
    above50 == null || above200 == null
      ? null
      : above50 > 0 && above200 > 0
        ? "Above its 50- and 200-day averages: an uptrend"
        : above50 < 0 && above200 < 0
          ? "Below its 50- and 200-day averages: a downtrend"
          : "Between its 50- and 200-day averages: mixed";
  const indexReturns = new Map((index?.price.returns ?? []).map((x) => [x.label, x.pct]));

  return (
    <div className="overview">
      <div className="stat-grid">
        <Group title="Trading">
          <StatRows
            rows={[
              { label: "Open", value: priceText(quote?.open), tip: "The first price of the session, set by the opening auction." },
              { label: "High", value: priceText(quote?.day_high) },
              { label: "Low", value: priceText(quote?.day_low) },
              { label: "Previous close", value: priceText(quote?.previous_close) },
              { label: "Volume", value: compactNumber(quote?.day_volume ?? session.volume) },
              { label: "Average volume (30 days)", value: compactNumber(p.average_volume_30d), tip: "Today's volume well above this means unusual interest." },
              { label: "Turnover", value: session.turnover != null ? `$${compactNumber(session.turnover)}` : dash, tip: "Dollar value traded today." },
              { label: "VWAP", value: priceText(session.vwap), tip: "Volume-weighted average price today." },
            ]}
          />
        </Group>
        {!isIndex && (
          <Group title="Valuation" tip="Worked out from the price on screen, so these move with the price.">
            <StatRows
              rows={[
                { label: "Market cap", value: r.marketCap != null ? `$${compact(r.marketCap)}` : dash, tip: "Price × shares on issue: what the whole company is worth." },
                { label: "P/E ratio", value: ratio(r.pe), tip: "Price ÷ earnings per share over the last year. Blank if the company made a loss." },
                { label: "Forward P/E", value: ratio(r.forwardPe), tip: "Price ÷ analysts' forecast earnings per share." },
                { label: "EPS (trailing)", value: f.eps != null ? `$${f.eps.toFixed(2)}` : dash, tip: "Earnings per share over the last 12 months." },
                { label: "Price to book", value: ratio(r.priceToBook), tip: "Price ÷ net assets per share." },
                { label: "Dividend yield", value: r.dividendYieldPct != null ? `${r.dividendYieldPct.toFixed(2)}%` : dash, tip: "Dividends over the last year ÷ price, before franking credits." },
                { label: "Beta", value: f.beta != null ? f.beta.toFixed(2) : dash, tip: "How much it tends to move against the market: 1 = with it, above 1 = more." },
              ]}
            />
          </Group>
        )}
        <Group title="Technicals" tip="Moving averages and the 52-week range, from daily closes up to yesterday.">
          <StatRows
            rows={[
              { label: "50-day average", value: priceText(p.sma50) },
              { label: "Price vs 50-day", value: pct(above50), className: tone(above50) },
              { label: "200-day average", value: priceText(p.sma200) },
              { label: "Price vs 200-day", value: pct(above200), className: tone(above200) },
              { label: "52-week high", value: priceText(p.week52_high) },
              { label: "From 52-week high", value: pct(vsPrice(price, p.week52_high)), className: tone(vsPrice(price, p.week52_high)) },
              { label: "52-week low", value: priceText(p.week52_low) },
            ]}
          />
          {trend && <p className="trend-note">{trend}</p>}
        </Group>
        <Group title="Performance vs ASX 200" tip="Price change over each period (dividends excluded), against the S&P/ASX 200 over the same period.">
          <table className="data-table compact perf-table">
            <thead>
              <tr>
                <th>Period</th>
                <th className="num">{symbol}</th>
                <th className="num">ASX 200</th>
                <th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Today</td>
                <td className={`num ${tone(todayPct)}`}>{pct(todayPct)}</td>
                <td className="num muted">{dash}</td>
                <td className="num muted">{dash}</td>
              </tr>
              {p.returns.map((x) => {
                const ix = indexReturns.get(x.label) ?? null;
                const diff = x.pct != null && ix != null ? x.pct - ix : null;
                return (
                  <tr key={x.label}>
                    <td>{x.label}</td>
                    <td className={`num ${tone(x.pct)}`}>{pct(x.pct, true, 1)}</td>
                    <td className={`num ${tone(ix)}`}>{pct(ix, true, 1)}</td>
                    <td className={`num strong ${tone(diff)}`}>{diff == null ? dash : `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${Math.abs(diff).toFixed(1)} pts`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Group>
      </div>
      {company.summary && (
        <p className="overview-about">
          <strong>About.</strong> {company.summary.length > 360 ? `${company.summary.slice(0, 360).trimEnd()}…` : company.summary}
        </p>
      )}
      <p className="muted tiny">Statistics to the close on {p.as_of ?? dash}. Company figures are Yahoo Finance's latest reported.</p>
    </div>
  );
}

function Financials({ company }: { company: Company }) {
  const f = company.fundamentals;
  const cur = f.reporting_currency ?? "";
  const big = (n: number | null) => (n == null ? dash : `${cur ? `${cur} ` : ""}${compact(n)}`);
  return (
    <div className="overview">
    <div className="stat-grid">
      <Group title="Income (last 12 months)">
        <StatRows
          rows={[
            { label: "Revenue", value: big(f.revenue), tip: "Total sales." },
            { label: "Net profit", value: big(f.net_income), tip: "Profit after all costs and tax." },
            { label: "Revenue growth", value: signedShare(f.revenue_growth), className: tone(f.revenue_growth), tip: "Change in revenue against the same period a year earlier." },
            { label: "Earnings growth", value: signedShare(f.earnings_growth), className: tone(f.earnings_growth), tip: "Change in earnings against the same period a year earlier." },
            { label: "EPS", value: f.eps != null ? `$${f.eps.toFixed(2)}` : dash, tip: "Earnings per share." },
          ]}
        />
      </Group>
      <Group title="Margins">
        <StatRows
          rows={[
            { label: "Gross margin", value: f.gross_margin ? share(f.gross_margin) : dash, tip: "Revenue left after the direct cost of what was sold. Not meaningful for banks." },
            { label: "Operating margin", value: share(f.operating_margin), tip: "Profit from operations ÷ revenue, before interest and tax." },
            { label: "Net margin", value: share(f.profit_margin), tip: "Net profit ÷ revenue: cents of profit per dollar of sales." },
            { label: "Return on equity", value: share(f.return_on_equity), tip: "Net profit ÷ shareholders' funds." },
          ]}
        />
      </Group>
      <Group title="Balance sheet">
        <StatRows
          rows={[
            { label: "Cash", value: big(f.total_cash) },
            { label: "Debt", value: big(f.total_debt) },
            { label: "Debt to equity", value: f.debt_to_equity != null ? `${f.debt_to_equity.toFixed(0)}%` : dash, tip: "Borrowings as a percentage of shareholders' funds." },
            { label: "Current ratio", value: ratio(f.current_ratio, 2), tip: "Short-term assets ÷ short-term debts. Below 1 can mean a squeeze. Not reported for banks." },
            { label: "Book value per share", value: f.book_value_per_share != null ? `$${f.book_value_per_share.toFixed(2)}` : dash, tip: "Net assets per share." },
          ]}
        />
      </Group>
    </div>
      <p className="muted tiny">Figures are the latest reported, in {cur || "the reporting currency"}{cur && f.trading_currency && cur !== f.trading_currency ? ` (the shares trade in ${f.trading_currency})` : ""}.</p>
    </div>
  );
}

function Dividends({ company, price }: { company: Company; price: number | null }) {
  const f = company.fundamentals;
  const paid = company.dividends;
  const r = ratios(f, price);
  const forwardYield = f.forward_dividend_per_share != null && price ? (100 * f.forward_dividend_per_share) / price : null;
  const history = [...paid].reverse(); // oldest first for the chart
  const max = Math.max(...history.map((d) => d.amount), 0);

  return (
    <div className="dividends">
      <div className="stat-grid">
        <Group title="Summary">
          <StatRows
            rows={[
              { label: "Paid over last 12 months", value: f.dividend_per_share != null ? `$${f.dividend_per_share.toFixed(2)}` : dash },
              { label: "Trailing yield", value: r.dividendYieldPct != null ? `${r.dividendYieldPct.toFixed(2)}%` : dash, tip: "Last year's dividends ÷ the price on screen." },
              { label: "Forward dividend", value: f.forward_dividend_per_share != null ? `$${f.forward_dividend_per_share.toFixed(2)}` : dash, tip: "The expected annual dividend at the latest rate." },
              { label: "Forward yield", value: forwardYield != null ? `${forwardYield.toFixed(2)}%` : dash },
              { label: "5-year average yield", value: f.five_year_average_yield != null ? `${f.five_year_average_yield.toFixed(2)}%` : dash },
              { label: "Payout ratio", value: share(f.payout_ratio, 0), tip: "Share of profit paid out. Near or above 100% is hard to sustain." },
              { label: "Last ex-dividend date", value: f.ex_dividend_date ?? dash, tip: "Buy before this date to receive the dividend; buying on or after it doesn't." },
            ]}
          />
        </Group>
        <Group title="Dividend history" tip="Cash per share paid at each ex-dividend date.">
          {history.length === 0 ? (
            <p className="muted small-text">No dividends on record.</p>
          ) : (
            <>
              <div className="div-chart" role="img" aria-label="Dividend history chart">
                {history.map((d) => (
                  <div key={d.date} className="div-bar" title={`${d.date}: $${d.amount.toFixed(3)}`}>
                    <i style={{ height: `${max ? (100 * d.amount) / max : 0}%` }} />
                    <span>{d.date.slice(2, 7)}</span>
                  </div>
                ))}
              </div>
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Ex-dividend date</th>
                    <th className="num">Per share</th>
                    <th className="num">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {paid.slice(0, 8).map((d, i) => {
                    const prior = paid[i + 2]; // same half of the year before (ASX pays twice yearly)
                    const change = prior ? (100 * (d.amount - prior.amount)) / prior.amount : null;
                    return (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td className="num">${d.amount.toFixed(3)}</td>
                        <td className={`num ${tone(change)}`} title="Against the matching payment a year earlier">
                          {pct(change, true, 1)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </Group>
      </div>
      <p className="muted tiny">
        Many ASX dividends come with franking credits (tax already paid by the company), which can add to the after-tax return. Yahoo doesn't publish franking, so it isn't shown. "Change" compares each payment with the matching one a year earlier.
      </p>
    </div>
  );
}

const RATING_STEPS = ["Strong buy", "Buy", "Hold", "Sell", "Strong sell"];

function AnalystView({ company, price, demo }: { company: Company; price: number | null; demo: boolean }) {
  const a = company.analysts;
  if (!a.count) return <p className="muted">No analyst coverage is reported for {company.code}.</p>;
  const upside = price && a.target_mean ? 100 * (a.target_mean / price - 1) : null;
  const low = Math.min(a.target_low ?? Infinity, price ?? Infinity);
  const high = Math.max(a.target_high ?? -Infinity, price ?? -Infinity);
  const at = (v: number | null) => (v == null || !Number.isFinite(low) || high <= low ? null : (100 * (v - low)) / (high - low));
  const scoreAt = a.rating_score != null ? ((a.rating_score - 1) / 4) * 100 : null;

  return (
    <div className="analysts">
      <div className="stat-grid">
        <Group title="Consensus rating" tip="The average recommendation of the analysts who cover the stock, on a scale from 1 (strong buy) to 5 (strong sell).">
          <div className="rating-head">
            <span className={`rating-badge r-${(a.rating ?? "").toLowerCase().replace(" ", "-")}`}>{a.rating ?? dash}</span>
            <span className="muted">
              {a.count} analyst{a.count === 1 ? "" : "s"}
              {a.rating_score != null && ` · score ${a.rating_score.toFixed(2)} of 5`}
            </span>
          </div>
          <div className="rating-scale" aria-hidden>
            <div className="rating-track">{scoreAt != null && <i style={{ left: `${scoreAt}%` }} />}</div>
            <div className="rating-labels">
              {RATING_STEPS.map((s) => (
                <span key={s}>{s}</span>
              ))}
            </div>
          </div>
        </Group>
        <Group title="12-month price targets" tip="Where analysts think the price will be in a year. Targets are often wrong and change often.">
          <StatRows
            rows={[
              { label: "Average target", value: priceText(a.target_mean) },
              { label: "vs price on screen", value: pct(upside, true, 1), className: tone(upside) },
              { label: "Median target", value: priceText(a.target_median) },
              { label: "Highest", value: priceText(a.target_high) },
              { label: "Lowest", value: priceText(a.target_low) },
            ]}
          />
          {Number.isFinite(low) && high > low && (
            <div className="target-range" aria-hidden>
              <div className="target-track">
                {at(a.target_mean) != null && <i className="mean" style={{ left: `${at(a.target_mean)}%` }} title="Average target" />}
                {at(price) != null && <i className="now" style={{ left: `${at(price)}%` }} title="Price on screen" />}
              </div>
              <div className="target-legend">
                <span>{priceText(low)}</span>
                <span>
                  <b className="dot now" /> price <b className="dot mean" /> average target
                </span>
                <span>{priceText(high)}</span>
              </div>
            </div>
          )}
        </Group>
      </div>
      <p className="muted tiny">
        Yahoo Finance's latest consensus{demo ? ", as of today, not the demo day" : ""}. Analyst opinions are one input, not a reason to trade: form your own view, and this isn't financial advice.
      </p>
    </div>
  );
}

function CompanyFacts({ company }: { company: Company }) {
  const [expanded, setExpanded] = useState(false);
  const o = company.ownership;
  const summary = company.summary ?? "";
  const long = summary.length > 700;
  return (
    <div className="company-facts">
      {summary && (
        <p className="company-summary">
          {long && !expanded ? `${summary.slice(0, 700).trimEnd()}… ` : `${summary} `}
          {long && (
            <button className="link" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Read more"}
            </button>
          )}
        </p>
      )}
      <div className="stat-grid">
        <Group title="Profile">
          <StatRows
            rows={[
              { label: "Name", value: company.name },
              { label: "Sector", value: company.sector ?? dash },
              { label: "Industry", value: company.industry ?? dash },
              { label: "Headquarters", value: company.headquarters ?? dash },
              { label: "Employees", value: company.employees != null ? company.employees.toLocaleString("en-AU") : dash },
              {
                label: "Links",
                value: (
                  <span className="links">
                    {company.website && (
                      <a href={company.website} target="_blank" rel="noreferrer">
                        Website
                      </a>
                    )}
                    {company.kind !== "index" && (
                      <a href={`https://www.asx.com.au/markets/company/${company.code}`} target="_blank" rel="noreferrer">
                        ASX announcements
                      </a>
                    )}
                  </span>
                ),
              },
            ]}
          />
        </Group>
        {company.kind !== "index" && (
          <Group title="Ownership" tip="Who holds the shares, as a share of those on issue.">
            <StatRows
              rows={[
                { label: "Institutions", value: share(o.institutions), tip: "Fund managers, super funds and other professional investors." },
                { label: "Insiders", value: share(o.insiders, 2), tip: "Directors and executives." },
                { label: "Shares on issue", value: compactNumber(company.fundamentals.shares_outstanding) },
                { label: "Free float", value: compactNumber(o.float_shares), tip: "Shares available to trade, excluding large locked-up holdings." },
              ]}
            />
            {o.institutions != null && (
              <div className="ownership-bar" aria-hidden>
                <i className="inst" style={{ flex: o.institutions }} />
                <i className="ins" style={{ flex: o.insiders ?? 0 }} />
                <i className="rest" style={{ flex: Math.max(0, 1 - o.institutions - (o.insiders ?? 0)) }} />
              </div>
            )}
          </Group>
        )}
        {company.officers.length > 0 && (
          <Group title="Management">
            <ul className="officers">
              {company.officers.map((p) => (
                <li key={p.name}>
                  <strong>{p.name}</strong>
                  <span className="muted">{p.title}</span>
                </li>
              ))}
            </ul>
          </Group>
        )}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for trigger",
  queued: "Waiting for auction",
  working: "Working",
};

function Activity({ symbol, account, onCancel }: Props) {
  const position = account?.positions.find((p) => p.symbol === symbol);
  const openOrders = (account?.orders ?? []).filter((o) => o.symbol === symbol && ["pending", "queued", "working"].includes(o.status));
  const trades = (account?.trades ?? []).filter((t) => t.symbol === symbol);
  return (
    <div className="activity-tab">
      {position && (
        <div className="stat-grid">
          <Group title="Your position">
            <StatRows
              rows={[
                { label: "Shares", value: position.quantity.toLocaleString("en-AU") },
                { label: "Average cost", value: `$${position.average_price}` },
                { label: "Cost base", value: money(Number(position.average_price) * position.quantity) },
                { label: "Market value", value: money(position.market_value) },
                { label: "Unrealised P&L", value: money(position.unrealised, true), className: tone(position.unrealised) },
                { label: "Realised P&L", value: money(position.realised, true), className: tone(position.realised) },
              ]}
            />
          </Group>
        </div>
      )}
      <h3 className="panel-title">Open orders</h3>
      {openOrders.length === 0 ? (
        <p className="muted small-text">No open orders for {symbol}.</p>
      ) : (
        <table className="data-table compact">
          <tbody>
            {openOrders.map((o) => (
              <tr key={o.id}>
                <td className={o.side === "buy" ? "up" : "down"}>{o.side.toUpperCase()}</td>
                <td>
                  {o.quantity.toLocaleString("en-AU")} × {o.display_type.replace("_", " ")}
                  {o.limit_price && ` $${o.limit_price}`}
                  {o.trigger_price && ` (trigger $${o.trigger_price})`}
                </td>
                <td className="muted">{STATUS_LABEL[o.status] ?? o.status}</td>
                <td className="row-actions">
                  <button className="small-button" onClick={() => void onCancel(o.id)}>
                    Cancel
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="panel-title">Your trades in {symbol}</h3>
      {trades.length === 0 ? (
        <p className="muted small-text">You haven't traded {symbol} yet.</p>
      ) : (
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Status</th>
              <th className="num">Shares</th>
              <th className="num">Entry</th>
              <th className="num">Exit</th>
              <th className="num">Net P&amp;L</th>
              <th className="num">R</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id}>
                <td>{t.status === "open" ? "Open" : "Closed"}</td>
                <td className="num">{t.entry_quantity.toLocaleString("en-AU")}</td>
                <td className="num">${t.average_entry}</td>
                <td className="num">{t.average_exit ? `$${t.average_exit}` : dash}</td>
                <td className={`num ${tone(t.status === "open" ? t.unrealised : t.net_pnl)}`}>{money(t.status === "open" ? t.unrealised : t.net_pnl, true)}</td>
                <td className="num">{t.r_multiple == null ? dash : `${t.r_multiple.toFixed(2)}R`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted tiny">Review these trades in Portfolio → Journal.</p>
    </div>
  );
}
