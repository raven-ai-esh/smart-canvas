import type { EdgeData, NodeData } from '../types';

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

export const getIncomingProgress = (
  nodes: NodeData[],
  edges: EdgeData[],
  nodeId: string,
) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sourceIds = new Set<string>();
  for (const edge of edges) {
    if (!edge || edge.target !== nodeId) continue;
    if (typeof edge.source === 'string' && edge.source) sourceIds.add(edge.source);
  }
  let sum = 0;
  let count = 0;
  sourceIds.forEach((id) => {
    const source = byId.get(id);
    if (!source) return;
    sum += clampProgress(source.progress);
    count += 1;
  });
  const value = count ? clampProgress(sum / count) : 0;
  return { count, value };
};

export const applyChildProgress = (
  nodes: NodeData[],
  edges: EdgeData[],
  opts?: { now?: number },
) => {
  const now = opts?.now ?? Date.now();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incomingByTarget = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge || typeof edge.target !== 'string' || typeof edge.source !== 'string') continue;
    const target = edge.target;
    let set = incomingByTarget.get(target);
    if (!set) {
      set = new Set();
      incomingByTarget.set(target, set);
    }
    set.add(edge.source);
  }

  let changed = false;
  let progressChanged = false;
  const nextNodes = nodes.map((node) => {
    if (!node || typeof node !== 'object') return node;
    if (node.type !== 'task') {
      if (!node.childProgress) return node;
      changed = true;
      return { ...node, childProgress: false, updatedAt: now };
    }
    if (!node.childProgress) return node;
    const sources = incomingByTarget.get(node.id);
    if (!sources || sources.size === 0) {
      changed = true;
      return { ...node, childProgress: false, updatedAt: now };
    }

    let sum = 0;
    let count = 0;
    sources.forEach((sourceId) => {
      const source = byId.get(sourceId);
      if (!source) return;
      sum += clampProgress(source.progress);
      count += 1;
    });
    if (!count) {
      changed = true;
      return { ...node, childProgress: false, updatedAt: now };
    }

    const nextProgress = clampProgress(sum / count);
    const nextStatus = statusFromProgress(nextProgress);
    const prevProgress = clampProgress(node.progress);
    if (Math.abs(prevProgress - nextProgress) < 0.1 && node.status === nextStatus) {
      return node;
    }
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
