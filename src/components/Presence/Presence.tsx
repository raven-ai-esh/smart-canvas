import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Moon, Sun, Snowflake } from 'lucide-react';
import { useStore } from '../../store/useStore';

const palette = ['#5E81AC', '#A3BE8C', '#B48EAD', '#D08770', '#88C0D0', '#EBCB8B', '#BF616A', '#8FBCBB'];

type FieldStatus = 'ok' | 'missing' | 'invalid';

function useIsCompactAuthModal() {
  const [isCompact, setIsCompact] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(max-width: 820px), (max-height: 560px), (pointer: coarse)').matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia('(max-width: 820px), (max-height: 560px), (pointer: coarse)');
    const onChange = () => setIsCompact(mql.matches);
    try {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    } catch {
      // Safari < 14
      // eslint-disable-next-line deprecation/deprecation
      mql.addListener(onChange);
      // eslint-disable-next-line deprecation/deprecation
      return () => mql.removeListener(onChange);
    }
  }, []);

  return isCompact;
}

function LabeledInputField({
  id,
  label,
  value,
  onChange,
  onBlur,
  type,
  placeholder,
  autoComplete,
  inputMode,
  status,
  errorText,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  status: FieldStatus;
  errorText?: string | null;
}) {
  const borderColor = status === 'invalid' ? '#BF616A' : status === 'missing' ? '#EBCB8B' : 'var(--border-strong)';
  const legendColor = status === 'invalid' ? '#BF616A' : status === 'missing' ? '#EBCB8B' : 'var(--text-secondary)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: '100%', alignSelf: 'stretch' }}>
      <fieldset
        style={{
          display: 'block',
          margin: 0,
          padding: '6px 10px 7px 10px',
          borderRadius: 14,
          border: `1px solid ${borderColor}`,
          background: 'transparent',
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
          // Fieldset has a UA default `min-inline-size: min-content`, which can make inputs different widths.
          // Force it to behave like a normal full-width block in our form layout.
          minInlineSize: 0,
          boxSizing: 'border-box',
        }}
      >
        <legend
          style={{
            padding: '0 6px',
            fontSize: 11,
            color: legendColor,
            userSelect: 'none',
          }}
        >
          {label}
        </legend>
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          type={type}
          placeholder={placeholder}
          autoComplete={autoComplete}
          inputMode={inputMode}
          aria-invalid={status !== 'ok'}
          aria-describedby={errorText ? `${id}-err` : undefined}
          style={{
            width: '100%',
            maxWidth: '100%',
            minWidth: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--text-primary)',
            padding: 0,
            outline: 'none',
            boxSizing: 'border-box',
            fontSize: 13,
            lineHeight: '18px',
            fontFamily: 'inherit',
          }}
        />
      </fieldset>
      {errorText ? (
        <div id={`${id}-err`} style={{ fontSize: 12, color: status === 'invalid' ? '#BF616A' : '#EBCB8B' }}>
          {errorText}
        </div>
      ) : null}
    </div>
  );
}

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function AnimalIcon({ kind }: { kind: number }) {
  const k = kind % 6;
  const common = { stroke: 'currentColor', fill: 'none', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (k === 0) {
    // Cat
    return (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path {...common} d="M7 9 5.2 6.2 7.8 7.6M17 9l1.8-2.8-2.6 1.4" />
        <path {...common} d="M7.5 10.5c-1.3 1.2-2 2.6-2 4.2 0 3.1 2.9 5.3 6.5 5.3s6.5-2.2 6.5-5.3c0-1.6-.7-3-2-4.2" />
        <path {...common} d="M9.5 14.2h.01M14.5 14.2h.01" />
        <path {...common} d="M10.8 16.2c.6.5 1.7.5 2.4 0" />
      </svg>
    );
  }
  if (k === 1) {
    // Dog
    return (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path {...common} d="M8 9 6 7.4 5 10.2M16 9l2-1.6 1 2.8" />
        <path {...common} d="M7.5 11.5c-1.2 1.1-2 2.6-2 4.3 0 3 2.9 5.2 6.5 5.2s6.5-2.2 6.5-5.2c0-1.7-.8-3.2-2-4.3" />
        <path {...common} d="M10 15.2h.01M14 15.2h.01" />
        <path {...common} d="M11.2 17.2c.5.4 1.1.4 1.6 0" />
      </svg>
    );
  }
  if (k === 2) {
    // Owl
    return (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path {...common} d="M7.2 10.2c-1.1 1.3-1.7 2.9-1.7 4.6 0 3.5 2.9 6.2 6.5 6.2s6.5-2.7 6.5-6.2c0-1.7-.6-3.3-1.7-4.6" />
        <path {...common} d="M9.2 13.2c.2-1 1.3-1.8 2.8-1.8s2.6.8 2.8 1.8" />
        <path {...common} d="M9.1 15.2c0 .8.8 1.4 1.7 1.4s1.7-.6 1.7-1.4" />
        <path {...common} d="M12.5 15.2c0 .8.8 1.4 1.7 1.4s1.7-.6 1.7-1.4" />
        <path {...common} d="M11.6 17.3c.3.3.5.5.8.5s.6-.2.8-.5" />
      </svg>
    );
  }
  if (k === 3) {
    // Fish
    return (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path {...common} d="M4.5 12c2.1-2.6 4.7-4 7.6-4 4.3 0 7.4 3.1 7.4 4s-3.1 4-7.4 4c-2.9 0-5.5-1.4-7.6-4Z" />
        <path {...common} d="M19.5 12l2.6-2.2v4.4Z" />
        <path {...common} d="M13.7 11.1h.01" />
      </svg>
    );
  }
  if (k === 4) {
    // Rabbit
    return (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path {...common} d="M9 6c0-1.6.9-2.8 2-2.8S13 4.4 13 6" />
        <path {...common} d="M15 6c0-1.6.9-2.8 2-2.8S19 4.4 19 6" />
        <path {...common} d="M8 11c-1.5 1.2-2.5 2.9-2.5 4.8 0 3.1 2.9 5.2 6.5 5.2s6.5-2.1 6.5-5.2c0-1.9-1-3.6-2.5-4.8" />
        <path {...common} d="M10 15.2h.01M14 15.2h.01" />
        <path {...common} d="M11.2 17.1c.5.5 1.1.5 1.6 0" />
      </svg>
    );
  }
  // Fox-ish
  return (
    <svg viewBox="0 0 24 24" width="22" height="22">
      <path {...common} d="M7 9 5.2 6.3 8.1 7.9M17 9l1.8-2.7-2.9 1.6" />
      <path {...common} d="M7.2 10.6c-.9 1.1-1.7 2.4-1.7 4.2 0 3.1 2.9 5.2 6.5 5.2s6.5-2.1 6.5-5.2c0-1.8-.8-3.1-1.7-4.2" />
      <path {...common} d="M9.5 14.2h.01M14.5 14.2h.01" />
      <path {...common} d="M10.9 16.4c.6.4 1.6.4 2.2 0" />
    </svg>
  );
}

function GoogleLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#EA4335" d="M12 10.2v3.9h5.4c-.2 1.2-1.4 3.6-5.4 3.6-3.2 0-5.8-2.7-5.8-6s2.6-6 5.8-6c1.8 0 3 .8 3.7 1.5l2.5-2.4C16.6 3.8 14.5 2.7 12 2.7 6.9 2.7 2.8 6.9 2.8 11.9S6.9 21.1 12 21.1c5.8 0 9.6-4.1 9.6-9.9 0-.7-.1-1.2-.2-1.7H12Z" />
      <path fill="#34A853" d="M3.9 7.3l3.2 2.4c.9-1.8 2.8-3.1 4.9-3.1 1.8 0 3 .8 3.7 1.5l2.5-2.4C16.6 3.8 14.5 2.7 12 2.7 8.4 2.7 5.3 4.7 3.9 7.3Z" opacity=".001" />
    </svg>
  );
}

function YandexLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#FC3F1D" />
      <path
        d="M12.6 6.6c-2.2 0-3.7 1.3-3.7 3.3 0 1.6.9 2.8 2.5 3.2L9.4 17.4h2.1l1.4-3.7h1.5v3.7h1.9V6.6h-3.7Zm-.2 1.8h1.8v3.6h-1.7c-1.1 0-1.7-.7-1.7-1.8 0-1.1.7-1.8 1.6-1.8Z"
        fill="#fff"
      />
    </svg>
  );
}

function TelegramLogo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#229ED9" />
      <path
        d="M16.9 7.8 6.7 11.9c-.7.3-.7 1.2.1 1.4l2.7.8 1 3.1c.1.4.6.5.9.2l1.6-1.6 2.8 2.1c.4.3.9.1 1-.4l1.8-9c.1-.6-.5-1.1-1.1-.9Zm-2.1 2.2-4.7 4.3c-.2.2-.1.5.2.6l.9.3.3 1.1c.1.3.4.3.6.1l.8-.8 2.4 1.8 1.2-6.3c0-.3-.3-.5-.6-.3Z"
        fill="#fff"
      />
    </svg>
  );
}

function CircularIconButton({
  disabled,
  title,
  ariaLabel,
  onClick,
  children,
}: {
  disabled?: boolean;
  title: string;
  ariaLabel: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      style={{
        width: 46,
        height: 46,
        borderRadius: 999,
        border: '1px solid var(--border-strong)',
        background: 'transparent',
        color: 'var(--text-primary)',
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        display: 'grid',
        placeItems: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {children}
    </button>
  );
}

function TelegramOAuthButton({
  disabled,
  telegramBotUsername,
  returnTo,
  onUnavailable,
}: {
  disabled: boolean;
  telegramBotUsername: string | null;
  returnTo: string;
  onUnavailable: () => void;
}) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    if (disabled) return;
    if (!telegramBotUsername) return;

    const container = document.getElementById('telegram-oauth-inline-btn');
    if (!container) return;
    container.innerHTML = '';

    (window as any).onTelegramAuth = (user: Record<string, unknown>) => {
      try {
        const params = new URLSearchParams();
        if (user && typeof user === 'object') {
          for (const [k, v] of Object.entries(user)) {
            if (v === undefined || v === null) continue;
            params.set(k, String(v));
          }
        }
        params.set('returnTo', returnTo);
        window.location.href = `/api/auth/telegram/callback?${params.toString()}`;
      } catch {
        window.location.href = `/api/auth/telegram/start?returnTo=${encodeURIComponent(returnTo)}`;
      }
    };

    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.setAttribute('data-telegram-login', telegramBotUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '22');
    script.setAttribute('data-userpic', 'false');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.onload = () => setReady(true);
    container.appendChild(script);

    return () => {
      try {
        delete (window as any).onTelegramAuth;
      } catch {
        // ignore
      }
    };
  }, [disabled, telegramBotUsername, returnTo]);

  return (
    <CircularIconButton disabled={disabled} title="Telegram" ariaLabel="Telegram" onClick={disabled ? onUnavailable : undefined}>
      {/* Invisible widget layer to capture click without showing Telegram button */}
      <div
        id="telegram-oauth-inline-btn"
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          pointerEvents: disabled || !ready ? 'none' : 'auto',
        }}
      />
      <TelegramLogo />
    </CircularIconButton>
  );
}

