import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { computeEffectiveEnergy } from '../utils/energy';
import { mergeSessionState, normalizeSessionState, type SessionState } from '../utils/sessionMerge';
import { debugLog } from '../utils/debug';

function getSessionIdFromUrl() {
  return new URLSearchParams(window.location.search).get('session');
}

function getResetFromUrl() {
  return new URLSearchParams(window.location.search).get('reset') === '1';
}

function clearResetInUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete('reset');
  window.history.replaceState({}, '', url.toString());
}

function pickSessionState(state: ReturnType<typeof useStore.getState>) {
  return {
    nodes: state.nodes,
    edges: state.edges,
    drawings: state.drawings,
    textBoxes: state.textBoxes,
    tombstones: state.tombstones,
  };
}

function applySessionState(state: SessionState) {
  const monitoringMode = useStore.getState().monitoringMode;
  useStore.setState({
    nodes: state.nodes as any,
    edges: state.edges as any,
    drawings: state.drawings as any,
    textBoxes: state.textBoxes as any,
    tombstones: state.tombstones,
    effectiveEnergy: computeEffectiveEnergy(state.nodes as any, state.edges as any, { blockDoneTasks: monitoringMode }),
    selectedNode: null,
    selectedNodes: [],
    selectedEdge: null,
    selectedEdges: [],
    selectedTextBoxId: null,
    selectedTextBoxes: [],
    editingTextBoxId: null,
  });
}

function getOrCreateClientId() {
  const key = 'living-canvas-client-id';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  window.localStorage.setItem(key, id);
  return id;
}

function stableSerialize(x: unknown) {
  // For our state shape (arrays/objects), JSON stringify is stable enough.
  return JSON.stringify(x);
}

type SessionMeta = {
  name: string | null;
  saved: boolean;
  ownerId: string | null;
  expiresAt: string | null;
};

function normalizeSessionMeta(raw: any): SessionMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  const ownerId = typeof raw.ownerId === 'string' ? raw.ownerId : null;
  const expiresAt = raw.expiresAt ? String(raw.expiresAt) : null;
  const saved = !!raw.saved || !!raw.savedAt;
  return { name, saved, ownerId, expiresAt };
}

