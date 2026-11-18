import type { Bar } from "../api";
import { Label, compactNumber } from "../app/ui";
import { formatPrice } from "../format";
import { estimatedTouch } from "../live/ticks";
import type { Quote, TradePrint } from "../live/types";

/**
 * The bid and ask to show. Yahoo only sends them now and then, so the last ones seen can be
 * missing or stale (no longer either side of the price). Then show what the simulator fills
 * against instead: one price step either side of the last trade, marked as an estimate.
 */
export function touchFor(quote: Quote | undefined, price: number | null): { bid: number | null; ask: number | null; estimated: boolean } {
  if (price == null) return { bid: null, ask: null, estimated: false };
  const bid = quote?.bid ?? null;
  const ask = quote?.ask ?? null;
  if (bid != null && ask != null && bid < ask && bid <= price && price <= ask) return { bid, ask, estimated: false };
  const [b, a] = estimatedTouch(price, null, null);
  return { bid: b, ask: a, estimated: true };
}

function sydneyClock(epoch: number): string {
  // Candle and quote times are Sydney wall-clock epochs, so read them as UTC.
  return new Date(epoch * 1000).toISOString().slice(11, 19);
}

/** Session figures from the day's 1-minute candles. */
export function sessionFigures(bars: Bar[]): { volume: number | null; turnover: number | null; vwap: number | null } {
  if (bars.length === 0) return { volume: null, turnover: null, vwap: null };
  let volume = 0;
  let turnover = 0;
  let weighted = 0;
  for (const b of bars) {
    volume += b.volume;
    turnover += b.close * b.volume;
    weighted += ((b.high + b.low + b.close) / 3) * b.volume;
  }
  return { volume, turnover, vwap: volume ? weighted / volume : null };
}

/** Bid, ask, spread and session figures, then the course of sales: the latest trades. */
export function MarketData({ quote, bars, prints, price }: { quote: Quote | undefined; bars: Bar[]; prints: TradePrint[]; price: number | null }) {
  const touch = touchFor(quote, price);
  const { bid, ask } = touch;
  const spread = bid != null && ask != null && ask > bid ? ask - bid : null;
  const mid = spread != null && bid != null ? bid + spread / 2 : null;
  const session = sessionFigures(bars);

  return (
    <div className="panel market-data">
      <h3 className="panel-title">Market data</h3>
      <div className="bid-ask">
        <div className="bid">
          <Label tip="The highest price a buyer is currently offering. A market sell order fills around here.">Bid{touch.estimated ? " (est.)" : ""}</Label>
          <strong>{bid != null ? formatPrice(bid) : "—"}</strong>
        </div>
        <div className="spread">
          <Label tip="The gap between the best bid and the best ask: a cost of trading in and out straight away.">Spread</Label>
          <strong>
            {spread != null ? `${(spread * 100).toFixed(spread < 0.01 ? 1 : 0)}c` : "—"}
            {spread != null && mid ? <span className="muted"> ({((100 * spread) / mid).toFixed(2)}%)</span> : null}
          </strong>
        </div>
        <div className="ask">
          <Label tip="The lowest price a seller is currently asking. A market buy order fills around here.">Ask{touch.estimated ? " (est.)" : ""}</Label>
          <strong>{ask != null ? formatPrice(ask) : "—"}</strong>
        </div>
      </div>
      <dl className="stat-rows">
        <div>
          <dt>
            <Label tip="Volume-weighted average price today: the average price everyone has paid. Day traders watch whether the price is above or below it.">VWAP</Label>
          </dt>
          <dd>{session.vwap != null ? formatPrice(session.vwap) : "—"}</dd>
        </div>
        <div>
          <dt>
            <Label tip="The total dollar value of shares traded today.">Turnover</Label>
          </dt>
          <dd>{session.turnover != null ? `$${compactNumber(session.turnover)}` : "—"}</dd>
        </div>
        <div>
          <dt>
            <Label tip="Shares traded today.">Volume</Label>
          </dt>
          <dd>{compactNumber(quote?.day_volume ?? session.volume)}</dd>
        </div>
      </dl>

      <h3 className="panel-title course-title">
        <Label tip="Course of sales: each trade as it is reported, newest first, with its price and size. Green traded higher than the trade before, red lower.">
          Course of sales
        </Label>
      </h3>
      {prints.length === 0 ? (
        <p className="muted small-text">Trades appear here as they happen (from when you opened this page).</p>
      ) : (
        <div className="course-of-sales">
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Time</th>
                <th className="num">Price</th>
                <th className="num">Shares</th>
              </tr>
            </thead>
            <tbody>
              {prints.slice(0, 25).map((p, i) => {
                const before = prints[i + 1]?.price;
                const move = before == null ? "" : p.price > before ? "up" : p.price < before ? "down" : "";
                return (
                  <tr key={`${p.time}-${i}`}>
                    <td className="muted">{sydneyClock(p.time)}</td>
                    <td className={`num ${move}`}>{formatPrice(p.price)}</td>
                    <td className="num">{p.volume.toLocaleString("en-AU")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted tiny">
        {touch.estimated
          ? "Yahoo sends bid and ask only occasionally, so these are estimated: one price step either side of the last trade, which is what the simulator fills against. "
          : ""}
        Market depth (the full queue of bids and offers) isn't available on free data.
      </p>
    </div>
  );
}
