import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Bold, Italic, Strikethrough, Code, List, ListOrdered, Quote, Paperclip, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../store/useStore';
import type { Attachment, NodeData, MentionToken, SessionSaver } from '../../types';
import styles from './Node.module.css';
import { numberLines, prefixLines, wrapSelection } from '../../utils/textEditing';
import { clampEnergy, energyToColor } from '../../utils/energy';
import { EnergySvgLiquidGauge } from './EnergySvgLiquidGauge';
import { filesToAttachments, formatBytes, MAX_ATTACHMENT_BYTES } from '../../utils/attachments';
import { getIncomingProgress } from '../../utils/childProgress';

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

type MentionOption = {
    id: string;
    label: string;
    name: string;
    email: string;
    avatarSeed: string;
    avatarUrl?: string | null;
    avatarAnimal?: number | null;
    avatarColor?: number | null;
};

type MentionParticipant = {
    id: string;
    label: string;
    avatarSeed: string;
    avatarUrl?: string | null;
    avatarAnimal?: number | null;
    avatarColor?: number | null;
};

const mentionLabelFor = (saver: SessionSaver) => {
    const name = String(saver.name ?? '').trim();
    if (name) return name;
    const email = String(saver.email ?? '').trim();
    if (email) return email;
    return 'User';
};

const hasAllMention = (text: string) => /(^|[^\p{L}\p{N}])@all(?![\p{L}\p{N}])/iu.test(text);

