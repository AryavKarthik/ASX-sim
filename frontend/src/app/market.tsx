// One connection to the market, shared by every page: prices, the account, the watchlist,
// live or demo mode, and the commands (orders, journal, coach). Pages read it with
// `useMarket()` instead of each opening their own connection.

import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { type Bar, fetchDays } from "../api";
import type { CommandResult, Defaults, FeedSource, JournalEntry, OrderCommand, Quote } from "../live/types";
import { type LiveFeed, useLiveFeed } from "../live/useLiveFeed";

const WATCHLIST_KEY = "asxsim.watchlist";
const REFRESH_KEY = "asxsim.refresh";
export const REFRESH_OPTIONS = [
  { ms: 0, label: "Live" },
  { ms: 5_000, label: "5s" },
  { ms: 30_000, label: "30s" },
];
const DEFAULT_REFRESH = 30_000;
/** The S&P/ASX 200, streamed always so the Home page can show the market. */
export const INDEX = "XJO";

type CandleListener = (symbol: string, candle: Bar) => void;

export type TradeTarget = { symbol: string; side: "buy" | "sell" };

export type Market = {
  defaults: Defaults;
  names: Record<string, string>;
  feed: LiveFeed;
  watchlist: string[];
  addToWatchlist: (symbol: string) => void;
  removeFromWatchlist: (symbol: string) => void;
  resetWatchlist: () => void;
  /** Stream this stock even if it isn't on the watchlist (the page you're looking at). */
  setFocus: (symbol: string | null) => void;
  focus: string | null;
  source: FeedSource;
  setSource: (source: FeedSource) => void;
  demoDays: string[];
  refreshMs: number;
  setRefreshMs: (ms: number) => void;
  onCandle: (listener: CandleListener) => () => void;
  onSnapshot: (listener: () => void) => () => void;
  /** Open the trade panel for a stock. */
  trade: (symbol: string, side?: "buy" | "sell") => void;
  tradeTarget: TradeTarget | null;
  closeTrade: () => void;
  lastViewed: string;
  placeOrder: (order: OrderCommand) => Promise<CommandResult>;
  cancelOrder: (orderId: string) => Promise<CommandResult>;
  saveJournal: (tradeId: string, fields: Partial<JournalEntry>) => Promise<CommandResult>;
  resetAccount: (startingCash: string) => Promise<CommandResult>;
  requestAnalytics: () => Promise<CommandResult>;
  askCoach: (payload: Record<string, unknown>, onDelta: (text: string) => void) => Promise<CommandResult>;
};

const MarketContext = createContext<Market | null>(null);

export function useMarket(): Market {
  const market = useContext(MarketContext);
  if (!market) throw new Error("useMarket must be used inside <MarketProvider>");
  return market;
}

function read<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : (parse(raw) ?? fallback);
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private window): the choice just won't be remembered.
  }
}

/** Price and change for a stock: from its live quote, else from the session's candles. */
export function priceOf(quote: Quote | undefined, candles: Bar[]): { price: number | null; change: number | null; pct: number | null } {
  if (quote) return { price: quote.price, change: quote.change, pct: quote.change_pct };
  if (candles.length === 0) return { price: null, change: null, pct: null };
  const first = candles[0].open;
  const last = candles[candles.length - 1].close;
  return { price: last, change: last - first, pct: first ? ((last - first) / first) * 100 : null };
}

