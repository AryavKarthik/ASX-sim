import { useCallback, useEffect, useRef, useState } from "react";

import type { Bar } from "../api";
import type { AccountView, CommandResult, FeedSource, LiveMessage, LiveStatus, Quote } from "./types";

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
  account: AccountView | null;
  candlesFor: (symbol: string) => Bar[];
  closedReason: string | null;
  /** Send a command (order, cancel, reset_account) and wait for the server's reply. */
  command: (action: string, payload: Record<string, unknown>) => Promise<CommandResult>;
};

/**
 * Streams the watchlist from the delayed market and carries trading commands. Candles are
 * kept outside React state (they change many times a second); `onCandle` lets the chart
 * update itself directly.
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
  const [account, setAccount] = useState<AccountView | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const candles = useRef(new Map<string, Bar[]>());
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, (r: CommandResult) => void>());
  const nextId = useRef(1);
  const callbacks = useRef({ onCandle, onSnapshot });
  const symbolsRef = useRef(symbols);

  useEffect(() => {
    callbacks.current = { onCandle, onSnapshot };
  }, [onCandle, onSnapshot]);

  const sourceKey = JSON.stringify(source);

  // One connection per source (live, or a particular demo). Watchlist edits don't reconnect.
  useEffect(() => {
    const ws = new WebSocket(liveSocketUrl(symbolsRef.current, source));
    socket.current = ws;
    candles.current = new Map();
    setQuotes({});
    setTicks({});
    setStatus(null);
    setAccount(null);
    setClosedReason(null);

    ws.onopen = () => setConnected(true);
    ws.onclose = (event) => {
      setConnected(false);
      if (event.code >= 4000) setClosedReason(event.reason || "Connection closed by the server");
      for (const resolve of pending.current.values()) {
        resolve({ type: "result", request_id: "", action: "", ok: false, error: "Disconnected from the server" });
      }
      pending.current.clear();
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as LiveMessage;
      switch (message.type) {
        case "snapshot":
          setSessionDay(message.session_day);
          setAccount(message.account);
          for (const [symbol, data] of Object.entries(message.symbols)) {
            candles.current.set(symbol, data.candles);
            const quote = data.quote;
            if (quote) setQuotes((q) => ({ ...q, [symbol]: quote }));
          }
          callbacks.current.onSnapshot();
          break;
        case "tick": {
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
          break;
        }
        case "account":
          setAccount(message.account);
          break;
        case "result": {
          const resolve = pending.current.get(message.request_id);
          pending.current.delete(message.request_id);
          resolve?.(message);
          break;
        }
        case "status": {
          const { type: _type, ...rest } = message;
          void _type;
          setStatus(rest);
          break;
        }
      }
    };
    return () => ws.close();
    // `sourceKey` captures the source; reconnect only when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // Watchlist changes are sent over the open connection.
  const symbolsKey = symbols.join(",");
  useEffect(() => {
    symbolsRef.current = symbols;
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: "watch", symbols }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolsKey]);

  const command = useCallback((action: string, payload: Record<string, unknown>) => {
    return new Promise<CommandResult>((resolve) => {
      const ws = socket.current;
      if (ws?.readyState !== WebSocket.OPEN) {
        resolve({ type: "result", request_id: "", action, ok: false, error: "Not connected to the server" });
        return;
      }
      const requestId = `r${nextId.current++}`;
      pending.current.set(requestId, resolve);
      ws.send(JSON.stringify({ action, request_id: requestId, ...payload }));
    });
  }, []);

  return {
    connected,
    sessionDay,
    status,
    quotes,
    ticks,
    account,
    candlesFor: (symbol) => candles.current.get(symbol) ?? [],
    closedReason,
    command,
  };
}