function Avatar({
  name,
  seed,
  registered,
  onClick,
  highlight,
  theme,
  imageUrl,
  size,
}: {
  name: string;
  seed: string;
  registered: boolean;
  highlight?: boolean;
  onClick?: () => void;
  theme: 'dark' | 'light';
  imageUrl?: string | null;
  size?: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl]);
  const h = useMemo(() => hashString(seed || name), [seed, name]);
  const bg = palette[h % palette.length];
  const kind = (h >>> 8) % 6;
  const fg = theme === 'dark' ? '#fff' : '#111';
  const border = highlight ? '2px solid var(--accent-primary)' : registered ? '1px solid var(--border-strong)' : '1px solid var(--border-subtle)';
  const avatarSize = size ?? 36;
  const showImage = !!imageUrl && !imageFailed;

  return (
    <button
      type="button"
      onClick={onClick}
      title={name}
      style={{
        width: avatarSize,
        height: avatarSize,
        borderRadius: 999,
        border,
        padding: 0,
        background: bg,
        color: fg,
        display: 'grid',
        placeItems: 'center',
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: highlight ? '0 0 0 2px var(--accent-glow)' : '0 6px 18px rgba(0,0,0,0.25)',
        overflow: 'hidden',
      }}
    >
      {showImage ? (
        <img
          src={imageUrl ?? ''}
          alt=""
          onError={() => setImageFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <AnimalIcon kind={kind} />
      )}
    </button>
  );
}

