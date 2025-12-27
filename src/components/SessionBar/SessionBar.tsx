import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Plus, Save, Share2, Trash2, X } from 'lucide-react';
import { useStore } from '../../store/useStore';
import styles from './SessionBar.module.css';

type SessionListItem = {
    id: string;
    name: string | null;
    savedAt: string | null;
    updatedAt: string | null;
};

export const SessionBar: React.FC = () => {
    const sessionId = useStore((s) => s.sessionId);
    const sessionName = useStore((s) => s.sessionName);
    const sessionSaved = useStore((s) => s.sessionSaved);
    const sessionOwnerId = useStore((s) => s.sessionOwnerId);
    const sessionExpiresAt = useStore((s) => s.sessionExpiresAt);
    const sessionSavers = useStore((s) => s.sessionSavers);
    const setSessionMeta = useStore((s) => s.setSessionMeta);
    const setSessionSavers = useStore((s) => s.setSessionSavers);
    const me = useStore((s) => s.me);

    const [showPrompt, setShowPrompt] = useState(false);
    const [nameInput, setNameInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const [nowTick, setNowTick] = useState(() => Date.now());
    const [expiryInfoToken, setExpiryInfoToken] = useState(0);
    const [expiryInfoOpen, setExpiryInfoOpen] = useState(false);
    const [expiryInfoVisible, setExpiryInfoVisible] = useState(false);
    const [showSessions, setShowSessions] = useState(false);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [sessionsError, setSessionsError] = useState<string | null>(null);
    const [sessions, setSessions] = useState<SessionListItem[]>([]);
    const [sessionActionBusy, setSessionActionBusy] = useState<string | null>(null);
    const [currentNameDraft, setCurrentNameDraft] = useState('');

    useEffect(() => {
        if (!showPrompt) return;
        setNameInput(sessionName ?? '');
    }, [showPrompt, sessionName]);

    useEffect(() => {
        if (!toast) return;
        const t = window.setTimeout(() => setToast(null), 1600);
        return () => window.clearTimeout(t);
    }, [toast]);

    useEffect(() => {
        const t = window.setInterval(() => setNowTick(Date.now()), 60 * 1000);
        return () => window.clearInterval(t);
    }, []);

    useEffect(() => {
        if (!expiryInfoToken) return;
        setExpiryInfoOpen(true);
        setExpiryInfoVisible(true);
        const fadeTimer = window.setTimeout(() => setExpiryInfoVisible(false), 1600);
        const clearTimer = window.setTimeout(() => setExpiryInfoOpen(false), 2000);
        return () => {
            window.clearTimeout(fadeTimer);
            window.clearTimeout(clearTimer);
        };
    }, [expiryInfoToken]);

    const requestAuth = useCallback((message = 'Для сохранения нужна авторизация') => {
        window.dispatchEvent(
            new CustomEvent('open-auth', {
                detail: { reason: 'save', message, mode: 'login' },
            }),
        );
    }, []);

    const openSavePrompt = useCallback(() => {
        if (!sessionId) return;
        if (sessionSaved) return;
        if (!me) {
            requestAuth();
            return;
        }
        setShowPrompt(true);
    }, [me, requestAuth, sessionId, sessionSaved]);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const key = String(e.key || '').toLowerCase();
            if (!(e.metaKey || e.ctrlKey)) return;
            if (key !== 's') return;
            e.preventDefault();
            openSavePrompt();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [openSavePrompt]);

    const submitSave = useCallback(async () => {
        if (!sessionId) return;
        const name = nameInput.trim();
        if (!name) {
            setToast('Введите имя сессии');
            return;
        }
        if (!me) {
            requestAuth();
            return;
        }
        setBusy(true);
        try {
            const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/save`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 401) {
                    requestAuth();
                    return;
                }
                setToast(String(data?.error ?? 'Не удалось сохранить'));
                return;
            }
            const meta = data?.meta;
            if (meta && typeof meta === 'object') {
                setSessionMeta({
                    name: typeof meta.name === 'string' ? meta.name : name,
                    saved: !!meta.saved || !!meta.savedAt,
                    ownerId: typeof meta.ownerId === 'string' ? meta.ownerId : null,
                    expiresAt: meta.expiresAt ? String(meta.expiresAt) : null,
                });
            } else {
                setSessionMeta({ name, saved: true });
            }
            setShowPrompt(false);
            setToast('Сессия сохранена');
            setSessions((prev) =>
                prev.map((item) =>
                    item.id === sessionId
                        ? {
                              ...item,
                              name: typeof meta?.name === 'string' ? meta.name : name,
                              updatedAt: new Date().toISOString(),
                          }
                        : item,
                ),
            );
            if (me?.id) {
                const currentSavers = useStore.getState().sessionSavers;
                if (!currentSavers.some((item) => item.id === me.id)) {
                    setSessionSavers([
                        ...currentSavers,
                        {
                            id: me.id,
                            name: me.name ?? '',
                            email: me.email ?? '',
                            avatarSeed: me.avatarSeed ?? '',
                            avatarUrl: me.avatarUrl ?? null,
                            avatarAnimal: me.avatarAnimal ?? null,
                            avatarColor: me.avatarColor ?? null,
                            savedAt: new Date().toISOString(),
                        },
                    ]);
                }
            }
        } finally {
            setBusy(false);
        }
    }, [me, nameInput, requestAuth, sessionId, setSessionMeta, setSessionSavers]);

    const saveForMe = useCallback(async () => {
        if (!sessionId) return;
        if (!me) {
            requestAuth();
            return;
        }
        setBusy(true);
        const name = (sessionName ?? '').trim() || 'Untitled session';
        try {
            const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/save`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 401) {
                    requestAuth();
                    return;
                }
                setToast(String(data?.error ?? 'Не удалось сохранить'));
                return;
            }
            const meta = data?.meta;
            if (meta && typeof meta === 'object') {
                setSessionMeta({
                    name: typeof meta.name === 'string' ? meta.name : name,
                    saved: !!meta.saved || !!meta.savedAt,
                    ownerId: typeof meta.ownerId === 'string' ? meta.ownerId : sessionOwnerId ?? null,
                    expiresAt: meta.expiresAt ? String(meta.expiresAt) : null,
                });
            }
            const nowIso = new Date().toISOString();
            setSessions((prev) => {
                const existing = prev.find((item) => item.id === sessionId);
                if (existing) {
                    return prev.map((item) =>
                        item.id === sessionId
                            ? {
                                  ...item,
                                  name: typeof meta?.name === 'string' ? meta.name : name,
                                  savedAt: item.savedAt ?? nowIso,
                                  updatedAt: nowIso,
                              }
                            : item,
                    );
                }
                return [
                    { id: sessionId, name: typeof meta?.name === 'string' ? meta.name : name, savedAt: nowIso, updatedAt: nowIso },
                    ...prev,
                ];
            });
            const currentSavers = useStore.getState().sessionSavers;
            if (!currentSavers.some((item) => item.id === me.id)) {
                setSessionSavers([
                    ...currentSavers,
                    {
                        id: me.id,
                        name: me.name ?? '',
                        email: me.email ?? '',
                        avatarSeed: me.avatarSeed ?? '',
                        avatarUrl: me.avatarUrl ?? null,
                        avatarAnimal: me.avatarAnimal ?? null,
                        avatarColor: me.avatarColor ?? null,
                        savedAt: nowIso,
                    },
                ]);
            }
            setToast('Сессия сохранена');
        } finally {
            setBusy(false);
        }
    }, [me, requestAuth, sessionId, sessionName, setSessionMeta, setSessionSavers, sessionOwnerId]);

    const onPromptKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitSave();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setShowPrompt(false);
        }
    };

    const daysLeft = useMemo(() => {
        if (sessionSaved || !sessionExpiresAt) return null;
        const expiresAtMs = new Date(sessionExpiresAt).getTime();
        if (!Number.isFinite(expiresAtMs)) return null;
        const delta = expiresAtMs - nowTick;
        if (delta <= 0) return 0;
        return Math.max(0, Math.ceil(delta / (1000 * 60 * 60 * 24)));
    }, [nowTick, sessionExpiresAt, sessionSaved]);

    const displaySessionName = useMemo(() => {
        if (sessionName && sessionName.trim()) return sessionName;
        return sessionSaved ? 'Untitled session' : 'Temporary session';
    }, [sessionName, sessionSaved]);

    const savedByMe = useMemo(() => {
        if (!me?.id) return false;
        return sessionSavers.some((saver) => saver.id === me.id);
    }, [me?.id, sessionSavers]);

    const canOpenSessions = useMemo(() => {
        if (!sessionId) return false;
        if (sessionOwnerId && me && sessionOwnerId !== me.id) return false;
        return true;
    }, [me, sessionId, sessionOwnerId]);

    const loadSessions = useCallback(async () => {
        if (!me) return;
        setSessionsLoading(true);
        setSessionsError(null);
        try {
            const res = await fetch('/api/sessions/mine');
            if (!res.ok) {
                setSessionsError('Не удалось загрузить сессии');
                return;
            }
            const data = await res.json();
            const items: unknown[] = Array.isArray(data?.sessions) ? data.sessions : [];
            const normalized: SessionListItem[] = items
                .map((item: any) => ({
                    id: typeof item?.id === 'string' ? item.id : '',
                    name: typeof item?.name === 'string' ? item.name : null,
                    savedAt: item?.savedAt ? String(item.savedAt) : null,
                    updatedAt: item?.updatedAt ? String(item.updatedAt) : null,
                }))
                .filter((item: SessionListItem) => item.id);
            setSessions(normalized);
        } catch {
            setSessionsError('Не удалось загрузить сессии');
        } finally {
            setSessionsLoading(false);
        }
    }, [me]);

    const openSessionsMenu = useCallback(() => {
        if (!sessionId) return;
        setShowSessions((v) => !v);
    }, [sessionId]);

    const closeSessionsMenu = useCallback(() => {
        setShowSessions(false);
    }, []);

    const sessionsAccess = useMemo(() => {
        if (!me) return { ok: false, reason: 'Sign in to see your sessions' };
        if (sessionOwnerId && sessionOwnerId !== me.id) {
            return { ok: false, reason: 'Session belongs to another account' };
        }
        return { ok: true, reason: null };
    }, [me, sessionOwnerId]);

    useEffect(() => {
        if (!showSessions) return;
        if (!sessionsAccess.ok) {
            setSessions([]);
            setSessionsError(sessionsAccess.reason);
            setSessionsLoading(false);
            return;
        }
        setSessionsError(null);
        loadSessions();
    }, [loadSessions, sessionsAccess, showSessions]);

    useEffect(() => {
        if (!showSessions) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeSessionsMenu();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [closeSessionsMenu, showSessions]);

    useEffect(() => {
        setShowSessions(false);
    }, [sessionId, sessionSaved]);

    useEffect(() => {
        if (!showSessions) return;
        setCurrentNameDraft(sessionName ?? '');
    }, [sessionName, showSessions]);

    const copyToClipboard = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            window.prompt('Copy session link:', text);
            return false;
        }
    };

    const handleShareSession = useCallback(
        async (id: string) => {
            const url = new URL(window.location.href);
            url.searchParams.set('session', id);
            url.searchParams.delete('reset');
            const ok = await copyToClipboard(url.toString());
            setToast(ok ? 'Ссылка скопирована' : 'Ссылка для копирования открыта');
        },
        [],
    );

    const handleOpenSession = useCallback(
        (id: string) => {
            if (!id) return;
            const url = new URL(window.location.href);
            url.searchParams.set('session', id);
            url.searchParams.delete('reset');
            const w = window.open(url.toString(), '_blank');
            if (w) w.opener = null;
            closeSessionsMenu();
        },
        [closeSessionsMenu],
    );

    const handleDeleteSession = useCallback(
        async (id: string) => {
            if (sessionActionBusy) return;
            setSessionActionBusy(id);
            try {
                const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
                if (!res.ok) {
                    setToast('Не удалось удалить сессию');
                    return;
                }
                setSessions((prev) => prev.filter((item) => item.id !== id));
                setToast('Сессия удалена');
                if (id === sessionId) {
                    const created = await fetch('/api/sessions', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ state: {} }),
                    });
                    const data = await created.json().catch(() => ({}));
                    const nextId = typeof data?.id === 'string' ? data.id : null;
                    if (!nextId) return;
                    const url = new URL(window.location.href);
                    url.searchParams.set('session', nextId);
                    url.searchParams.delete('reset');
                    window.location.href = url.toString();
                }
            } finally {
                setSessionActionBusy(null);
            }
        },
        [sessionActionBusy, sessionId],
    );

    const currentSessionItem = useMemo(() => {
        if (!sessionId) return null;
        const fromList = sessions.find((item) => item.id === sessionId);
        if (fromList) return fromList;
        return { id: sessionId, name: sessionName ?? null, savedAt: null, updatedAt: null };
    }, [sessionId, sessionName, sessions]);

    const otherSessions = useMemo(() => sessions.filter((item) => item.id !== sessionId), [sessionId, sessions]);

    const formatUpdatedAt = useCallback((value: string | null) => {
        if (!value) return 'No activity';
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return 'No activity';
        return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }, []);

    const openSessionInNewTab = useCallback((id: string, opts?: { reset?: boolean; windowRef?: Window | null }) => {
        const url = new URL(window.location.href);
        url.searchParams.set('session', id);
        if (opts?.reset) url.searchParams.set('reset', '1');
        else url.searchParams.delete('reset');
        if (opts?.windowRef) {
            opts.windowRef.location.href = url.toString();
            return;
        }
        const w = window.open(url.toString(), '_blank');
        if (w) w.opener = null;
    }, []);

    const openLoadingTab = () => {
        const w = window.open('about:blank', '_blank');
        if (!w) return null;
        try {
            w.opener = null;
            w.document.write(
                `<!doctype html><html><head><meta charset="utf-8"/><title>Loading…</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background: #0b0f18; color: #e6e6e6; }
  .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
  .card { max-width: 420px; width: 100%; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 18px; }
  .bar { height: 6px; border-radius: 999px; background: rgba(255,255,255,0.14); overflow: hidden; margin-top: 12px; }
  .bar > div { height: 100%; width: 40%; background: rgba(255,255,255,0.55); animation: l 1.1s ease-in-out infinite; border-radius: 999px; }
  @keyframes l { 0% { transform: translateX(-120%);} 100% { transform: translateX(260%);} }
</style></head><body><div class="wrap"><div class="card">
  <div>Creating session…</div>
  <div class="bar"><div></div></div>
</div></div></body></html>`,
            );
            w.document.close();
        } catch {
            // ignore
        }
        return w;
    };

    const handleCreateNewSession = useCallback(async () => {
        if (sessionActionBusy) return;
        setSessionActionBusy('new');
        const w = openLoadingTab();
        try {
            const res = await fetch('/api/sessions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    state: {
                        nodes: [],
                        edges: [],
                        drawings: [],
                        textBoxes: [],
                        comments: [],
                        tombstones: { nodes: {}, edges: {}, drawings: {}, textBoxes: {}, comments: {} },
                    },
                }),
            });
            if (!res.ok) throw new Error('Failed to create session');
            const data = await res.json();
            const id = typeof data?.id === 'string' ? data.id : null;
            if (!id) throw new Error('Invalid session id');
            openSessionInNewTab(id, { reset: true, windowRef: w });
            closeSessionsMenu();
        } catch {
            setToast('Не удалось создать сессию');
            try {
                w?.close();
            } catch {
                // ignore
            }
        } finally {
            setSessionActionBusy(null);
        }
    }, [closeSessionsMenu, openSessionInNewTab, sessionActionBusy]);

    const handleCopySession = useCallback(
        async (id: string) => {
            if (sessionActionBusy) return;
            setSessionActionBusy(id);
            const w = openLoadingTab();
            try {
                let newId: string | null = null;
                if (id === sessionId) {
                    const snapshot = ((s) => ({
                        nodes: s.nodes,
                        edges: s.edges,
                        drawings: s.drawings,
                        textBoxes: s.textBoxes,
                        tombstones: s.tombstones,
                    }))(useStore.getState());
                    const res = await fetch('/api/sessions', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ state: snapshot }),
                    });
                    if (!res.ok) throw new Error('copy_failed');
                    const data = await res.json();
                    newId = typeof data?.id === 'string' ? data.id : null;
                } else {
                    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/clone`, { method: 'POST' });
                    if (!res.ok) throw new Error('copy_failed');
                    const data = await res.json();
                    newId = typeof data?.id === 'string' ? data.id : null;
                }
                if (!newId) throw new Error('copy_failed');
                openSessionInNewTab(newId, { reset: true, windowRef: w });
                closeSessionsMenu();
            } catch {
                setToast('Не удалось скопировать сессию');
                try {
                    w?.close();
                } catch {
                    // ignore
                }
            } finally {
                setSessionActionBusy(null);
            }
        },
        [closeSessionsMenu, openSessionInNewTab, sessionActionBusy, sessionId],
    );

    const handleRenameCurrent = useCallback(async () => {
        if (!sessionId || !sessionSaved) return;
        const nextName = currentNameDraft.trim();
        if (!nextName || nextName === sessionName) {
            setCurrentNameDraft(sessionName ?? '');
            return;
        }
        if (!me) {
            requestAuth('Для переименования нужна авторизация');
            setCurrentNameDraft(sessionName ?? '');
            return;
        }
        if (sessionOwnerId && sessionOwnerId !== me.id) return;
        setSessionActionBusy(sessionId);
        try {
            const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/save`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: nextName }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setToast(String(data?.error ?? 'Не удалось переименовать'));
                setCurrentNameDraft(sessionName ?? '');
                return;
            }
            const meta = data?.meta;
            setSessionMeta({
                name: typeof meta?.name === 'string' ? meta.name : nextName,
                saved: true,
                ownerId: typeof meta?.ownerId === 'string' ? meta.ownerId : sessionOwnerId ?? null,
                expiresAt: meta?.expiresAt ? String(meta.expiresAt) : null,
            });
            setSessions((prev) =>
                prev.map((item) =>
                    item.id === sessionId ? { ...item, name: typeof meta?.name === 'string' ? meta.name : nextName, updatedAt: new Date().toISOString() } : item,
                ),
            );
            setToast('Название обновлено');
        } finally {
            setSessionActionBusy(null);
        }
    }, [currentNameDraft, me, requestAuth, sessionId, sessionName, sessionOwnerId, sessionSaved, setSessionMeta]);

    return (
        <>
            <div className={styles.root}>
                {toast && <div className={styles.toast}>{toast}</div>}
                {!sessionSaved && (
                    <div className={styles.saveGroup}>
                        <button type="button" className={styles.saveButton} onClick={openSavePrompt} disabled={busy}>
                            <Save size={14} />
                            Save
                        </button>
                        {typeof daysLeft === 'number' && (
                            <button
                                type="button"
                                className={styles.expiryBadge}
                                onClick={() => setExpiryInfoToken((v) => v + 1)}
                            >
                                {daysLeft} days
                            </button>
                        )}
                        {expiryInfoOpen && typeof daysLeft === 'number' && (
                            <div className={styles.expiryInfo} style={{ opacity: expiryInfoVisible ? 0.65 : 0 }}>
                                Session will be deleted in {daysLeft} days if not saved.
                            </div>
                        )}
                    </div>
                )}
                {sessionSaved && !savedByMe && (
                    <div className={styles.saveGroup}>
                        <button type="button" className={styles.saveButton} onClick={saveForMe} disabled={busy}>
                            <Save size={14} />
                            Save to my sessions
                        </button>
                    </div>
                )}
                {sessionId ? (
                    <button
                        type="button"
                        className={styles.sessionName}
                        title={displaySessionName}
                        onClick={openSessionsMenu}
                        disabled={!canOpenSessions}
                    >
                        {displaySessionName}
                    </button>
                ) : null}
                {showPrompt && (
                    <div className={styles.prompt} onPointerDown={(e) => e.stopPropagation()}>
                        <div className={styles.promptTitle}>Session name</div>
                        <input
                            className={styles.promptInput}
                            value={nameInput}
                            onChange={(e) => setNameInput(e.target.value)}
                            onKeyDown={onPromptKeyDown}
                            autoFocus
                            placeholder="Например: Roadmap Q3"
                        />
                        <div className={styles.promptActions}>
                            <button type="button" className={styles.promptButton} onClick={() => setShowPrompt(false)}>
                                Cancel
                            </button>
                            <button type="button" className={`${styles.promptButton} ${styles.promptButtonPrimary}`} onClick={submitSave} disabled={busy}>
                                Save
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {sessionId && (
                <>
                    <div
                        className={`${styles.sessionsBackdrop} ${showSessions ? styles.sessionsBackdropOpen : ''}`}
                        onPointerDown={closeSessionsMenu}
                    />
                    <aside
                        className={`${styles.sessionsPanel} ${showSessions ? styles.sessionsPanelOpen : ''}`}
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        {currentSessionItem && (
                            <div className={styles.currentSession}>
                                <div className={styles.currentSessionHeader}>
                                    <div className={styles.currentSessionLabel}>Current session</div>
                                    {!sessionSaved && <div className={styles.currentSessionBadge}>Temporary</div>}
                                </div>
                                <div className={styles.currentSessionRow}>
                                    <div className={styles.sessionItemInfo}>
                                        <input
                                            className={styles.currentSessionName}
                                            value={sessionSaved ? currentNameDraft : displaySessionName}
                                            onChange={(e) => setCurrentNameDraft(e.target.value)}
                                            onBlur={handleRenameCurrent}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    handleRenameCurrent();
                                                } else if (e.key === 'Escape') {
                                                    e.preventDefault();
                                                    setCurrentNameDraft(sessionName ?? '');
                                                    (e.currentTarget as HTMLInputElement).blur();
                                                }
                                            }}
                                            disabled={!sessionSaved || sessionActionBusy === currentSessionItem.id}
                                        />
                                        <div className={styles.sessionItemMeta}>
                                            Updated {formatUpdatedAt(currentSessionItem.updatedAt ?? currentSessionItem.savedAt)}
                                        </div>
                                    </div>
                                    <div className={styles.sessionItemActions}>
                                        <button
                                            type="button"
                                            className={styles.sessionActionButton}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleCopySession(currentSessionItem.id);
                                            }}
                                            disabled={sessionActionBusy === currentSessionItem.id}
                                        >
                                            <Copy size={14} />
                                        </button>
                                        <button
                                            type="button"
                                            className={styles.sessionActionButton}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleShareSession(currentSessionItem.id);
                                            }}
                                            disabled={sessionActionBusy === currentSessionItem.id}
                                        >
                                            <Share2 size={14} />
                                        </button>
                                        {sessionSaved && (
                                            <button
                                                type="button"
                                                className={`${styles.sessionActionButton} ${styles.sessionActionDanger}`}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDeleteSession(currentSessionItem.id);
                                                }}
                                                disabled={sessionActionBusy === currentSessionItem.id}
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                        <div className={styles.sessionsHeader}>
                            <div className={styles.sessionsTitle}>Sessions</div>
                            <button type="button" className={styles.sessionsClose} onClick={closeSessionsMenu}>
                                <X size={16} />
                            </button>
                        </div>
                        <button
                            type="button"
                            className={styles.newSessionButton}
                            onClick={handleCreateNewSession}
                            disabled={sessionActionBusy === 'new'}
                        >
                            <Plus size={14} />
                            New session
                        </button>
                        {sessionsLoading && <div className={styles.sessionsEmpty}>Loading…</div>}
                        {!sessionsLoading && sessionsError && <div className={styles.sessionsEmpty}>{sessionsError}</div>}
                        {!sessionsLoading && !sessionsError && otherSessions.length === 0 && (
                            <div className={styles.sessionsEmpty}>No other sessions</div>
                        )}
                        {!sessionsLoading && !sessionsError && otherSessions.length > 0 && (
                            <div className={styles.sessionsList}>
                                {otherSessions.map((item) => {
                                    return (
                                        <div
                                            key={item.id}
                                            className={styles.sessionItem}
                                            onClick={() => handleOpenSession(item.id)}
                                        >
                                            <div className={styles.sessionItemInfo}>
                                                <div className={styles.sessionItemName}>{item.name ?? 'Untitled session'}</div>
                                                <div className={styles.sessionItemMeta}>Updated {formatUpdatedAt(item.updatedAt ?? item.savedAt)}</div>
                                            </div>
                                            <div className={styles.sessionItemActions}>
                                                <button
                                                    type="button"
                                                    className={styles.sessionActionButton}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleCopySession(item.id);
                                                    }}
                                                    disabled={sessionActionBusy === item.id}
                                                >
                                                    <Copy size={14} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={styles.sessionActionButton}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleShareSession(item.id);
                                                    }}
                                                    disabled={sessionActionBusy === item.id}
                                                >
                                                    <Share2 size={14} />
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`${styles.sessionActionButton} ${styles.sessionActionDanger}`}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleDeleteSession(item.id);
                                                    }}
                                                    disabled={sessionActionBusy === item.id}
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </aside>
                </>
            )}
        </>
    );
};
