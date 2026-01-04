import React from 'react';
import { useStore } from '../../store/useStore';
import styles from './Edge.module.css';
import { energyToColor } from '../../utils/energy';
import { catmullRomToBezierPath } from '../../utils/strokeBeautify';
import type { EdgeControlPoint } from '../../types';

type Vec2 = { x: number; y: number };

const EPS = 0.0001;

const resolveVec = (value?: { x?: number; y?: number } | null): Vec2 | null => {
    if (!value) return null;
    const x = typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : null;
    const y = typeof value.y === 'number' && Number.isFinite(value.y) ? value.y : null;
    if (x === null || y === null) return null;
    return { x, y };
};

const resolveOffset = (value?: { x?: number; y?: number } | null): Vec2 => ({
    x: typeof value?.x === 'number' && Number.isFinite(value.x) ? value.x : 0,
    y: typeof value?.y === 'number' && Number.isFinite(value.y) ? value.y : 0,
});

const normalizeVec = (value: Vec2, fallback: Vec2): Vec2 => {
    const len = Math.hypot(value.x, value.y);
    if (len > EPS) return { x: value.x / len, y: value.y / len };
    return fallback;
};

const pointOnCubic = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 => {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const a = mt2 * mt;
    const b = 3 * mt2 * t;
    const c = 3 * mt * t2;
    const d = t2 * t;
    return {
        x: p0.x * a + p1.x * b + p2.x * c + p3.x * d,
        y: p0.y * a + p1.y * b + p2.y * c + p3.y * d,
    };
};

const closestTOnCubic = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, target: Vec2): number => {
    let bestT = 0;
    let bestDist = Infinity;
    const samples = 40;
    for (let i = 0; i <= samples; i += 1) {
        const t = i / samples;
        const p = pointOnCubic(p0, p1, p2, p3, t);
        const dist = Math.hypot(p.x - target.x, p.y - target.y);
        if (dist < bestDist) {
            bestDist = dist;
            bestT = t;
        }
    }
    const refineRange = 1 / samples;
    const refineSteps = 20;
    const start = Math.max(0, bestT - refineRange);
    const end = Math.min(1, bestT + refineRange);
    for (let i = 0; i <= refineSteps; i += 1) {
        const t = start + (end - start) * (i / refineSteps);
        const p = pointOnCubic(p0, p1, p2, p3, t);
        const dist = Math.hypot(p.x - target.x, p.y - target.y);
        if (dist < bestDist) {
            bestDist = dist;
            bestT = t;
        }
    }
    return bestT;
};


interface EdgeProps {
    id: string;
    sourceId: string;
    targetId: string;
    onRequestContextMenu?: (args: { kind: 'edge' | 'selection'; id: string; x: number; y: number }) => void;
    screenToWorld: (screenX: number, screenY: number) => { x: number; y: number };
}

interface LayerBridgeEdgeProps {
    id: string;
    fromId: string;
    toId: string;
    layerLabel: string;
}

