import { type FormEvent, useEffect, useMemo, useState } from "react";

import { type Bar, fetchHistory } from "../api";
import { priceOf, useMarket } from "../app/market";
import { go, plannerPath, stockPath } from "../app/router";
import { Change, FlashPrice, Icon, Label, money, pct } from "../app/ui";
import { formatDay, formatPrice } from "../format";
import { aggregate, dailyCandle, withToday } from "../live/indicators";
import { isValidPrice, priceDecimals, tickSize } from "../live/ticks";
import { LEVEL_STYLE, type LevelKey, type Levels, PlanChart } from "../planner/PlanChart";
import { type ChecklistItem, type PlanFields, type SavedPlan, deletePlan, listPlans, savePlan } from "../planner/plansApi";
import {
  DEFAULT_BROKERAGE,
  MIN_PARCEL,
  analyse,
  defaultLevels,
  outcome,
  problems as planProblems,
  rLevels,
  riskBudget,
  sharesForRisk,
} from "../planner/risk";

type Draft = {
  id: string | null; // the saved plan this came from, if any
  symbol: string;
  title: string;
  setup: string;
  entry: string;
  stop: string;
  target: string;
  riskMode: "percent" | "dollars";
  riskValue: string;
  shares: string; // "" = sized from the risk
  notes: string;
  checklist: ChecklistItem[];
};

const DRAFTS_KEY = "asxsim.planner.drafts.v1";
const LAST_KEY = "asxsim.planner.last";
const TIMEFRAMES = [
  { key: "1m", label: "1m", minutes: 1 },
  { key: "5m", label: "5m", minutes: 5 },
  { key: "15m", label: "15m", minutes: 15 },
  { key: "1d", label: "Daily", minutes: null },
] as const;
type Timeframe = (typeof TIMEFRAMES)[number]["key"];

const CHECKLIST = [
  "The trend on the daily chart agrees with this trade",
  "My stop is below a real support level, not just a round number",
  "The reward is at least twice the risk",
  "My position size comes from my risk, not a hunch",
  "No results or big announcements are due today",
];

function readDrafts(): Record<string, Draft> {
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Draft>) : {};
  } catch {
    return {};
  }
}

function remember(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the draft just won't survive leaving the page.
  }
}

