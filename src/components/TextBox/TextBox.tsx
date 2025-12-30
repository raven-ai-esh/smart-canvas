import React from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { TextBox as TextBoxType } from '../../types';
import { useStore } from '../../store/useStore';
import { formatBytes } from '../../utils/attachments';
import styles from './TextBox.module.css';

const MIN_W = 80;
const MIN_H = 44;
const DRAG_COMMIT_DIST = 1.5;
const INNER_PAD_X = 16; // left+right (8+8)
const INNER_PAD_Y = 16; // top+bottom (8+8)
const BORDER_BOX_SHRINK = 2; // 1px border on each side with box-sizing: border-box
const LONG_PRESS_MS = 500;
const TOUCH_DRAG_THRESHOLD = 8;

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; kind: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; kind: 'pdf'; src: string }
  | { status: 'ready'; kind: 'text' | 'markdown' | 'json'; text: string }
  | { status: 'ready'; kind: 'table'; rows: string[][]; truncated: boolean }
  | { status: 'ready'; kind: 'html'; html: string };

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

const getFileExtension = (name: string) => {
  const trimmed = name.trim();
  const idx = trimmed.lastIndexOf('.');
  if (idx === -1) return '';
  return trimmed.slice(idx + 1).toLowerCase();
};

const dataUrlToText = (dataUrl: string) => {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return '';
  const meta = dataUrl.slice(0, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  if (meta.includes(';base64')) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }
  return decodeURIComponent(payload);
};

const dataUrlToArrayBuffer = (dataUrl: string) => {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return new ArrayBuffer(0);
  const meta = dataUrl.slice(0, commaIdx);
  const payload = dataUrl.slice(commaIdx + 1);
  if (meta.includes(';base64')) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  const text = decodeURIComponent(payload);
  return new TextEncoder().encode(text).buffer;
};

const isDataUrl = (value: string) => value.startsWith('data:');

const sourceToText = async (src: string) => {
  if (isDataUrl(src)) return dataUrlToText(src);
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error('preview_fetch_failed');
  return res.text();
};

const sourceToArrayBuffer = async (src: string) => {
  if (isDataUrl(src)) return dataUrlToArrayBuffer(src);
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error('preview_fetch_failed');
  return res.arrayBuffer();
};

const limitRows = (rows: unknown[][], maxRows: number, maxCols: number) => {
  const limited = rows.slice(0, maxRows).map((row) =>
    row.slice(0, maxCols).map((cell) => (cell == null ? '' : String(cell))),
  );
  const truncated = rows.length > maxRows || rows.some((row) => row.length > maxCols);
  return { rows: limited, truncated };
};

