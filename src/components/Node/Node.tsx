import React, { useCallback, useRef, useState } from 'react';
import { Bold, Italic, Strikethrough, Code, List, ListOrdered, Quote, Paperclip, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../store/useStore';
import type { Attachment, NodeData } from '../../types';
import styles from './Node.module.css';
import { numberLines, prefixLines, wrapSelection } from '../../utils/textEditing';
import { clampEnergy, energyToColor } from '../../utils/energy';
import { EnergySvgLiquidGauge } from './EnergySvgLiquidGauge';
import { filesToAttachments, formatBytes, MAX_ATTACHMENT_BYTES } from '../../utils/attachments';

// View Components
const GraphView: React.FC<{ data: NodeData; energyColor: string; fillRatio: number }> = ({ data, energyColor, fillRatio }) => (
    <div
        className={`${styles.graphNode} ${data.type === 'task' ? styles.task : ''}`}
        style={{
            '--graph-energy-color': energyColor,
            '--graph-fill': String(Math.max(0, Math.min(1, fillRatio))),
        } as React.CSSProperties}
    />
);

// Helper to get delta to center
const getDeltaToCenter = (x: number, y: number, canvas: { x: number, y: number, scale: number }) => {
    // Use the stable app viewport when the mobile keyboard shifts the visual viewport.
    const viewport = (window as any).__livingCanvasViewport;
    const screenW = Number.isFinite(viewport?.appWidth) ? viewport.appWidth : window.innerWidth;
    const screenH = Number.isFinite(viewport?.appHeight) ? viewport.appHeight : window.innerHeight;

    // Current Viewport Center in Screen Coords
    const screenCX = screenW / 2;
    const screenCY = screenH / 2;

    // Convert to World Coords
    const worldCX = (screenCX - canvas.x) / canvas.scale;
    const worldCY = (screenCY - canvas.y) / canvas.scale;

    return { dx: x - worldCX, dy: y - worldCY };
};

type TextSel = { start: number; end: number };
const clampProgress = (value: number) => Math.min(100, Math.max(0, value));
const statusFromProgress = (progress: number) => {
    if (progress >= 100) return 'done';
    if (progress <= 0) return 'queued';
    return 'in_progress';
};


type MarkdownEditorProps = {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    alwaysEditing?: boolean;
    exitOnEnter?: boolean;
    submitLabel?: string;
    onSubmit?: () => void;
    onEditingChange?: (editing: boolean) => void;
    attachments?: Attachment[];
    onAddAttachments?: (attachments: Attachment[]) => void;
    onRemoveAttachment?: (id: string) => void;
};

const AttachmentList: React.FC<{
    attachments: Attachment[];
    compact?: boolean;
    onRemoveAttachment?: (id: string) => void;
}> = ({ attachments, compact, onRemoveAttachment }) => {
    if (!attachments.length) return null;
    return (
        <div className={`${styles.attachmentList}${compact ? ` ${styles.attachmentListCompact}` : ''}`}>
            {attachments.map((attachment) => (
                <div key={attachment.id} className={styles.attachmentItem}>
                    <a href={attachment.dataUrl} download={attachment.name} className={styles.attachmentFile}>
                        <span className={styles.attachmentPreview}>
                            {attachment.kind === 'image' ? (
                                <img
                                    src={attachment.dataUrl}
                                    alt={attachment.name}
                                    className={styles.attachmentPreviewImg}
                                />
                            ) : (
                                <span className={styles.attachmentPreviewText}>
                                    {attachment.name?.split('.').pop()?.slice(0, 4)?.toUpperCase() || 'FILE'}
                                </span>
                            )}
                        </span>
                        <span className={styles.attachmentInfo}>
                            <span className={styles.attachmentName}>{attachment.name}</span>
                            <span className={styles.attachmentMeta}>{formatBytes(attachment.size)}</span>
                        </span>
                    </a>
                    {onRemoveAttachment && (
                        <button
                            type="button"
                            className={styles.attachmentRemove}
                            onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            }}
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onRemoveAttachment(attachment.id);
                            }}
                        >
                            <Trash2 size={14} />
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
};

const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
    value,
    onChange,
    placeholder,
    alwaysEditing = false,
    exitOnEnter = false,
    submitLabel,
    onSubmit,
    onEditingChange,
    attachments,
    onAddAttachments,
    onRemoveAttachment,
}) => {
    const [editing, setEditing] = useState(alwaysEditing);
    const [attachNotice, setAttachNotice] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    React.useEffect(() => {
        if (alwaysEditing) setEditing(true);
    }, [alwaysEditing]);

    React.useEffect(() => {
        onEditingChange?.(editing);
    }, [editing, onEditingChange]);

    React.useEffect(() => {
        if (!attachNotice) return;
        const t = window.setTimeout(() => setAttachNotice(null), 2000);
        return () => window.clearTimeout(t);
    }, [attachNotice]);

    const apply = useCallback((fn: (text: string, sel: TextSel) => { nextText: string; nextSelection: TextSel }) => {
        const el = textareaRef.current;
        if (!el) return;
        const { nextText, nextSelection } = fn(el.value, { start: el.selectionStart, end: el.selectionEnd });
        onChange(nextText);
        requestAnimationFrame(() => {
            const t = textareaRef.current;
            if (!t) return;
            t.focus();
            t.setSelectionRange(nextSelection.start, nextSelection.end);
        });
    }, [onChange]);

    const keepTextFocus = (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter') {
            if ((e.metaKey || e.ctrlKey) && onSubmit) {
                e.preventDefault();
                onSubmit();
                return;
            }
            if (exitOnEnter && !(e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.currentTarget.blur();
                return;
            }
            if (e.metaKey || e.ctrlKey) {
                e.preventDefault();
                const el = e.currentTarget;
                const start = el.selectionStart ?? 0;
                const end = el.selectionEnd ?? start;
                const a = Math.min(start, end);
                const b = Math.max(start, end);
                const nextText = `${el.value.slice(0, a)}\n${el.value.slice(b)}`;
                onChange(nextText);
                requestAnimationFrame(() => {
                    const t = textareaRef.current;
                    if (!t) return;
                    t.focus();
                    t.setSelectionRange(a + 1, a + 1);
                });
                return;
            }
        }
        if (e.key === 'Escape' && !alwaysEditing) {
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
            return;
        }
    };

    const handleBlur = () => {
        if (alwaysEditing) return;
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

    const handleAttachments = async (files: FileList | null) => {
        if (!files || files.length === 0 || !onAddAttachments) return;
        // Attachments are stored as data URLs so they stay in sync across collaborators.
        const { attachments: incoming, rejected } = await filesToAttachments(Array.from(files));
        if (incoming.length) onAddAttachments(incoming);
        if (rejected.length) {
            setAttachNotice(`Max file size is ${formatBytes(MAX_ATTACHMENT_BYTES)}`);
        }
    };

    const showPreview = !editing && !alwaysEditing;
    const resolvedPlaceholder = placeholder ?? 'Double click to edit…';

    return (
        <div ref={rootRef} className={styles.editorRoot} data-interactive="true" onPointerDown={(e) => e.stopPropagation()}>
            {showPreview ? (
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
                        <div className={styles.editorPlaceholder}>{resolvedPlaceholder}</div>
                    ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
                    )}
                    <AttachmentList attachments={attachments ?? []} compact />
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
                        {onAddAttachments && (
                            <>
                                <div className={styles.editorDivider} />
                                <button
                                    type="button"
                                    className={styles.editorButton}
                                    title="Attach file"
                                    onPointerDown={keepTextFocus}
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <Paperclip size={16} />
                                </button>
                            </>
                        )}
                    </div>
                    <textarea
                        ref={textareaRef}
                        className={styles.noteContentInput}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        onBlur={handleBlur}
                        onKeyDown={handleKeyDown}
                        onPointerDown={(e) => e.stopPropagation()}
                        placeholder={resolvedPlaceholder}
                    />
                    <AttachmentList
                        attachments={attachments ?? []}
                        onRemoveAttachment={onRemoveAttachment}
                    />
                    {attachNotice && (
                        <div className={styles.editorNotice}>{attachNotice}</div>
                    )}
                    {onSubmit && submitLabel && (
                        <div className={styles.editorSubmitRow}>
                            <button
                                type="button"
                                className={styles.editorSubmitButton}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={onSubmit}
                            >
                                {submitLabel}
                            </button>
                        </div>
                    )}
                    {onAddAttachments && (
                        <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            className={styles.editorAttachmentInput}
                            onChange={(e) => {
                                handleAttachments(e.target.files);
                                e.currentTarget.value = '';
                            }}
                        />
                    )}
                </>
            )}
        </div>
    );
};

