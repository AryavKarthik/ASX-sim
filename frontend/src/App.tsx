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
        <span className="badge">Past-day replay</span>
        <span className="muted small">Live trading on the delayed market is coming next · for practice only</span>
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
