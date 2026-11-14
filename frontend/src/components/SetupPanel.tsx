import { type FormEvent, useEffect, useMemo, useState } from "react";

import { type Security, createSession, fetchDays, fetchSymbols } from "../api";
import { formatDay } from "../format";

export type StartedSession = { id: string; symbol: string; day: string };

/** Pick a recorded trading day and a stock, then start a replay. */
export function SetupPanel({ onStart }: { onStart: (session: StartedSession) => void }) {
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState("");
  const [securities, setSecurities] = useState<Security[]>([]);
  const [symbol, setSymbol] = useState("BHP");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    fetchDays()
      .then((list) => {
        setDays(list);
        setDay(list[0] ?? "");
        if (list.length === 0) setError("No recorded data found. Is ASXSIM_DATA_DIR set?");
      })
      .catch((e: Error) => setError(`Can't reach the backend: ${e.message}`));
  }, []);

  useEffect(() => {
    if (!day) return;
    fetchSymbols(day)
      .then(setSecurities)
      .catch((e: Error) => setError(e.message));
  }, [day]);

  const known = useMemo(() => new Set(securities.map((s) => s.code)), [securities]);
  const code = symbol.trim().toUpperCase();
  const selected = securities.find((s) => s.code === code);

  async function start(event: FormEvent) {
    event.preventDefault();
    setStarting(true);
    setError(null);
    try {
      const created = await createSession(code, day);
      onStart({ id: created.session_id, symbol: code, day });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <form className="setup card" onSubmit={start}>
      <h1>Intraday replay</h1>
      <p className="muted">
        Pick a past trading day and a stock. The day replays minute by minute from just before
        the open, and you only ever see what had happened up to the replay clock.
      </p>

      <label>
        Trading day
        <select value={day} onChange={(e) => setDay(e.target.value)} disabled={days.length === 0}>
          {days.map((d) => (
            <option key={d} value={d}>
              {formatDay(d)}
            </option>
          ))}
        </select>
      </label>

      <label>
        Stock
        <input
          list="securities"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="ASX code, e.g. BHP"
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id="securities">
          {securities.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </datalist>
        <span className="hint">{selected ? selected.name : code ? "Not in the recorded data" : " "}</span>
      </label>

      {error && <p className="error">{error}</p>}

      <button type="submit" className="primary" disabled={!day || !known.has(code) || starting}>
        {starting ? "Starting…" : "Start replay"}
      </button>
    </form>
  );
}
