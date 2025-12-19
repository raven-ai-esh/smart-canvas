import React, { useCallback, useRef, useState } from 'react';
import { Bold, Italic, Strikethrough, Code, List, ListOrdered, Quote } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../store/useStore';
import type { NodeData } from '../../types';
import styles from './Node.module.css';
import { numberLines, prefixLines, wrapSelection } from '../../utils/textEditing';
import { clampEnergy, energyToColor } from '../../utils/energy';
import { EnergySvgLiquidGauge } from './EnergySvgLiquidGauge';

// View Components
const GraphView: React.FC<{ data: NodeData }> = ({ data }) => (
    <div className={`${styles.graphNode} ${data.type === 'task' ? styles.task : ''}`} />
);

// Helper to get distance to center
const getDistToCenter = (x: number, y: number, canvas: { x: number, y: number, scale: number }) => {
    // Current Viewport Center in Screen Coords
    const screenCX = window.innerWidth / 2;
    const screenCY = window.innerHeight / 2;

    // Convert to World Coords
    const worldCX = (screenCX - canvas.x) / canvas.scale;
    const worldCY = (screenCY - canvas.y) / canvas.scale;

    return Math.sqrt(Math.pow(x - worldCX, 2) + Math.pow(y - worldCY, 2));
};

type TextSel = { start: number; end: number };

const NoteContentEditor: React.FC<{
    nodeId: string;
    value: string;
}> = ({ nodeId, value }) => {
    const updateNode = useStore((state) => state.updateNode);
    const [editing, setEditing] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const apply = useCallback((fn: (text: string, sel: TextSel) => { nextText: string; nextSelection: TextSel }) => {
        const el = textareaRef.current;
        if (!el) return;
        const { nextText, nextSelection } = fn(el.value, { start: el.selectionStart, end: el.selectionEnd });
        updateNode(nodeId, { content: nextText });
        requestAnimationFrame(() => {
            const t = textareaRef.current;
            if (!t) return;
            t.focus();
            t.setSelectionRange(nextSelection.start, nextSelection.end);
        });
    }, [nodeId, updateNode]);

    const keepTextFocus = (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter') {
            if (e.metaKey || e.ctrlKey) {
                e.preventDefault();
                const el = e.currentTarget;
                const start = el.selectionStart ?? 0;
                const end = el.selectionEnd ?? start;
                const a = Math.min(start, end);
                const b = Math.max(start, end);
                const nextText = `${el.value.slice(0, a)}\n${el.value.slice(b)}`;
                updateNode(nodeId, { content: nextText });
                requestAnimationFrame(() => {
                    const t = textareaRef.current;
                    if (!t) return;
                    t.focus();
                    t.setSelectionRange(a + 1, a + 1);
                });
                return;
            }
            e.preventDefault();
            e.currentTarget.blur(); // finish editing
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.currentTarget.blur();
            return;
        }

        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            apply((t, s) => wrapSelection(t, s, '**'));
            return;
        }
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
            e.preventDefault();
            apply((t, s) => wrapSelection(t, s, '_'));
        }
    };

    const handleBlur = () => {
        requestAnimationFrame(() => {
            const root = rootRef.current;
            if (!root) {
                setEditing(false);
                return;
            }
            if (root.contains(document.activeElement)) return;
            setEditing(false);
        });
    };

    return (
        <div ref={rootRef} className={styles.editorRoot} data-interactive="true" onPointerDown={(e) => e.stopPropagation()}>
            {!editing ? (
                <div
                    className={styles.editorPreview}
                    data-interactive="true"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                        setEditing(true);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                >
                    {value.trim().length === 0 ? (
                        <div className={styles.editorPlaceholder}>Double click to edit…</div>
                    ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
                    )}
                </div>
            ) : (
                <>
                <div className={styles.editorToolbar} data-interactive="true">
                <button
                    type="button"
                    className={styles.editorButton}
                    title="Bold (Ctrl/Cmd+B)"
                    onPointerDown={keepTextFocus}
                    onClick={() => apply((t, s) => wrapSelection(t, s, '**'))}
                >
                    <Bold size={16} />
                </button>
                <button
                    type="button"
                    className={styles.editorButton}
                    title="Italic (Ctrl/Cmd+I)"
                    onPointerDown={keepTextFocus}
                    onClick={() => apply((t, s) => wrapSelection(t, s, '_'))}
                >
                    <Italic size={16} />
                </button>
                <button
                    type="button"
                    className={styles.editorButton}
                    title="Strikethrough"
                    onPointerDown={keepTextFocus}
                    onClick={() => apply((t, s) => wrapSelection(t, s, '~~'))}
                >
                    <Strikethrough size={16} />
                </button>
                <button
                    type="button"
                    className={styles.editorButton}
                    title="Inline code"
                    onPointerDown={keepTextFocus}
                    onClick={() => apply((t, s) => wrapSelection(t, s, '`'))}
                >
                    <Code size={16} />
                </button>

                <div className={styles.editorDivider} />

                <button
                    type="button"
                    className={styles.editorButton}
                    title="Bullet list"
                    onPointerDown={keepTextFocus}
                    onClick={() => apply((t, s) => prefixLines(t, s, '- '))}
                >
                    <List size={16} />
                </button>
                <button
                    type="button"
                    className={styles.editorButton}
                    title="Numbered list"
                    onPointerDown={keepTextFocus}
                    onClick={() => apply((t, s) => numberLines(t, s, 1))}
                >
                    <ListOrdered size={16} />
                </button>
                <button
                    type="button"
                    className={styles.editorButton}
                    title="Quote"
                    onPointerDown={keepTextFocus}
                    onClick={() => apply((t, s) => prefixLines(t, s, '> '))}
                >
                    <Quote size={16} />
                </button>

            </div>
                <textarea
                    ref={textareaRef}
                    className={styles.noteContentInput}
                    value={value}
                    onChange={(e) => updateNode(nodeId, { content: e.target.value })}
                    onBlur={handleBlur}
                    onKeyDown={handleKeyDown}
                    onPointerDown={(e) => e.stopPropagation()}
                    placeholder="Double click to edit…"
                />
                </>
            )}
        </div>
    );
};

