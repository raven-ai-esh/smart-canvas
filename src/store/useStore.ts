import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Comment, NodeData, EdgeData, CanvasState, Drawing, LayerData, PenToolType, Tombstones, TextBox, SessionSaver } from '../types';
import { clampEnergy, computeEffectiveEnergy, relu } from '../utils/energy';
import { debugLog } from '../utils/debug';
import { getGuestIdentity } from '../utils/guestIdentity';
import { DEFAULT_LAYER_ID, normalizeLayers, resolveLayerId } from '../utils/layers';
import { collectLayerStackEntries, sortLayerStackEntries, type StackKind } from '../utils/stacking';
import { applyChildProgress } from '../utils/childProgress';

type UndoSnapshot = {
    nodes: NodeData[];
    edges: EdgeData[];
    drawings: Drawing[];
    textBoxes: TextBox[];
    layers: LayerData[];
    tombstones: Tombstones;
};

type StackMoveAction = 'up' | 'down' | 'top' | 'bottom';

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
    layers: LayerData[];
    activeLayerId: string;
    setActiveLayerId: (id: string) => void;
    addLayer: (name?: string) => string;
    renameLayer: (id: string, name: string) => void;
    toggleLayerVisibility: (id: string) => void;
    setLayerVisibility: (id: string, visible: boolean) => void;
    showAllLayers: () => void;
    mergeLayers: (layerIds: string[], targetId?: string) => void;
    deleteLayers: (layerIds: string[]) => void;
    canvas: CanvasState;
    effectiveEnergy: Record<string, number>;
    tombstones: Tombstones;
    sessionId: string | null;
    sessionName: string | null;
    sessionSaved: boolean;
    sessionOwnerId: string | null;
    sessionExpiresAt: string | null;
    sessionSavers: SessionSaver[];
    setSessionId: (id: string | null) => void;
    setSessionMeta: (meta: { name?: string | null; saved?: boolean; ownerId?: string | null; expiresAt?: string | null }) => void;
    setSessionSavers: (savers: SessionSaver[]) => void;
    canvasViewCommand: CanvasViewCommand | null;
    setCanvasViewCommand: (command: CanvasViewCommand | null) => void;
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
    deleteComment: (id: string) => void;
    moveStackItem: (kind: StackKind, id: string, action: StackMoveAction) => void;

    theme: 'dark' | 'light';
    toggleTheme: () => void;

    snowEnabled: boolean;
    toggleSnow: () => void;
}

type CanvasViewAction = 'focus_node' | 'zoom_to_cards' | 'zoom_to_graph' | 'zoom_to_fit' | 'pan';
type CanvasViewCommand = {
    id: string;
    action: CanvasViewAction;
    nodeId?: string | null;
    x?: number | null;
    y?: number | null;
    scale?: number | null;
};

