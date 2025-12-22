import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Comment, NodeData, EdgeData, CanvasState, Drawing, PenToolType, Tombstones, TextBox } from '../types';
import { clampEnergy, computeEffectiveEnergy, relu } from '../utils/energy';
import { debugLog } from '../utils/debug';
import { getGuestIdentity } from '../utils/guestIdentity';

type UndoSnapshot = {
    nodes: NodeData[];
    edges: EdgeData[];
    drawings: Drawing[];
    textBoxes: TextBox[];
    tombstones: Tombstones;
};

const ts = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const clampProgress = (x: unknown) => Math.min(100, Math.max(0, Number.isFinite(Number(x)) ? Number(x) : 0));
const statusFromProgress = (progress: number) => {
    if (progress >= 100) return 'done' as const;
    if (progress <= 0) return 'queued' as const;
    return 'in_progress' as const;
};
const progressFromStatus = (status?: NodeData['status'], legacyInWork?: boolean) => {
    if (status === 'done') return 100;
    if (status === 'in_progress') return 50;
    if (status === 'queued') return 0;
    if (legacyInWork) return 50;
    return 0;
};
const tombstoneFor = (now: number, updatedAt?: number) => Math.max(now, ts(updatedAt) + 1);

const resolveAuthor = (state: AppState) => {
    const me = state.me;
    if (me?.id) {
        const name = (me.name || me.email || 'User').trim();
        return { authorId: me.id, authorName: name || 'User' };
    }
    const selfId = state.presence?.selfId ?? null;
    const selfPeer = selfId ? state.presence.peers.find((p) => p.id === selfId) : null;
    const seed = selfPeer?.avatarSeed ?? '';
    const fallback = selfPeer?.name ?? 'Guest';
    const guestName = getGuestIdentity(seed, fallback).name;
    return { authorId: null, authorName: guestName };
};

const withAuthor = <T extends { authorId?: string | null; authorName?: string | null }>(state: AppState, data: T) => {
    const hasName = typeof data.authorName === 'string' && data.authorName.trim().length > 0;
    const hasId = typeof data.authorId === 'string' && data.authorId.trim().length > 0;
    if (hasName || hasId) return data;
    return { ...data, ...resolveAuthor(state) };
};

const resolveCommentAuthor = (state: AppState) => {
    const me = state.me;
    if (me?.id) {
        const name = (me.name || me.email || 'User').trim();
        return {
            authorId: me.id,
            authorName: name || 'User',
            avatarUrl: me.avatarUrl ?? null,
            avatarAnimal: Number.isFinite(me.avatarAnimal) ? me.avatarAnimal ?? null : null,
            avatarColor: Number.isFinite(me.avatarColor) ? me.avatarColor ?? null : null,
        };
    }
    const selfId = state.presence?.selfId ?? null;
    const selfPeer = selfId ? state.presence.peers.find((p) => p.id === selfId) : null;
    const seed = selfPeer?.avatarSeed ?? '';
    const fallback = selfPeer?.name ?? 'Guest';
    const guestName = getGuestIdentity(seed, fallback).name;
    return {
        authorId: null,
        authorName: guestName,
        avatarUrl: null,
        avatarAnimal: Number.isFinite(selfPeer?.avatarAnimal) ? selfPeer?.avatarAnimal ?? null : null,
        avatarColor: Number.isFinite(selfPeer?.avatarColor) ? selfPeer?.avatarColor ?? null : null,
    };
};

interface AppState {
    nodes: NodeData[];
    edges: EdgeData[];
    canvas: CanvasState;
    effectiveEnergy: Record<string, number>;
    tombstones: Tombstones;
    sessionId: string | null;
    sessionName: string | null;
    sessionSaved: boolean;
    sessionOwnerId: string | null;
    sessionExpiresAt: string | null;
    setSessionId: (id: string | null) => void;
    setSessionMeta: (meta: { name?: string | null; saved?: boolean; ownerId?: string | null; expiresAt?: string | null }) => void;
    textBoxes: TextBox[];
    comments: Comment[];
    editingTextBoxId: string | null;
    setEditingTextBoxId: (id: string | null) => void;
    selectedTextBoxId: string | null;
    selectTextBox: (id: string | null) => void;
    selectedTextBoxes: string[];

    selectedNode: string | null;
    selectedNodes: string[];
    selectedEdge: string | null;
    selectedEdges: string[];
    neighbors: Record<string, number>; // id -> distance (0 = selected, 1 = connected, etc.)

