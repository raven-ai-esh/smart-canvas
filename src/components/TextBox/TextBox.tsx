import React from 'react';
import type { TextBox as TextBoxType } from '../../types';
import { useStore } from '../../store/useStore';
import styles from './TextBox.module.css';

const MIN_W = 80;
const MIN_H = 44;
const DRAG_COMMIT_DIST = 1.5;
const INNER_PAD_X = 16; // left+right (8+8)
const INNER_PAD_Y = 16; // top+bottom (8+8)
const BORDER_BOX_SHRINK = 2; // 1px border on each side with box-sizing: border-box
const LONG_PRESS_MS = 500;
const TOUCH_DRAG_THRESHOLD = 8;

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

export function TextBox({
  box,
  screenToWorld,
  snapMode,
  resolveSnap,
  clearAlignmentGuides,
  onRequestContextMenu,
}: {
  box: TextBoxType;
  screenToWorld: (x: number, y: number) => { x: number; y: number };
  snapMode?: boolean;
  resolveSnap?: (req: SnapRequest) => { x: number; y: number };
  clearAlignmentGuides?: () => void;
  onRequestContextMenu?: (args: { id: string; x: number; y: number }) => void;
}) {
  const updateTextBox = useStore((s) => s.updateTextBox);
  const editingId = useStore((s) => s.editingTextBoxId);
  const setEditingId = useStore((s) => s.setEditingTextBoxId);
  const selectedId = useStore((s) => s.selectedTextBoxId);
  const selectedIds = useStore((s) => s.selectedTextBoxes);
  const selectTextBox = useStore((s) => s.selectTextBox);

  const isEditing = editingId === box.id;
  const isSelected = selectedId === box.id || selectedIds.includes(box.id);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const measureRef = React.useRef<HTMLDivElement | null>(null);
  const editHistoryRef = React.useRef(false);

  const [fontSize, setFontSize] = React.useState(14);

  React.useEffect(() => {
    if (!isEditing) editHistoryRef.current = false;
  }, [isEditing]);

  const ensureEditHistory = () => {
    if (editHistoryRef.current) return;
    useStore.getState().pushHistory();
    editHistoryRef.current = true;
  };

  React.useEffect(() => {
    if (!isEditing) return;
    const t = textareaRef.current;
    if (!t) return;
    t.focus();
    // Place caret at the end.
    try {
      const len = t.value.length;
      t.setSelectionRange(len, len);
    } catch {
      // ignore
    }
  }, [isEditing]);

  // Auto-fit font size to the current box (smooth updates, no jumping).
  React.useEffect(() => {
    const el = measureRef.current;
    if (!el) return;

    // The container uses `box-sizing: border-box` and has a 1px border even when transparent.
    // That reduces the inner content size; account for it here to avoid bottom clipping.
    const availableW = Math.max(1, box.width - INNER_PAD_X - BORDER_BOX_SHRINK);
    const availableH = Math.max(1, box.height - INNER_PAD_Y - BORDER_BOX_SHRINK);
    const text = (box.text && box.text.trim().length > 0) ? box.text : 'Type…';

    let raf = 0;
    raf = requestAnimationFrame(() => {
      // Binary search for the largest font size that fits height (wrapping handles width).
      const min = 10;
      const max = 22;
      let lo = min;
      let hi = max;

      // Ensure measurement element matches the editor/display constraints.
      el.style.width = `${availableW}px`;

      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = `${mid}px`;
        // Force content update (text wrapping depends on font size).
        el.textContent = text;

        // scrollHeight uses the untransformed layout box (good: our box is in world-units-as-px).
        // Keep a small safety margin to avoid sub-pixel rounding clipping in the real box.
        const fits = el.scrollHeight <= availableH - 1.5;
        if (fits) lo = mid;
        else hi = mid;
      }

      // Stabilize tiny changes to avoid micro-jitter.
      // Always round down (never up), otherwise we can exceed the fitted height.
      const next = Math.floor(lo * 10) / 10;
      setFontSize((prev) => (Math.abs(prev - next) < 0.2 ? prev : next));
    });

    return () => cancelAnimationFrame(raf);
  }, [box.width, box.height, box.text]);

  // Auto-expand box height while editing (so text doesn't get cut off and doesn't require scrolling).
  React.useEffect(() => {
    if (!isEditing) return;
    const t = textareaRef.current;
    if (!t) return;

    let raf = 0;
    raf = requestAnimationFrame(() => {
      // scrollHeight is the required content height for the textarea area.
      const needed = Math.ceil(t.scrollHeight + INNER_PAD_Y + BORDER_BOX_SHRINK);
      if (needed > box.height + 1) {
        updateTextBox(box.id, { height: needed });
      }
    });

    return () => cancelAnimationFrame(raf);
  }, [isEditing, box.id, box.text, box.width, fontSize, box.height, updateTextBox]);

  const dragStateRef = React.useRef<
    | null
    | {
        kind: 'move' | 'resize';
        startWorld: { x: number; y: number };
        startBox: { x: number; y: number; width: number; height: number };
        pointerId: number;
        committed: boolean;
      }
  >(null);

  const groupDragRef = React.useRef<
    | null
    | {
        pointerId: number;
        startWorld: { x: number; y: number };
        nodeStarts: Array<{ id: string; x: number; y: number }>;
        textBoxStarts: Array<{ id: string; x: number; y: number }>;
        committed: boolean;
      }
  >(null);

  const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchCandidateRef = React.useRef<null | {
    pointerId: number;
    downClientX: number;
    downClientY: number;
    downWorld: { x: number; y: number };
    openedMenu: boolean;
  }>(null);

  const clearTouchCandidate = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    touchCandidateRef.current = null;
  };

  const startDrag = (e: React.PointerEvent, kind: 'move' | 'resize') => {
    e.preventDefault();
    e.stopPropagation();

    const startWorld = screenToWorld(e.clientX, e.clientY);
    dragStateRef.current = {
      kind,
      startWorld,
      startBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      pointerId: e.pointerId,
      committed: false,
    };

    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const startGroupDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startWorld = screenToWorld(e.clientX, e.clientY);
    const st = useStore.getState();
    const selectedNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
    const selectedTextBoxes = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);

    groupDragRef.current = {
      pointerId: e.pointerId,
      startWorld,
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
    };

    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const startTouchMoveDragFromCandidate = (
    e: React.PointerEvent,
    cand: {
      pointerId: number;
      downClientX: number;
      downClientY: number;
      downWorld: { x: number; y: number };
      openedMenu: boolean;
    }
  ) => {
    if (!cand) return;
    const st = useStore.getState();
    const selectedNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
    const selectedTextBoxes = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
    const isMulti = (selectedNodes.length + selectedTextBoxes.length) > 1;
    const isInSelection = selectedTextBoxes.includes(box.id) || st.selectedTextBoxId === box.id;

    if (!isEditing && isMulti && isInSelection) {
      groupDragRef.current = {
        pointerId: e.pointerId,
        startWorld: cand.downWorld,
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
      };
    } else {
      dragStateRef.current = {
        kind: 'move',
        startWorld: cand.downWorld,
        startBox: { x: box.x, y: box.y, width: box.width, height: box.height },
        pointerId: e.pointerId,
        committed: false,
      };
    }

    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  };

  const onDragMove = (e: React.PointerEvent) => {
    const cand = touchCandidateRef.current;
    if (cand && cand.pointerId === e.pointerId && e.pointerType === 'touch') {
      const dist = Math.hypot(e.clientX - cand.downClientX, e.clientY - cand.downClientY);
      if (!cand.openedMenu && dist > TOUCH_DRAG_THRESHOLD) {
        const snapshot = cand;
        clearTouchCandidate();
        // Start drag only after user intent is clear (move threshold).
        startTouchMoveDragFromCandidate(e, snapshot);
      } else {
        // Still deciding between tap/long-press; don't drag yet.
        e.stopPropagation();
        return;
      }
    }

    const group = groupDragRef.current;
    if (group && group.pointerId === e.pointerId) {
      e.preventDefault();
      e.stopPropagation();
      const now = screenToWorld(e.clientX, e.clientY);
      let dx = now.x - group.startWorld.x;
      let dy = now.y - group.startWorld.y;
      if (snapMode && resolveSnap) {
        const anchor = group.textBoxStarts.find((tb) => tb.id === box.id) ?? group.textBoxStarts[0];
        if (anchor) {
          const snapped = resolveSnap({
            x: anchor.x + dx,
            y: anchor.y + dy,
            width: box.width,
            height: box.height,
            anchor: 'topleft',
            excludeNodeIds: group.nodeStarts.map((ns) => ns.id),
            excludeTextBoxIds: group.textBoxStarts.map((tb) => tb.id),
          });
          dx = snapped.x - anchor.x;
          dy = snapped.y - anchor.y;
        } else {
          clearAlignmentGuides?.();
        }
      } else if (!snapMode) {
        clearAlignmentGuides?.();
      }

      const moved = Math.hypot(dx, dy) > DRAG_COMMIT_DIST;
      if (moved && !group.committed) {
        group.committed = true;
        useStore.getState().pushHistory();
      }

      const st = useStore.getState() as any;
      for (const ns of group.nodeStarts) {
        st.updateNode(ns.id, { x: ns.x + dx, y: ns.y + dy });
      }
      for (const ts0 of group.textBoxStarts) {
        st.updateTextBox(ts0.id, { x: ts0.x + dx, y: ts0.y + dy });
      }
      return;
    }

    const st = dragStateRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const now = screenToWorld(e.clientX, e.clientY);
    let dx = now.x - st.startWorld.x;
    let dy = now.y - st.startWorld.y;
    const moved = Math.hypot(dx, dy) > DRAG_COMMIT_DIST;
    if (!st.committed && moved) {
      st.committed = true;
      // Make drag/resize undoable as a single operation.
      useStore.getState().pushHistory();
    }

    if (st.kind === 'move') {
      if (snapMode && resolveSnap) {
        const stSnap = resolveSnap({
          x: st.startBox.x + dx,
          y: st.startBox.y + dy,
          width: st.startBox.width,
          height: st.startBox.height,
          anchor: 'topleft',
          excludeNodeIds: [],
          excludeTextBoxIds: [box.id],
        });
        dx = stSnap.x - st.startBox.x;
        dy = stSnap.y - st.startBox.y;
      } else if (!snapMode) {
        clearAlignmentGuides?.();
      }
      updateTextBox(box.id, { x: st.startBox.x + dx, y: st.startBox.y + dy });
      return;
    }

    clearAlignmentGuides?.();

    // When resizing, keep width stable if user mostly drags vertically (and vice-versa).
    if (Math.abs(dx) < Math.abs(dy) * 0.35) dx = 0;
    if (Math.abs(dy) < Math.abs(dx) * 0.35) dy = 0;

    const nextW = Math.max(MIN_W, st.startBox.width + dx);
    const nextH = Math.max(MIN_H, st.startBox.height + dy);
    updateTextBox(box.id, { width: nextW, height: nextH });
  };

  const endDrag = (e: React.PointerEvent) => {
    const cand = touchCandidateRef.current;
    if (cand && cand.pointerId === e.pointerId && e.pointerType === 'touch') {
      const isClick = Math.hypot(e.clientX - cand.downClientX, e.clientY - cand.downClientY) < TOUCH_DRAG_THRESHOLD;
      const opened = cand.openedMenu;
      clearTouchCandidate();
      e.stopPropagation();
      clearAlignmentGuides?.();
      if (isClick && !opened && !isEditing) {
        selectTextBox(box.id);
      }
      return;
    }

    const group = groupDragRef.current;
    if (group && group.pointerId === e.pointerId) {
      groupDragRef.current = null;
      e.stopPropagation();
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
      clearAlignmentGuides?.();
      return;
    }

    const st = dragStateRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
    clearAlignmentGuides?.();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(box.id);
    selectTextBox(box.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && isEditing) {
      e.preventDefault();
      setEditingId(null);
      textareaRef.current?.blur();
    }
  };

  return (
    <div
      className={`${styles.textBox} ${(isEditing || isSelected) ? styles.active : ''}`}
      style={{
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
      }}
      data-textbox-id={box.id}
      data-interactive="true"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.pointerType === 'touch' && !isEditing) {
          // Touch UX: tap selects, drag after threshold moves, long-press opens context menu.
          clearTouchCandidate();
          touchCandidateRef.current = {
            pointerId: e.pointerId,
            downClientX: e.clientX,
            downClientY: e.clientY,
            downWorld: screenToWorld(e.clientX, e.clientY),
            openedMenu: false,
          };
          longPressTimerRef.current = setTimeout(() => {
            const cand = touchCandidateRef.current;
            if (!cand || cand.pointerId !== e.pointerId) return;
            cand.openedMenu = true;
            const st = useStore.getState();
            const selNodes = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
            const selEdges = st.selectedEdges?.length ? st.selectedEdges : (st.selectedEdge ? [st.selectedEdge] : []);
            const selText = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
            const multiCount = selNodes.length + selEdges.length + selText.length;
            const isInSelection = selText.includes(box.id);
            if (multiCount > 1 && isInSelection) {
              onRequestContextMenu?.({ id: '__selection__', x: cand.downClientX, y: cand.downClientY });
            } else {
              selectTextBox(box.id);
              setEditingId(null);
              onRequestContextMenu?.({ id: box.id, x: cand.downClientX, y: cand.downClientY });
            }
          }, LONG_PRESS_MS);
          return;
        }

        const st = useStore.getState();
        const selectedNodesNow = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
        const selectedTextBoxesNow = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
        const isMulti = (selectedNodesNow.length + selectedTextBoxesNow.length) > 1;
        const isInSelection = selectedTextBoxesNow.includes(box.id) || st.selectedTextBoxId === box.id;

        if (!isEditing && isMulti && isInSelection) {
          startGroupDrag(e);
          return;
        }

        selectTextBox(box.id);
        if (!isEditing) startDrag(e, 'move');
      }}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    >
      {/* Hidden measuring box for font auto-fit. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: -99999,
          top: -99999,
          visibility: 'hidden',
          pointerEvents: 'none',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: '1.25',
          fontFamily: 'inherit',
          padding: 0,
          margin: 0,
        }}
      />

      {isEditing ? (
        <textarea
          ref={textareaRef}
          className={styles.editor}
          value={box.text}
          placeholder="Type…"
          onChange={(e) => {
            ensureEditHistory();
            updateTextBox(box.id, { text: e.target.value });
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={() => setEditingId(null)}
          onKeyDown={onKeyDown}
          style={{
            fontSize,
            lineHeight: 1.25,
          }}
        />
      ) : (
        <div
          className={`${styles.display} ${box.text ? '' : styles.placeholder}`}
          style={{ fontSize, lineHeight: 1.25 }}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {box.text || 'Type…'}
        </div>
      )}

      {!isEditing && (
        <div
          className={styles.resizeHandle}
          onPointerDown={(e) => startDrag(e, 'resize')}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      )}
    </div>
  );
}
