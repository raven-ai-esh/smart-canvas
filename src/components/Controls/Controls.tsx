import React, { useEffect, useRef, useState } from 'react';
import { Atom, Hand, Moon, Sun, PenTool, Eraser, Highlighter, Type, X, Link2, Plus, Copy, Share2, Loader2, Monitor, Snowflake, Grid3x3, Eye, Paintbrush } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { PenToolType } from '../../types';

const BUTTON_SIZE = 48;
const BUTTON_GAP = 12;
const BUTTON_STEP = BUTTON_SIZE + BUTTON_GAP;

type ControlButtonProps = {
    title: string;
    onClick?: () => void;
    active?: boolean;
    disabled?: boolean;
    borderColor?: string;
    iconColor?: string;
    inactiveBackgroundColor?: string;
    buttonStyle?: React.CSSProperties;
    children: React.ReactNode;
};

const ControlButton: React.FC<ControlButtonProps> = ({ title, onClick, active, disabled, borderColor, iconColor, inactiveBackgroundColor, buttonStyle, children }) => {
    const [pressed, setPressed] = useState(false);
    const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number; size: number }>>([]);

    const baseStyle: React.CSSProperties = {
        background: active ? 'var(--accent-primary)' : (inactiveBackgroundColor ?? 'var(--bg-node)'),
        border: `1px solid ${borderColor ?? 'var(--text-dim)'}`,
        borderRadius: '50%',
        width: `${BUTTON_SIZE}px`,
        height: `${BUTTON_SIZE}px`,
        padding: 0,
        color: active ? '#fff' : (iconColor ?? 'var(--text-primary)'),
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: pressed ? '0 2px 6px rgba(0,0,0,0.25)' : '0 4px 12px rgba(0,0,0,0.3)',
        transition: 'transform 120ms ease, box-shadow 120ms ease, background 180ms ease, color 180ms ease',
        outline: 'none',
        touchAction: 'manipulation',
        transform: pressed ? 'scale(0.92)' : 'scale(1)',
        WebkitTapHighlightColor: 'transparent',
        opacity: disabled ? 0.6 : 1,
        position: 'relative',
        overflow: 'hidden',
        ...buttonStyle,
    };

    return (
        <button
            onClick={disabled ? undefined : onClick}
            title={title}
            style={baseStyle}
            disabled={disabled}
            onPointerDown={(e) => {
                if (disabled) return;
                setPressed(true);
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const size = Math.max(rect.width, rect.height) * 1.8;
                const id = Date.now() + Math.floor(Math.random() * 1000);
                setRipples((r) => [...r, { id, x, y, size }]);
                window.setTimeout(() => {
                    setRipples((r) => r.filter((rr) => rr.id !== id));
                }, 620);
            }}
            onPointerUp={() => setPressed(false)}
            onPointerCancel={() => setPressed(false)}
            onPointerLeave={() => setPressed(false)}
            aria-pressed={!!active}
        >
            <span style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                {ripples.map((r) => (
                    <span
                        key={r.id}
                        style={{
                            position: 'absolute',
                            left: r.x,
                            top: r.y,
                            width: r.size,
                            height: r.size,
                            marginLeft: -r.size / 2,
                            marginTop: -r.size / 2,
                            borderRadius: 9999,
                            background:
                                'radial-gradient(circle, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0.18) 25%, rgba(255,255,255,0.06) 45%, rgba(255,255,255,0) 70%)',
                            transform: 'scale(0.05)',
                            animation: 'controlsRipple 600ms ease-out forwards',
                            filter: 'blur(0.2px)',
                        }}
                    />
                ))}
            </span>
            {children}
        </button>
    );
};

