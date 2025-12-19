import type { Drawing, EdgeData, NodeData, Tombstones, TextBox } from '../types';

export type SessionState = {
  nodes: NodeData[];
  edges: EdgeData[];
  drawings: Drawing[];
  textBoxes: TextBox[];
  tombstones: Tombstones;
};

const ts = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

const normalizeTombstones = (raw: unknown): Tombstones => {
  if (!raw || typeof raw !== 'object') return { nodes: {}, edges: {}, drawings: {}, textBoxes: {} };
  const r: any = raw;
  return {
    nodes: r.nodes && typeof r.nodes === 'object' ? r.nodes : {},
    edges: r.edges && typeof r.edges === 'object' ? r.edges : {},
    drawings: r.drawings && typeof r.drawings === 'object' ? r.drawings : {},
    textBoxes: r.textBoxes && typeof r.textBoxes === 'object' ? r.textBoxes : {},
  };
};

export function normalizeSessionState(raw: any): SessionState {
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    nodes: Array.isArray(obj.nodes) ? obj.nodes : [],
    edges: Array.isArray(obj.edges) ? obj.edges : [],
    drawings: Array.isArray(obj.drawings) ? obj.drawings : [],
    textBoxes: Array.isArray(obj.textBoxes) ? obj.textBoxes : [],
    tombstones: normalizeTombstones(obj.tombstones),
  };
}

function mergeTombstones(a: Tombstones, b: Tombstones): Tombstones {
  const out: Tombstones = {
    nodes: { ...a.nodes },
    edges: { ...a.edges },
    drawings: { ...a.drawings },
    textBoxes: { ...a.textBoxes },
  };
  for (const [id, t] of Object.entries(b.nodes)) out.nodes[id] = Math.max(ts(out.nodes[id]), ts(t));
  for (const [id, t] of Object.entries(b.edges)) out.edges[id] = Math.max(ts(out.edges[id]), ts(t));
  for (const [id, t] of Object.entries(b.drawings)) out.drawings[id] = Math.max(ts(out.drawings[id]), ts(t));
  for (const [id, t] of Object.entries(b.textBoxes)) out.textBoxes[id] = Math.max(ts(out.textBoxes[id]), ts(t));
  return out;
}

function mergeById<T extends { id: string; updatedAt?: number }>(current: T[], incoming: T[], tombstoneMap: Record<string, number>) {
  const byId = new Map<string, T>();
  const consider = (item: T) => {
    if (!item || typeof item !== 'object') return;
    const id = item.id;
    if (typeof id !== 'string' || !id) return;
    const deletedAt = ts(tombstoneMap[id]);
    const updatedAt = ts(item.updatedAt);
    if (deletedAt && deletedAt >= updatedAt) return;

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, item);
      return;
    }
    if (ts(existing.updatedAt) <= updatedAt) byId.set(id, item);
  };

  current.forEach(consider);
  incoming.forEach(consider);
  return Array.from(byId.values());
}

export function mergeSessionState(localRaw: unknown, remoteRaw: unknown): SessionState {
  const local = normalizeSessionState(localRaw as any);
  const remote = normalizeSessionState(remoteRaw as any);

  const tombstones = mergeTombstones(local.tombstones, remote.tombstones);
  const nodes = mergeById(local.nodes, remote.nodes, tombstones.nodes);
  const edges = mergeById(local.edges, remote.edges, tombstones.edges).filter((e) => {
    const edgeUpdatedAt = ts(e.updatedAt);
    const sourceDeletedAt = ts(tombstones.nodes[e.source]);
    const targetDeletedAt = ts(tombstones.nodes[e.target]);
    if (sourceDeletedAt && sourceDeletedAt >= edgeUpdatedAt) return false;
    if (targetDeletedAt && targetDeletedAt >= edgeUpdatedAt) return false;
    return true;
  });
  const drawings = mergeById(local.drawings, remote.drawings, tombstones.drawings);
  const textBoxes = mergeById(local.textBoxes, remote.textBoxes, tombstones.textBoxes);

  return { nodes, edges, drawings, textBoxes, tombstones };
}