const snapshotOf = (state: Pick<AppState, 'nodes' | 'edges' | 'drawings' | 'textBoxes' | 'layers' | 'tombstones'>): UndoSnapshot => ({
    nodes: state.nodes,
    edges: state.edges,
    drawings: state.drawings,
    textBoxes: state.textBoxes,
    layers: state.layers,
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

const initialLayers = normalizeLayers([]);
const initialActiveLayerId = resolveLayerId(initialLayers, null);

const nextLayerName = (layers: LayerData[]) => `Layer ${layers.length + 1}`;

const ensureActiveLayerVisible = (layers: LayerData[], activeLayerId: string) => {
    let changed = false;
    const next = layers.map((layer) => {
        if (layer.id !== activeLayerId || layer.visible) return layer;
        changed = true;
        return { ...layer, visible: true, updatedAt: Date.now() };
    });
    return changed ? next : layers;
};

const sanitizeSelections = (state: AppState, visibleLayerIds: Set<string>) => {
    const visibleNodeIds = new Set(
        state.nodes.filter((node) => visibleLayerIds.has(node.layerId ?? DEFAULT_LAYER_ID)).map((node) => node.id),
    );
    const visibleTextBoxIds = new Set(
        state.textBoxes.filter((tb) => visibleLayerIds.has(tb.layerId ?? DEFAULT_LAYER_ID)).map((tb) => tb.id),
    );
    const selectedNodes = state.selectedNodes.filter((id) => visibleNodeIds.has(id));
    const selectedTextBoxes = state.selectedTextBoxes.filter((id) => visibleTextBoxIds.has(id));
    const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null;
    const selectedTextBoxId = selectedTextBoxes.length === 1 ? selectedTextBoxes[0] : null;
    return {
        selectedNodes,
        selectedTextBoxes,
        selectedNode,
        selectedTextBoxId,
        selectedEdge: null,
        selectedEdges: [],
        neighbors: {},
    };
};

const stackableLayerId = (item: { layerId?: string | null }) => (
    typeof item.layerId === 'string' && item.layerId ? item.layerId : DEFAULT_LAYER_ID
);

const maxLayerZIndex = (state: Pick<AppState, 'nodes' | 'textBoxes' | 'comments'>, layerId: string) => {
    const rootComments = state.comments.filter((comment) => !comment.parentId);
    const entries = collectLayerStackEntries({
        nodes: state.nodes,
        textBoxes: state.textBoxes,
        comments: rootComments,
        layerId,
    });
    let max = -Infinity;
    for (const entry of entries) {
        if (typeof entry.zIndex === 'number' && Number.isFinite(entry.zIndex)) {
            max = Math.max(max, entry.zIndex);
        }
    }
    return max === -Infinity ? null : max;
};

const resolveStackItem = (state: Pick<AppState, 'nodes' | 'textBoxes' | 'comments'>, kind: StackKind, id: string) => {
    if (kind === 'node') return state.nodes.find((node) => node.id === id) ?? null;
    if (kind === 'textBox') return state.textBoxes.find((tb) => tb.id === id) ?? null;
    return state.comments.find((comment) => comment.id === id) ?? null;
};

export const useStore = create<AppState>()(
    persist(
        (set, get) => ({
            nodes: [],
            edges: [],
            layers: initialLayers,
            activeLayerId: initialActiveLayerId,
            canvas: { x: 0, y: 0, scale: 1 },
            effectiveEnergy: {},
            tombstones: { nodes: {}, edges: {}, drawings: {}, textBoxes: {}, comments: {}, layers: {} },
            setActiveLayerId: (id) => set((state) => {
                const resolved = resolveLayerId(state.layers, id);
                const layers = ensureActiveLayerVisible(state.layers, resolved);
                return { activeLayerId: resolved, layers };
            }),
            addLayer: (name) => {
                const now = Date.now();
                const nextName = typeof name === 'string' && name.trim() ? name.trim() : nextLayerName(get().layers);
                const id = crypto.randomUUID();
                const layer: LayerData = { id, name: nextName, visible: true, createdAt: now, updatedAt: now };
                set((state) => ({
                    ...pushHistoryReducer(state),
                    layers: [...state.layers, layer],
                    activeLayerId: id,
                }));
                return id;
            },
            renameLayer: (id, name) => set((state) => {
                const trimmed = name.trim();
                if (!trimmed) return {};
                let changed = false;
                const layers = state.layers.map((layer) => {
                    if (layer.id !== id) return layer;
                    if (layer.name === trimmed) return layer;
                    changed = true;
                    return { ...layer, name: trimmed, updatedAt: Date.now() };
                });
                if (!changed) return {};
                return { ...pushHistoryReducer(state), layers };
            }),
            toggleLayerVisibility: (id) => set((state) => {
                const target = state.layers.find((layer) => layer.id === id);
                if (!target) return {};
                const visibleCount = state.layers.filter((layer) => layer.visible).length;
                let nextVisible = target.visible;
                if (target.visible) {
                    if (visibleCount > 1) nextVisible = false;
                } else {
                    nextVisible = true;
                }
                if (nextVisible === target.visible) return {};
                const layers = state.layers.map((layer) => (
                    layer.id === id ? { ...layer, visible: nextVisible, updatedAt: Date.now() } : layer
                ));
                const activeLayerId = nextVisible ? state.activeLayerId : resolveLayerId(layers, state.activeLayerId);
                const visibleLayerIds = new Set(layers.filter((layer) => layer.visible).map((layer) => layer.id));
                return { layers, activeLayerId, ...sanitizeSelections(state, visibleLayerIds) };
            }),
            setLayerVisibility: (id, visible) => set((state) => {
                const target = state.layers.find((layer) => layer.id === id);
                if (!target || target.visible === visible) return {};
                const visibleCount = state.layers.filter((layer) => layer.visible).length;
                if (!visible && visibleCount <= 1) return {};
                const layers = state.layers.map((layer) => (
                    layer.id === id ? { ...layer, visible, updatedAt: Date.now() } : layer
                ));
                const activeLayerId = visible ? state.activeLayerId : resolveLayerId(layers, state.activeLayerId);
                const visibleLayerIds = new Set(layers.filter((layer) => layer.visible).map((layer) => layer.id));
                return { layers, activeLayerId, ...sanitizeSelections(state, visibleLayerIds) };
            }),
            showAllLayers: () => set((state) => {
                const layers = state.layers.map((layer) => (layer.visible ? layer : { ...layer, visible: true, updatedAt: Date.now() }));
                return { layers, ...sanitizeSelections(state, new Set(layers.map((layer) => layer.id))) };
            }),
            mergeLayers: (layerIds, targetId) => set((state) => {
                const unique = Array.from(new Set(layerIds.filter(Boolean)));
                if (unique.length < 2) return {};
                const resolvedTarget = resolveLayerId(state.layers, targetId ?? unique[0]);
                if (!unique.includes(resolvedTarget)) unique.push(resolvedTarget);
                const removeSet = new Set(unique.filter((id) => id !== resolvedTarget && id !== DEFAULT_LAYER_ID));
                if (removeSet.size === 0) return {};
                const now = Date.now();
                const moveSet = new Set(unique.filter((id) => id !== resolvedTarget));
                const nodes = state.nodes.map((node) => (
                    moveSet.has(node.layerId ?? DEFAULT_LAYER_ID) ? { ...node, layerId: resolvedTarget, updatedAt: now } : node
                ));
                const drawings = state.drawings.map((drawing) => (
                    moveSet.has(drawing.layerId ?? DEFAULT_LAYER_ID) ? { ...drawing, layerId: resolvedTarget, updatedAt: now } : drawing
                ));
                const textBoxes = state.textBoxes.map((tb) => (
                    moveSet.has(tb.layerId ?? DEFAULT_LAYER_ID) ? { ...tb, layerId: resolvedTarget, updatedAt: now } : tb
                ));
                const comments = state.comments.map((comment) => {
                    const commentLayerId = comment.layerId ?? DEFAULT_LAYER_ID;
                    if (moveSet.has(commentLayerId)) return { ...comment, layerId: resolvedTarget, updatedAt: now };
                    return comment;
                });
                const layers = state.layers.filter((layer) => !removeSet.has(layer.id)).map((layer) => (
                    layer.id === resolvedTarget ? { ...layer, updatedAt: now } : layer
                ));
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    layers: { ...state.tombstones.layers },
                };
                for (const id of removeSet) {
                    const layer = state.layers.find((l) => l.id === id);
                    tombstones.layers[id] = tombstoneFor(now, layer?.updatedAt);
                }
                return {
                    ...pushHistoryReducer(state),
                    nodes,
                    drawings,
                    textBoxes,
                    comments,
                    layers,
                    tombstones,
                    activeLayerId: resolvedTarget,
                    selectedNode: null,
                    selectedNodes: [],
                    selectedEdge: null,
                    selectedEdges: [],
                    selectedTextBoxId: null,
                    selectedTextBoxes: [],
                    neighbors: {},
                };
            }),
            deleteLayers: (layerIds) => set((state) => {
                const removeIds = Array.from(new Set(layerIds.filter((id) => id && id !== DEFAULT_LAYER_ID)));
                if (removeIds.length === 0) return {};
                const remaining = state.layers.filter((layer) => !removeIds.includes(layer.id));
                if (remaining.length === 0) return {};
                const now = Date.now();
                const removeSet = new Set(removeIds);
                const removeNodes = state.nodes.filter((node) => removeSet.has(node.layerId ?? DEFAULT_LAYER_ID));
                const removeNodeSet = new Set(removeNodes.map((node) => node.id));
                const removeEdges = state.edges.filter((edge) => removeNodeSet.has(edge.source) || removeNodeSet.has(edge.target));
                const removeEdgeSet = new Set(removeEdges.map((edge) => edge.id));
                const removeTextBoxes = state.textBoxes.filter((tb) => removeSet.has(tb.layerId ?? DEFAULT_LAYER_ID));
                const removeDrawings = state.drawings.filter((drawing) => removeSet.has(drawing.layerId ?? DEFAULT_LAYER_ID));
                const removeComments = state.comments.filter((comment) => {
                    const layerId = comment.layerId ?? DEFAULT_LAYER_ID;
                    if (removeSet.has(layerId)) return true;
                    if (comment.targetKind === 'node' && comment.targetId && removeNodeSet.has(comment.targetId)) return true;
                    return false;
                });
                const removeTextBoxSet = new Set(removeTextBoxes.map((tb) => tb.id));
                const removeDrawingSet = new Set(removeDrawings.map((drawing) => drawing.id));
                const removeCommentSet = new Set(removeComments.map((comment) => comment.id));
                const nodes = state.nodes.filter((node) => !removeNodeSet.has(node.id));
                const edges = state.edges.filter((edge) => !removeEdgeSet.has(edge.id));
                const textBoxes = state.textBoxes.filter((tb) => !removeTextBoxSet.has(tb.id));
                const drawings = state.drawings.filter((drawing) => !removeDrawingSet.has(drawing.id));
                const comments = state.comments.filter((comment) => !removeCommentSet.has(comment.id));
                const layers = remaining;
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    nodes: { ...state.tombstones.nodes },
                    edges: { ...state.tombstones.edges },
                    drawings: { ...state.tombstones.drawings },
                    textBoxes: { ...state.tombstones.textBoxes },
                    comments: { ...state.tombstones.comments },
                    layers: { ...state.tombstones.layers },
                };
                for (const node of removeNodes) tombstones.nodes[node.id] = tombstoneFor(now, node.updatedAt);
                for (const edge of removeEdges) tombstones.edges[edge.id] = tombstoneFor(now, edge.updatedAt);
                for (const drawing of removeDrawings) tombstones.drawings[drawing.id] = tombstoneFor(now, drawing.updatedAt);
                for (const tb of removeTextBoxes) tombstones.textBoxes[tb.id] = tombstoneFor(now, tb.updatedAt);
                for (const comment of removeComments) tombstones.comments[comment.id] = tombstoneFor(now, comment.updatedAt);
                for (const layerId of removeSet) {
                    const layer = state.layers.find((l) => l.id === layerId);
                    tombstones.layers[layerId] = tombstoneFor(now, layer?.updatedAt);
                }
                const normalizedEnergy = normalizeEnergies(nodes, edges);
                const effectiveEnergy = effectiveForMode(normalizedEnergy.nodes, edges, state.monitoringMode, normalizedEnergy.effectiveEnergy);
                const activeLayerId = resolveLayerId(layers, state.activeLayerId);
                return {
                    ...pushHistoryReducer(state),
                    nodes: normalizedEnergy.nodes,
                    edges,
                    drawings,
                    textBoxes,
                    comments,
                    layers,
                    tombstones,
                    effectiveEnergy,
                    activeLayerId,
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
            sessionId: null,
            sessionName: null,
            sessionSaved: false,
            sessionOwnerId: null,
            sessionExpiresAt: null,
            sessionSavers: [],
            setSessionId: (id) => set({ sessionId: id }),
            setSessionMeta: (meta) => set((state) => ({
                sessionName: Object.prototype.hasOwnProperty.call(meta, 'name') ? meta.name ?? null : state.sessionName,
                sessionSaved: typeof meta.saved === 'boolean' ? meta.saved : state.sessionSaved,
                sessionOwnerId: Object.prototype.hasOwnProperty.call(meta, 'ownerId') ? meta.ownerId ?? null : state.sessionOwnerId,
                sessionExpiresAt: Object.prototype.hasOwnProperty.call(meta, 'expiresAt') ? meta.expiresAt ?? null : state.sessionExpiresAt,
            })),
            setSessionSavers: (savers) => set({ sessionSavers: Array.isArray(savers) ? savers : [] }),
            canvasViewCommand: null,
            setCanvasViewCommand: (command) => set({ canvasViewCommand: command }),
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
                    layers: prev.layers,
                    activeLayerId: resolveLayerId(prev.layers, state.activeLayerId),
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
                    layers: next.layers,
                    activeLayerId: resolveLayerId(next.layers, state.activeLayerId),
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
                const layerId = resolveLayerId(state.layers, base.layerId ?? state.activeLayerId);
                const nextZ = maxLayerZIndex(state, layerId);
                const legacyInWork = (base as { inWork?: boolean }).inWork;
                const progress = base.type === 'task'
                    ? clampProgress(base.progress ?? progressFromStatus(base.status, legacyInWork))
                    : undefined;
                const status = base.type === 'task' ? statusFromProgress(progress ?? 0) : base.status;
                const normalized: NodeData = {
                    ...base,
                    layerId,
                    zIndex: Number.isFinite(base.zIndex) ? base.zIndex : (nextZ !== null ? nextZ + 1 : undefined),
                    status,
                    progress,
                    createdAt: base.createdAt ?? now,
                    updatedAt: base.updatedAt ?? now,
                };
                const nodes = [...state.nodes, normalized];
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    nodes: { ...state.tombstones.nodes },
                    comments: { ...state.tombstones.comments },
                    layers: { ...state.tombstones.layers },
                };
                delete tombstones.nodes[normalized.id];
                const normalizedEnergy = normalizeEnergies(nodes, state.edges);
                const childProgressResult = applyChildProgress(normalizedEnergy.nodes, state.edges);
                const effectiveEnergy = effectiveForMode(
                    childProgressResult.nodes,
                    state.edges,
                    state.monitoringMode,
                    normalizedEnergy.effectiveEnergy,
                );
                return {
                    ...pushHistoryReducer(state),
                    nodes: childProgressResult.nodes,
                    tombstones,
                    effectiveEnergy,
                };
            }),

            updateNode: (id, data) => set((state) => {
                const now = Date.now();
                const nextData = { ...data } as Partial<NodeData>;
                if (Object.prototype.hasOwnProperty.call(nextData, 'layerId')) {
                    nextData.layerId = resolveLayerId(state.layers, nextData.layerId ?? null);
                }
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
                const hasEnergyUpdate = Object.prototype.hasOwnProperty.call(nextData, 'energy');
                const nodes = state.nodes.map((node) => (node.id === id ? { ...node, ...nextData, updatedAt: now } : node));
                let workingNodes = nodes;
                let normalizedEnergy: ReturnType<typeof normalizeEnergies> | null = null;
                if (hasEnergyUpdate) {
                    normalizedEnergy = normalizeEnergies(nodes, state.edges);
                    workingNodes = normalizedEnergy.nodes;
                }
                const childProgressResult = applyChildProgress(workingNodes, state.edges);
                const finalNodes = childProgressResult.nodes;
                const affectsMonitoring = state.monitoringMode && (
                    Object.prototype.hasOwnProperty.call(nextData, 'progress')
                    || Object.prototype.hasOwnProperty.call(nextData, 'status')
                    || Object.prototype.hasOwnProperty.call(nextData, 'type')
                    || childProgressResult.progressChanged
                );
                if (!hasEnergyUpdate && !affectsMonitoring) return { nodes: finalNodes };
                if (hasEnergyUpdate) {
                    const effectiveEnergy = effectiveForMode(
                        finalNodes,
                        state.edges,
                        state.monitoringMode,
                        normalizedEnergy?.effectiveEnergy,
                    );
                    return { nodes: finalNodes, effectiveEnergy };
                }
                const effectiveEnergy = effectiveForMode(finalNodes, state.edges, state.monitoringMode, state.effectiveEnergy);
                return { nodes: finalNodes, effectiveEnergy };
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
                    comments: { ...state.tombstones.comments },
                    layers: { ...state.tombstones.layers },
                };
                for (const e of removedEdges) {
                    tombstones.edges[e.id] = tombstoneFor(now, e.updatedAt);
                }
                debugLog({ type: 'delete_call', t: performance.now(), kind: 'node', id, now, updatedAt: node?.updatedAt, tombstone: tombstoneNode });
                const childProgressResult = applyChildProgress(nodes, edges);
                const effectiveEnergy = effectiveForMode(childProgressResult.nodes, edges, state.monitoringMode);
                return {
                    ...pushHistoryReducer(state),
                    nodes: childProgressResult.nodes,
                    edges,
                    tombstones,
                    effectiveEnergy,
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
                    comments: { ...state.tombstones.comments },
                    layers: { ...state.tombstones.layers },
                };
                delete tombstones.edges[normalized.id];
                const normalizedEnergy = normalizeEnergies(state.nodes, edges);
                const childProgressResult = applyChildProgress(normalizedEnergy.nodes, edges);
                const effectiveEnergy = effectiveForMode(
                    childProgressResult.nodes,
                    edges,
                    state.monitoringMode,
                    normalizedEnergy.effectiveEnergy,
                );
                return {
                    ...pushHistoryReducer(state),
                    edges,
                    nodes: childProgressResult.nodes,
                    tombstones,
                    effectiveEnergy,
                };
            }),

            updateEdge: (id, data) =>
                set((state) => {
                    const now = Date.now();
                    const edges = state.edges.map((e) => (e.id === id ? { ...e, ...data, updatedAt: now } : e));
                    const normalizedEnergy = normalizeEnergies(state.nodes, edges);
                    const childProgressResult = applyChildProgress(normalizedEnergy.nodes, edges);
                    const effectiveEnergy = effectiveForMode(
                        childProgressResult.nodes,
                        edges,
                        state.monitoringMode,
                        normalizedEnergy.effectiveEnergy,
                    );
                    return {
                        edges,
                        nodes: childProgressResult.nodes,
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
                    comments: { ...state.tombstones.comments },
                    layers: { ...state.tombstones.layers },
                };
                debugLog({ type: 'delete_call', t: performance.now(), kind: 'edge', id, now, updatedAt: edge?.updatedAt, tombstone: tombstoneEdge });
                const normalizedEnergy = normalizeEnergies(state.nodes, edges);
                const childProgressResult = applyChildProgress(normalizedEnergy.nodes, edges);
                const effectiveEnergy = effectiveForMode(
                    childProgressResult.nodes,
                    edges,
                    state.monitoringMode,
                    normalizedEnergy.effectiveEnergy,
                );
                return {
                    ...pushHistoryReducer(state),
                    edges,
                    nodes: childProgressResult.nodes,
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
                    comments: { ...state.tombstones.comments },
                    layers: { ...state.tombstones.layers },
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
                const layerId = resolveLayerId(state.layers, base.layerId ?? state.activeLayerId);
                const normalized: Drawing = {
                    ...base,
                    layerId,
                    createdAt: base.createdAt ?? now,
                    updatedAt: base.updatedAt ?? now,
                };
                const drawings = [...state.drawings, normalized];
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    drawings: { ...state.tombstones.drawings },
                    comments: { ...state.tombstones.comments },
                    layers: { ...state.tombstones.layers },
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
                    comments: { ...state.tombstones.comments },
                    layers: { ...state.tombstones.layers },
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
                    const layerId = resolveLayerId(state.layers, base.layerId ?? state.activeLayerId);
                    const nextZ = maxLayerZIndex(state, layerId);
                    const normalized: TextBox = {
                        ...base,
                        layerId,
                        zIndex: Number.isFinite(base.zIndex) ? base.zIndex : (nextZ !== null ? nextZ + 1 : undefined),
                        createdAt: base.createdAt ?? now,
                        updatedAt: base.updatedAt ?? now,
                        kind: base.kind ?? 'text',
                        text: String(base.text ?? ''),
                    };
                    const textBoxes = [...state.textBoxes, normalized];
                    const tombstones: Tombstones = {
                        ...state.tombstones,
                        textBoxes: { ...state.tombstones.textBoxes },
                        comments: { ...state.tombstones.comments },
                        layers: { ...state.tombstones.layers },
                    };
                    delete tombstones.textBoxes[normalized.id];
                    return {
                        ...pushHistoryReducer(state),
                        textBoxes,
                        tombstones,
                        editingTextBoxId: normalized.kind === 'image' || normalized.kind === 'file' ? null : normalized.id,
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
                    const nextData = { ...data } as Partial<TextBox>;
                    if (Object.prototype.hasOwnProperty.call(nextData, 'layerId')) {
                        nextData.layerId = resolveLayerId(state.layers, nextData.layerId ?? null);
                    }
                    const textBoxes = state.textBoxes.map((t) => (t.id === id ? { ...t, ...nextData, updatedAt: now } : t));
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
                        comments: { ...state.tombstones.comments },
                        layers: { ...state.tombstones.layers },
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
                    let inferredLayerId = comment.layerId ?? null;
                    if (!inferredLayerId && comment.targetKind === 'node' && comment.targetId) {
                        const node = state.nodes.find((n) => n.id === comment.targetId);
                        inferredLayerId = node?.layerId ?? null;
                    }
                    if (!inferredLayerId && comment.targetKind === 'textBox' && comment.targetId) {
                        const tb = state.textBoxes.find((t) => t.id === comment.targetId);
                        inferredLayerId = tb?.layerId ?? null;
                    }
                    const layerId = resolveLayerId(state.layers, inferredLayerId ?? state.activeLayerId);
                    const isRoot = !comment.parentId;
                    const nextZ = isRoot ? maxLayerZIndex(state, layerId) : null;
                    const normalized: Comment = {
                        ...author,
                        ...comment,
                        layerId,
                        zIndex: Number.isFinite(comment.zIndex) ? comment.zIndex : (nextZ !== null ? nextZ + 1 : undefined),
                        targetId: comment.targetId ?? null,
                        parentId: comment.parentId ?? null,
                        text,
                        attachments,
                        createdAt: comment.createdAt ?? now,
                        updatedAt: comment.updatedAt ?? now,
                    };
                    const tombstones: Tombstones = {
                        ...state.tombstones,
                        comments: { ...state.tombstones.comments },
                        layers: { ...state.tombstones.layers },
                    };
                    delete tombstones.comments[normalized.id];
                    return { comments: [...state.comments, normalized], tombstones };
                }),
            deleteComment: (id) =>
                set((state) => {
                    if (!id) return {};
                    const now = Date.now();
                    const hasTarget = state.comments.some((comment) => comment.id === id);
                    if (!hasTarget) return {};
                    const childrenByParent = new Map<string, string[]>();
                    state.comments.forEach((comment) => {
                        if (!comment.parentId) return;
                        const list = childrenByParent.get(comment.parentId) ?? [];
                        list.push(comment.id);
                        childrenByParent.set(comment.parentId, list);
                    });
                    const toDelete = new Set<string>();
                    const stack = [id];
                    while (stack.length > 0) {
                        const next = stack.pop();
                        if (!next || toDelete.has(next)) continue;
                        toDelete.add(next);
                        const children = childrenByParent.get(next);
                        if (children && children.length) stack.push(...children);
                    }
                    if (toDelete.size === 0) return {};
                    const comments = state.comments.filter((comment) => !toDelete.has(comment.id));
                    const tombstones: Tombstones = {
                        ...state.tombstones,
                        comments: { ...state.tombstones.comments },
                        layers: { ...state.tombstones.layers },
                    };
                    state.comments.forEach((comment) => {
                        if (!toDelete.has(comment.id)) return;
                        tombstones.comments[comment.id] = tombstoneFor(now, comment.updatedAt);
                    });
                    return { comments, tombstones };
                }),

            moveStackItem: (kind, id, action) => set((state) => {
                if (!id) return {};
                const target = resolveStackItem(state, kind, id);
                if (!target) return {};
                const layerId = stackableLayerId(target);
                const rootComments = state.comments.filter((comment) => !comment.parentId);
                const entries = sortLayerStackEntries(collectLayerStackEntries({
                    nodes: state.nodes,
                    textBoxes: state.textBoxes,
                    comments: rootComments,
                    layerId,
                }));
                if (entries.length < 2) return {};
                const index = entries.findIndex((entry) => entry.kind === kind && entry.id === id);
                if (index < 0) return {};
                let nextIndex = index;
                if (action === 'up') nextIndex = Math.min(entries.length - 1, index + 1);
                if (action === 'down') nextIndex = Math.max(0, index - 1);
                if (action === 'top') nextIndex = entries.length - 1;
                if (action === 'bottom') nextIndex = 0;
                if (nextIndex === index) return {};

                const nextEntries = entries.slice();
                const [moved] = nextEntries.splice(index, 1);
                nextEntries.splice(nextIndex, 0, moved);

                const nodeUpdates = new Map<string, number>();
                const textBoxUpdates = new Map<string, number>();
                const commentUpdates = new Map<string, number>();
                nextEntries.forEach((entry, idx) => {
                    if (entry.item.zIndex === idx) return;
                    if (entry.kind === 'node') nodeUpdates.set(entry.id, idx);
                    else if (entry.kind === 'textBox') textBoxUpdates.set(entry.id, idx);
                    else commentUpdates.set(entry.id, idx);
                });

                if (!nodeUpdates.size && !textBoxUpdates.size && !commentUpdates.size) return {};
                const now = Date.now();
                const nodes = nodeUpdates.size
                    ? state.nodes.map((node) => (
                        nodeUpdates.has(node.id) ? { ...node, zIndex: nodeUpdates.get(node.id), updatedAt: now } : node
                    ))
                    : state.nodes;
                const textBoxes = textBoxUpdates.size
                    ? state.textBoxes.map((tb) => (
                        textBoxUpdates.has(tb.id) ? { ...tb, zIndex: textBoxUpdates.get(tb.id), updatedAt: now } : tb
                    ))
                    : state.textBoxes;
                const comments = commentUpdates.size
                    ? state.comments.map((comment) => (
                        commentUpdates.has(comment.id) ? { ...comment, zIndex: commentUpdates.get(comment.id), updatedAt: now } : comment
                    ))
                    : state.comments;
                return { ...pushHistoryReducer(state), nodes, textBoxes, comments };
            }),

            theme: 'dark',
            toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
            snowEnabled: false,
	            toggleSnow: () => set((state) => ({ snowEnabled: !state.snowEnabled })),

	        }),
        {
            name: 'living-canvas-storage',
            version: 6,
            partialize: (state) => ({
                theme: state.theme,
                penTool: state.penTool,
                snowEnabled: state.snowEnabled,
                commentsMode: state.commentsMode,
                authorshipMode: state.authorshipMode,
            }), // Don't persist canvas position/focus
            migrate: (persisted: unknown, _version: number) => {
                if (!persisted || typeof persisted !== 'object') return persisted as any;
                const anyState = persisted as any;
                return {
                    theme: anyState.theme === 'light' ? 'light' : 'dark',
                    penTool: anyState.penTool === 'eraser' || anyState.penTool === 'highlighter' ? anyState.penTool : 'pen',
                    snowEnabled: !!anyState.snowEnabled,
                    commentsMode: !!anyState.commentsMode,
                    authorshipMode: !!anyState.authorshipMode,
                };
            },
        }
	    )
	);