export function MarketProvider({ defaults, children }: { defaults: Defaults; children: ReactNode }) {
  const known = useMemo(() => new Set(defaults.universe.map((u) => u.code)), [defaults.universe]);
  const names = useMemo(() => Object.fromEntries(defaults.universe.map((u) => [u.code, u.name])), [defaults.universe]);
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    const saved = read<string[] | null>(WATCHLIST_KEY, null, (raw) => {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string" && known.has(s)) : null;
    });
    return saved && saved.length > 0 ? saved.slice(0, defaults.max_symbols) : defaults.watchlist;
  });
  const [focus, setFocus] = useState<string | null>(null);
  const [lastViewed, setLastViewed] = useState(watchlist[0] ?? "BHP");
  const [source, setSource] = useState<FeedSource>({ kind: "live" });
  const [refreshMs, setRefreshState] = useState<number>(() =>
    read(REFRESH_KEY, DEFAULT_REFRESH, (raw) => (REFRESH_OPTIONS.some((o) => o.ms === Number(raw)) ? Number(raw) : null)),
  );
  const [demoDays, setDemoDays] = useState<string[]>([]);
  const [tradeTarget, setTradeTarget] = useState<TradeTarget | null>(null);
  const candleListeners = useRef(new Set<CandleListener>());
  const snapshotListeners = useRef(new Set<() => void>());
  const [positionSymbols, setPositionSymbols] = useState<string[]>([]);

  useEffect(() => {
    fetchDays().then(setDemoDays).catch(() => setDemoDays([]));
  }, []);

  useEffect(() => write(WATCHLIST_KEY, JSON.stringify(watchlist)), [watchlist]);

  useEffect(() => {
    if (focus) setLastViewed(focus);
  }, [focus]);

  // What to stream: the stock on screen, the ASX 200 (Home always shows it), then holdings,
  // then the watchlist (the server takes 20).
  const streamed = useMemo(() => {
    const all = [...(focus ? [focus] : []), INDEX, ...positionSymbols, ...watchlist];
    return [...new Set(all)].slice(0, defaults.max_symbols);
  }, [focus, positionSymbols, watchlist, defaults.max_symbols]);

  const feed = useLiveFeed(
    streamed,
    source,
    useCallback((symbol: string, candle: Bar) => {
      for (const listener of candleListeners.current) listener(symbol, candle);
    }, []),
    useCallback(() => {
      for (const listener of snapshotListeners.current) listener();
    }, []),
    refreshMs,
  );

  const heldKey = (feed.account?.positions ?? []).map((p) => p.symbol).join(",");
  useEffect(() => {
    setPositionSymbols(heldKey ? heldKey.split(",") : []);
  }, [heldKey]);

  const { command } = feed;
  const market: Market = {
    defaults,
    names,
    feed,
    watchlist,
    addToWatchlist: (s) => setWatchlist((list) => (list.includes(s) || list.length >= defaults.max_symbols ? list : [...list, s])),
    removeFromWatchlist: (s) => setWatchlist((list) => list.filter((x) => x !== s)),
    resetWatchlist: () => setWatchlist(defaults.watchlist),
    setFocus,
    focus,
    source,
    setSource,
    demoDays,
    refreshMs,
    setRefreshMs: (ms) => {
      setRefreshState(ms);
      write(REFRESH_KEY, String(ms));
    },
    onCandle: useCallback((listener: CandleListener) => {
      candleListeners.current.add(listener);
      return () => candleListeners.current.delete(listener);
    }, []) as Market["onCandle"],
    onSnapshot: useCallback((listener: () => void) => {
      snapshotListeners.current.add(listener);
      return () => snapshotListeners.current.delete(listener);
    }, []) as Market["onSnapshot"],
    trade: (symbol, side = "buy") => setTradeTarget({ symbol, side }),
    tradeTarget,
    closeTrade: () => setTradeTarget(null),
    lastViewed,
    placeOrder: useCallback((order: OrderCommand) => command("order", order), [command]),
    cancelOrder: useCallback((orderId: string) => command("cancel", { order_id: orderId }), [command]),
    saveJournal: useCallback(
      (tradeId: string, fields: Partial<JournalEntry>) => command("journal", { trade_id: tradeId, fields }),
      [command],
    ),
    resetAccount: useCallback((cash: string) => command("reset_account", { starting_cash: cash }), [command]),
    requestAnalytics: useCallback(() => command("analytics", {}), [command]),
    askCoach: useCallback(
      (payload: Record<string, unknown>, onDelta: (text: string) => void) => command("coach", payload, onDelta),
      [command],
    ),
  };

  return <MarketContext.Provider value={market}>{children}</MarketContext.Provider>;
}
