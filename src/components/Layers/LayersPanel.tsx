import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { DEFAULT_LAYER_ID } from '../../utils/layers';
import styles from './LayersPanel.module.css';

export const LayersPanel: React.FC = () => {
    const layers = useStore((state) => state.layers);
    const activeLayerId = useStore((state) => state.activeLayerId);
    const setActiveLayerId = useStore((state) => state.setActiveLayerId);
    const addLayer = useStore((state) => state.addLayer);
    const renameLayer = useStore((state) => state.renameLayer);
    const toggleLayerVisibility = useStore((state) => state.toggleLayerVisibility);
    const setLayerVisibility = useStore((state) => state.setLayerVisibility);
    const showAllLayers = useStore((state) => state.showAllLayers);
    const mergeLayers = useStore((state) => state.mergeLayers);
    const deleteLayers = useStore((state) => state.deleteLayers);

    const rootRef = useRef<HTMLDivElement | null>(null);
    const [open, setOpen] = useState(false);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');

    const layerById = useMemo(() => new Map(layers.map((layer) => [layer.id, layer])), [layers]);
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const selectedCount = selectedIds.length;
    const canMerge = selectedCount > 1;
    const hasSelection = selectedCount > 0;
    const hasDeletable = selectedIds.some((id) => id !== DEFAULT_LAYER_ID);
    const selectedAnyHidden = useMemo(
        () => selectedIds.some((id) => layerById.get(id)?.visible === false),
        [layerById, selectedIds],
    );
    const mergeTargetId = selectedIds[0] ?? null;
    const mergeTargetName = mergeTargetId ? layerById.get(mergeTargetId)?.name ?? 'Layer' : null;
    const mergeLabel = mergeTargetName ? `Merge into ${mergeTargetName}` : 'Merge';

    useEffect(() => {
        setSelectedIds((prev) => {
            const next = prev.filter((id) => layers.some((layer) => layer.id === id));
            return next.length === prev.length ? prev : next;
        });
        if (renamingId && !layers.some((layer) => layer.id === renamingId)) {
            setRenamingId(null);
        }
    }, [layers, renamingId]);

    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (e: PointerEvent) => {
            const root = rootRef.current;
            if (!root) return;
            if (root.contains(e.target as Node)) return;
            setOpen(false);
            setRenamingId(null);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [open]);

    const handleToggleOpen = () => {
        setOpen((prev) => !prev);
        setRenamingId(null);
    };

    const handleAddLayer = () => {
        const id = addLayer();
        const layer = useStore.getState().layers.find((item) => item.id === id);
        setSelectedIds([id]);
        setRenamingId(id);
        setRenameValue(layer?.name ?? '');
        setOpen(true);
    };

    const toggleSelected = (id: string) => {
        setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
    };

    const commitRename = (id: string) => {
        const trimmed = renameValue.trim();
        if (trimmed) renameLayer(id, trimmed);
        setRenamingId(null);
    };

    const handleMergeSelected = () => {
        if (!canMerge) return;
        const targetId = selectedIds[0];
        if (!targetId) return;
        mergeLayers(selectedIds, targetId);
        setSelectedIds([targetId]);
        setActiveLayerId(targetId);
    };

    const handleDeleteSelected = () => {
        if (!hasDeletable) return;
        const deletable = selectedIds.filter((id) => id !== DEFAULT_LAYER_ID);
        if (deletable.length === 0) return;
        const shouldDelete = window.confirm(`Delete ${deletable.length} layer${deletable.length > 1 ? 's' : ''}?`);
        if (!shouldDelete) return;
        deleteLayers(deletable);
        setSelectedIds((prev) => prev.filter((id) => !deletable.includes(id)));
    };

    return (
        <div ref={rootRef} className={styles.layersRoot} data-interactive="true">
            {open && (
                <div className={styles.layersPanel} data-interactive="true" data-scroll-lock="true">
                    <div className={styles.panelHeader}>
                        <div className={styles.panelTitle}>
                            Layers <span className={styles.panelCount}>{layers.length}</span>
                        </div>
                        <div className={styles.panelHeaderActions}>
                            <button
                                type="button"
                                className={styles.actionButton}
                                onClick={showAllLayers}
                                title="Show all layers"
                            >
                                All
                            </button>
                            <button
                                type="button"
                                className={styles.actionButton}
                                onClick={handleAddLayer}
                                title="Add layer"
                            >
                                <Plus size={14} />
                            </button>
                        </div>
                    </div>
                    <div className={styles.panelActions}>
                        <button
                            type="button"
                            className={styles.actionButton}
                            onClick={() => selectedIds.forEach((id) => setLayerVisibility(id, selectedAnyHidden))}
                            disabled={!hasSelection}
                            title={selectedAnyHidden ? 'Show selected' : 'Hide selected'}
                        >
                            {selectedAnyHidden ? 'Show' : 'Hide'}
                        </button>
                        <button
                            type="button"
                            className={styles.actionButton}
                            onClick={handleMergeSelected}
                            disabled={!canMerge}
                            title={mergeLabel}
                        >
                            {mergeLabel}
                        </button>
                        <button
                            type="button"
                            className={styles.actionButton}
                            onClick={handleDeleteSelected}
                            disabled={!hasDeletable}
                            title="Delete selected"
                        >
                            Delete
                        </button>
                    </div>
                    <div className={styles.layerList} data-scroll-lock="true">
                        {layers.map((layer) => {
                            const isActive = layer.id === activeLayerId;
                            const isSelected = selectedSet.has(layer.id);
                            const isHidden = !layer.visible;
                            const isDefault = layer.id === DEFAULT_LAYER_ID;
                            return (
                                <div
                                    key={layer.id}
                                    className={[
                                        styles.layerRow,
                                        isActive ? styles.layerRowActive : '',
                                        isSelected ? styles.layerRowSelected : '',
                                        isHidden ? styles.layerRowHidden : '',
                                    ].join(' ')}
                                    data-interactive="true"
                                    onClick={(e) => {
                                        const target = e.target as HTMLElement | null;
                                        if (target?.closest?.('[data-layer-control="true"]')) return;
                                        setActiveLayerId(layer.id);
                                    }}
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    <input
                                        type="checkbox"
                                        className={styles.layerCheckbox}
                                        checked={isSelected}
                                        onChange={() => toggleSelected(layer.id)}
                                        onClick={(e) => e.stopPropagation()}
                                        data-layer-control="true"
                                        aria-label={`Select ${layer.name}`}
                                    />
                                    <button
                                        type="button"
                                        className={styles.visibilityButton}
                                        data-interactive="true"
                                        aria-pressed={layer.visible}
                                        aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
                                        data-layer-control="true"
                                        onPointerDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleLayerVisibility(layer.id);
                                        }}
                                        title={layer.visible ? 'Hide layer' : 'Show layer'}
                                    >
                                        {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                                    </button>
                                    {renamingId === layer.id ? (
                                        <input
                                            className={styles.layerRenameInput}
                                            value={renameValue}
                                            onChange={(e) => setRenameValue(e.target.value)}
                                            onBlur={() => commitRename(layer.id)}
                                            onClick={(e) => e.stopPropagation()}
                                            data-layer-control="true"
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    commitRename(layer.id);
                                                } else if (e.key === 'Escape') {
                                                    setRenamingId(null);
                                                }
                                            }}
                                            autoFocus
                                        />
                                    ) : (
                                        <button
                                            type="button"
                                            className={styles.layerNameButton}
                                            onDoubleClick={(e) => {
                                                e.stopPropagation();
                                                setRenamingId(layer.id);
                                                setRenameValue(layer.name);
                                            }}
                                            title={layer.name}
                                        >
                                            <span className={styles.layerName}>{layer.name}</span>
                                            {isActive && <span className={styles.activeBadge}>Active</span>}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className={styles.deleteButton}
                                        disabled={isDefault}
                                        data-layer-control="true"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (isDefault) return;
                                            const shouldDelete = window.confirm(`Delete layer "${layer.name}"?`);
                                            if (!shouldDelete) return;
                                            deleteLayers([layer.id]);
                                            setSelectedIds((prev) => prev.filter((id) => id !== layer.id));
                                        }}
                                        title={isDefault ? 'Default layer cannot be deleted' : 'Delete layer'}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
            <button
                type="button"
                className={`${styles.layersToggle} ${open ? styles.layersToggleActive : ''}`}
                onClick={handleToggleOpen}
                title="Layers"
                data-interactive="true"
            >
                <img className={styles.layersIcon} src="/icons/layers.png" alt="Layers" />
            </button>
        </div>
    );
};
