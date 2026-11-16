import { useEffect, useState } from "react";

import type { CommandResult, JournalEntry, JournalOptions, TradeView } from "./types";

type Props = {
  trades: TradeView[];
  options: JournalOptions;
  onSave: (tradeId: string, fields: Partial<JournalEntry>) => Promise<CommandResult>;
  onSelectSymbol: (symbol: string) => void;
};

function money(value: string | null, signed = true): string {
  if (value == null) return "—";
  const n = Number(value);
  const text = Math.abs(n).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
  return signed ? `${n >= 0 ? "+" : "−"}${text}` : text;
}

function tone(value: string | number | null): string {
  const n = Number(value ?? 0);
  return n > 0 ? "up" : n < 0 ? "down" : "";
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function holding(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}

function Stars({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  return (
    <div className="stars" role="group" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={value != null && n <= value ? "on" : ""}
          onClick={() => onChange(value === n ? null : n)}
          aria-label={`${n} of 5`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

/** Edit one trade's plan and review. */
function Editor({ trade, options, onSave }: { trade: TradeView; options: JournalOptions; onSave: Props["onSave"] }) {
  const [draft, setDraft] = useState<JournalEntry>(trade.journal);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDraft(trade.journal);
    setMessage(null);
    // Reset only when switching trades, not on every price update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade.id]);

  const set = <K extends keyof JournalEntry>(key: K, value: JournalEntry[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  function toggleEmotion(emotion: string) {
    set("emotions", draft.emotions.includes(emotion) ? draft.emotions.filter((e) => e !== emotion) : [...draft.emotions, emotion]);
  }

  async function save() {
    const { updated_at: _updated, ...fields } = draft;
    void _updated;
    const reply = await onSave(trade.id, fields);
    setMessage(reply.ok ? { ok: true, text: "Saved" } : { ok: false, text: reply.error });
  }

  const closed = trade.status === "closed";
  return (
    <div className="journal-editor">
      <div className="journal-grid">
        <section>
          <h4>The plan</h4>
          <label>
            Setup
            <select value={draft.setup ?? ""} onChange={(e) => set("setup", e.target.value || null)}>
              <option value="">Not set</option>
              {[...new Set([...options.setups, ...(draft.setup ? [draft.setup] : [])])].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Why I took it
            <textarea rows={3} value={draft.thesis} onChange={(e) => set("thesis", e.target.value)} placeholder="What did you see? Why here, why now?" />
          </label>
          <div className="input-row">
            <label>
              Planned stop
              <input inputMode="decimal" value={draft.planned_stop ?? ""} onChange={(e) => set("planned_stop", e.target.value || null)} />
            </label>
            <label>
              Planned target
              <input inputMode="decimal" value={draft.planned_target ?? ""} onChange={(e) => set("planned_target", e.target.value || null)} />
            </label>
          </div>
          <label>
            Confidence
            <Stars value={draft.confidence} onChange={(v) => set("confidence", v)} label="Confidence" />
          </label>
          <label>
            How I felt
            <div className="chips">
              {options.emotions.map((emotion) => (
                <button
                  key={emotion}
                  type="button"
                  className={draft.emotions.includes(emotion) ? "chip on" : "chip"}
                  onClick={() => toggleEmotion(emotion)}
                >
                  {emotion}
                </button>
              ))}
            </div>
          </label>
        </section>

        <section>
          <h4>The review {closed ? "" : <span className="muted small-inline">(after you close the trade)</span>}</h4>
          <label>
            Did I follow my plan?
            <div className="segmented small">
              {[
                ["Yes", true],
                ["No", false],
              ].map(([text, value]) => (
                <button
                  key={String(text)}
                  type="button"
                  className={draft.followed_plan === value ? "active" : ""}
                  onClick={() => set("followed_plan", draft.followed_plan === value ? null : (value as boolean))}
                >
                  {text}
                </button>
              ))}
            </div>
          </label>
          <label>
            What went well
            <textarea rows={2} value={draft.went_well} onChange={(e) => set("went_well", e.target.value)} />
          </label>
          <label>
            What to do better
            <textarea rows={2} value={draft.to_improve} onChange={(e) => set("to_improve", e.target.value)} />
          </label>
          <label>
            How well I traded it <span className="muted small-inline">(the process, not the profit)</span>
            <Stars value={draft.rating} onChange={(v) => set("rating", v)} label="Rating" />
          </label>
        </section>
      </div>
      <div className="journal-actions">
        <button className="primary" onClick={save}>
          Save journal
        </button>
        {message && <span className={message.ok ? "up small-text" : "error small-text"}>{message.text}</span>}
      </div>
    </div>
  );
}

/** Your trades as round trips, with each one's plan, review and R-multiple. */
export function JournalPanel({ trades, options, onSave, onSelectSymbol }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = trades.find((t) => t.id === openId) ?? null;

  if (trades.length === 0) {
    return (
      <p className="muted empty">
        No trades yet. Each time you buy into a stock and later sell out, it becomes one trade here. Add your plan on
        the order ticket, then review it after you close.
      </p>
    );
  }

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Opened</th>
            <th>Stock</th>
            <th>Shares</th>
            <th>Entry → exit</th>
            <th>Held</th>
            <th>Net P&amp;L</th>
            <th title="Profit or loss in units of the risk you planned (needs a planned stop)">R</th>
            <th>Setup</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const pnl = t.status === "open" ? t.unrealised : t.net_pnl;
            const reviewed = t.journal.rating != null || t.journal.followed_plan != null;
            return (
              <tr
                key={t.id}
                className={`clickable ${t.id === openId ? "selected-row" : ""}`}
                onClick={() => setOpenId(t.id === openId ? null : t.id)}
              >
                <td>{when(t.opened_at)}</td>
                <td
                  className="strong"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectSymbol(t.symbol);
                  }}
                >
                  {t.symbol}
                </td>
                <td>{t.entry_quantity.toLocaleString("en-AU")}</td>
                <td>
                  ${t.average_entry} → {t.average_exit ? `$${t.average_exit}` : <span className="tag">open</span>}
                </td>
                <td>{holding(t.holding_minutes)}</td>
                <td className={tone(pnl)}>
                  {money(pnl)}
                  {t.status === "open" && <span className="muted tiny block">unrealised</span>}
                </td>
                <td className={tone(t.r_multiple)}>{t.r_multiple == null ? "—" : `${t.r_multiple > 0 ? "+" : ""}${t.r_multiple.toFixed(2)}R`}</td>
                <td>{t.journal.setup ?? <span className="muted">—</span>}</td>
                <td>
                  {t.journal.rating ? "★".repeat(t.journal.rating) : reviewed ? "✓" : t.status === "closed" ? <span className="muted">Add review</span> : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {open && <Editor trade={open} options={options} onSave={onSave} />}
    </>
  );
}
