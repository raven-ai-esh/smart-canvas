import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Comment, NodeData, EdgeData, CanvasState, Drawing, LayerData, PenToolType, Tombstones, TextBox, SessionSaver, StackGroup, StackItemKind, StackItemRef } from '../types';
import type { AssistantSelectionContext } from '../types/assistant';
import { clampEnergy, computeEffectiveEnergy } from '../utils/energy';
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
    stacks: StackGroup[];
    layers: LayerData[];
    tombstones: Tombstones;
};

type StackMoveAction = 'up' | 'down' | 'top' | 'bottom';
type StackCollapsedSize = { width: number; height: number };

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
const STACK_CARD_WIDTH = 240;
const STACK_CARD_HEIGHT = 160;

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
    sessionShareToken: string | null;
    setSessionId: (id: string | null) => void;
    setSessionShareToken: (token: string | null) => void;
    setSessionMeta: (meta: { name?: string | null; saved?: boolean; ownerId?: string | null; expiresAt?: string | null }) => void;
    setSessionSavers: (savers: SessionSaver[]) => void;
    assistantSelectionContext: AssistantSelectionContext | null;
    setAssistantSelectionContext: (context: AssistantSelectionContext | null) => void;
    clearAssistantSelectionContext: () => void;
    canvasViewCommand: CanvasViewCommand | null;
    setCanvasViewCommand: (command: CanvasViewCommand | null) => void;
    textBoxes: TextBox[];
    comments: Comment[];
    stacks: StackGroup[];
    editingTextBoxId: string | null;
    setEditingTextBoxId: (id: string | null) => void;
    selectedTextBoxId: string | null;
    selectTextBox: (id: string | null) => void;
    selectedTextBoxes: string[];
    selectedStackId: string | null;
    selectStack: (id: string | null) => void;
    selectedStacks: string[];

    selectedNode: string | null;
    selectedNodes: string[];
    selectedEdge: string | null;
    selectedEdges: string[];
    selectedEdgeHandle: { edgeId: string; handleId: string } | null;
    neighbors: Record<string, number>; // id -> distance (0 = selected, 1 = connected, etc.)

    moveMode: boolean;
    toggleMoveMode: () => void;
    snapMode: boolean;
    toggleSnapMode: () => void;
    focusMode: boolean;
    toggleFocusMode: () => void;
    monitoringMode: boolean;
    toggleMonitoringMode: () => void;
    ganttMode: boolean;
    toggleGanttMode: () => void;
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
    selectEdgeHandle: (edgeId: string, handleId: string) => void;
    setSelectedEdgeHandle: (handle: { edgeId: string; handleId: string } | null) => void;
    setMultiSelection: (sel: { nodes: string[]; edges?: string[]; textBoxes?: string[]; stacks?: string[] }) => void;
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
    createStack: (items: Array<{ kind: StackItemKind; id: string }>, options?: { collapsedSize?: StackCollapsedSize }) => void;
    expandStack: (id: string) => void;
    collapseStack: (id: string, options?: { collapsedSize?: StackCollapsedSize }) => void;
    toggleStack: (id: string) => void;
    ungroupStack: (id: string) => void;
    updateStackTitle: (id: string, title: string) => void;
    moveStack: (id: string, delta: { dx: number; dy: number }) => void;

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

