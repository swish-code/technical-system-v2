import { useState, useEffect } from 'react';

// Live event channel. Auto-reconnects: the previous version opened a socket once
// and never reopened it, so any drop (server redeploy, idle proxy timeout, laptop
// sleep, mobile backgrounding, network change) permanently killed live updates
// until the user manually refreshed the page. Now it reconnects with backoff and
// emits a synthetic { type: 'WS_RECONNECTED' } event so consumers can re-sync
// anything they missed while disconnected.
export function useWebSocket() {
  const [lastMessage, setLastMessage] = useState<any>(null);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;          // component unmounted — don't reconnect
    let attempts = 0;             // consecutive failed attempts (for backoff)
    let connectedBefore = false;  // distinguish first connect from a reconnect

    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}`);

      socket.onopen = () => {
        attempts = 0;
        // On a RE-connection (not the very first), tell consumers to re-sync so
        // messages that arrived during the gap show without a manual refresh.
        if (connectedBefore) setLastMessage({ type: 'WS_RECONNECTED', ts: Date.now() });
        connectedBefore = true;
      };

      socket.onmessage = (event) => {
        try { setLastMessage(JSON.parse(event.data)); }
        catch (e) { console.error('WS parse error', e); }
      };

      socket.onclose = () => {
        if (stopped) return;
        // Backoff 1s→2s→4s→8s→16s (capped) with jitter to avoid a thundering
        // herd of clients all reconnecting at the same instant after a redeploy.
        attempts += 1;
        const base = Math.min(16000, 1000 * 2 ** Math.min(attempts, 4));
        const delay = base + Math.floor(Math.random() * 1000);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        // onerror is followed by onclose; close now so onclose schedules reconnect.
        try { socket?.close(); } catch { /* ignore */ }
      };
    };

    connect();

    // Reconnect immediately when the tab returns to the foreground or the network
    // comes back — sleep/background/network-switch drop the socket silently.
    const kick = () => {
      if (stopped) return;
      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        attempts = 0;
        connect();
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') kick(); };
    window.addEventListener('online', kick);
    window.addEventListener('focus', kick);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('online', kick);
      window.removeEventListener('focus', kick);
      document.removeEventListener('visibilitychange', onVisible);
      try { socket?.close(); } catch { /* ignore */ }
    };
  }, []);

  return lastMessage;
}