const CardView: React.FC<{ data: NodeData }> = ({ data }) => {
    const updateNode = useStore((state) => state.updateNode);
    const [showEnergySelector, setShowEnergySelector] = React.useState(false);

    // Missing state restored
    const [isEditing, setIsEditing] = React.useState(false);

    const effectiveEnergy = useStore((state) => state.effectiveEnergy[data.id] ?? data.energy);
    const baseEnergy = clampEnergy(Number.isFinite(data.energy) ? data.energy : 50);
    const energyColor = energyToColor(effectiveEnergy);
    const incomingEnergy = useStore((state) => {
        let incoming = 0;
        for (const e of state.edges) {
            if (e.target !== data.id) continue;
            incoming += Math.max(0, state.effectiveEnergy[e.source] ?? 0);
        }
        return incoming;
    });
    const maxBaseEnergy = Math.max(0, 100 - incomingEnergy);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            setIsEditing(false);
        }
    };

    // Close selector when clicking outside
    React.useEffect(() => {
        if (showEnergySelector) {
            const handleClick = () => setShowEnergySelector(false);
            window.addEventListener('click', handleClick);
            return () => window.removeEventListener('click', handleClick);
        }
    }, [showEnergySelector]);

    const isTask = data.type === 'task';

    return (
        <div className={isTask ? styles.taskNode : styles.cardNode}>
            {/* Header / Title Area */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
                {isEditing ? (
                    <input
                        className={styles.cardHeaderInput}
                        value={data.title}
                        onChange={(e) => updateNode(data.id, { title: e.target.value })}
                        onBlur={() => setIsEditing(false)}
                        onKeyDown={handleKeyDown}
                        autoFocus
                        onPointerDown={(e) => e.stopPropagation()}
                        style={{ flex: 1, marginRight: 8 }}
                    />
                ) : (
                    <div
                        className={styles.cardHeader}
                        onDoubleClick={() => setIsEditing(true)}
                        data-interactive="true"
                        onPointerDown={(e) => e.stopPropagation()}
                        style={{ flex: 1, marginRight: 8 }}
                    >
                        {data.title}
                    </div>
                )}

                {/* Interactive Energy Indicator */}
                <div style={{ position: 'relative' }}>
                    <div
                        className={styles.energyIndicatorInteract}
                        title={`Energy: ${Math.round(baseEnergy)} / ${Math.round(effectiveEnergy)}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            setShowEnergySelector(!showEnergySelector);
                        }}
                        data-interactive="true"
                        onPointerDown={(e) => e.stopPropagation()}
                        style={{
                            backgroundColor: energyColor,
                            boxShadow: `0 0 8px ${energyColor}, 0 0 16px ${energyColor}`,
                        }}
                    />

                    {showEnergySelector && (
                        <div className={styles.energySelector} data-interactive="true" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                            <div className={styles.energyMiniValuesRow}>
                                <span className={styles.energyMiniValue} title="Собственная энергия" style={{ color: energyColor }}>
                                    {Math.round(baseEnergy)}
                                </span>
                                <span className={styles.energyMiniDividerLine} aria-hidden="true" />
                                <span className={styles.energyMiniValue} title="Суммарная энергия">
                                    {Math.round(effectiveEnergy)}
                                </span>
                            </div>
                            <div
                                className={styles.energyLiquidGauge}
                                onPointerDown={(e) => {
                                    e.preventDefault();
                                    const el = e.currentTarget;
                                    const rect = el.getBoundingClientRect();
                                    const t = (rect.bottom - e.clientY) / rect.height;
                                    updateNode(data.id, { energy: clampEnergy(t * maxBaseEnergy) });

                                    const onMove = (ev: PointerEvent) => {
                                        const tt = (rect.bottom - ev.clientY) / rect.height;
                                        updateNode(data.id, { energy: clampEnergy(tt * maxBaseEnergy) });
                                    };
                                    const onUp = () => {
                                        window.removeEventListener('pointermove', onMove);
                                        window.removeEventListener('pointerup', onUp);
                                        window.removeEventListener('pointercancel', onUp);
                                    };
                                    window.addEventListener('pointermove', onMove);
                                    window.addEventListener('pointerup', onUp, { once: true });
                                    window.addEventListener('pointercancel', onUp, { once: true });
                                }}
                                role="slider"
                                aria-label="Energy"
                                aria-valuemin={0}
                                aria-valuemax={Math.round(maxBaseEnergy)}
                                aria-valuenow={Math.round(baseEnergy)}
                            >
                                <EnergySvgLiquidGauge level={baseEnergy} />
                                {Math.abs(effectiveEnergy - baseEnergy) >= 0.5 && (
                                    <div
                                        className={styles.energyLiquidGaugeMarker}
                                        style={{ bottom: `${clampEnergy(effectiveEnergy)}%` }}
                                        aria-hidden="true"
                                    />
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <div className={styles.cardMeta}>
                <span className={styles.type}>{data.type}</span>
                {/* Old energy tag removed from here */}
            </div>

            {isTask && (data.startDate || data.endDate) && (
                <div className={styles.dateRow}>
                    {data.startDate && (
                        <div className={styles.dateTag} title="Start Date">
                            <span>S:</span> {data.startDate}
                        </div>
                    )}
                    {data.endDate && (
                        <div className={styles.dateTag} title="End Date">
                            <span>E:</span> {data.endDate}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const NoteView: React.FC<{ data: NodeData }> = ({ data }) => {
    const updateNode = useStore((state) => state.updateNode);
    // NoteView is explicitly for "Dive in", so maybe we allow direct editing?
    // User requested "Double click for renaming".
    // Let's keep NoteView title as double-click, but Content as direct?
    // Usually NoteView implies "I am editing". Let's assume standard behavior for now but updated title interaction.
    // Actually, usually NoteView is "Open Mode". Let's keep it editable or make it consistent.
    // Let's apply double-click rule to Title for consistency. Content should be always editable if in NoteView.

    const [isEditingTitle, setIsEditingTitle] = React.useState(false);
    const [showEnergyPanel, setShowEnergyPanel] = React.useState(false);
    const effectiveEnergy = useStore((state) => state.effectiveEnergy[data.id] ?? data.energy);
    const baseEnergy = clampEnergy(Number.isFinite(data.energy) ? data.energy : 50);
    const energyColor = energyToColor(effectiveEnergy);
    const incomingEnergy = useStore((state) => {
        let incoming = 0;
        for (const e of state.edges) {
            if (e.target !== data.id) continue;
            incoming += Math.max(0, state.effectiveEnergy[e.source] ?? 0);
        }
        return incoming;
    });
    const maxBaseEnergy = Math.max(0, 100 - incomingEnergy);

    React.useEffect(() => {
        if (!showEnergyPanel) return;
        const onClick = () => {
            setShowEnergyPanel(false);
        };
        window.addEventListener('click', onClick);
        return () => window.removeEventListener('click', onClick);
    }, [showEnergyPanel]);

    const setBaseEnergyFromClientY = (clientY: number, el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const t = (rect.bottom - clientY) / rect.height; // bottom=0, top=1
        const next = clampEnergy(t * maxBaseEnergy);
        updateNode(data.id, { energy: next });
    };

    const handleEnergyScalePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const el = e.currentTarget;
        setBaseEnergyFromClientY(e.clientY, el);
        const onMove = (ev: PointerEvent) => setBaseEnergyFromClientY(ev.clientY, el);
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
        window.addEventListener('pointercancel', onUp, { once: true });
    };

    return (
        <div className={styles.noteDetailWrap} data-interactive="true" onPointerDown={(e) => e.stopPropagation()}>
            <div className={styles.noteNode}>
                <div className={styles.noteHeaderRow}>
                    <div className={styles.noteTitleWrap}>
                        {isEditingTitle ? (
                            <input
                                className={styles.noteTitleInput}
                                value={data.title}
                                onChange={(e) => updateNode(data.id, { title: e.target.value })}
                                onBlur={() => setIsEditingTitle(false)}
                                onKeyDown={(e) => e.key === 'Enter' && setIsEditingTitle(false)}
                                autoFocus
                                onPointerDown={(e) => e.stopPropagation()}
                                data-interactive="true"
                            />
                        ) : (
                            <div
                                className={styles.noteTitle}
                                onDoubleClick={() => setIsEditingTitle(true)}
                                data-interactive="true"
                                onPointerDown={(e) => e.stopPropagation()}
                            >
                                {data.title}
                            </div>
                        )}
                    </div>

                    <div className={styles.noteHeaderActions} onPointerDown={(e) => e.stopPropagation()}>
                        <div className={`${styles.typeSwitcher} ${styles.noteTypeSwitcherCompact}`}>
                            <div
                                className={`${styles.typeOption} ${data.type === 'idea' ? styles.activeIdea : ''}`}
                                onClick={() => updateNode(data.id, { type: 'idea' })}
                            >
                                Idea
                            </div>
                            <div
                                className={`${styles.typeOption} ${data.type === 'task' ? styles.activeTask : ''}`}
                                onClick={() => updateNode(data.id, { type: 'task' })}
                            >
                                Task
                            </div>
                        </div>

                        <div style={{ position: 'relative' }}>
                            <div
                                className={styles.energyIndicatorInteract}
                                title={`Energy: ${Math.round(baseEnergy)} / ${Math.round(effectiveEnergy)}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setShowEnergyPanel((v) => !v);
                                }}
                                data-interactive="true"
                                onPointerDown={(e) => e.stopPropagation()}
                                style={{
                                    backgroundColor: energyColor,
                                    boxShadow: `0 0 8px ${energyColor}, 0 0 16px ${energyColor}`,
                                    transform: showEnergyPanel ? 'scale(1.6)' : undefined,
                                }}
                            />
                        </div>
                    </div>
                </div>

                <div className={styles.noteStack}>
                {/* Date Pickers (Only for Task) */}
                {data.type === 'task' && (
                    <div style={{ display: 'flex', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4, paddingLeft: 2 }}>START</div>
                            <input
                                type="date"
                                className={styles.customDateInput}
                                value={data.startDate || ''}
                                onChange={(e) => updateNode(data.id, { startDate: e.target.value })}
                                onPointerDown={(e) => e.stopPropagation()}
                            />
                        </div>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4, paddingLeft: 2 }}>DUE</div>
                            <input
                                type="date"
                                className={styles.customDateInput}
                                value={data.endDate || ''}
                                onChange={(e) => updateNode(data.id, { endDate: e.target.value })}
                                onPointerDown={(e) => e.stopPropagation()}
                            />
                        </div>
                    </div>
                )}

                <NoteContentEditor nodeId={data.id} value={data.content} />
                </div>
            </div>

            {showEnergyPanel && (
                <div
                    className={styles.noteEnergySide}
                    data-interactive="true"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className={styles.noteEnergyValuesRow}>
                        <span className={styles.noteEnergyValue} title="Собственная энергия" style={{ color: energyColor }}>
                            {Math.round(baseEnergy)}
                        </span>
                        <span className={styles.noteEnergyDividerLine} aria-hidden="true" />
                        <span className={styles.noteEnergyValue} title="Суммарная энергия">
                            {Math.round(effectiveEnergy)}
                        </span>
                    </div>

                    <div
                        className={styles.noteEnergyScale}
                        onPointerDown={handleEnergyScalePointerDown}
                        role="slider"
                        aria-label="Energy"
                        aria-valuemin={0}
                        aria-valuemax={Math.round(maxBaseEnergy)}
                        aria-valuenow={Math.round(baseEnergy)}
                    >
                        <EnergySvgLiquidGauge level={baseEnergy} className={styles.noteEnergyFluidCanvas} />
                        {Math.abs(effectiveEnergy - baseEnergy) >= 0.5 && (
                            <div className={styles.noteEnergyScaleMarker} style={{ bottom: `${effectiveEnergy}%` }} aria-hidden="true" />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

interface NodeProps {
    data: NodeData;
}

export const Node: React.FC<NodeProps> = ({ data }) => {
    const { canvas } = useStore();
    const scale = canvas.scale;

    // Localized Semantic Zoom Logic
    // Only "Open" (NoteView) if:
    // 1. Scale is high enough (> 1.1)
    // 2. Node is close to center (e.g. within 400px radius in world space, roughly)

    const dist = getDistToCenter(data.x, data.y, canvas);
    const isFocusedInViewport = dist < 250;

    // Determine Active View
    let activeView: 'graph' | 'card' | 'note' = 'card';

    // Increased threshold to 0.6 for earlier graph view
    if (scale < 0.6) {
        activeView = 'graph';
    } else if (scale > 1.1 && isFocusedInViewport) {
        activeView = 'note';
    } else {
        activeView = 'card';
    }

    // Determine visibility classes
    const isGraph = activeView === 'graph';
    // If note view is active, we treat card view as hidden, or maybe we don't render note view separately 
    // but just use CardView <-> NoteView transition? 
    // For now, let's just smooth Graph <-> Card.
    const isCard = activeView === 'card';
    const isNote = activeView === 'note';

    // To allow smooth transition, we render both Graph and Card when switching?
    // Or simpler: Always render Graph and Card, toggle opacity.
    // NoteView is heavy, maybe conditional? Or just treat as 'Card' slot?

    // Logic:
    // Graph is visible if isGraph.
    // Card is visible if isCard OR isNote (if Note replaces Card).
    // Actually Note is separate. 
    // Let's render Graph and "Card/Note Content".

    // Simpler:
    // 1. Graph Container
    // 2. Card Container (which might contain Note if we merged them, but they are separate components).
    // Let's keep distinct containers.

    const graphClass = `${styles.viewContainer} ${isGraph ? styles.visible : styles.hidden}`;
    const cardClass = `${styles.viewContainer} ${isCard ? styles.visible : styles.hidden}`;
    const noteClass = `${styles.viewContainer} ${isNote ? styles.visible : styles.hidden}`;

    // Valid Wrapper Class Logic
    const neighbors = useStore((state) => state.neighbors);
    const selectedNode = useStore((state) => state.selectedNode);
    const selectedNodes = useStore((state) => state.selectedNodes);
    const connectionTargetId = useStore((state) => state.connectionTargetId);

    const isSelected = selectedNode === data.id || selectedNodes.includes(data.id);
    const neighborDist = neighbors[data.id];
    const isTarget = connectionTargetId === data.id;

    let wrapperClass = `${styles.nodeWrapper} ${isTarget ? styles.targetGlow : ''}`;

    const hasAnySelection = !!selectedNode || selectedNodes.length > 0;
    if (isSelected) {
        wrapperClass += ` ${styles.highlightLevel0}`;
    } else if (neighborDist === 1) {
        wrapperClass += ` ${styles.highlightLevel1}`;
    } else if (neighborDist === 2) {
        wrapperClass += ` ${styles.highlightLevel2}`;
    } else if (hasAnySelection) {
        wrapperClass += ` ${styles.backgroundNoise}`;
    }

    return (
        <div
            className={wrapperClass}
            style={{
                left: data.x,
                top: data.y,
            }}
            data-node-bounds="true"
            data-node-id={data.id}
        >
            {/* Graph View */}
            <div className={graphClass}>
                <GraphView data={data} />
            </div>

            {/* Card View */}
            <div className={cardClass}>
                <CardView data={data} />
            </div>

            {/* Note View */}
            <div className={noteClass}>
                <NoteView data={data} />
            </div>
        </div>
    );
};
