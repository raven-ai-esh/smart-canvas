import React from 'react';
import { useStore } from '../../store/useStore';
import styles from './Edge.module.css';
import { energyToColor } from '../../utils/energy';



interface EdgeProps {
    id: string;
    sourceId: string;
    targetId: string;
    onRequestContextMenu?: (args: { kind: 'edge' | 'selection'; id: string; x: number; y: number }) => void;
}

// Subscribe to store parts granularly to optimize performance
export const Edge: React.FC<EdgeProps> = ({ sourceId, targetId, id, onRequestContextMenu }) => {
    const sourceNode = useStore((state) => state.nodes.find((n) => n.id === sourceId));
    const targetNode = useStore((state) => state.nodes.find((n) => n.id === targetId));
    const selectedNode = useStore((state) => state.selectedNode);
    const selectedEdge = useStore((state) => state.selectedEdge);
    const selectedEdges = useStore((state) => state.selectedEdges);
    const selectedNodes = useStore((state) => state.selectedNodes);
    const selectedTextBoxes = useStore((state) => state.selectedTextBoxes);
    const neighbors = useStore((state) => state.neighbors);
    const selectEdge = useStore((state) => state.selectEdge);
    const monitoringMode = useStore((state) => state.monitoringMode);
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

        // --- CIRCLE INTERSECTION (Graph View) ---
        if (sDims.shape === 'circle' && tDims.shape === 'circle') {
            const dx = tx - sx;
            const dy = ty - sy;
            const distRaw = Math.sqrt(dx * dx + dy * dy);

            if (distRaw === 0) return null; // Overlap

            // Normalized direction
            const nx = dx / distRaw;
            const ny = dy / distRaw;

            // Radius is half width (16px)
            const sRad = sDims.w / 2;
            const tRad = tDims.w / 2;

            const start = { x: sx + nx * sRad, y: sy + ny * sRad };

            // Arrow: line stops short by ARROW_LEN, arrow tip touches border.
            const tip = { x: tx - nx * tRad, y: ty - ny * tRad };
            const end = { x: tx - nx * (tRad + ARROW_LEN), y: ty - ny * (tRad + ARROW_LEN) };

            // Straight line for graph circles looks cleaner? Or slight curve?
            // User liked "Smooth". Continuous connections usually imply curves.
            // Let's use a very subtle curve or just straight if dist is short?
            // Standard Bezier with consistent offset usually looks good.

            const cpOffset = Math.max(distRaw * 0.3, 30);
            // Perpendicular control points? No, for circles, tangent? 
            // Or just simple curve 'out' from center?
            // Actually, for circles, straight line often looks best, OR bezier with slight handles aligned to direction?
            // If we use the "Same Normal Logic", the normal at the intersection point of a circle IS the direction vector (from center).
            // So normal = (nx, ny).

            const cp1 = { x: start.x + nx * cpOffset, y: start.y + ny * cpOffset };
            // For target, normal is pointing OUT of target, which is (-nx, -ny).
            // So we project OUT from target surface: end (which is near surface) + normal * offset.
            // Wait, end is "in front" of surface.
            // Normal at target surface points towards source (if we look at the line incoming).
            // Actually, normal usually points OUT of the shape.
            // At target intersection (near tx, ty), normal points towards Source (-nx, -ny).
            // Visual:  (S) --->  (T)
            // Normal at S = --->
            // Normal at T = <--- (pointing away from T center)
            // So cp2 = end + (-nx, -ny) * offset?
            // But we want C curve.
            // If we use same logic as box:
            // cp2 = end + normal * offset.
            // For box, normal was perpendicular to side.
            // For circle, normal is radial.
            // So:
            const cp2 = { x: end.x + (-nx) * cpOffset, y: end.y + (-ny) * cpOffset }; // Projecting "out" from target towards source?

            // Wait, cp2 should "pull" the curve.
            // Usually for node-link:
            // CP1 = Start + Normal * Offset
            // CP2 = End + Normal * Offset
            // Start normal = Out from S. End normal = Out from T.

            const d = `M ${start.x} ${start.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`;

            // Arrow head triangle
            const ux = tip.x - end.x;
            const uy = tip.y - end.y;
            const ulen = Math.sqrt(ux * ux + uy * uy) || 1;
            const vx = ux / ulen;
            const vy = uy / ulen;
            const px = -vy;
            const py = vx;
            const base = { x: tip.x - vx * ARROW_LEN, y: tip.y - vy * ARROW_LEN };
            const left = { x: base.x + px * (ARROW_W / 2), y: base.y + py * (ARROW_W / 2) };
            const right = { x: base.x - px * (ARROW_W / 2), y: base.y - py * (ARROW_W / 2) };
            const arrowD = `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`;

            return { d, arrowD, tip, end };
        }

        // --- BOX INTERSECTION (Card View) ---
        // Fallback to Box logic if mixed or both box
        // Use the existing logic
        // Ray-Box Intersection to find exact border point and normal

        const getBoxIntersection = (cx: number, cy: number, w: number, h: number, targetX: number, targetY: number) => {
            const h_w = w / 2;
            const h_h = h / 2;
            const dx = targetX - cx;
            const dy = targetY - cy;

            const adx = Math.abs(dx) < 0.0001 ? 0.0001 : Math.abs(dx);
            const ady = Math.abs(dy) < 0.0001 ? 0.0001 : Math.abs(dy);

            const tx_plane = h_w / adx;
            const ty_plane = h_h / ady;

            if (tx_plane < ty_plane) {
                const sign = dx > 0 ? 1 : -1;
                return { x: cx + sign * h_w, y: cy + dy * tx_plane, nx: sign, ny: 0 };
            } else {
                const sign = dy > 0 ? 1 : -1;
                return { x: cx + dx * ty_plane, y: cy + sign * h_h, nx: 0, ny: sign };
            }
        };

        const start = getBoxIntersection(sx, sy, sDims.w, sDims.h, tx, ty);
        const end = getBoxIntersection(tx, ty, tDims.w, tDims.h, sx, sy);

        const dist = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));

        const cpOffset = Math.max(dist * 0.5, 60);

        const cp1 = { x: start.x + start.nx * cpOffset, y: start.y + start.ny * cpOffset };
        const cp2 = { x: end.x + end.nx * cpOffset, y: end.y + end.ny * cpOffset };

        const tip = { x: end.x, y: end.y };
        const endLine = { x: end.x + end.nx * ARROW_LEN, y: end.y + end.ny * ARROW_LEN };

        const d = `M ${start.x} ${start.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${endLine.x} ${endLine.y}`;

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
        const arrowD = `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`;

        return { d, arrowD, tip, end: endLine };
    }, [sx, sy, tx, ty, sourceId, targetId, isGraphMode]);

    if (!geom) return null;

    const isSelectedEdge = (selectedEdge === id) || selectedEdges.includes(id);
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
    const isMonitoringEdge = monitoringMode && sourceNode.type === 'task' && sourceStatus === 'in_progress';
    const monitorColor = energyToColor(sourceEnergy);

    // Highlight Logic
    let className = styles.edgePath;
    if (isSelectedEdge) className += ` ${styles.edgeSelected}`;
    if (isMonitoringEdge) className += ` ${styles.edgeMonitoring}`;
    const monitorStyle = isMonitoringEdge ? ({ '--edge-monitor-color': monitorColor } as React.CSSProperties) : undefined;

    const selectThisEdge = (e: any) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();

        const multiCount = (selectedNodes?.length ?? 0) + (selectedEdges?.length ?? 0) + (selectedTextBoxes?.length ?? 0);
        const isInSelection = (selectedEdges?.includes(id) ?? false) || selectedEdge === id;
        if (multiCount > 1 && isInSelection) return;
        selectEdge(id);
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

    const gradId = `edge-grad-${id}`;
    const baseColor = isMonitoringEdge ? monitorColor : (isSelectedEdge ? 'var(--accent-primary)' : hasFocus ? 'var(--text-primary)' : 'var(--text-dim)');
    const sOpacity = isSelectedEdge ? 1 : (hasFocus ? focusOpacityFor(sourceId, sDist) : 1);
    const tOpacity = isSelectedEdge ? 1 : (hasFocus ? focusOpacityFor(targetId, tDist) : 1);

    // Always use a gradient paint to avoid switching stroke types (url <-> color), which can flicker in browsers.
    const strokePaint = `url(#${gradId})`;

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
                onPointerDown={selectThisEdge}
                onClick={selectThisEdge}
                onPointerDownCapture={startTouchLongPress}
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
                className={`${styles.edgeArrow} ${isSelectedEdge ? styles.edgeArrowSelected : ''}${isMonitoringEdge ? ` ${styles.edgeArrowMonitoring}` : ''}`}
                style={{ fill: strokePaint, ...(monitorStyle ?? {}) }}
            />
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
