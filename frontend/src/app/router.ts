// Page navigation with the URL hash (#/stock/BHP), so each page has its own address and the
// browser's back and forward buttons work. Small enough not to need a routing library.

import { useEffect, useState } from "react";

export type Page = "home" | "watchlist" | "stock" | "portfolio" | "planner" | "coach" | "swing" | "replay";

export type Route = { page: Page; symbol?: string; tab?: string };

const PAGES: Page[] = ["home", "watchlist", "stock", "portfolio", "planner", "coach", "swing", "replay"];

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const page = (parts[0] ?? "home") as Page;
  if (!PAGES.includes(page)) return { page: "home" };
  if (page === "stock") {
    const symbol = (parts[1] ?? "").toUpperCase();
    return symbol ? { page, symbol } : { page: "watchlist" };
  }
  if (page === "planner") return parts[1] ? { page, symbol: parts[1].toUpperCase() } : { page };
  return parts[1] ? { page, tab: parts[1] } : { page };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

export function go(path: string): void {
  window.location.hash = path;
}

export const stockPath = (symbol: string) => `/stock/${symbol}`;
export const plannerPath = (symbol?: string) => (symbol ? `/planner/${symbol}` : "/planner");
