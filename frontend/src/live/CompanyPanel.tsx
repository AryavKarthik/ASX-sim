import { useEffect, useState } from "react";

import { formatPrice } from "../format";
import { type Company, compact, rangePosition, ratios } from "./company";

type Props = {
  symbol: string;
  /** The session being shown: history and statistics stop before it. */
  sessionDay: string | null;
  /** The price on screen (delayed, or the demo's): valuation ratios are worked out from it. */
  price: number | null;
  demo: boolean;
};

function Stat({ label, value, help, sub }: { label: string; value: string; help: string; sub?: string }) {
  return (
    <div className="tile" title={help}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  );
}

const pct = (n: number | null, digits = 1) => (n == null ? "—" : `${n.toFixed(digits)}%`);
const times = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}×`);

export type CompanyState = { data: Company | null; error: string | null };

/** Company profile, fundamentals and price statistics, up to the session day. */
export function useCompany(symbol: string | null, sessionDay: string | null): CompanyState {
  const [state, setState] = useState<CompanyState>({ data: null, error: null });
  useEffect(() => {
    if (!symbol) return;
    let current = true;
    setState({ data: null, error: null });
    const params = new URLSearchParams({ symbol });
    if (sessionDay) params.set("until", sessionDay);
    fetch(`/api/live/company?${params}`)
      .then(async (response) => {
        const body = (await response.json()) as Company & { detail?: string };
        if (!response.ok) throw new Error(body.detail ?? response.statusText);
        if (current) setState({ data: body, error: null });
      })
      .catch((e: Error) => current && setState({ data: null, error: e.message }));
    return () => {
      current = false;
    };
  }, [symbol, sessionDay]);
  return state;
}

/** What the company is, what it earns, and how its price has moved. */
export function CompanyPanel({ symbol, sessionDay, price, demo, company, showPrice = true }: Props & { company?: CompanyState; showPrice?: boolean }) {
  const own = useCompany(company ? null : symbol, sessionDay);
  const { data, error } = company ?? own;
  const [expanded, setExpanded] = useState(false);

  useEffect(() => setExpanded(false), [symbol]);

  if (error) return <p className="error">Couldn't load company information: {error}</p>;
  if (!data) return <p className="muted">Loading {symbol}…</p>;

  const f = data.fundamentals;
  const r = ratios(f, price);
  const p = data.price;
  const position = rangePosition(price, p.week52_low, p.week52_high);
  const money = f.reporting_currency ? `${f.reporting_currency} ` : "";
  const isCompany = data.kind === "equity";
  const summary = data.summary ?? "";
  const long = summary.length > 420;

  return (
    <div className="company">
      <header className="company-head">
        <div>
          <h3>
            {data.name} <span className="muted">ASX: {data.code}</span>
          </h3>
          <p className="muted small-text">
            {[data.sector, data.industry, data.headquarters, data.employees ? `${compact(data.employees)} employees` : null]
              .filter(Boolean)
              .join(" · ") || (data.kind === "index" ? "Market index" : data.kind.toUpperCase())}
          </p>
        </div>
        <div className="company-links">
          {data.website && (
            <a href={data.website} target="_blank" rel="noreferrer">
              Website
            </a>
          )}
          {data.kind !== "index" && (
            <a href={`https://www.asx.com.au/markets/company/${data.code}`} target="_blank" rel="noreferrer" title="Official ASX page: announcements, dividends and reports">
              ASX announcements
            </a>
          )}
        </div>
      </header>

      {summary && (
        <p className="company-summary">
          {long && !expanded ? `${summary.slice(0, 420).trimEnd()}… ` : `${summary} `}
          {long && (
            <button className="link" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : "Read more"}
            </button>
          )}
        </p>
      )}

      {isCompany && (
        <>
          <h4>Valuation at {price != null ? formatPrice(price) : "the current price"}</h4>
          <div className="tiles">
            <Stat label="Market cap" value={r.marketCap == null ? "—" : `$${compact(r.marketCap)}`} help="What the whole company is worth at this share price: price × shares on issue." sub={f.shares_outstanding ? `${compact(f.shares_outstanding)} shares` : undefined} />
            <Stat label="P/E ratio" value={times(r.pe)} help="Price ÷ earnings per share over the last 12 months: how many years of current profit you pay for. High can mean expected growth, or an expensive share. Blank if the company made a loss." sub={f.eps != null ? `EPS $${f.eps.toFixed(2)}` : undefined} />
            <Stat label="Forward P/E" value={times(r.forwardPe)} help="Price ÷ analysts' forecast earnings per share for next year. Lower than the P/E means profits are expected to grow." />
            <Stat label="Dividend yield" value={pct(r.dividendYieldPct, 2)} help="Dividends paid per share over the last 12 months ÷ price. Before franking credits, which can add to the after-tax return for Australian investors." sub={f.dividend_per_share != null ? `$${f.dividend_per_share.toFixed(2)} a share` : undefined} />
            <Stat label="Price to book" value={times(r.priceToBook)} help="Price ÷ net assets per share. Around 1 means the price is close to what the accounts say the assets are worth." />
            <Stat label="Beta" value={f.beta == null ? "—" : f.beta.toFixed(2)} help="How much the share has tended to move against the market. 1 moves with it, above 1 swings more, below 1 less." />
          </div>

          <h4>The business</h4>
          <div className="tiles">
            <Stat label="Revenue" value={f.revenue == null ? "—" : `${money}${compact(f.revenue)}`} help="Sales over the last 12 months, in the currency the company reports in." />
            <Stat label="Net profit" value={f.net_income == null ? "—" : `${money}${compact(f.net_income)}`} help="Profit after all costs and tax over the last 12 months." />
            <Stat label="Profit margin" value={pct(f.profit_margin == null ? null : 100 * f.profit_margin)} help="Net profit ÷ revenue: how many cents of each dollar of sales end up as profit." />
            <Stat label="Return on equity" value={pct(f.return_on_equity == null ? null : 100 * f.return_on_equity)} help="Net profit ÷ shareholders' funds: how well the company turns owners' money into profit." />
            <Stat label="Debt to equity" value={pct(f.debt_to_equity, 0)} help="Borrowings as a percentage of shareholders' funds. Higher means more debt, which adds risk when profits fall." />
            <Stat label="Payout ratio" value={pct(f.payout_ratio == null ? null : 100 * f.payout_ratio, 0)} help="Share of profit paid out as dividends. Near or above 100% is hard to sustain." sub={f.ex_dividend_date ? `last ex-dividend ${f.ex_dividend_date}` : undefined} />
          </div>
        </>
      )}

      {showPrice && (
      <>
      <h4>Price history {p.as_of && <span className="muted small-text">to the close on {p.as_of}</span>}</h4>
      {p.week52_low != null && p.week52_high != null && (
        <div className="range" title="Where the current price sits between the lowest and highest prices of the past 52 weeks">
          <span>{formatPrice(p.week52_low)}</span>
          <div className="range-bar">{position != null && <i style={{ left: `${position}%` }} />}</div>
          <span>{formatPrice(p.week52_high)}</span>
          <span className="muted small-text">52-week range{position != null ? ` · now at ${position.toFixed(0)}% of it` : ""}</span>
        </div>
      )}
      <table className="returns">
        <thead>
          <tr>
            {p.returns.map((x) => (
              <th key={x.label}>{x.label}</th>
            ))}
            <th>Avg daily volume</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            {p.returns.map((x) => (
              <td key={x.label} className={x.pct == null ? "muted" : x.pct >= 0 ? "up" : "down"}>
                {x.pct == null ? "—" : `${x.pct >= 0 ? "+" : "−"}${Math.abs(x.pct).toFixed(1)}%`}
              </td>
            ))}
            <td>{compact(p.average_volume_30d)}</td>
          </tr>
        </tbody>
      </table>
      </>
      )}

      <p className="muted tiny">
        Company figures are from Yahoo Finance and are the latest reported, so they can lag announcements. Price changes
        exclude dividends. Use the D, W and M chart buttons for the long-term chart.
        {demo && " In a demo, the price history stops before the demo day, but company figures are today's latest."}
      </p>
    </div>
  );
}