function lastSymbol(): string | null {
  try {
    return window.localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

function blankDraft(symbol: string): Draft {
  return {
    id: null,
    symbol,
    title: "",
    setup: "",
    entry: "",
    stop: "",
    target: "",
    riskMode: "percent",
    riskValue: "1",
    shares: "",
    notes: "",
    checklist: CHECKLIST.map((text) => ({ text, done: false })),
  };
}

function fromSaved(p: SavedPlan): Draft {
  return {
    id: p.id,
    symbol: p.symbol,
    title: p.title,
    setup: p.setup ?? "",
    entry: p.entry,
    stop: p.stop ?? "",
    target: p.target ?? "",
    riskMode: p.risk_mode,
    riskValue: p.risk_value ?? "",
    shares: p.shares == null ? "" : String(p.shares),
    notes: p.notes,
    checklist: p.checklist,
  };
}

/** Positive number from a text field, or null. */
function num(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const priceText = (p: number) => p.toFixed(priceDecimals(p));

/** Work out a trade's risk and reward before placing it: chart, sizing, notes and saved plans. */
export function PlannerPage({ symbol: routeSymbol }: { symbol?: string }) {
  const market = useMarket();
  const { feed, names, defaults, setFocus, lastViewed } = market;
  const tradeable = useMemo(() => defaults.universe.filter((u) => !/\bindex\b/i.test(u.name)), [defaults.universe]);
  const canPlan = (code: string | null | undefined): code is string => !!code && tradeable.some((u) => u.code === code);
  const symbol = canPlan(routeSymbol) ? routeSymbol : canPlan(lastSymbol()) ? lastSymbol()! : canPlan(lastViewed) ? lastViewed : (tradeable[0]?.code ?? "BHP");
  const unknown = routeSymbol != null && !canPlan(routeSymbol);

  const [drafts, setDrafts] = useState<Record<string, Draft>>(readDrafts);
  const draft = drafts[symbol] ?? blankDraft(symbol);
  const [whatIf, setWhatIf] = useState<number | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("5m");
  const [history, setHistory] = useState<{ symbol: string; bars: Bar[] } | null>(null);
  const [saved, setSaved] = useState<SavedPlan[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newItem, setNewItem] = useState("");
  const [pick, setPick] = useState("");

  // Stream this stock while planning it.
  useEffect(() => {
    setFocus(symbol);
    remember(LAST_KEY, symbol);
    setWhatIf(null);
    setStatus(null);
    return () => setFocus(null);
  }, [symbol, setFocus]);

  useEffect(() => remember(DRAFTS_KEY, JSON.stringify(drafts)), [drafts]);

  useEffect(() => {
    listPlans()
      .then(setSaved)
      .catch((e: Error) => setListError(e.message));
  }, []);

  function update(patch: Partial<Draft>) {
    setDrafts((all) => ({ ...all, [symbol]: { ...(all[symbol] ?? blankDraft(symbol)), ...patch } }));
    setStatus(null);
  }

  // ----- prices and chart data -----
  const quote = feed.quotes[symbol];
  const raw = feed.candlesFor(symbol);
  const shown = priceOf(quote, raw);
  const live = shown.price;
  const rawKey = `${raw.length}:${raw[raw.length - 1]?.time ?? ""}:${raw[raw.length - 1]?.close ?? ""}`;
  const minutes = TIMEFRAMES.find((t) => t.key === timeframe)?.minutes ?? null;
  const intradayEmpty = raw.length === 0;
  const daily = minutes == null || intradayEmpty;

  useEffect(() => {
    if (!daily || history?.symbol === symbol) return;
    let current = true;
    fetchHistory(symbol, "1d", feed.sessionDay)
      .then((bars) => current && setHistory({ symbol, bars }))
      .catch(() => current && setHistory({ symbol, bars: [] }));
    return () => {
      current = false;
    };
  }, [daily, symbol, feed.sessionDay, history?.symbol]);

  const bars = useMemo(() => {
    if (!daily && minutes != null) return aggregate(raw, minutes);
    const past = history?.symbol === symbol ? history.bars : [];
    return withToday(past, dailyCandle(raw), "1d");
    // rawKey stands in for the candles, which arrive by mutating one array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawKey, daily, minutes, history, symbol]);

  // A new plan starts at the live price: 2% risk for 4% reward.
  useEffect(() => {
    if (draft.entry !== "" || draft.stop !== "" || draft.target !== "" || draft.id || live == null) return;
    const l = defaultLevels(live);
    update({ entry: priceText(l.entry), stop: priceText(l.stop), target: priceText(l.target) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, live == null, draft.entry]);

  // ----- the maths -----
  const entry = num(draft.entry);
  const stop = num(draft.stop);
  const target = num(draft.target);
  const brokerage = feed.account?.brokerage ?? DEFAULT_BROKERAGE;
  const equity = Number(feed.account?.equity ?? 0);
  const cash = Number(feed.account?.buying_power ?? 0);
  const budget = riskBudget(draft.riskMode, Number(draft.riskValue), equity);
  const sized = entry != null && stop != null ? sharesForRisk(entry, stop, budget, brokerage, feed.account ? cash : undefined) : { shares: 0, limitedBy: null };
  const manual = draft.shares !== "";
  const shares = manual ? Math.max(0, Math.floor(Number(draft.shares) || 0)) : sized.shares;
  const a = analyse(entry, stop, target, shares, brokerage);
  const issues = planProblems(entry, stop, target);
  for (const [label, p] of [["entry price", entry], ["stop-loss", stop], ["target", target]] as const) {
    if (p != null && !isValidPrice(p)) issues.push(`The ${label} $${p} isn't a valid ASX price step (${+(tickSize(p) * 100).toFixed(1)}c at this price).`);
  }
  const held = feed.account?.positions.some((p) => p.symbol === symbol) ?? false;
  const warnings: string[] = [];
  if (a.loss != null && equity > 0 && a.loss / equity > 0.02) warnings.push(`You'd lose ${pct((a.loss / equity) * 100, false, 1)} of your account at the stop. Many traders cap one trade's risk at 1–2%.`);
  if (a.ratio != null && a.ratio < 1) warnings.push("The target is closer than the stop, so you'd need to win most of these trades just to break even.");
  if (shares > 0 && entry != null && !held && shares * entry < MIN_PARCEL) warnings.push(`A first purchase must be at least ${money(MIN_PARCEL)} on the ASX, so the broker would reject this size.`);
  if (!manual && sized.limitedBy === "cash" && shares > 0) warnings.push("Sized down to what your buying power can afford, so you're risking less than you set.");
  if (shares === 0 && entry != null && stop != null && stop < entry && budget > 0) warnings.push("Your risk budget doesn't cover even one share plus brokerage. Risk more, or move the stop closer.");
  const winRateNeeded = a.ratio != null ? 100 / (1 + a.ratio) : null;

  const levels: Levels = { entry, stop, target, whatIf };
  function moveLevel(key: LevelKey, price: number) {
    if (key === "whatIf") setWhatIf(price);
    else update({ [key]: priceText(price) } as Partial<Draft>);
  }

  // The "what if" line starts at the entry.
  useEffect(() => {
    if (whatIf == null && entry != null) setWhatIf(entry);
  }, [whatIf, entry]);

  const scenarios = useMemo(() => {
    if (entry == null || shares <= 0) return [];
    const rows: { label: string; price: number; key: string }[] = [];
    if (stop != null && stop < entry) {
      rows.push({ label: "Stop-loss", price: stop, key: "stop" });
      for (const l of rLevels(entry, stop, [1, 2, 3])) rows.push({ label: `+${l.r}R`, price: l.price, key: `r${l.r}` });
    }
    if (a.breakeven != null) rows.push({ label: "Breakeven", price: a.breakeven, key: "be" });
    rows.push({ label: "Entry", price: entry, key: "entry" });
    if (target != null && target > entry) rows.push({ label: "Target", price: target, key: "target" });
    return rows.sort((x, y) => y.price - x.price);
  }, [entry, stop, target, shares, a.breakeven]);

  const whatIfPnl = whatIf != null && entry != null && shares > 0 ? outcome(entry, whatIf, shares, brokerage) : null;
  const sliderMin = entry != null ? Math.min(stop ?? entry, entry) * 0.97 : 0;
  const sliderMax = entry != null ? Math.max(target ?? entry, entry) * 1.03 : 1;

  // ----- notebook actions -----
  function fields(): PlanFields {
    return {
      symbol,
      title: draft.title,
      setup: draft.setup || null,
      entry: draft.entry,
      stop: draft.stop || null,
      target: draft.target || null,
      risk_mode: draft.riskMode,
      risk_value: draft.riskValue || null,
      shares: manual ? shares : null,
      notes: draft.notes,
      checklist: draft.checklist,
    };
  }

  async function save(asNew: boolean) {
    try {
      const plan = await savePlan(fields(), asNew ? null : draft.id);
      update({ id: plan.id });
      setSaved((list) => [plan, ...list.filter((p) => p.id !== plan.id)]);
      setStatus({ ok: true, text: asNew || !draft.id ? "Plan saved to your notebook." : "Plan updated." });
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message });
    }
  }

  function startNew() {
    setDrafts((all) => ({ ...all, [symbol]: blankDraft(symbol) }));
    setWhatIf(null);
    setStatus(null);
  }

  function open(plan: SavedPlan) {
    setDrafts((all) => ({ ...all, [plan.symbol]: fromSaved(plan) }));
    setWhatIf(null);
    go(plannerPath(plan.symbol));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(id: string) {
    try {
      await deletePlan(id);
      setSaved((list) => list.filter((p) => p.id !== id));
      if (draft.id === id) update({ id: null });
    } catch (e) {
      setListError((e as Error).message);
    }
    setConfirmDelete(null);
  }

  function placeTrade() {
    if (entry == null || shares <= 0) return;
    market.trade(symbol, "buy", {
      quantity: shares,
      kind: "limit",
      limit: draft.entry,
      plan: {
        setup: draft.setup || undefined,
        thesis: [draft.title, draft.notes].filter(Boolean).join(" · ") || undefined,
        planned_stop: draft.stop || undefined,
        planned_target: draft.target || undefined,
      },
    });
  }

  function choose(event: FormEvent) {
    event.preventDefault();
    const code = pick.trim().toUpperCase();
    if (canPlan(code)) {
      go(plannerPath(code));
      setPick("");
    }
  }

  const ready = issues.length === 0 && entry != null && shares > 0;
  const doneCount = draft.checklist.filter((c) => c.done).length;

  return (
    <div className="planner-page">
      <header className="page-head planner-head">
        <div>
          <h1>Risk planner</h1>
          <p className="muted">Set your entry, stop-loss and target, and see what the trade can make or lose before you place it.</p>
        </div>
        <form className="add-symbol" onSubmit={choose}>
          <input list="planner-universe" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="Plan another stock, e.g. CBA" aria-label="Choose a stock to plan" />
          <datalist id="planner-universe">
            {tradeable.map((u) => (
              <option key={u.code} value={u.code}>
                {u.name}
              </option>
            ))}
          </datalist>
          <button className="primary" type="submit" disabled={!canPlan(pick.trim().toUpperCase())}>
            Plan
          </button>
        </form>
      </header>
      {unknown && <p className="error small-text">{routeSymbol} isn't a stock you can trade here, so this shows {symbol} instead.</p>}

      <div className="planner-grid">
        <section className="panel planner-chart-panel">
          <div className="planner-chart-head">
            <div>
              <a className="planner-symbol" href={`#${stockPath(symbol)}`}>
                {symbol}
              </a>
              <span className="muted"> {names[symbol]}</span>
            </div>
            <div className="planner-live">
              <FlashPrice value={live} className="planner-price" />
              <Change change={shown.change} percent={shown.pct} price={live} />
            </div>
          </div>
          <PlanChart
            bars={bars}
            intraday={!daily}
            levels={levels}
            onChange={moveLevel}
            toolbar={
              <div className="tf" role="group" aria-label="Timeframe">
                {TIMEFRAMES.map((t) => (
                  <button key={t.key} className={timeframe === t.key ? "active" : ""} onClick={() => setTimeframe(t.key)} disabled={t.minutes != null && intradayEmpty}>
                    {t.label}
                  </button>
                ))}
              </div>
            }
            hint={<p className="muted small-text drag-hint">Drag the coloured lines up or down to move them. Hold Ctrl and scroll to zoom.</p>}
          />
          <div className="plan-legend">
            {(Object.keys(LEVEL_STYLE) as LevelKey[]).map((k) => (
              <span key={k}>
                <i style={{ background: LEVEL_STYLE[k].color }} /> {LEVEL_STYLE[k].title}
              </span>
            ))}
            <span>
              <i className="zone up" /> Profit zone
            </span>
            <span>
              <i className="zone down" /> Loss zone
            </span>
            {feed.sessionDay && <span className="muted">· {daily ? "Daily candles" : `Session of ${formatDay(feed.sessionDay)}`}</span>}
          </div>
        </section>

        <aside className="planner-side">
          <section className="panel plan-inputs">
            <h3 className="panel-title">Your plan</h3>
            <PriceField level="entry" label="Entry (buy) price" tip="The price you plan to buy at. The order is placed as a limit order at this price." value={draft.entry} onChange={(v) => update({ entry: v })} />
            {live != null && (
              <button className="link-button" onClick={() => update({ entry: priceText(live) })}>
                Use the live price ({formatPrice(live)})
              </button>
            )}
            <PriceField level="stop" label="Stop-loss" tip="Where you'll sell if the trade goes wrong. It's the price that proves your idea wrong, and it sets your risk." value={draft.stop} onChange={(v) => update({ stop: v })} />
            <PriceField level="target" label="Target" tip="Where you plan to take profit." value={draft.target} onChange={(v) => update({ target: v })} />

            <div className="risk-row">
              <Label tip="How much you're willing to lose if the stop is hit. The planner works out the number of shares from this.">Risk per trade</Label>
              <div className="input-row">
                <input inputMode="decimal" value={draft.riskValue} onChange={(e) => update({ riskValue: e.target.value.replace(/[^\d.]/g, "") })} aria-label="Amount to risk" />
                <div className="segmented small unit" role="group" aria-label="Risk unit">
                  <button type="button" className={draft.riskMode === "percent" ? "active" : ""} onClick={() => update({ riskMode: "percent" })}>
                    %
                  </button>
                  <button type="button" className={draft.riskMode === "dollars" ? "active" : ""} onClick={() => update({ riskMode: "dollars" })}>
                    $
                  </button>
                </div>
              </div>
              {equity > 0 && (
                <span className="hint muted">
                  {draft.riskMode === "percent" ? `= ${money(budget)} of your ${money(equity)} account` : `= ${pct((budget / equity) * 100, false, 2)} of your ${money(equity)} account`}
                </span>
              )}
            </div>

            <div className="risk-row">
              <Label tip="Worked out from your risk so that hitting the stop loses about that much, brokerage included. Type a number to set it yourself.">Shares</Label>
              <div className="input-row">
                <input inputMode="numeric" value={manual ? draft.shares : shares ? String(shares) : ""} placeholder="auto" onChange={(e) => update({ shares: e.target.value.replace(/[^\d]/g, "") })} aria-label="Shares" />
                <button type="button" className={manual ? "" : "active-soft"} onClick={() => update({ shares: "" })} disabled={!manual} title="Size the position from your risk again">
                  Auto
                </button>
              </div>
              <span className="hint muted">{manual ? "Set by you" : "Sized from your risk"}</span>
            </div>
          </section>

          <section className="panel plan-results" aria-live="polite">
            <div className="result-pair">
              <div className="result loss">
                <Label tip="What you'd lose if the stop-loss fills, including brokerage on the buy and the sell. A fast fall can fill below your stop, so it can be more.">Risk (max loss)</Label>
                <strong>{a.loss != null ? money(-a.loss, true) : "—"}</strong>
                <span className="muted small-text">
                  {a.stopPct != null ? `${pct(-a.stopPct)} move` : "Set a stop"}
                  {a.loss != null && equity > 0 ? ` · ${pct((a.loss / equity) * 100, false, 2)} of account` : ""}
                </span>
              </div>
              <div className="result gain">
                <Label tip="What you'd make if the target fills, after brokerage both ways.">Potential gain</Label>
                <strong>{a.gain != null ? money(a.gain, true) : "—"}</strong>
                <span className="muted small-text">
                  {a.targetPct != null ? `${pct(a.targetPct)} move` : "Set a target"}
                  {a.gain != null && equity > 0 ? ` · ${pct((a.gain / equity) * 100, true, 2)} of account` : ""}
                </span>
              </div>
            </div>
            <div className="ratio-row">
              <div>
                <Label tip="Potential gain ÷ risk. 2:1 means you stand to make twice what you could lose.">Reward : risk</Label>
                <strong className={a.ratio == null ? "" : a.ratio >= 2 ? "up" : a.ratio < 1 ? "down" : ""}>{a.ratio != null ? `${a.ratio.toFixed(2)} : 1` : "—"}</strong>
              </div>
              <div className="ratio-bar" aria-hidden>
                {a.loss != null && a.gain != null && (
                  <>
                    <i className="down" style={{ flex: a.loss }} />
                    <i className="up" style={{ flex: a.gain }} />
                  </>
                )}
              </div>
            </div>
            <dl className="stat-rows">
              <div>
                <dt>
                  <Label tip="At this reward-to-risk, the share of trades you'd need to win just to break even over many trades.">Win rate to break even</Label>
                </dt>
                <dd>{winRateNeeded != null ? `${winRateNeeded.toFixed(0)}%` : "—"}</dd>
              </div>
              <div>
                <dt>Position value</dt>
                <dd>
                  {a.value ? money(a.value) : "—"}
                  {a.value && equity > 0 ? <span className="muted"> ({pct((a.value / equity) * 100, false, 0)})</span> : null}
                </dd>
              </div>
              <div>
                <dt>
                  <Label tip="The price you need to sell at just to cover brokerage on the way in and out.">Breakeven price</Label>
                </dt>
                <dd>{a.breakeven != null ? formatPrice(a.breakeven) : "—"}</dd>
              </div>
              <div>
                <dt>Brokerage (in + out)</dt>
                <dd>{a.value ? `≈ ${money(a.buyFee * 2)}` : "—"}</dd>
              </div>
            </dl>
            {issues.map((p) => (
              <p key={p} className="error small-text">
                {p}
              </p>
            ))}
            {warnings.map((w) => (
              <p key={w} className="ticket-note">
                {w}
              </p>
            ))}
            <button className="primary submit-buy place-plan" onClick={placeTrade} disabled={!ready} title="Opens the order ticket filled in with this plan. You confirm the order there.">
              Place this trade · buy {shares > 0 ? shares.toLocaleString("en-AU") : ""} {symbol}
            </button>
            <p className="muted tiny">Opens the order ticket as a limit order at your entry, with the plan attached to your journal. Nothing is bought until you confirm it there. The stop and target aren't placed automatically.</p>
          </section>
        </aside>
      </div>

      <div className="planner-lower">
        <section className="panel notebook">
          <div className="notebook-head">
            <h3 className="panel-title">Notebook</h3>
            <span className="muted small-text">{draft.id ? "Editing a saved plan" : "New plan (not saved yet)"}</span>
          </div>
          <div className="notebook-row">
            <label>
              Plan name
              <input value={draft.title} onChange={(e) => update({ title: e.target.value })} placeholder={`e.g. ${symbol} breakout above yesterday's high`} maxLength={120} />
            </label>
            <label>
              Setup
              <select value={draft.setup} onChange={(e) => update({ setup: e.target.value })}>
                <option value="">Choose…</option>
                {defaults.journal.setups.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Your plan
            <textarea
              rows={6}
              value={draft.notes}
              onChange={(e) => update({ notes: e.target.value })}
              placeholder={"What do you see on the chart?\nWhat has to happen before you buy?\nWhat would prove you wrong?\nWhen will you take profit or get out?"}
            />
          </label>
          <div className="checklist">
            <div className="checklist-head">
              <Label tip="Tick each one before you trade. Professional traders use a checklist so they don't skip steps when excited.">Pre-trade checklist</Label>
              <span className={`muted small-text ${doneCount === draft.checklist.length && doneCount > 0 ? "up" : ""}`}>
                {doneCount} of {draft.checklist.length}
              </span>
            </div>
            <ul>
              {draft.checklist.map((item, i) => (
                <li key={`${i}-${item.text}`}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={() => update({ checklist: draft.checklist.map((c, j) => (j === i ? { ...c, done: !c.done } : c)) })}
                    />
                    <span>{item.text}</span>
                  </label>
                  <button className="icon-button" onClick={() => update({ checklist: draft.checklist.filter((_, j) => j !== i) })} aria-label={`Remove "${item.text}"`} title="Remove">
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="input-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newItem.trim() || draft.checklist.length >= 20) return;
                update({ checklist: [...draft.checklist, { text: newItem.trim(), done: false }] });
                setNewItem("");
              }}
            >
              <input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add your own rule" maxLength={200} aria-label="New checklist item" />
              <button type="submit" disabled={!newItem.trim()}>
                Add
              </button>
            </form>
          </div>
          <div className="notebook-actions">
            <button className="primary" onClick={() => save(false)} disabled={entry == null}>
              {draft.id ? "Save changes" : "Save plan"}
            </button>
            {draft.id && <button onClick={() => save(true)}>Save as a new plan</button>}
            <button className="ghost" onClick={startNew}>
              Start a new plan
            </button>
            {status && <span className={status.ok ? "up small-text" : "error small-text"}>{status.text}</span>}
          </div>
        </section>

        <section className="panel what-if">
          <h3 className="panel-title">
            <Label tip="Move the slider, drag the grey line on the chart, or click a row to see what you'd make or lose if you sold at that price.">What if it goes to…</Label>
          </h3>
          {entry == null || shares <= 0 ? (
            <p className="muted small-text">Set an entry and a position size to try prices.</p>
          ) : (
            <>
              <div className="what-if-readout">
                <strong>{whatIf != null ? formatPrice(whatIf) : "—"}</strong>
                <span className={`what-if-pnl ${whatIfPnl == null ? "" : whatIfPnl > 0 ? "up" : whatIfPnl < 0 ? "down" : ""}`}>{whatIfPnl != null ? money(whatIfPnl, true) : "—"}</span>
                {whatIfPnl != null && a.loss != null && a.loss > 0 && <span className="muted">{`${whatIfPnl >= 0 ? "+" : "−"}${Math.abs(whatIfPnl / a.loss).toFixed(2)}R`}</span>}
              </div>
              <input
                type="range"
                className="what-if-slider"
                min={sliderMin}
                max={sliderMax}
                step={tickSize(entry)}
                value={whatIf ?? entry}
                onChange={(e) => setWhatIf(Number(e.target.value))}
                aria-label="What-if exit price"
              />
              <table className="data-table compact scenarios">
                <thead>
                  <tr>
                    <th>If you sell at</th>
                    <th className="num">Price</th>
                    <th className="num">Profit / loss</th>
                    <th className="num">Account</th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map((s) => {
                    const pnl = outcome(entry, s.price, shares, brokerage);
                    return (
                      <tr key={s.key} className={`clickable ${whatIf != null && Math.abs(whatIf - s.price) < 1e-9 ? "selected" : ""}`} onClick={() => setWhatIf(s.price)}>
                        <td>{s.label}</td>
                        <td className="num">{formatPrice(s.price)}</td>
                        <td className={`num ${pnl > 0 ? "up" : pnl < 0 ? "down" : ""}`}>{money(pnl, true)}</td>
                        <td className="num muted">{equity > 0 ? pct((pnl / equity) * 100, true, 2) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted tiny">"R" is your risk: +2R means a gain twice what you'd lose at the stop. Profits are after brokerage both ways.</p>
            </>
          )}
        </section>
      </div>

      <section className="panel saved-plans">
        <div className="notebook-head">
          <h3 className="panel-title">Saved plans</h3>
          <span className="muted small-text">{saved.length} saved</span>
        </div>
        {listError && <p className="error small-text">Couldn't load your plans: {listError}</p>}
        {saved.length === 0 && !listError ? (
          <p className="muted small-text">Plans you save appear here, so you can come back to them and see how your ideas played out.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Plan</th>
                <th className="num">Entry</th>
                <th className="num">Stop</th>
                <th className="num">Target</th>
                <th className="num">
                  <Label tip="From the prices alone, before brokerage. Open the plan to see it after fees.">Reward : risk</Label>
                </th>
                <th className="num">Now</th>
                <th>Saved</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {saved.map((p) => {
                const e = Number(p.entry);
                const s = p.stop ? Number(p.stop) : null;
                const t = p.target ? Number(p.target) : null;
                const ratio = s != null && t != null && e > s ? (t - e) / (e - s) : null;
                const now = p.symbol === symbol ? live : priceOf(feed.quotes[p.symbol], feed.candlesFor(p.symbol)).price;
                return (
                  <tr key={p.id} className={`clickable ${draft.id === p.id ? "selected" : ""}`} onClick={() => open(p)}>
                    <td>
                      <span className="cell-symbol">{p.symbol}</span>
                      <span className="cell-name">{p.title || names[p.symbol]}</span>
                    </td>
                    <td className="num">{formatPrice(e)}</td>
                    <td className="num down">{s != null ? formatPrice(s) : "—"}</td>
                    <td className="num up">{t != null ? formatPrice(t) : "—"}</td>
                    <td className="num">{ratio != null ? `${ratio.toFixed(1)} : 1` : "—"}</td>
                    <td className="num muted">{now != null ? formatPrice(now) : "—"}</td>
                    <td className="muted">{new Date(p.updated_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</td>
                    <td className="row-actions" onClick={(ev) => ev.stopPropagation()}>
                      {confirmDelete === p.id ? (
                        <>
                          <button className="small-button danger" onClick={() => remove(p.id)}>
                            Delete
                          </button>
                          <button className="small-button" onClick={() => setConfirmDelete(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <button className="icon-button" onClick={() => setConfirmDelete(p.id)} aria-label={`Delete plan for ${p.symbol}`} title="Delete">
                          <Icon name="close" size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/** A price box with a coloured marker and one-step − / + buttons. */
function PriceField({ level, label, tip, value, onChange }: { level: LevelKey; label: string; tip: string; value: string; onChange: (v: string) => void }) {
  const n = num(value);
  const step = (direction: 1 | -1) => {
    if (n == null) return;
    const next = n + direction * tickSize(direction > 0 ? n : Math.max(n - tickSize(n) / 2, 0.001));
    if (next > 0) onChange(priceText(next));
  };
  return (
    <div className="price-field">
      <Label tip={tip}>
        <i className="level-dot" style={{ background: LEVEL_STYLE[level].color }} />
        {label}
      </Label>
      <div className="stepper">
        <button type="button" onClick={() => step(-1)} disabled={n == null} aria-label={`Lower the ${label} one price step`}>
          −
        </button>
        <input inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0.00" aria-label={label} />
        <button type="button" onClick={() => step(1)} disabled={n == null} aria-label={`Raise the ${label} one price step`}>
          +
        </button>
      </div>
    </div>
  );
}
