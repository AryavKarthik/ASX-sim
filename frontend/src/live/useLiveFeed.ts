import { useEffect, useRef, useState } from "react";

import type { Bar } from "../api";
import type { FeedSource, LiveMessage, LiveStatus, Quote } from "./types";

function liveSocketUrl(symbols: string[], source: FeedSource): string {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ symbols: symbols.join(",") });
  if (source.kind === "demo") {
    params.set("source", "demo");
    params.set("speed", String(source.speed));
    if (source.day) params.set("day", source.day);
  }
  return `${protocol}://${window.location.host}/api/live/ws?${params}`;
}

export type LiveFeed = {
  connected: boolean;
  sessionDay: string | null;
  status: LiveStatus | null;
  quotes: Record<string, Quote>;
  /** How many updates each symbol has had (used to flash the watchlist row). */
  ticks: Record<string, number>;
  candlesFor: (symbol: string) => Bar[];
  closedReason: string | null;
};

/**
 * Streams the watchlist from the delayed market. Candles are kept outside React state (they
 * change many times a second); `onCandle` is called so the chart can update itself directly.
 */
export function useLiveFeed(
  symbols: string[],
  source: FeedSource,
  onCandle: (symbol: string, candle: Bar) => void,
  onSnapshot: () => void,
): LiveFeed {
  const [connected, setConnected] = useState(false);
  const [sessionDay, setSessionDay] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [ticks, setTicks] = useState<Record<string, number>>({});
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const candles = useRef(new Map<string, Bar[]>());
  const callbacks = useRef({ onCandle, onSnapshot });

  useEffect(() => {
    callbacks.current = { onCandle, onSnapshot };
  }, [onCandle, onSnapshot]);

  const key = `${symbols.join(",")}|${JSON.stringify(source)}`;

  useEffect(() => {
    const ws = new WebSocket(liveSocketUrl(symbols, source));
    candles.current = new Map();
    setQuotes({});
    setTicks({});
    setStatus(null);
    setClosedReason(null);

    ws.onopen = () => setConnected(true);
    ws.onclose = (event) => {
      setConnected(false);
      if (event.code >= 4000) setClosedReason(event.reason || "Connection closed by the server");
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as LiveMessage;
      if (message.type === "snapshot") {
        setSessionDay(message.session_day);
        for (const [symbol, data] of Object.entries(message.symbols)) {
          candles.current.set(symbol, data.candles);
        }
        callbacks.current.onSnapshot();
      } else if (message.type === "tick") {
        setQuotes((q) => ({ ...q, [message.symbol]: message.quote }));
        setTicks((t) => ({ ...t, [message.symbol]: (t[message.symbol] ?? 0) + 1 }));
        if (message.candle) {
          const list = candles.current.get(message.symbol) ?? [];
          const last = list[list.length - 1];
          if (last && last.time === message.candle.time) list[list.length - 1] = message.candle;
          else list.push(message.candle);
          candles.current.set(message.symbol, list);
          callbacks.current.onCandle(message.symbol, message.candle);
        }
      } else {
        const { type: _type, ...rest } = message;
        void _type;
        setStatus(rest);
      }
    };
    return () => ws.close();
    // `key` captures symbols and source; the arrays themselves change identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    connected,
    sessionDay,
    status,
    quotes,
    ticks,
    candlesFor: (symbol) => candles.current.get(symbol) ?? [],
    closedReason,
  };
}
