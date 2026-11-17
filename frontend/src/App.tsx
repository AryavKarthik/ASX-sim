import { useEffect, useState } from "react";

import { ReplayView } from "./components/ReplayView";
import { SetupPanel, type StartedSession } from "./components/SetupPanel";
import { LiveView } from "./live/LiveView";
import type { Defaults } from "./live/types";
import { SwingView } from "./swing/SwingView";

type Mode = "live" | "swing" | "replay";

export function App() {
  const [mode, setMode] = useState<Mode>("live");
  const [session, setSession] = useState<StartedSession | null>(null);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/live/defaults")
      .then((r) => (r.ok ? (r.json() as Promise<Defaults>) : Promise.reject(new Error(r.statusText))))
      .then(setDefaults)
      .catch((e: Error) => setError(`Can't reach the backend: ${e.message}`));
  }, []);

  return (
    <div className="app">
      <nav className="topbar">
        <span className="brand">
          ASX<span>-sim</span>
        </span>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === "live"} className={mode === "live" ? "active" : ""} onClick={() => setMode("live")}>
            Live market (delayed)
          </button>
          <button role="tab" aria-selected={mode === "swing"} className={mode === "swing" ? "active" : ""} onClick={() => setMode("swing")}>
            Swing practice
          </button>
          <button role="tab" aria-selected={mode === "replay"} className={mode === "replay" ? "active" : ""} onClick={() => setMode("replay")}>
            Past-day replay
          </button>
        </div>
        <span className="muted small">Simulated trading for practice · prices ~20 min delayed</span>
      </nav>
      <main>
        {error && <p className="error">{error}</p>}
        {mode === "live" ? (
          defaults && <LiveView defaults={defaults} />
        ) : mode === "swing" ? (
          <SwingView />
        ) : session ? (
          <ReplayView key={session.id} sessionId={session.id} onExit={() => setSession(null)} />
        ) : (
          <SetupPanel onStart={setSession} />
        )}
      </main>
    </div>
  );
}
