import { useState } from "react";

import { ReplayView } from "./components/ReplayView";
import { SetupPanel, type StartedSession } from "./components/SetupPanel";

export function App() {
  const [session, setSession] = useState<StartedSession | null>(null);

  return (
    <div className="app">
      <nav className="topbar">
        <span className="brand">
          ASX<span>-sim</span>
        </span>
        <span className="badge">Intraday replay</span>
        <span className="muted small">Real recorded ASX data · for practice only</span>
      </nav>
      <main>
        {session ? (
          <ReplayView key={session.id} sessionId={session.id} onExit={() => setSession(null)} />
        ) : (
          <SetupPanel onStart={setSession} />
        )}
      </main>
    </div>
  );
}
