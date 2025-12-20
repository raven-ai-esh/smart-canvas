import type { EdgeData, NodeData } from '../types';

export const relu = (x: number) => (x > 0 ? x : 0);
export const clampEnergy = (x: number) => Math.min(100, Math.max(0, x));

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const hexToRgb = (hex: string) => {
  const raw = hex.replace('#', '');
  const r = Number.parseInt(raw.slice(0, 2), 16);
  const g = Number.parseInt(raw.slice(2, 4), 16);
  const b = Number.parseInt(raw.slice(4, 6), 16);
  return { r, g, b };
};

const rgbToCss = (rgb: { r: number; g: number; b: number }) =>
  `rgb(${Math.round(rgb.r)} ${Math.round(rgb.g)} ${Math.round(rgb.b)})`;

const mix = (a: string, b: string, t: number) => {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToCss({
    r: lerp(ca.r, cb.r, t),
    g: lerp(ca.g, cb.g, t),
    b: lerp(ca.b, cb.b, t),
  });
};

const GREEN = '#A3BE8C';
const GOLD = '#EBCB8B';
const RED = '#BF616A';

export function energyToColor(energy0to100: number) {
  const e = clampEnergy(energy0to100);
  if (e <= 33) return mix(GREEN, GOLD, e / 33);
  if (e <= 66) return mix(GOLD, RED, (e - 33) / 33);
  return mix(RED, RED, 0);
}

export function computeEffectiveEnergy(
  nodes: NodeData[],
  edges: EdgeData[],
  opts?: { maxIterations?: number; blockDoneTasks?: boolean },
): Record<string, number> {
  const maxIterations = opts?.maxIterations ?? 20;
  const blockDoneTasks = !!opts?.blockDoneTasks;

  const baseById: Record<string, number> = {};
  const byId: Record<string, NodeData> = {};
  nodes.forEach((n) => {
    baseById[n.id] = clampEnergy(Number.isFinite(n.energy) ? n.energy : 50);
    byId[n.id] = n;
  });

  // Start from base energy.
  let effective: Record<string, number> = { ...baseById };

  // Directed edges: source -> target; energy propagates into target.
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    const next: Record<string, number> = { ...effective };

    for (const node of nodes) {
      let incoming = 0;
      for (const edge of edges) {
        if (edge.target !== node.id) continue;
        if (blockDoneTasks) {
          const srcNode = byId[edge.source];
          if (srcNode?.type === 'task') {
            const progress = typeof srcNode.progress === 'number' && Number.isFinite(srcNode.progress) ? srcNode.progress : 0;
            if (progress >= 100 || srcNode.status === 'done') continue;
          }
        }
        incoming += relu(effective[edge.source] ?? baseById[edge.source] ?? 0);
      }
      const base = baseById[node.id] ?? 0;
      const incomingCapped = Math.min(incoming, Math.max(0, 100 - base));
      const computed = clampEnergy(base + incomingCapped);
      if (computed !== (effective[node.id] ?? 0)) changed = true;
      next[node.id] = computed;
    }

    effective = next;
    if (!changed) break;
  }

  return effective;
}