    moveMode: boolean;
    toggleMoveMode: () => void;
    snapMode: boolean;
    toggleSnapMode: () => void;
    focusMode: boolean;
    toggleFocusMode: () => void;
    monitoringMode: boolean;
    toggleMonitoringMode: () => void;
    authorshipMode: boolean;
    toggleAuthorshipMode: () => void;
    commentsMode: boolean;
    toggleCommentsMode: () => void;

    me: {
        id: string;
        email: string;
        name: string;
        avatarSeed: string;
        avatarUrl?: string | null;
        avatarAnimal?: number | null;
        avatarColor?: number | null;
        verified: boolean;
    } | null;
    setMe: (me: AppState['me']) => void;

    presence: {
        selfId: string | null;
        peers: {
            id: string;
            name: string;
            avatarSeed: string;
            avatarUrl?: string | null;
            avatarAnimal?: number | null;
            avatarColor?: number | null;
            registered: boolean;
        }[];
    };
    setPresence: (presence: AppState['presence']) => void;

    history: UndoSnapshot[];
    future: UndoSnapshot[];
    pushHistory: (snapshot?: UndoSnapshot) => void;
    undo: () => void;
    redo: () => void;

    // Actions
    addNode: (node: NodeData) => void;
    updateNode: (id: string, data: Partial<NodeData>) => void;
    deleteNode: (id: string) => void;
    addEdge: (edge: EdgeData) => void;
    updateEdge: (id: string, data: Partial<EdgeData>) => void;
    deleteEdge: (id: string) => void;
    setCanvasTransform: (x: number, y: number, scale: number) => void;

    physicsEnabled: boolean;
    togglePhysicsMode: () => void;
    selectNode: (id: string | null) => void;
    selectEdge: (id: string | null) => void;
    setMultiSelection: (sel: { nodes: string[]; edges?: string[]; textBoxes?: string[] }) => void;
    deleteSelection: () => void;

    connectionTargetId: string | null;
    setConnectionTargetId: (id: string | null) => void;

    // Pen Mode
    penMode: boolean;
    togglePenMode: () => void;
    penTool: PenToolType;
    setPenTool: (tool: PenToolType) => void;
    drawings: Drawing[];
    addDrawing: (drawing: Drawing) => void;
    removeDrawing: (id: string) => void;

    // Text tool
    textMode: boolean;
    toggleTextMode: () => void;
    addTextBox: (tb: TextBox) => void;
    updateTextBox: (id: string, data: Partial<TextBox>) => void;
    deleteTextBox: (id: string) => void;
    addComment: (comment: Comment) => void;

    theme: 'dark' | 'light';
    toggleTheme: () => void;

    snowEnabled: boolean;
    toggleSnow: () => void;
}

const snapshotOf = (state: Pick<AppState, 'nodes' | 'edges' | 'drawings' | 'textBoxes' | 'tombstones'>): UndoSnapshot => ({
    nodes: state.nodes,
    edges: state.edges,
    drawings: state.drawings,
    textBoxes: state.textBoxes,
    tombstones: state.tombstones,
});

const pushHistoryReducer = (state: AppState, snapshot?: UndoSnapshot) => {
    const entry = snapshot ?? snapshotOf(state);
    const nextHistory = [...state.history, entry];
    const history = nextHistory.length > 60 ? nextHistory.slice(nextHistory.length - 60) : nextHistory;
    return { history, future: [] as UndoSnapshot[] };
};

const normalizeEnergies = (nodes: NodeData[], edges: EdgeData[], opts?: { maxIterations?: number }) => {
    const maxIterations = opts?.maxIterations ?? 15;

    let working = nodes.map((n) => ({
        ...n,
        energy: clampEnergy(Number.isFinite(n.energy) ? n.energy : 50),
    }));

    let effective = computeEffectiveEnergy(working, edges);

    // Enforce: base energy + incoming energy <= 100 by reducing base energy if needed.
    // We iterate because reducing base can change effective energies, which changes incoming.
    for (let iter = 0; iter < maxIterations; iter++) {
        let changed = false;

        const incomingById: Record<string, number> = {};
        for (const edge of edges) {
            if (edge.energyEnabled === false) continue;
            const src = edge.source;
            const tgt = edge.target;
            const srcEff = relu(effective[src] ?? 0);
            incomingById[tgt] = (incomingById[tgt] ?? 0) + srcEff;
        }

        const nextNodes = working.map((n) => {
            const incoming = incomingById[n.id] ?? 0;
            const maxBase = Math.max(0, 100 - incoming);
            const nextEnergy = clampEnergy(Math.min(Number.isFinite(n.energy) ? n.energy : 50, maxBase));
            if (nextEnergy !== n.energy) changed = true;
            return nextEnergy === n.energy ? n : { ...n, energy: nextEnergy };
        });

        if (!changed) break;
        working = nextNodes;
        effective = computeEffectiveEnergy(working, edges);
    }

    return { nodes: working, effectiveEnergy: effective };
};

