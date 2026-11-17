import { useEffect, useState } from "react";

import { MarketProvider } from "./app/market";
import { useRoute } from "./app/router";
import { Shell } from "./app/Shell";
import type { Defaults } from "./live/types";
import { HomePage } from "./pages/HomePage";
import { CoachPage, ReplayPage } from "./pages/OtherPages";
import { PortfolioPage } from "./pages/PortfolioPage";
import { StockPage } from "./pages/StockPage";
import { WatchlistPage } from "./pages/WatchlistPage";
import { SwingView } from "./swing/SwingView";

export function App() {
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/live/defaults")
      .then((r) => (r.ok ? (r.json() as Promise<Defaults>) : Promise.reject(new Error(r.statusText))))
      .then(setDefaults)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="boot-message">
        <h1>
          ASX<span>-sim</span>
        </h1>
        <p className="error">Can't reach the backend: {error}</p>
        <p className="muted">Start it with scripts\dev.ps1 (or `uv run uvicorn asxsim.api.app:app` in backend/), then refresh.</p>
      </div>
    );
  }
  if (!defaults) return <div className="boot-message muted">Loading…</div>;

  return (
    <MarketProvider defaults={defaults}>
      <Routed />
    </MarketProvider>
  );
}

function Routed() {
  const route = useRoute();
  return (
    <Shell page={route.page}>
      {route.page === "home" && <HomePage />}
      {route.page === "watchlist" && <WatchlistPage />}
      {route.page === "stock" && route.symbol && <StockPage symbol={route.symbol} />}
      {route.page === "portfolio" && <PortfolioPage tab={route.tab} />}
      {route.page === "coach" && <CoachPage />}
      {route.page === "swing" && <SwingView />}
      {route.page === "replay" && <ReplayPage />}
    </Shell>
  );
}