const NoteContentEditor: React.FC<{
    nodeId: string;
    value: string;
    attachments: Attachment[];
}> = ({ nodeId, value, attachments }) => {
    const updateNode = useStore((state) => state.updateNode);
    const historyPushedRef = useRef(false);

    const ensureHistory = useCallback(() => {
        if (historyPushedRef.current) return;
        useStore.getState().pushHistory();
        historyPushedRef.current = true;
    }, []);

    const handleEditingChange = (editing: boolean) => {
        if (!editing) historyPushedRef.current = false;
    };

    const updateContent = (next: string) => {
        ensureHistory();
        updateNode(nodeId, { content: next });
    };

    const addAttachments = (incoming: Attachment[]) => {
        if (!incoming.length) return;
        ensureHistory();
        updateNode(nodeId, { attachments: [...attachments, ...incoming] });
    };

    const removeAttachment = (id: string) => {
        ensureHistory();
        updateNode(nodeId, { attachments: attachments.filter((item) => item.id !== id) });
    };

    return (
        <MarkdownEditor
            value={value}
            onChange={updateContent}
            placeholder="Double click to edit…"
            exitOnEnter
            onEditingChange={handleEditingChange}
            attachments={attachments}
            onAddAttachments={addAttachments}
            onRemoveAttachment={removeAttachment}
        />
    );
};