const effectiveForMode = (nodes: NodeData[], edges: EdgeData[], monitoringMode: boolean, fallback?: Record<string, number>) => {
    if (monitoringMode) return computeEffectiveEnergy(nodes, edges, { blockDoneTasks: true });
    return fallback ?? computeEffectiveEnergy(nodes, edges);
};

export const useStore = create<AppState>()(
    persist(
        (set, get) => ({
            nodes: [],
            edges: [],
            canvas: { x: 0, y: 0, scale: 1 },
            effectiveEnergy: {},
            tombstones: { nodes: {}, edges: {}, drawings: {}, textBoxes: {} },
            sessionId: null,
            sessionName: null,
            sessionSaved: false,
            sessionOwnerId: null,
            sessionExpiresAt: null,
            setSessionId: (id) => set({ sessionId: id }),
            setSessionMeta: (meta) => set((state) => ({
                sessionName: Object.prototype.hasOwnProperty.call(meta, 'name') ? meta.name ?? null : state.sessionName,
                sessionSaved: typeof meta.saved === 'boolean' ? meta.saved : state.sessionSaved,
                sessionOwnerId: Object.prototype.hasOwnProperty.call(meta, 'ownerId') ? meta.ownerId ?? null : state.sessionOwnerId,
                sessionExpiresAt: Object.prototype.hasOwnProperty.call(meta, 'expiresAt') ? meta.expiresAt ?? null : state.sessionExpiresAt,
            })),
            textBoxes: [],
            comments: [],
            editingTextBoxId: null,
            setEditingTextBoxId: (id) => set({ editingTextBoxId: id }),
            selectedTextBoxId: null,
            selectedTextBoxes: [],
            selectTextBox: (id) => {
                set({
                    selectedTextBoxId: id,
                    selectedTextBoxes: id ? [id] : [],
                    selectedNode: null,
                    selectedNodes: [],
                    selectedEdge: null,
                    selectedEdges: [],
                    neighbors: {},
                });
                debugLog({
                    type: 'select',
                    t: performance.now(),
                    kind: id ? 'textBox' : 'none',
                    id: id ?? null,
                    selection: { node: null, edge: null, textBox: id ?? null },
                });
            },

            selectedNode: null,
            selectedNodes: [],
            selectedEdge: null,
            selectedEdges: [],
            neighbors: {},

            moveMode: false,
            toggleMoveMode: () => set((state) => ({ moveMode: !state.moveMode })),
            snapMode: false,
            toggleSnapMode: () => set((state) => ({ snapMode: !state.snapMode })),
            focusMode: false,
            toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
            monitoringMode: false,
            toggleMonitoringMode: () =>
                set((state) => {
                    const next = !state.monitoringMode;
                    return {
                        monitoringMode: next,
                        effectiveEnergy: effectiveForMode(state.nodes, state.edges, next, state.effectiveEnergy),
                    };
                }),
            authorshipMode: false,
            toggleAuthorshipMode: () => set((state) => ({ authorshipMode: !state.authorshipMode })),
            commentsMode: false,
            toggleCommentsMode: () => set((state) => ({ commentsMode: !state.commentsMode })),

            me: null,
            setMe: (me) => set({ me }),

            presence: { selfId: null, peers: [] },
            setPresence: (presence) => set({ presence }),

            history: [],
            future: [],
            pushHistory: (snapshot) => set((state) => pushHistoryReducer(state, snapshot)),
	            undo: () => set((state) => {
	                if (state.history.length === 0) return {};
	                const prev = state.history[state.history.length - 1];
	                const history = state.history.slice(0, -1);
	                const future = [...state.future, snapshotOf(state)];
	                return {
	                    nodes: prev.nodes,
	                    edges: prev.edges,
	                    drawings: prev.drawings,
	                    textBoxes: prev.textBoxes,
	                    tombstones: prev.tombstones,
	                    history,
	                    future,
	                    selectedNode: null,
	                    selectedNodes: [],
	                    selectedEdge: null,
	                    selectedEdges: [],
	                    selectedTextBoxId: null,
	                    selectedTextBoxes: [],
	                    neighbors: {},
	                    connectionTargetId: null,
	                    editingTextBoxId: null,
	                    effectiveEnergy: effectiveForMode(prev.nodes, prev.edges, state.monitoringMode),
	                };
	            }),
	            redo: () => set((state) => {
	                if (state.future.length === 0) return {};
	                const next = state.future[state.future.length - 1];
	                const future = state.future.slice(0, -1);
	                const history = [...state.history, snapshotOf(state)];
	                return {
	                    nodes: next.nodes,
	                    edges: next.edges,
	                    drawings: next.drawings,
	                    textBoxes: next.textBoxes,
	                    tombstones: next.tombstones,
	                    history,
	                    future,
	                    selectedNode: null,
	                    selectedNodes: [],
	                    selectedEdge: null,
	                    selectedEdges: [],
	                    selectedTextBoxId: null,
	                    selectedTextBoxes: [],
	                    neighbors: {},
	                    connectionTargetId: null,
	                    editingTextBoxId: null,
	                    effectiveEnergy: effectiveForMode(next.nodes, next.edges, state.monitoringMode),
	                };
	            }),

            addNode: (node) => set((state) => {
                const now = Date.now();
                const base = withAuthor(state, node);
                const legacyInWork = (base as { inWork?: boolean }).inWork;
                const progress = base.type === 'task'
                    ? clampProgress(base.progress ?? progressFromStatus(base.status, legacyInWork))
                    : undefined;
                const status = base.type === 'task' ? statusFromProgress(progress ?? 0) : base.status;
                const normalized: NodeData = {
                    ...base,
                    status,
                    progress,
                    createdAt: base.createdAt ?? now,
                    updatedAt: base.updatedAt ?? now,
                };
                const nodes = [...state.nodes, normalized];
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    nodes: { ...state.tombstones.nodes },
                };
                delete tombstones.nodes[normalized.id];
                const normalizedEnergy = normalizeEnergies(nodes, state.edges);
                const effectiveEnergy = effectiveForMode(normalizedEnergy.nodes, state.edges, state.monitoringMode, normalizedEnergy.effectiveEnergy);
                return {
                    ...pushHistoryReducer(state),
                    nodes: normalizedEnergy.nodes,
                    tombstones,
                    effectiveEnergy,
                };
            }),

            updateNode: (id, data) => set((state) => {
                const now = Date.now();
                const nextData = { ...data } as Partial<NodeData>;
                if (Object.prototype.hasOwnProperty.call(nextData, 'energy')) {
                    nextData.energy = clampEnergy(Number(nextData.energy));
                }
                if (Object.prototype.hasOwnProperty.call(nextData, 'progress')) {
                    nextData.progress = clampProgress(nextData.progress);
                }
                const existing = state.nodes.find((node) => node.id === id);
                const legacyInWork = (existing as { inWork?: boolean } | undefined)?.inWork;
                if (Object.prototype.hasOwnProperty.call(nextData, 'type')) {
                    if (nextData.type === 'task') {
                        const progress = clampProgress(
                            nextData.progress ?? existing?.progress ?? progressFromStatus(nextData.status ?? existing?.status, legacyInWork),
                        );
                        nextData.progress = progress;
                        nextData.status = statusFromProgress(progress);
                    }
                    if (nextData.type === 'idea') {
                        nextData.status = undefined;
                        nextData.progress = undefined;
                    }
                }
                if ((existing?.type === 'task' || nextData.type === 'task') && Object.prototype.hasOwnProperty.call(nextData, 'progress')) {
                    const progress = clampProgress(nextData.progress);
                    nextData.progress = progress;
                    nextData.status = statusFromProgress(progress);
                }
                const nodes = state.nodes.map((node) => (node.id === id ? { ...node, ...nextData, updatedAt: now } : node));
                const hasEnergyUpdate = Object.prototype.hasOwnProperty.call(nextData, 'energy');
                const affectsMonitoring = state.monitoringMode && (
                    Object.prototype.hasOwnProperty.call(nextData, 'progress')
                    || Object.prototype.hasOwnProperty.call(nextData, 'status')
                    || Object.prototype.hasOwnProperty.call(nextData, 'type')
                );
                if (!hasEnergyUpdate && !affectsMonitoring) return { nodes };
                if (hasEnergyUpdate) {
                    const normalizedEnergy = normalizeEnergies(nodes, state.edges);
                    const effectiveEnergy = effectiveForMode(normalizedEnergy.nodes, state.edges, state.monitoringMode, normalizedEnergy.effectiveEnergy);
                    return { nodes: normalizedEnergy.nodes, effectiveEnergy };
                }
                const effectiveEnergy = effectiveForMode(nodes, state.edges, state.monitoringMode, state.effectiveEnergy);
                return { nodes, effectiveEnergy };
            }),

            deleteNode: (id) => set((state) => {
                const now = Date.now();
                const node = state.nodes.find((n) => n.id === id);
                const nodes = state.nodes.filter((node) => node.id !== id);
                const removedEdges = state.edges.filter((edge) => edge.source === id || edge.target === id);
                const edges = state.edges.filter((edge) => edge.source !== id && edge.target !== id);
                const tombstoneNode = tombstoneFor(now, node?.updatedAt);
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    nodes: { ...state.tombstones.nodes, [id]: tombstoneNode },
                    edges: { ...state.tombstones.edges },
                    drawings: { ...state.tombstones.drawings },
                    textBoxes: { ...state.tombstones.textBoxes },
                };
                for (const e of removedEdges) {
                    tombstones.edges[e.id] = tombstoneFor(now, e.updatedAt);
                }
                debugLog({ type: 'delete_call', t: performance.now(), kind: 'node', id, now, updatedAt: node?.updatedAt, tombstone: tombstoneNode });
                return {
                    ...pushHistoryReducer(state),
                    nodes,
                    edges,
                    tombstones,
                    effectiveEnergy: effectiveForMode(nodes, edges, state.monitoringMode),
                };
            }),

            addEdge: (edge) => set((state) => {
                const now = Date.now();
                const base = withAuthor(state, edge);
                const normalized: EdgeData = {
                    ...base,
                    energyEnabled: base.energyEnabled !== false,
                    createdAt: base.createdAt ?? now,
                    updatedAt: base.updatedAt ?? now,
                };
                const edges = [...state.edges, normalized];
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    edges: { ...state.tombstones.edges },
                };
                delete tombstones.edges[normalized.id];
                const normalizedEnergy = normalizeEnergies(state.nodes, edges);
                const effectiveEnergy = effectiveForMode(normalizedEnergy.nodes, edges, state.monitoringMode, normalizedEnergy.effectiveEnergy);
                return {
                    ...pushHistoryReducer(state),
                    edges,
                    nodes: normalizedEnergy.nodes,
                    tombstones,
                    effectiveEnergy,
                };
            }),

            updateEdge: (id, data) =>
                set((state) => {
                    const now = Date.now();
                    const edges = state.edges.map((e) => (e.id === id ? { ...e, ...data, updatedAt: now } : e));
                    const normalizedEnergy = normalizeEnergies(state.nodes, edges);
                    const effectiveEnergy = effectiveForMode(normalizedEnergy.nodes, edges, state.monitoringMode, normalizedEnergy.effectiveEnergy);
                    return {
                        edges,
                        nodes: normalizedEnergy.nodes,
                        effectiveEnergy,
                    };
                }),

            deleteEdge: (id) => set((state) => {
                const now = Date.now();
                const edge = state.edges.find((e) => e.id === id);
                const edges = state.edges.filter((edge) => edge.id !== id);
                const tombstoneEdge = tombstoneFor(now, edge?.updatedAt);
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    edges: { ...state.tombstones.edges, [id]: tombstoneEdge },
                };
                debugLog({ type: 'delete_call', t: performance.now(), kind: 'edge', id, now, updatedAt: edge?.updatedAt, tombstone: tombstoneEdge });
                const normalizedEnergy = normalizeEnergies(state.nodes, edges);
                const effectiveEnergy = effectiveForMode(normalizedEnergy.nodes, edges, state.monitoringMode, normalizedEnergy.effectiveEnergy);
                return {
                    ...pushHistoryReducer(state),
                    edges,
                    nodes: normalizedEnergy.nodes,
                    tombstones,
                    effectiveEnergy,
                };
            }),

            setCanvasTransform: (x, y, scale) => set((state) => ({
                canvas: { ...state.canvas, x, y, scale },
            })),



            physicsEnabled: false,
            togglePhysicsMode: () => set((state) => ({ physicsEnabled: !state.physicsEnabled })),

            selectNode: (id) => {
                const state = get();
                if (!id) {
                    set({
                        selectedNode: null,
                        selectedNodes: [],
                        selectedEdge: null,
                        selectedEdges: [],
                        selectedTextBoxId: null,
                        selectedTextBoxes: [],
                        neighbors: {},
                    });
                    debugLog({
                        type: 'select',
                        t: performance.now(),
                        kind: 'none',
                        id: null,
                        selection: { node: null, edge: get().selectedEdge, textBox: null },
                    });
                    return;
                }

                // Clear edge selection when selecting a node
                set({
                    selectedEdge: null,
                    selectedEdges: [],
                    selectedTextBoxId: null,
                    selectedTextBoxes: [],
                    selectedNodes: [id],
                });

                // BFS for neighbors
                const neighbors: Record<string, number> = {};
                const queue: { id: string, dist: number }[] = [{ id, dist: 0 }];
                const visited = new Set<string>();

                while (queue.length > 0) {
                    const { id: curr, dist } = queue.shift()!;
                    if (visited.has(curr)) continue;
                    visited.add(curr);
                    neighbors[curr] = dist;

                    if (dist < 3) { // Max depth for highlighting
                        // Find connected edges
                        const connectedEdges = state.edges.filter(e => e.source === curr || e.target === curr);
                        for (const edge of connectedEdges) {
                            const neighborId = edge.source === curr ? edge.target : edge.source;
                            if (!visited.has(neighborId)) {
                                queue.push({ id: neighborId, dist: dist + 1 });
                            }
                        }
                    }
                }
                set({ selectedNode: id, neighbors });
                debugLog({
                    type: 'select',
                    t: performance.now(),
                    kind: 'node',
                    id,
                    selection: { node: id, edge: null, textBox: null },
                });
            },

            selectEdge: (id) => {
                if (id) {
                    set({
                        selectedEdge: id,
                        selectedEdges: [id],
                        selectedNode: null,
                        selectedNodes: [],
                        neighbors: {},
                        selectedTextBoxId: null,
                        selectedTextBoxes: [],
                    });
                    debugLog({
                        type: 'select',
                        t: performance.now(),
                        kind: 'edge',
                        id,
                        selection: { node: null, edge: id, textBox: null },
                    });
                } else {
                    set({ selectedEdge: null, selectedEdges: [] });
                    debugLog({
                        type: 'select',
                        t: performance.now(),
                        kind: 'none',
                        id: null,
                        selection: { node: get().selectedNode, edge: null, textBox: get().selectedTextBoxId },
                    });
                }
            },

            setMultiSelection: ({ nodes, edges, textBoxes }) => {
                const n = Array.from(new Set((nodes ?? []).filter(Boolean)));
                const e = Array.from(new Set((edges ?? []).filter(Boolean)));
                const t = Array.from(new Set((textBoxes ?? []).filter(Boolean)));
                set({
                    selectedNodes: n,
                    selectedEdges: e,
                    selectedTextBoxes: t,
                    selectedNode: n.length === 1 && e.length === 0 && t.length === 0 ? n[0] : null,
                    selectedEdge: e.length === 1 && n.length === 0 && t.length === 0 ? e[0] : null,
                    selectedTextBoxId: t.length === 1 && n.length === 0 && e.length === 0 ? t[0] : null,
                    neighbors: {},
                });
                debugLog({
                    type: 'select',
                    t: performance.now(),
                    kind: (n.length + e.length + t.length) > 1 ? 'none' : n.length === 1 ? 'node' : e.length === 1 ? 'edge' : t.length === 1 ? 'textBox' : 'none',
                    id: (n.length === 1 ? n[0] : e.length === 1 ? e[0] : t.length === 1 ? t[0] : null),
                    selection: { node: n.length === 1 ? n[0] : null, edge: e.length === 1 ? e[0] : null, textBox: t.length === 1 ? t[0] : null },
                });
            },

            deleteSelection: () => set((state) => {
                const now = Date.now();
                const selectedNodes = state.selectedNodes.length ? state.selectedNodes : (state.selectedNode ? [state.selectedNode] : []);
                const selectedEdges = state.selectedEdges.length ? state.selectedEdges : (state.selectedEdge ? [state.selectedEdge] : []);
                const selectedTextBoxes = state.selectedTextBoxes.length ? state.selectedTextBoxes : (state.selectedTextBoxId ? [state.selectedTextBoxId] : []);

                if (selectedNodes.length === 0 && selectedEdges.length === 0 && selectedTextBoxes.length === 0) return {};

                // Remove nodes + edges connected to removed nodes
                const removeNodeSet = new Set(selectedNodes);
                const removedEdgesByNode = state.edges.filter((e) => removeNodeSet.has(e.source) || removeNodeSet.has(e.target));
                const removeEdgeSet = new Set([...selectedEdges, ...removedEdgesByNode.map((e) => e.id)]);

                const nodes = state.nodes.filter((n) => !removeNodeSet.has(n.id));
                const edges = state.edges.filter((e) => !removeEdgeSet.has(e.id));
                const textBoxes = state.textBoxes.filter((tb) => !selectedTextBoxes.includes(tb.id));

                const tombstones: Tombstones = {
                    ...state.tombstones,
                    nodes: { ...state.tombstones.nodes },
                    edges: { ...state.tombstones.edges },
                    drawings: { ...state.tombstones.drawings },
                    textBoxes: { ...state.tombstones.textBoxes },
                };

                for (const nodeId of removeNodeSet) {
                    const node = state.nodes.find((n) => n.id === nodeId);
                    tombstones.nodes[nodeId] = tombstoneFor(now, node?.updatedAt);
                }
                for (const edgeId of removeEdgeSet) {
                    const edge = state.edges.find((e) => e.id === edgeId);
                    tombstones.edges[edgeId] = tombstoneFor(now, edge?.updatedAt);
                }
                for (const tbId of selectedTextBoxes) {
                    const tb = state.textBoxes.find((t) => t.id === tbId);
                    tombstones.textBoxes[tbId] = tombstoneFor(now, tb?.updatedAt);
                }

                const normalizedEnergy = normalizeEnergies(nodes, edges);
                const effectiveEnergy = effectiveForMode(normalizedEnergy.nodes, edges, state.monitoringMode, normalizedEnergy.effectiveEnergy);

                return {
                    ...pushHistoryReducer(state),
                    nodes: normalizedEnergy.nodes,
                    edges,
                    textBoxes,
                    tombstones,
                    effectiveEnergy,
                    selectedNode: null,
                    selectedNodes: [],
                    selectedEdge: null,
                    selectedEdges: [],
                    selectedTextBoxId: null,
                    selectedTextBoxes: [],
                    neighbors: {},
                    editingTextBoxId: null,
                };
            }),

            connectionTargetId: null,
            setConnectionTargetId: (id) => set({ connectionTargetId: id }),

            // Pen Mode Actions
            penMode: false,
            togglePenMode: () =>
                set((state) => {
                    const next = !state.penMode;
                    return next ? { penMode: true, textMode: false } : { penMode: false };
                }),
            penTool: 'pen',
            setPenTool: (tool) => set({ penTool: tool }),
            drawings: [],
            addDrawing: (drawing) => set((state) => {
                const now = Date.now();
                const base = withAuthor(state, drawing);
                const normalized: Drawing = {
                    ...base,
                    createdAt: base.createdAt ?? now,
                    updatedAt: base.updatedAt ?? now,
                };
                const drawings = [...state.drawings, normalized];
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    drawings: { ...state.tombstones.drawings },
                };
                delete tombstones.drawings[normalized.id];
                return { ...pushHistoryReducer(state), drawings, tombstones };
            }),
            removeDrawing: (id) => set((state) => {
                const now = Date.now();
                const drawing = state.drawings.find((d) => d.id === id);
                const drawings = state.drawings.filter(d => d.id !== id);
                const tombstoneDrawing = tombstoneFor(now, drawing?.updatedAt);
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    drawings: { ...state.tombstones.drawings, [id]: tombstoneDrawing },
                };
                debugLog({ type: 'delete_call', t: performance.now(), kind: 'drawing', id, now, updatedAt: drawing?.updatedAt, tombstone: tombstoneDrawing });
                return { ...pushHistoryReducer(state), drawings, tombstones };
            }),

            // Text tool
            textMode: false,
            toggleTextMode: () =>
                set((state) => {
                    const next = !state.textMode;
                    // Make tools mutually exclusive with Pen Mode.
                    return next ? { textMode: true, penMode: false } : { textMode: false };
                }),
            addTextBox: (tb) =>
                set((state) => {
                    const now = Date.now();
                    const base = withAuthor(state, tb);
                    const normalized: TextBox = {
                        ...base,
                        createdAt: base.createdAt ?? now,
                        updatedAt: base.updatedAt ?? now,
                        kind: base.kind ?? 'text',
                        text: String(base.text ?? ''),
                    };
                    const textBoxes = [...state.textBoxes, normalized];
                    const tombstones: Tombstones = {
                        ...state.tombstones,
                        textBoxes: { ...state.tombstones.textBoxes },
                    };
                    delete tombstones.textBoxes[normalized.id];
                    return {
                        ...pushHistoryReducer(state),
                        textBoxes,
                        tombstones,
                        editingTextBoxId: normalized.kind === 'image' ? null : normalized.id,
                        selectedTextBoxId: normalized.id,
                        selectedTextBoxes: [normalized.id],
                        selectedNode: null,
                        selectedNodes: [],
                        selectedEdge: null,
                        selectedEdges: [],
	                        neighbors: {},
	                    };
	                }),
            updateTextBox: (id, data) =>
                set((state) => {
                    const now = Date.now();
                    const textBoxes = state.textBoxes.map((t) => (t.id === id ? { ...t, ...data, updatedAt: now } : t));
                    return { textBoxes };
                }),
	            deleteTextBox: (id) =>
	                set((state) => {
                    const now = Date.now();
                    const tb = state.textBoxes.find((t) => t.id === id);
                    const textBoxes = state.textBoxes.filter((t) => t.id !== id);
                    const tombstoneTextBox = tombstoneFor(now, tb?.updatedAt);
                    const tombstones: Tombstones = {
                        ...state.tombstones,
                        textBoxes: { ...state.tombstones.textBoxes, [id]: tombstoneTextBox },
                    };
	                    debugLog({ type: 'delete_call', t: performance.now(), kind: 'textBox', id, now, updatedAt: tb?.updatedAt, tombstone: tombstoneTextBox });
	                    const editingTextBoxId = state.editingTextBoxId === id ? null : state.editingTextBoxId;
	                    const selectedTextBoxId = state.selectedTextBoxId === id ? null : state.selectedTextBoxId;
	                    const selectedTextBoxes = state.selectedTextBoxes.filter((x) => x !== id);
	                    return { ...pushHistoryReducer(state), textBoxes, tombstones, editingTextBoxId, selectedTextBoxId, selectedTextBoxes };
	                }),

            addComment: (comment) =>
                set((state) => {
                    const now = Date.now();
                    const author = resolveCommentAuthor(state);
                    const text = String(comment.text ?? '').trim();
                    const attachments = Array.isArray(comment.attachments) ? comment.attachments : [];
                    if (!text && attachments.length === 0) return {};
                    const normalized: Comment = {
                        ...author,
                        ...comment,
                        targetId: comment.targetId ?? null,
                        parentId: comment.parentId ?? null,
                        text,
                        attachments,
                        createdAt: comment.createdAt ?? now,
                        updatedAt: comment.updatedAt ?? now,
                    };
                    return { comments: [...state.comments, normalized] };
                }),

	            theme: 'dark',
	            toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
	            snowEnabled: false,
	            toggleSnow: () => set((state) => ({ snowEnabled: !state.snowEnabled })),

	        }),
	        {
	            name: 'living-canvas-storage',
	            version: 5,
	            partialize: (state) => ({
	                theme: state.theme,
	                penTool: state.penTool,
	                snowEnabled: state.snowEnabled,
	            }), // Don't persist canvas position/focus
	            migrate: (persisted: unknown, _version: number) => {
	                if (!persisted || typeof persisted !== 'object') return persisted as any;
	                const anyState = persisted as any;
	                return {
	                    theme: anyState.theme === 'light' ? 'light' : 'dark',
	                    penTool: anyState.penTool === 'eraser' || anyState.penTool === 'highlighter' ? anyState.penTool : 'pen',
	                    snowEnabled: !!anyState.snowEnabled,
	                };
	            },
	        }
	    )
	);