export const LayerBridgeEdge: React.FC<LayerBridgeEdgeProps> = ({ fromId, toId, layerLabel }) => {
    const fromNode = useStore((state) => state.nodes.find((n) => n.id === fromId));
    const toNode = useStore((state) => state.nodes.find((n) => n.id === toId));
    const scale = useStore((state) => state.canvas.scale);
    const isGraphMode = scale < 0.6;

    if (!fromNode || !toNode) return null;

    const sx = fromNode.x;
    const sy = fromNode.y;
    const tx = toNode.x;
    const ty = toNode.y;

    const geom = React.useMemo(() => {
        const getNodeDimensions = (nodeId: string) => {
            if (isGraphMode) return { w: 32, h: 32, shape: 'circle' as const };
            const container = document.querySelector(`[data-node-id="${nodeId}"]`);
            if (container) {
                const isNoteMode = scale >= 1.2;
                const targetSelector = isNoteMode ? '[class*="noteNode"]' : '[class*="cardNode"], [class*="taskNode"]';
                const target = container.querySelector(targetSelector) as HTMLElement | null;
                if (target) return { w: target.offsetWidth, h: target.offsetHeight, shape: 'box' as const };
            }
            return { w: 240, h: 100, shape: 'box' as const };
        };

        const dx = tx - sx;
        const dy = ty - sy;
        const distRaw = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = dx / distRaw;
        const ny = dy / distRaw;
        const stubLen = Math.min(Math.max(80, distRaw * 0.35), 140);
        const end = { x: sx + nx * stubLen, y: sy + ny * stubLen };
        const portal = { x: end.x, y: end.y, r: isGraphMode ? 8 : 10 };
        const cpOffset = Math.max(stubLen * 0.6, 40);

        if (isGraphMode) {
            const radius = 16;
            const start = { x: sx + nx * radius, y: sy + ny * radius };
            const cp1 = { x: start.x + nx * cpOffset, y: start.y + ny * cpOffset };
            const cp2 = { x: end.x - nx * cpOffset * 0.4, y: end.y - ny * cpOffset * 0.4 };
            const d = `M ${start.x} ${start.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`;
            return { d, portal };
        }

        const dims = getNodeDimensions(fromId);
        const hW = dims.w / 2;
        const hH = dims.h / 2;
        const adx = Math.abs(end.x - sx) < 0.0001 ? 0.0001 : Math.abs(end.x - sx);
        const ady = Math.abs(end.y - sy) < 0.0001 ? 0.0001 : Math.abs(end.y - sy);
        const txPlane = hW / adx;
        const tyPlane = hH / ady;
        let start;
        let normal;
        if (txPlane < tyPlane) {
            const sign = end.x > sx ? 1 : -1;
            start = { x: sx + sign * hW, y: sy + (end.y - sy) * txPlane };
            normal = { x: sign, y: 0 };
        } else {
            const sign = end.y > sy ? 1 : -1;
            start = { x: sx + (end.x - sx) * tyPlane, y: sy + sign * hH };
            normal = { x: 0, y: sign };
        }
        const cp1 = { x: start.x + normal.x * cpOffset, y: start.y + normal.y * cpOffset };
        const cp2 = { x: end.x - nx * cpOffset * 0.4, y: end.y - ny * cpOffset * 0.4 };
        const d = `M ${start.x} ${start.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`;
        return { d, portal };
    }, [fromId, isGraphMode, scale, sx, sy, tx, ty]);

    if (!geom) return null;
    const label = layerLabel?.trim() ? layerLabel.trim() : 'Layer';
    const glyph = label.slice(0, 1).toUpperCase();

    return (
        <g className={styles.edgeBridgeGroup} pointerEvents="none">
            <path className={styles.edgeBridgePath} d={geom.d} />
            <circle className={styles.edgeBridgePortal} cx={geom.portal.x} cy={geom.portal.y} r={geom.portal.r} />
            <text className={styles.edgeBridgeLabel} x={geom.portal.x} y={geom.portal.y}>
                {glyph}
            </text>
        </g>
    );
};

