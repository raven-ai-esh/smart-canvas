import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { computeEffectiveEnergy } from '../utils/energy';
import { mergeSessionState, normalizeSessionState, type SessionState } from '../utils/sessionMerge';
import { debugLog } from '../utils/debug';
import html2canvas from 'html2canvas';

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
    comments: state.comments,
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
    comments: state.comments as any,
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
  const setSessionSavers = useStore((s) => s.setSessionSavers);

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
    if (!sessionId) {
      setSessionSavers([]);
      return;
    }
    let cancelled = false;
    setSessionSavers([]);

    const loadSavers = async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/savers`);
        if (!res.ok) {
          if (!cancelled) setSessionSavers([]);
          return;
        }
        const data = await res.json();
        const items: unknown[] = Array.isArray(data?.savers) ? data.savers : [];
        const normalized = items
          .map((item: any) => ({
            id: typeof item?.id === 'string' ? item.id : '',
            name: typeof item?.name === 'string' ? item.name : '',
            email: typeof item?.email === 'string' ? item.email : '',
            avatarSeed: typeof item?.avatarSeed === 'string' ? item.avatarSeed : '',
            avatarUrl: typeof item?.avatarUrl === 'string' ? item.avatarUrl : null,
            avatarAnimal: Number.isFinite(item?.avatarAnimal) ? Number(item.avatarAnimal) : null,
            avatarColor: Number.isFinite(item?.avatarColor) ? Number(item.avatarColor) : null,
            savedAt: item?.savedAt ? String(item.savedAt) : null,
          }))
          .filter((item: any) => item.id);
        if (!cancelled) setSessionSavers(normalized);
      } catch {
        if (!cancelled) setSessionSavers([]);
      }
    };

    loadSavers();
    const onAuthChanged = () => {
      loadSavers();
    };
    window.addEventListener('auth-changed', onAuthChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('auth-changed', onAuthChanged);
    };
  }, [sessionId, setSessionSavers]);

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
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: {} }),
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const id = typeof data?.id === 'string' ? data.id : null;
      if (!id || cancelled) return;

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
        comments: [] as any,
	        tombstones: { nodes: {}, edges: {}, drawings: {}, textBoxes: {}, comments: {} },
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

    const applyCanvasViewAction = (
      action: string,
      payload: { nodeId?: string | null; x?: number | null; y?: number | null; scale?: number | null } = {},
    ) => {
      if (typeof window === 'undefined' || typeof document === 'undefined') return false;
      const MIN_SCALE = 0.1;
      const MAX_SCALE = 5;
      const ZOOM_DETAIL = 1.12;
      const ZOOM_GRAPH = 0.58;
      const clampScale = (scale: number) => Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
      const getViewportMetrics = () => {
        const viewport = window.visualViewport;
        const width = viewport?.width ?? window.innerWidth;
        const height = viewport?.height ?? window.innerHeight;
        return { width, height, centerX: width / 2, centerY: height / 2 };
      };
      const centerOnWorldPoint = (worldX: number, worldY: number, targetScale: number) => {
        const { centerX, centerY } = getViewportMetrics();
        const nextScale = clampScale(targetScale);
        const nextX = centerX - worldX * nextScale;
        const nextY = centerY - worldY * nextScale;
        useStore.getState().setCanvasTransform(nextX, nextY, nextScale);
      };
      const applyZoomPreset = (targetScale: number) => {
        const { centerX, centerY } = getViewportMetrics();
        const canvas = useStore.getState().canvas;
        const worldX = (centerX - canvas.x) / canvas.scale;
        const worldY = (centerY - canvas.y) / canvas.scale;
        centerOnWorldPoint(worldX, worldY, targetScale);
      };
      const applyZoomToFit = () => {
        const st = useStore.getState();
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        const addRect = (x: number, y: number, width: number, height: number) => {
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + width);
          maxY = Math.max(maxY, y + height);
        };

        const getNodeSize = (id: string) => {
          const el = document.querySelector<HTMLElement>(`[data-node-rect="true"][data-node-rect-id="${id}"]`);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          const scale = Math.max(0.0001, useStore.getState().canvas.scale);
          return { width: rect.width / scale, height: rect.height / scale };
        };

        for (const node of st.nodes) {
          const size = getNodeSize(node.id) ?? { width: 240, height: 120 };
          addRect(node.x - size.width / 2, node.y - size.height / 2, size.width, size.height);
        }

        for (const box of st.textBoxes) {
          addRect(box.x, box.y, box.width, box.height);
        }

        for (const drawing of st.drawings) {
          const points = Array.isArray(drawing.points) ? drawing.points : [];
          if (points.length === 0) continue;
          let dMinX = Infinity;
          let dMinY = Infinity;
          let dMaxX = -Infinity;
          let dMaxY = -Infinity;
          for (const pt of points) {
            if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
            dMinX = Math.min(dMinX, pt.x);
            dMinY = Math.min(dMinY, pt.y);
            dMaxX = Math.max(dMaxX, pt.x);
            dMaxY = Math.max(dMaxY, pt.y);
          }
          if (!Number.isFinite(dMinX) || !Number.isFinite(dMinY) || !Number.isFinite(dMaxX) || !Number.isFinite(dMaxY)) continue;
          addRect(dMinX, dMinY, dMaxX - dMinX, dMaxY - dMinY);
        }

        for (const comment of st.comments) {
          if (comment.targetKind !== 'canvas') continue;
          const cx = comment.x;
          const cy = comment.y;
          if (typeof cx !== 'number' || typeof cy !== 'number') continue;
          const size = 24;
          addRect(cx - size / 2, cy - size / 2, size, size);
        }

        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return;

        const { width, height } = getViewportMetrics();
        const padding = 160;
        const viewW = Math.max(1, width - padding * 2);
        const viewH = Math.max(1, height - padding * 2);
        const boundsW = Math.max(1, maxX - minX);
        const boundsH = Math.max(1, maxY - minY);
        const targetScale = clampScale(Math.min(viewW / boundsW, viewH / boundsH));
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        centerOnWorldPoint(centerX, centerY, targetScale);
      };

      if (action === 'zoom_to_cards') {
        applyZoomPreset(ZOOM_DETAIL);
        return true;
      }
      if (action === 'zoom_to_graph') {
        applyZoomPreset(ZOOM_GRAPH);
        return true;
      }
      if (action === 'zoom_to_fit') {
        applyZoomToFit();
        return true;
      }
      if (action === 'pan') {
        const x = Number.isFinite(payload.x) ? Number(payload.x) : null;
        const y = Number.isFinite(payload.y) ? Number(payload.y) : null;
        if (x !== null && y !== null) {
          const targetScale = Number.isFinite(payload.scale)
            ? Number(payload.scale)
            : useStore.getState().canvas.scale;
          centerOnWorldPoint(x, y, targetScale);
          return true;
        }
        return false;
      }
      if (action === 'focus_node') {
        if (payload.nodeId) {
          const node = useStore.getState().nodes.find((candidate) => candidate.id === payload.nodeId);
          if (node) {
            centerOnWorldPoint(node.x, node.y, ZOOM_DETAIL);
            return true;
          }
        }
        return false;
      }
      return false;
    };

    const computeActiveBounds = () => {
      const st = useStore.getState();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      const addRect = (x: number, y: number, width: number, height: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
      };

      const getNodeSize = (id: string) => {
        const el = document.querySelector<HTMLElement>(`[data-node-rect="true"][data-node-rect-id="${id}"]`);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const scale = Math.max(0.0001, useStore.getState().canvas.scale);
        return { width: rect.width / scale, height: rect.height / scale };
      };

      for (const node of st.nodes) {
        const size = getNodeSize(node.id) ?? { width: 240, height: 120 };
        addRect(node.x - size.width / 2, node.y - size.height / 2, size.width, size.height);
      }

      for (const box of st.textBoxes) {
        addRect(box.x, box.y, box.width, box.height);
      }

      for (const drawing of st.drawings) {
        const points = Array.isArray(drawing.points) ? drawing.points : [];
        if (points.length === 0) continue;
        let dMinX = Infinity;
        let dMinY = Infinity;
        let dMaxX = -Infinity;
        let dMaxY = -Infinity;
        for (const pt of points) {
          if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
          dMinX = Math.min(dMinX, pt.x);
          dMinY = Math.min(dMinY, pt.y);
          dMaxX = Math.max(dMaxX, pt.x);
          dMaxY = Math.max(dMaxY, pt.y);
        }
        if (!Number.isFinite(dMinX) || !Number.isFinite(dMinY) || !Number.isFinite(dMaxX) || !Number.isFinite(dMaxY)) continue;
        addRect(dMinX, dMinY, dMaxX - dMinX, dMaxY - dMinY);
      }

      for (const comment of st.comments) {
        if (comment.targetKind !== 'canvas') continue;
        const cx = comment.x;
        const cy = comment.y;
        if (typeof cx !== 'number' || typeof cy !== 'number') continue;
        const size = 24;
        addRect(cx - size / 2, cy - size / 2, size, size);
      }

      if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
      return { minX, minY, maxX, maxY };
    };

    const captureActiveSnapshot = async (requestId: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      const container = document.querySelector<HTMLElement>('[data-canvas-root="true"]');
      if (!container) {
        ws.send(JSON.stringify({ type: 'canvas_snapshot_response', requestId, error: 'canvas_root_missing' }));
        return;
      }
      const bounds = computeActiveBounds();
      if (!bounds) {
        ws.send(JSON.stringify({ type: 'canvas_snapshot_response', requestId, error: 'no_objects' }));
        return;
      }

      const prev = useStore.getState().canvas;
      const { width, height } = (() => {
        const viewport = window.visualViewport;
        const w = viewport?.width ?? window.innerWidth;
        const h = viewport?.height ?? window.innerHeight;
        return { width: w, height: h };
      })();
      const padding = 140;
      const viewW = Math.max(1, width - padding * 2);
      const viewH = Math.max(1, height - padding * 2);
      const boundsW = Math.max(1, bounds.maxX - bounds.minX);
      const boundsH = Math.max(1, bounds.maxY - bounds.minY);
      const targetScale = Math.min(Math.max(Math.min(viewW / boundsW, viewH / boundsH), 0.1), 5);
      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;
      const nextX = width / 2 - centerX * targetScale;
      const nextY = height / 2 - centerY * targetScale;

      useStore.getState().setCanvasTransform(nextX, nextY, targetScale);

      const waitFrames = (count: number) => new Promise<void>((resolve) => {
        let remaining = count;
        const tick = () => {
          remaining -= 1;
          if (remaining <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      try {
        await waitFrames(2);
        const rect = container.getBoundingClientRect();
        const screenshotPadding = 24;
        const screenMinX = bounds.minX * targetScale + nextX - rect.left - screenshotPadding;
        const screenMinY = bounds.minY * targetScale + nextY - rect.top - screenshotPadding;
        const screenMaxX = bounds.maxX * targetScale + nextX - rect.left + screenshotPadding;
        const screenMaxY = bounds.maxY * targetScale + nextY - rect.top + screenshotPadding;
        const cropX = Math.max(0, Math.floor(screenMinX));
        const cropY = Math.max(0, Math.floor(screenMinY));
        const cropW = Math.max(1, Math.min(rect.width, Math.ceil(screenMaxX)) - cropX);
        const cropH = Math.max(1, Math.min(rect.height, Math.ceil(screenMaxY)) - cropY);
        const shot = await html2canvas(container, {
          backgroundColor: null,
          logging: false,
          useCORS: true,
          allowTaint: true,
          scale: window.devicePixelRatio || 1,
          x: cropX,
          y: cropY,
          width: cropW,
          height: cropH,
        });
        const dataUrl = shot.toDataURL('image/png');
        ws.send(JSON.stringify({
          type: 'canvas_snapshot_response',
          requestId,
          dataUrl,
          width: shot.width,
          height: shot.height,
        }));
      } catch (err) {
        ws.send(JSON.stringify({
          type: 'canvas_snapshot_response',
          requestId,
          error: err instanceof Error ? err.message : 'snapshot_failed',
        }));
      } finally {
        useStore.getState().setCanvasTransform(prev.x, prev.y, prev.scale);
      }
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
            comments: Object.keys(next.tombstones.comments).length,
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
        comments: Object.keys(desiredStateRef.current.tombstones.comments).length,
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

        if (msg?.type === 'canvas_view') {
          const action = typeof msg?.action === 'string' ? msg.action : null;
          if (action) {
            const nodeId = typeof msg?.nodeId === 'string' ? msg.nodeId : null;
            const x = Number.isFinite(msg?.x) ? Number(msg.x) : null;
            const y = Number.isFinite(msg?.y) ? Number(msg.y) : null;
            const scale = Number.isFinite(msg?.scale) ? Number(msg.scale) : null;
            const id = typeof crypto?.randomUUID === 'function'
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            useStore.getState().setCanvasViewCommand({ id, action, nodeId, x, y, scale });
            applyCanvasViewAction(action, { nodeId, x, y, scale });
          }
          return;
        }

        if (msg?.type === 'canvas_snapshot_request') {
          const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
          if (requestId) {
            void captureActiveSnapshot(requestId);
          }
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
                avatarAnimal: Number.isFinite(p.avatarAnimal) ? Number(p.avatarAnimal) : null,
                avatarColor: Number.isFinite(p.avatarColor) ? Number(p.avatarColor) : null,
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