const CardView = React.memo(({ data }: { data: NodeData }) => {
    const updateNode = useStore((state) => state.updateNode);
    const [showEnergySelector, setShowEnergySelector] = React.useState(false);
    const monitoringMode = useStore((state) => state.monitoringMode);
    const [energyInputOpen, setEnergyInputOpen] = React.useState(false);
    const [energyInputValue, setEnergyInputValue] = React.useState('');
    const [energyToast, setEnergyToast] = React.useState<string | null>(null);
    const [energyToastVisible, setEnergyToastVisible] = React.useState(false);
    const energyInputRef = React.useRef<HTMLInputElement | null>(null);

    // Missing state restored
    const [isEditing, setIsEditing] = React.useState(false);
    const titleTouchRef = React.useRef<{ id: number; x: number; y: number } | null>(null);
    const titleHistoryRef = React.useRef(false);

    React.useEffect(() => {
        if (!isEditing) titleHistoryRef.current = false;
    }, [isEditing]);

    const ensureTitleHistory = () => {
        if (titleHistoryRef.current) return;
        useStore.getState().pushHistory();
        titleHistoryRef.current = true;
    };

    const effectiveEnergy = useStore((state) => state.effectiveEnergy[data.id] ?? data.energy);
    const baseEnergy = clampEnergy(Number.isFinite(data.energy) ? data.energy : 50);
    const energyColor = energyToColor(effectiveEnergy);
    const incomingEnergy = useStore((state) => {
        let incoming = 0;
        for (const e of state.edges) {
            if (e.target !== data.id) continue;
            if (e.energyEnabled === false) continue;
            incoming += Math.max(0, state.effectiveEnergy[e.source] ?? 0);
        }
        return incoming;
    });
    const maxBaseEnergy = Math.max(0, 100 - incomingEnergy);
    const maxAllowedBaseEnergy = Math.max(0, Math.min(100, Math.floor(maxBaseEnergy + 1e-6)));

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

    // Keep numeric input and toast state scoped to the energy popover.
    React.useEffect(() => {
        if (!showEnergySelector) {
            setEnergyInputOpen(false);
            setEnergyInputValue(String(Math.round(baseEnergy)));
        }
    }, [showEnergySelector, baseEnergy]);

    // Mirror toast behavior used elsewhere: fade out, then clear.
    React.useEffect(() => {
        if (!energyToast) return;
        setEnergyToastVisible(true);
        const hide = window.setTimeout(() => setEnergyToastVisible(false), 1200);
        const clear = window.setTimeout(() => setEnergyToast(null), 1700);
        return () => {
            window.clearTimeout(hide);
            window.clearTimeout(clear);
        };
    }, [energyToast]);

    // Sync input text with current energy and focus when opened.
    React.useEffect(() => {
        if (!energyInputOpen) {
            setEnergyInputValue(String(Math.round(baseEnergy)));
            return;
        }
        requestAnimationFrame(() => {
            const el = energyInputRef.current;
            if (!el) return;
            el.focus();
            el.select();
        });
    }, [energyInputOpen, baseEnergy]);

    const showEnergyWarning = (message: string) => {
        setEnergyToast(message);
    };

    const commitEnergyInput = (opts: { closeOnError: boolean }) => {
        const raw = energyInputValue.trim();
        if (!raw) {
            showEnergyWarning('Введите целое число от 0 до 100');
            if (opts.closeOnError) setEnergyInputOpen(false);
            return;
        }
        if (!/^-?\d+$/.test(raw)) {
            showEnergyWarning('Введите целое число от 0 до 100');
            if (opts.closeOnError) setEnergyInputOpen(false);
            return;
        }
        const next = Number(raw);
        if (!Number.isFinite(next)) {
            showEnergyWarning('Введите целое число от 0 до 100');
            if (opts.closeOnError) setEnergyInputOpen(false);
            return;
        }
        // If user kept the current displayed value, just close without mutating.
        if (next === Math.round(baseEnergy)) {
            setEnergyInputOpen(false);
            return;
        }
        if (next < 0 || next > 100) {
            showEnergyWarning('Допустимый диапазон: 0–100');
            if (opts.closeOnError) setEnergyInputOpen(false);
            return;
        }
        if (next > maxAllowedBaseEnergy) {
            showEnergyWarning(`Максимум ${maxAllowedBaseEnergy}, иначе суммарная энергия > 100`);
            if (opts.closeOnError) setEnergyInputOpen(false);
            return;
        }

        useStore.getState().pushHistory();
        updateNode(data.id, { energy: next });
        setEnergyInputOpen(false);
    };

    const isTask = data.type === 'task';
    const progress = clampProgress(typeof data.progress === 'number' && Number.isFinite(data.progress) ? data.progress : 0);
    const status = statusFromProgress(progress);
    const statusLetter = status === 'done' ? 'D' : status === 'in_progress' ? 'P' : 'Q';
    const shouldPulse = monitoringMode && isTask && status === 'in_progress';
    const cardClassName = `${isTask ? styles.taskNode : styles.cardNode}${shouldPulse ? ` ${styles.monitorPulse}` : ''}${isTask ? ` ${styles.cardProgressRing}` : ''}`;
    const cardStyle = isTask ? ({ '--card-progress': progress, '--progress-color': energyColor } as React.CSSProperties) : undefined;

    return (
        <div className={cardClassName} style={cardStyle}>
            {/* Header / Title Area */}
            <div className={styles.cardHeaderRow}>
                <div className={styles.cardTitleWrap}>
                    {isTask && (
                        <div
                            className={styles.statusBadge}
                            title={status === 'done' ? 'Done' : status === 'in_progress' ? 'In Progress' : 'Queued'}
                            style={{
                                borderColor: energyColor,
                                color: energyColor,
                                boxShadow: `0 0 6px ${energyColor}`,
                            }}
                        >
                            <span className={styles.statusBadgeText}>{statusLetter}</span>
                        </div>
                    )}
                    {isEditing ? (
                        <input
                            className={styles.cardHeaderInput}
                            value={data.title}
                            onChange={(e) => {
                                ensureTitleHistory();
                                updateNode(data.id, { title: e.target.value });
                            }}
                            onBlur={() => setIsEditing(false)}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            onPointerDown={(e) => e.stopPropagation()}
                        />
                    ) : (
                        <div
                            className={styles.cardHeader}
                            onDoubleClick={() => setIsEditing(true)}
                            data-interactive="true"
                            onPointerDown={(e) => {
                                e.stopPropagation();
                                if (e.pointerType === 'touch') {
                                    titleTouchRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
                                }
                            }}
                            onPointerUp={(e) => {
                                if (e.pointerType !== 'touch') return;
                                const ref = titleTouchRef.current;
                                if (!ref || ref.id !== e.pointerId) return;
                                const dist = Math.hypot(e.clientX - ref.x, e.clientY - ref.y);
                                titleTouchRef.current = null;
                                if (dist < 8) setIsEditing(true);
                            }}
                            onPointerCancel={() => {
                                titleTouchRef.current = null;
                            }}
                        >
                            {data.title}
                        </div>
                    )}
                </div>

                <div className={styles.cardHeaderActions}>
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
                                    {energyInputOpen ? (
                                        <input
                                            ref={energyInputRef}
                                            className={`${styles.energyMiniValue} ${styles.energyMiniInput}`}
                                            value={energyInputValue}
                                            inputMode="numeric"
                                            aria-label="Собственная энергия"
                                            onChange={(e) => setEnergyInputValue(e.target.value)}
                                            onPointerDown={(e) => e.stopPropagation()}
                                            onClick={(e) => e.stopPropagation()}
                                            onBlur={() => commitEnergyInput({ closeOnError: true })}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    commitEnergyInput({ closeOnError: false });
                                                } else if (e.key === 'Escape') {
                                                    e.preventDefault();
                                                    setEnergyInputOpen(false);
                                                }
                                            }}
                                        />
                                    ) : (
                                        <span
                                            className={`${styles.energyMiniValue} ${styles.energyMiniValueEditable}`}
                                            title="Собственная энергия"
                                            style={{ color: energyColor }}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setEnergyInputOpen(true);
                                            }}
                                            onPointerDown={(e) => e.stopPropagation()}
                                        >
                                            {Math.round(baseEnergy)}
                                        </span>
                                    )}
                                    <span className={styles.energyMiniDividerLine} aria-hidden="true" />
                                    <span className={styles.energyMiniValue} title="Суммарная энергия">
                                        {Math.round(effectiveEnergy)}
                                    </span>
                                </div>
                                {energyToast && (
                                    <div
                                        className={`${styles.energyToast} ${energyToastVisible ? styles.energyToastVisible : ''}`}
                                        aria-live="polite"
                                    >
                                        {energyToast}
                                    </div>
                                )}
                                <div
                                    className={styles.energyLiquidGauge}
                                    onPointerDown={(e) => {
                                        e.preventDefault();
                                        useStore.getState().pushHistory();
                                        const el = e.currentTarget;
                                        const pointerId = e.pointerId;
                                        const rect = el.getBoundingClientRect();
                                        const t = (rect.bottom - e.clientY) / rect.height;
                                        updateNode(data.id, { energy: clampEnergy(t * maxBaseEnergy) });

                                        // Track only the initiating pointer to avoid multi-touch interference.
                                        const onMove = (ev: PointerEvent) => {
                                            if (ev.pointerId !== pointerId) return;
                                            const tt = (rect.bottom - ev.clientY) / rect.height;
                                            updateNode(data.id, { energy: clampEnergy(tt * maxBaseEnergy) });
                                        };
                                        const cleanup = () => {
                                            window.removeEventListener('pointermove', onMove);
                                            window.removeEventListener('pointerup', onUp);
                                            window.removeEventListener('pointercancel', onUp);
                                        };
                                        const onUp = (ev: PointerEvent) => {
                                            if (ev.pointerId !== pointerId) return;
                                            cleanup();
                                        };
                                        window.addEventListener('pointermove', onMove);
                                        window.addEventListener('pointerup', onUp);
                                        window.addEventListener('pointercancel', onUp);
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
            </div>

            <div className={styles.cardMeta}>
                <span className={styles.type}>{data.type}</span>
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
        </div>
    );
});

