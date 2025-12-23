import React, { useEffect, useRef, useState } from 'react';
import { Activity, Hand, PenTool, Eraser, Highlighter, Type, X, SlidersHorizontal, Grid3x3, Eye, CircleDot, StickyNote, Network } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { PenToolType } from '../../types';

const BUTTON_SIZE = 48;
const BUTTON_GAP = 12;
const BUTTON_STEP = BUTTON_SIZE + BUTTON_GAP;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_DETAIL_THRESHOLD = 1.1;
const ZOOM_GRAPH_THRESHOLD = 0.6;
const ZOOM_EPS = 0.02;
const ZOOM_DETAIL = ZOOM_DETAIL_THRESHOLD + ZOOM_EPS;
const ZOOM_NORMAL = 1;
const ZOOM_GRAPH = ZOOM_GRAPH_THRESHOLD - ZOOM_EPS;

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
    const { moveMode, toggleMoveMode, snapMode, toggleSnapMode, focusMode, toggleFocusMode, monitoringMode, toggleMonitoringMode, theme, penMode, togglePenMode, penTool, setPenTool, textMode, toggleTextMode, canvas, setCanvasTransform } = useStore();

    const controlsRootRef = useRef<HTMLDivElement | null>(null);

    // Tool menu visibility
    const [showToolMenu, setShowToolMenu] = useState(false);
    const [showModeMenu, setShowModeMenu] = useState(false);
    const [showZoomMenu, setShowZoomMenu] = useState(false);
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
            // Keep menus open while actively drawing with pen mode, but allow pen taps to close otherwise.
            if (e.pointerType === 'pen' && penMode) return;
            const root = controlsRootRef.current;
            if (!root) return;
            if (root.contains(e.target as Node)) return;
            setShowToolMenu(false);
            setShowModeMenu(false);
            setShowZoomMenu(false);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [penMode]);

    useEffect(() => {
        if (!focusMode) return;
        setShowToolMenu(false);
        setShowModeMenu(false);
        setShowZoomMenu(false);
    }, [focusMode]);

    const handlePenClick = () => {
        setShowModeMenu(false);
        setShowZoomMenu(false);
        setShowToolMenu(!showToolMenu);
    };

    const handleTextClick = () => {
        setShowToolMenu(false);
        setShowModeMenu(false);
        setShowZoomMenu(false);
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

    const handleModeClick = () => {
        setShowToolMenu(false);
        setShowZoomMenu(false);
        setShowModeMenu((v) => !v);
    };

    const handleFocusClick = () => {
        setShowToolMenu(false);
        setShowModeMenu(false);
        setShowZoomMenu(false);
        toggleFocusMode();
    };

    const handleZoomClick = () => {
        setShowToolMenu(false);
        setShowModeMenu(false);
        setShowZoomMenu((v) => !v);
    };

    const applyZoomPreset = (targetScale: number, label: string) => {
        const viewport = window.visualViewport;
        const width = viewport?.width ?? window.innerWidth;
        const height = viewport?.height ?? window.innerHeight;
        const centerX = width / 2;
        const centerY = height / 2;
        const worldX = (centerX - canvas.x) / canvas.scale;
        const worldY = (centerY - canvas.y) / canvas.scale;
        const nextScale = Math.min(Math.max(targetScale, MIN_ZOOM), MAX_ZOOM);
        const nextX = centerX - worldX * nextScale;
        const nextY = centerY - worldY * nextScale;
        setCanvasTransform(nextX, nextY, nextScale);
        setShowZoomMenu(false);
        setToastText(label);
    };

    const zoomPresetKey = (() => {
        const scale = canvas.scale;
        const closeTo = (target: number) => Math.abs(scale - target) <= 0.08;
        if (closeTo(ZOOM_DETAIL)) return 'detail';
        if (closeTo(ZOOM_GRAPH)) return 'graph';
        if (closeTo(ZOOM_NORMAL)) return 'normal';
        return null;
    })();

    // Mobile-friendly positioning:
    // - small screens: keep controls closer to the bottom
    // - account for visualViewport offsets to avoid jumping when keyboard/autofill UI appears
    const baseBottom = isSmallScreen ? (isLandscape ? 12 : 18) : (isLandscape ? 44 : 60);
    const bottomPadding = `calc(${baseBottom}px + env(safe-area-inset-bottom, 0px))`;
    const toastBottom = `calc(${baseBottom}px + env(safe-area-inset-bottom, 0px) + 70px)`;

    const penMenuBorderColor = theme === 'light' ? undefined : 'var(--accent-primary)';
    const penMenuInactiveFill = theme === 'light' ? 'var(--accent-glow)' : undefined;

    const baseRowButtonCount = 5;
    const modeAnchorOffset = (1 - (baseRowButtonCount - 1) / 2) * BUTTON_STEP;
    const zoomAnchorOffset = (2 - (baseRowButtonCount - 1) / 2) * BUTTON_STEP;
    const penAnchorOffset = (3 - (baseRowButtonCount - 1) / 2) * BUTTON_STEP; // Move, Modes, Zoom, Pen, Text
    const zoomIcon = zoomPresetKey === 'detail'
        ? <StickyNote size={18} />
        : zoomPresetKey === 'graph'
            ? <Network size={18} />
            : <CircleDot size={18} />;

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
	                {!focusMode && (
	                    <div
	                        style={{
	                            position: 'fixed',
	                            left: `calc(50% + ${penAnchorOffset}px)`,
	                            bottom: subStackBottom,
	                            transform: `translateX(-50%) translateY(${showToolMenu ? 0 : 10}px) scale(${showToolMenu ? 1 : 0.96})`,
	                            zIndex: 1600,
	                            display: 'flex',
	                            flexDirection: 'column-reverse',
	                            gap: BUTTON_GAP,
	                            transformOrigin: '50% 100%',
	                            pointerEvents: showToolMenu ? 'auto' : 'none',
	                            opacity: showToolMenu ? 1 : 0,
	                            filter: showToolMenu ? 'blur(0)' : 'blur(0.8px)',
	                            transition: 'opacity 180ms ease, transform 180ms ease, filter 180ms ease',
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
	                            <div
                                    key={b.key}
                                    style={{
                                        opacity: showToolMenu ? 1 : 0,
                                        transform: `translateY(${showToolMenu ? 0 : 10}px) scale(${showToolMenu ? 1 : 0.92})`,
                                        transition: 'opacity 180ms ease, transform 180ms ease',
                                        transitionDelay: showToolMenu ? `${idx * 35}ms` : '0ms',
                                    }}
                                >
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

                {/* Secondary stack for Mode menu (Physics + Grid + Focus) */}
                {!focusMode && (
                    <div
                        style={{
                            position: 'fixed',
                            left: `calc(50% + ${modeAnchorOffset}px)`,
                            bottom: subStackBottom,
                            transform: `translateX(-50%) translateY(${showModeMenu ? 0 : 10}px) scale(${showModeMenu ? 1 : 0.96})`,
                            zIndex: 1600,
                            display: 'flex',
                            flexDirection: 'column-reverse',
                            gap: BUTTON_GAP,
                            transformOrigin: '50% 100%',
                            pointerEvents: showModeMenu ? 'auto' : 'none',
                            opacity: showModeMenu ? 1 : 0,
                            filter: showModeMenu ? 'blur(0)' : 'blur(0.8px)',
                            transition: 'opacity 180ms ease, transform 180ms ease, filter 180ms ease',
                        }}
                    >
                        {[
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
                            {
                                key: 'monitoring',
                                title: monitoringMode ? 'Disable Monitoring' : 'Enable Monitoring',
                                onClick: toggleMonitoringMode,
                                active: monitoringMode,
                                child: <Activity size={18} />,
                            },
                        ].map((b, idx) => (
                            <div
                                key={b.key}
                                style={{
                                    opacity: showModeMenu ? 1 : 0,
                                    transform: `translateY(${showModeMenu ? 0 : 10}px) scale(${showModeMenu ? 1 : 0.92})`,
                                    transition: 'opacity 180ms ease, transform 180ms ease',
                                    transitionDelay: showModeMenu ? `${idx * 35}ms` : '0ms',
                                }}
                            >
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

                {/* Secondary stack for Zoom menu (detail/normal/graph) */}
                {!focusMode && (
                    <div
                        style={{
                            position: 'fixed',
                            left: `calc(50% + ${zoomAnchorOffset}px)`,
                            bottom: subStackBottom,
                            transform: `translateX(-50%) translateY(${showZoomMenu ? 0 : 10}px) scale(${showZoomMenu ? 1 : 0.96})`,
                            zIndex: 1600,
                            display: 'flex',
                            flexDirection: 'column-reverse',
                            gap: BUTTON_GAP,
                            transformOrigin: '50% 100%',
                            pointerEvents: showZoomMenu ? 'auto' : 'none',
                            opacity: showZoomMenu ? 1 : 0,
                            filter: showZoomMenu ? 'blur(0)' : 'blur(0.8px)',
                            transition: 'opacity 180ms ease, transform 180ms ease, filter 180ms ease',
                        }}
                    >
                        {[
                            {
                                key: 'detail',
                                title: 'Detail Zoom',
                                onClick: () => applyZoomPreset(ZOOM_DETAIL, 'Zoom: Detail'),
                                active: zoomPresetKey === 'detail',
                                child: <StickyNote size={18} />,
                            },
                            {
                                key: 'normal',
                                title: 'Normal Zoom',
                                onClick: () => applyZoomPreset(ZOOM_NORMAL, 'Zoom: Normal'),
                                active: zoomPresetKey === 'normal',
                                child: <CircleDot size={18} />,
                            },
                            {
                                key: 'graph',
                                title: 'Graph View Zoom',
                                onClick: () => applyZoomPreset(ZOOM_GRAPH, 'Zoom: Graph'),
                                active: zoomPresetKey === 'graph',
                                child: <Network size={18} />,
                            },
                        ].map((b, idx) => (
                            <div
                                key={b.key}
                                style={{
                                    opacity: showZoomMenu ? 1 : 0,
                                    transform: `translateY(${showZoomMenu ? 0 : 10}px) scale(${showZoomMenu ? 1 : 0.92})`,
                                    transition: 'opacity 180ms ease, transform 180ms ease',
                                    transitionDelay: showZoomMenu ? `${idx * 35}ms` : '0ms',
                                }}
                            >
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
                            active={showModeMenu || snapMode || focusMode || monitoringMode}
                        >
                                <SlidersHorizontal size={18} />
                            </ControlButton>

                        <ControlButton
                            onClick={handleZoomClick}
                            title="Zoom"
                            active={showZoomMenu || !!zoomPresetKey}
                        >
                            {zoomIcon}
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

                        </>
                    )}
	            </div>
	        </div>
	    );
};
