import type { Comment, NodeData, TextBox } from '../types';
import { DEFAULT_LAYER_ID } from './layers';

export type StackKind = 'node' | 'textBox' | 'comment';

export type StackEntry = {
  kind: StackKind;
  id: string;
  layerId: string;
  zIndex: number | null;
  fallback: number;
  item: NodeData | TextBox | Comment;
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const resolveItemLayerId = (item: { layerId?: string | null }) => (
  typeof item.layerId === 'string' && item.layerId ? item.layerId : DEFAULT_LAYER_ID
);

export const collectLayerStackEntries = (opts: {
  nodes: NodeData[];
  textBoxes: TextBox[];
  comments: Comment[];
  layerId: string;
}): StackEntry[] => {
  const { nodes, textBoxes, comments, layerId } = opts;
  const entries: StackEntry[] = [];
  let fallback = 0;
  const push = (kind: StackKind, item: NodeData | TextBox | Comment) => {
    entries.push({
      kind,
      id: item.id,
      layerId,
      zIndex: isFiniteNumber(item.zIndex) ? item.zIndex : null,
      fallback: fallback++,
      item,
    });
  };

  textBoxes.forEach((tb) => {
    if (resolveItemLayerId(tb) !== layerId) return;
    push('textBox', tb);
  });
  nodes.forEach((node) => {
    if (resolveItemLayerId(node) !== layerId) return;
    push('node', node);
  });
  comments.forEach((comment) => {
    if (resolveItemLayerId(comment) !== layerId) return;
    push('comment', comment);
  });
  return entries;
};

export const sortLayerStackEntries = (entries: StackEntry[]): StackEntry[] => {
  const hasExplicit = entries.some((entry) => isFiniteNumber(entry.zIndex));
  const keyFor = (entry: StackEntry) => {
    if (!hasExplicit) return entry.fallback;
    return isFiniteNumber(entry.zIndex) ? entry.zIndex : entry.fallback;
  };
  return entries
    .slice()
    .sort((a, b) => keyFor(a) - keyFor(b) || a.fallback - b.fallback);
};