const NoteView = React.memo(({ data }: { data: NodeData }) => {
    const updateNode = useStore((state) => state.updateNode);
    const monitoringMode = useStore((state) => state.monitoringMode);
    // NoteView is explicitly for "Dive in", so maybe we allow direct editing?
    // User requested "Double click for renaming".
    // Let's keep NoteView title as double-click, but Content as direct?
    // Usually NoteView implies "I am editing". Let's assume standard behavior for now but updated title interaction.
    // Actually, usually NoteView is "Open Mode". Let's keep it editable or make it consistent.
    // Let's apply double-click rule to Title for consistency. Content should be always editable if in NoteView.

    const [isEditingTitle, setIsEditingTitle] = React.useState(false);
    const titleTouchRef = useRef<{ id: number; x: number; y: number } | null>(null);
    const [isDraggingProgress, setIsDraggingProgress] = React.useState(false);
    const [showEnergyPanel, setShowEnergyPanel] = React.useState(false);
    const [energyInputOpen, setEnergyInputOpen] = React.useState(false);
    const [energyInputValue, setEnergyInputValue] = React.useState('');
    const [energyToast, setEnergyToast] = React.useState<string | null>(null);
    const [energyToastVisible, setEnergyToastVisible] = React.useState(false);
    const energyInputRef = React.useRef<HTMLInputElement | null>(null);
    const titleHistoryRef = React.useRef(false);

    React.useEffect(() => {
        if (!isEditingTitle) titleHistoryRef.current = false;
    }, [isEditingTitle]);

    const ensureTitleHistory = () => {
        if (titleHistoryRef.current) return;
        useStore.getState().pushHistory();
        titleHistoryRef.current = true;
    };
    const effectiveEnergy = useStore((state) => state.effectiveEnergy[data.id] ?? data.energy);
    const baseEnergy = clampEnergy(Number.isFinite(data.energy) ? data.energy : 50);
    const energyColor = energyToColor(effectiveEnergy);
    const incomingEnergy = useStore((state) => {
        let incoming = 0;
        for (const e of state.edges) {
            if (e.target !== data.id) continue;
            if (e.energyEnabled === false) continue;
            incoming += Math.max(0, state.effectiveEnergy[e.source] ?? 0);
        }
        return incoming;
    });
    const maxBaseEnergy = Math.max(0, 100 - incomingEnergy);
    const maxAllowedBaseEnergy = Math.max(0, Math.min(100, Math.floor(maxBaseEnergy + 1e-6)));
    const isTask = data.type === 'task';
    const progress = clampProgress(typeof data.progress === 'number' && Number.isFinite(data.progress) ? data.progress : 0);
    const status = statusFromProgress(progress);
    const shouldPulse = monitoringMode && isTask && status === 'in_progress';
    const nodeAttachments = Array.isArray(data.attachments) ? data.attachments : [];

    React.useEffect(() => {
        if (!showEnergyPanel) return;
        const onClick = () => {
            setShowEnergyPanel(false);
        };
        window.addEventListener('click', onClick);
        return () => window.removeEventListener('click', onClick);
    }, [showEnergyPanel]);

    // Keep numeric input scoped to the energy panel and sync to current value.
    React.useEffect(() => {
        if (!showEnergyPanel) {
            setEnergyInputOpen(false);
            setEnergyInputValue(String(Math.round(baseEnergy)));
        }
    }, [showEnergyPanel, baseEnergy]);

    // Fade-out warning toast (same timing as other in-app toasts).
    React.useEffect(() => {
        if (!energyToast) return;
        setEnergyToastVisible(true);
        const hide = window.setTimeout(() => setEnergyToastVisible(false), 1200);
        const clear = window.setTimeout(() => setEnergyToast(null), 1700);
        return () => {
            window.clearTimeout(hide);
            window.clearTimeout(clear);
        };
    }, [energyToast]);

    // Focus the numeric input on open so keyboard entry is immediate.
    React.useEffect(() => {
        if (!energyInputOpen) {
            setEnergyInputValue(String(Math.round(baseEnergy)));
            return;
        }
        requestAnimationFrame(() => {
            const el = energyInputRef.current;
            if (!el) return;
            el.focus();
            el.select();
        });
    }, [energyInputOpen, baseEnergy]);

    const showEnergyWarning = (message: string) => {
        setEnergyToast(message);
    };

    const commitEnergyInput = (opts: { closeOnError: boolean }) => {
        const raw = energyInputValue.trim();
        if (!raw) {
            showEnergyWarning('Введите целое число от 0 до 100');
            if (opts.closeOnError) setEnergyInputOpen(false);
            return;
        }
        if (!/^-?\d+$/.test(raw)) {
            showEnergyWarning('Введите целое число от 0 до 100');
            if (opts.closeOnError) setEnergyInputOpen(false);
            return;
        }
        const next = Number(raw);
        if (!Number.isFinite(next)) {
            showEnergyWarning('Введите целое число от 0 до 100');
            if (opts.closeOnError) setEnergyInputOpen(false);
            return;
        }
        // If the user re-entered the displayed value, close without changes.
        if (next === Math.round(baseEnergy)) {
            setEnergyInputOpen(false);
            return;
        }
        if (next < 0 || next > 100) {
            showEnergyWarning('Допустимый диапазон: 0–100');
            if (opts.closeOnError) setEnergyInputOpen(false);
            return;
        }
        if (next > maxAllowedBaseEnergy) {
            showEnergyWarning(`Максимум ${maxAllowedBaseEnergy}, иначе суммарная энергия > 100`);
            if (opts.closeOnError) setEnergyInputOpen(false);
            return;
        }

        useStore.getState().pushHistory();
        updateNode(data.id, { energy: next });
        setEnergyInputOpen(false);
    };

    const setBaseEnergyFromClientY = (clientY: number, el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const t = (rect.bottom - clientY) / rect.height; // bottom=0, top=1
        const next = clampEnergy(t * maxBaseEnergy);
        updateNode(data.id, { energy: next });
    };

    const handleEnergyScalePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        useStore.getState().pushHistory();
        const el = e.currentTarget;
        const pointerId = e.pointerId;
        setBaseEnergyFromClientY(e.clientY, el);
        // Track only the initiating pointer to prevent stray touches from changing the value.
        const onMove = (ev: PointerEvent) => {
            if (ev.pointerId !== pointerId) return;
            setBaseEnergyFromClientY(ev.clientY, el);
        };
        const cleanup = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        const onUp = (ev: PointerEvent) => {
            if (ev.pointerId !== pointerId) return;
            cleanup();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    };

    const setProgressFromClientX = (clientX: number, el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const t = (clientX - rect.left) / rect.width;
        const next = clampProgress(t * 100);
        updateNode(data.id, { progress: next });
    };

    const startProgressDrag = (clientX: number, el: HTMLElement, pointerId: number) => {
        setIsDraggingProgress(true);
        setProgressFromClientX(clientX, el);
        // Track only the initiating pointer to prevent stray touches from changing the value.
        const onMove = (ev: PointerEvent) => {
            if (ev.pointerId !== pointerId) return;
            setProgressFromClientX(ev.clientX, el);
        };
        const cleanup = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            setIsDraggingProgress(false);
        };
        const onUp = (ev: PointerEvent) => {
            if (ev.pointerId !== pointerId) return;
            cleanup();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    };

    const handleProgressPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget;
        useStore.getState().pushHistory();
        startProgressDrag(e.clientX, el, e.pointerId);
    };

    const applyQuickProgress = (value: number, e?: React.SyntheticEvent) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        const next = clampProgress(value);
        if (Math.round(progress) === next) return;
        useStore.getState().pushHistory();
        updateNode(data.id, { progress: next });
    };
    const quickProgressOptions = [25, 50, 75, 100];


    return (
        <div className={styles.noteDetailWrap} data-interactive="true" onPointerDown={(e) => e.stopPropagation()}>
            {/* Wrap the detailed card + energy panel so phone layout can scale them together. */}
            <div className={styles.noteShell}>
                <div className={`${styles.noteNode}${shouldPulse ? ` ${styles.monitorPulse}` : ''}`}>
                <div className={styles.noteHeaderRow}>
                    <div className={styles.noteTitleWrap}>
                        {isEditingTitle ? (
                            <input
                                className={styles.noteTitleInput}
                                value={data.title}
                                onChange={(e) => {
                                    ensureTitleHistory();
                                    updateNode(data.id, { title: e.target.value });
                                }}
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
                                onPointerDown={(e) => {
                                    e.stopPropagation();
                                    if (e.pointerType === 'touch') {
                                        titleTouchRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
                                    }
                                }}
                                onPointerUp={(e) => {
                                    if (e.pointerType !== 'touch') return;
                                    const ref = titleTouchRef.current;
                                    if (!ref || ref.id !== e.pointerId) return;
                                    const dist = Math.hypot(e.clientX - ref.x, e.clientY - ref.y);
                                    titleTouchRef.current = null;
                                    if (dist < 8) setIsEditingTitle(true);
                                }}
                                onPointerCancel={() => {
                                    titleTouchRef.current = null;
                                }}
                            >
                                {data.title}
                            </div>
                        )}
                    </div>

                    <div className={styles.noteHeaderActions} onPointerDown={(e) => e.stopPropagation()}>
                        <div className={`${styles.typeSwitcher} ${styles.noteTypeSwitcherCompact}`}>
                            <div
                                className={`${styles.typeOption} ${data.type === 'idea' ? styles.activeIdea : ''}`}
                                onClick={() => {
                                    useStore.getState().pushHistory();
                                    updateNode(data.id, { type: 'idea' });
                                }}
                            >
                                Idea
                            </div>
                            <div
                                className={`${styles.typeOption} ${data.type === 'task' ? styles.activeTask : ''}`}
                                onClick={() => {
                                    useStore.getState().pushHistory();
                                    updateNode(data.id, { type: 'task' });
                                }}
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
                    {isTask && (
                        <>
                            <div className={styles.noteProgressRow}>
                                <div
                                    className={styles.noteProgressTrack}
                                    style={{ '--progress-color': energyColor } as React.CSSProperties}
                                    onPointerDown={handleProgressPointerDown}
                                    role="slider"
                                    aria-label="Progress"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round(progress)}
                                    data-interactive="true"
                                >
                                    <div
                                        className={styles.noteProgressFill}
                                        style={{
                                            width: `${progress}%`,
                                            transition: isDraggingProgress ? 'none' : undefined,
                                        }}
                                    />
                                </div>
                                <div className={styles.noteProgressValue}>{Math.round(progress)}%</div>
                            </div>
                            <div
                                className={styles.noteProgressQuickRow}
                                style={{ '--progress-color': energyColor } as React.CSSProperties}
                            >
                                {quickProgressOptions.map((value) => {
                                    const isActive = Math.round(progress) === value;
                                    return (
                                        <button
                                            key={value}
                                            type="button"
                                            className={`${styles.noteProgressQuickButton}${isActive ? ` ${styles.noteProgressQuickActive}` : ''}`}
                                            onClick={(e) => applyQuickProgress(value, e)}
                                            onPointerDown={(e) => e.stopPropagation()}
                                            data-interactive="true"
                                        >
                                            {value}%
                                        </button>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    {/* Date Pickers + Status (Only for Task) */}
                    {data.type === 'task' && (
                        <div className={styles.taskMetaRow}>
                            <div className={styles.taskMetaItem}>
                                <span className={styles.taskMetaLabel}>Start</span>
                                <input
                                    type="date"
                                    className={styles.customDateInput}
                                    value={data.startDate || ''}
                                    onChange={(e) => {
                                        useStore.getState().pushHistory();
                                        updateNode(data.id, { startDate: e.target.value });
                                    }}
                                    onPointerDown={(e) => e.stopPropagation()}
                                />
                            </div>
                            <div className={styles.taskMetaItem}>
                                <span className={styles.taskMetaLabel}>Due</span>
                                <input
                                    type="date"
                                    className={styles.customDateInput}
                                    value={data.endDate || ''}
                                    onChange={(e) => {
                                        useStore.getState().pushHistory();
                                        updateNode(data.id, { endDate: e.target.value });
                                    }}
                                    onPointerDown={(e) => e.stopPropagation()}
                                />
                            </div>
                            <div className={styles.taskMetaItem}>
                                <span className={styles.taskMetaLabel}>Status</span>
                                <div className={styles.taskMetaValue}>
                                    {status === 'done' ? 'Done' : status === 'in_progress' ? 'In Progress' : 'Queued'}
                                </div>
                            </div>
                        </div>
                    )}

                    <NoteContentEditor nodeId={data.id} value={data.content} attachments={nodeAttachments} />
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
                            {energyInputOpen ? (
                                <input
                                    ref={energyInputRef}
                                    className={`${styles.noteEnergyValue} ${styles.noteEnergyInput}`}
                                    value={energyInputValue}
                                    inputMode="numeric"
                                    aria-label="Собственная энергия"
                                    onChange={(e) => setEnergyInputValue(e.target.value)}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={(e) => e.stopPropagation()}
                                    onBlur={() => commitEnergyInput({ closeOnError: true })}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            commitEnergyInput({ closeOnError: false });
                                        } else if (e.key === 'Escape') {
                                            e.preventDefault();
                                            setEnergyInputOpen(false);
                                        }
                                    }}
                                />
                            ) : (
                                <span
                                    className={`${styles.noteEnergyValue} ${styles.noteEnergyValueEditable}`}
                                    title="Собственная энергия"
                                    style={{ color: energyColor }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setEnergyInputOpen(true);
                                    }}
                                    onPointerDown={(e) => e.stopPropagation()}
                                >
                                    {Math.round(baseEnergy)}
                                </span>
                            )}
                            <span className={styles.noteEnergyDividerLine} aria-hidden="true" />
                            <span className={styles.noteEnergyValue} title="Суммарная энергия">
                                {Math.round(effectiveEnergy)}
                            </span>
                        </div>
                        {energyToast && (
                            <div
                                className={`${styles.energyToast} ${styles.noteEnergyToast} ${energyToastVisible ? styles.energyToastVisible : ''}`}
                                aria-live="polite"
                            >
                                {energyToast}
                            </div>
                        )}

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
        </div>
    );
});

