import type { LayerData } from '../types';

export const DEFAULT_LAYER_ID = 'layer-default';
export const DEFAULT_LAYER_NAME = 'Base';

const normalizeLayer = (raw: any, now: number, fallbackIndex: number): LayerData | null => {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  if (!id) return null;
  const nameRaw = typeof raw.name === 'string' ? raw.name.trim() : '';
  const name = nameRaw || `Layer ${fallbackIndex + 1}`;
  const visible = raw.visible !== false;
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : now;
  const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : createdAt;
  return { id, name, visible, createdAt, updatedAt };
};

export const buildDefaultLayer = (now = Date.now()): LayerData => ({
  id: DEFAULT_LAYER_ID,
  name: DEFAULT_LAYER_NAME,
  visible: true,
  createdAt: now,
  updatedAt: now,
});

export const normalizeLayers = (raw: unknown, now = Date.now()): LayerData[] => {
  const input = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const cleaned: LayerData[] = [];
  input.forEach((item, idx) => {
    const layer = normalizeLayer(item, now, idx);
    if (!layer || seen.has(layer.id)) return;
    seen.add(layer.id);
    cleaned.push(layer);
  });
  if (!seen.has(DEFAULT_LAYER_ID)) {
    cleaned.unshift(buildDefaultLayer(now));
  }
  return cleaned;
};

export const resolveLayerId = (layers: LayerData[], layerId?: string | null) => {
  if (layerId && layers.some((layer) => layer.id === layerId)) return layerId;
  return layers[0]?.id ?? DEFAULT_LAYER_ID;
};

export const ensureItemLayerId = <T extends { layerId?: string | null }>(
  items: T[],
  layers: LayerData[],
): T[] => {
  let changed = false;
  const next = items.map((item) => {
    const nextLayerId = resolveLayerId(layers, item.layerId);
    if (nextLayerId === (item.layerId ?? null)) return item;
    changed = true;
    return { ...item, layerId: nextLayerId };
  });
  return changed ? next : items;
};
