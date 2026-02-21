import { useEffect, useRef, useState, useCallback } from 'react';

export function useWebSocket(url, onMessage) {
  const [isConnected, setIsConnected] = useState(false);
  const wsRef        = useRef(null);
  const reconnectRef = useRef(null);
  const onMsgRef     = useRef(onMessage);
  onMsgRef.current   = onMessage;

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        clearTimeout(reconnectRef.current);
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          onMsgRef.current?.(data);
        } catch { /* ignore parse errors */ }
      };

      ws.onclose = () => {
        setIsConnected(false);
        reconnectRef.current = setTimeout(connect, 3500);
      };

      ws.onerror = () => ws.close();
    } catch { /* ignore connection errors */ }
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { isConnected };
}