interface NodeProps {
    data: NodeData;
}

export const Node: React.FC<NodeProps> = ({ data }) => {
    const { canvas } = useStore();
    const scale = canvas.scale;
    const [isHovered, setIsHovered] = useState(false);

    // Localized Semantic Zoom Logic
    // Only "Open" (NoteView) if:
    // 1. Scale is high enough (> 1.1)
    // 2. Node is close to center (e.g. within 400px radius in world space, roughly)

    const { dx, dy } = getDeltaToCenter(data.x, data.y, canvas);
    const focusRadiusX = 180 / Math.max(0.0001, scale);
    const focusRadiusY = focusRadiusX * 0.7;
    const focusNorm = (dx * dx) / (focusRadiusX * focusRadiusX)
        + (dy * dy) / (focusRadiusY * focusRadiusY);
    const focusScore = Math.max(0, 1 - Math.min(1, focusNorm));
    const isFocusedInViewport = focusNorm < 1;

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
    const noteViewStyle = isNote
        ? ({
            // Phone note view uses this offset so the detailed card stays centered on the viewport.
            '--note-offset-x': `${-dx}px`,
            '--note-offset-y': `${-dy}px`,
        } as React.CSSProperties)
        : undefined;
    const noteFocusZ = isNote ? Math.round(520 + focusScore * 180) : undefined;

    // Valid Wrapper Class Logic
    const neighbors = useStore((state) => state.neighbors);
    const selectedNode = useStore((state) => state.selectedNode);
    const selectedNodes = useStore((state) => state.selectedNodes);
    const connectionTargetId = useStore((state) => state.connectionTargetId);
    const authorshipMode = useStore((state) => state.authorshipMode);
    const effectiveEnergy = useStore((state) => state.effectiveEnergy[data.id] ?? data.energy);

    const isSelected = selectedNode === data.id || selectedNodes.includes(data.id);
    const authorLabel = typeof data.authorName === 'string' ? data.authorName.trim() : '';
    const showAuthor = authorshipMode && !!authorLabel && (isHovered || isSelected);
    const graphLabel = data.title?.trim();
    const showGraphLabel = isGraph && !!graphLabel && isHovered;
    const neighborDist = neighbors[data.id];
    const isTarget = connectionTargetId === data.id;
    const energyColor = energyToColor(effectiveEnergy);
    const progressValue = data.type === 'task'
        ? clampProgress(Number.isFinite(data.progress as number) ? (data.progress as number) : 0)
        : 0;
    const clarityValue = Number.isFinite(data.clarity) ? Math.max(0, Math.min(1, data.clarity)) : 0;
    const fillRatio = data.type === 'task' ? progressValue / 100 : clarityValue;

    let wrapperClass = `${styles.nodeWrapper} ${isTarget ? styles.targetGlow : ''}`;
    if (isNote) wrapperClass += ` ${styles.noteFocus}`;

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

    const renderAuthorBadge = () => (
        authorLabel ? (
            <div className={`${styles.authorBadge} ${showAuthor ? styles.authorVisible : ''}`}>{authorLabel}</div>
        ) : null
    );

    return (
        <div
            className={wrapperClass}
            style={{
                left: data.x,
                top: data.y,
                ...(noteFocusZ !== undefined ? ({ '--note-focus-z': noteFocusZ } as React.CSSProperties) : {}),
            }}
            data-node-bounds="true"
            data-node-id={data.id}
            onPointerEnter={() => setIsHovered(true)}
            onPointerLeave={() => setIsHovered(false)}
        >
            {/* Graph View */}
            <div
                className={graphClass}
                data-node-rect={isGraph ? 'true' : undefined}
                data-node-rect-id={data.id}
            >
                {renderAuthorBadge()}
                {graphLabel ? (
                    <div className={`${styles.graphLabel} ${showGraphLabel ? styles.graphLabelVisible : ''}`}>
                        {graphLabel}
                    </div>
                ) : null}
                <GraphView data={data} energyColor={energyColor} fillRatio={fillRatio} />
            </div>

            {/* Card View */}
            <div
                className={cardClass}
                data-node-rect={isCard ? 'true' : undefined}
                data-node-rect-id={data.id}
            >
                {renderAuthorBadge()}
                <CardView data={data} />
            </div>

            {/* Note View */}
            <div
                className={noteClass}
                data-node-rect={isNote ? 'true' : undefined}
                data-node-rect-id={data.id}
                style={noteViewStyle}
            >
                {renderAuthorBadge()}
                <NoteView data={data} />
            </div>
        </div>
    );
};
