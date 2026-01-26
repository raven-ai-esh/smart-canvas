import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Plus, Save, Share2, Trash2, X } from 'lucide-react';
import { useStore } from '../../store/useStore';
import styles from './SessionBar.module.css';
import { useTranslation } from '../../i18n';

type SessionListItem = {
    id: string;
    name: string | null;
    savedAt: string | null;
    updatedAt: string | null;
};

type SessionTab = {
    id: string;
    name: string | null;
    shareToken: string | null;
};

const tabsStorageKey = 'smart-canvas-session-tabs';

export const SessionBar: React.FC = () => {
    const sessionId = useStore((s) => s.sessionId);
    const sessionName = useStore((s) => s.sessionName);
    const sessionSaved = useStore((s) => s.sessionSaved);
    const sessionOwnerId = useStore((s) => s.sessionOwnerId);
    const sessionExpiresAt = useStore((s) => s.sessionExpiresAt);
    const sessionSavers = useStore((s) => s.sessionSavers);
    const sessionShareToken = useStore((s) => s.sessionShareToken);
    const setSessionMeta = useStore((s) => s.setSessionMeta);
    const setSessionSavers = useStore((s) => s.setSessionSavers);
    const me = useStore((s) => s.me);
    const locale = useStore((s) => s.generalSettings.locale);
    const localeTag = locale === 'ru' ? 'ru-RU' : 'en-US';
    const { t } = useTranslation();

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
    const [linkPrompt, setLinkPrompt] = useState<{ title: string; url: string } | null>(null);
    const [sessionTabs, setSessionTabs] = useState<SessionTab[]>(() => {
        try {
            const raw = window.sessionStorage.getItem(tabsStorageKey);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            const unique = new Map<string, SessionTab>();
            parsed.forEach((item) => {
                const id = typeof item?.id === 'string' ? item.id : '';
                if (!id) return;
                const name = typeof item?.name === 'string' ? item.name : null;
                const shareToken = typeof item?.shareToken === 'string' ? item.shareToken : null;
                unique.set(id, { id, name, shareToken });
            });
            return Array.from(unique.values());
        } catch {
            return [];
        }
    });

    const linkPromptInputRef = useRef<HTMLInputElement | null>(null);

    const emitPopState = useCallback(() => {
        try {
            window.dispatchEvent(new PopStateEvent('popstate'));
        } catch {
            window.dispatchEvent(new Event('popstate'));
        }
    }, []);

    const switchToSession = useCallback(
        (id: string, opts?: { reset?: boolean; shareToken?: string | null }) => {
            if (!id) return;
            const url = new URL(window.location.href);
            url.searchParams.set('session', id);
            if (opts?.reset) url.searchParams.set('reset', '1');
            else url.searchParams.delete('reset');
            const shareToken = typeof opts?.shareToken === 'string' && opts.shareToken.trim()
                ? opts.shareToken.trim()
                : null;
            if (shareToken) {
                url.searchParams.set('share', shareToken);
                url.searchParams.delete('shareToken');
            } else {
                url.searchParams.delete('share');
                url.searchParams.delete('shareToken');
            }
            window.history.pushState({}, '', url.toString());
            emitPopState();
        },
        [emitPopState],
    );

    const upsertSessionTab = useCallback((id: string, name: string | null, shareToken?: string | null) => {
        if (!id) return;
        const nextName = typeof name === 'string' && name.trim() ? name.trim() : null;
        const nextShare = typeof shareToken === 'string' && shareToken.trim() ? shareToken.trim() : null;
        setSessionTabs((prev) => {
            const idx = prev.findIndex((tab) => tab.id === id);
            if (idx < 0) {
                return [...prev, { id, name: nextName, shareToken: nextShare }];
            }
            const existing = prev[idx];
            const mergedName = nextName ?? existing.name;
            const mergedShare = nextShare ?? existing.shareToken;
            if (existing.name === mergedName && existing.shareToken === mergedShare) return prev;
            const next = prev.slice();
            next[idx] = { ...existing, name: mergedName, shareToken: mergedShare };
            return next;
        });
    }, []);

    const closeSessionTab = useCallback(
        (id: string) => {
            setSessionTabs((prev) => {
                if (prev.length <= 1) return prev;
                const next = prev.filter((tab) => tab.id !== id);
                if (next.length === prev.length) return prev;
                if (id === sessionId) {
                    const fallback = next[next.length - 1];
                    if (fallback) switchToSession(fallback.id, { shareToken: fallback.shareToken });
                }
                return next;
            });
        },
        [sessionId, switchToSession],
    );

    useEffect(() => {
        try {
            window.sessionStorage.setItem(tabsStorageKey, JSON.stringify(sessionTabs));
        } catch {
            // ignore
        }
    }, [sessionTabs]);

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
            const shareHeaders = sessionShareToken ? { 'x-session-share': sessionShareToken } : undefined;
            const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/save`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(shareHeaders ?? {}) },
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
    }, [me, nameInput, requestAuth, sessionId, sessionShareToken, setSessionMeta, setSessionSavers]);

    const saveForMe = useCallback(async () => {
        if (!sessionId) return;
        if (!me) {
            requestAuth();
            return;
        }
        setBusy(true);
        const name = (sessionName ?? '').trim() || 'Untitled session';
        try {
            const shareHeaders = sessionShareToken ? { 'x-session-share': sessionShareToken } : undefined;
            const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/save`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(shareHeaders ?? {}) },
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
    }, [me, requestAuth, sessionId, sessionName, sessionShareToken, setSessionMeta, setSessionSavers, sessionOwnerId]);

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

    useEffect(() => {
        if (!sessionId) return;
        upsertSessionTab(sessionId, sessionName ?? null, sessionShareToken ?? null);
    }, [sessionId, sessionName, sessionShareToken, upsertSessionTab]);

    useEffect(() => {
        if (!sessions.length) return;
        setSessionTabs((prev) => {
            let changed = false;
            const next = prev.map((tab) => {
                const match = sessions.find((item) => item.id === tab.id);
                if (!match || !match.name || match.name === tab.name) return tab;
                changed = true;
                return { ...tab, name: match.name };
            });
            return changed ? next : prev;
        });
    }, [sessions]);

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
            if (e.key !== 'Escape') return;
            if (linkPrompt) return;
            closeSessionsMenu();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [closeSessionsMenu, linkPrompt, showSessions]);

    useEffect(() => {
        if (!linkPrompt) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setLinkPrompt(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [linkPrompt]);

    useEffect(() => {
        if (!linkPrompt) return;
        const t = window.setTimeout(() => {
            linkPromptInputRef.current?.focus();
            linkPromptInputRef.current?.select();
        }, 0);
        return () => window.clearTimeout(t);
    }, [linkPrompt]);

    useEffect(() => {
        setShowSessions(false);
    }, [sessionId, sessionSaved]);

    useEffect(() => {
        if (!showSessions) return;
        setCurrentNameDraft(sessionName ?? '');
    }, [sessionName, showSessions]);

    const copyToClipboard = useCallback(async (text: string) => {
        if (!navigator.clipboard?.writeText) return false;
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            return false;
        }
    }, []);

    const handleShareSession = useCallback(
        async (id: string) => {
            if (sessionActionBusy) return;
            setSessionActionBusy(id);
            try {
                const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/share`, { method: 'POST' });
                if (!res.ok) {
                    setToast('Не удалось создать ссылку');
                    return;
                }
                const data = await res.json().catch(() => ({}));
                const url = typeof data?.url === 'string' ? data.url : null;
                if (!url) {
                    setToast('Не удалось создать ссылку');
                    return;
                }
                const ok = await copyToClipboard(url);
                if (!ok) {
                    setLinkPrompt({ title: 'Share link', url });
                } else {
                    setLinkPrompt(null);
                }
                setToast(ok ? 'Ссылка скопирована' : 'Ссылка готова к копированию');
            } catch {
                setToast('Не удалось создать ссылку');
            } finally {
                setSessionActionBusy(null);
            }
        },
        [copyToClipboard, sessionActionBusy],
    );

    const handleOpenSession = useCallback(
        (id: string) => {
            if (!id) return;
            const matched = sessions.find((item) => item.id === id);
            upsertSessionTab(id, matched?.name ?? null, null);
            switchToSession(id);
            closeSessionsMenu();
        },
        [closeSessionsMenu, sessions, switchToSession, upsertSessionTab],
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
                setSessionTabs((prev) => prev.filter((tab) => tab.id !== id));
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
                    upsertSessionTab(nextId, null, null);
                    switchToSession(nextId, { reset: true });
                }
            } finally {
                setSessionActionBusy(null);
            }
        },
        [sessionActionBusy, sessionId, switchToSession, upsertSessionTab],
    );

    const currentSessionItem = useMemo(() => {
        if (!sessionId) return null;
        const fromList = sessions.find((item) => item.id === sessionId);
        if (fromList) return fromList;
        return { id: sessionId, name: sessionName ?? null, savedAt: null, updatedAt: null };
    }, [sessionId, sessionName, sessions]);

    const otherSessions = useMemo(() => sessions.filter((item) => item.id !== sessionId), [sessionId, sessions]);
    const canCloseTabs = sessionTabs.length > 1;
    const getTabLabel = useCallback(
        (tab: SessionTab) => {
            if (tab.id === sessionId) return displaySessionName;
            if (tab.name && tab.name.trim()) return tab.name;
            return t('session.untitled', 'Untitled session');
        },
        [displaySessionName, sessionId, t],
    );

    const formatUpdatedAt = useCallback((value: string | null) => {
        if (!value) return t('session.noActivity', 'No activity');
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return t('session.noActivity', 'No activity');
        return date.toLocaleString(localeTag, { dateStyle: 'medium', timeStyle: 'short' });
    }, [localeTag, t]);

    const handleCreateNewSession = useCallback(async () => {
        if (sessionActionBusy) return;
        setSessionActionBusy('new');
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
                        layers: useStore.getState().layers,
                        tombstones: { nodes: {}, edges: {}, drawings: {}, textBoxes: {}, comments: {}, layers: {} },
                    },
                }),
            });
            if (!res.ok) throw new Error('Failed to create session');
            const data = await res.json();
            const id = typeof data?.id === 'string' ? data.id : null;
            if (!id) throw new Error('Invalid session id');
            upsertSessionTab(id, null, null);
            switchToSession(id, { reset: true });
            closeSessionsMenu();
        } catch {
            setToast('Не удалось создать сессию');
        } finally {
            setSessionActionBusy(null);
        }
    }, [closeSessionsMenu, sessionActionBusy, switchToSession, upsertSessionTab]);

    const handleCopySession = useCallback(
        async (id: string) => {
            if (sessionActionBusy) return;
            setSessionActionBusy(id);
            try {
                let newId: string | null = null;
                if (id === sessionId) {
                    const snapshot = ((s) => ({
                        nodes: s.nodes,
                        edges: s.edges,
                        drawings: s.drawings,
                        textBoxes: s.textBoxes,
                        comments: s.comments,
                        layers: s.layers,
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
                upsertSessionTab(newId, null, null);
                switchToSession(newId, { reset: true });
                closeSessionsMenu();
            } catch {
                setToast('Не удалось скопировать сессию');
            } finally {
                setSessionActionBusy(null);
            }
        },
        [closeSessionsMenu, sessionActionBusy, sessionId, switchToSession, upsertSessionTab],
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

    const handleCopyShareLink = useCallback(async () => {
        if (!linkPrompt) return;
        const ok = await copyToClipboard(linkPrompt.url);
        if (ok) {
            setToast('Ссылка скопирована');
            setLinkPrompt(null);
            return;
        }
        setToast('Скопируйте ссылку вручную');
        linkPromptInputRef.current?.focus();
        linkPromptInputRef.current?.select();
    }, [copyToClipboard, linkPrompt]);

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
                        className={styles.sessionsButton}
                        title="Sessions"
                        onClick={openSessionsMenu}
                        disabled={!canOpenSessions}
                    >
                        Sessions
                    </button>
                ) : null}
                {sessionId && sessionTabs.length > 1 && (
                    <div className={styles.tabsBar} role="tablist" aria-label="Session tabs">
                        {sessionTabs.map((tab) => {
                            const active = tab.id === sessionId;
                            return (
                                <div
                                    key={tab.id}
                                    className={`${styles.tab} ${active ? styles.tabActive : ''}`}
                                    role="tab"
                                    aria-selected={active}
                                >
                                    <button
                                        type="button"
                                        className={styles.tabButton}
                                        onClick={() => switchToSession(tab.id, { shareToken: tab.shareToken })}
                                        title={getTabLabel(tab)}
                                    >
                                        <span className={styles.tabLabel}>{getTabLabel(tab)}</span>
                                    </button>
                                    {canCloseTabs && (
                                        <button
                                            type="button"
                                            className={styles.tabClose}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                closeSessionTab(tab.id);
                                            }}
                                            title="Close tab"
                                            aria-label="Close tab"
                                        >
                                            <X size={12} />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
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

            {linkPrompt && (
                <>
                    <div className={styles.linkBackdrop} onPointerDown={() => setLinkPrompt(null)} />
                    <div className={`${styles.prompt} ${styles.linkPrompt}`} onPointerDown={(e) => e.stopPropagation()}>
                        <div className={styles.promptTitle}>{linkPrompt.title}</div>
                        <input
                            ref={linkPromptInputRef}
                            className={styles.promptInput}
                            value={linkPrompt.url}
                            readOnly
                            onFocus={(e) => e.currentTarget.select()}
                        />
                        <div className={styles.promptActions}>
                            <button type="button" className={styles.promptButton} onClick={() => setLinkPrompt(null)}>
                                Close
                            </button>
                            <button
                                type="button"
                                className={`${styles.promptButton} ${styles.promptButtonPrimary}`}
                                onClick={handleCopyShareLink}
                            >
                                Copy
                            </button>
                        </div>
                    </div>
                </>
            )}

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
