import { type FormEvent, useEffect, useRef, useState } from "react";

import type { CoachStatus, CommandResult } from "./types";

type Turn = { role: "user" | "assistant"; content: string; kind?: "review"; error?: boolean };

type Props = {
  status: CoachStatus;
  symbol: string;
  /** Ask the coach; `onDelta` receives the reply as it is written. */
  ask: (
    payload: { kind: "chat" | "review"; question?: string; history: { role: string; content: string }[]; symbol: string },
    onDelta: (text: string) => void,
  ) => Promise<CommandResult>;
};

const STARTERS = [
  "Review my most recent trade",
  "How should I size a position from my stop?",
  "What is VWAP and how do day traders use it?",
  "What mistakes do my stats suggest I'm making?",
];

function usd(n: number): string {
  return `US$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
}

/** Chat with the AI coach. It explains and reviews; it doesn't give buy or sell tips. */
export function CoachPanel({ status: initial, symbol, ask }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(initial);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns]);

  async function send(kind: "chat" | "review", question: string) {
    if (busy) return;
    // Only real exchanges go back to the model: reviews and errors aren't part of the chat.
    const history = turns
      .filter((t) => !t.error && !t.kind)
      .map(({ role, content }) => ({ role, content }));
    const shown = kind === "review" ? "Give me a full review of my trading so far." : question;
    setTurns((t) => [...t, { role: "user", content: shown, kind: kind === "review" ? "review" : undefined }, { role: "assistant", content: "", kind: kind === "review" ? "review" : undefined }]);
    setDraft("");
    setBusy(true);
    const append = (text: string) =>
      setTurns((t) => {
        const last = t[t.length - 1];
        return [...t.slice(0, -1), { ...last, content: last.content + text }];
      });
    const result = await ask({ kind, question, history, symbol }, append);
    if (result.coach) setStatus(result.coach);
    if (!result.ok) {
      setTurns((t) => [...t.slice(0, -1), { role: "assistant", content: result.error, error: true }]);
    }
    setBusy(false);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (question) void send("chat", question);
  }

  if (!status.available) {
    return (
      <div className="coach-setup">
        <h4>Switch on the AI coach</h4>
        <p>
          The coach explains concepts, helps you plan trades and reviews your journal and statistics. It runs on
          Claude, which needs your own API key (about US$10 a month at most, capped by the app).
        </p>
        <ol>
          <li>
            Create a key at <strong>console.anthropic.com</strong> and set a monthly spend limit there.
          </li>
          <li>
            In the project folder, copy <code>.env.example</code> to <code>.env</code> and paste the key after{" "}
            <code>ANTHROPIC_API_KEY=</code>
          </li>
          <li>Restart the backend.</li>
        </ol>
        <p className="muted small-text">The key stays on your computer in .env, which is never committed to GitHub.</p>
      </div>
    );
  }

  const left = Math.max(0, status.budget_usd - status.spent_usd);
  return (
    <div className="coach">
      <div className="coach-head">
        <span className="muted small-text">
          A coach, not a tipster: it teaches and reviews, and won't tell you what to buy or sell. General education,
          not financial advice.
        </span>
        <button
          className="review-button"
          disabled={busy}
          onClick={() => void send("review", "")}
          title={`A full review of your journal and statistics, using the stronger model (${status.review_model}). Costs a few cents.`}
        >
          Full review
        </button>
      </div>

      <div className="coach-log" aria-live="polite">
        {turns.length === 0 && (
          <div className="starters">
            <p className="muted">Ask anything about trading, or start with one of these:</p>
            {STARTERS.map((s) => (
              <button key={s} disabled={busy} onClick={() => void send("chat", s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role} ${t.error ? "error" : ""}`}>
            <span className="who">{t.role === "user" ? "You" : "Coach"}</span>
            <p>{t.content || (busy && i === turns.length - 1 ? "Thinking…" : "")}</p>
          </div>
        ))}
        <div ref={end} />
      </div>

      <form className="coach-input" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Ask the coach (it can see your account and ${symbol})`}
          maxLength={4000}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          {busy ? "…" : "Ask"}
        </button>
      </form>
      <p className="muted tiny coach-spend" title="Estimated from token counts and list prices. Chat uses the cheap model; a full review costs more.">
        About {usd(status.spent_usd)} used of {usd(status.budget_usd)} this month ({usd(left)} left) · {status.calls}{" "}
        {status.calls === 1 ? "reply" : "replies"}
      </p>
    </div>
  );
}