export const Presence: React.FC = () => {
  const presence = useStore((s) => s.presence);
  const me = useStore((s) => s.me);
  const theme = useStore((s) => s.theme);
  const snowEnabled = useStore((s) => s.snowEnabled);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const toggleSnow = useStore((s) => s.toggleSnow);
  const isCompactAuth = useIsCompactAuthModal();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [touched, setTouched] = useState<{ name: boolean; email: boolean; password: boolean }>({ name: false, email: false, password: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [authNoticeVisible, setAuthNoticeVisible] = useState(false);
  const [devVerifyUrl, setDevVerifyUrl] = useState<string | null>(null);
  const [providers, setProviders] = useState<{ google: boolean; yandex: boolean; telegram: boolean; telegramBotUsername: string | null } | null>(null);
  // Account settings modal state (separate from auth modal).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsName, setSettingsName] = useState('');
  const [settingsEmail, setSettingsEmail] = useState('');
  const [settingsPassword, setSettingsPassword] = useState('');
  const [settingsPasswordConfirm, setSettingsPasswordConfirm] = useState('');
  const [settingsAvatarData, setSettingsAvatarData] = useState<string | null>(null);
  const [settingsAvatarRemoved, setSettingsAvatarRemoved] = useState(false);
  const [settingsSubmitAttempted, setSettingsSubmitAttempted] = useState(false);
  const [settingsTouched, setSettingsTouched] = useState<{ name: boolean; email: boolean; password: boolean; passwordConfirm: boolean }>({ name: false, email: false, password: false, passwordConfirm: false });
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [settingsNoticeVisible, setSettingsNoticeVisible] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const selfId = presence.selfId;
  const peers = presence.peers;
  const selfPeer = selfId ? peers.find((p) => p.id === selfId) : null;
  const others = selfId ? peers.filter((p) => p.id !== selfId) : peers;

  const myName = me?.name ?? selfPeer?.name ?? 'Guest';
  const mySeed = me?.avatarSeed ?? selfPeer?.avatarSeed ?? (window.localStorage.getItem('living-canvas-client-id') ?? '');
  const myAvatarUrl = me?.avatarUrl ?? selfPeer?.avatarUrl ?? null;
  const myRegistered = !!me;
  const settingsAvatarPreview = settingsAvatarRemoved ? null : (settingsAvatarData ?? me?.avatarUrl ?? null);

  const returnTo = useMemo(() => window.location.pathname + window.location.search, []);

  const close = () => {
    setOpen(false);
    setMessage(null);
    setDevVerifyUrl(null);
    setBusy(false);
    setSubmitAttempted(false);
    setTouched({ name: false, email: false, password: false });
  };

  const openSettings = () => {
    if (!me) return;
    // Close the mini popover and open the full settings modal.
    setOpen(false);
    setSettingsOpen(true);
  };

  const closeSettings = () => {
    setSettingsOpen(false);
    setSettingsMessage(null);
    setSettingsBusy(false);
    setSettingsSubmitAttempted(false);
    setSettingsTouched({ name: false, email: false, password: false, passwordConfirm: false });
    setSettingsPasswordConfirm('');
    setSettingsAvatarData(null);
    setSettingsAvatarRemoved(false);
    setSettingsNotice(null);
    setSettingsNoticeVisible(false);
  };

  useEffect(() => {
    if (!settingsOpen) return;
    // Seed the settings form from the latest profile data.
    setSettingsName(me?.name ?? '');
    setSettingsEmail(me?.email ?? '');
    setSettingsPassword('');
    setSettingsPasswordConfirm('');
    setSettingsAvatarData(null);
    setSettingsAvatarRemoved(false);
    setSettingsMessage(null);
    setSettingsNotice(null);
    setSettingsNoticeVisible(false);
    setSettingsSubmitAttempted(false);
    setSettingsTouched({ name: false, email: false, password: false, passwordConfirm: false });
  }, [settingsOpen, me]);

  useEffect(() => {
    if (settingsOpen && !me) {
      // If the session becomes unauthenticated, close the settings modal.
      closeSettings();
    }
  }, [settingsOpen, me]);

  useEffect(() => {
    if (!settingsPassword) setSettingsPasswordConfirm('');
  }, [settingsPassword]);

  useEffect(() => {
    if (!open) return;
    // When switching tabs between signup/login reset field-level validation visuals.
    setSubmitAttempted(false);
    setTouched({ name: false, email: false, password: false });
    setMessage(null);
    setDevVerifyUrl(null);
  }, [mode, open]);

  useEffect(() => {
    if (!authNotice) {
      setAuthNoticeVisible(false);
      return;
    }
    setAuthNoticeVisible(true);
    const fadeTimer = window.setTimeout(() => setAuthNoticeVisible(false), 1600);
    const clearTimer = window.setTimeout(() => setAuthNotice(null), 2000);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(clearTimer);
    };
  }, [authNotice]);

  useEffect(() => {
    if (!settingsNotice) {
      setSettingsNoticeVisible(false);
      return;
    }
    setSettingsNoticeVisible(true);
    const fadeTimer = window.setTimeout(() => setSettingsNoticeVisible(false), 1600);
    const clearTimer = window.setTimeout(() => setSettingsNotice(null), 2000);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(clearTimer);
    };
  }, [settingsNotice]);

  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent)?.detail ?? {};
      setOpen(true);
      if (detail?.mode === 'login') setMode('login');
      if (detail?.mode === 'signup') setMode('signup');
      if (typeof detail?.message === 'string' && detail.message.trim()) {
        setAuthNotice(detail.message);
      }
    };
    window.addEventListener('open-auth', handler as EventListener);
    return () => window.removeEventListener('open-auth', handler as EventListener);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const res = await fetch('/api/auth/providers');
      if (!res.ok) return;
      const data = await res.json();
      if (cancelled) return;
      setProviders({ google: !!data?.google, yandex: !!data?.yandex, telegram: !!data?.telegram, telegramBotUsername: data?.telegramBotUsername ? String(data.telegramBotUsername) : null });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  const shouldValidate = (field: keyof typeof touched) => submitAttempted || touched[field];

  const validateName = (v: string) => {
    const t = v.trim();
    if (!t) return { status: 'missing' as const, error: 'Введите имя' };
    if (t.length < 2) return { status: 'invalid' as const, error: 'Имя слишком короткое' };
    return { status: 'ok' as const, error: null };
  };

  const validateEmail = (v: string) => {
    const t = v.trim();
    if (!t) return { status: 'missing' as const, error: 'Введите email' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { status: 'invalid' as const, error: 'Некорректный email' };
    return { status: 'ok' as const, error: null };
  };

  const validatePassword = (v: string) => {
    if (!v) return { status: 'missing' as const, error: 'Введите пароль' };
    if (v.length < 8) return { status: 'invalid' as const, error: 'Пароль должен быть минимум 8 символов' };
    return { status: 'ok' as const, error: null };
  };

  const getNameUi = () => {
    if (mode !== 'signup') return { status: 'ok' as const, error: null };
    if (!shouldValidate('name')) return { status: 'ok' as const, error: null };
    return validateName(name);
  };
  const getEmailUi = () => {
    if (!shouldValidate('email')) return { status: 'ok' as const, error: null };
    return validateEmail(email);
  };
  const getPasswordUi = () => {
    if (!shouldValidate('password')) return { status: 'ok' as const, error: null };
    return validatePassword(password);
  };

  const shouldValidateSettings = (field: keyof typeof settingsTouched) => settingsSubmitAttempted || settingsTouched[field];

  const getSettingsNameUi = () => {
    if (!shouldValidateSettings('name')) return { status: 'ok' as const, error: null };
    return validateName(settingsName);
  };

  const getSettingsEmailUi = () => {
    if (!shouldValidateSettings('email')) return { status: 'ok' as const, error: null };
    return validateEmail(settingsEmail);
  };

  const getSettingsPasswordUi = () => {
    if (!shouldValidateSettings('password')) return { status: 'ok' as const, error: null };
    if (!settingsPassword) return { status: 'ok' as const, error: null };
    return validatePassword(settingsPassword);
  };

  const getSettingsPasswordConfirmUi = () => {
    if (!shouldValidateSettings('passwordConfirm')) return { status: 'ok' as const, error: null };
    if (!settingsPassword) return { status: 'ok' as const, error: null };
    if (!settingsPasswordConfirm) return { status: 'missing' as const, error: 'Confirm your password' };
    if (settingsPasswordConfirm !== settingsPassword) return { status: 'invalid' as const, error: 'Passwords do not match' };
    return { status: 'ok' as const, error: null };
  };

  const validateBeforeSubmit = () => {
    const issues: Array<{ field: 'name' | 'email' | 'password'; status: FieldStatus }> = [];
    if (mode === 'signup') {
      const n = validateName(name);
      if (n.status !== 'ok') issues.push({ field: 'name', status: n.status });
    }
    const e = validateEmail(email);
    if (e.status !== 'ok') issues.push({ field: 'email', status: e.status });
    const p = validatePassword(password);
    if (p.status !== 'ok') issues.push({ field: 'password', status: p.status });
    return issues;
  };

  const refreshMe = async () => {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return;
    const data = await res.json();
    useStore.getState().setMe(data?.user ? {
      id: String(data.user.id ?? ''),
      email: String(data.user.email ?? ''),
      name: String(data.user.name ?? ''),
      avatarSeed: String(data.user.avatarSeed ?? ''),
      avatarUrl: typeof data.user.avatarUrl === 'string' ? data.user.avatarUrl : null,
      verified: !!data.user.verified,
    } : null);
    window.dispatchEvent(new Event('auth-changed'));
  };

  const doLogout = async () => {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      await refreshMe();
      close();
    } finally {
      setBusy(false);
    }
  };

  const doEmailAuth = async () => {
    setSubmitAttempted(true);
    const issues = validateBeforeSubmit();
    if (issues.length) {
      setTouched((t) => ({ ...t, name: true, email: true, password: true }));
      return;
    }

    setBusy(true);
    setMessage(null);
    setDevVerifyUrl(null);
    try {
      if (mode === 'signup') {
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, name }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setMessage(String(data?.error ?? 'signup_failed'));
          return;
        }
        if (data?.devVerifyUrl) setDevVerifyUrl(String(data.devVerifyUrl));
        setMessage('Проверь email для подтверждения');
        return;
      }

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(String(data?.error ?? 'login_failed'));
        return;
      }
      await refreshMe();
      close();
    } finally {
      setBusy(false);
    }
  };

  // Save only the changed profile fields and keep the modal responsive while updating.
  const saveSettings = async () => {
    if (!me) return;
    setSettingsSubmitAttempted(true);

    const payload: { name?: string; email?: string; password?: string; avatarData?: string; avatarRemove?: boolean } = {};
    const nextName = settingsName.trim();
    const nextEmail = settingsEmail.trim().toLowerCase();
    const currentEmail = (me.email ?? '').trim().toLowerCase();

    if (nextName !== (me.name ?? '').trim()) {
      const n = validateName(settingsName);
      if (n.status !== 'ok') {
        setSettingsTouched((t) => ({ ...t, name: true }));
        return;
      }
      payload.name = nextName;
    }

    if (nextEmail !== currentEmail) {
      const e = validateEmail(settingsEmail);
      if (e.status !== 'ok') {
        setSettingsTouched((t) => ({ ...t, email: true }));
        return;
      }
      payload.email = nextEmail;
    }

    if (settingsPassword) {
      const p = validatePassword(settingsPassword);
      if (p.status !== 'ok') {
        setSettingsTouched((t) => ({ ...t, password: true }));
        return;
      }
      if (!settingsPasswordConfirm || settingsPasswordConfirm !== settingsPassword) {
        setSettingsTouched((t) => ({ ...t, passwordConfirm: true }));
        return;
      }
      payload.password = settingsPassword;
    }

    if (settingsAvatarRemoved) {
      payload.avatarRemove = true;
    } else if (settingsAvatarData) {
      payload.avatarData = settingsAvatarData;
    }

    if (!Object.keys(payload).length) {
      setSettingsMessage('No changes to save');
      return;
    }

    setSettingsBusy(true);
    setSettingsMessage(null);
    try {
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = String(data?.error ?? 'update_failed');
        if (err === 'email_in_use') setSettingsMessage('Email is already in use');
        else if (err === 'bad_email') setSettingsMessage('Enter a valid email');
        else if (err === 'bad_name') setSettingsMessage('Name is too short');
        else if (err === 'bad_password') setSettingsMessage('Password must be at least 8 characters');
        else if (err === 'bad_avatar') setSettingsMessage('Avatar must be an image file');
        else if (err === 'avatar_too_large') setSettingsMessage('Avatar is too large');
        else if (err === 'no_changes') setSettingsMessage('No changes to save');
        else setSettingsMessage('Failed to update profile');
        return;
      }
      await refreshMe();
      setSettingsPassword('');
      setSettingsPasswordConfirm('');
      setSettingsAvatarData(null);
      setSettingsAvatarRemoved(false);
      if (data?.pendingEmail) {
        setSettingsNotice(`Confirmation sent to ${data.pendingEmail}`);
      } else {
        setSettingsNotice('Changes saved');
      }
      if (typeof data?.devEmailChangeUrl === 'string' && data.devEmailChangeUrl) {
        setSettingsMessage(`Dev email confirmation: ${data.devEmailChangeUrl}`);
      } else {
        setSettingsMessage(null);
      }
    } finally {
      setSettingsBusy(false);
    }
  };

  const handleAvatarPick = () => {
    avatarInputRef.current?.click();
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setSettingsMessage('Avatar must be an image file');
      return;
    }
    if (file.size > 1_000_000) {
      setSettingsMessage('Avatar is too large (max 1MB)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      setSettingsAvatarData(result);
      setSettingsAvatarRemoved(false);
      setSettingsMessage(null);
    };
    reader.readAsDataURL(file);
  };

  const openOAuth = (provider: 'google' | 'yandex' | 'telegram') => {
    if (providers && !providers[provider]) {
      setMessage(`${provider} не настроен`);
      return;
    }
    if (provider === 'telegram') return;
    const url = `/api/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`;
    window.location.href = url;
  };

  const copyText = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      setMessage('Ссылка скопирована');
    } catch {
      window.prompt('Copy:', t);
    }
  };

  return (
    <>
      <div
        style={{
          position: 'fixed',
          top: 'calc(12px + env(safe-area-inset-top, 0px))',
          right: 'calc(12px + env(safe-area-inset-right, 0px))',
          zIndex: 1500,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          pointerEvents: 'auto',
        }}
      >
        <Avatar
          name={myName}
          seed={mySeed}
          registered={myRegistered}
          highlight
          theme={theme}
          imageUrl={myAvatarUrl}
          onClick={() => setOpen((v) => !v)}
        />
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {others.slice(0, 10).map((p, idx) => (
            <div
              key={p.id}
              style={{
                position: 'relative',
                marginLeft: idx === 0 ? 0 : -4, // ~10% overlap for 36px avatar
                zIndex: idx,
              }}
            >
              <Avatar name={p.name} seed={p.avatarSeed} registered={p.registered} theme={theme} imageUrl={p.avatarUrl} />
            </div>
          ))}
        </div>
      </div>

      {/* Registered: small popover below avatars */}
      {open && me && (
        <div
          style={{
            position: 'fixed',
            top: 'calc(12px + env(safe-area-inset-top, 0px) + 44px)',
            right: 'calc(12px + env(safe-area-inset-right, 0px))',
            zIndex: 1600,
            width: 260,
            borderRadius: 14,
            background: 'var(--bg-node)',
            border: '1px solid var(--border-strong)',
            boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
            padding: 12,
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>{me.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{me.email || '—'}</div>
          <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              onClick={openSettings}
              style={{
                borderRadius: 10,
                border: '1px solid var(--border-strong)',
                background: 'transparent',
                color: 'var(--text-primary)',
                padding: '8px 10px',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Account settings
            </button>
            <div style={{ height: 1, background: 'var(--border-strong)', opacity: 0.45 }} />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                type="button"
                onClick={toggleTheme}
                title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 999,
                  border: '1px solid var(--border-strong)',
                  background: theme === 'light' ? 'var(--accent-glow)' : 'transparent',
                  color: 'var(--text-primary)',
                  display: 'grid',
                  placeItems: 'center',
                  cursor: 'pointer',
                }}
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button>
              <button
                type="button"
                onClick={toggleSnow}
                title={snowEnabled ? 'Disable Snow' : 'Enable Snow'}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 999,
                  border: '1px solid var(--border-strong)',
                  background: snowEnabled ? 'var(--accent-glow)' : 'transparent',
                  color: 'var(--text-primary)',
                  display: 'grid',
                  placeItems: 'center',
                  cursor: 'pointer',
                }}
              >
                <Snowflake size={18} />
              </button>
            </div>
            <div style={{ height: 1, background: 'var(--border-strong)', opacity: 0.45 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={doLogout}
                disabled={busy}
                style={{
                  flex: 1,
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  padding: '8px 10px',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                Logout
              </button>
              <button
                type="button"
                onClick={close}
                style={{
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  padding: '8px 10px',
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Account settings modal for authenticated users */}
      {settingsOpen && me && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            background: 'rgba(0,0,0,0.45)',
            display: 'grid',
            placeItems: isCompactAuth ? 'end center' : 'center',
            padding:
              'calc(12px + env(safe-area-inset-top, 0px)) calc(12px + env(safe-area-inset-right, 0px)) calc(12px + env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px))',
          }}
          onPointerDown={closeSettings}
        >
          <div style={{ display: 'grid', justifyItems: 'center', position: 'relative' }}>
            {settingsNotice && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  transform: 'translate(-50%, -120%)',
                  padding: '8px 12px',
                  borderRadius: 999,
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-node)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                  boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
                  opacity: settingsNoticeVisible ? 0.72 : 0,
                  transition: 'opacity 220ms ease',
                  pointerEvents: 'none',
                }}
              >
                {settingsNotice}
              </div>
            )}
            <div
              style={{
                width: isCompactAuth ? 'min(680px, 100%)' : 'min(520px, 92vw)',
                borderRadius: isCompactAuth ? '16px 16px 14px 14px' : 16,
                background: 'var(--bg-node)',
                border: '1px solid var(--border-strong)',
                boxShadow: '0 20px 70px rgba(0,0,0,0.55)',
                padding: 16,
                boxSizing: 'border-box',
                maxHeight: isCompactAuth ? 'calc(var(--visual-height, 100vh) - env(safe-area-inset-top, 0px) - 12px)' : undefined,
                overflowY: isCompactAuth ? 'auto' : undefined,
                paddingBottom: isCompactAuth ? 'calc(16px + env(safe-area-inset-bottom, 0px))' : 16,
                WebkitOverflowScrolling: isCompactAuth ? 'touch' : undefined,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Account settings</div>
                <button
                  type="button"
                  onClick={closeSettings}
                  style={{
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'transparent',
                    color: 'var(--text-primary)',
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  Close
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
                <Avatar
                  name={settingsName || myName}
                  seed={mySeed}
                  registered
                  theme={theme}
                  imageUrl={settingsAvatarPreview}
                  size={64}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Profile photo</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={handleAvatarPick}
                      style={{
                        borderRadius: 10,
                        border: '1px solid var(--border-strong)',
                        background: 'transparent',
                        color: 'var(--text-primary)',
                        padding: '8px 10px',
                        cursor: 'pointer',
                      }}
                    >
                      {settingsAvatarPreview ? 'Change' : 'Upload'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSettingsAvatarData(null);
                        setSettingsAvatarRemoved(true);
                      }}
                      disabled={!settingsAvatarPreview}
                      style={{
                        borderRadius: 10,
                        border: '1px solid var(--border-strong)',
                        background: 'transparent',
                        color: 'var(--text-primary)',
                        padding: '8px 10px',
                        cursor: settingsAvatarPreview ? 'pointer' : 'not-allowed',
                        opacity: settingsAvatarPreview ? 1 : 0.6,
                      }}
                    >
                      Remove
                    </button>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleAvatarChange}
                      style={{ display: 'none' }}
                    />
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                <LabeledInputField
                  id="settings-name"
                  label="Name"
                  value={settingsName}
                  onChange={setSettingsName}
                  onBlur={() => setSettingsTouched((t) => ({ ...t, name: true }))}
                  placeholder="Your name"
                  status={getSettingsNameUi().status}
                  errorText={getSettingsNameUi().error}
                />
                <LabeledInputField
                  id="settings-email"
                  label="Email"
                  value={settingsEmail}
                  onChange={setSettingsEmail}
                  onBlur={() => setSettingsTouched((t) => ({ ...t, email: true }))}
                  placeholder="email@example.com"
                  autoComplete="email"
                  inputMode="email"
                  status={getSettingsEmailUi().status}
                  errorText={getSettingsEmailUi().error}
                />
                <LabeledInputField
                  id="settings-password"
                  label="New password"
                  value={settingsPassword}
                  onChange={setSettingsPassword}
                  onBlur={() => setSettingsTouched((t) => ({ ...t, password: true }))}
                  placeholder="Leave empty to keep current"
                  type="password"
                  autoComplete="new-password"
                  status={getSettingsPasswordUi().status}
                  errorText={getSettingsPasswordUi().error}
                />
                <LabeledInputField
                  id="settings-password-confirm"
                  label="Confirm password"
                  value={settingsPasswordConfirm}
                  onChange={setSettingsPasswordConfirm}
                  onBlur={() => setSettingsTouched((t) => ({ ...t, passwordConfirm: true }))}
                  placeholder="Repeat new password"
                  type="password"
                  autoComplete="new-password"
                  status={getSettingsPasswordConfirmUi().status}
                  errorText={getSettingsPasswordConfirmUi().error}
                />
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Leave the password empty if you do not want to change it.
                </div>
              </div>

              {settingsMessage && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>{settingsMessage}</div>
              )}

              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button
                  type="button"
                  onClick={saveSettings}
                  disabled={settingsBusy}
                  style={{
                    flex: 1,
                    borderRadius: 12,
                    border: '1px solid var(--border-strong)',
                    background: 'var(--accent-primary)',
                    color: '#fff',
                    padding: '10px 12px',
                    cursor: settingsBusy ? 'not-allowed' : 'pointer',
                  }}
                >
                  Save changes
                </button>
                <button
                  type="button"
                  onClick={closeSettings}
                  style={{
                    borderRadius: 12,
                    border: '1px solid var(--border-strong)',
                    background: 'transparent',
                    color: 'var(--text-primary)',
                    padding: '10px 12px',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Guest: centered registration/login modal */}
      {open && !me && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            background: 'rgba(0,0,0,0.45)',
            display: 'grid',
            placeItems: isCompactAuth ? 'end center' : 'center',
            padding:
              'calc(12px + env(safe-area-inset-top, 0px)) calc(12px + env(safe-area-inset-right, 0px)) calc(12px + env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px))',
          }}
          onPointerDown={close}
        >
          <div style={{ display: 'grid', justifyItems: 'center', position: 'relative' }}>
            {authNotice && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  transform: 'translate(-50%, -120%)',
                  padding: '8px 12px',
                  borderRadius: 999,
                  border: '1px solid var(--border-strong)',
                  background: 'var(--bg-node)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                  boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
                  opacity: authNoticeVisible ? 0.72 : 0,
                  transition: 'opacity 220ms ease',
                  pointerEvents: 'none',
                }}
              >
                {authNotice}
              </div>
            )}
            <div
              style={{
                width: isCompactAuth ? 'min(680px, 100%)' : 'min(520px, 92vw)',
                borderRadius: isCompactAuth ? '16px 16px 14px 14px' : 16,
                background: 'var(--bg-node)',
                border: '1px solid var(--border-strong)',
                boxShadow: '0 20px 70px rgba(0,0,0,0.55)',
                padding: 16,
                boxSizing: 'border-box',
                maxHeight: isCompactAuth ? 'calc(var(--visual-height, 100vh) - env(safe-area-inset-top, 0px) - 12px)' : undefined,
                overflowY: isCompactAuth ? 'auto' : undefined,
                paddingBottom: isCompactAuth ? 'calc(16px + env(safe-area-inset-bottom, 0px))' : 16,
                WebkitOverflowScrolling: isCompactAuth ? 'touch' : undefined,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                {mode === 'signup' ? 'Регистрация' : 'Вход'}
              </div>
              <button
                type="button"
                onClick={close}
                style={{
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  padding: '6px 10px',
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setMode('signup')}
                style={{
                  flex: 1,
                  minWidth: 180,
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: mode === 'signup' ? 'var(--accent-glow)' : 'transparent',
                  color: 'var(--text-primary)',
                  padding: '8px 10px',
                  cursor: 'pointer',
                }}
              >
                Email
              </button>
              <button
                type="button"
                onClick={() => setMode('login')}
                style={{
                  flex: 1,
                  minWidth: 180,
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: mode === 'login' ? 'var(--accent-glow)' : 'transparent',
                  color: 'var(--text-primary)',
                  padding: '8px 10px',
                  cursor: 'pointer',
                }}
              >
                Уже есть аккаунт
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              {mode === 'signup' && (
                <LabeledInputField
                  id="auth-name"
                  label="Name"
                  value={name}
                  onChange={(v) => setName(v)}
                  onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  placeholder="Your name"
                  status={getNameUi().status}
                  errorText={getNameUi().error}
                />
              )}
              <LabeledInputField
                id="auth-email"
                label="Email"
                value={email}
                onChange={(v) => setEmail(v)}
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                placeholder="email@example.com"
                autoComplete="email"
                inputMode="email"
                status={getEmailUi().status}
                errorText={getEmailUi().error}
              />
              <LabeledInputField
                id="auth-password"
                label="Password"
                value={password}
                onChange={(v) => setPassword(v)}
                onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                placeholder={mode === 'signup' ? 'Min 8 characters' : 'Your password'}
                type="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                status={getPasswordUi().status}
                errorText={getPasswordUi().error}
              />
            </div>

            {message && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>{message}</div>
            )}
            {devVerifyUrl && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  Dev verify link
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    readOnly
                    value={devVerifyUrl}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      borderRadius: 12,
                      border: '1px solid var(--border-strong)',
                      background: 'transparent',
                      color: 'var(--text-primary)',
                      padding: '10px 12px',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => copyText(devVerifyUrl)}
                    style={{
                      borderRadius: 12,
                      border: '1px solid var(--border-strong)',
                      background: 'transparent',
                      color: 'var(--text-primary)',
                      padding: '10px 12px',
                      cursor: 'pointer',
                    }}
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button
                type="button"
                onClick={doEmailAuth}
                disabled={busy}
                style={{
                  flex: 1,
                  borderRadius: 12,
                  border: '1px solid var(--border-strong)',
                  background: 'var(--accent-primary)',
                  color: '#fff',
                  padding: '10px 12px',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                {mode === 'signup' ? 'Sign up' : 'Sign in'}
              </button>
            </div>

            <div style={{ height: 1, background: 'var(--border-strong)', marginTop: 14 }} />

            <div style={{ display: 'flex', gap: 10, marginTop: 12, justifyContent: 'center' }}>
              <CircularIconButton
                onClick={() => openOAuth('google')}
                disabled={!!providers && !providers.google}
                title="Google"
                ariaLabel="Google"
              >
                <GoogleLogo />
              </CircularIconButton>
              <CircularIconButton
                onClick={() => openOAuth('yandex')}
                disabled={!!providers && !providers.yandex}
                title="Yandex"
                ariaLabel="Yandex"
              >
                <YandexLogo />
              </CircularIconButton>
              <TelegramOAuthButton
                disabled={!!providers && !providers.telegram}
                telegramBotUsername={providers?.telegramBotUsername ?? null}
                returnTo={returnTo}
                onUnavailable={() => setMessage('telegram не настроен')}
              />
            </div>
          </div>
        </div>
      </div>
      )}
    </>
  );
};