// Subscribe to store parts granularly to optimize performance
export const Edge: React.FC<EdgeProps> = ({ sourceId, targetId, id, onRequestContextMenu, screenToWorld }) => {
    const sourceNode = useStore((state) => state.nodes.find((n) => n.id === sourceId));
    const targetNode = useStore((state) => state.nodes.find((n) => n.id === targetId));
    const selectedNode = useStore((state) => state.selectedNode);
    const selectedEdge = useStore((state) => state.selectedEdge);
    const selectedEdges = useStore((state) => state.selectedEdges);
    const selectedEdgeHandle = useStore((state) => state.selectedEdgeHandle);
    const selectedNodes = useStore((state) => state.selectedNodes);
    const selectedTextBoxes = useStore((state) => state.selectedTextBoxes);
    const setMultiSelection = useStore((state) => state.setMultiSelection);
    const neighbors = useStore((state) => state.neighbors);
    const selectEdge = useStore((state) => state.selectEdge);
    const selectEdgeHandle = useStore((state) => state.selectEdgeHandle);
    const setSelectedEdgeHandle = useStore((state) => state.setSelectedEdgeHandle);
    const edgeData = useStore((state) => state.edges.find((e) => e.id === id));
    const updateEdge = useStore((state) => state.updateEdge);
    const pushHistory = useStore((state) => state.pushHistory);
    const monitoringMode = useStore((state) => state.monitoringMode);
    const authorshipMode = useStore((state) => state.authorshipMode);
    const [isHovered, setIsHovered] = React.useState(false);
    const dragStateRef = React.useRef<{
        kind: 'control' | 'source' | 'target';
        pointerId: number;
        startClient: Vec2;
        startWorld: Vec2;
        base?: { start: Vec2; cp1: Vec2; cp2: Vec2; end: Vec2 };
        controlId?: string;
        isLegacy?: boolean;
        nodeCenter?: Vec2;
        captureTarget?: EventTarget | null;
        moved: boolean;
    } | null>(null);
    const dragHandlersRef = React.useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);
    const suppressClickRef = React.useRef(false);
    const sourceEnergy = useStore((state) => {
        const eff = state.effectiveEnergy[sourceId];
        if (Number.isFinite(eff)) return eff;
        const node = state.nodes.find((n) => n.id === sourceId);
        return Number.isFinite(node?.energy) ? node?.energy ?? 0 : 0;
    });
    // const canvas = useStore((state) => state.canvas); // Removed as unused

    // We need to re-render if nodes move. 
    // The selector `nodes.find` returns the node object. If node updates, object reference changes.
    // This is correct behavior for position updates.

    if (!sourceNode || !targetNode) return null;

    const sx = sourceNode.x;
    const sy = sourceNode.y;
    const tx = targetNode.x;
    const ty = targetNode.y;

    // We need canvas scale to determine view mode
    const scale = useStore((state) => state.canvas.scale);
    const isGraphMode = scale < 0.6;

    const sourceAnchor = resolveVec(edgeData?.sourceAnchor);
    const targetAnchor = resolveVec(edgeData?.targetAnchor);
    const curveOffset = resolveOffset(edgeData?.curveOffset);
    const controlPoints = React.useMemo<EdgeControlPoint[]>(() => {
        const raw = Array.isArray(edgeData?.controlPoints) ? edgeData?.controlPoints : [];
        return raw
            .map((cp) => {
                if (!cp || typeof cp !== 'object') return null;
                const id = typeof cp.id === 'string' && cp.id ? cp.id : null;
                const t = typeof cp.t === 'number' && Number.isFinite(cp.t) ? Math.max(0, Math.min(1, cp.t)) : null;
                const ox = typeof cp.offset?.x === 'number' && Number.isFinite(cp.offset.x) ? cp.offset.x : null;
                const oy = typeof cp.offset?.y === 'number' && Number.isFinite(cp.offset.y) ? cp.offset.y : null;
                if (!id || t === null || ox === null || oy === null) return null;
                return { id, t, offset: { x: ox, y: oy } };
            })
            .filter(Boolean) as EdgeControlPoint[];
    }, [edgeData?.controlPoints]);

    // Memoize geometry (path + arrow head)
    const geom = React.useMemo(() => {
        // Helper: Get Node Dimensions based on view mode
        const getNodeDimensions = (nodeId: string) => {
            // In Graph Mode, we assume a fixed size circle
            if (isGraphMode) {
                return { w: 32, h: 32, shape: 'circle' as const };
            }

            // In Card/Note Mode, we measure the DOM
            // We must select the specific child based on current scale to avoid reading stale '.visible' classes from previous render
            const container = document.querySelector(`[data-node-id="${nodeId}"]`);
            if (container) {
                const isNoteMode = scale >= 1.2;
                // Select the correct child based on expected mode
                const targetSelector = isNoteMode ? '[class*="noteNode"]' : '[class*="cardNode"], [class*="taskNode"]';
                const target = container.querySelector(targetSelector) as HTMLElement;

                if (target) {
                    return { w: target.offsetWidth, h: target.offsetHeight, shape: 'box' as const };
                }
            }
            return { w: 240, h: 100, shape: 'box' as const };
        };

        const sDims = getNodeDimensions(sourceId);
        const tDims = getNodeDimensions(targetId);

        const ARROW_LEN = 10;
        const ARROW_W = 7;

        const dx = tx - sx;
        const dy = ty - sy;
        const distRaw = Math.hypot(dx, dy);
        if (distRaw < EPS) return null;

        const baseDir = { x: dx / distRaw, y: dy / distRaw };
        const targetFallback = { x: -baseDir.x, y: -baseDir.y };
        const sourceDir = normalizeVec(sourceAnchor ?? baseDir, baseDir);
        const targetDir = normalizeVec(targetAnchor ?? targetFallback, targetFallback);

        const buildArrow = (tip: Vec2, endLine: Vec2) => {
            const ux = tip.x - endLine.x;
            const uy = tip.y - endLine.y;
            const ulen = Math.sqrt(ux * ux + uy * uy) || 1;
            const vx = ux / ulen;
            const vy = uy / ulen;
            const px = -vy;
            const py = vx;
            const base = { x: tip.x - vx * ARROW_LEN, y: tip.y - vy * ARROW_LEN };
            const left = { x: base.x + px * (ARROW_W / 2), y: base.y + py * (ARROW_W / 2) };
            const right = { x: base.x - px * (ARROW_W / 2), y: base.y - py * (ARROW_W / 2) };
            return `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`;
        };

        const legacyActive = Math.abs(curveOffset.x) > EPS || Math.abs(curveOffset.y) > EPS;
        const handleDefs = [
            ...controlPoints.map((cp) => ({ id: cp.id, t: cp.t, offset: cp.offset, isLegacy: false })),
            ...(legacyActive ? [{ id: '__legacy__', t: 0.5, offset: curveOffset, isLegacy: true }] : []),
        ].sort((a, b) => a.t - b.t);

        const buildGeom = (input: {
            start: Vec2;
            endLine: Vec2;
            tip: Vec2;
            cp1: Vec2;
            cp2: Vec2;
            startNormal: Vec2;
            endNormal: Vec2;
        }) => {
            const base = { start: input.start, cp1: input.cp1, cp2: input.cp2, end: input.endLine };
            const handles = handleDefs.map((cp) => {
                const basePoint = pointOnCubic(base.start, base.cp1, base.cp2, base.end, cp.t);
                return {
                    id: cp.id,
                    t: cp.t,
                    offset: cp.offset,
                    isLegacy: cp.isLegacy,
                    pos: { x: basePoint.x + cp.offset.x, y: basePoint.y + cp.offset.y },
                };
            });
            const d = handles.length > 0
                ? catmullRomToBezierPath([input.start, ...handles.map((h) => h.pos), input.endLine])
                : `M ${input.start.x} ${input.start.y} C ${input.cp1.x} ${input.cp1.y}, ${input.cp2.x} ${input.cp2.y}, ${input.endLine.x} ${input.endLine.y}`;
            const arrowD = buildArrow(input.tip, input.endLine);
            return {
                d,
                arrowD,
                tip: input.tip,
                end: input.endLine,
                start: input.start,
                base,
                handles,
                startNormal: input.startNormal,
                endNormal: input.endNormal,
            };
        };

        // --- CIRCLE INTERSECTION (Graph View) ---
        if (sDims.shape === 'circle' && tDims.shape === 'circle') {
            const sRad = sDims.w / 2;
            const tRad = tDims.w / 2;

            const start = { x: sx + sourceDir.x * sRad, y: sy + sourceDir.y * sRad };
            const tip = { x: tx + targetDir.x * tRad, y: ty + targetDir.y * tRad };
            const endLine = { x: tip.x + targetDir.x * ARROW_LEN, y: tip.y + targetDir.y * ARROW_LEN };

            const dist = Math.hypot(tip.x - start.x, tip.y - start.y);
            const cpOffset = Math.max(dist * 0.3, 30);

            const cp1 = { x: start.x + sourceDir.x * cpOffset, y: start.y + sourceDir.y * cpOffset };
            const cp2 = { x: endLine.x + targetDir.x * cpOffset, y: endLine.y + targetDir.y * cpOffset };

            return buildGeom({
                start,
                endLine,
                tip,
                cp1,
                cp2,
                startNormal: sourceDir,
                endNormal: targetDir,
            });
        }

        // --- BOX INTERSECTION (Card View) ---
        const getBoxIntersection = (cx: number, cy: number, w: number, h: number, dir: Vec2) => {
            const hW = w / 2;
            const hH = h / 2;
            const dx = dir.x;
            const dy = dir.y;

            const adx = Math.abs(dx) < EPS ? EPS : Math.abs(dx);
            const ady = Math.abs(dy) < EPS ? EPS : Math.abs(dy);

            const txPlane = hW / adx;
            const tyPlane = hH / ady;

            if (txPlane < tyPlane) {
                const sign = dx > 0 ? 1 : -1;
                return { x: cx + sign * hW, y: cy + dy * txPlane, nx: sign, ny: 0 };
            }
            const sign = dy > 0 ? 1 : -1;
            return { x: cx + dx * tyPlane, y: cy + sign * hH, nx: 0, ny: sign };
        };

        const start = getBoxIntersection(sx, sy, sDims.w, sDims.h, sourceDir);
        const end = getBoxIntersection(tx, ty, tDims.w, tDims.h, targetDir);

        const tip = { x: end.x, y: end.y };
        const endLine = { x: end.x + end.nx * ARROW_LEN, y: end.y + end.ny * ARROW_LEN };

        const dist = Math.hypot(end.x - start.x, end.y - start.y);
        const cpOffset = Math.max(dist * 0.5, 60);

        const cp1 = { x: start.x + start.nx * cpOffset, y: start.y + start.ny * cpOffset };
        const cp2 = { x: endLine.x + end.nx * cpOffset, y: endLine.y + end.ny * cpOffset };

        return buildGeom({
            start: { x: start.x, y: start.y },
            endLine,
            tip,
            cp1,
            cp2,
            startNormal: { x: start.nx, y: start.ny },
            endNormal: { x: end.nx, y: end.ny },
        });
    }, [
        sx,
        sy,
        tx,
        ty,
        sourceId,
        targetId,
        isGraphMode,
        scale,
        sourceAnchor?.x,
        sourceAnchor?.y,
        targetAnchor?.x,
        targetAnchor?.y,
        curveOffset.x,
        curveOffset.y,
        controlPoints,
    ]);

    if (!geom) return null;

    const isEnergyEnabled = edgeData?.energyEnabled !== false;
    const isSelectedEdge = (selectedEdge === id) || selectedEdges.includes(id);
    const authorLabel = typeof edgeData?.authorName === 'string' ? edgeData?.authorName.trim() : '';
    const showAuthor = authorshipMode && !!authorLabel && (isHovered || isSelectedEdge);
    const hasFocus = !!selectedNode;

    // Check states
    const sDist = neighbors[sourceId];
    const tDist = neighbors[targetId];

    // In focus mode, edges should match node opacity levels exactly:
    // selected = 1, dist1 = 0.9, dist2 = 0.6, rest = 0.1
    const focusOpacityFor = (nodeId: string, dist?: number) => {
        if (!selectedNode) return 1;
        if (selectedNode === nodeId) return 1;
        if (dist === 1) return 0.9;
        if (dist === 2) return 0.6;
        return 0.1;
    };

    const sourceProgress = Math.min(100, Math.max(0, Number.isFinite(sourceNode.progress as number) ? (sourceNode.progress as number) : 0));
    const sourceStatus = sourceProgress >= 100 ? 'done' : sourceProgress <= 0 ? 'queued' : 'in_progress';
    const isMonitoringEdge = isEnergyEnabled && monitoringMode && sourceNode.type === 'task' && sourceStatus === 'in_progress';
    const monitorColor = energyToColor(sourceEnergy);

    // Highlight Logic
    let className = styles.edgePath;
    if (isSelectedEdge) className += ` ${styles.edgeSelected}`;
    if (isMonitoringEdge) className += ` ${styles.edgeMonitoring}`;
    if (!isEnergyEnabled) className += ` ${styles.edgeDisabled}`;
    const monitorStyle = isMonitoringEdge ? ({ '--edge-monitor-color': monitorColor } as React.CSSProperties) : undefined;

    const selectThisEdge = (e: any) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();

        if (e?.shiftKey) {
            const st = useStore.getState();
            const selNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
            const selEdges = st.selectedEdges?.length ? st.selectedEdges : (st.selectedEdge ? [st.selectedEdge] : []);
            const selText = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
            const isSelected = selEdges.includes(id);
            const nextEdges = isSelected ? selEdges.filter((edgeId) => edgeId !== id) : [...selEdges, id];
            setMultiSelection({ nodes: selNodes, edges: nextEdges, textBoxes: selText });
            return;
        }

        const multiCount = (selectedNodes?.length ?? 0) + (selectedEdges?.length ?? 0) + (selectedTextBoxes?.length ?? 0);
        const isInSelection = (selectedEdges?.includes(id) ?? false) || selectedEdge === id;
        if (multiCount > 1 && isInSelection) return;
        selectEdge(id);
    };

    const stopEdgeDrag = React.useCallback((pointerId?: number) => {
        const state = dragStateRef.current;
        if (pointerId && state?.pointerId !== pointerId) return;
        const handlers = dragHandlersRef.current;
        if (handlers) {
            window.removeEventListener('pointermove', handlers.move, true);
            window.removeEventListener('pointerup', handlers.up, true);
            window.removeEventListener('pointercancel', handlers.up, true);
            dragHandlersRef.current = null;
        }
        if (state?.captureTarget && 'releasePointerCapture' in (state.captureTarget as any)) {
            try {
                (state.captureTarget as any).releasePointerCapture(state.pointerId);
            } catch {
                // ignore
            }
        }
        dragStateRef.current = null;
    }, []);

    React.useEffect(() => () => stopEdgeDrag(), [stopEdgeDrag]);

    const beginEdgeDrag = (
        e: React.PointerEvent,
        next: {
            kind: 'control' | 'source' | 'target';
            controlId?: string;
            isLegacy?: boolean;
            nodeCenter?: Vec2;
            base?: { start: Vec2; cp1: Vec2; cp2: Vec2; end: Vec2 };
        },
    ) => {
        const startClient = { x: e.clientX, y: e.clientY };
        const startWorld = screenToWorld(e.clientX, e.clientY);
        dragStateRef.current = {
            kind: next.kind,
            pointerId: e.pointerId,
            startClient,
            startWorld,
            base: next.base,
            controlId: next.controlId,
            isLegacy: next.isLegacy,
            nodeCenter: next.nodeCenter,
            captureTarget: e.currentTarget,
            moved: false,
        };

        if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && 'setPointerCapture' in (e.currentTarget as any)) {
            try {
                (e.currentTarget as any).setPointerCapture(e.pointerId);
            } catch {
                // ignore
            }
        }

        const DRAG_START_PX = 4;

        const move = (ev: PointerEvent) => {
            const state = dragStateRef.current;
            if (!state || state.pointerId !== ev.pointerId) return;
            const distPx = Math.hypot(ev.clientX - state.startClient.x, ev.clientY - state.startClient.y);
            if (!state.moved && distPx < DRAG_START_PX) return;
            if (!state.moved) {
                pushHistory();
                state.moved = true;
            }
            const world = screenToWorld(ev.clientX, ev.clientY);

            if (state.kind === 'control') {
                const base = state.base;
                if (!base || !state.controlId) return;
                const t = state.isLegacy
                    ? 0.5
                    : closestTOnCubic(base.start, base.cp1, base.cp2, base.end, world);
                const basePoint = pointOnCubic(base.start, base.cp1, base.cp2, base.end, t);
                const offset = { x: world.x - basePoint.x, y: world.y - basePoint.y };
                if (state.isLegacy) {
                    updateEdge(id, { curveOffset: offset });
                } else {
                    const nextPoints = controlPoints.map((cp) => (
                        cp.id === state.controlId ? { ...cp, t, offset } : cp
                    ));
                    updateEdge(id, { controlPoints: nextPoints });
                }
                return;
            }

            if (!state.nodeCenter) return;
            const dir = { x: world.x - state.nodeCenter.x, y: world.y - state.nodeCenter.y };
            const len = Math.hypot(dir.x, dir.y);
            if (len < EPS) return;
            const anchor = { x: dir.x / len, y: dir.y / len };
            if (state.kind === 'source') updateEdge(id, { sourceAnchor: anchor });
            else updateEdge(id, { targetAnchor: anchor });
        };

        const up = (ev: PointerEvent) => {
            const state = dragStateRef.current;
            if (!state || state.pointerId !== ev.pointerId) return;
            suppressClickRef.current = state.moved;
            if (state.moved) {
                window.setTimeout(() => {
                    suppressClickRef.current = false;
                }, 0);
            }
            stopEdgeDrag(ev.pointerId);
        };

        dragHandlersRef.current = { move, up };
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
    };

    const startControlDrag = (e: React.PointerEvent, handle: { id: string; isLegacy: boolean }) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (!geom?.base) return;
        e.preventDefault();
        e.stopPropagation();
        selectEdgeHandle(id, handle.id);
        beginEdgeDrag(e, {
            kind: 'control',
            controlId: handle.id,
            isLegacy: handle.isLegacy,
            base: geom.base,
        });
    };

    const startAnchorDrag = (e: React.PointerEvent, kind: 'source' | 'target') => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        selectThisEdge(e);
        if (e.shiftKey) return;
        beginEdgeDrag(e, {
            kind,
            nodeCenter: kind === 'source' ? { x: sx, y: sy } : { x: tx, y: ty },
        });
    };

    const handleEdgePointerDown = (e: React.PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (selectedEdgeHandle) setSelectedEdgeHandle(null);
        selectThisEdge(e);
    };

    const handleEdgeClick = (e: React.MouseEvent) => {
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        selectThisEdge(e);
    };

    const handleEdgeDoubleClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!geom?.base) return;
        if (!isSelectedEdge) {
            selectEdge(id);
            return;
        }
        const world = screenToWorld(e.clientX, e.clientY);
        const t = closestTOnCubic(geom.base.start, geom.base.cp1, geom.base.cp2, geom.base.end, world);
        const basePoint = pointOnCubic(geom.base.start, geom.base.cp1, geom.base.cp2, geom.base.end, t);
        const offset = { x: world.x - basePoint.x, y: world.y - basePoint.y };
        const nextPoints = [...controlPoints];
        const hasLegacy = Math.abs(curveOffset.x) > EPS || Math.abs(curveOffset.y) > EPS;
        if (hasLegacy) {
            nextPoints.push({
                id: crypto.randomUUID(),
                t: 0.5,
                offset: { x: curveOffset.x, y: curveOffset.y },
            });
        }
        const newId = crypto.randomUUID();
        nextPoints.push({ id: newId, t, offset });
        pushHistory();
        updateEdge(id, {
            controlPoints: nextPoints,
            ...(hasLegacy ? { curveOffset: { x: 0, y: 0 } } : {}),
        });
        selectEdgeHandle(id, newId);
    };

    const startTouchLongPress = (e: React.PointerEvent) => {
        if (!onRequestContextMenu) return;
        if (e.pointerType !== 'touch') return;

        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startY = e.clientY;
        const multiCount = (selectedNodes?.length ?? 0) + (selectedEdges?.length ?? 0) + (selectedTextBoxes?.length ?? 0);
        const isInSelection = (selectedEdges?.includes(id) ?? false) || selectedEdge === id;
        if (!(multiCount > 1 && isInSelection)) {
            selectEdge(id);
        }

        let cancelled = false;
        const THRESH = 10;

        const cleanup = () => {
            window.removeEventListener('touchmove', onTouchMove, true);
            window.removeEventListener('touchend', onTouchEnd, true);
            window.removeEventListener('touchcancel', onTouchEnd, true);
        };

        const onTouchMove = (ev: TouchEvent) => {
            const t = ev.touches?.[0];
            if (!t) return;
            const dist = Math.hypot(t.clientX - startX, t.clientY - startY);
            if (dist > THRESH) {
                cancelled = true;
                cleanup();
            }
        };

        const onTouchEnd = (_ev: TouchEvent) => {
            cancelled = true;
            cleanup();
        };

        window.addEventListener('touchmove', onTouchMove, { capture: true, passive: true } as any);
        window.addEventListener('touchend', onTouchEnd, { capture: true, passive: true } as any);
        window.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true } as any);

        window.setTimeout(() => {
            cleanup();
            if (cancelled) return;
            if (multiCount > 1 && isInSelection) {
                onRequestContextMenu({ kind: 'selection', id: '__selection__', x: startX, y: startY });
            } else {
                onRequestContextMenu({ kind: 'edge', id, x: startX, y: startY });
            }
        }, 500);
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        if (!onRequestContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        selectEdge(id);
        onRequestContextMenu({ kind: 'edge', id, x: e.clientX, y: e.clientY });
    };

    const gradId = `edge-grad-${id}`;
    const baseColor = isMonitoringEdge ? monitorColor : (isSelectedEdge ? 'var(--accent-primary)' : hasFocus ? 'var(--text-primary)' : 'var(--text-dim)');
    const sOpacity = isSelectedEdge ? 1 : (hasFocus ? focusOpacityFor(sourceId, sDist) : 1);
    const tOpacity = isSelectedEdge ? 1 : (hasFocus ? focusOpacityFor(targetId, tDist) : 1);

    // Always use a gradient paint to avoid switching stroke types (url <-> color), which can flicker in browsers.
    const strokePaint = `url(#${gradId})`;
    const handleRadius = 6 / Math.max(0.0001, scale);
    const handleStrokeWidth = 1.5;
    const anchorHandleOffset = 18 / Math.max(0.0001, scale);
    const sourceHandlePos = {
        x: geom.start.x + geom.startNormal.x * anchorHandleOffset,
        y: geom.start.y + geom.startNormal.y * anchorHandleOffset,
    };
    const targetHandlePos = {
        x: geom.tip.x + geom.endNormal.x * anchorHandleOffset,
        y: geom.tip.y + geom.endNormal.y * anchorHandleOffset,
    };
    const showHandles = isSelectedEdge;

    return (
        <>
            <defs>
                <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1={sx} y1={sy} x2={tx} y2={ty}>
                    <stop offset="0%" stopColor={baseColor} stopOpacity={sOpacity} />
                    <stop offset="100%" stopColor={baseColor} stopOpacity={tOpacity} />
                </linearGradient>
            </defs>
            <path
                d={geom.d}
                className={styles.edgeHitArea}
                data-edge-id={id}
                onPointerDown={handleEdgePointerDown}
                onClick={handleEdgeClick}
                onDoubleClick={handleEdgeDoubleClick}
                onContextMenu={handleContextMenu}
                onPointerDownCapture={startTouchLongPress}
                onPointerEnter={() => setIsHovered(true)}
                onPointerLeave={() => setIsHovered(false)}
            />
            <path
                d={geom.d}
                className={className}
                style={{
                    stroke: strokePaint,
                    ...(monitorStyle ?? {}),
                }}
            />
            <path
                d={geom.arrowD}
                className={`${styles.edgeArrow} ${isSelectedEdge ? styles.edgeArrowSelected : ''}${isMonitoringEdge ? ` ${styles.edgeArrowMonitoring}` : ''}${!isEnergyEnabled ? ` ${styles.edgeArrowDisabled}` : ''}`}
                style={{ fill: strokePaint, ...(monitorStyle ?? {}) }}
            />
            {showHandles && (
                <>
                    <circle
                        className={`${styles.edgeHandle} ${styles.edgeHandleAnchor}`}
                        cx={sourceHandlePos.x}
                        cy={sourceHandlePos.y}
                        r={handleRadius}
                        style={{ strokeWidth: handleStrokeWidth }}
                        data-edge-handle="source"
                        onPointerDown={(e) => startAnchorDrag(e, 'source')}
                    />
                    <circle
                        className={`${styles.edgeHandle} ${styles.edgeHandleAnchor}`}
                        cx={targetHandlePos.x}
                        cy={targetHandlePos.y}
                        r={handleRadius}
                        style={{ strokeWidth: handleStrokeWidth }}
                        data-edge-handle="target"
                        onPointerDown={(e) => startAnchorDrag(e, 'target')}
                    />
                    {geom.handles.map((handle) => {
                        const isSelected = selectedEdgeHandle?.edgeId === id && selectedEdgeHandle.handleId === handle.id;
                        return (
                            <circle
                                key={handle.id}
                                className={`${styles.edgeHandle} ${styles.edgeHandleControl}${isSelected ? ` ${styles.edgeHandleSelected}` : ''}`}
                                cx={handle.pos.x}
                                cy={handle.pos.y}
                                r={handleRadius}
                                style={{ strokeWidth: handleStrokeWidth }}
                                data-edge-handle="control"
                                onPointerDown={(e) => startControlDrag(e, handle)}
                            />
                        );
                    })}
                </>
            )}
            {authorLabel && (
                <text
                    x={Math.min(sx, tx) - 6}
                    y={Math.min(sy, ty) - 8}
                    className={`${styles.edgeAuthor} ${showAuthor ? styles.edgeAuthorVisible : ''}`}
                    textAnchor="start"
                    dominantBaseline="text-after-edge"
                >
                    {authorLabel}
                </text>
            )}
        </>
    );
};

interface ConnectionLineProps {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
}

export const ConnectionLine: React.FC<ConnectionLineProps> = ({ startX, startY, endX, endY }) => {
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    let d = '';
    if (absDeltaX > absDeltaY) {
        d = `M ${startX} ${startY} C ${startX + absDeltaX / 2} ${startY}, ${endX - absDeltaX / 2} ${endY}, ${endX} ${endY}`;
    } else {
        d = `M ${startX} ${startY} C ${startX} ${startY + absDeltaY / 2}, ${endX} ${endY - absDeltaY / 2}, ${endX} ${endY}`;
    }

    return (
        <path
            d={d}
            className={styles.connectionLine}
        />
    );
};
