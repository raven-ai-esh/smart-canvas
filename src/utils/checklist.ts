import type { ChecklistItem, NodeData } from '../types';

const clampProgress = (value: unknown) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(100, Math.max(0, num));
};

const statusFromProgress = (progress: number) => {
  if (progress >= 100) return 'done' as const;
  if (progress <= 0) return 'queued' as const;
  return 'in_progress' as const;
};

const normalizeChecklist = (items: ChecklistItem[] | undefined | null) => {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item.id === 'string' && item.id);
};

export const getChecklistStats = (items: ChecklistItem[] | undefined | null) => {
  const list = normalizeChecklist(items);
  const total = list.length;
  let done = 0;
  for (const item of list) {
    if (item?.done) done += 1;
  }
  const progress = total ? clampProgress((done / total) * 100) : 0;
  return { total, done, progress };
};

export const applyChecklistProgress = (
  nodes: NodeData[],
  opts?: { now?: number },
) => {
  const now = opts?.now ?? Date.now();
  let changed = false;
  let progressChanged = false;
  const nextNodes = nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    if (node.type !== 'task') return node;
    if (node.childProgress) return node;
    if (node.progressManual) return node;
    const { total, progress } = getChecklistStats(node.checklist);
    if (!total) return node;
    const nextProgress = clampProgress(progress);
    const nextStatus = statusFromProgress(nextProgress);
    const prevProgress = clampProgress(node.progress);
    if (Math.abs(prevProgress - nextProgress) < 0.1 && node.status === nextStatus) return node;
    changed = true;
    progressChanged = true;
    return {
      ...node,
      progress: nextProgress,
      status: nextStatus,
      updatedAt: now,
    };
  });

  return {
    nodes: changed ? nextNodes : nodes,
    changed,
    progressChanged,
  };
};