export function useSessionSync() {
  const [sessionId, setSessionId] = useState<string | null>(() => getSessionIdFromUrl());
  const [resetRequested, setResetRequested] = useState<boolean>(() => getResetFromUrl());
  const clientId = useMemo(() => getOrCreateClientId(), []);
  const setSessionIdInStore = useStore((s) => s.setSessionId);
  const setSessionMeta = useStore((s) => s.setSessionMeta);

  const wsRef = useRef<WebSocket | null>(null);
  const applyingRemoteRef = useRef(false);
  const desiredStateRef = useRef<ReturnType<typeof pickSessionState> | null>(null);
  const desiredStateJsonRef = useRef<string | null>(null);
  const lastAppliedJsonRef = useRef<string | null>(null);
  const sendTimer = useRef<number | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);
  const resetRequestedRef = useRef(resetRequested);
  const activeSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    resetRequestedRef.current = resetRequested;
  }, [resetRequested]);

  useEffect(() => {
    setSessionIdInStore(sessionId);
  }, [sessionId, setSessionIdInStore]);

  useEffect(() => {
    const onPopState = () => {
      setSessionId(getSessionIdFromUrl());
      setResetRequested(getResetFromUrl());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (sessionId) return;

    let cancelled = false;
    (async () => {
      const res = await fetch('/api/settings/default-session');
      if (!res.ok) return;
      const data = await res.json();
      const id = typeof data?.id === 'string' ? data.id : null;
      if (!id) return;
      if (cancelled) return;

      const url = new URL(window.location.href);
      url.searchParams.set('session', id);
      url.searchParams.delete('reset');
      window.history.replaceState({}, '', url.toString());
      setResetRequested(false);
      setSessionId(id);
    })().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    if (activeSessionIdRef.current !== sessionId) {
      activeSessionIdRef.current = sessionId;
      useStore.setState({
        nodes: [] as any,
        edges: [] as any,
        drawings: [] as any,
        textBoxes: [] as any,
	        tombstones: { nodes: {}, edges: {}, drawings: {}, textBoxes: {} },
	        selectedNode: null,
	        selectedNodes: [],
	        selectedEdge: null,
	        selectedEdges: [],
	        selectedTextBoxId: null,
	        selectedTextBoxes: [],
	        neighbors: {},
	        connectionTargetId: null,
	        effectiveEnergy: {},
        history: [],
        future: [],
        editingTextBoxId: null,
        presence: { selfId: null, peers: [] },
      } as any);
      setSessionMeta({ name: null, saved: false, ownerId: null, expiresAt: null });
    }

    desiredStateRef.current = null;
    desiredStateJsonRef.current = null;
    lastAppliedJsonRef.current = null;

    const clearTimers = () => {
      if (sendTimer.current) window.clearTimeout(sendTimer.current);
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      sendTimer.current = null;
      reconnectTimer.current = null;
    };

    const applyRemote = (remote: SessionState, source: 'fetch' | 'ws_sync' | 'ws_update') => {
      applyingRemoteRef.current = true;
      try {
        const local = pickSessionState(useStore.getState());
        const next = resetRequestedRef.current ? remote : mergeSessionState(local, remote);
        debugLog({
          type: 'sync_apply',
          t: performance.now(),
          source,
          localCounts: { nodes: local.nodes.length, edges: local.edges.length, drawings: local.drawings.length, textBoxes: local.textBoxes.length },
          remoteCounts: { nodes: remote.nodes.length, edges: remote.edges.length, drawings: remote.drawings.length, textBoxes: remote.textBoxes.length },
          mergedCounts: { nodes: next.nodes.length, edges: next.edges.length, drawings: next.drawings.length, textBoxes: next.textBoxes.length },
          tombstones: {
            nodes: Object.keys(next.tombstones.nodes).length,
            edges: Object.keys(next.tombstones.edges).length,
            drawings: Object.keys(next.tombstones.drawings).length,
            textBoxes: Object.keys(next.tombstones.textBoxes).length,
          },
        });
        applySessionState(next);
        lastAppliedJsonRef.current = stableSerialize(pickSessionState(useStore.getState()));
      } finally {
        applyingRemoteRef.current = false;
      }

      if (resetRequestedRef.current) {
        clearResetInUrl();
        resetRequestedRef.current = false;
        setResetRequested(false);
      }
    };

    const fetchInitial = async () => {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (cancelled) return;
      const remote = normalizeSessionState(data?.state);
      const meta = normalizeSessionMeta(data?.meta);
      if (meta) setSessionMeta(meta);
      applyRemote(remote, 'fetch');
    };

    const flush = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!desiredStateRef.current || !desiredStateJsonRef.current) return;
      if (desiredStateJsonRef.current === lastAppliedJsonRef.current) return; // already in sync

      const requestId = crypto.randomUUID();
      debugLog({
        type: 'sync_send',
        t: performance.now(),
        requestId,
        counts: {
          nodes: desiredStateRef.current.nodes.length,
          edges: desiredStateRef.current.edges.length,
          drawings: desiredStateRef.current.drawings.length,
          textBoxes: desiredStateRef.current.textBoxes.length,
        },
        tombstones: {
          nodes: Object.keys(desiredStateRef.current.tombstones.nodes).length,
          edges: Object.keys(desiredStateRef.current.tombstones.edges).length,
          drawings: Object.keys(desiredStateRef.current.tombstones.drawings).length,
          textBoxes: Object.keys(desiredStateRef.current.tombstones.textBoxes).length,
        },
      });
      ws.send(
        JSON.stringify({
          type: 'update',
          clientId,
          requestId,
          state: desiredStateRef.current,
        }),
      );
    };

    const scheduleFlush = () => {
      if (sendTimer.current) window.clearTimeout(sendTimer.current);
      sendTimer.current = window.setTimeout(() => {
        flush();
      }, 80);
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimer.current) return;
      const attempt = reconnectAttempt.current++;
      const delay = Math.min(15000, 500 * Math.pow(2, attempt));
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        connectWs();
      }, delay);
    };

    const connectWs = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = `${proto}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}&clientId=${encodeURIComponent(clientId)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        reconnectAttempt.current = 0;
        flush();
      });

      ws.addEventListener('message', (evt) => {
        let msg: any;
        try {
          msg = JSON.parse(String(evt.data));
        } catch {
          return;
        }

        if (msg?.type === 'session_meta') {
          const meta = normalizeSessionMeta(msg?.meta);
          if (meta) setSessionMeta(meta);
          return;
        }

        if (msg?.type === 'presence') {
          const peers = Array.isArray(msg?.peers) ? msg.peers : [];
          useStore.getState().setPresence({
            selfId: typeof msg?.selfId === 'string' ? msg.selfId : null,
            peers: peers
              .filter((p: any) => p && typeof p === 'object')
              .map((p: any) => ({
                id: String(p.id ?? ''),
                name: String(p.name ?? 'Guest'),
                avatarSeed: String(p.avatarSeed ?? ''),
                avatarUrl: typeof p.avatarUrl === 'string' ? p.avatarUrl : null,
                registered: !!p.registered,
              }))
              .filter((p: any) => p.id),
          });
          return;
        }

        if (msg?.type !== 'sync' && msg?.type !== 'update') return;
        if (msg?.meta) {
          const meta = normalizeSessionMeta(msg.meta);
          if (meta) setSessionMeta(meta);
        }

        // Our server broadcasts updates to the sender as well. Applying those echoes would
        // reset local UI state (selection/editing) while typing, so treat them as an ACK.
        if (msg?.type === 'update' && typeof msg?.sourceClientId === 'string' && msg.sourceClientId === clientId) {
          // Mark "in sync" so unrelated store updates (presence, selection) don't trigger resends.
          lastAppliedJsonRef.current = desiredStateJsonRef.current ?? stableSerialize(pickSessionState(useStore.getState()));
          return;
        }
        const remote = normalizeSessionState(msg?.state);
        applyRemote(remote, msg.type === 'sync' ? 'ws_sync' : 'ws_update');

        // If we have local changes queued, try flushing again.
        scheduleFlush();
      });

      ws.addEventListener('close', () => {
        if (wsRef.current === ws) wsRef.current = null;
        scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        // some browsers only emit error without close; ensure we reconnect
        scheduleReconnect();
      });
    };

    fetchInitial().catch(() => undefined);
    connectWs();

    const onAuthChanged = () => {
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
    window.addEventListener('auth-changed', onAuthChanged);

    const unsubscribe = useStore.subscribe((state) => {
      if (applyingRemoteRef.current) return;
      const snapshot = pickSessionState(state);
      const json = stableSerialize(snapshot);
      desiredStateRef.current = snapshot;
      desiredStateJsonRef.current = json;
      scheduleFlush();
    });

    return () => {
      cancelled = true;
      window.removeEventListener('auth-changed', onAuthChanged);
      unsubscribe();
      clearTimers();
      if (wsRef.current) wsRef.current.close();
      wsRef.current = null;
    };
  }, [clientId, sessionId]);
}
