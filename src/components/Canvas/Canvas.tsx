import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { Node } from '../Node/Node';
import { Edge, ConnectionLine } from '../Edge/Edge';
import styles from './Canvas.module.css';
import { v4 as uuidv4 } from 'uuid';
import { Link2, MessageCircle, X, Zap, ZapOff } from 'lucide-react';
import { beautifyStroke } from '../../utils/strokeBeautify';
import type { Attachment, Comment, EdgeData, NodeData, TextBox as TextBoxType } from '../../types';
import { debugLog } from '../../utils/debug';
import { TextBox } from '../TextBox/TextBox';
import { SnowOverlay } from '../Snow/SnowOverlay';
import { hashString } from '../../utils/guestIdentity';
import { filesToAttachments, formatBytes, MAX_ATTACHMENT_BYTES } from '../../utils/attachments';

const MIN_SCALE = 0.1;
const MAX_SCALE = 5;
const ZOOM_DETAIL_THRESHOLD = 1.1;
const ZOOM_GRAPH_THRESHOLD = 0.6;
const ZOOM_EPS = 0.02;
const ZOOM_DETAIL = ZOOM_DETAIL_THRESHOLD + ZOOM_EPS;
const ZOOM_GRAPH = ZOOM_GRAPH_THRESHOLD - ZOOM_EPS;
const CLICK_THRESHOLD = 5;
const LONG_PRESS_MS = 500;
const TOUCH_DRAG_THRESHOLD = 8;
const GRID_SIZE = 50;
const ALIGN_SNAP_PX = 8;
const FOCUS_RADIUS_X = 180;
const FOCUS_RADIUS_Y = Math.round(FOCUS_RADIUS_X * 0.7);

    type InteractionMode = 'idle' | 'panning' | 'draggingNode' | 'connecting' | 'textPlacing' | 'selecting';
type AlignmentGuide = { axis: 'x' | 'y'; pos: number; length: number };
type SnapAnchor = 'center' | 'topleft';
type SnapRequest = {
    x: number;
    y: number;
    width: number;
    height: number;
    anchor: SnapAnchor;
    excludeNodeIds?: string[];
    excludeTextBoxIds?: string[];
};
type ClipboardPayload =
    | { kind: 'node'; data: NodeData }
    | { kind: 'edge'; data: EdgeData }
    | { kind: 'selection'; nodes: NodeData[]; edges: EdgeData[]; textBoxes: TextBoxType[] };

type ContextMenuState = {
    kind: 'node' | 'textBox' | 'edge' | 'selection' | 'canvas' | 'comment';
    id?: string;
    x: number;
    y: number;
    worldX?: number;
    worldY?: number;
    hidden?: boolean;
};

type CommentDraft = {
    targetKind: Comment['targetKind'];
    targetId?: string | null;
    x?: number;
    y?: number;
};