export const Controls: React.FC = () => {
    const { physicsEnabled, togglePhysicsMode, moveMode, toggleMoveMode, snapMode, toggleSnapMode, focusMode, toggleFocusMode, theme, toggleTheme, penMode, togglePenMode, penTool, setPenTool, textMode, toggleTextMode, snowEnabled, toggleSnow } = useStore();

    const controlsRootRef = useRef<HTMLDivElement | null>(null);

    // Tool menu visibility
    const [showToolMenu, setShowToolMenu] = useState(false);
    const [showShareMenu, setShowShareMenu] = useState(false);
    const [showDisplayMenu, setShowDisplayMenu] = useState(false);
    const [showModeMenu, setShowModeMenu] = useState(false);
    const [shareBusy, setShareBusy] = useState<null | 'new' | 'clone'>(null);
    const [toastText, setToastText] = useState<string | null>(null);
    const [toastVisible, setToastVisible] = useState(false);

    // Orientation detection (more reliable on iPad than innerWidth/innerHeight during rotation)
    const [isLandscape, setIsLandscape] = useState(
        window.matchMedia('(orientation: landscape)').matches
    );

    const [isSmallScreen, setIsSmallScreen] = useState(
        window.matchMedia?.('(max-width: 520px)')?.matches ?? window.innerWidth <= 520
    );

    useEffect(() => {
        const mq = window.matchMedia?.('(orientation: landscape)');
        const checkOrientation = () => {
            setIsLandscape(mq ? mq.matches : window.innerWidth > window.innerHeight);
        };
        checkOrientation();
        window.addEventListener('resize', checkOrientation);
        window.addEventListener('orientationchange', checkOrientation);
        mq?.addEventListener?.('change', checkOrientation);
        return () => {
            window.removeEventListener('resize', checkOrientation);
            window.removeEventListener('orientationchange', checkOrientation);
            mq?.removeEventListener?.('change', checkOrientation);
        };
    }, []);

    useEffect(() => {
        const mq = window.matchMedia?.('(max-width: 520px)');
        const onChange = () => setIsSmallScreen(mq ? mq.matches : window.innerWidth <= 520);
        onChange();
        window.addEventListener('resize', onChange);
        mq?.addEventListener?.('change', onChange);
        return () => {
            window.removeEventListener('resize', onChange);
            mq?.removeEventListener?.('change', onChange);
        };
    }, []);

    useEffect(() => {
        if (theme === 'light') {
            document.body.classList.add('light-theme');
        } else {
            document.body.classList.remove('light-theme');
        }
    }, [theme]);

    useEffect(() => {
        if (!toastText) return;
        setToastVisible(true);
        const hide = window.setTimeout(() => setToastVisible(false), 1200);
        const clear = window.setTimeout(() => setToastText(null), 1700);
        return () => {
            window.clearTimeout(hide);
            window.clearTimeout(clear);
        };
    }, [toastText]);

    useEffect(() => {
        const handlePointerDown = (e: PointerEvent) => {
            if (e.pointerType === 'pen') return;
            const root = controlsRootRef.current;
            if (!root) return;
            if (root.contains(e.target as Node)) return;
            setShowToolMenu(false);
            setShowShareMenu(false);
            setShowDisplayMenu(false);
            setShowModeMenu(false);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, []);

    useEffect(() => {
        if (!focusMode) return;
        setShowToolMenu(false);
        setShowShareMenu(false);
        setShowDisplayMenu(false);
        setShowModeMenu(false);
    }, [focusMode]);

    const handlePenClick = () => {
        setShowDisplayMenu(false);
        setShowShareMenu(false);
        setShowModeMenu(false);
        setShowToolMenu(!showToolMenu);
    };

    const handleTextClick = () => {
        setShowToolMenu(false);
        setShowShareMenu(false);
        setShowDisplayMenu(false);
        setShowModeMenu(false);
        toggleTextMode();
    };

    const handleToolSelect = (tool: PenToolType) => {
        setPenTool(tool);
        if (!penMode) togglePenMode();
        setShowToolMenu(false);
    };

    const handleClose = () => {
        if (penMode) togglePenMode();
        setShowToolMenu(false);
    };

    const handleShareClick = () => {
        setShowToolMenu(false);
        setShowDisplayMenu(false);
        setShowModeMenu(false);
        setShowShareMenu((v) => !v);
    };
    const handleCloseShare = () => setShowShareMenu(false);

    const handleDisplayClick = () => {
        setShowToolMenu(false);
        setShowShareMenu(false);
        setShowModeMenu(false);
        setShowDisplayMenu((v) => !v);
    };

    const handleModeClick = () => {
        setShowToolMenu(false);
        setShowShareMenu(false);
        setShowDisplayMenu(false);
        setShowModeMenu((v) => !v);
    };

    const handleFocusClick = () => {
        setShowToolMenu(false);
        setShowShareMenu(false);
        setShowDisplayMenu(false);
        setShowModeMenu(false);
        toggleFocusMode();
    };

    const copyToClipboard = async (text: string) => {
        const copy = async (text: string) => {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                // Clipboard may be blocked (non-https, permissions). Fallback:
                window.prompt('Copy session link:', text);
                return false;
            }
        };
        return copy(text);
    };

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
  .card { max-width: 520px; width: 100%; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 20px; }
  .bar { height: 6px; border-radius: 999px; background: rgba(255,255,255,0.14); overflow: hidden; margin-top: 12px; }
  .bar > div { height: 100%; width: 40%; background: rgba(255,255,255,0.55); animation: l 1.1s ease-in-out infinite; border-radius: 999px; }
  @keyframes l { 0% { transform: translateX(-120%);} 100% { transform: translateX(260%);} }
</style></head><body><div class="wrap"><div class="card">
  <div>Создаём сессию…</div>
  <div class="bar"><div></div></div>
</div></div></body></html>`,
            );
            w.document.close();
        } catch {
            // ignore
        }
        return w;
    };

    const ensureSessionId = async () => {
        const url = new URL(window.location.href);
        const existing = url.searchParams.get('session');
        if (existing) return existing;

        try {
            const settingsRes = await fetch('/api/settings/default-session');
            if (settingsRes.ok) {
                const settings = await settingsRes.json();
                const id = typeof settings?.id === 'string' ? settings.id : null;
                if (id) {
                    url.searchParams.set('session', id);
                    window.history.replaceState({}, '', url.toString());
                    return id;
                }
            }

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
            if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
            const data = await res.json();
            const id = data?.id;
            if (typeof id !== 'string' || !id) throw new Error('Invalid session id');

            url.searchParams.set('session', id);
            window.history.replaceState({}, '', url.toString());
            return id;
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error(e);
        }
    };

    const handleCopyCurrentSessionLink = async () => {
        const id = await ensureSessionId();
        if (!id) return;
        const url = new URL(window.location.href);
        url.searchParams.set('session', id);
        const ok = await copyToClipboard(url.toString());
        setToastText(ok ? 'Ссылка скопирована' : 'Ссылка для копирования открыта');
        setShowShareMenu(false);
    };

    const handleCreateNewEmptySession = async () => {
        if (shareBusy) return;
        setShareBusy('new');
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
                        tombstones: { nodes: {}, edges: {}, drawings: {}, textBoxes: {} },
                    },
                }),
            });
            if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
            const data = await res.json();
            const id = data?.id;
            if (typeof id !== 'string' || !id) throw new Error('Invalid session id');

            const url = new URL(window.location.href);
            url.searchParams.set('session', id);
            url.searchParams.set('reset', '1');
            if (w) w.location.href = url.toString();
            else window.open(url.toString(), '_blank');
            setShowShareMenu(false);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error(e);
            try {
                w?.close();
            } catch {
                // ignore
            }
            setToastText('Не удалось создать сессию');
        } finally {
            setShareBusy(null);
        }
    };

    const handleCreateClonedSession = async () => {
        if (shareBusy) return;
        setShareBusy('clone');
        const w = openLoadingTab();
        try {
            const sourceId = await ensureSessionId();
            if (!sourceId) throw new Error('No session id');

            let res = await fetch(`/api/sessions/${encodeURIComponent(sourceId)}/clone`, { method: 'POST' });
            if (!res.ok) {
                // Backward-compatible fallback: client-side clone by uploading snapshot.
                const snapshot = ((s) => ({
                    nodes: s.nodes,
                    edges: s.edges,
                    drawings: s.drawings,
                    textBoxes: s.textBoxes,
                    tombstones: { nodes: {}, edges: {}, drawings: {}, textBoxes: {} },
                }))(useStore.getState());

                res = await fetch('/api/sessions', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ state: snapshot }),
                });
            }
            if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
            const data = await res.json();
            const id = data?.id;
            if (typeof id !== 'string' || !id) throw new Error('Invalid session id');

            const url = new URL(window.location.href);
            url.searchParams.set('session', id);
            url.searchParams.set('reset', '1');
            if (w) w.location.href = url.toString();
            else window.open(url.toString(), '_blank');
            setShowShareMenu(false);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error(e);
            try {
                w?.close();
            } catch {
                // ignore
            }
            setToastText('Не удалось склонировать сессию');
        } finally {
            setShareBusy(null);
        }
    };

    // Mobile-friendly positioning:
    // - small screens: keep controls closer to the bottom
    // - account for visualViewport offsets to avoid jumping when keyboard/autofill UI appears
    const baseBottom = isSmallScreen ? (isLandscape ? 12 : 18) : (isLandscape ? 44 : 60);
    const bottomPadding = `calc(${baseBottom}px + env(safe-area-inset-bottom, 0px))`;
    const toastBottom = `calc(${baseBottom}px + env(safe-area-inset-bottom, 0px) + 70px)`;

    const shareMenuBorderColor = theme === 'light' ? undefined : 'var(--border-share-menu)';
    const shareMenuIconColor = theme === 'light' ? 'var(--border-share-menu)' : undefined;
    const penMenuBorderColor = theme === 'light' ? undefined : 'var(--accent-primary)';
    const penMenuInactiveFill = theme === 'light' ? 'var(--accent-glow)' : undefined;
    const displayMenuBorderColor = theme === 'light' ? undefined : 'var(--border-display-menu)';
    const displayMenuIconColor = theme === 'light' ? 'var(--border-display-menu)' : undefined;

    const baseRowButtonCount = 6;
    const modeAnchorOffset = (1 - (baseRowButtonCount - 1) / 2) * BUTTON_STEP;
    const penAnchorOffset = (2 - (baseRowButtonCount - 1) / 2) * BUTTON_STEP; // Move, Modes, Pen, Text, Display, Share
    const displayAnchorOffset = (4 - (baseRowButtonCount - 1) / 2) * BUTTON_STEP;
    const shareAnchorOffset = (5 - (baseRowButtonCount - 1) / 2) * BUTTON_STEP;

    // Sub-menus should “grow” vertically from their base button.
    // Place the submenu so its bottom-most button sits just above the base row.
    const subStackBottom = `calc(${baseBottom}px + env(safe-area-inset-bottom, 0px) + ${BUTTON_STEP}px)`;

    return (
        <div ref={controlsRootRef}>
            <style>{`
	              @keyframes controlsSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
	              .controlsSpin { animation: controlsSpin 0.9s linear infinite; }
                  @keyframes controlsRipple {
                    0% { transform: scale(0.05); opacity: 0.65; }
                    100% { transform: scale(1); opacity: 0; }
                  }
                  @keyframes controlsSubRowIn {
                    0% { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.96); filter: blur(0.8px); }
                    100% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); filter: blur(0); }
                  }
                  @keyframes controlsSubBtnIn {
                    0% { opacity: 0; transform: translateY(12px) scale(0.92); }
                    100% { opacity: 1; transform: translateY(0) scale(1); }
                  }
	            `}</style>

	            {toastText && (
	                <div
	                    style={{
	                        position: 'fixed',
	                        left: '50%',
	                        bottom: toastBottom,
	                        transform: `translateX(-50%) translateY(${toastVisible ? 0 : 8}px)`,
	                        opacity: toastVisible ? 1 : 0,
	                        transition: 'opacity 220ms ease, transform 220ms ease',
	                        pointerEvents: 'none',
                        zIndex: 2000,
                        background: 'var(--bg-node)',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 12,
                        padding: '8px 10px',
                        boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                        color: 'var(--text-primary)',
                        fontSize: 13,
                    }}
                >
                    {toastText}
                </div>
	            )}

	                {/* Secondary stack for Pen menu (vertical from base button) */}
	                {!focusMode && showToolMenu && (
	                    <div
	                        style={{
	                            position: 'fixed',
	                            left: `calc(50% + ${penAnchorOffset}px)`,
	                            bottom: subStackBottom,
	                            transform: 'translateX(-50%)',
	                            zIndex: 1600,
	                            display: 'flex',
	                            flexDirection: 'column-reverse',
	                            gap: BUTTON_GAP,
	                            animation: 'controlsSubRowIn 180ms ease-out both',
	                            transformOrigin: '50% 100%',
	                            pointerEvents: 'auto',
	                        }}
	                    >
                        {[
                            {
                                key: 'pen',
                                title: 'Pen',
                                onClick: () => handleToolSelect('pen' as PenToolType),
                                active: penTool === 'pen' && penMode,
                                child: <PenTool size={18} />,
                            },
                            {
                                key: 'eraser',
                                title: 'Eraser',
                                onClick: () => handleToolSelect('eraser' as PenToolType),
                                active: penTool === 'eraser' && penMode,
                                child: <Eraser size={18} />,
                            },
                            {
                                key: 'highlighter',
                                title: 'Marker',
                                onClick: () => handleToolSelect('highlighter' as PenToolType),
                                active: penTool === 'highlighter' && penMode,
                                child: <Highlighter size={18} />,
                            },
                            {
                                key: 'close',
                                title: 'Close Pen Mode',
                                onClick: handleClose,
                                active: false,
                                child: <X size={18} />,
                            },
	                        ].map((b, idx) => (
	                            <div key={b.key} style={{ animation: 'controlsSubBtnIn 220ms ease-out both', animationDelay: `${idx * 35}ms` }}>
	                                <ControlButton
	                                    onClick={b.onClick}
	                                    title={b.title}
	                                    active={b.active}
                                    borderColor={penMenuBorderColor}
                                    inactiveBackgroundColor={penMenuInactiveFill}
                                >
                                    {b.child}
                                </ControlButton>
                            </div>
	                        ))}
	                    </div>
	                )}

                {/* Secondary stack for Share menu (vertical from base button) */}
                {!focusMode && showShareMenu && (
	                    <div
	                        style={{
	                            position: 'fixed',
	                            left: `calc(50% + ${shareAnchorOffset}px)`,
	                            bottom: subStackBottom,
	                            transform: 'translateX(-50%)',
	                            zIndex: 1600,
	                            display: 'flex',
	                            flexDirection: 'column-reverse',
	                            gap: BUTTON_GAP,
	                            animation: 'controlsSubRowIn 180ms ease-out both',
	                            transformOrigin: '50% 100%',
	                            pointerEvents: 'auto',
	                        }}
	                    >
                        {[
                            {
                                key: 'new',
                                title: 'New session (new tab)',
                                onClick: handleCreateNewEmptySession,
                                disabled: shareBusy !== null,
                                child: shareBusy === 'new' ? <Loader2 size={18} className="controlsSpin" /> : <Plus size={18} />,
                            },
                            {
                                key: 'clone',
                                title: 'Clone session (new tab)',
                                onClick: handleCreateClonedSession,
                                disabled: shareBusy !== null,
                                child: shareBusy === 'clone' ? <Loader2 size={18} className="controlsSpin" /> : <Copy size={18} />,
                            },
                            {
                                key: 'copy',
                                title: 'Copy current session link',
                                onClick: handleCopyCurrentSessionLink,
                                disabled: shareBusy !== null,
                                child: <Share2 size={18} />,
                            },
                            {
                                key: 'close',
                                title: 'Close Share',
                                onClick: handleCloseShare,
                                disabled: shareBusy !== null,
                                child: <X size={18} />,
                            },
                        ].map((b, idx) => (
                            <div key={b.key} style={{ animation: 'controlsSubBtnIn 220ms ease-out both', animationDelay: `${idx * 35}ms` }}>
                                <ControlButton
                                    onClick={b.onClick}
                                    title={b.title}
                                    disabled={b.disabled}
                                    borderColor={shareMenuBorderColor}
                                    iconColor={shareMenuIconColor}
                                >
                                    {b.child}
                                </ControlButton>
                            </div>
                        ))}
                    </div>
                )}

                {/* Secondary stack for Display menu (Theme + Snow) */}
                {!focusMode && showDisplayMenu && (
                    <div
                        style={{
                            position: 'fixed',
                            left: `calc(50% + ${displayAnchorOffset}px)`,
                            bottom: subStackBottom,
                            transform: 'translateX(-50%)',
                            zIndex: 1600,
                            display: 'flex',
                            flexDirection: 'column-reverse',
                            gap: BUTTON_GAP,
                            animation: 'controlsSubRowIn 180ms ease-out both',
                            transformOrigin: '50% 100%',
                            pointerEvents: 'auto',
                        }}
                    >
                        {[
                            {
                                key: 'theme',
                                title: theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode',
                                onClick: toggleTheme,
                                active: false,
                                child: theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />,
                            },
                            {
                                key: 'snow',
                                title: snowEnabled ? 'Disable Snow' : 'Enable Snow',
                                onClick: toggleSnow,
                                active: snowEnabled,
                                child: <Snowflake size={18} />,
                            },
                        ].map((b, idx) => (
                            <div key={b.key} style={{ animation: 'controlsSubBtnIn 220ms ease-out both', animationDelay: `${idx * 35}ms` }}>
                                <ControlButton
                                    onClick={b.onClick}
                                    title={b.title}
                                    active={b.active}
                                    borderColor={displayMenuBorderColor}
                                    iconColor={displayMenuIconColor}
                                >
                                    {b.child}
                                </ControlButton>
                            </div>
                        ))}
                    </div>
                )}

                {/* Secondary stack for Mode menu (Physics + Grid + Focus) */}
                {!focusMode && showModeMenu && (
                    <div
                        style={{
                            position: 'fixed',
                            left: `calc(50% + ${modeAnchorOffset}px)`,
                            bottom: subStackBottom,
                            transform: 'translateX(-50%)',
                            zIndex: 1600,
                            display: 'flex',
                            flexDirection: 'column-reverse',
                            gap: BUTTON_GAP,
                            animation: 'controlsSubRowIn 180ms ease-out both',
                            transformOrigin: '50% 100%',
                            pointerEvents: 'auto',
                        }}
                    >
                        {[
                            {
                                key: 'physics',
                                title: physicsEnabled ? 'Disable Physics' : 'Enable Physics',
                                onClick: togglePhysicsMode,
                                active: physicsEnabled,
                                child: <Atom size={18} />,
                            },
                            {
                                key: 'grid',
                                title: snapMode ? 'Disable Grid Snap' : 'Grid + Align',
                                onClick: toggleSnapMode,
                                active: snapMode,
                                child: <Grid3x3 size={18} />,
                            },
                            {
                                key: 'focus',
                                title: focusMode ? 'Disable Focus Mode' : 'Enable Focus Mode',
                                onClick: handleFocusClick,
                                active: focusMode,
                                child: <Eye size={18} />,
                            },
                        ].map((b, idx) => (
                            <div key={b.key} style={{ animation: 'controlsSubBtnIn 220ms ease-out both', animationDelay: `${idx * 35}ms` }}>
                                <ControlButton
                                    onClick={b.onClick}
                                    title={b.title}
                                    active={b.active}
                                >
                                    {b.child}
                                </ControlButton>
                            </div>
                        ))}
                    </div>
                )}

                {/* Base row */}
	            <div style={{
	                position: 'fixed',
	                bottom: bottomPadding,
	                left: '50%',
	                transform: 'translateX(-50%)',
	                zIndex: 1600,
	                display: 'flex',
	                gap: BUTTON_GAP,
                    pointerEvents: 'auto',
	            }}>
                    {focusMode ? (
                        <ControlButton
                            onClick={handleFocusClick}
                            title="Disable Focus Mode"
                            active
                            buttonStyle={{ opacity: 0.55 }}
                        >
                            <Eye size={18} />
                        </ControlButton>
                    ) : (
                        <>
                            <ControlButton
                                onClick={toggleMoveMode}
                                title={moveMode ? 'Disable Move' : 'Move canvas'}
                                active={moveMode}
                            >
                                <Hand size={18} />
                            </ControlButton>

                            <ControlButton
                                onClick={handleModeClick}
                                title="Modes"
                                active={showModeMenu || physicsEnabled || snapMode || focusMode}
                            >
                                <Monitor size={18} />
                            </ControlButton>

		                    <ControlButton
		                        onClick={handlePenClick}
		                        title="Pen Mode"
		                        active={penMode || showToolMenu}
	                        >
	                            {penTool === 'eraser' ? <Eraser size={18} /> :
	                                penTool === 'highlighter' ? <Highlighter size={18} /> :
	                                    <PenTool size={18} />}
	                        </ControlButton>

                        <ControlButton
                            onClick={handleTextClick}
                            title={textMode ? 'Disable Text' : 'Text'}
                            active={textMode}
                        >
                            <Type size={18} />
                        </ControlButton>

                        <ControlButton
                            onClick={handleDisplayClick}
                            title="Display"
                            active={showDisplayMenu}
                        >
                            <Paintbrush size={18} />
                        </ControlButton>

	                    <ControlButton
	                        onClick={handleShareClick}
	                        title="Share"
	                        active={showShareMenu}
	                    >
	                        <Link2 size={18} />
	                    </ControlButton>
                        </>
                    )}
	            </div>
	        </div>
	    );
};