const snapshotOf = (state: Pick<AppState, 'nodes' | 'edges' | 'drawings' | 'textBoxes' | 'stacks' | 'layers' | 'tombstones'>): UndoSnapshot => ({
    nodes: state.nodes,
    edges: state.edges,
    drawings: state.drawings,
    textBoxes: state.textBoxes,
    stacks: state.stacks,
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
    const working = nodes.map((n) => ({
        ...n,
        energy: clampEnergy(Number.isFinite(n.energy) ? n.energy : 50),
    }));
    const effective = computeEffectiveEnergy(working, edges, { maxIterations: opts?.maxIterations });
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
        selectedEdgeHandle: null,
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

const stackItemKey = (item: { kind: StackItemKind; id: string }) => `${item.kind}:${item.id}`;

const resolveStackItemLayerId = (state: Pick<AppState, 'nodes' | 'textBoxes'>, item: { kind: StackItemKind; id: string }) => {
    if (item.kind === 'node') {
        const node = state.nodes.find((n) => n.id === item.id);
        return node ? stackableLayerId(node) : null;
    }
    const textBox = state.textBoxes.find((tb) => tb.id === item.id);
    return textBox ? stackableLayerId(textBox) : null;
};

const resolveStackItemPosition = (state: Pick<AppState, 'nodes' | 'textBoxes'>, item: { kind: StackItemKind; id: string }) => {
    if (item.kind === 'node') {
        const node = state.nodes.find((n) => n.id === item.id);
        return node ? { x: node.x, y: node.y, width: 0, height: 0 } : null;
    }
    const textBox = state.textBoxes.find((tb) => tb.id === item.id);
    return textBox ? { x: textBox.x, y: textBox.y, width: textBox.width, height: textBox.height } : null;
};

const resolveStackItemCenter = (state: Pick<AppState, 'textBoxes'>, item: StackItemRef) => {
    if (item.kind === 'node') return { x: item.x, y: item.y };
    const textBox = state.textBoxes.find((tb) => tb.id === item.id);
    const width = Number.isFinite(textBox?.width) ? (textBox!.width as number) : (item.width ?? 0);
    const height = Number.isFinite(textBox?.height) ? (textBox!.height as number) : (item.height ?? 0);
    return { x: item.x + width / 2, y: item.y + height / 2 };
};

const computeStackAnchor = (state: Pick<AppState, 'textBoxes'>, items: StackItemRef[]) => {
    if (items.length === 0) return { x: 0, y: 0 };
    let sumX = 0;
    let sumY = 0;
    items.forEach((item) => {
        const center = resolveStackItemCenter(state, item);
        sumX += center.x;
        sumY += center.y;
    });
    return { x: sumX / items.length, y: sumY / items.length };
};

const buildCollapsedOffsets = (count: number) => {
    const offsets: Array<{ x: number; y: number }> = [];
    if (count <= 1) return [{ x: 0, y: 0 }];
    const spreadX = 10;
    const spreadY = 7;
    const start = -(count - 1) / 2;
    for (let i = 0; i < count; i += 1) {
        offsets.push({ x: (start + i) * spreadX, y: (start + i) * spreadY });
    }
    return offsets;
};

const buildCollapsedPositionMap = (
    state: Pick<AppState, 'textBoxes'>,
    items: StackItemRef[],
    anchor: { x: number; y: number },
    collapsedSize?: { width: number; height: number },
) => {
    const offsets = buildCollapsedOffsets(items.length);
    const positions = new Map<string, { x: number; y: number }>();
    items.forEach((item, idx) => {
        const offset = offsets[idx] ?? { x: 0, y: 0 };
        const centerX = anchor.x + offset.x;
        const centerY = anchor.y + offset.y;
        if (item.kind === 'node') {
            positions.set(stackItemKey(item), { x: centerX, y: centerY });
            return;
        }
        const textBox = state.textBoxes.find((tb) => tb.id === item.id);
        if (!textBox) return;
        const width = collapsedSize?.width ?? textBox.width;
        const height = collapsedSize?.height ?? textBox.height;
        positions.set(stackItemKey(item), {
            x: centerX - width / 2,
            y: centerY - height / 2,
        });
    });
    return positions;
};

const resolveStackUniformSize = (size?: Partial<StackCollapsedSize>) => {
    const width = typeof size?.width === 'number' && Number.isFinite(size.width) && size.width > 0
        ? size.width
        : STACK_CARD_WIDTH;
    const height = typeof size?.height === 'number' && Number.isFinite(size.height) && size.height > 0
        ? size.height
        : STACK_CARD_HEIGHT;
    return { width, height };
};

const pruneStacks = (stacks: StackGroup[], nodes: NodeData[], textBoxes: TextBox[]) => {
    if (!stacks.length) return { stacks, removedStacks: [] as StackGroup[] };
    const nodeIds = new Set(nodes.map((node) => node.id));
    const textBoxIds = new Set(textBoxes.map((tb) => tb.id));
    const removedStacks: StackGroup[] = [];
    const nextStacks = stacks
        .map((stack) => {
            const nextItems = stack.items.filter((item) => (
                item.kind === 'node' ? nodeIds.has(item.id) : textBoxIds.has(item.id)
            ));
            if (nextItems.length < 2) {
                removedStacks.push(stack);
                return null;
            }
            if (nextItems.length === stack.items.length) return stack;
            return { ...stack, items: nextItems, updatedAt: Date.now() };
        })
        .filter(Boolean) as StackGroup[];
    return { stacks: nextStacks, removedStacks };
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
            tombstones: { nodes: {}, edges: {}, drawings: {}, textBoxes: {}, comments: {}, layers: {}, stacks: {} },
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
                const stacks = state.stacks.map((stack) => (
                    moveSet.has(stack.layerId ?? DEFAULT_LAYER_ID) ? { ...stack, layerId: resolvedTarget, updatedAt: now } : stack
                ));
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
                    stacks,
                    layers,
                    tombstones,
                    activeLayerId: resolvedTarget,
                    selectedNode: null,
                    selectedNodes: [],
                    selectedEdge: null,
                    selectedEdges: [],
                    selectedEdgeHandle: null,
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
                const pruneResult = pruneStacks(state.stacks, nodes, textBoxes);
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    nodes: { ...state.tombstones.nodes },
                    edges: { ...state.tombstones.edges },
                    drawings: { ...state.tombstones.drawings },
                    textBoxes: { ...state.tombstones.textBoxes },
                    comments: { ...state.tombstones.comments },
                    layers: { ...state.tombstones.layers },
                };
                if (pruneResult.removedStacks.length) {
                    tombstones.stacks = { ...state.tombstones.stacks };
                    pruneResult.removedStacks.forEach((stack) => {
                        tombstones.stacks[stack.id] = tombstoneFor(now, stack.updatedAt);
                    });
                }
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
                    stacks: pruneResult.stacks,
                    layers,
                    tombstones,
                    effectiveEnergy,
                    activeLayerId,
                    selectedNode: null,
                    selectedNodes: [],
                    selectedEdge: null,
                    selectedEdges: [],
                    selectedEdgeHandle: null,
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
            sessionShareToken: null,
            setSessionId: (id) => set({ sessionId: id }),
            setSessionShareToken: (token) => set({ sessionShareToken: token ?? null }),
            setSessionMeta: (meta) => set((state) => ({
                sessionName: Object.prototype.hasOwnProperty.call(meta, 'name') ? meta.name ?? null : state.sessionName,
                sessionSaved: typeof meta.saved === 'boolean' ? meta.saved : state.sessionSaved,
                sessionOwnerId: Object.prototype.hasOwnProperty.call(meta, 'ownerId') ? meta.ownerId ?? null : state.sessionOwnerId,
                sessionExpiresAt: Object.prototype.hasOwnProperty.call(meta, 'expiresAt') ? meta.expiresAt ?? null : state.sessionExpiresAt,
            })),
            setSessionSavers: (savers) => set({ sessionSavers: Array.isArray(savers) ? savers : [] }),
            assistantSelectionContext: null,
            setAssistantSelectionContext: (context) => set({ assistantSelectionContext: context }),
            clearAssistantSelectionContext: () => set({ assistantSelectionContext: null }),
            canvasViewCommand: null,
            setCanvasViewCommand: (command) => set({ canvasViewCommand: command }),
            textBoxes: [],
            comments: [],
            stacks: [],
            editingTextBoxId: null,
            setEditingTextBoxId: (id) => set({ editingTextBoxId: id }),
            selectedTextBoxId: null,
            selectedTextBoxes: [],
            selectTextBox: (id) => {
                set({
                    selectedTextBoxId: id,
                    selectedTextBoxes: id ? [id] : [],
                    selectedStackId: null,
                    selectedStacks: [],
                    selectedNode: null,
                    selectedNodes: [],
                    selectedEdge: null,
                    selectedEdges: [],
                    selectedEdgeHandle: null,
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
            selectedStackId: null,
            selectedStacks: [],
            selectStack: (id) => {
                set({
                    selectedStackId: id,
                    selectedStacks: id ? [id] : [],
                    selectedNode: null,
                    selectedNodes: [],
                    selectedEdge: null,
                    selectedEdges: [],
                    selectedEdgeHandle: null,
                    selectedTextBoxId: null,
                    selectedTextBoxes: [],
                    neighbors: {},
                });
                debugLog({
                    type: 'select',
                    t: performance.now(),
                    kind: id ? 'stack' : 'none',
                    id: id ?? null,
                    selection: { node: null, edge: null, textBox: null },
                });
            },

            selectedNode: null,
            selectedNodes: [],
            selectedEdge: null,
            selectedEdges: [],
            selectedEdgeHandle: null,
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
            ganttMode: false,
            toggleGanttMode: () => set((state) => {
                const next = !state.ganttMode;
                if (!next) return { ganttMode: false };
                return {
                    ganttMode: true,
                    penMode: false,
                    textMode: false,
                    moveMode: false,
                    snapMode: false,
                    focusMode: false,
                    monitoringMode: false,
                    effectiveEnergy: effectiveForMode(state.nodes, state.edges, false, state.effectiveEnergy),
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
                    stacks: prev.stacks,
                    layers: prev.layers,
                    activeLayerId: resolveLayerId(prev.layers, state.activeLayerId),
                    tombstones: prev.tombstones,
                    history,
                    future,
	                    selectedNode: null,
	                    selectedNodes: [],
	                    selectedEdge: null,
	                    selectedEdges: [],
	                    selectedEdgeHandle: null,
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
                    stacks: next.stacks,
                    layers: next.layers,
                    activeLayerId: resolveLayerId(next.layers, state.activeLayerId),
                    tombstones: next.tombstones,
                    history,
                    future,
	                    selectedNode: null,
	                    selectedNodes: [],
	                    selectedEdge: null,
	                    selectedEdges: [],
	                    selectedEdgeHandle: null,
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
                const stackPositionUpdate = Object.prototype.hasOwnProperty.call(nextData, 'x')
                    || Object.prototype.hasOwnProperty.call(nextData, 'y');
                if (stackPositionUpdate) {
                    const inCollapsedStack = state.stacks.some((stack) => (
                        stack.collapsed && stack.items.some((item) => item.kind === 'node' && item.id === id)
                    ));
                    if (inCollapsedStack) {
                        delete (nextData as Partial<NodeData>).x;
                        delete (nextData as Partial<NodeData>).y;
                    }
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
                if (Object.keys(nextData).length === 0) return {};
                const hasEnergyUpdate = Object.prototype.hasOwnProperty.call(nextData, 'energy');
                const nodes = state.nodes.map((node) => (node.id === id ? { ...node, ...nextData, updatedAt: now } : node));
                let nextStacks = state.stacks;
                const shouldUpdateStackPos = Object.prototype.hasOwnProperty.call(nextData, 'x')
                    || Object.prototype.hasOwnProperty.call(nextData, 'y');
                if (shouldUpdateStackPos) {
                    const updatedNode = nodes.find((node) => node.id === id);
                    if (updatedNode) {
                        let changed = false;
                        nextStacks = state.stacks.map((stack) => {
                            if (stack.collapsed) return stack;
                            const idx = stack.items.findIndex((item) => item.kind === 'node' && item.id === id);
                            if (idx < 0) return stack;
                            const nextItems = stack.items.slice();
                            nextItems[idx] = { ...nextItems[idx], x: updatedNode.x, y: updatedNode.y };
                            changed = true;
                            return { ...stack, items: nextItems, updatedAt: now };
                        });
                        if (!changed) nextStacks = state.stacks;
                    }
                }
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
                if (!hasEnergyUpdate && !affectsMonitoring) {
                    return nextStacks === state.stacks ? { nodes: finalNodes } : { nodes: finalNodes, stacks: nextStacks };
                }
                if (hasEnergyUpdate) {
                    const effectiveEnergy = effectiveForMode(
                        finalNodes,
                        state.edges,
                        state.monitoringMode,
                        normalizedEnergy?.effectiveEnergy,
                    );
                    return nextStacks === state.stacks
                        ? { nodes: finalNodes, effectiveEnergy }
                        : { nodes: finalNodes, effectiveEnergy, stacks: nextStacks };
                }
                const effectiveEnergy = effectiveForMode(finalNodes, state.edges, state.monitoringMode, state.effectiveEnergy);
                return nextStacks === state.stacks
                    ? { nodes: finalNodes, effectiveEnergy }
                    : { nodes: finalNodes, effectiveEnergy, stacks: nextStacks };
            }),

            deleteNode: (id) => set((state) => {
                const now = Date.now();
                const node = state.nodes.find((n) => n.id === id);
                const nodes = state.nodes.filter((node) => node.id !== id);
                const removedEdges = state.edges.filter((edge) => edge.source === id || edge.target === id);
                const edges = state.edges.filter((edge) => edge.source !== id && edge.target !== id);
                const pruneResult = pruneStacks(state.stacks, nodes, state.textBoxes);
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
                if (pruneResult.removedStacks.length) {
                    tombstones.stacks = { ...state.tombstones.stacks };
                    pruneResult.removedStacks.forEach((stack) => {
                        tombstones.stacks[stack.id] = tombstoneFor(now, stack.updatedAt);
                    });
                }
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
                    stacks: pruneResult.stacks,
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
                        selectedStackId: null,
                        selectedStacks: [],
                        selectedEdgeHandle: null,
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
                    selectedStackId: null,
                    selectedStacks: [],
                    selectedEdgeHandle: null,
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
                        selectedStackId: null,
                        selectedStacks: [],
                        selectedEdgeHandle: null,
                    });
                    debugLog({
                        type: 'select',
                        t: performance.now(),
                        kind: 'edge',
                        id,
                        selection: { node: null, edge: id, textBox: null },
                    });
                } else {
                    set({
                        selectedEdge: null,
                        selectedEdges: [],
                        selectedStackId: null,
                        selectedStacks: [],
                        selectedEdgeHandle: null,
                    });
                    debugLog({
                        type: 'select',
                        t: performance.now(),
                        kind: 'none',
                        id: null,
                        selection: { node: get().selectedNode, edge: null, textBox: get().selectedTextBoxId },
                    });
                }
            },

            selectEdgeHandle: (edgeId, handleId) => {
                set({
                    selectedEdge: edgeId,
                    selectedEdges: [edgeId],
                    selectedNode: null,
                    selectedNodes: [],
                    neighbors: {},
                    selectedTextBoxId: null,
                    selectedTextBoxes: [],
                    selectedStackId: null,
                    selectedStacks: [],
                    selectedEdgeHandle: { edgeId, handleId },
                });
            },

            setSelectedEdgeHandle: (handle) => set({ selectedEdgeHandle: handle }),

            setMultiSelection: ({ nodes, edges, textBoxes, stacks }) => {
                const n = Array.from(new Set((nodes ?? []).filter(Boolean)));
                const e = Array.from(new Set((edges ?? []).filter(Boolean)));
                const t = Array.from(new Set((textBoxes ?? []).filter(Boolean)));
                const s = Array.from(new Set((stacks ?? []).filter(Boolean)));
                set({
                    selectedNodes: n,
                    selectedEdges: e,
                    selectedTextBoxes: t,
                    selectedStacks: s,
                    selectedNode: n.length === 1 && e.length === 0 && t.length === 0 && s.length === 0 ? n[0] : null,
                    selectedEdge: e.length === 1 && n.length === 0 && t.length === 0 && s.length === 0 ? e[0] : null,
                    selectedTextBoxId: t.length === 1 && n.length === 0 && e.length === 0 && s.length === 0 ? t[0] : null,
                    selectedStackId: s.length === 1 && n.length === 0 && e.length === 0 && t.length === 0 ? s[0] : null,
                    selectedEdgeHandle: null,
                    neighbors: {},
                });
                debugLog({
                    type: 'select',
                    t: performance.now(),
                    kind: (n.length + e.length + t.length + s.length) > 1
                        ? 'none'
                        : n.length === 1
                            ? 'node'
                            : e.length === 1
                                ? 'edge'
                                : t.length === 1
                                    ? 'textBox'
                                    : s.length === 1
                                        ? 'stack'
                                        : 'none',
                    id: (n.length === 1 ? n[0] : e.length === 1 ? e[0] : t.length === 1 ? t[0] : s.length === 1 ? s[0] : null),
                    selection: { node: n.length === 1 ? n[0] : null, edge: e.length === 1 ? e[0] : null, textBox: t.length === 1 ? t[0] : null },
                });
            },

            deleteSelection: () => set((state) => {
                const now = Date.now();
                const selectedNodes = state.selectedNodes.length ? state.selectedNodes : (state.selectedNode ? [state.selectedNode] : []);
                const selectedEdges = state.selectedEdges.length ? state.selectedEdges : (state.selectedEdge ? [state.selectedEdge] : []);
                const selectedTextBoxes = state.selectedTextBoxes.length ? state.selectedTextBoxes : (state.selectedTextBoxId ? [state.selectedTextBoxId] : []);
                const selectedStacks = state.selectedStacks.length ? state.selectedStacks : (state.selectedStackId ? [state.selectedStackId] : []);
                const stackById = new Map(state.stacks.map((stack) => [stack.id, stack]));
                const stackNodeIds: string[] = [];
                const stackTextBoxIds: string[] = [];
                selectedStacks.forEach((stackId) => {
                    const stack = stackById.get(stackId);
                    if (!stack) return;
                    stack.items.forEach((item) => {
                        if (item.kind === 'node') stackNodeIds.push(item.id);
                        else stackTextBoxIds.push(item.id);
                    });
                });
                const allSelectedNodes = Array.from(new Set([...selectedNodes, ...stackNodeIds]));
                const allSelectedTextBoxes = Array.from(new Set([...selectedTextBoxes, ...stackTextBoxIds]));

                if (allSelectedNodes.length === 0 && selectedEdges.length === 0 && allSelectedTextBoxes.length === 0) return {};

                // Remove nodes + edges connected to removed nodes
                const removeNodeSet = new Set(allSelectedNodes);
                const removedEdgesByNode = state.edges.filter((e) => removeNodeSet.has(e.source) || removeNodeSet.has(e.target));
                const removeEdgeSet = new Set([...selectedEdges, ...removedEdgesByNode.map((e) => e.id)]);

                const nodes = state.nodes.filter((n) => !removeNodeSet.has(n.id));
                const edges = state.edges.filter((e) => !removeEdgeSet.has(e.id));
                const textBoxes = state.textBoxes.filter((tb) => !allSelectedTextBoxes.includes(tb.id));
                const pruneResult = pruneStacks(state.stacks, nodes, textBoxes);

                const tombstones: Tombstones = {
                    ...state.tombstones,
                    nodes: { ...state.tombstones.nodes },
                    edges: { ...state.tombstones.edges },
                    drawings: { ...state.tombstones.drawings },
                    textBoxes: { ...state.tombstones.textBoxes },
                    comments: { ...state.tombstones.comments },
                    layers: { ...state.tombstones.layers },
                };
                if (pruneResult.removedStacks.length) {
                    tombstones.stacks = { ...state.tombstones.stacks };
                    pruneResult.removedStacks.forEach((stack) => {
                        tombstones.stacks[stack.id] = tombstoneFor(now, stack.updatedAt);
                    });
                }

                for (const nodeId of removeNodeSet) {
                    const node = state.nodes.find((n) => n.id === nodeId);
                    tombstones.nodes[nodeId] = tombstoneFor(now, node?.updatedAt);
                }
                for (const edgeId of removeEdgeSet) {
                    const edge = state.edges.find((e) => e.id === edgeId);
                    tombstones.edges[edgeId] = tombstoneFor(now, edge?.updatedAt);
                }
                for (const tbId of allSelectedTextBoxes) {
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
                    stacks: pruneResult.stacks,
                    tombstones,
                    effectiveEnergy,
                    selectedNode: null,
                    selectedNodes: [],
                    selectedEdge: null,
                    selectedEdges: [],
                    selectedEdgeHandle: null,
                    selectedTextBoxId: null,
                    selectedTextBoxes: [],
                    selectedStackId: null,
                    selectedStacks: [],
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
                        selectedEdgeHandle: null,
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
                    const stackPositionUpdate = Object.prototype.hasOwnProperty.call(nextData, 'x')
                        || Object.prototype.hasOwnProperty.call(nextData, 'y');
                    const stackSizeUpdate = Object.prototype.hasOwnProperty.call(nextData, 'width')
                        || Object.prototype.hasOwnProperty.call(nextData, 'height');
                    if (stackPositionUpdate || stackSizeUpdate) {
                        const inCollapsedStack = state.stacks.some((stack) => (
                            stack.collapsed && stack.items.some((item) => item.kind === 'textBox' && item.id === id)
                        ));
                        if (inCollapsedStack) {
                            delete (nextData as Partial<TextBox>).x;
                            delete (nextData as Partial<TextBox>).y;
                            delete (nextData as Partial<TextBox>).width;
                            delete (nextData as Partial<TextBox>).height;
                        }
                    }
                    if (Object.keys(nextData).length === 0) return {};
                    const textBoxes = state.textBoxes.map((t) => (t.id === id ? { ...t, ...nextData, updatedAt: now } : t));
                    let nextStacks = state.stacks;
                    const shouldUpdateStackItem = Object.prototype.hasOwnProperty.call(nextData, 'x')
                        || Object.prototype.hasOwnProperty.call(nextData, 'y')
                        || Object.prototype.hasOwnProperty.call(nextData, 'width')
                        || Object.prototype.hasOwnProperty.call(nextData, 'height');
                    if (shouldUpdateStackItem) {
                        const updatedTextBox = textBoxes.find((t) => t.id === id);
                        if (updatedTextBox) {
                            let changed = false;
                            nextStacks = state.stacks.map((stack) => {
                                if (stack.collapsed) return stack;
                                const idx = stack.items.findIndex((item) => item.kind === 'textBox' && item.id === id);
                                if (idx < 0) return stack;
                                const nextItems = stack.items.slice();
                                nextItems[idx] = {
                                    ...nextItems[idx],
                                    x: updatedTextBox.x,
                                    y: updatedTextBox.y,
                                    width: updatedTextBox.width,
                                    height: updatedTextBox.height,
                                };
                                changed = true;
                                return { ...stack, items: nextItems, updatedAt: now };
                            });
                            if (!changed) nextStacks = state.stacks;
                        }
                    }
                    return nextStacks === state.stacks ? { textBoxes } : { textBoxes, stacks: nextStacks };
                }),
            deleteTextBox: (id) =>
                set((state) => {
                    const now = Date.now();
                    const tb = state.textBoxes.find((t) => t.id === id);
                    const textBoxes = state.textBoxes.filter((t) => t.id !== id);
                    const pruneResult = pruneStacks(state.stacks, state.nodes, textBoxes);
                    const tombstoneTextBox = tombstoneFor(now, tb?.updatedAt);
                    const tombstones: Tombstones = {
                        ...state.tombstones,
                        textBoxes: { ...state.tombstones.textBoxes, [id]: tombstoneTextBox },
                        comments: { ...state.tombstones.comments },
                        layers: { ...state.tombstones.layers },
                    };
                    if (pruneResult.removedStacks.length) {
                        tombstones.stacks = { ...state.tombstones.stacks };
                        pruneResult.removedStacks.forEach((stack) => {
                            tombstones.stacks[stack.id] = tombstoneFor(now, stack.updatedAt);
                        });
                    }
                    debugLog({ type: 'delete_call', t: performance.now(), kind: 'textBox', id, now, updatedAt: tb?.updatedAt, tombstone: tombstoneTextBox });
                    const editingTextBoxId = state.editingTextBoxId === id ? null : state.editingTextBoxId;
                    const selectedTextBoxId = state.selectedTextBoxId === id ? null : state.selectedTextBoxId;
                    const selectedTextBoxes = state.selectedTextBoxes.filter((x) => x !== id);
                    return { ...pushHistoryReducer(state), textBoxes, stacks: pruneResult.stacks, tombstones, editingTextBoxId, selectedTextBoxId, selectedTextBoxes };
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

            createStack: (items, options) => set((state) => {
                const unique = new Map<string, { kind: StackItemKind; id: string }>();
                items.forEach((item) => {
                    if (!item?.id) return;
                    unique.set(stackItemKey(item), item);
                });
                const candidates = Array.from(unique.values());
                if (candidates.length < 2) return {};
                const stackedKeys = new Set(state.stacks.flatMap((stack) => stack.items.map(stackItemKey)));
                const filtered = candidates.filter((item) => !stackedKeys.has(stackItemKey(item)));
                if (filtered.length < 2) return {};

                let layerId: string | null = null;
                const resolvedItems: StackItemRef[] = [];
                filtered.forEach((item) => {
                    const pos = resolveStackItemPosition(state, item);
                    if (!pos) return;
                    const itemLayerId = resolveStackItemLayerId(state, item);
                    if (!itemLayerId) return;
                    if (!layerId) layerId = itemLayerId;
                    if (layerId !== itemLayerId) return;
                    const nextItem: StackItemRef = { ...item, x: pos.x, y: pos.y };
                    if (item.kind === 'textBox') {
                        nextItem.width = pos.width;
                        nextItem.height = pos.height;
                    }
                    resolvedItems.push(nextItem);
                });
                if (resolvedItems.length < 2) return {};

                const anchor = computeStackAnchor(state, resolvedItems);
                const collapsedSize = resolveStackUniformSize(options?.collapsedSize);
                const collapsedPositions = buildCollapsedPositionMap(state, resolvedItems, anchor, collapsedSize);
                const now = Date.now();
                const stack: StackGroup = {
                    id: crypto.randomUUID(),
                    title: '',
                    items: resolvedItems,
                    collapsed: true,
                    collapsedSize,
                    anchor,
                    layerId: layerId ?? undefined,
                    createdAt: now,
                    updatedAt: now,
                };
                const stackTextBoxIds = new Set(
                    resolvedItems.filter((item) => item.kind === 'textBox').map((item) => item.id),
                );
                const nodes = state.nodes.map((node) => {
                    const pos = collapsedPositions.get(`node:${node.id}`);
                    return pos ? { ...node, x: pos.x, y: pos.y, updatedAt: now } : node;
                });
                const textBoxes = state.textBoxes.map((tb) => {
                    const pos = collapsedPositions.get(`textBox:${tb.id}`);
                    if (!pos) return tb;
                    if (!stackTextBoxIds.has(tb.id)) return { ...tb, x: pos.x, y: pos.y, updatedAt: now };
                    return {
                        ...tb,
                        x: pos.x,
                        y: pos.y,
                        width: collapsedSize.width,
                        height: collapsedSize.height,
                        updatedAt: now,
                    };
                });
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    stacks: { ...state.tombstones.stacks },
                };
                delete tombstones.stacks[stack.id];
                return {
                    ...pushHistoryReducer(state),
                    nodes,
                    textBoxes,
                    stacks: [...state.stacks, stack],
                    tombstones,
                };
            }),

            expandStack: (id) => set((state) => {
                const stack = state.stacks.find((item) => item.id === id);
                if (!stack || !stack.collapsed) return {};
                const now = Date.now();
                const nodes = state.nodes.map((node) => {
                    const entry = stack.items.find((item) => item.kind === 'node' && item.id === node.id);
                    return entry ? { ...node, x: entry.x, y: entry.y, updatedAt: now } : node;
                });
                const textBoxes = state.textBoxes.map((tb) => {
                    const entry = stack.items.find((item) => item.kind === 'textBox' && item.id === tb.id);
                    if (!entry) return tb;
                    const next = { ...tb, x: entry.x, y: entry.y, updatedAt: now };
                    if (Number.isFinite(entry.width) && Number.isFinite(entry.height)) {
                        next.width = entry.width as number;
                        next.height = entry.height as number;
                    }
                    return next;
                });
                const stacks = state.stacks.map((item) => (
                    item.id === id ? { ...item, collapsed: false, updatedAt: now } : item
                ));
                return { ...pushHistoryReducer(state), nodes, textBoxes, stacks };
            }),

            collapseStack: (id, options) => set((state) => {
                const stack = state.stacks.find((item) => item.id === id);
                if (!stack || stack.collapsed) return {};
                const now = Date.now();
                const updatedItems = stack.items.map((item) => {
                    const pos = resolveStackItemPosition(state, item);
                    if (!pos) return item;
                    if (item.kind === 'textBox') {
                        return { ...item, x: pos.x, y: pos.y, width: pos.width, height: pos.height };
                    }
                    return { ...item, x: pos.x, y: pos.y };
                });
                const anchor = computeStackAnchor(state, updatedItems);
                const collapsedSize = resolveStackUniformSize(options?.collapsedSize ?? stack.collapsedSize);
                const collapsedPositions = buildCollapsedPositionMap(state, updatedItems, anchor, collapsedSize);
                const nodes = state.nodes.map((node) => {
                    const pos = collapsedPositions.get(`node:${node.id}`);
                    return pos ? { ...node, x: pos.x, y: pos.y, updatedAt: now } : node;
                });
                const stackTextBoxIds = new Set(
                    updatedItems.filter((item) => item.kind === 'textBox').map((item) => item.id),
                );
                const textBoxes = state.textBoxes.map((tb) => {
                    const pos = collapsedPositions.get(`textBox:${tb.id}`);
                    if (!pos) return tb;
                    if (!stackTextBoxIds.has(tb.id)) return { ...tb, x: pos.x, y: pos.y, updatedAt: now };
                    return {
                        ...tb,
                        x: pos.x,
                        y: pos.y,
                        width: collapsedSize.width,
                        height: collapsedSize.height,
                        updatedAt: now,
                    };
                });
                const stacks = state.stacks.map((item) => (
                    item.id === id
                        ? {
                            ...item,
                            items: updatedItems,
                            collapsed: true,
                            collapsedSize,
                            anchor,
                            updatedAt: now,
                        }
                        : item
                ));
                return { ...pushHistoryReducer(state), nodes, textBoxes, stacks };
            }),

            toggleStack: (id) => {
                const stack = get().stacks.find((item) => item.id === id);
                if (!stack) return;
                if (stack.collapsed) {
                    get().expandStack(id);
                } else {
                    get().collapseStack(id);
                }
            },

            ungroupStack: (id) => set((state) => {
                const stack = state.stacks.find((item) => item.id === id);
                if (!stack) return {};
                const now = Date.now();
                let nodes = state.nodes;
                let textBoxes = state.textBoxes;
                if (stack.collapsed) {
                    nodes = state.nodes.map((node) => {
                        const entry = stack.items.find((item) => item.kind === 'node' && item.id === node.id);
                        return entry ? { ...node, x: entry.x, y: entry.y, updatedAt: now } : node;
                    });
                    textBoxes = state.textBoxes.map((tb) => {
                        const entry = stack.items.find((item) => item.kind === 'textBox' && item.id === tb.id);
                        if (!entry) return tb;
                        const next = { ...tb, x: entry.x, y: entry.y, updatedAt: now };
                        if (Number.isFinite(entry.width) && Number.isFinite(entry.height)) {
                            next.width = entry.width as number;
                            next.height = entry.height as number;
                        }
                        return next;
                    });
                }
                const stacks = state.stacks.filter((item) => item.id !== id);
                const tombstones: Tombstones = {
                    ...state.tombstones,
                    stacks: { ...state.tombstones.stacks, [id]: tombstoneFor(now, stack.updatedAt) },
                };
                return { ...pushHistoryReducer(state), nodes, textBoxes, stacks, tombstones };
            }),

            updateStackTitle: (id, title) => set((state) => {
                const stack = state.stacks.find((item) => item.id === id);
                if (!stack) return {};
                const nextTitle = typeof title === 'string' ? title.trim() : '';
                if ((stack.title ?? '') === nextTitle) return {};
                const now = Date.now();
                const stacks = state.stacks.map((item) => (
                    item.id === id ? { ...item, title: nextTitle, updatedAt: now } : item
                ));
                return { ...pushHistoryReducer(state), stacks };
            }),

            moveStack: (id, delta) => set((state) => {
                const stack = state.stacks.find((item) => item.id === id);
                if (!stack) return {};
                const dx = Number.isFinite(delta?.dx) ? delta.dx : 0;
                const dy = Number.isFinite(delta?.dy) ? delta.dy : 0;
                if (dx === 0 && dy === 0) return {};
                const now = Date.now();
                const nodeIds = new Set(stack.items.filter((item) => item.kind === 'node').map((item) => item.id));
                const textBoxIds = new Set(stack.items.filter((item) => item.kind === 'textBox').map((item) => item.id));
                const nodes = state.nodes.map((node) => (
                    nodeIds.has(node.id) ? { ...node, x: node.x + dx, y: node.y + dy, updatedAt: now } : node
                ));
                const textBoxes = state.textBoxes.map((tb) => (
                    textBoxIds.has(tb.id) ? { ...tb, x: tb.x + dx, y: tb.y + dy, updatedAt: now } : tb
                ));
                const updatedItems = stack.items.map((item) => ({ ...item, x: item.x + dx, y: item.y + dy }));
                const anchor = stack.anchor ? { x: stack.anchor.x + dx, y: stack.anchor.y + dy } : undefined;
                const stacks = state.stacks.map((item) => (
                    item.id === id ? { ...item, items: updatedItems, anchor, updatedAt: now } : item
                ));
                return { nodes, textBoxes, stacks };
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
