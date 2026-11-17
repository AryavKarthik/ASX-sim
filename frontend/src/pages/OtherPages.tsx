import { useState } from "react";

import { useMarket } from "../app/market";
import { ReplayView } from "../components/ReplayView";
import { SetupPanel, type StartedSession } from "../components/SetupPanel";
import { CoachPanel } from "../live/CoachPanel";

export function CoachPage() {
  const { defaults, lastViewed, askCoach } = useMarket();
  return (
    <div className="coach-page">
      <header className="page-head">
        <div>
          <h1>Coach</h1>
          <p className="muted">Ask about trading, a stock, or your own results. It teaches and reviews; it won't tell you what to buy.</p>
        </div>
      </header>
      <section className="panel coach-card">
        <CoachPanel status={defaults.coach} symbol={lastViewed} ask={askCoach} />
      </section>
    </div>
  );
}

export function ReplayPage() {
  const [session, setSession] = useState<StartedSession | null>(null);
  return (
    <div className="replay-page">
      <header className="page-head">
        <div>
          <h1>Replay a past day</h1>
          <p className="muted">Watch a recorded trading day minute by minute, to review what happened.</p>
        </div>
      </header>
      {session ? <ReplayView key={session.id} sessionId={session.id} onExit={() => setSession(null)} /> : <SetupPanel onStart={setSession} />}
    </div>
  );
}
