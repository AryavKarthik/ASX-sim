# ASX-sim

[![CI](https://github.com/AryavKarthik/ASX-sim/actions/workflows/ci.yml/badge.svg)](https://github.com/AryavKarthik/ASX-sim/actions/workflows/ci.yml)
![Python 3.12](https://img.shields.io/badge/python-3.12-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**A realistic ASX day-trading simulator on the live market, with an AI coach.**

Trade ASX shares **during today's trading session**, on free market data that runs about
20 minutes behind the real exchange. Prices stream in continuously, every time a new
(delayed) price is published, and your simulated orders fill against that live feed under
the same rules as the real market:
- the pre-open phase and the opening single price auction,
- ASX tick sizes and bid/ask spreads,
- liquidity limits and partial fills,
- brokerage and T+2 settlement,
- the closing single price auction.

Then you review every trade with a journal, performance analytics and a Claude-powered
coach that challenges your reasoning instead of handing out tips. A separate swing-practice
mode lets you trade through months of daily prices in an evening.

> **Status:** v1.0. Everything on the [roadmap](#roadmap) for the planned three-week build
> is done. It is a personal learning tool: simulated money only, and nothing here is
> financial advice.

![Home: the ASX 200, your account, today's movers and your watchlist with trend lines](docs/images/home.jpg)

| A stock's chart and order ticket | Portfolio: positions, P&L and allocation |
|---|---|
| ![A stock page's 1-minute chart with VWAP, and the order ticket](docs/images/stock.png) | ![Portfolio summary, positions table with Trade buttons, and allocation](docs/images/portfolio.png) |

*Screenshots use invented sample prices in demo mode (see [Market data and licensing](#market-data-and-licensing)).*

---

## How the 20-minute delay works

Real-time ASX data costs money. Free data (Yahoo Finance) is delayed by about 20 minutes but
still updates continuously. ASX-sim embraces that: **the simulator's market is the real ASX
running 20 minutes behind.**

- If you only watch prices inside ASX-sim, trading feels live. At 10:20am your time you see
  the 10:00 open, and every price change arrives as it is published.
- Your orders are matched against the prices as they arrive, in order, so you can never act
  on a price before the market "reached" it.
- Market phases (pre-open, opening auction, closing auction) follow the same delayed clock.
- The data layer is swappable. Plugging in a real-time feed later (for example Interactive
  Brokers) removes the delay without changing the rest of the app.

## Features

**A clear, page-based interface**, in the spirit of beginner-friendly broker redesigns:
- a sidebar with **Home**, **Watchlist**, **Portfolio**, **Coach**, **Practice** and **Replay**, a stock search in the top bar, and the market's phase, delayed clock and your equity always visible,
- **a page for every stock** (`#/stock/BHP`): price and change, its trends (today, 1 week to 3 years, 52-week range), key statistics, a large chart, the order ticket, company details and your activity in it,
- **Portfolio**: equity, total, unrealised and realised P&L, cash and buying power, a positions table with a Trade button on every row, orders, history, journal, performance and allocation,
- a **Trade** panel that slides in from any watchlist or portfolio row, and an info tip on every piece of jargon.

**Core: live day trading on delayed data**
- A streaming feed of delayed prices, updated on every new price (not once a minute),
  with a 15-second polling fallback if the stream drops.
- A live candlestick chart and quote that update tick by tick, plus a delayed-market clock and
  phase badge.
- **Realistic execution:**
  - market, limit, stop, stop-limit and trailing-stop orders; good-for-day or good-till-cancelled,
  - fills modelled from real volume: a one-tick spread, a cap on how much of each
    minute's volume you can take, partial fills, and a queue estimate for limit orders.
- **ASX market structure:** trading calendar and public holidays, pre-open, opening and
  closing single price auctions with the ASX's randomised timing, and trading halts
  (inferred from the feed, with a reopening auction).
- **Account mechanics:** cash vs settled cash (T+2), average cost, realised and unrealised
  P&L, brokerage on every order. Long only: no short selling or margin.
- **Charts:**
  - candlesticks and volume at 1, 5, 15 and 60 minutes (built from the session's 1-minute
    candles), plus daily, weekly and monthly with up to decades of history,
  - indicators you can switch on: EMA 9, SMA 20, VWAP, Bollinger Bands, and RSI and MACD in
    their own panels. Each has a plain-English explanation on hover,
  - long-term history stops before the session day, and weekly/monthly bars are built from
    daily bars after that cut-off, so a demo can't see how its own day ends,
  - **drawing tools:** horizontal lines for support and resistance (snapped to real ASX
    prices, labelled on the price axis), trend lines and rays. Drag to move, drag an end to
    adjust, Delete to remove. Lines are anchored to time and price, so they stay in place
    across zooming and every timeframe, and each stock keeps its own (saved in your browser).
- **Trade journal:**
  - fills are grouped into round-trip trades automatically,
  - write your plan (setup, reason, stop, target) on the order ticket and see the risk/reward
    before you buy,
  - review each trade (followed the plan?, what went well, what to improve, emotions, rating),
  - each trade's **R-multiple** (P&L in units of the risk you planned) is worked out for you.
- **Performance analytics** (the Performance view):
  - equity curve against the ASX 200 rescaled to your starting cash. The index never uses
    data past the market clock, so a demo can't leak the rest of the day,
  - net P&L and return vs the ASX 200, win rate, profit factor, payoff ratio, expectancy,
    average R, max drawdown, Sharpe ratio (once there are 5+ trading days), fees as a share of
    gross profit,
  - results by setup, by time of day and by stock, and a discipline check comparing trades
    where you followed your plan with trades where you didn't.
- **Company pages** (the Company view): what the business does, its sector and size;
  market cap, P/E, forward P/E, dividend yield and price to book, worked out from the price
  on screen so they move with it; revenue, profit, margins, debt and payout ratio; the
  52-week range and trailing returns. Every figure has a plain-English explanation on hover.
- **AI coach (Claude)** in the Coach view ([ADR 0010](docs/adr/0010-ai-coach.md)):
  - ask anything about trading, with replies streamed as they are written. The coach sees
    your account, positions, open orders, journal and statistics, and the stock you're
    watching,
  - a **Full review** button for a deeper review of your journal and statistics,
  - a coach, not a tipster: it explains, questions your plan and reviews your trades, and
    won't say what to buy or sell or predict prices,
  - it only sees the market up to the (delayed or replayed) market clock,
  - cheap by design: Claude Haiku for chat and Claude Sonnet for reviews, with a monthly
    budget the app enforces (default US$10). Needs your own API key in `.env`; without one
    the coach is simply switched off.

**Swing practice: months of daily bars in an evening** ([ADR 0011](docs/adr/0011-swing-practice-on-daily-bars.md))
- Pick a stock and a period (or take a surprise), then step forward one trading day, week
  or month at a time. You only ever see up to "today's" close.
- Market, limit and stop orders fill on the following days. A price that gaps past your
  stop fills at the open, as in real life.
- **Blind practice:** a mystery stock from a random date, with the name and dates hidden
  until the end, so you can't trade on what you remember.
- Your result is measured against simply buying and holding the same stock.
- The same drawing tools as the live chart, saved per session.
- The server never sends a bar beyond the current day; sessions are saved so you can pick
  one up later.

**Secondary: look back at past days**
- Replay a recorded past trading day minute by minute, to review what happened or practise
  outside market hours. It uses a replay clock and a time gate so it never shows the future.

## Architecture

```mermaid
flowchart LR
    UI["React + TypeScript UI<br/>chart · ticket · journal · performance · company · coach · swing"] <-->|REST + WebSocket| API[FastAPI]
    API --> Hub["Live hub<br/>one shared feed, delayed-market clock, halts"]
    Hub --> Feed["Delayed price stream<br/>Yahoo (swappable), polling fallback"]
    Hub --> Demo["Demo feed<br/>a recorded day played as live"]
    Hub --> Fill["Execution engine<br/>spread · liquidity · auctions · stops"]
    Fill --> Ledger["Account<br/>cash · positions · T+2 · brokerage"]
    Ledger --> Journal["Journal<br/>round-trip trades, plans, reviews"]
    Journal --> Analytics["Performance analytics<br/>vs ASX 200"]
    Hub -->|"snapshot as of the market clock"| Coach["AI coach<br/>budget ledger"] --> Claude[(Claude API)]
    API --> Swing["Swing practice<br/>daily bars, next-day fills"]
    API --> History["History and company data<br/>cut off before the session day"]
    API -.-> Replay["Past-day replay<br/>(secondary)"]
    Demo & Replay --> Store["Recorded 1-minute bars<br/>(private, or invented samples)"]
```

One rule runs through the whole design: **nothing may see past the market clock.** Fills,
the ASX 200 benchmark, long-term charts, company ratios, the coach's snapshot and swing
practice are each cut off at "now", whether that is the delayed live market or a replayed
day, and the cut-offs are covered by tests.

Key design decisions are recorded as [Architecture Decision Records](docs/adr/):

| ADR | Decision |
|---|---|
| [0004](docs/adr/0004-data-licensing.md) | Market data is never committed or published |
| [0007](docs/adr/0007-live-delayed-trading-is-the-core.md) | Live trading on delayed data is the core |
| [0008](docs/adr/0008-execution-model.md) | How simulated orders fill |
| [0009](docs/adr/0009-inferred-trading-halts.md) | Trading halts are inferred from the feed |
| [0010](docs/adr/0010-ai-coach.md) | The AI coach teaches and reviews; it never tips |
| [0011](docs/adr/0011-swing-practice-on-daily-bars.md) | Swing practice on daily bars |

## Market data and licensing

ASX-sim's **code** is open source (MIT). **Market data is never committed or published.**
Prices come from Yahoo Finance via `yfinance` for personal, non-commercial use: a live
stream of delayed prices for trading, plus a scheduled job that records each day's 1-minute
bars into a *private* repository for charts and past-day review. See
[ADR 0004](docs/adr/0004-data-licensing.md).

Because real prices can't be published, the repository includes a generator for **invented
sample prices** (`python -m asxsim.data.sample`). The screenshots above use it, and so can
you, to try the demo without downloading anything.

## Getting started

Requires [uv](https://docs.astral.sh/uv/) (it installs the right Python version
automatically) and [Node.js](https://nodejs.org/) 20+.

**1. Get some data for the demo.** Either make up three sample days (instant, no network):

```bash
git clone https://github.com/AryavKarthik/ASX-sim.git
cd ASX-sim/backend
uv sync
uv run python -m asxsim.data.sample --out ../../ASX-sim-data/bars_1m
```

or record the last week of real 1-minute bars for a few stocks, for your own use:

```bash
uv run python -m asxsim.data.recorder --out ../../ASX-sim-data/bars_1m --symbols BHP CBA CSL
```

Live trading, long-term charts, company pages and swing practice fetch from Yahoo as you
use them and need no recorded data.

By default the app reads data from an `ASX-sim-data` folder next to the repo. Set
`ASXSIM_DATA_DIR` to use somewhere else.

**2. Run the app.** Start the backend and the frontend in two terminals:

```bash
# terminal 1, from backend/
uv run uvicorn asxsim.api.app:app --reload --port 8000

# terminal 2, from frontend/
npm install
npm run dev
```

Then open <http://localhost:5173>. On Windows, `scripts\dev.ps1` does all of this in one
step. The API's interactive docs are at <http://127.0.0.1:8000/docs>.

The app opens on the **Live market (delayed)** tab. During ASX trading hours (about 10:20am
to 4:30pm Sydney time with the delay) your watchlist streams live. Outside those hours it
shows the last session, and **Try the demo** plays a recorded day as if it were live.

**3. Switch on the AI coach (optional).** Create an API key at
[console.anthropic.com](https://console.anthropic.com/) and set a monthly spend limit
there. Copy `.env.example` to `.env`, paste the key after `ANTHROPIC_API_KEY=`, and restart
the backend. `.env` is gitignored. The app stops calling the API at
`COACH_MONTHLY_BUDGET_USD` (default US$10); chat costs a fraction of a cent per question.
To see the Coach screen without a key, set `COACH_PRACTICE=1` for a canned reply.

Your simulated account, journal, coach spend and swing sessions are saved in `~/.asxsim`,
outside the repository.

## Development

| Check | Backend (from `backend/`) | Frontend (from `frontend/`) |
|---|---|---|
| Lint and format | `uv run ruff check .` and `uv run ruff format .` | |
| Types | `uv run mypy src tests` (strict) | `npm run typecheck` |
| Tests | `uv run pytest --cov=asxsim` | `npm test` |
| Build | | `npm run build` |

CI runs all of these, plus a secret scan, on every pull request. The backend has over 300
tests at about 90% coverage; none of them touch the network or need an API key (Yahoo and Claude sit behind small
interfaces with stand-ins). The frontend tests cover the indicator, ratio and
drawing-placement maths.

Pre-commit hooks run these checks, plus a secret scanner, on every commit:
`uv tool install pre-commit && pre-commit install`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/).

## Roadmap

- [x] **Day 1:** repo, CI, daily 1-minute data recorder
- [x] **Day 2:** ASX market rules: tick sizes, trading calendar, trading phases and auctions
- [x] **Day 3:** first clickable app (currently a past-day replay viewer): chart, clock, time gate, WebSocket stream
- [x] **Live delayed market (top priority):** watchlist of up to 20 stocks streaming Yahoo's delayed prices as they update (with a polling fallback), live candles and quotes that tick with every price, measured delay, delayed-market clock and phases, and a demo mode for outside market hours. *Verified live on 16 Nov 2026: updates about every second for busy stocks, a 20.0-minute delay, real bid/ask included (see ADR 0007).*
- [x] **Trading on the live market:** order ticket (market and limit), fills at the delayed prices shown with spread, liquidity caps, partial fills and opening/closing auctions, ASX rules ($500 first parcel, price steps, no shorting), brokerage, cash, buying power, holdings, P&L, positions/orders/fills, saved account → `v0.1`
- [x] **Week 2, part 1:** stop, stop-limit and trailing-stop orders (broker-side conditional orders), good-till-cancelled orders, T+2 settlement
- [x] **Week 2, part 2:** trade journal (round-trip trades, plan on the ticket, review, R-multiple) and a price refresh setting (Live / 5s / 30s)
- [x] **Week 2, part 3:** performance analytics (equity vs ASX 200, trade statistics, drawdown, Sharpe, breakdowns, discipline)
- [x] **Week 2, part 4:** chart timeframes (1m to monthly) and indicators (EMA, SMA, VWAP, Bollinger, RSI, MACD)
- [x] **Week 2, part 5:** trading halts, inferred from the feed, with a reopening auction ([ADR 0009](docs/adr/0009-inferred-trading-halts.md))
- [x] **Week 3, part 1:** AI coach (chat and full reviews, coach-not-tipster, monthly budget)
- [x] **Week 3, part 2:** company pages (profile, fundamentals, valuation at the live price, 52-week range, returns)
- [x] **Week 3, part 3:** swing practice on daily bars (next-day fills, gaps, blind mode, vs buy and hold)
- [x] **Week 3, part 4:** portfolio polish: sample-data generator, screenshots, architecture and docs → `v1.0`
- [x] **After v1.0:** drawing tools on charts (horizontal lines, trend lines, rays)
- [x] **After v1.0:** redesigned interface: sidebar pages, a page per stock with its trends, a Portfolio page, a slide-in trade panel, full-width layout
- [ ] **Secondary:** trading inside past-day replay
- [ ] **Later:** real-time data provider, short selling and margin, dividends and franking credits, ASX options, a refreshed ASX 200 list (a few codes have changed since it was compiled)

## License

[MIT](LICENSE) © 2026 Aryav Karthik. Chart rendering uses
[TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/) (Apache-2.0).
