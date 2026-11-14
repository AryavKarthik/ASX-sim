import { useCallback, useEffect, useRef, useState } from "react";

import { type Bar, type Command, type ReplayState, type ServerMessage, replaySocketUrl } from "./api";

/**
 * Connects to a replay session's WebSocket. The server pushes the clock, the market phase and
 * any bars that have just finished; we send play/pause/step/speed commands back.
 *
 * `onBars(bars, reset)` is called with new bars; `reset` is true for the initial snapshot.
 */
export function useReplay(sessionId: string, onBars: (bars: Bar[], reset: boolean) => void) {
  const [state, setState] = useState<ReplayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const onBarsRef = useRef(onBars);

  useEffect(() => {
    onBarsRef.current = onBars;
  }, [onBars]);

  useEffect(() => {
    const ws = new WebSocket(replaySocketUrl(sessionId));
    socket.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = (event) => {
      setConnected(false);
      if (event.code === 4404) setError("This replay has expired. Start a new one.");
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      if (message.type === "error") {
        setError(message.message);
        return;
      }
      setError(null);
      setState(message.state);
      if (message.type === "snapshot" || message.bars.length > 0) {
        onBarsRef.current(message.bars, message.type === "snapshot");
      }
    };
    return () => {
      ws.close();
      socket.current = null;
    };
  }, [sessionId]);

  const send = useCallback((command: Command) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(command));
  }, []);

  return { state, error, connected, send };
}