const parseCsvRows = (input: string, maxRows: number, maxCols: number) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') {
      const nextChar = input[i + 1];
      if (inQuotes && nextChar === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n' && !inQuotes) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= maxRows) break;
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      if (row.length >= maxCols) {
        rows.push(row);
        row = [];
        cell = '';
        if (rows.length >= maxRows) break;
      }
      continue;
    }
    cell += char;
  }

  if (row.length || cell) {
    row.push(cell);
    rows.push(row);
  }

  return limitRows(rows, maxRows, maxCols);
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
  const authorshipMode = useStore((s) => s.authorshipMode);

  const isEditing = editingId === box.id;
  const isImage = box.kind === 'image' && typeof box.src === 'string' && box.src.length > 0;
  const isFile = box.kind === 'file' && typeof box.src === 'string' && box.src.length > 0;
  const isMedia = isImage || isFile;
  const isSelected = selectedId === box.id || selectedIds.includes(box.id);
  const fileName = typeof box.fileName === 'string' ? box.fileName.trim() : '';
  const fileMime = typeof box.fileMime === 'string' ? box.fileMime.trim() : '';
  const fileSize = Number.isFinite(box.fileSize) ? Number(box.fileSize) : null;
  const fileExt = getFileExtension(fileName);
  const fileBadge = fileExt ? fileExt.toUpperCase() : 'FILE';
  const fileDisplayName = fileName || 'Document';
  const authorLabel = typeof box.authorName === 'string' ? box.authorName.trim() : '';
  const [isHovered, setIsHovered] = React.useState(false);
  const showAuthor = authorshipMode && !!authorLabel && (isHovered || isSelected);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const measureRef = React.useRef<HTMLDivElement | null>(null);
  const editHistoryRef = React.useRef(false);
  const lastTapRef = React.useRef<{ t: number; x: number; y: number } | null>(null);

  const [fontSize, setFontSize] = React.useState(14);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [previewState, setPreviewState] = React.useState<PreviewState>({ status: 'idle' });

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

  React.useEffect(() => {
    if (!previewOpen || !isFile || !box.src) {
      setPreviewState({ status: 'idle' });
      return;
    }
    const src = box.src;
    let cancelled = false;

    const run = async () => {
      const ext = getFileExtension(fileName);
      const mime = fileMime.toLowerCase();
      const isPdf = mime === 'application/pdf' || ext === 'pdf';
      const isMarkdown = ext === 'md' || mime === 'text/markdown' || mime === 'text/x-markdown';
      const isText = ext === 'txt' || mime.startsWith('text/plain');
      const isJson = ext === 'json' || mime === 'application/json';
      const isCsv = ext === 'csv' || mime === 'text/csv';
      const isDocx = ext === 'docx' || mime.includes('wordprocessingml');
      const isDoc = ext === 'doc' || mime === 'application/msword';
      const isXlsx = ext === 'xlsx' || mime.includes('spreadsheet') || mime.includes('excel');

      try {
        if (isPdf) {
          if (!cancelled) setPreviewState({ status: 'ready', kind: 'pdf', src });
          return;
        }
        if (isMarkdown) {
          const text = await sourceToText(src);
          if (!cancelled) setPreviewState({ status: 'ready', kind: 'markdown', text });
          return;
        }
        if (isText) {
          const text = await sourceToText(src);
          if (!cancelled) setPreviewState({ status: 'ready', kind: 'text', text });
          return;
        }
        if (isJson) {
          const raw = await sourceToText(src);
          let text = raw;
          try {
            text = JSON.stringify(JSON.parse(raw), null, 2);
          } catch {
            // Keep raw JSON if parsing fails.
          }
          if (!cancelled) setPreviewState({ status: 'ready', kind: 'json', text });
          return;
        }
        if (isCsv) {
          const text = await sourceToText(src);
          const { rows, truncated } = parseCsvRows(text, 200, 30);
          if (!cancelled) setPreviewState({ status: 'ready', kind: 'table', rows, truncated });
          return;
        }
        if (isDoc) {
          if (!cancelled) setPreviewState({ status: 'error', message: 'Preview is not available for .doc files.' });
          return;
        }
        if (isDocx) {
          if (!cancelled) setPreviewState({ status: 'loading', kind: 'docx' });
          const buffer = await sourceToArrayBuffer(src);
          const mammothModule = await import('mammoth/mammoth.browser');
          const convert = typeof mammothModule.convertToHtml === 'function'
            ? mammothModule.convertToHtml
            : mammothModule.default?.convertToHtml;
          if (!convert) throw new Error('docx_preview_unavailable');
          const result = await convert({ arrayBuffer: buffer });
          if (!cancelled) setPreviewState({ status: 'ready', kind: 'html', html: result.value || '' });
          return;
        }
        if (isXlsx) {
          if (!cancelled) setPreviewState({ status: 'loading', kind: 'xlsx' });
          const buffer = await sourceToArrayBuffer(src);
          const xlsxModule = await import('xlsx');
          const XLSX = xlsxModule.default ?? xlsxModule;
          if (!XLSX.read || !XLSX.utils?.sheet_to_json) throw new Error('xlsx_preview_unavailable');
          const workbook = XLSX.read(buffer, { type: 'array' });
          const sheetName = workbook.SheetNames?.[0];
          if (!sheetName) throw new Error('xlsx_preview_empty');
          const sheet = workbook.Sheets[sheetName];
          const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false }) as unknown[][];
          const { rows, truncated } = limitRows(rawRows, 200, 30);
          if (!cancelled) setPreviewState({ status: 'ready', kind: 'table', rows, truncated });
          return;
        }
        if (!cancelled) setPreviewState({ status: 'error', message: 'Preview is not available for this file type.' });
      } catch (err) {
        if (!cancelled) {
          setPreviewState({ status: 'error', message: 'Failed to load preview.' });
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [previewOpen, isFile, box.src, fileName, fileMime]);

  React.useEffect(() => {
    if (!previewOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewOpen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [previewOpen]);

  // Auto-fit font size to the current box (smooth updates, no jumping).
  React.useEffect(() => {
    const el = measureRef.current;
    if (isMedia) return;
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
  }, [box.width, box.height, box.text, isMedia]);

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

    // iOS Safari can be flaky with touch pointer capture; keep it for mouse/pen only.
    if (e.pointerType !== 'touch') {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
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

    // Match Canvas behavior: avoid touch capture to prevent stuck gestures on iOS.
    if (e.pointerType !== 'touch') {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
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

    // Avoid touch capture to keep iOS drag streams stable.
    if (e.pointerType !== 'touch') {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
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
        const now = Date.now();
        const last = lastTapRef.current;
        const dist = last ? Math.hypot(e.clientX - last.x, e.clientY - last.y) : Number.POSITIVE_INFINITY;
        // Use a double-tap on touch to enter edit mode; single tap keeps selection.
        if (last && now - last.t < 320 && dist < 24) {
          lastTapRef.current = null;
          selectTextBox(box.id);
          if (!isImage) setEditingId(box.id);
        } else {
          lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
          selectTextBox(box.id);
        }
      } else if (opened) {
        // Reset tap history when a long-press context menu is shown.
        lastTapRef.current = null;
      }
      return;
    }

    const group = groupDragRef.current;
    if (group && group.pointerId === e.pointerId) {
      groupDragRef.current = null;
      e.stopPropagation();
      if (e.pointerType !== 'touch') {
        try {
          (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
      }
      clearAlignmentGuides?.();
      return;
    }

    const st = dragStateRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    e.stopPropagation();
    if (e.pointerType !== 'touch') {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
    }
    clearAlignmentGuides?.();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isFile) {
      setPreviewOpen(true);
      return;
    }
    if (isImage) return;
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
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
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

        if (e.shiftKey && !isEditing) {
          const st = useStore.getState();
          const selectedNodesNow = st.selectedNodes?.length ? st.selectedNodes : (st.selectedNode ? [st.selectedNode] : []);
          const selectedEdgesNow = st.selectedEdges?.length ? st.selectedEdges : (st.selectedEdge ? [st.selectedEdge] : []);
          const selectedTextBoxesNow = st.selectedTextBoxes?.length ? st.selectedTextBoxes : (st.selectedTextBoxId ? [st.selectedTextBoxId] : []);
          if (!selectedTextBoxesNow.includes(box.id)) {
            st.setMultiSelection({ nodes: selectedNodesNow, edges: selectedEdgesNow, textBoxes: [...selectedTextBoxesNow, box.id] });
          }
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

      {authorLabel && (
        <div className={`${styles.authorBadge} ${showAuthor ? styles.authorVisible : ''}`}>{authorLabel}</div>
      )}

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
          className={`${styles.display} ${(!isMedia && !box.text) ? styles.placeholder : ''}`}
          style={{ fontSize, lineHeight: 1.25 }}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {isImage ? (
            <img className={styles.imageDisplay} src={box.src} alt="" draggable={false} />
          ) : isFile ? (
            <div className={styles.fileCard}>
              <div className={styles.fileIcon}>
                <FileText size={26} />
                <span className={styles.fileBadge}>{fileBadge}</span>
              </div>
              <div className={styles.fileInfo}>
                <div className={styles.fileName}>{fileDisplayName}</div>
                <div className={styles.fileMeta}>
                  {fileSize !== null ? formatBytes(fileSize) : 'Unknown size'}
                </div>
              </div>
              <button
                type="button"
                className={styles.fileOpenButton}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewOpen(true);
                }}
              >
                Open
              </button>
            </div>
          ) : (
            (box.text || 'Type…')
          )}
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
      {previewOpen && isFile && typeof document !== 'undefined' && box.src && createPortal(
        <div
          className={styles.previewOverlay}
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className={styles.previewModal}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.previewHeader}>
              <div className={styles.previewTitle}>
                {fileDisplayName}
                {fileSize !== null ? ` · ${formatBytes(fileSize)}` : ''}
              </div>
              <div className={styles.previewActions}>
                <a
                  className={styles.previewButton}
                  href={box.src}
                  download={fileDisplayName}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Download size={14} />
                  Download
                </a>
                <button
                  type="button"
                  className={styles.previewButton}
                  onClick={() => setPreviewOpen(false)}
                >
                  <X size={14} />
                  Close
                </button>
              </div>
            </div>
            <div className={styles.previewBody}>
              {previewState.status === 'loading' && (
                <div className={styles.previewLoading}>Loading preview…</div>
              )}
              {previewState.status === 'error' && (
                <div className={styles.previewError}>{previewState.message}</div>
              )}
              {previewState.status === 'ready' && previewState.kind === 'pdf' && (
                <iframe className={styles.previewFrame} src={previewState.src} title={fileDisplayName} />
              )}
              {previewState.status === 'ready' && previewState.kind === 'text' && (
                <pre className={styles.previewText}>{previewState.text}</pre>
              )}
              {previewState.status === 'ready' && previewState.kind === 'json' && (
                <pre className={styles.previewText}>{previewState.text}</pre>
              )}
              {previewState.status === 'ready' && previewState.kind === 'markdown' && (
                <div className={styles.previewMarkdown}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewState.text}</ReactMarkdown>
                </div>
              )}
              {previewState.status === 'ready' && previewState.kind === 'html' && (
                <div
                  className={styles.previewDoc}
                  dangerouslySetInnerHTML={{ __html: previewState.html }}
                />
              )}
              {previewState.status === 'ready' && previewState.kind === 'table' && (
                <div className={styles.previewTableWrap}>
                  <table className={styles.previewTable}>
                    <tbody>
                      {previewState.rows.map((row, rowIdx) => (
                        <tr key={`${rowIdx}`}>
                          {row.map((cell, cellIdx) => (
                            <td key={`${rowIdx}-${cellIdx}`}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {previewState.truncated && (
                    <div className={styles.previewNotice}>Showing first 200 rows / 30 columns.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
