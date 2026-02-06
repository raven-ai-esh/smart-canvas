import type { EdgeData, NodeData } from '../types';

const parseDateInput = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(`${trimmed}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
};

const formatDateInput = (valueMs: number) => new Date(valueMs).toISOString().slice(0, 10);

const applyChildDatesOnce = (
  nodes: NodeData[],
  edges: EdgeData[],
  now: number,
) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rangesByParent = new Map<string, { minStart: number | null; maxEnd: number | null }>();

  for (const edge of edges) {
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string') continue;
    const child = byId.get(edge.source);
    if (!child || child.type !== 'task') continue;
    const parent = byId.get(edge.target);
    if (!parent || parent.type !== 'task') continue;

    const startMs = parseDateInput(child.startDate);
    const endMs = parseDateInput(child.endDate);
    if (startMs === null && endMs === null) continue;

    let entry = rangesByParent.get(parent.id);
    if (!entry) {
      entry = { minStart: null, maxEnd: null };
      rangesByParent.set(parent.id, entry);
    }
    if (startMs !== null) {
      entry.minStart = entry.minStart === null ? startMs : Math.min(entry.minStart, startMs);
    }
    if (endMs !== null) {
      entry.maxEnd = entry.maxEnd === null ? endMs : Math.max(entry.maxEnd, endMs);
    }
  }

  let changed = false;
  const nextNodes = nodes.map((node) => {
    if (!node || node.type !== 'task') return node;
    const range = rangesByParent.get(node.id);
    if (!range) return node;

    const startManual = node.startDateManual === true;
    const endManual = node.endDateManual === true;
    const startAuto = node.startDateAuto === true;
    const endAuto = node.endDateAuto === true;
    if (startManual && endManual) return node;
    const hasStart = typeof node.startDate === 'string' && node.startDate.trim().length > 0;
    const hasEnd = typeof node.endDate === 'string' && node.endDate.trim().length > 0;

    let candidateStart = range.minStart !== null ? formatDateInput(range.minStart) : null;
    let candidateEnd = range.maxEnd !== null ? formatDateInput(range.maxEnd) : null;

    if (candidateStart && candidateEnd && range.minStart !== null && range.maxEnd !== null) {
      if (range.minStart > range.maxEnd) candidateEnd = null;
    }

    let nextStart = node.startDate;
    let nextEnd = node.endDate;
    let nextStartAuto = startAuto;
    let nextEndAuto = endAuto;

    if (!startManual) {
      if (candidateStart !== null) {
        if (!hasStart || startAuto) {
          nextStart = candidateStart;
          nextStartAuto = true;
        }
      } else if (startAuto) {
        nextStart = undefined;
        nextStartAuto = false;
      }
    }

    if (!endManual) {
      if (candidateEnd !== null) {
        if (!hasEnd || endAuto) {
          nextEnd = candidateEnd;
          nextEndAuto = true;
        }
      } else if (endAuto) {
        nextEnd = undefined;
        nextEndAuto = false;
      }
    }

    if (
      nextStart === node.startDate
      && nextEnd === node.endDate
      && nextStartAuto === startAuto
      && nextEndAuto === endAuto
    ) {
      return node;
    }
    changed = true;
    return {
      ...node,
      startDate: nextStart,
      endDate: nextEnd,
      startDateAuto: nextStartAuto,
      endDateAuto: nextEndAuto,
      updatedAt: now,
    };
  });

  return {
    nodes: changed ? nextNodes : nodes,
    changed,
  };
};

export const applyChildDates = (
  nodes: NodeData[],
  edges: EdgeData[],
  opts?: { now?: number },
) => {
  const now = opts?.now ?? Date.now();
  let current = nodes;
  let changed = false;
  const maxPasses = Math.max(1, nodes.length);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = applyChildDatesOnce(current, edges, now);
    if (!result.changed) break;
    current = result.nodes;
    changed = true;
  }
  return {
    nodes: changed ? current : nodes,
    changed,
  };
};