const normalizeMentionables = (savers: SessionSaver[] | undefined) => {
    if (!Array.isArray(savers)) return [];
    const seen = new Set<string>();
    const people = savers
        .map((saver) => ({
            id: String(saver.id ?? ''),
            label: mentionLabelFor(saver),
            name: String(saver.name ?? ''),
            email: String(saver.email ?? ''),
            avatarSeed: String(saver.avatarSeed ?? ''),
            avatarUrl: saver.avatarUrl ?? null,
            avatarAnimal: Number.isFinite(saver.avatarAnimal) ? saver.avatarAnimal ?? null : null,
            avatarColor: Number.isFinite(saver.avatarColor) ? saver.avatarColor ?? null : null,
        }))
        .filter((item) => {
            if (!item.id || seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        });
    if (!people.length) return people;
    return [
        {
            id: 'all',
            label: 'all',
            name: 'All participants',
            email: '',
            avatarSeed: '',
            avatarUrl: null,
            avatarAnimal: null,
            avatarColor: null,
        },
        ...people,
    ];
};

const normalizeMentions = (mentions: MentionToken[] | undefined) => {
    if (!Array.isArray(mentions)) return [];
    return mentions.filter((mention) => mention && typeof mention.id === 'string' && mention.id && typeof mention.label === 'string' && mention.label.trim());
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const pruneMentions = (text: string, mentions: MentionToken[]) => {
    return mentions.filter((mention) => {
        const label = mention.label.trim();
        if (!label) return false;
        const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])@${escapeRegExp(label)}(?![\\p{L}\\p{N}])`, 'iu');
        return pattern.test(text);
    });
};

const resolveMentionParticipants = (mentions: MentionToken[] | undefined, savers: SessionSaver[] | undefined) => {
    const normalized = normalizeMentions(mentions);
    if (!normalized.length && (!savers || !savers.length)) return [];
    const byId = new Map<string, SessionSaver>();
    (savers ?? []).forEach((saver) => {
        if (!saver?.id) return;
        byId.set(saver.id, saver);
    });
    const seen = new Set<string>();
    const out: MentionParticipant[] = [];
    const allMentioned = normalized.some((mention) => mention.id === 'all' || mention.label.trim().toLowerCase() === 'all');
    if (allMentioned) {
        (savers ?? []).forEach((saver) => {
            if (!saver?.id || seen.has(saver.id)) return;
            seen.add(saver.id);
            out.push({
                id: saver.id,
                label: mentionLabelFor(saver),
                avatarSeed: saver.avatarSeed ?? '',
                avatarUrl: saver.avatarUrl ?? null,
                avatarAnimal: Number.isFinite(saver.avatarAnimal) ? saver.avatarAnimal ?? null : null,
                avatarColor: Number.isFinite(saver.avatarColor) ? saver.avatarColor ?? null : null,
            });
        });
    }
    for (const mention of normalized) {
        if (seen.has(mention.id)) continue;
        if (mention.id === 'all' || mention.label.trim().toLowerCase() === 'all') continue;
        seen.add(mention.id);
        const saver = byId.get(mention.id);
        const fallback = saver ? mentionLabelFor(saver) : mention.label.trim();
        out.push({
            id: mention.id,
            label: mention.label.trim() || fallback,
            avatarSeed: saver?.avatarSeed ?? '',
            avatarUrl: saver?.avatarUrl ?? null,
            avatarAnimal: Number.isFinite(saver?.avatarAnimal) ? saver?.avatarAnimal ?? null : null,
            avatarColor: Number.isFinite(saver?.avatarColor) ? saver?.avatarColor ?? null : null,
        });
    }
    return out;
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
    mentionables?: SessionSaver[];
    mentions?: MentionToken[];
    onMentionsChange?: (next: MentionToken[]) => void;
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
                    <a
                        href={attachment.url ?? attachment.dataUrl ?? ''}
                        download={attachment.name}
                        className={styles.attachmentFile}
                    >
                        <span className={styles.attachmentPreview}>
                            {attachment.kind === 'image' ? (
                                <img
                                    src={attachment.url ?? attachment.dataUrl ?? ''}
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
    mentionables,
    mentions,
    onMentionsChange,
}) => {
    const safeValue = typeof value === 'string' ? value : '';
    const [editing, setEditing] = useState(alwaysEditing);
    const [attachNotice, setAttachNotice] = useState<string | null>(null);
    const sessionId = useStore((state) => state.sessionId);
    const rootRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [mentionOpen, setMentionOpen] = useState(false);
    const [mentionQuery, setMentionQuery] = useState('');
    const [mentionIndex, setMentionIndex] = useState(0);
    const [mentionAnchor, setMentionAnchor] = useState<{ start: number; end: number } | null>(null);
    const mentionOptions = useMemo(() => normalizeMentionables(mentionables), [mentionables]);
    const mentionMatches = useMemo(() => {
        if (!mentionOpen) return [];
        const q = mentionQuery.trim().toLowerCase();
        if (!q) return mentionOptions.slice(0, 6);
        return mentionOptions
            .filter((item) => {
                const name = item.name.toLowerCase();
                const email = item.email.toLowerCase();
                const label = item.label.toLowerCase();
                return name.includes(q) || email.includes(q) || label.includes(q);
            })
            .slice(0, 6);
    }, [mentionOpen, mentionOptions, mentionQuery]);
    const normalizedMentions = useMemo(() => normalizeMentions(mentions), [mentions]);

    const closeMentions = useCallback(() => {
        setMentionOpen(false);
        setMentionQuery('');
        setMentionAnchor(null);
        setMentionIndex(0);
    }, []);

    const syncMentions = useCallback((nextText: string) => {
        if (!onMentionsChange) return;
        let nextMentions = pruneMentions(nextText, normalizedMentions);
        const allMentioned = hasAllMention(nextText);
        if (allMentioned && !nextMentions.some((m) => m.id === 'all' || m.label.trim().toLowerCase() === 'all')) {
            nextMentions = [...nextMentions, { id: 'all', label: 'all' }];
        }
        if (!allMentioned && nextMentions.some((m) => m.id === 'all' || m.label.trim().toLowerCase() === 'all')) {
            nextMentions = nextMentions.filter((m) => m.id !== 'all' && m.label.trim().toLowerCase() !== 'all');
        }
        if (nextMentions.length !== normalizedMentions.length) onMentionsChange(nextMentions);
    }, [normalizedMentions, onMentionsChange]);

    const trackMentionTrigger = useCallback((text: string, cursor: number | null) => {
        if (cursor === null || cursor === undefined) {
            closeMentions();
            return;
        }
        const before = text.slice(0, cursor);
        const match = before.match(/(^|[^\p{L}\p{N}])@([\p{L}\p{N}._-]*)$/u);
        if (!match) {
            closeMentions();
            return;
        }
        const query = match[2] ?? '';
        const start = cursor - query.length - 1;
        setMentionOpen(true);
        setMentionQuery(query);
        setMentionAnchor({ start, end: cursor });
        setMentionIndex(0);
    }, [closeMentions]);

    React.useEffect(() => {
        if (alwaysEditing) setEditing(true);
    }, [alwaysEditing]);

    React.useEffect(() => {
        onEditingChange?.(editing);
    }, [editing, onEditingChange]);

    React.useEffect(() => {
        if (!editing) closeMentions();
    }, [closeMentions, editing]);

    React.useEffect(() => {
        if (!attachNotice) return;
        const t = window.setTimeout(() => setAttachNotice(null), 2000);
        return () => window.clearTimeout(t);
    }, [attachNotice]);

    React.useEffect(() => {
        if (mentionIndex >= mentionMatches.length && mentionMatches.length > 0) {
            setMentionIndex(0);
        }
    }, [mentionIndex, mentionMatches.length]);

    const apply = useCallback((fn: (text: string, sel: TextSel) => { nextText: string; nextSelection: TextSel }) => {
        const el = textareaRef.current;
        if (!el) return;
        const { nextText, nextSelection } = fn(el.value, { start: el.selectionStart, end: el.selectionEnd });
        onChange(nextText);
        syncMentions(nextText);
        trackMentionTrigger(nextText, nextSelection.end);
        requestAnimationFrame(() => {
            const t = textareaRef.current;
            if (!t) return;
            t.focus();
            t.setSelectionRange(nextSelection.start, nextSelection.end);
        });
    }, [onChange, syncMentions, trackMentionTrigger]);

    const applyMention = useCallback((option: MentionOption) => {
        const el = textareaRef.current;
        if (!el || !mentionAnchor) return;
        const current = el.value;
        const mentionText = `@${option.label}`;
        const suffix = current.slice(mentionAnchor.end);
        const spacer = suffix.startsWith(' ') || suffix.startsWith('\n') || suffix === '' ? '' : ' ';
        const nextText = `${current.slice(0, mentionAnchor.start)}${mentionText}${spacer}${suffix}`;
        onChange(nextText);
        if (onMentionsChange) {
            const merged = normalizedMentions.some((m) => m.id === option.id)
                ? normalizedMentions
                : [...normalizedMentions, { id: option.id, label: option.label }];
            onMentionsChange(pruneMentions(nextText, merged));
        }
        closeMentions();
        requestAnimationFrame(() => {
            const nextPos = mentionAnchor.start + mentionText.length + spacer.length;
            el.focus();
            el.setSelectionRange(nextPos, nextPos);
        });
    }, [closeMentions, mentionAnchor, normalizedMentions, onChange, onMentionsChange]);

    const keepTextFocus = (e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (mentionOpen) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const dir = e.key === 'ArrowDown' ? 1 : -1;
                const count = mentionMatches.length;
                if (count > 0) {
                    setMentionIndex((prev) => (prev + dir + count) % count);
                }
                return;
            }
            if (e.key === 'Enter' && mentionMatches.length > 0) {
                e.preventDefault();
                const picked = mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)];
                if (picked) applyMention(picked);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeMentions();
                return;
            }
        }
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
        closeMentions();
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
        const { attachments: incoming, rejected, failed } = await filesToAttachments(Array.from(files), sessionId);
        if (incoming.length) onAddAttachments(incoming);
        if (rejected.length) {
            setAttachNotice(`Max file size is ${formatBytes(MAX_ATTACHMENT_BYTES)}`);
        } else if (failed.length) {
            setAttachNotice('Upload failed. Please try again.');
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const next = e.target.value;
        onChange(next);
        trackMentionTrigger(next, e.target.selectionStart);
        syncMentions(next);
    };

    const showPreview = !editing && !alwaysEditing;
    const resolvedPlaceholder = placeholder ?? 'Double click to edit…';

    return (
        <div ref={rootRef} className={styles.editorRoot} data-interactive="true" onPointerDown={(e) => e.stopPropagation()}>
            {showPreview ? (
                <div
                    className={styles.editorPreview}
                    data-interactive="true"
                    data-scroll-lock="true"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                        setEditing(true);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                >
                    {safeValue.trim().length === 0 ? (
                        <div className={styles.editorPlaceholder}>{resolvedPlaceholder}</div>
                    ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{safeValue}</ReactMarkdown>
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
                    <div className={styles.editorInputWrap}>
                        <textarea
                            ref={textareaRef}
                            className={styles.noteContentInput}
                            data-scroll-lock="true"
                            value={safeValue}
                            onChange={handleChange}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            onPointerDown={(e) => e.stopPropagation()}
                            placeholder={resolvedPlaceholder}
                        />
                        {mentionOpen && (
                            <div
                                className={styles.mentionMenu}
                                data-interactive="true"
                                onPointerDown={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                }}
                            >
                                            {mentionMatches.length === 0 ? (
                                                <div className={styles.mentionEmpty}>No saved people yet</div>
                                            ) : (
                                                mentionMatches.map((item, idx) => (
                                                    <button
                                                        key={item.id}
                                                        type="button"
                                            className={`${styles.mentionItem} ${idx === mentionIndex ? styles.mentionItemActive : ''}`}
                                            onPointerDown={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                            }}
                                            onClick={() => applyMention(item)}
                                        >
                                            <span className={styles.mentionAvatar}>
                                                {(item.id === 'all' ? 'A' : item.label).slice(0, 1).toUpperCase()}
                                            </span>
                                            <span className={styles.mentionText}>
                                                <span className={styles.mentionName}>
                                                    {item.id === 'all' ? 'All participants' : item.label}
                                                </span>
                                                {item.id === 'all' ? (
                                                    <span className={styles.mentionMeta}>Tag everyone who saved this canvas</span>
                                                ) : (
                                                    item.email && item.email !== item.label && (
                                                        <span className={styles.mentionMeta}>{item.email}</span>
                                                    )
                                                )}
                                            </span>
                                                    </button>
                                                ))
                                            )}
                            </div>
                        )}
                    </div>
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
    mentions: MentionToken[];
}> = ({ nodeId, value, attachments, mentions }) => {
    const updateNode = useStore((state) => state.updateNode);
    const mentionables = useStore((state) => state.sessionSavers);
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

    const updateMentions = (next: MentionToken[]) => {
        ensureHistory();
        updateNode(nodeId, { mentions: next });
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
            mentionables={mentionables}
            mentions={mentions}
            onMentionsChange={updateMentions}
        />
    );
};

const CardView = React.memo(({ data }: { data: NodeData }) => {
    const updateNode = useStore((state) => state.updateNode);
    const [showEnergySelector, setShowEnergySelector] = React.useState(false);
    const monitoringMode = useStore((state) => state.monitoringMode);
    const sessionSavers = useStore((state) => state.sessionSavers);
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
    const maxBaseEnergy = 100;

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
    const mentionParticipants = resolveMentionParticipants(data.mentions, sessionSavers);
    const authorLabel = typeof data.authorName === 'string' ? data.authorName.trim() : '';

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

            {mentionParticipants.length > 0 && (
                <div className={styles.peopleRow}>
                    {authorLabel && (
                        <span className={`${styles.personPill} ${styles.authorPill}`} title="Author">
                            {authorLabel}
                        </span>
                    )}
                    {mentionParticipants.map((person) => (
                        <span key={person.id} className={`${styles.personPill} ${styles.participantPill}`} title="Participant">
                            {person.label}
                        </span>
                    ))}
                </div>
            )}

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

export const NoteView = React.memo(({ data }: { data: NodeData }) => {
    const updateNode = useStore((state) => state.updateNode);
    const monitoringMode = useStore((state) => state.monitoringMode);
    const sessionSavers = useStore((state) => state.sessionSavers);
    const edges = useStore((state) => state.edges);
    const nodes = useStore((state) => state.nodes);
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
    const maxBaseEnergy = 100;
    const isTask = data.type === 'task';
    const progress = clampProgress(typeof data.progress === 'number' && Number.isFinite(data.progress) ? data.progress : 0);
    const status = statusFromProgress(progress);
    const shouldPulse = monitoringMode && isTask && status === 'in_progress';
    const incomingProgress = React.useMemo(
        () => getIncomingProgress(nodes, edges, data.id),
        [nodes, edges, data.id],
    );
    const canUseChildProgress = incomingProgress.count > 0;
    const childProgressEnabled = isTask && data.childProgress === true;
    const childProgressActive = childProgressEnabled && canUseChildProgress;
    const nodeAttachments = Array.isArray(data.attachments) ? data.attachments : [];
    const mentionParticipants = resolveMentionParticipants(data.mentions, sessionSavers);
    const authorLabel = typeof data.authorName === 'string' ? data.authorName.trim() : '';

    React.useEffect(() => {
        if (!childProgressEnabled) return;
        if (canUseChildProgress) return;
        updateNode(data.id, { childProgress: false });
    }, [childProgressEnabled, canUseChildProgress, updateNode, data.id]);

    React.useEffect(() => {
        if (!childProgressActive) return;
        const next = incomingProgress.value;
        if (Math.abs(progress - next) < 0.1) return;
        updateNode(data.id, { progress: next });
    }, [childProgressActive, incomingProgress.value, progress, updateNode, data.id]);

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
        updateNode(data.id, { progress: next, childProgress: false });
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
        updateNode(data.id, { progress: next, childProgress: false });
    };
    const quickProgressOptions = [25, 50, 75, 100];
    const toggleChildProgress = (e?: React.SyntheticEvent) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        if (!canUseChildProgress) return;
        useStore.getState().pushHistory();
        if (childProgressEnabled) {
            updateNode(data.id, { childProgress: false });
            return;
        }
        updateNode(data.id, { childProgress: true, progress: incomingProgress.value });
    };


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

                {mentionParticipants.length > 0 && (
                    <div className={styles.peopleRow}>
                        {authorLabel && (
                            <span className={`${styles.personPill} ${styles.authorPill}`} title="Author">
                                {authorLabel}
                            </span>
                        )}
                        {mentionParticipants.map((person) => (
                            <span key={person.id} className={`${styles.personPill} ${styles.participantPill}`} title="Participant">
                                {person.label}
                            </span>
                        ))}
                    </div>
                )}

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
                                <button
                                    type="button"
                                    className={`${styles.noteProgressToggle}${childProgressEnabled ? ` ${styles.noteProgressToggleActive}` : ''}`}
                                    onClick={toggleChildProgress}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    disabled={!canUseChildProgress}
                                    aria-pressed={childProgressEnabled}
                                    title={canUseChildProgress ? 'Use incoming nodes progress' : 'No incoming nodes'}
                                    data-interactive="true"
                                >
                                    <span className={styles.noteProgressToggleLabel}>Child Progress</span>
                                    <span className={styles.noteProgressToggleSwitch} aria-hidden="true" />
                                </button>
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

                    <NoteContentEditor nodeId={data.id} value={data.content} attachments={nodeAttachments} mentions={normalizeMentions(data.mentions)} />
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
