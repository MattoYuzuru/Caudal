import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { FleetNode } from './domain';
import type { Preferences } from './preferences';

type PendingRead = { controller: AbortController; invalidated: boolean };
export type SyncStatus = 'live' | 'polling' | 'connecting' | 'offline';
const streamPath = '/api/v1/fleet/events';
const unavailable = 'Не удалось связаться с Caudal. Проверьте подключение.';
const freshFor = 90_000;

function expiresAt(node: FleetNode) {
  return node.status === 'healthy' && node.last_seen ? Date.parse(node.last_seen) + freshFor : Infinity;
}

export function useFleetSync({ live, interval }: Pick<Preferences, 'live' | 'interval'>, onUnauthorized: () => void) {
  const [nodes, setNodes] = useState<FleetNode[]>([]);
  const [controlPlaneNodeId, setControlPlaneNodeId] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [serverClock, setServerClock] = useState<{ at: number; tick: number }>();
  const pending = useRef<PendingRead | undefined>(undefined);

  const refresh = useCallback(async function read(invalidated = false) {
    if (pending.current) {
      pending.current.invalidated ||= invalidated;
      return;
    }
    if (!navigator.onLine) {
      setError(unavailable);
      return;
    }
    const flight: PendingRead = { controller: new AbortController(), invalidated: false };
    pending.current = flight;
    setFetching(true);
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      flight.controller.abort();
    }, 8_000);
    try {
      const result = await api.fleet(flight.controller.signal);
      if (pending.current !== flight) return;
      setNodes(result.nodes ?? []);
      setControlPlaneNodeId(result.control_plane_node_id);
      const serverTime = Date.parse(result.server_time ?? '');
      setServerClock(Number.isFinite(serverTime) ? { at: serverTime, tick: performance.now() } : undefined);
      setUpdatedAt(Date.now());
      setError('');
    } catch (failure) {
      if (pending.current !== flight) return;
      if (failure instanceof ApiError && failure.status === 401) onUnauthorized();
      else if (timedOut) setError('Caudal не ответил вовремя. Повторите проверку связи.');
      else setError(failure instanceof Error ? failure.message : unavailable);
    } finally {
      window.clearTimeout(timeout);
      if (pending.current === flight) {
        pending.current = undefined;
        if (flight.invalidated && !document.hidden) void read();
        else setFetching(false);
      }
    }
  }, [onUnauthorized]);

  useEffect(() => {
    if (!serverClock) return;
    const next = nodes.reduce((earliest, node) => {
      const expires = expiresAt(node);
      return Number.isFinite(expires) ? Math.min(earliest, expires) : earliest;
    }, Infinity);
    if (!Number.isFinite(next)) return;
    const now = () => serverClock.at + performance.now() - serverClock.tick;
    const timer = window.setTimeout(() => {
      const expired = now();
      setNodes(current => current.map(node => expiresAt(node) <= expired ? { ...node, status: 'stale' } : node));
    }, Math.max(0, Math.ceil(next - now())) + 1);
    return () => window.clearTimeout(timer);
  }, [nodes, serverClock]);

  const cancel = useCallback(() => {
    pending.current?.controller.abort();
    pending.current = undefined;
  }, []);

  useEffect(() => {
    let stream: EventSource | undefined;
    let retry: number | undefined;
    let bootstrap: number | undefined;
    let backoff = 1_000;
    let needsRead = true;

    function disconnect() {
      stream?.close();
      stream = undefined;
      window.clearTimeout(retry);
      window.clearTimeout(bootstrap);
      retry = undefined;
      bootstrap = undefined;
    }

    function connect() {
      if (document.hidden || !navigator.onLine || stream || retry !== undefined) return;
      if (!live || typeof EventSource === 'undefined') {
        if (needsRead) void refresh();
        needsRead = false;
        return;
      }
      const source = new EventSource(streamPath);
      let receivedEvent = false;
      stream = source;
      if (needsRead) {
        bootstrap = window.setTimeout(() => {
          needsRead = false;
          void refresh();
        }, 500);
      }
      source.addEventListener('fleet', () => {
        if (stream !== source) return;
        window.clearTimeout(bootstrap);
        backoff = 1_000;
        needsRead = false;
        receivedEvent = true;
        setStreaming(true);
        void refresh(true);
      });
      source.onerror = () => {
        if (stream !== source) return;
        source.close();
        stream = undefined;
        window.clearTimeout(bootstrap);
        setStreaming(false);
        if (needsRead || receivedEvent) void refresh(receivedEvent);
        needsRead = false;
        retry = window.setTimeout(() => {
          retry = undefined;
          connect();
        }, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    }

    function resume() {
      window.clearTimeout(retry);
      retry = undefined;
      if (document.hidden || !navigator.onLine) return;
      needsRead = true;
      backoff = 1_000;
      if (stream) {
        window.clearTimeout(bootstrap);
        needsRead = false;
        void refresh();
      } else connect();
    }

    function visibility() {
      if (document.hidden) {
        disconnect();
        setStreaming(false);
      } else resume();
    }

    function offline() {
      disconnect();
      cancel();
      setFetching(false);
      setStreaming(false);
      setError(unavailable);
    }

    setStreaming(false);
    if (!navigator.onLine) offline();
    else resume();
    const poll = window.setInterval(() => {
      if (!document.hidden && navigator.onLine) void refresh();
    }, interval * 1_000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    return () => {
      disconnect();
      cancel();
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', offline);
    };
  }, [cancel, interval, live, refresh]);

  function accept(node: FleetNode) {
    cancel();
    setNodes(previous => [...previous.filter(item => item.id !== node.id), node]);
    void refresh();
  }

  const status: SyncStatus = error ? 'offline' : streaming ? 'live' : updatedAt ? 'polling' : 'connecting';
  return { nodes, controlPlaneNodeId, updatedAt, ready: updatedAt !== undefined, fetching, error, status, refresh, accept };
}
