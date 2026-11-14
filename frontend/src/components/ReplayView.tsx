import { useCallback, useEffect, useRef } from "react";

import type { Bar } from "../api";
import { PHASE_HELP, PHASE_LABELS, clockTime, formatChange, formatDay, formatPrice } from "../format";
import { useReplay } from "../useReplay";
import { PriceChart, type PriceChartHandle } from "./PriceChart";

const SPEEDS = [1, 10, 60, 300];

export function ReplayView({ sessionId, onExit }: { sessionId: string; onExit: () => void }) {
  const chart = useRef<PriceChartHandle>(null);
  const handleBars = useCallback((bars: Bar[], reset: boolean) => {
    if (reset) chart.current?.reset(bars);
    else chart.current?.append(bars);
  }, []);
  const { state, error, connected, send } = useReplay(sessionId, handleBars);

  // Keyboard: space = play/pause, right arrow = step one minute.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!state || event.target instanceof HTMLInputElement) return;
      if (event.code === "Space") {
        event.preventDefault();
        send({ action: state.playing ? "pause" : "play" });
      } else if (event.code === "ArrowRight") {
        send({ action: "step" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, send]);

  const change =
    state?.last_price != null && state.open_price != null
      ? formatChange(state.last_price, state.open_price)
      : null;

  return (
    <div className="replay">
      <header className="replay-header card">
        <div className="instrument">
          <span className="code">{state?.symbol ?? "…"}</span>
          <span className="muted">{state?.name}</span>
          {state && <span className="muted day">{formatDay(state.day)}</span>}
        </div>

        <div className="quote">
          <span className="price">{state?.last_price != null ? formatPrice(state.last_price) : "—"}</span>
          {change && (
            <span className={change.up ? "up" : "down"} title="Change since the open">
              {change.text}
            </span>
          )}
        </div>

        <div className="clock-block">
          <span className="clock">{state ? clockTime(state.now) : "--:--:--"}</span>
          {state && (
            <span className={`phase phase-${state.phase}`} title={PHASE_HELP[state.phase]}>
              {PHASE_LABELS[state.phase]}
            </span>
          )}
        </div>
      </header>

      <section className="chart-card card">
        <PriceChart ref={chart} />
        {state && state.bars_visible === 0 && (
          <div className="overlay">
            <strong>{PHASE_LABELS[state.phase]}</strong>
            <span>{PHASE_HELP[state.phase]}</span>
            <span className="muted">Press play. Trading starts just before 10:00.</span>
          </div>
        )}
      </section>

      <footer className="controls card">
        <button
          className="primary"
          onClick={() => send({ action: state?.playing ? "pause" : "play" })}
          disabled={!connected || state?.finished}
        >
          {state?.playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button onClick={() => send({ action: "step" })} disabled={!connected || state?.finished}>
          +1 min
        </button>

        <div className="speeds" role="group" aria-label="Replay speed">
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              className={state?.speed === speed ? "active" : ""}
              onClick={() => send({ action: "speed", value: speed })}
              disabled={!connected}
            >
              {speed}×
            </button>
          ))}
        </div>

        <span className="muted hint-keys">Space: play/pause · →: +1 min · No rewind, like the real market</span>

        <button className="ghost" onClick={onExit}>
          New replay
        </button>
      </footer>

      {state?.finished && (
        <p className="notice">
          Replay finished. {state.symbol} closed at {state.last_price != null ? formatPrice(state.last_price) : "—"}.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {!connected && !error && <p className="muted">Connecting…</p>}
    </div>
  );
}