export const Canvas: React.FC = () => {
    const containerRef = useRef<HTMLDivElement>(null);

    // Optimize Subscriptions
    const canvas = useStore((state) => state.canvas);
    const canvasViewCommand = useStore((state) => state.canvasViewCommand);
    const nodes = useStore((state) => state.nodes);
    const edges = useStore((state) => state.edges);
    const penMode = useStore((state) => state.penMode);
    const penTool = useStore((state) => state.penTool);
    const drawings = useStore((state) => state.drawings);
    const textMode = useStore((state) => state.textMode);
    const textBoxes = useStore((state) => state.textBoxes);
    const moveMode = useStore((state) => state.moveMode);
    const snapMode = useStore((state) => state.snapMode);
    const snowEnabled = useStore((state) => state.snowEnabled);
    const theme = useStore((state) => state.theme);
    const comments = useStore((state) => state.comments);
    const commentsMode = useStore((state) => state.commentsMode);
    const me = useStore((state) => state.me);

	    // Actions
	    const setCanvasTransform = useStore((state) => state.setCanvasTransform);
	    const updateNode = useStore((state) => state.updateNode);
	    const addEdge = useStore((state) => state.addEdge);
	    const addNode = useStore((state) => state.addNode);
	    const selectNode = useStore((state) => state.selectNode);
	    const addDrawing = useStore((state) => state.addDrawing);
	    const removeDrawing = useStore((state) => state.removeDrawing);
	    const addTextBox = useStore((state) => state.addTextBox);
	    const setEditingTextBoxId = useStore((state) => state.setEditingTextBoxId);
	    const toggleTextMode = useStore((state) => state.toggleTextMode);
	    const updateEdge = useStore((state) => state.updateEdge);
	    const addComment = useStore((state) => state.addComment);
	    const deleteComment = useStore((state) => state.deleteComment);
    const toggleCommentsMode = useStore((state) => state.toggleCommentsMode);
    const setCanvasViewCommand = useStore((state) => state.setCanvasViewCommand);

    const canvasRef = useRef(canvas);
    useEffect(() => {
        canvasRef.current = canvas;
    }, [canvas]);
    const lastCanvasViewIdRef = useRef<string | null>(null);

    // Interaction State
    const [mode, setMode] = useState<InteractionMode>('idle');
    const modeRef = useRef<InteractionMode>('idle');
    useEffect(() => {
        modeRef.current = mode;
    }, [mode]);
	    const [activeId, setActiveId] = useState<string | null>(null);
	    const activeIdRef = useRef<string | null>(null);
	    useEffect(() => {
	        activeIdRef.current = activeId;
	    }, [activeId]);
	    const clearAlignmentGuides = useCallback(() => setAlignmentGuides([]), []);
	    useEffect(() => {
	        if (!snapMode) clearAlignmentGuides();
	    }, [snapMode, clearAlignmentGuides]);
	    const contextConnectActiveRef = useRef(false);
	    const connectingPointerIdRef = useRef<number | null>(null);
	    const connectingPointerTypeRef = useRef<string | null>(null);
    const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
    const [connectionStart, setConnectionStart] = useState({ x: 0, y: 0 });
	    const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 }); // World coordinates
	    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	    const [marqueeRect, setMarqueeRect] = useState<null | { left: number; top: number; width: number; height: number }>(null);
	    const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);
	    const [openCommentId, setOpenCommentId] = useState<string | null>(null);
	    const [hoverCommentId, setHoverCommentId] = useState<string | null>(null);
	    const [draftComment, setDraftComment] = useState<CommentDraft | null>(null);
	    const [draftText, setDraftText] = useState('');
	    const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([]);
	    const [draftNotice, setDraftNotice] = useState<string | null>(null);
	    const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
	    const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
	    const draftAttachInputRef = useRef<HTMLInputElement | null>(null);
	    const marqueeStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
	    const groupDragRef = useRef<null | {
        pointerId: number;
        startWorld: { x: number; y: number };
        nodeStarts: Array<{ id: string; x: number; y: number }>;
        textBoxStarts: Array<{ id: string; x: number; y: number }>;
        committed: boolean;
        lastT: number;
	        lastPosByNode: Record<string, { x: number; y: number }>;
	    }>(null);

	    const clearMarqueeHover = () => {
	        document.querySelectorAll<HTMLElement>('[data-marquee-hover="true"]').forEach((el) => {
	            el.removeAttribute('data-marquee-hover');
	        });
	    };

	    const updateMarqueeHover = (rect: { left: number; top: number; width: number; height: number }) => {
	        const selLeft = rect.left;
	        const selTop = rect.top;
	        const selRight = rect.left + rect.width;
	        const selBottom = rect.top + rect.height;
	        const intersects = (r: DOMRect) => !(r.right < selLeft || r.left > selRight || r.bottom < selTop || r.top > selBottom);

	        document.querySelectorAll<HTMLElement>('[data-node-bounds="true"]').forEach((el) => {
	            const r = el.getBoundingClientRect();
	            const hit = intersects(r);
	            if (hit) el.setAttribute('data-marquee-hover', 'true');
	            else el.removeAttribute('data-marquee-hover');
	        });

	        document.querySelectorAll<HTMLElement>('[data-textbox-id]').forEach((el) => {
	            const r = el.getBoundingClientRect();
	            const hit = intersects(r);
	            if (hit) el.setAttribute('data-marquee-hover', 'true');
	            else el.removeAttribute('data-marquee-hover');
	        });

	        // Edge hit areas are SVG paths; HTMLElement typing is looser but works in the browser.
	        (document.querySelectorAll('[data-edge-id]') as any as Element[]).forEach((el) => {
	            const r = (el as any).getBoundingClientRect?.();
	            if (!r) return;
	            const hit = intersects(r as DOMRect);
	            if (hit) (el as any).setAttribute?.('data-marquee-hover', 'true');
	            else (el as any).removeAttribute?.('data-marquee-hover');
	        });
	    };
	    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const touchPressCandidate = useRef<{
        nodeId: string;
        downClientX: number;
        downClientY: number;
        pointerType: string;
    } | null>(null);
    const shiftPressCandidate = useRef<{
        nodeId: string;
        pointerId: number;
        downClientX: number;
        downClientY: number;
    } | null>(null);
    const canvasLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const canvasTouchCandidate = useRef<{
        pointerId: number;
        downClientX: number;
        downClientY: number;
        downWorldX: number;
        downWorldY: number;
    } | null>(null);

    // Drawing State
    const isDrawing = useRef(false);
    const drawingPointerIdRef = useRef<number | null>(null);
    const drawingPointerTypeRef = useRef<string | null>(null);
    const penStrokeActiveRef = useRef(false);
    const currentStrokePointsRef = useRef<{ x: number; y: number }[]>([]);
    const pendingStrokePointsRef = useRef<{ x: number; y: number }[]>([]);
    const lastStrokePointRef = useRef<{ x: number; y: number } | null>(null);
    const livePathRef = useRef<SVGPathElement | null>(null);
    const livePathDRef = useRef<string>('');
    const livePathRafRef = useRef<number | null>(null);
    const liveStrokeStyleRef = useRef<{ stroke: string; width: number; opacity: number } | null>(null);

    const lastPointerPos = useRef({ x: 0, y: 0 }); // Screen coordinates
    const lastPointerKnownRef = useRef(false);
    const pointerDownPos = useRef({ x: 0, y: 0 }); // To detect clicks vs drags
    const wheelRafRef = useRef<number | null>(null);
    const wheelPendingRef = useRef<{ x: number; y: number; scale: number } | null>(null);

    // Touch gesture state (for double-tap and pinch-to-zoom)
    const lastTapTime = useRef(0);
    const lastTapPos = useRef({ x: 0, y: 0 });
    const pinchStartDistance = useRef<number | null>(null);
    const pinchStartScale = useRef(1);
    const pinchCenter = useRef({ x: 0, y: 0 });
    const pinchStartWorld = useRef<{ x: number; y: number } | null>(null);
    const isPinching = useRef(false); // Block panning during pinch
    const clipboardRef = useRef<ClipboardPayload | null>(null);
    const pasteCountRef = useRef(0);
    const pasteEventHandledAtRef = useRef(0);
    const pasteFallbackTimerRef = useRef<number | null>(null);
	    const pendingDragUndoSnapshotRef = useRef<{ nodes: NodeData[]; edges: EdgeData[]; drawings: any[]; textBoxes: any[]; tombstones: any } | null>(null);
    const dragUndoCommittedRef = useRef(false);
    const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);

    // Helper: Screen to World conversion
    const screenToWorld = useCallback((screenX: number, screenY: number) => {
        if (!containerRef.current) return { x: 0, y: 0 };
        const rect = containerRef.current.getBoundingClientRect();
        return {
            x: (screenX - rect.left - canvas.x) / canvas.scale,
            y: (screenY - rect.top - canvas.y) / canvas.scale
        };
    }, [canvas]);

    const screenToWorldLatest = useCallback((screenX: number, screenY: number) => {
        const el = containerRef.current;
        if (!el) return { x: 0, y: 0 };
        const rect = el.getBoundingClientRect();
        const c = canvasRef.current;
        return {
            x: (screenX - rect.left - c.x) / c.scale,
            y: (screenY - rect.top - c.y) / c.scale,
        };
    }, []);

    const snapToGrid = useCallback((value: number) => Math.round(value / GRID_SIZE) * GRID_SIZE, []);

    const resolveSnap = useCallback((req: SnapRequest) => {
        if (!snapMode) return { x: req.x, y: req.y };
        const container = containerRef.current;
        if (!container) return { x: req.x, y: req.y };
        const containerRect = container.getBoundingClientRect();
        const c = canvasRef.current;
        const threshold = ALIGN_SNAP_PX / Math.max(0.0001, c.scale);

        const excludeNodes = new Set(req.excludeNodeIds ?? []);
        const excludeTextBoxes = new Set(req.excludeTextBoxIds ?? []);

        const rectFromClient = (r: DOMRect) => {
            const left = (r.left - containerRect.left - c.x) / c.scale;
            const top = (r.top - containerRect.top - c.y) / c.scale;
            const width = r.width / c.scale;
            const height = r.height / c.scale;
            return {
                left,
                top,
                right: left + width,
                bottom: top + height,
                width,
                height,
                cx: left + width / 2,
                cy: top + height / 2,
            };
        };

        const candidatesX: number[] = [];
        const candidatesY: number[] = [];

        document.querySelectorAll<HTMLElement>('[data-node-rect="true"]').forEach((el) => {
            const id = el.getAttribute('data-node-rect-id');
            if (!id || excludeNodes.has(id)) return;
            const rect = rectFromClient(el.getBoundingClientRect());
            candidatesX.push(rect.left, rect.cx, rect.right);
            candidatesY.push(rect.top, rect.cy, rect.bottom);
        });

        document.querySelectorAll<HTMLElement>('[data-textbox-id]').forEach((el) => {
            const id = el.getAttribute('data-textbox-id');
            if (!id || excludeTextBoxes.has(id)) return;
            const rect = rectFromClient(el.getBoundingClientRect());
            candidatesX.push(rect.left, rect.cx, rect.right);
            candidatesY.push(rect.top, rect.cy, rect.bottom);
        });

        const width = Math.max(0, req.width);
        const height = Math.max(0, req.height);
        let left = req.anchor === 'center' ? req.x - width / 2 : req.x;
        let top = req.anchor === 'center' ? req.y - height / 2 : req.y;

        const targetX = [
            { kind: 'left', value: left },
            { kind: 'center', value: left + width / 2 },
            { kind: 'right', value: left + width },
        ] as const;
        const targetY = [
            { kind: 'top', value: top },
            { kind: 'center', value: top + height / 2 },
            { kind: 'bottom', value: top + height },
        ] as const;

        const findBest = (
            targets: ReadonlyArray<{ kind: string; value: number }>,
            candidates: number[]
        ) => {
            let best: { delta: number; target: typeof targets[number]; candidate: number } | null = null;
            for (const t of targets) {
                for (const cVal of candidates) {
                    const delta = cVal - t.value;
                    const dist = Math.abs(delta);
                    if (dist > threshold) continue;
                    if (!best || dist < Math.abs(best.delta)) {
                        best = { delta, target: t, candidate: cVal };
                    }
                }
            }
            return best;
        };

        const bestX = findBest(targetX, candidatesX);
        const bestY = findBest(targetY, candidatesY);

        const guides: AlignmentGuide[] = [];

        if (bestX) {
            if (bestX.target.kind === 'left') left = bestX.candidate;
            if (bestX.target.kind === 'center') left = bestX.candidate - width / 2;
            if (bestX.target.kind === 'right') left = bestX.candidate - width;
            guides.push({ axis: 'x', pos: bestX.candidate * c.scale + c.x, length: containerRect.height });
        } else {
            const snapped = snapToGrid(req.anchor === 'center' ? left + width / 2 : left);
            left = req.anchor === 'center' ? snapped - width / 2 : snapped;
        }

        if (bestY) {
            if (bestY.target.kind === 'top') top = bestY.candidate;
            if (bestY.target.kind === 'center') top = bestY.candidate - height / 2;
            if (bestY.target.kind === 'bottom') top = bestY.candidate - height;
            guides.push({ axis: 'y', pos: bestY.candidate * c.scale + c.y, length: containerRect.width });
        } else {
            const snapped = snapToGrid(req.anchor === 'center' ? top + height / 2 : top);
            top = req.anchor === 'center' ? snapped - height / 2 : snapped;
        }

        setAlignmentGuides(guides);

        return {
            x: req.anchor === 'center' ? left + width / 2 : left,
            y: req.anchor === 'center' ? top + height / 2 : top,
        };
    }, [snapMode, snapToGrid]);

    const getNodeSize = useCallback((id: string) => {
        const el = document.querySelector<HTMLElement>(`[data-node-rect="true"][data-node-rect-id="${id}"]`);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const scale = Math.max(0.0001, canvasRef.current.scale);
        return { width: rect.width / scale, height: rect.height / scale };
    }, []);

    const getViewportMetrics = useCallback(() => {
        const viewport = window.visualViewport;
        const width = viewport?.width ?? window.innerWidth;
        const height = viewport?.height ?? window.innerHeight;
        return { width, height, centerX: width / 2, centerY: height / 2 };
    }, []);

    const clampScale = useCallback((scale: number) => Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE), []);

    const centerOnWorldPoint = useCallback((worldX: number, worldY: number, targetScale: number) => {
        const { centerX, centerY } = getViewportMetrics();
        const nextScale = clampScale(targetScale);
        const nextX = centerX - worldX * nextScale;
        const nextY = centerY - worldY * nextScale;
        setCanvasTransform(nextX, nextY, nextScale);
    }, [clampScale, getViewportMetrics, setCanvasTransform]);

    const applyZoomPreset = useCallback((targetScale: number) => {
        const { centerX, centerY } = getViewportMetrics();
        const current = canvasRef.current;
        const worldX = (centerX - current.x) / current.scale;
        const worldY = (centerY - current.y) / current.scale;
        centerOnWorldPoint(worldX, worldY, targetScale);
    }, [centerOnWorldPoint, getViewportMetrics]);

    const applyZoomToFit = useCallback(() => {
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
    }, [centerOnWorldPoint, clampScale, getNodeSize, getViewportMetrics]);

    useEffect(() => {
        if (!canvasViewCommand) return;
        if (canvasViewCommand.id === lastCanvasViewIdRef.current) return;
        lastCanvasViewIdRef.current = canvasViewCommand.id;

        const action = canvasViewCommand.action;
        if (action === 'zoom_to_cards') {
            applyZoomPreset(ZOOM_DETAIL);
            setCanvasViewCommand(null);
            return;
        }
        if (action === 'zoom_to_graph') {
            applyZoomPreset(ZOOM_GRAPH);
            setCanvasViewCommand(null);
            return;
        }
        if (action === 'zoom_to_fit') {
            applyZoomToFit();
            setCanvasViewCommand(null);
            return;
        }
        if (action === 'focus_node') {
            const id = canvasViewCommand.nodeId ?? null;
            if (id) {
                const st = useStore.getState();
                const node = st.nodes.find((candidate) => candidate.id === id);
                if (node) centerOnWorldPoint(node.x, node.y, ZOOM_DETAIL);
            }
            setCanvasViewCommand(null);
        }
    }, [applyZoomPreset, applyZoomToFit, canvasViewCommand, centerOnWorldPoint, setCanvasViewCommand]);

    const resolveCommentAnchor = useCallback((target: CommentDraft | Comment) => {
        if (target.targetKind === 'canvas') {
            if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return null;
            return { x: target.x as number, y: target.y as number };
        }
        if (target.targetKind === 'node') {
            const nodeId = target.targetId ?? null;
            const node = nodeId ? nodes.find((n) => n.id === nodeId) : null;
            if (!node) return null;
            const size = getNodeSize(node.id) ?? { width: 240, height: 120 };
            return {
                x: node.x + size.width / 2 + 12,
                y: node.y - size.height / 2 + 8,
            };
        }
        if (target.targetKind === 'textBox') {
            const boxId = target.targetId ?? null;
            const box = boxId ? textBoxes.find((t) => t.id === boxId) : null;
            if (!box) return null;
            return {
                x: box.x + box.width + 10,
                y: box.y + 6,
            };
        }
        if (target.targetKind === 'edge') {
            const edgeId = target.targetId ?? null;
            const edge = edgeId ? edges.find((e) => e.id === edgeId) : null;
            if (!edge) return null;
            const source = nodes.find((n) => n.id === edge.source);
            const targetNode = nodes.find((n) => n.id === edge.target);
            if (!source || !targetNode) return null;
            return {
                x: (source.x + targetNode.x) / 2,
                y: (source.y + targetNode.y) / 2,
            };
        }
        return null;
    }, [edges, nodes, textBoxes, getNodeSize]);

    const applyLiveStrokeStyle = (style: { stroke: string; width: number; opacity: number }) => {
        liveStrokeStyleRef.current = style;
        const el = livePathRef.current;
        if (!el) return;
        el.setAttribute('stroke', style.stroke);
        el.setAttribute('stroke-width', String(style.width));
        el.style.opacity = String(style.opacity);
    };

    const clearLiveStroke = () => {
        if (livePathRafRef.current) {
            cancelAnimationFrame(livePathRafRef.current);
            livePathRafRef.current = null;
        }
        currentStrokePointsRef.current = [];
        pendingStrokePointsRef.current = [];
        lastStrokePointRef.current = null;
        livePathDRef.current = '';
        const el = livePathRef.current;
        if (el) el.setAttribute('d', '');
    };

    const requestAuthForComment = useCallback((message = 'Для комментария нужна авторизация') => {
        window.dispatchEvent(
            new CustomEvent('open-auth', {
                detail: { reason: 'comment', message, mode: 'login' },
            }),
        );
    }, []);

    const startCommentDraft = useCallback((draft: CommentDraft) => {
        if (!me) {
            requestAuthForComment();
            return;
        }
        if (!commentsMode) toggleCommentsMode();
        setDraftComment(draft);
        setDraftText('');
        setDraftAttachments([]);
        setDraftNotice(null);
        setOpenCommentId(null);
        setHoverCommentId(null);
    }, [commentsMode, me, requestAuthForComment, toggleCommentsMode]);

    const submitDraftComment = useCallback(() => {
        if (!draftComment) return;
        const text = draftText.trim();
        if (!text && draftAttachments.length === 0) return;
        const id = uuidv4();
        addComment({
            id,
            targetKind: draftComment.targetKind,
            targetId: draftComment.targetId ?? null,
            parentId: null,
            x: draftComment.x,
            y: draftComment.y,
            text,
            attachments: draftAttachments,
        });
        setDraftComment(null);
        setDraftText('');
        setDraftAttachments([]);
        setDraftNotice(null);
        setOpenCommentId(id);
    }, [addComment, draftAttachments, draftComment, draftText]);

    const handleDraftAttachmentInput = useCallback(async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        // Convert selected files to data URLs so they can travel with the session state.
        const { attachments, rejected } = await filesToAttachments(Array.from(files));
        if (attachments.length) {
            setDraftAttachments((prev) => [...prev, ...attachments]);
        }
        if (rejected.length) {
            setDraftNotice(`Max file size is ${formatBytes(MAX_ATTACHMENT_BYTES)}`);
        }
    }, []);

    const submitReply = useCallback((parent: Comment) => {
        if (!me) {
            requestAuthForComment();
            return;
        }
        const text = (replyDrafts[parent.id] ?? '').trim();
        if (!text) return;
        addComment({
            id: uuidv4(),
            targetKind: parent.targetKind,
            targetId: parent.targetId ?? null,
            parentId: parent.id,
            x: parent.x,
            y: parent.y,
            text,
        });
        setReplyDrafts((prev) => ({ ...prev, [parent.id]: '' }));
    }, [addComment, me, replyDrafts, requestAuthForComment]);

    useEffect(() => {
        if (!draftComment) return;
        requestAnimationFrame(() => draftInputRef.current?.focus());
    }, [draftComment]);

    useEffect(() => {
        if (!draftNotice) return;
        const t = window.setTimeout(() => setDraftNotice(null), 2000);
        return () => window.clearTimeout(t);
    }, [draftNotice]);

    useEffect(() => {
        if (!commentsMode) {
            setOpenCommentId(null);
            setHoverCommentId(null);
        }
    }, [commentsMode]);

    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest?.('[data-comment-ui="true"]')) return;
            setOpenCommentId(null);
            setDraftComment(null);
            setDraftAttachments([]);
            setDraftNotice(null);
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        return () => window.removeEventListener('pointerdown', onPointerDown, true);
    }, []);

    const flushPendingStrokePoints = () => {
        if (pendingStrokePointsRef.current.length === 0) return;
        const el = livePathRef.current;
        if (!el) {
            pendingStrokePointsRef.current = [];
            return;
        }

        const MIN_DIST = 0.6; // world units

        let d = livePathDRef.current;
        for (const p of pendingStrokePointsRef.current) {
            const last = lastStrokePointRef.current;
            if (last) {
                const dx = p.x - last.x;
                const dy = p.y - last.y;
                if (dx * dx + dy * dy < MIN_DIST * MIN_DIST) continue;
            }

            currentStrokePointsRef.current.push(p);
            lastStrokePointRef.current = p;
            if (!d) d = `M ${p.x} ${p.y}`;
            else d += ` L ${p.x} ${p.y}`;
        }
        pendingStrokePointsRef.current = [];
        livePathDRef.current = d;
        el.setAttribute('d', d);
    };

    const scheduleLiveStrokeFlush = () => {
        if (livePathRafRef.current) return;
        livePathRafRef.current = requestAnimationFrame(() => {
            livePathRafRef.current = null;
            flushPendingStrokePoints();
        });
    };

    const clearLongPress = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
        touchPressCandidate.current = null;
    };

    const clearCanvasLongPress = () => {
        if (canvasLongPressTimer.current) {
            clearTimeout(canvasLongPressTimer.current);
            canvasLongPressTimer.current = null;
        }
        canvasTouchCandidate.current = null;
    };

    const updateConnectionTargetFromClientPoint = (clientX: number, clientY: number, sourceId: string) => {
        const target = document.elementFromPoint(clientX, clientY);
        const nodeElement = target?.closest('[data-node-id]');
            if (nodeElement) {
            const targetId = nodeElement.getAttribute('data-node-id')!;
            if (targetId !== sourceId) {
                useStore.getState().setConnectionTargetId(targetId);
            } else {
                useStore.getState().setConnectionTargetId(null);
            }
        } else {
            useStore.getState().setConnectionTargetId(null);
        }
    };

    const finalizeConnectionAtClientPoint = (clientX: number, clientY: number, sourceId: string) => {
        const target = document.elementFromPoint(clientX, clientY);
        const nodeElement = target?.closest('[data-node-id]');
        if (nodeElement) {
            const targetId = nodeElement.getAttribute('data-node-id')!;
            if (targetId !== sourceId) {
                addEdge({
                    id: uuidv4(),
                    source: sourceId,
                    target: targetId,
                    type: 'default'
                });
            }
        }
        useStore.getState().setConnectionTargetId(null);
    };

			    const startContextConnectionDrag = (e: React.PointerEvent, nodeId: string) => {
			        e.preventDefault();
			        e.stopPropagation();

		        const node = useStore.getState().nodes.find((n) => n.id === nodeId);
		        if (!node) return;

		        const pointerId = e.pointerId;
		        const isTouch = e.pointerType === 'touch';

			        // On touch devices, unmounting the pressed button can trigger a touchcancel and kill the gesture.
			        // Keep the menu in the DOM but hide it and disable hit-testing; close it on gesture end.
			        if (isTouch) {
			            setContextMenu((prev) =>
			                prev ? { ...prev, kind: 'node', id: nodeId, hidden: true } : { kind: 'node', id: nodeId, x: e.clientX, y: e.clientY, hidden: true }
			            );
			        } else {
			            setContextMenu(null);
			        }

		        // While connecting we don't want existing selection-driven dimming (backgroundNoise).
		        // Clear selection so all nodes remain fully visible when choosing a target.
		        {
		            const { selectNode, selectEdge, selectTextBox } = useStore.getState();
	            selectNode(null);
	            selectEdge(null);
	            selectTextBox(null);
	            setEditingTextBoxId(null);
		        }

			        setMode('connecting');
			        setActiveId(nodeId);
			        connectingPointerIdRef.current = pointerId;
			        connectingPointerTypeRef.current = e.pointerType;
			        setConnectionStart({ x: node.x, y: node.y });
			        setCursorPos(screenToWorldLatest(e.clientX, e.clientY));
			        updateConnectionTargetFromClientPoint(e.clientX, e.clientY, nodeId);

	        contextConnectActiveRef.current = isTouch;

	        let cleaned = false;
	        let finished = false;
	        let lastClient = { x: e.clientX, y: e.clientY };
		        const cleanup = () => {
		            if (cleaned) return;
		            cleaned = true;
		            contextConnectActiveRef.current = false;
		            connectingPointerIdRef.current = null;
		            connectingPointerTypeRef.current = null;
		            setContextMenu(null);
		            window.removeEventListener('pointermove', onMove, true);
		            window.removeEventListener('pointerup', onUp, true);
		            window.removeEventListener('pointercancel', onCancel, true);
		            window.removeEventListener('touchmove', onTouchMove, true);
		            window.removeEventListener('touchend', onTouchEnd, true);
		            window.removeEventListener('touchcancel', onTouchCancel, true);
		        };

	        const onMove = (ev: PointerEvent) => {
	            if (ev.pointerId !== pointerId) return;
	            lastClient = { x: ev.clientX, y: ev.clientY };
	            setCursorPos(screenToWorldLatest(ev.clientX, ev.clientY));
	            updateConnectionTargetFromClientPoint(ev.clientX, ev.clientY, nodeId);
	        };

	        const onCancel = (ev: PointerEvent) => {
	            if (ev.pointerId !== pointerId) return;
	            // Touch pointers often emit pointercancel mid-gesture; keep the connection gesture alive
	            // and let touchend finalize it.
	            if (isTouch) return;
	            onUp(ev);
	        };

	        // Touch fallback: many mobile browsers are inconsistent with pointermove streams when drag starts on UI controls.
	        const onTouchMove = (ev: TouchEvent) => {
	            if (ev.touches.length !== 1) return;
	            const t = ev.touches[0];
	            lastClient = { x: t.clientX, y: t.clientY };
	            setCursorPos(screenToWorldLatest(t.clientX, t.clientY));
	            updateConnectionTargetFromClientPoint(t.clientX, t.clientY, nodeId);
	            ev.preventDefault();
	        };

	        const onTouchEnd = (ev: TouchEvent) => {
	            if (ev.touches.length !== 0) return;
	            if (finished) return;
	            finished = true;
	            // Finalize from touch end point (or last move point as fallback).
	            const t = ev.changedTouches?.[0];
	            const x = t?.clientX ?? lastClient.x;
	            const y = t?.clientY ?? lastClient.y;
	            finalizeConnectionAtClientPoint(x, y, nodeId);
	            setMode('idle');
	            setActiveId(null);
	            cleanup();
	        };

	        const onTouchCancel = (_ev: TouchEvent) => {
	            if (finished) return;
	            finished = true;
	            setMode('idle');
	            setActiveId(null);
	            cleanup();
	        };

	        const onUp = (ev: PointerEvent) => {
	            if (ev.pointerId !== pointerId) return;
	            if (finished) return;
	            finished = true;
	            finalizeConnectionAtClientPoint(ev.clientX, ev.clientY, nodeId);
	            setMode('idle');
	            setActiveId(null);
	            cleanup();
	        };

		        // Pointer events are reliable for mouse/pen, less so for touch (some browsers emit pointerup mid-gesture).
		        if (!isTouch) {
		            window.addEventListener('pointermove', onMove, true);
		            window.addEventListener('pointerup', onUp, true);
		            window.addEventListener('pointercancel', onCancel, true);
		        }
		        window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false } as any);
		        window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true } as any);
		        window.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: true } as any);
		    };

    const handleWheel = useCallback((e: WheelEvent) => {
        e.preventDefault();
        const base = wheelPendingRef.current ?? canvasRef.current;
        if (e.ctrlKey || e.metaKey) {
            const zoomSensitivity = 0.001;
            const delta = -e.deltaY * zoomSensitivity;
            const newScale = Math.min(Math.max(base.scale * (1 + delta), MIN_SCALE), MAX_SCALE);

            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const cursorX = e.clientX - rect.left;
            const cursorY = e.clientY - rect.top;
            const scaleRatio = newScale / base.scale;
            const newX = cursorX - (cursorX - base.x) * scaleRatio;
            const newY = cursorY - (cursorY - base.y) * scaleRatio;
            wheelPendingRef.current = { x: newX, y: newY, scale: newScale };
        } else {
            wheelPendingRef.current = { x: base.x - e.deltaX, y: base.y - e.deltaY, scale: base.scale };
        }

        if (wheelRafRef.current == null) {
            wheelRafRef.current = window.requestAnimationFrame(() => {
                wheelRafRef.current = null;
                const next = wheelPendingRef.current;
                if (!next) return;
                wheelPendingRef.current = null;
                setCanvasTransform(next.x, next.y, next.scale);
            });
        }
    }, [setCanvasTransform]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        container.addEventListener('wheel', handleWheel, { passive: false });

        // Touch start - track for double-tap and pinch
	        const handleTouchStart = (e: TouchEvent) => {
	            if (penStrokeActiveRef.current) {
	                e.preventDefault();
	                return;
	            }
	            if (modeRef.current === 'connecting') {
	                // Don't let pinch/gesture handling interrupt an active connection drag.
	                e.preventDefault();
	                return;
	            }
	            if (e.touches.length === 2) {
	                // Start pinch gesture
	                isPinching.current = true;
	                const t1 = e.touches[0];
	                const t2 = e.touches[1];
                pinchStartDistance.current = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
                pinchStartScale.current = canvasRef.current.scale;
                pinchCenter.current = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
                pinchStartWorld.current = screenToWorldLatest(pinchCenter.current.x, pinchCenter.current.y);

                // Pinch should override any in-progress one-finger gestures.
                setMode('idle');
                setActiveId(null);
                setMarqueeRect(null);
                marqueeStartRef.current = null;
                clearMarqueeHover();
                clearLongPress();
                e.preventDefault();
            }
        };

        // Touch move - handle pinch-to-zoom
	        const handleTouchMove = (e: TouchEvent) => {
	            if (penStrokeActiveRef.current) {
	                e.preventDefault();
	                return;
	            }
	            // Fallback for iOS: during an active connection drag, some pointermove streams don't fire reliably.
	            // Update the live connection line from touch events when it's a single-finger drag.
	            if (modeRef.current === 'connecting') {
	                if (e.touches.length === 1) {
	                    const t = e.touches[0];
	                    setCursorPos(screenToWorldLatest(t.clientX, t.clientY));
	                    const srcId = activeIdRef.current;
	                    if (srcId) updateConnectionTargetFromClientPoint(t.clientX, t.clientY, srcId);
	                }
	                // If a second touch appears (palm/accidental), keep connecting and suppress pinch.
	                e.preventDefault();
	                return;
	            }
	            if (e.touches.length === 2 && pinchStartDistance.current !== null && pinchStartWorld.current) {
	                // Pinch zoom + two-finger pan (keeps the world point under the pinch center anchored).
	                isPinching.current = true;
	                const t1 = e.touches[0];
                const t2 = e.touches[1];
                const currentDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
                const scaleChange = currentDistance / pinchStartDistance.current;
                const newScale = Math.min(Math.max(pinchStartScale.current * scaleChange, MIN_SCALE), MAX_SCALE);

                const centerClientX = (t1.clientX + t2.clientX) / 2;
                const centerClientY = (t1.clientY + t2.clientY) / 2;
                pinchCenter.current = { x: centerClientX, y: centerClientY };

                const rect = container.getBoundingClientRect();
                const centerX = centerClientX - rect.left;
                const centerY = centerClientY - rect.top;

                const anchor = pinchStartWorld.current;
                const newX = centerX - anchor.x * newScale;
                const newY = centerY - anchor.y * newScale;

                setCanvasTransform(newX, newY, newScale);
                e.preventDefault();
            } else if (e.touches.length === 1 && penMode) {
                e.preventDefault();
            }
        };

        // Touch end - detect double-tap
	        const handleTouchEnd = (e: TouchEvent) => {
	            if (penStrokeActiveRef.current) return;
	            if (modeRef.current === 'connecting') return;
	            if (penMode || textMode) return;
	            // Reset pinch state when fingers lifted
	            if (e.touches.length < 2) {
	                pinchStartDistance.current = null;
	                pinchStartWorld.current = null;
                // Delay resetting isPinching to prevent immediate panning after pinch
                setTimeout(() => {
                    isPinching.current = false;
                }, 100);
            }

            // Check for double-tap (single finger only, not from pinch)
            if (e.changedTouches.length === 1 && e.touches.length === 0) {
                const touch = e.changedTouches[0];
                const now = Date.now();
                const timeDiff = now - lastTapTime.current;
                const dist = Math.hypot(
                    touch.clientX - lastTapPos.current.x,
                    touch.clientY - lastTapPos.current.y
                );

                if (timeDiff < 300 && dist < 30) {
                    // Double-tap detected! Create node
                    const target = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;
                    // Avoid creating nodes when the double-tap hits any interactive UI or an existing object.
                    if (
                        !target?.closest?.('[data-node-id]')
                        && !target?.closest?.('[data-textbox-id]')
                        && !target?.closest?.('[data-interactive="true"]')
                        && !target?.closest?.('button')
                    ) {
                        const worldPos = screenToWorldLatest(touch.clientX, touch.clientY);
                        addNode({
                            id: uuidv4(),
                            title: 'New Thought',
                            content: '',
                            type: 'idea',
                            x: worldPos.x,
                            y: worldPos.y,
                            clarity: 0.5,
                            energy: 50
                        });
                    }
                }

                lastTapTime.current = now;
                lastTapPos.current = { x: touch.clientX, y: touch.clientY };
            }
        };

        container.addEventListener('touchstart', handleTouchStart, { passive: false });
        container.addEventListener('touchmove', handleTouchMove, { passive: false });
        container.addEventListener('touchend', handleTouchEnd, { passive: true });

        return () => {
            container.removeEventListener('wheel', handleWheel);
            container.removeEventListener('touchstart', handleTouchStart);
            container.removeEventListener('touchmove', handleTouchMove);
            container.removeEventListener('touchend', handleTouchEnd);
        };
    }, [handleWheel, penMode, textMode, addNode, screenToWorldLatest]);

    // Handle Hotkeys
    useEffect(() => {
        const isEditableTarget = (target: EventTarget | null) => {
            if (!(target instanceof HTMLElement)) return false;
            if (target.closest('input, textarea, select')) return true;
            if (target.isContentEditable) return true;
            const ce = target.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]');
            return !!ce;
        };

        const getPasteWorldPos = () => {
            const el = containerRef.current;
            if (!el) return { x: 0, y: 0 };
            if (lastPointerKnownRef.current) {
                return screenToWorld(lastPointerPos.current.x, lastPointerPos.current.y);
            }
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            return screenToWorld(cx, cy);
        };

        const tryParsePayload = (raw: string): ClipboardPayload | null => {
            try {
                const obj = JSON.parse(raw);
                if (!obj || typeof obj !== 'object') return null;
                if (obj.kind === 'node' && obj.data && typeof obj.data === 'object') return obj;
                if (obj.kind === 'edge' && obj.data && typeof obj.data === 'object') return obj;
                if (
                    obj.kind === 'selection'
                    && Array.isArray(obj.nodes)
                    && Array.isArray(obj.edges)
                    && Array.isArray(obj.textBoxes)
                ) return obj;
                return null;
            } catch {
                return null;
            }
        };

        const getPastePlacement = () => {
            const n = pasteCountRef.current++;
            return {
                pos: getPasteWorldPos(),
                offset: 36 + (n % 6) * 10,
            };
        };

        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

        const normalizeUrl = (raw: string) => {
            const trimmed = raw.trim();
            if (!trimmed) return null;
            try {
                return new URL(trimmed);
            } catch {
                if (trimmed.startsWith('www.')) {
                    try {
                        return new URL(`https://${trimmed}`);
                    } catch {
                        return null;
                    }
                }
                return null;
            }
        };

        const isLikelyImageUrl = (url: URL) => /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(url.pathname);

        const createTextBoxFromText = (text: string) => {
            const { pos, offset } = getPastePlacement();
            const lines = text.split(/\r?\n/);
            const maxLine = lines.reduce((acc, line) => Math.max(acc, line.length), 1);
            const width = clamp(maxLine * 7 + 48, 160, 420);
            const height = clamp(lines.length * 22 + 32, 64, 260);
            addTextBox({
                id: uuidv4(),
                x: pos.x + offset - width / 2,
                y: pos.y + offset - height / 2,
                width,
                height,
                text,
            });
        };

        const createNode = (title: string, content: string) => {
            const { pos, offset } = getPastePlacement();
            addNode({
                id: uuidv4(),
                title,
                content,
                type: 'idea',
                x: pos.x + offset,
                y: pos.y + offset,
                clarity: 0.5,
                energy: 50,
            });
        };

        const createNodeFromText = (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return;
            const lines = trimmed.split(/\r?\n/);
            const title = (lines[0] || 'Note').trim().slice(0, 80) || 'Note';
            const body = lines.slice(1).join('\n').trim();
            const content = body || trimmed;
            createNode(title, content);
        };

        const createLinkBox = (url: URL) => {
            createTextBoxFromText(url.toString());
        };

        const createImageBox = (src: string) => {
            const { pos, offset } = getPastePlacement();
            const maxSize = 360;
            const minSize = 140;
            const fallbackW = 320;
            const fallbackH = 240;

            const addImageBox = (w: number, h: number) => {
                const width = clamp(w, minSize, maxSize);
                const height = clamp(h, minSize, maxSize);
                addTextBox({
                    id: uuidv4(),
                    x: pos.x + offset - width / 2,
                    y: pos.y + offset - height / 2,
                    width,
                    height,
                    text: '',
                    kind: 'image',
                    src,
                });
            };

            const img = new Image();
            img.onload = () => {
                const w = img.naturalWidth || fallbackW;
                const h = img.naturalHeight || fallbackH;
                if (!w || !h) {
                    addImageBox(fallbackW, fallbackH);
                    return;
                }
                const scale = Math.min(1, maxSize / Math.max(w, h));
                addImageBox(w * scale, h * scale);
            };
            img.onerror = () => addImageBox(fallbackW, fallbackH);
            img.src = src;
        };

        const extractImageFromHtml = (html: string) => {
            try {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const img = doc.querySelector('img');
                const src = img?.getAttribute('src');
                return src || null;
            } catch {
                return null;
            }
        };

        const readBlobAsDataUrl = (blob: Blob) => new Promise<string | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });

        const downscaleImageBlob = async (blob: Blob) => {
            const fallback = () => readBlobAsDataUrl(blob);
            if (!blob.type.startsWith('image/')) return fallback();
            if (typeof createImageBitmap !== 'function') return fallback();

            try {
                const bitmap = await createImageBitmap(blob);
                const w = bitmap.width || 0;
                const h = bitmap.height || 0;
                if (!w || !h) {
                    bitmap.close?.();
                    return fallback();
                }
                const maxDim = 960;
                const scale = Math.min(1, maxDim / Math.max(w, h));
                if (scale >= 1) {
                    bitmap.close?.();
                    return fallback();
                }
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(w * scale));
                canvas.height = Math.max(1, Math.round(h * scale));
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    bitmap.close?.();
                    return fallback();
                }
                ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                bitmap.close?.();
                const webp = canvas.toDataURL('image/webp', 0.92);
                if (webp.startsWith('data:image/webp')) return webp;
                return canvas.toDataURL('image/png');
            } catch {
                return fallback();
            }
        };

        const doPasteSelection = (payload: ClipboardPayload | null) => {
            if (!payload) return;

            const { pos, offset } = getPastePlacement();
            if (payload.kind === 'node') {
                const node = payload.data;
                addNode({
                    ...node,
                    id: uuidv4(),
                    x: pos.x + offset,
                    y: pos.y + offset,
                    createdAt: undefined,
                    updatedAt: undefined,
                });
                return;
            }

            if (payload.kind === 'edge') {
                const edge = payload.data;
                // Only paste edge if nodes exist
                const { nodes } = useStore.getState();
                const hasSource = nodes.some((nn) => nn.id === edge.source);
                const hasTarget = nodes.some((nn) => nn.id === edge.target);
                if (!hasSource || !hasTarget) return;
                addEdge({
                    ...edge,
                    id: uuidv4(),
                    createdAt: undefined,
                    updatedAt: undefined,
                });
                return;
            }

            const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
            const textBoxes = Array.isArray(payload.textBoxes) ? payload.textBoxes : [];
            const edges = Array.isArray(payload.edges) ? payload.edges : [];
            if (nodes.length === 0 && textBoxes.length === 0 && edges.length === 0) return;

            const points = [
                ...nodes.map((node) => ({ x: node.x, y: node.y })),
                ...textBoxes.map((tb) => ({ x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 })),
            ];
            const centerX = points.length ? points.reduce((acc, p) => acc + p.x, 0) / points.length : pos.x;
            const centerY = points.length ? points.reduce((acc, p) => acc + p.y, 0) / points.length : pos.y;
            const dx = pos.x - centerX + offset;
            const dy = pos.y - centerY + offset;

            const idMap = new Map<string, string>();
            const nextNodes = nodes.map((node) => {
                const nextId = uuidv4();
                idMap.set(node.id, nextId);
                return {
                    ...node,
                    id: nextId,
                    x: node.x + dx,
                    y: node.y + dy,
                    createdAt: undefined,
                    updatedAt: undefined,
                };
            });
            const nextTextBoxes = textBoxes.map((tb) => ({
                ...tb,
                id: uuidv4(),
                x: tb.x + dx,
                y: tb.y + dy,
                createdAt: undefined,
                updatedAt: undefined,
            }));
            const existingIds = new Set(useStore.getState().nodes.map((nn) => nn.id));
            const nextEdges = edges
                .map((edge) => {
                    const mappedSource = idMap.get(edge.source);
                    const mappedTarget = idMap.get(edge.target);
                    const source = mappedSource ?? edge.source;
                    const target = mappedTarget ?? edge.target;
                    const hasSource = !!mappedSource || existingIds.has(edge.source);
                    const hasTarget = !!mappedTarget || existingIds.has(edge.target);
                    if (!hasSource || !hasTarget) return null;
                    return {
                        ...edge,
                        id: uuidv4(),
                        source,
                        target,
                        createdAt: undefined,
                        updatedAt: undefined,
                    };
                })
                .filter(Boolean) as EdgeData[];

            nextNodes.forEach((node) => addNode(node));
            nextTextBoxes.forEach((tb) => addTextBox(tb));
            nextEdges.forEach((edge) => addEdge(edge));
        };

        const pasteFromText = (raw: string) => {
            const text = raw.replace(/\r\n/g, '\n');
            const trimmed = text.trim();
            if (!trimmed) return;
            if (trimmed.startsWith('data:image/')) {
                createImageBox(trimmed);
                return;
            }
            const url = normalizeUrl(trimmed);
            if (url) {
                if (isLikelyImageUrl(url)) {
                    createImageBox(url.toString());
                } else {
                    createLinkBox(url);
                }
                return;
            }
            const lines = trimmed.split('\n');
            if (lines.length > 1 || trimmed.length > 140) {
                createNodeFromText(trimmed);
            } else {
                createTextBoxFromText(trimmed);
            }
        };

        const pasteFromClipboardData = async (clipboardData: DataTransfer | null, localPayload: ClipboardPayload | null) => {
            if (!clipboardData) return false;
            const items = Array.from(clipboardData.items || []);
            let imageBlob: Blob | null = null;

            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) {
                        imageBlob = file;
                        break;
                    }
                }
            }

            if (!imageBlob && clipboardData.files?.length) {
                const file = Array.from(clipboardData.files).find((f) => f.type.startsWith('image/'));
                imageBlob = file ?? null;
            }

            if (imageBlob) {
                const dataUrl = await downscaleImageBlob(imageBlob);
                if (dataUrl) {
                    createImageBox(dataUrl);
                    return true;
                }
            }

            const htmlText = clipboardData.getData('text/html');
            const plainText = clipboardData.getData('text/plain');
            const uriText = clipboardData.getData('text/uri-list');

            const uriLine = uriText
                ? uriText.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? ''
                : '';
            const rawText = plainText || uriLine;

            if (rawText) {
                const parsed = tryParsePayload(rawText);
                if (parsed) {
                    doPasteSelection(parsed);
                    return true;
                }
            }

            if (htmlText) {
                const imgSrc = extractImageFromHtml(htmlText);
                if (imgSrc) {
                    createImageBox(imgSrc);
                    return true;
                }
                const htmlTextContent = htmlText.replace(/<[^>]+>/g, ' ').trim();
                if (htmlTextContent) {
                    pasteFromText(htmlTextContent);
                    return true;
                }
            }

            if (rawText) {
                pasteFromText(rawText);
                return true;
            }

            if (localPayload) {
                doPasteSelection(localPayload);
                return true;
            }

            return false;
        };

        const pasteFromClipboard = async (localPayload: ClipboardPayload | null) => {
            if (navigator.clipboard?.read) {
                try {
                    const items = await navigator.clipboard.read();
                    let imageBlob: Blob | null = null;
                    let htmlText: string | null = null;
                    let plainText: string | null = null;
                    let uriText: string | null = null;

                    for (const item of items) {
                        for (const type of item.types) {
                            if (!imageBlob && type.startsWith('image/')) {
                                imageBlob = await item.getType(type);
                            } else if (!htmlText && type === 'text/html') {
                                htmlText = await item.getType(type).then((b) => b.text());
                            } else if (!plainText && type === 'text/plain') {
                                plainText = await item.getType(type).then((b) => b.text());
                            } else if (!uriText && type === 'text/uri-list') {
                                uriText = await item.getType(type).then((b) => b.text());
                            }
                        }
                    }

                    const uriLine = uriText
                        ? uriText.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? ''
                        : '';
                    const rawText = plainText ?? uriLine;
                    if (rawText) {
                        const parsed = tryParsePayload(rawText);
                        if (parsed) {
                            doPasteSelection(parsed);
                            return;
                        }
                    }

                    if (imageBlob) {
                        const dataUrl = await downscaleImageBlob(imageBlob);
                        if (dataUrl) {
                            createImageBox(dataUrl);
                            return;
                        }
                    }

                    if (htmlText) {
                        const imgSrc = extractImageFromHtml(htmlText);
                        if (imgSrc) {
                            createImageBox(imgSrc);
                            return;
                        }
                        const htmlTextContent = htmlText.replace(/<[^>]+>/g, ' ').trim();
                        if (htmlTextContent) {
                            pasteFromText(htmlTextContent);
                            return;
                        }
                    }

                    if (rawText) {
                        pasteFromText(rawText);
                        return;
                    }

                    doPasteSelection(localPayload);
                    return;
                } catch {
                    // Fall back to text-only paste.
                }
            }

            if (navigator.clipboard?.readText) {
                navigator.clipboard
                    .readText()
                    .then((text) => {
                        const parsed = tryParsePayload(text);
                        if (parsed) {
                            doPasteSelection(parsed);
                        } else {
                            pasteFromText(text);
                        }
                    })
                    .catch(() => doPasteSelection(localPayload));
            } else {
                doPasteSelection(localPayload);
            }
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if typing in an input
            const target = e.target as any;
            const isInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
            const isCE = target instanceof HTMLElement && target.isContentEditable;

            const isDeleteKey = e.key === 'Backspace' || e.key === 'Delete' || String(e.key || '').toLowerCase() === 'backspace';
            if (isDeleteKey) {
                const st = useStore.getState();
                debugLog({
                    type: 'keydown',
                    t: performance.now(),
                    key: String(e.key),
                    code: (e as any).code,
                    ctrl: !!e.ctrlKey,
                    meta: !!e.metaKey,
                    shift: !!e.shiftKey,
                    alt: !!e.altKey,
                    activeTag: (document.activeElement as any)?.tagName,
                    activeIsContentEditable: !!(document.activeElement as any)?.isContentEditable,
                    ignored: isInput || isCE,
                    ignoreReason: isInput ? 'target_is_input' : isCE ? 'target_is_contenteditable' : undefined,
                    selection: { node: st.selectedNode, edge: st.selectedEdge, textBox: st.selectedTextBoxId },
                });
            }

            if (isInput || isCE) return;

            const isMod = e.ctrlKey || e.metaKey;
            const key = String(e.key || '').toLowerCase();

            // Cmd/Ctrl + Z: undo / redo
            if (isMod && key === 'z') {
                e.preventDefault();
                if (e.shiftKey) useStore.getState().redo();
                else useStore.getState().undo();
                return;
            }

            // Cmd/Ctrl + C: copy selected
            if (isMod && key === 'c') {
                const st = useStore.getState();
                const selectedNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
                const selectedEdges = st.selectedEdges?.length ? st.selectedEdges : (st.selectedEdge ? [st.selectedEdge] : []);
                const selectedTextBoxes = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
                if (selectedNodes.length === 0 && selectedEdges.length === 0 && selectedTextBoxes.length === 0) return;
                e.preventDefault();

                const nodes = selectedNodes
                    .map((id) => st.nodes.find((n) => n.id === id))
                    .filter(Boolean) as NodeData[];
                let edges = selectedEdges
                    .map((id) => st.edges.find((ed) => ed.id === id))
                    .filter(Boolean) as EdgeData[];
                if (edges.length === 0 && nodes.length > 0) {
                    const nodeSet = new Set(nodes.map((n) => n.id));
                    edges = st.edges.filter((ed) => nodeSet.has(ed.source) && nodeSet.has(ed.target));
                }
                const textBoxes = selectedTextBoxes
                    .map((id) => st.textBoxes.find((tb) => tb.id === id))
                    .filter(Boolean) as TextBoxType[];

                const payload: ClipboardPayload = { kind: 'selection', nodes, edges, textBoxes };
                clipboardRef.current = payload;
                navigator.clipboard?.writeText?.(JSON.stringify(payload)).catch(() => undefined);
                return;
            }

            // Cmd/Ctrl + V: paste
            if (isMod && key === 'v') {
                if (pasteFallbackTimerRef.current) window.clearTimeout(pasteFallbackTimerRef.current);
                const requestedAt = Date.now();
                pasteFallbackTimerRef.current = window.setTimeout(() => {
                    if (pasteEventHandledAtRef.current >= requestedAt) return;
                    void pasteFromClipboard(clipboardRef.current);
                }, 120);
                return;
            }

            if (e.key === 'Backspace' || e.key === 'Delete') {
                const st = useStore.getState();
                const hasSelection =
                    !!st.selectedNode ||
                    !!st.selectedEdge ||
                    !!st.selectedTextBoxId ||
                    (st.selectedNodes?.length ?? 0) > 0 ||
                    (st.selectedEdges?.length ?? 0) > 0 ||
                    (st.selectedTextBoxes?.length ?? 0) > 0;
                if (!hasSelection) return;
                e.preventDefault();
                st.deleteSelection();
            }
        };

        const handlePaste = (e: ClipboardEvent) => {
            if (isEditableTarget(e.target)) return;
            pasteEventHandledAtRef.current = Date.now();
            if (pasteFallbackTimerRef.current) {
                window.clearTimeout(pasteFallbackTimerRef.current);
                pasteFallbackTimerRef.current = null;
            }
            e.preventDefault();
            void pasteFromClipboardData(e.clipboardData, clipboardRef.current);
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('paste', handlePaste);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('paste', handlePaste);
            if (pasteFallbackTimerRef.current) window.clearTimeout(pasteFallbackTimerRef.current);
        };
    }, [addEdge, addNode, addTextBox, screenToWorld]);

    // Physics Simulation Loop
    const physicsEnabled = useStore((state) => state.physicsEnabled);
    const requestRef = useRef<number | null>(null);
    const velocities = useRef<Record<string, { vx: number, vy: number }>>({});
    const physicsStartTime = useRef<number | null>(null);
    const draggingNodeIdRef = useRef<string | null>(null);
    const lastDragTime = useRef<number>(0);
    const lastDragPos = useRef<{ x: number; y: number } | null>(null);

    useEffect(() => {
        if (physicsEnabled) {
            velocities.current = {};
            physicsStartTime.current = performance.now();
        } else {
            physicsStartTime.current = null;
        }
    }, [physicsEnabled]);

    useEffect(() => {
        if (!physicsEnabled) {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
            return;
        }

        const animate = () => {
            const { nodes, edges, updateNode } = useStore.getState();
            const draggedId = draggingNodeIdRef.current;

            const start = physicsStartTime.current ?? performance.now();
            const ramp = Math.min(Math.max((performance.now() - start) / 400, 0), 1);

            // Initialize velocities if needed
            nodes.forEach(node => {
                if (!velocities.current[node.id]) {
                    velocities.current[node.id] = { vx: 0, vy: 0 };
                }
            });

            const updates: Record<string, { x: number, y: number }> = {};
            let moved = false;

            // 1. Repulsion (All vs All)
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const n1 = nodes[i];
                    const n2 = nodes[j];

                    const dx = n1.x - n2.x;
                    const dy = n1.y - n2.y;
                    let dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist === 0) dist = 0.1;

                    const force = (500000 / (dist * dist)) * ramp;
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;

                    if (n1.id !== draggedId) {
                        velocities.current[n1.id].vx += fx;
                        velocities.current[n1.id].vy += fy;
                    }
                    if (n2.id !== draggedId) {
                        velocities.current[n2.id].vx -= fx;
                        velocities.current[n2.id].vy -= fy;
                    }
                }
            }

            // 2. Attraction (Edges)
            edges.forEach(edge => {
                const source = nodes.find(n => n.id === edge.source);
                const target = nodes.find(n => n.id === edge.target);
                if (!source || !target) return;

                const dx = target.x - source.x;
                const dy = target.y - source.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 0.001) return;
                const SPRING_LEN = 300;
                const force = (dist - SPRING_LEN) * 0.01 * ramp;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;

                if (source.id !== draggedId) {
                    velocities.current[source.id].vx += fx;
                    velocities.current[source.id].vy += fy;
                }
                if (target.id !== draggedId) {
                    velocities.current[target.id].vx -= fx;
                    velocities.current[target.id].vy -= fy;
                }
            });

            // 3. Center Gravity & Integration
            nodes.forEach(node => {
                if (node.id === draggedId) return;
                const body = velocities.current[node.id];
                body.vx -= node.x * 0.002 * ramp;
                body.vy -= node.y * 0.002 * ramp;
                body.vx *= 0.8;
                body.vy *= 0.8;

                const speed = Math.sqrt(body.vx * body.vx + body.vy * body.vy);
                if (speed > 50) {
                    body.vx = (body.vx / speed) * 50;
                    body.vy = (body.vy / speed) * 50;
                }

                if (speed > 1.1) {
                    updates[node.id] = { x: node.x + body.vx, y: node.y + body.vy };
                    moved = true;
                }
            });

            if (moved) {
                Object.entries(updates).forEach(([id, pos]) => {
                    updateNode(id, pos);
                });
            }

            requestRef.current = requestAnimationFrame(animate);
        };

        requestRef.current = requestAnimationFrame(animate);
        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        };
    }, [physicsEnabled]);

    const startNodeConnection = (e: React.PointerEvent, nodeId: string) => {
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) return;

        // While connecting we don't want existing selection-driven dimming (backgroundNoise).
        // Clear selection so all nodes remain fully visible when choosing a target.
        {
            const { selectNode, selectEdge, selectTextBox } = useStore.getState();
            selectNode(null);
            selectEdge(null);
            selectTextBox(null);
            setEditingTextBoxId(null);
            clearMarqueeHover();
        }

        setMode('connecting');
        setActiveId(nodeId);
        connectingPointerIdRef.current = e.pointerId;
        connectingPointerTypeRef.current = e.pointerType;
        setConnectionStart({ x: node.x, y: node.y });
        setCursorPos(screenToWorld(e.clientX, e.clientY));
        updateConnectionTargetFromClientPoint(e.clientX, e.clientY, nodeId);
    };

	    const handlePointerDown = (e: React.PointerEvent) => {
	        // Palm rejection: ignore touch pointers while a pencil stroke is active.
	        if (penStrokeActiveRef.current && e.pointerType === 'touch') {
	            e.preventDefault();
	            return;
	        }
        shiftPressCandidate.current = null;

        const target = e.target as HTMLElement;
        const isInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
        clearCanvasLongPress();

        if (e.pointerType === 'mouse' && e.button === 2) {
            return;
        }

	        // Don't handle events on buttons - let them bubble normally
        const isButton = target.closest('button');
        if (isButton) {
            return; // Let button handle its own events
        }

	        // Allow node sub-controls/editors to handle their own pointer events
		        const isInteractive = target.closest('[data-interactive="true"]');
		        if (isInteractive) {
		            return;
		        }

	        // Ignore secondary touch pointers here; pinch is handled via native touch events.
	        if (e.pointerType === 'touch' && e.isPrimary === false) {
	            e.preventDefault();
	            return;
	        }

	        // Mark an active pen interaction only once we know the canvas is handling the pointer.
	        if (e.pointerType === 'pen') {
	            penStrokeActiveRef.current = true;
	        }

	        // Prevent default browser behavior (text selection, etc.) unless interacting with input
	        if (!isInput) {
	            e.preventDefault();
	        }
        // Ensure keyboard shortcuts (delete/undo etc.) aren't "eaten" by a previously-focused input.
        if (!isInput) {
            try {
                (document.activeElement as HTMLElement | null)?.blur?.();
            } catch {
                // ignore
            }
        }

        const nodeElement = target.closest('[data-node-id]');

        lastPointerPos.current = { x: e.clientX, y: e.clientY };
        lastPointerKnownRef.current = true;
        pointerDownPos.current = { x: e.clientX, y: e.clientY };
        // Only capture pointer for mouse/pen events, not touch (iOS Safari has issues with touch capture)
        if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
            containerRef.current?.setPointerCapture(e.pointerId);
        }

        if (nodeElement) {
            const nodeId = nodeElement.getAttribute('data-node-id')!;
            const worldPos = screenToWorld(e.clientX, e.clientY);
            const node = nodes.find(n => n.id === nodeId)!;

            // Touch: allow long-press to open context menu and drag to move node
	            if (e.pointerType === 'touch' && !penMode) {
	                clearLongPress();
	                touchPressCandidate.current = {
	                    nodeId,
                    downClientX: e.clientX,
                    downClientY: e.clientY,
                    pointerType: e.pointerType,
                };
	                longPressTimer.current = setTimeout(() => {
	                    const candidate = touchPressCandidate.current;
	                    if (!candidate || candidate.nodeId !== nodeId) return;
	                    const st = useStore.getState();
	                    const selectedNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
	                    const selectedEdges = st.selectedEdges?.length ? st.selectedEdges : (st.selectedEdge ? [st.selectedEdge] : []);
	                    const selectedTextBoxes = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
	                    const multiCount = selectedNodes.length + selectedEdges.length + selectedTextBoxes.length;

	                    const isInSelection = selectedNodes.includes(nodeId);
	                    if (multiCount > 1 && isInSelection) {
	                        setContextMenu({ kind: 'selection', id: '__selection__', x: candidate.downClientX, y: candidate.downClientY });
	                    } else {
	                        setContextMenu({ kind: 'node', id: nodeId, x: candidate.downClientX, y: candidate.downClientY });
	                        selectNode(nodeId);
	                    }
	                    setMode('idle');
	                    setActiveId(null);
	                    clearLongPress();
	                }, LONG_PRESS_MS);
                e.stopPropagation();
                return;
            }

		            if (e.shiftKey) {
		                shiftPressCandidate.current = {
		                    nodeId,
		                    pointerId: e.pointerId,
		                    downClientX: e.clientX,
		                    downClientY: e.clientY,
		                };
		                e.stopPropagation();
		                return;
		            } else {
	                const st = useStore.getState();
	                const selectedNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
	                const selectedTextBoxes = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
	                const multiCount = selectedNodes.length + selectedTextBoxes.length;
	                const shouldGroupDrag = multiCount > 1 && selectedNodes.includes(nodeId);

	                if (shouldGroupDrag) {
	                    groupDragRef.current = {
	                        pointerId: e.pointerId,
	                        startWorld: worldPos,
	                        nodeStarts: selectedNodes
	                            .map((id) => {
	                                const n = st.nodes.find((nn) => nn.id === id);
	                                return n ? { id, x: n.x, y: n.y } : null;
	                            })
	                            .filter(Boolean) as any,
	                        textBoxStarts: selectedTextBoxes
	                            .map((id) => {
	                                const tb = st.textBoxes.find((t) => t.id === id);
	                                return tb ? { id, x: tb.x, y: tb.y } : null;
	                            })
	                            .filter(Boolean) as any,
	                        committed: false,
	                        lastT: performance.now(),
	                        lastPosByNode: {},
	                    };
	                    // Seed last positions for velocity updates (physics)
	                    for (const ns of groupDragRef.current.nodeStarts) {
	                        groupDragRef.current.lastPosByNode[ns.id] = { x: ns.x, y: ns.y };
	                    }
	                } else {
	                    groupDragRef.current = null;
	                }

	                // Start Dragging Node (single or group)
	                setMode('draggingNode');
	                setActiveId(nodeId);
	                draggingNodeIdRef.current = nodeId;
	                lastDragTime.current = performance.now();
	                lastDragPos.current = { x: node.x, y: node.y };
	                dragStartPosRef.current = { x: node.x, y: node.y };
	                pendingDragUndoSnapshotRef.current = {
	                    nodes: useStore.getState().nodes,
	                    edges: useStore.getState().edges,
	                    drawings: useStore.getState().drawings,
	                    textBoxes: useStore.getState().textBoxes,
	                    tombstones: useStore.getState().tombstones,
	                };
	                dragUndoCommittedRef.current = false;
	                setDragOffset({ x: worldPos.x - node.x, y: worldPos.y - node.y });
            }
            e.stopPropagation();
        } else {
            if (e.pointerType === 'touch' && !penMode && !textMode) {
                clearCanvasLongPress();
                const worldPos = screenToWorld(e.clientX, e.clientY);
                canvasTouchCandidate.current = {
                    pointerId: e.pointerId,
                    downClientX: e.clientX,
                    downClientY: e.clientY,
                    downWorldX: worldPos.x,
                    downWorldY: worldPos.y,
                };
                canvasLongPressTimer.current = setTimeout(() => {
                    const candidate = canvasTouchCandidate.current;
                    if (!candidate || candidate.pointerId !== e.pointerId) return;
                    setContextMenu({
                        kind: 'canvas',
                        id: '__canvas__',
                        x: candidate.downClientX,
                        y: candidate.downClientY,
                        worldX: candidate.downWorldX,
                        worldY: candidate.downWorldY,
                    });
                    setMode('idle');
                    setActiveId(null);
                    setMarqueeRect(null);
                    marqueeStartRef.current = null;
                    clearMarqueeHover();
                    clearCanvasLongPress();
                }, LONG_PRESS_MS);
                e.stopPropagation();
                return;
            }
            if (textMode) {
                setMode('textPlacing');
                setActiveId(null);
                setContextMenu(null);
                setEditingTextBoxId(null);
                useStore.getState().selectTextBox(null);
                const { selectNode, selectEdge } = useStore.getState();
                selectNode(null);
                selectEdge(null);
                return;
            }
            // If pen mode is on and we are not starting on a node, start drawing
            if (penMode) {
                if (penTool === 'pen' || penTool === 'highlighter') {
                    isDrawing.current = true;
                    drawingPointerIdRef.current = e.pointerId;
                    drawingPointerTypeRef.current = e.pointerType;
                    penStrokeActiveRef.current = e.pointerType === 'pen';
                    const worldPos = screenToWorld(e.clientX, e.clientY);
                    clearLiveStroke();
                    applyLiveStrokeStyle({
                        stroke: penTool === 'highlighter' ? 'var(--accent-primary)' : 'var(--text-primary)',
                        width: penTool === 'highlighter' ? 20 : 3,
                        opacity: penTool === 'highlighter' ? 0.3 : 1,
                    });
                    pendingStrokePointsRef.current.push(worldPos);
                    scheduleLiveStrokeFlush();
                } else if (penTool === 'eraser') {
                    isDrawing.current = true;
                    drawingPointerIdRef.current = e.pointerId;
                    drawingPointerTypeRef.current = e.pointerType;
                    penStrokeActiveRef.current = e.pointerType === 'pen';
                    clearLiveStroke();
                    // Eraser starts working on down too
                    const worldPos = screenToWorld(e.clientX, e.clientY);
                    handleEraser(worldPos);
                }
	            } else {
	                // Default: marquee selection on primary press; panning requires Move mode.
	                const isPrimaryPress =
	                    e.pointerType === 'mouse' ? e.button === 0 : true;
	                if (isPrimaryPress && !moveMode) {
	                    setMode('selecting');
	                    marqueeStartRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
	                    setMarqueeRect({ left: e.clientX, top: e.clientY, width: 0, height: 0 });
	                    clearMarqueeHover();
                    const { selectNode, selectEdge, selectTextBox } = useStore.getState();
                    selectNode(null);
                    selectEdge(null);
                    selectTextBox(null);
                    setEditingTextBoxId(null);
	                    setContextMenu(null);
	                    return;
	                }
	
	                // Start Panning (when Move mode enabled)
	                setMode('panning');
	                const { selectNode, selectEdge, selectTextBox } = useStore.getState();
	                selectNode(null);
	                selectEdge(null);
                selectTextBox(null);
                setEditingTextBoxId(null);
	                setContextMenu(null);
	            }
	        }
	    };

    const handleEraser = (pos: { x: number, y: number }) => {
        // Simple radius check
        const ERASER_RADIUS = 20; // World units
        drawings.forEach(d => {
            // Check if any point in drawing is close
            const hit = d.points.some(p => Math.hypot(p.x - pos.x, p.y - pos.y) < ERASER_RADIUS);
            if (hit) {
                removeDrawing(d.id);
            }
        });
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        // Palm rejection: ignore touch pointers while a pencil stroke is active.
        if (penStrokeActiveRef.current && e.pointerType === 'touch') return;

        const screenDeltaX = e.clientX - lastPointerPos.current.x;
        const screenDeltaY = e.clientY - lastPointerPos.current.y;
        lastPointerPos.current = { x: e.clientX, y: e.clientY };
        lastPointerKnownRef.current = true;

        if (mode === 'selecting') {
            const start = marqueeStartRef.current;
            if (!start || start.pointerId !== e.pointerId) return;
            const left = Math.min(start.x, e.clientX);
            const top = Math.min(start.y, e.clientY);
            const width = Math.abs(e.clientX - start.x);
            const height = Math.abs(e.clientY - start.y);
            setMarqueeRect({ left, top, width, height });
            updateMarqueeHover({ left, top, width, height });
            return;
        }

        const shiftCandidate = shiftPressCandidate.current;
        if (shiftCandidate && shiftCandidate.pointerId === e.pointerId) {
            const dist = Math.hypot(
                e.clientX - shiftCandidate.downClientX,
                e.clientY - shiftCandidate.downClientY
            );
            if (dist > CLICK_THRESHOLD) {
                shiftPressCandidate.current = null;
                startNodeConnection(e, shiftCandidate.nodeId);
                return;
            }
        }

	        const candidate = touchPressCandidate.current;
	        if (candidate && e.pointerType === 'touch') {
	            const dist = Math.hypot(e.clientX - candidate.downClientX, e.clientY - candidate.downClientY);
	            if (dist > TOUCH_DRAG_THRESHOLD) {
	                // Cancel long-press and start dragging the node
	                clearLongPress();
	                const node = nodes.find((n) => n.id === candidate.nodeId);
	                if (node) {
	                    const worldPos = screenToWorld(e.clientX, e.clientY);
	                    // If this touch started on a multi-selected node, drag the whole selection.
	                    const st = useStore.getState();
	                    const selectedNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
	                    const selectedTextBoxes = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
	                    const multiCount = selectedNodes.length + selectedTextBoxes.length;
	                    const shouldGroupDrag = multiCount > 1 && selectedNodes.includes(candidate.nodeId);

	                    if (shouldGroupDrag) {
	                        groupDragRef.current = {
	                            pointerId: e.pointerId,
	                            startWorld: worldPos,
	                            nodeStarts: selectedNodes
	                                .map((id) => {
	                                    const n = st.nodes.find((nn) => nn.id === id);
	                                    return n ? { id, x: n.x, y: n.y } : null;
	                                })
	                                .filter(Boolean) as any,
	                            textBoxStarts: selectedTextBoxes
	                                .map((id) => {
	                                    const tb = st.textBoxes.find((t) => t.id === id);
	                                    return tb ? { id, x: tb.x, y: tb.y } : null;
	                                })
	                                .filter(Boolean) as any,
	                            committed: false,
	                            lastT: performance.now(),
	                            lastPosByNode: {},
	                        };
	                        for (const ns of groupDragRef.current.nodeStarts) {
	                            groupDragRef.current.lastPosByNode[ns.id] = { x: ns.x, y: ns.y };
	                        }
	                    } else {
	                        groupDragRef.current = null;
	                    }

	                    setMode('draggingNode');
	                    setActiveId(candidate.nodeId);
	                    draggingNodeIdRef.current = candidate.nodeId;
	                    lastDragTime.current = performance.now();
	                    lastDragPos.current = { x: node.x, y: node.y };
	                    dragStartPosRef.current = { x: node.x, y: node.y };
	                    pendingDragUndoSnapshotRef.current = {
	                        nodes: useStore.getState().nodes,
	                        edges: useStore.getState().edges,
	                        drawings: useStore.getState().drawings,
	                        textBoxes: useStore.getState().textBoxes,
	                        tombstones: useStore.getState().tombstones,
	                    };
                    dragUndoCommittedRef.current = false;
                    setDragOffset({ x: worldPos.x - node.x, y: worldPos.y - node.y });
                    setContextMenu(null);
                }
            }
        }

        const canvasCandidate = canvasTouchCandidate.current;
        if (canvasCandidate && e.pointerType === 'touch') {
            const dist = Math.hypot(e.clientX - canvasCandidate.downClientX, e.clientY - canvasCandidate.downClientY);
            if (dist > TOUCH_DRAG_THRESHOLD) {
                clearCanvasLongPress();
                const { selectNode, selectEdge, selectTextBox } = useStore.getState();
                selectNode(null);
                selectEdge(null);
                selectTextBox(null);
                setEditingTextBoxId(null);
                if (moveMode) {
                    setMode('panning');
                    setCanvasTransform(canvas.x + screenDeltaX, canvas.y + screenDeltaY, canvas.scale);
                } else {
                    setMode('selecting');
                    marqueeStartRef.current = { x: canvasCandidate.downClientX, y: canvasCandidate.downClientY, pointerId: e.pointerId };
                    const left = Math.min(canvasCandidate.downClientX, e.clientX);
                    const top = Math.min(canvasCandidate.downClientY, e.clientY);
                    const width = Math.abs(e.clientX - canvasCandidate.downClientX);
                    const height = Math.abs(e.clientY - canvasCandidate.downClientY);
                    setMarqueeRect({ left, top, width, height });
                    clearMarqueeHover();
                }
                setContextMenu(null);
            }
            return;
        }

        if (mode === 'textPlacing') {
            const dx = e.clientX - pointerDownPos.current.x;
            const dy = e.clientY - pointerDownPos.current.y;
            if (Math.hypot(dx, dy) > CLICK_THRESHOLD) {
                setMode('panning');
                const { selectNode, selectEdge } = useStore.getState();
                selectNode(null);
                selectEdge(null);
                setEditingTextBoxId(null);
                setContextMenu(null);
            } else {
                return;
            }
        }

        if (isDrawing.current && penMode) {
            if (drawingPointerIdRef.current !== null && e.pointerId !== drawingPointerIdRef.current) return;
            const native = e.nativeEvent as PointerEvent;
            const events = native.getCoalescedEvents?.() ?? [native];
            for (const ev of events) {
                const worldPos = screenToWorld(ev.clientX, ev.clientY);
                if (penTool === 'eraser') {
                    handleEraser(worldPos);
                } else {
                    pendingStrokePointsRef.current.push(worldPos);
                }
            }
            if (penTool !== 'eraser') scheduleLiveStrokeFlush();
        } else if (mode === 'panning' && !isPinching.current) {
            setCanvasTransform(canvas.x + screenDeltaX, canvas.y + screenDeltaY, canvas.scale);
	        } else if (mode === 'draggingNode' && activeId) {
	            const worldPos = screenToWorld(e.clientX, e.clientY);
	            const group = groupDragRef.current;
	            if (group && group.pointerId === e.pointerId) {
	                let dx = worldPos.x - group.startWorld.x;
	                let dy = worldPos.y - group.startWorld.y;
	                if (snapMode) {
	                    const anchor = group.nodeStarts.find((ns) => ns.id === activeId) ?? group.nodeStarts[0];
	                    if (anchor) {
	                        const size = getNodeSize(anchor.id) ?? { width: 0, height: 0 };
	                        const snapped = resolveSnap({
	                            x: anchor.x + dx,
	                            y: anchor.y + dy,
	                            width: size.width,
	                            height: size.height,
	                            anchor: 'center',
	                            excludeNodeIds: group.nodeStarts.map((ns) => ns.id),
	                            excludeTextBoxIds: group.textBoxStarts.map((ts0) => ts0.id),
	                        });
	                        dx = snapped.x - anchor.x;
	                        dy = snapped.y - anchor.y;
	                    } else {
	                        clearAlignmentGuides();
	                    }
	                } else {
	                    clearAlignmentGuides();
	                }

	                const moved = Math.hypot(dx, dy) > 2;
	                if (moved && !group.committed && pendingDragUndoSnapshotRef.current) {
	                    useStore.getState().pushHistory(pendingDragUndoSnapshotRef.current as any);
	                    pendingDragUndoSnapshotRef.current = null;
	                    dragUndoCommittedRef.current = true;
	                    group.committed = true;
	                }

	                const { updateNode, updateTextBox } = useStore.getState() as any;
	                for (const ns of group.nodeStarts) {
	                    updateNode(ns.id, { x: ns.x + dx, y: ns.y + dy });
	                }
	                for (const ts0 of group.textBoxStarts) {
	                    updateTextBox(ts0.id, { x: ts0.x + dx, y: ts0.y + dy });
	                }

	                if (physicsEnabled) {
	                    const nowT = performance.now();
	                    const dtMs = Math.max(1, nowT - group.lastT);
	                    for (const ns of group.nodeStarts) {
	                        const nextX = ns.x + dx;
	                        const nextY = ns.y + dy;
	                        const prev = group.lastPosByNode[ns.id];
	                        if (prev) {
	                            const vx = ((nextX - prev.x) / dtMs) * 16.7;
	                            const vy = ((nextY - prev.y) / dtMs) * 16.7;
	                            velocities.current[ns.id] = { vx, vy };
	                        }
	                        group.lastPosByNode[ns.id] = { x: nextX, y: nextY };
	                    }
	                    group.lastT = nowT;
	                }
	                return;
	            }

	            let nextX = worldPos.x - dragOffset.x;
	            let nextY = worldPos.y - dragOffset.y;
	            if (snapMode && activeId) {
	                const size = getNodeSize(activeId) ?? { width: 0, height: 0 };
	                const snapped = resolveSnap({
	                    x: nextX,
	                    y: nextY,
	                    width: size.width,
	                    height: size.height,
	                    anchor: 'center',
	                    excludeNodeIds: [activeId],
	                });
	                nextX = snapped.x;
	                nextY = snapped.y;
	            } else if (!snapMode) {
	                clearAlignmentGuides();
	            }

	            if (!dragUndoCommittedRef.current && pendingDragUndoSnapshotRef.current && dragStartPosRef.current) {
	                const moved = Math.hypot(nextX - dragStartPosRef.current.x, nextY - dragStartPosRef.current.y) > 2;
	                if (moved) {
	                    useStore.getState().pushHistory(pendingDragUndoSnapshotRef.current as any);
                    pendingDragUndoSnapshotRef.current = null;
                    dragUndoCommittedRef.current = true;
                }
            }
            updateNode(activeId, { x: nextX, y: nextY });

            if (physicsEnabled) {
                const now = performance.now();
                const prev = lastDragPos.current;
                const dtMs = Math.max(1, now - lastDragTime.current);
                if (prev) {
                    const vx = ((nextX - prev.x) / dtMs) * 16.7;
                    const vy = ((nextY - prev.y) / dtMs) * 16.7;
                    velocities.current[activeId] = { vx, vy };
                }
                lastDragTime.current = now;
                lastDragPos.current = { x: nextX, y: nextY };
            }
	        } else if (mode === 'connecting') {
	            if (connectingPointerTypeRef.current === 'touch') return;
	            const pid = connectingPointerIdRef.current;
	            if (pid !== null && e.pointerId !== pid) return;
	            const worldPos = screenToWorld(e.clientX, e.clientY);
	            setCursorPos(worldPos);

	            if (activeId) updateConnectionTargetFromClientPoint(e.clientX, e.clientY, activeId);
	        }
    };

		    const handlePointerUp = (e: React.PointerEvent) => {
        // Palm rejection: ignore touch pointers while a pencil stroke is active.
        if (penStrokeActiveRef.current && e.pointerType === 'touch') return;
        clearCanvasLongPress();

	        if (mode === 'selecting') {
	            const rect = marqueeRect;
	            setMarqueeRect(null);
	            marqueeStartRef.current = null;
	            clearMarqueeHover();

            const w = rect?.width ?? 0;
            const h = rect?.height ?? 0;
            const isDragSelect = w > 6 || h > 6;

            const { selectNode, selectEdge, selectTextBox, setMultiSelection, setEditingTextBoxId } = useStore.getState();
            selectEdge(null);
            setEditingTextBoxId(null);

            if (isDragSelect && rect) {
                const selLeft = rect.left;
                const selTop = rect.top;
                const selRight = rect.left + rect.width;
                const selBottom = rect.top + rect.height;

                const intersects = (r: DOMRect) => !(r.right < selLeft || r.left > selRight || r.bottom < selTop || r.top > selBottom);

                const nodeIds: string[] = [];
                document.querySelectorAll<HTMLElement>('[data-node-bounds="true"]').forEach((el) => {
                    const id = el.getAttribute('data-node-id');
                    if (!id) return;
                    const r = el.getBoundingClientRect();
                    if (intersects(r)) nodeIds.push(id);
                });

                const textBoxIds: string[] = [];
                document.querySelectorAll<HTMLElement>('[data-textbox-id]').forEach((el) => {
                    const id = el.getAttribute('data-textbox-id');
                    if (!id) return;
                    const r = el.getBoundingClientRect();
                    if (intersects(r)) textBoxIds.push(id);
                });

                const edgeIds: string[] = [];
                document.querySelectorAll<HTMLElement>('[data-edge-id]').forEach((el) => {
                    const id = el.getAttribute('data-edge-id');
                    if (!id) return;
                    const r = el.getBoundingClientRect();
                    if (intersects(r)) edgeIds.push(id);
                });

                const uniqueNodes = Array.from(new Set(nodeIds));
                const uniqueText = Array.from(new Set(textBoxIds));
                const uniqueEdges = Array.from(new Set(edgeIds));

                if (uniqueNodes.length === 1 && uniqueText.length === 0 && uniqueEdges.length === 0) {
                    selectTextBox(null);
                    selectNode(uniqueNodes[0]);
                } else if (uniqueText.length === 1 && uniqueNodes.length === 0 && uniqueEdges.length === 0) {
                    selectNode(null);
                    selectTextBox(uniqueText[0]);
                } else if (uniqueEdges.length === 1 && uniqueNodes.length === 0 && uniqueText.length === 0) {
                    selectNode(null);
                    selectTextBox(null);
                    selectEdge(uniqueEdges[0]);
                } else {
                    selectNode(null);
                    selectTextBox(null);
                    setMultiSelection({ nodes: uniqueNodes, textBoxes: uniqueText, edges: uniqueEdges });
                }
            } else {
                // Click on empty space: clear selection
                selectNode(null);
                selectTextBox(null);
            }

            setMode('idle');
            setActiveId(null);
            draggingNodeIdRef.current = null;
            lastDragPos.current = null;
            pendingDragUndoSnapshotRef.current = null;
            dragUndoCommittedRef.current = false;
            dragStartPosRef.current = null;
	            if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
	                try {
	                    const el = containerRef.current as any;
	                    if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
	                } catch {
	                    // ignore
	                }
	            }
	            if (e.pointerType === 'pen') {
	                penStrokeActiveRef.current = false;
	            }
	            clearAlignmentGuides();
		            return;
		        }

	        if (mode === 'connecting') {
	            const connectType = connectingPointerTypeRef.current;
	            if (connectType === 'touch') return;
	            const pid = connectingPointerIdRef.current;
	            if (pid !== null && e.pointerId !== pid) return;
	        }

	        // Check for click (small movement)
        const dist = Math.sqrt(
            Math.pow(e.clientX - pointerDownPos.current.x, 2) +
            Math.pow(e.clientY - pointerDownPos.current.y, 2)
        );
        const isClick = dist < CLICK_THRESHOLD;

        const shiftCandidate = shiftPressCandidate.current;
        if (shiftCandidate && shiftCandidate.pointerId === e.pointerId) {
            shiftPressCandidate.current = null;
            if (isClick) {
                const st = useStore.getState();
                const selectedNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
                const selectedEdges = st.selectedEdges?.length ? st.selectedEdges : (st.selectedEdge ? [st.selectedEdge] : []);
                const selectedTextBoxes = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
                const nextNodes = Array.from(new Set([...selectedNodes, shiftCandidate.nodeId]));
                const { selectNode, selectEdge, selectTextBox, setMultiSelection, setEditingTextBoxId } = st;

                setEditingTextBoxId(null);
                if (nextNodes.length === 1 && selectedEdges.length === 0 && selectedTextBoxes.length === 0) {
                    selectEdge(null);
                    selectTextBox(null);
                    selectNode(nextNodes[0]);
                } else {
                    selectNode(null);
                    selectEdge(null);
                    selectTextBox(null);
                    setMultiSelection({ nodes: nextNodes, textBoxes: selectedTextBoxes, edges: selectedEdges });
                }
            }
        }

        // Touch candidate: treat as tap-select if we didn't long-press and didn't start dragging.
        if (touchPressCandidate.current) {
            const nodeId = touchPressCandidate.current.nodeId;
            clearLongPress();
            if (isClick && !contextMenu) {
                selectNode(nodeId);
            }
            // Do not early-return: allow connection/pan cleanup below.
        }

        if (isDrawing.current) {
            if (drawingPointerIdRef.current !== null && e.pointerId !== drawingPointerIdRef.current) return;
            isDrawing.current = false;
            flushPendingStrokePoints();
            // Finish drawing
            const points = currentStrokePointsRef.current;
            if (points.length > 1 && penTool !== 'eraser') {
                const isHighlighter = penTool === 'highlighter';
                addDrawing({
                    id: uuidv4(),
                    ...(() => {
                        const { points: beautifiedPoints, path } = beautifyStroke(points);
                        return { points: beautifiedPoints, path };
                    })(),
                    color: isHighlighter ? 'var(--accent-primary)' : 'var(--text-primary)',
                    width: isHighlighter ? 20 : 3,
                    opacity: isHighlighter ? 0.3 : 1,
                    tool: penTool
                });
            }
            clearLiveStroke();
            drawingPointerIdRef.current = null;
            drawingPointerTypeRef.current = null;
            penStrokeActiveRef.current = false;
            if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
                try {
                    const el = containerRef.current as any;
                    if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
                } catch {
                    // ignore
                }
            }
            return;
        }

        if (mode === 'textPlacing') {
            if (isClick) {
                const target = e.target as HTMLElement;
                if (
                    !target.closest('[data-node-id]') &&
                    !target.closest('[data-textbox-id]') &&
                    !target.closest('button')
                ) {
	                    const worldPos = screenToWorld(e.clientX, e.clientY);
	                    const w = 240;
	                    const h = 96;
	                    addTextBox({
	                        id: uuidv4(),
	                        x: worldPos.x - w / 2,
	                        y: worldPos.y - h / 2,
	                        width: w,
	                        height: h,
	                        text: '',
	                    });
	                    // Exit text tool after placing a box (one-shot placement).
	                    toggleTextMode();
	                }
	            }
	        } else if (mode === 'connecting' && activeId) {
	            finalizeConnectionAtClientPoint(e.clientX, e.clientY, activeId);
	        } else if (mode === 'draggingNode' && activeId && isClick) {
	            const st = useStore.getState();
	            const selectedNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
	            const selectedTextBoxes = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
	            const isMulti = (selectedNodes.length + selectedTextBoxes.length) > 1;
	            // Clicked on a node without dragging -> select single only if we are not in multi-selection
	            if (!isMulti) selectNode(activeId);
	        }

		        setMode('idle');
		        setActiveId(null);
		        connectingPointerIdRef.current = null;
		        connectingPointerTypeRef.current = null;
		        groupDragRef.current = null;
		        draggingNodeIdRef.current = null;
        shiftPressCandidate.current = null;
		        lastDragPos.current = null;
	        pendingDragUndoSnapshotRef.current = null;
	        dragUndoCommittedRef.current = false;
        dragStartPosRef.current = null;
        // Only release capture for mouse/pen events (matching setPointerCapture)
        if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
            try {
                const el = containerRef.current as any;
                if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
            } catch {
                // ignore
            }
        }

        if (e.pointerType === 'pen') {
            penStrokeActiveRef.current = false;
        }
        clearAlignmentGuides();
    };

    const handleDoubleClick = (e: React.MouseEvent) => {
        if (penMode || textMode) return;
        // Only create if clicking on empty canvas
        const target = e.target as HTMLElement;
        // Prevent node creation when double-clicking on existing objects or interactive UI.
        if (
            target.closest('[data-node-id]')
            || target.closest('[data-textbox-id]')
            || target.closest('[data-interactive="true"]')
        ) return;

        const worldPos = screenToWorld(e.clientX, e.clientY);
        addNode({
            id: uuidv4(),
            title: 'New Thought',
            content: '',
            type: 'idea',
            x: worldPos.x,
            y: worldPos.y,
            clarity: 0.5,
            energy: 50
        });
    };

	    // Handle pointer cancel - iOS Safari fires this when it decides to handle a gesture
		    const handlePointerCancel = (e: React.PointerEvent) => {
		        // If a touch-based context connection drag is active, ignore pointercancel;
		        // some browsers emit cancel when UI overlays unmount, but touchend will finalize/cleanup.
		        if (e.pointerType === 'touch' && contextConnectActiveRef.current) return;
		        // Reset all interaction state
		        isDrawing.current = false;
		        setMode('idle');
		        setActiveId(null);
            clearCanvasLongPress();
	        setMarqueeRect(null);
	        marqueeStartRef.current = null;
	        clearMarqueeHover();
	        clearLiveStroke();
	        drawingPointerIdRef.current = null;
	        drawingPointerTypeRef.current = null;
	        penStrokeActiveRef.current = false;
        useStore.getState().setConnectionTargetId(null);
	        clearLongPress();
        shiftPressCandidate.current = null;
	        draggingNodeIdRef.current = null;
	        lastDragPos.current = null;
	        pendingDragUndoSnapshotRef.current = null;
	        dragUndoCommittedRef.current = false;
	        dragStartPosRef.current = null;
	        groupDragRef.current = null;
        if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
            try {
                const el = containerRef.current as any;
                if (el?.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
            } catch {
                // ignore
            }
        }
	        clearAlignmentGuides();
	    };

    const handlePointerLeave = (e: React.PointerEvent) => {
        // On touch devices pointerleave can fire mid-gesture when the finger crosses fixed UI,
        // which would prematurely finalize drags/connections. Let touch gestures finish via touchend/pointerup.
        if (e.pointerType === 'touch') return;
        handlePointerUp(e);
    };

    const handleCommentContextMenu = useCallback((e: React.MouseEvent) => {
        if (e.defaultPrevented) return;
        const target = e.target as HTMLElement;
        if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) return;
        const commentEl = target.closest('[data-comment-id]');
        if (!commentEl) return;
        const id = commentEl.getAttribute('data-comment-id');
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ kind: 'comment', id, x: e.clientX, y: e.clientY });
    }, [setContextMenu]);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        if (e.defaultPrevented) return;
        const target = e.target as HTMLElement;
        if (target.closest('[data-comment-ui="true"]')) return;
        if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) return;

        e.preventDefault();
        e.stopPropagation();

        const nodeEl = target.closest('[data-node-id]');
        const textEl = target.closest('[data-textbox-id]');
        const edgeEl = target.closest('[data-edge-id]');

        const st = useStore.getState();
        const selectedNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
        const selectedEdges = st.selectedEdges?.length ? st.selectedEdges : (st.selectedEdge ? [st.selectedEdge] : []);
        const selectedTextBoxes = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
        const multiCount = selectedNodes.length + selectedEdges.length + selectedTextBoxes.length;

        if (nodeEl) {
            const id = nodeEl.getAttribute('data-node-id');
            if (!id) return;
            if (multiCount > 1 && selectedNodes.includes(id)) {
                setContextMenu({ kind: 'selection', id: '__selection__', x: e.clientX, y: e.clientY });
                return;
            }
            st.selectNode(id);
            st.selectEdge(null);
            st.selectTextBox(null);
            st.setEditingTextBoxId(null);
            setContextMenu({ kind: 'node', id, x: e.clientX, y: e.clientY });
            return;
        }

        if (textEl) {
            const id = textEl.getAttribute('data-textbox-id');
            if (!id) return;
            if (multiCount > 1 && selectedTextBoxes.includes(id)) {
                setContextMenu({ kind: 'selection', id: '__selection__', x: e.clientX, y: e.clientY });
                return;
            }
            st.selectTextBox(id);
            st.selectNode(null);
            st.selectEdge(null);
            st.setEditingTextBoxId(null);
            setContextMenu({ kind: 'textBox', id, x: e.clientX, y: e.clientY });
            return;
        }

        if (edgeEl) {
            const id = edgeEl.getAttribute('data-edge-id');
            if (!id) return;
            if (multiCount > 1 && selectedEdges.includes(id)) {
                setContextMenu({ kind: 'selection', id: '__selection__', x: e.clientX, y: e.clientY });
                return;
            }
            st.selectEdge(id);
            st.selectNode(null);
            st.selectTextBox(null);
            st.setEditingTextBoxId(null);
            setContextMenu({ kind: 'edge', id, x: e.clientX, y: e.clientY });
            return;
        }

        const worldPos = screenToWorldLatest(e.clientX, e.clientY);
        setContextMenu({
            kind: 'canvas',
            id: '__canvas__',
            x: e.clientX,
            y: e.clientY,
            worldX: worldPos.x,
            worldY: worldPos.y,
        });
    }, [screenToWorldLatest]);

    // Helper to generate SVG path from points
    const getSvgPath = (points: { x: number; y: number }[]) => {
        if (points.length === 0) return '';
        const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
        return d;
    };

    const noteScale = 1 / Math.max(0.0001, canvas.scale);
    const focusHintVisible = canvas.scale > 1.1;
    const rootComments = React.useMemo(() => comments.filter((c) => !c.parentId), [comments]);
    const repliesByParent = React.useMemo(() => {
        const map = new Map<string, Comment[]>();
        comments.forEach((comment) => {
            if (!comment.parentId) return;
            if (!map.has(comment.parentId)) map.set(comment.parentId, []);
            map.get(comment.parentId)?.push(comment);
        });
        return map;
    }, [comments]);
    const showCommentLayer = commentsMode || !!draftComment || !!openCommentId;
    const getCommentLabel = (comment: Comment) => {
        const name = String(comment.authorName ?? 'Guest').trim();
        return name || 'Guest';
    };
    const getCommentInitial = (name: string) => name.trim().charAt(0).toUpperCase() || '?';
    const getCommentColor = (comment: Comment) => {
        if (Number.isFinite(comment.avatarColor)) {
            const idx = Number(comment.avatarColor);
            const hue = (idx * 37) % 360;
            return `hsl(${hue} 54% 45%)`;
        }
        const seed = String(comment.authorName ?? 'Guest');
        const hue = hashString(seed) % 360;
        return `hsl(${hue} 54% 45%)`;
    };
    const contextEdge = contextMenu?.kind === 'edge'
        ? edges.find((edge) => edge.id === contextMenu.id) ?? null
        : null;
    const contextEdgeEnergyEnabled = contextEdge?.energyEnabled !== false;

    return (
        <div
            ref={containerRef}
            className={`${styles.canvasContainer} ${mode === 'panning' ? styles.panning : ''}`}
            data-canvas-root="true"
	    onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            onPointerCancel={handlePointerCancel}
            onContextMenu={handleContextMenu}
            onDoubleClick={handleDoubleClick}
            style={{ cursor: textMode ? 'text' : penMode ? (penTool === 'eraser' ? 'cell' : 'crosshair') : undefined }}
        >
	            {contextMenu && (
	                <div
	                    className={styles.contextMenuOverlay}
	                    style={contextMenu.hidden ? { pointerEvents: 'none', opacity: 0 } : undefined}
	                    data-interactive="true"
	                    onPointerDown={() => setContextMenu(null)}
	                    onClick={() => setContextMenu(null)}
	                >
	                    <div
	                        className={styles.contextMenu}
	                        style={{
	                            left: contextMenu.x,
	                            top: contextMenu.y,
	                            opacity: contextMenu.hidden ? 0 : 1,
	                        }}
	                        data-interactive="true"
	                        onPointerDown={(e) => e.stopPropagation()}
	                        onClick={(e) => e.stopPropagation()}
	                    >
	                        {contextMenu.kind !== 'selection' && contextMenu.kind !== 'comment' && (
	                            <button
	                                type="button"
	                                className={styles.contextButton}
	                                title="Add comment"
	                                data-interactive="true"
	                                onPointerDown={(e) => {
	                                    e.preventDefault();
	                                    e.stopPropagation();
	                                    let draft: CommentDraft | null = null;
	                                    if (contextMenu.kind === 'canvas') {
	                                        const world = Number.isFinite(contextMenu.worldX) && Number.isFinite(contextMenu.worldY)
	                                            ? { x: contextMenu.worldX as number, y: contextMenu.worldY as number }
	                                            : screenToWorldLatest(contextMenu.x, contextMenu.y);
	                                        draft = { targetKind: 'canvas', targetId: null, x: world.x, y: world.y };
	                                    } else if (contextMenu.kind === 'node' && contextMenu.id) {
	                                        draft = { targetKind: 'node', targetId: contextMenu.id };
	                                    } else if (contextMenu.kind === 'edge' && contextMenu.id) {
	                                        draft = { targetKind: 'edge', targetId: contextMenu.id };
	                                    } else if (contextMenu.kind === 'textBox' && contextMenu.id) {
	                                        draft = { targetKind: 'textBox', targetId: contextMenu.id };
	                                    }
	                                    if (draft) startCommentDraft(draft);
	                                    setContextMenu(null);
	                                }}
	                            >
	                                <MessageCircle size={18} />
	                            </button>
	                        )}
	                        {contextMenu.kind !== 'canvas' && (
	                            <button
	                                type="button"
	                                className={styles.contextButton}
	                                title="Delete"
	                                data-interactive="true"
	                                onPointerDown={(e) => {
	                                    e.preventDefault();
	                                    e.stopPropagation();
	                                    const st = useStore.getState() as any;
	                                    if (contextMenu.kind === 'selection') {
	                                        st.deleteSelection();
	                                    } else if (contextMenu.kind === 'node' && contextMenu.id) {
	                                        st.deleteNode(contextMenu.id);
	                                        st.selectNode(null);
	                                    } else if (contextMenu.kind === 'edge' && contextMenu.id) {
	                                        st.deleteEdge(contextMenu.id);
	                                        st.selectEdge(null);
	                                    } else if (contextMenu.kind === 'textBox' && contextMenu.id) {
	                                        st.deleteTextBox(contextMenu.id);
	                                        st.selectTextBox(null);
	                                        st.setEditingTextBoxId(null);
	                                    } else if (contextMenu.kind === 'comment' && contextMenu.id) {
	                                        deleteComment(contextMenu.id);
	                                        setOpenCommentId((prev) => (prev === contextMenu.id ? null : prev));
	                                        setHoverCommentId((prev) => (prev === contextMenu.id ? null : prev));
	                                    }
	                                    setContextMenu(null);
	                                }}
	                            >
	                                <X size={18} />
	                            </button>
	                        )}
                            {contextMenu.kind === 'edge' && contextEdge && (
                                <button
                                    type="button"
                                    className={styles.contextButton}
                                    title={contextEdgeEnergyEnabled ? 'Disable energy flow' : 'Enable energy flow'}
                                    data-interactive="true"
                                    onPointerDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        useStore.getState().pushHistory();
                                        if (contextMenu.id) {
                                            updateEdge(contextMenu.id, { energyEnabled: !contextEdgeEnergyEnabled });
                                        }
                                        setContextMenu(null);
                                    }}
                                >
                                    {contextEdgeEnergyEnabled ? <ZapOff size={18} /> : <Zap size={18} />}
                                </button>
                            )}
	                        {contextMenu.kind === 'node' && (
	                            <button
	                                type="button"
	                                className={styles.contextButton}
	                                title="Create connection"
	                                data-interactive="true"
	                                onPointerDown={(e) => contextMenu.id && startContextConnectionDrag(e, contextMenu.id)}
	                            >
	                                <Link2 size={18} />
	                            </button>
	                        )}
	                    </div>
	                </div>
	            )}

            <SnowOverlay enabled={snowEnabled} theme={theme} embedded />

            <div
                className={styles.gridPattern}
                style={{
                    backgroundPosition: `${canvas.x}px ${canvas.y}px`,
                    backgroundSize: `${GRID_SIZE * canvas.scale}px ${GRID_SIZE * canvas.scale}px`
                }}
            />

            {alignmentGuides.map((guide, idx) => (
                <div
                    key={`${guide.axis}-${idx}`}
                    className={styles.alignmentGuide}
                    style={guide.axis === 'x'
                        ? { left: guide.pos, top: 0, width: 1, height: guide.length }
                        : { top: guide.pos, left: 0, height: 1, width: guide.length }
                    }
                />
            ))}

            {marqueeRect && (
                <div
                    className={styles.selectionRect}
                    style={{
                        left: marqueeRect.left,
                        top: marqueeRect.top,
                        width: marqueeRect.width,
                        height: marqueeRect.height,
                    }}
                />
            )}

            <div
                className={`${styles.focusIndicator} ${focusHintVisible ? styles.focusVisible : ''}`}
                style={{
                    '--focus-w': `${FOCUS_RADIUS_X * 2}px`,
                    '--focus-h': `${FOCUS_RADIUS_Y * 2}px`,
                } as React.CSSProperties}
            />

            <svg
                className={styles.canvasLayer}
                style={{
                    transform: `translate(${canvas.x}px, ${canvas.y}px) scale(${canvas.scale})`,
                    overflow: 'visible',
                    pointerEvents: 'auto',
                    zIndex: 0
                }}
            >
	                <defs />
                {/* Render Saved Drawings */}
                {drawings.map(drawing => (
                    <path
                        key={drawing.id}
                        d={drawing.path ?? getSvgPath(drawing.points)}
                        stroke={drawing.color}
                        strokeWidth={drawing.width || 3}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ opacity: drawing.opacity || 1 }}
                        pointerEvents="none"
                    />
                ))}
                {/* Render Current Drawing Path (live, no React re-renders) */}
                <path
                    ref={livePathRef}
                    d=""
                    stroke="var(--text-primary)"
                    strokeWidth={3}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ opacity: 1, pointerEvents: 'none' }}
                />

			                {edges.map((edge) => (
			                    <Edge
			                        key={edge.id}
			                        sourceId={edge.source}
			                        targetId={edge.target}
			                        id={edge.id}
			                        onRequestContextMenu={(args) => {
			                            if (args.kind === 'selection') setContextMenu({ kind: 'selection', id: '__selection__', x: args.x, y: args.y });
			                            else setContextMenu({ kind: args.kind, id: args.id, x: args.x, y: args.y });
			                        }}
			                    />
			                ))}
                {mode === 'connecting' && (
                    <ConnectionLine
                        startX={connectionStart.x}
                        startY={connectionStart.y}
                        endX={cursorPos.x}
                        endY={cursorPos.y}
                    />
                )}
            </svg>

            <div
                className={`${styles.canvasLayer} ${styles.nodeLayer}`}
                style={{
                    transform: `translate(${canvas.x}px, ${canvas.y}px) scale(${canvas.scale})`,
                    // Keep phone note overlays visually stable regardless of zoom level.
                    '--note-scale': String(noteScale),
                    zIndex: 1
                } as React.CSSProperties}
            >
	                {textBoxes.map((tb) => (
	                    <TextBox
	                        key={tb.id}
	                        box={tb}
	                        screenToWorld={screenToWorld}
	                        snapMode={snapMode}
	                        resolveSnap={resolveSnap}
	                        clearAlignmentGuides={clearAlignmentGuides}
	                        onRequestContextMenu={(args) => {
	                            if (args.id === '__selection__') setContextMenu({ kind: 'selection', id: '__selection__', x: args.x, y: args.y });
	                            else setContextMenu({ kind: 'textBox', id: args.id, x: args.x, y: args.y });
	                        }}
	                    />
	                ))}
                {nodes.map((node) => (
                    <div
                        key={node.id}
                        data-node-id={node.id}
                    >
                        <Node data={node} />
                    </div>
                ))}
                {showCommentLayer && (
                    <div className={styles.commentLayer} data-comment-ui="true" onContextMenu={handleCommentContextMenu}>
                        {rootComments.map((comment) => {
                            const anchor = resolveCommentAnchor(comment);
                            if (!anchor) return null;
                            const label = getCommentLabel(comment);
                            const isOpen = openCommentId === comment.id;
                            const isHover = hoverCommentId === comment.id;
                            const replies = repliesByParent.get(comment.id) ?? [];
                            const showBubble = isOpen || isHover;
                            const avatarColor = getCommentColor(comment);
                            return (
                                <div
                                    key={comment.id}
                                    className={styles.commentItem}
                                    style={{ left: anchor.x, top: anchor.y }}
                                    data-comment-ui="true"
                                    data-comment-id={comment.id}
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    <button
                                        type="button"
                                        className={`${styles.commentAvatarButton} ${isOpen ? styles.commentAvatarActive : ''}`}
                                        title={label}
                                        data-comment-ui="true"
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onMouseEnter={() => setHoverCommentId(comment.id)}
                                        onMouseLeave={() => setHoverCommentId(null)}
                                        onClick={() => setOpenCommentId((prev) => (prev === comment.id ? null : comment.id))}
                                    >
                                        {comment.avatarUrl ? (
                                            <img className={styles.commentAvatarImg} src={comment.avatarUrl} alt={label} />
                                        ) : (
                                            <div className={styles.commentAvatarFallback} style={{ background: avatarColor }}>
                                                {getCommentInitial(label)}
                                            </div>
                                        )}
                                    </button>
                                    <div
                                        className={`${styles.commentBubble} ${showBubble ? styles.commentBubbleVisible : ''} ${isOpen ? styles.commentBubbleOpen : ''}`}
                                        data-comment-ui="true"
                                        onPointerDown={(e) => e.stopPropagation()}
                                    >
                                        <div className={styles.commentAuthor}>{label}</div>
                                        {comment.text ? <div className={styles.commentText}>{comment.text}</div> : null}
                                        {comment.attachments && comment.attachments.length > 0 && (
                                            <div className={styles.commentAttachmentList}>
                                                {comment.attachments.map((attachment) => (
                                                    <a
                                                        key={attachment.id}
                                                        href={attachment.dataUrl}
                                                        download={attachment.name}
                                                        className={styles.commentAttachmentFile}
                                                    >
                                                        <span className={styles.commentAttachmentName}>{attachment.name}</span>
                                                        <span className={styles.commentAttachmentMeta}>{formatBytes(attachment.size)}</span>
                                                    </a>
                                                ))}
                                            </div>
                                        )}
                                        {isOpen && replies.length > 0 && (
                                            <div className={styles.commentReplies}>
                                                {replies.map((reply) => {
                                                    const replyLabel = getCommentLabel(reply);
                                                    return (
                                                        <div key={reply.id} className={styles.commentReply} data-comment-id={reply.id}>
                                                            <span className={styles.commentReplyAuthor}>{replyLabel}</span>
                                                            <span className={styles.commentReplyText}>{reply.text}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                        {isOpen && (
                                            me ? (
                                                <div className={styles.commentReplyRow}>
                                                    <input
                                                        className={styles.commentReplyInput}
                                                        type="text"
                                                        value={replyDrafts[comment.id] ?? ''}
                                                        placeholder="Reply..."
                                                        data-comment-ui="true"
                                                        onPointerDown={(e) => e.stopPropagation()}
                                                        onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [comment.id]: e.target.value }))}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') {
                                                                e.preventDefault();
                                                                submitReply(comment);
                                                            }
                                                        }}
                                                    />
                                                    <button
                                                        type="button"
                                                        className={styles.commentReplyButton}
                                                        data-comment-ui="true"
                                                        onPointerDown={(e) => e.stopPropagation()}
                                                        onClick={() => submitReply(comment)}
                                                    >
                                                        Reply
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className={styles.commentReplyNotice}>Sign in to reply.</div>
                                            )
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                        {draftComment && (() => {
                            const anchor = resolveCommentAnchor(draftComment);
                            if (!anchor) return null;
                            return (
                                <div
                                    className={styles.commentItem}
                                    style={{ left: anchor.x, top: anchor.y }}
                                    data-comment-ui="true"
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    <div className={styles.commentDraft} data-comment-ui="true">
                                        <textarea
                                            ref={draftInputRef}
                                            className={styles.commentDraftInput}
                                            value={draftText}
                                            placeholder="Write a comment..."
                                            data-comment-ui="true"
                                            onPointerDown={(e) => e.stopPropagation()}
                                            onChange={(e) => setDraftText(e.target.value)}
                                            onKeyDown={(e) => {
                                                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                                    e.preventDefault();
                                                    submitDraftComment();
                                                }
                                            }}
                                        />
                                        {draftAttachments.length > 0 && (
                                            <div className={styles.commentAttachmentList}>
                                                {draftAttachments.map((attachment) => (
                                                    <div key={attachment.id} className={styles.commentAttachmentDraft}>
                                                        <div className={styles.commentAttachmentFile}>
                                                            <span className={styles.commentAttachmentName}>{attachment.name}</span>
                                                            <span className={styles.commentAttachmentMeta}>{formatBytes(attachment.size)}</span>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            className={styles.commentAttachmentRemove}
                                                            data-comment-ui="true"
                                                            onPointerDown={(e) => e.stopPropagation()}
                                                            onClick={() => setDraftAttachments((prev) => prev.filter((a) => a.id !== attachment.id))}
                                                        >
                                                            Remove
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        {draftNotice && (
                                            <div className={styles.commentDraftNotice}>{draftNotice}</div>
                                        )}
                                        <div className={styles.commentDraftActions}>
                                            <button
                                                type="button"
                                                className={styles.commentDraftButton}
                                                data-comment-ui="true"
                                                onPointerDown={(e) => e.stopPropagation()}
                                                onClick={() => draftAttachInputRef.current?.click()}
                                            >
                                                Attach
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.commentDraftButton}
                                                data-comment-ui="true"
                                                onPointerDown={(e) => e.stopPropagation()}
                                                onClick={submitDraftComment}
                                            >
                                                Send
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.commentDraftButton}
                                                data-comment-ui="true"
                                                onPointerDown={(e) => e.stopPropagation()}
                                                onClick={() => {
                                                    setDraftComment(null);
                                                    setDraftAttachments([]);
                                                    setDraftNotice(null);
                                                }}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                        <input
                                            ref={draftAttachInputRef}
                                            type="file"
                                            multiple
                                            className={styles.commentAttachmentInput}
                                            onChange={(e) => {
                                                handleDraftAttachmentInput(e.target.files);
                                                e.currentTarget.value = '';
                                            }}
                                            data-comment-ui="true"
                                        />
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                )}
            </div>
        </div>
    );
};
