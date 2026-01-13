import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronUp, Link2, MessageCircle, ThumbsDown, ThumbsUp, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../store/useStore';
import type { AssistantSelectionContext } from '../../types/assistant';

type AssistantTrace = {
  reasoning?: string | null;
  skill?: {
    runId?: string;
    skillId?: string;
    skillVersionId?: string;
    found?: boolean;
    matchDistance?: number;
  } | null;
  tools?: Array<{
    name: string;
    callId?: string;
    arguments?: unknown;
    output?: unknown;
    isError?: boolean;
  }>;
};

type ChatMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string | null;
  selectionContext?: AssistantSelectionContext | null;
  trace?: AssistantTrace | null;
  externalReply?: boolean;
  externalSender?: string | null;
  externalChannel?: string | null;
};

const MAX_VISIBLE_MESSAGES = 120;
const AUTO_RESET_ON_SESSION_CHANGE = true;
const PANEL_DEFAULT_WIDTH = 360;
const PANEL_DEFAULT_HEIGHT = 520;
const PANEL_MIN_WIDTH = 280;
const PANEL_MIN_HEIGHT = 320;
const PANEL_MAX_WIDTH = 560;
const PANEL_MAX_HEIGHT = 760;
const RESIZE_FROM_TOP_LEFT = true;
const NETWORK_ERROR_MESSAGE = 'Network error: failed to reach the assistant backend. Please check your connection and try again.';

const trimMessages = (messages: ChatMessage[], max = MAX_VISIBLE_MESSAGES) => {
  if (messages.length <= max) return messages;
  return messages.slice(messages.length - max);
};

const isExternalReplyContent = (content: string) => (
  content.startsWith('Пользователь ')
  && content.includes(' ответил на сообщение ')
  && content.includes(' текстом: ')
);

  const isNetworkError = (err: unknown) => {
    if (err instanceof TypeError) return true;
    const message = String((err as Error | null)?.message ?? '').toLowerCase();
    return message.includes('failed to fetch') || message.includes('load failed') || message.includes('network');
  };

const mapErrorMessage = (code?: string) => {
  if (code === 'openai_key_required') {
    return 'OpenAI API key is missing. Add it in Raven AI.';
  }
  if (code === 'invalid_openai_key') {
    return 'OpenAI API key is invalid. Update it in Raven AI.';
  }
  if (code === 'openai_rate_limited') {
    return 'OpenAI rate limit reached. Please try again later.';
  }
  if (code === 'unauthorized') {
    return 'Please sign in to use the AI assistant.';
  }
  if (code === 'thread_not_found') {
    return 'Chat session is missing. Reopen the assistant to start a new one.';
  }
  if (code === 'content_required') {
    return 'Message is empty. Please type something.';
  }
  if (code === 'session_required') {
    return 'Session is not ready yet. Please wait a moment and try again.';
  }
  if (code === 'thread_session_mismatch') {
    return 'Chat session does not match the current canvas. Reopening the assistant should fix it.';
  }
  if (code === 'assistant_chat_deprecated') {
    return 'Assistant is outdated. Please hard refresh the page.';
  }
  if (code && typeof code === 'string') {
    return `Assistant error: ${code}`;
  }
  return 'Assistant request failed. Please try again.';
};

export const AgentWidget: React.FC = () => {
  const sessionId = useStore((s) => s.sessionId);
  const me = useStore((s) => s.me);
  const selectionContext = useStore((s) => s.assistantSelectionContext);
  const clearSelectionContext = useStore((s) => s.clearAssistantSelectionContext);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});
  const [feedbackState, setFeedbackState] = useState<Record<string, 'up' | 'down'>>({});
  const [feedbackBusy, setFeedbackBusy] = useState<Record<string, boolean>>({});
  const [hasUnread, setHasUnread] = useState(false);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [assistantStatus, setAssistantStatus] = useState<'idle' | 'thinking' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextInfo, setContextInfo] = useState<{ remainingRatio?: number | null } | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [panelSize, setPanelSize] = useState({ width: PANEL_DEFAULT_WIDTH, height: PANEL_DEFAULT_HEIGHT });
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia?.('(max-width: 520px)').matches ?? false);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  const threadIdRef = useRef<string | null>(null);
  const resizeStartRef = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const panelSizeRef = useRef(panelSize);
  const threadKey = useMemo(() => {
    if (!me?.id || !sessionId) return null;
    return `assistantThread:${me.id}:${sessionId}`;
  }, [me?.id, sessionId]);
  const sessionReady = Boolean(sessionId);
  const sizeKey = useMemo(() => (me?.id ? `assistantPanelSize:${me.id}` : null), [me?.id]);
  const lastSessionKey = useMemo(() => (
    me?.id ? `assistantLastSession:${me.id}` : null
  ), [me?.id]);

  const clampPanelSize = useCallback((size: { width: number; height: number }) => {
    if (typeof window === 'undefined') return size;
    const viewportWidth = window.innerWidth || 1200;
    const viewportHeight = window.innerHeight || 800;
    const maxWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, viewportWidth - 24));
    const maxHeight = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, viewportHeight - 140));
    const width = Math.max(PANEL_MIN_WIDTH, Math.min(size.width, maxWidth));
    const height = Math.max(PANEL_MIN_HEIGHT, Math.min(size.height, maxHeight));
    return { width, height };
  }, []);

  const isUiActive = useCallback(() => {
    if (typeof document === 'undefined') return false;
    return !document.hidden && document.hasFocus();
  }, []);

  const toggleDetails = useCallback((key: string) => {
    setExpandedDetails((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const stopRequest = useCallback(() => {
    if (requestAbortRef.current) {
      requestAbortRef.current.abort();
    }
  }, []);

  useEffect(() => {
    panelSizeRef.current = panelSize;
  }, [panelSize]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) {
      setShowResetConfirm(false);
    }
  }, [open]);

  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    setAssistantStatus(null);
  }, [threadId]);

  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 520px)');
    if (!mq) return undefined;
    const onChange = () => setIsNarrow(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [open, messages, pending]);

  useEffect(() => {
    if (open && isUiActive()) {
      setHasUnread(false);
    }
  }, [open, isUiActive, messages]);

  useEffect(() => {
    const onVisibility = () => {
      if (open && isUiActive()) {
        setHasUnread(false);
      }
    };
    window.addEventListener('focus', onVisibility);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onVisibility);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isUiActive, open]);

  useEffect(() => {
    const onAssistantStatus = (evt: Event) => {
      const detail = (evt as CustomEvent).detail ?? {};
      const targetThreadId = typeof detail.threadId === 'string' ? detail.threadId : null;
      if (!targetThreadId || targetThreadId !== threadIdRef.current) return;
      const status = typeof detail.status === 'string' ? detail.status : null;
      if (status === 'thinking' || status === 'idle') {
        setAssistantStatus(status);
      }
    };
    window.addEventListener('assistant-status', onAssistantStatus);
    return () => window.removeEventListener('assistant-status', onAssistantStatus);
  }, []);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    };
    window.addEventListener('assistant-open', onOpen);
    return () => window.removeEventListener('assistant-open', onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = wrapperRef.current;
      if (root && root.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (isNarrow || !sizeKey) return;
    const raw = window.localStorage?.getItem(sizeKey);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw);
      if (!stored || typeof stored !== 'object') return;
      const width = Number(stored.width);
      const height = Number(stored.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return;
      setPanelSize(clampPanelSize({ width, height }));
    } catch {
      // ignore bad local storage value
    }
  }, [clampPanelSize, isNarrow, sizeKey]);

  useEffect(() => {
    if (isNarrow) return undefined;
    const onResize = () => {
      setPanelSize((prev) => clampPanelSize(prev));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampPanelSize, isNarrow]);

  useEffect(() => {
    if (!threadKey || !lastSessionKey) {
      setThreadId(null);
      setMessages([]);
      setContextInfo(null);
      setExpandedDetails({});
      setHasUnread(false);
      return;
    }
    const sessionKey = sessionId ?? 'default';
    if (AUTO_RESET_ON_SESSION_CHANGE) {
      const lastSession = window.localStorage?.getItem(lastSessionKey);
      if (lastSession && lastSession !== sessionKey) {
        window.localStorage?.removeItem(threadKey);
      }
      window.localStorage?.setItem(lastSessionKey, sessionKey);
    }
    const stored = window.localStorage?.getItem(threadKey);
    setThreadId(stored);
    setMessages([]);
    setContextInfo(null);
    setExpandedDetails({});
    setHasUnread(false);
  }, [lastSessionKey, sessionId, threadKey]);

  const persistPanelSize = useCallback((size: { width: number; height: number }) => {
    if (!sizeKey) return;
    window.localStorage?.setItem(sizeKey, JSON.stringify(size));
  }, [sizeKey]);

  const onResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isNarrow) return;
    event.preventDefault();
    event.stopPropagation();
    resizeStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      width: panelSize.width,
      height: panelSize.height,
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (!resizeStartRef.current) return;
      const dx = moveEvent.clientX - resizeStartRef.current.x;
      const dy = moveEvent.clientY - resizeStartRef.current.y;
      const next = clampPanelSize({
        width: resizeStartRef.current.width + (RESIZE_FROM_TOP_LEFT ? -dx : dx),
        height: resizeStartRef.current.height + (RESIZE_FROM_TOP_LEFT ? -dy : dy),
      });
      setPanelSize(next);
      panelSizeRef.current = next;
    };
    const onUp = () => {
      if (resizeStartRef.current) {
        persistPanelSize(clampPanelSize(panelSizeRef.current));
      }
      resizeStartRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [clampPanelSize, isNarrow, panelSize, persistPanelSize]);

  const persistThreadId = useCallback((id: string) => {
    if (threadKey) {
      window.localStorage?.setItem(threadKey, id);
    }
    setThreadId(id);
  }, [threadKey]);

  const createThread = useCallback(async ({ forceNew = false }: { forceNew?: boolean } = {}) => {
    if (!sessionReady || !sessionId) {
      throw new Error('Session is not ready yet. Please wait a moment and try again.');
    }
    const payload: Record<string, unknown> = { sessionId };
    if (forceNew) {
      payload.forceNew = true;
    }
    const res = await fetch('/api/assistant/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-assistant-client': 'widget-v2' },
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    let data: any = {};
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }
    }
    if (!res.ok) {
      throw new Error(mapErrorMessage(data?.error));
    }
    const id = data?.thread?.id;
    if (typeof id !== 'string' || !id) {
      throw new Error('Assistant request failed. Please try again.');
    }
    persistThreadId(id);
    return id;
  }, [persistThreadId, sessionId, sessionReady]);

  const loadMessages = useCallback(async (id: string) => {
    const query = sessionId ? `?limit=120&sessionId=${encodeURIComponent(sessionId)}` : '?limit=120';
    const res = await fetch(`/api/assistant/threads/${id}/messages${query}`, {
      headers: { 'x-assistant-client': 'widget-v2' },
    });
    const raw = await res.text();
    let data: any = {};
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }
    }
    if (res.status === 404) return null;
    if (res.status === 409) return null;
    if (!res.ok) {
      throw new Error(mapErrorMessage(data?.error));
    }
    const loaded = Array.isArray(data?.messages) ? data.messages : [];
    const mapped = loaded.map((msg: any) => ({
      id: msg.id,
      role: msg.role,
      content: msg.content,
      createdAt: msg.createdAt ?? null,
      selectionContext: (msg?.meta?.selectionContext ?? null) as AssistantSelectionContext | null,
      trace: msg?.meta?.trace ?? null,
      externalReply: !!msg?.meta?.externalReply,
      externalSender: typeof msg?.meta?.externalSender === 'string' ? msg.meta.externalSender : null,
      externalChannel: typeof msg?.meta?.externalChannel === 'string' ? msg.meta.externalChannel : null,
    })).filter((msg: ChatMessage) => {
      if (msg.externalReply) return false;
      if (msg.role === 'user' && isExternalReplyContent(msg.content)) return false;
      return true;
    });
    const context = data?.context && typeof data.context === 'object' ? data.context : null;
    return { messages: mapped, context };
  }, [sessionId]);

  const sendSkillFeedback = useCallback(async ({
    messageKey,
    messageId,
    runId,
    rating,
  }: {
    messageKey: string;
    messageId?: string;
    runId?: string;
    rating: 'positive' | 'negative';
  }) => {
    if (!me?.id) return;
    if (!runId && !messageId) return;
    setFeedbackBusy((prev) => ({ ...prev, [messageKey]: true }));
    try {
      const payload: Record<string, string> = { rating };
      if (runId) payload.runId = runId;
      if (messageId) payload.assistantMessageId = messageId;
      const res = await fetch('/api/raven-ai/skills/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error('feedback_failed');
      }
      setFeedbackState((prev) => ({ ...prev, [messageKey]: rating === 'positive' ? 'up' : 'down' }));
    } catch {
      setFeedbackState((prev) => {
        if (!Object.prototype.hasOwnProperty.call(prev, messageKey)) return prev;
        const copy = { ...prev };
        delete copy[messageKey];
        return copy;
      });
    } finally {
      setFeedbackBusy((prev) => ({ ...prev, [messageKey]: false }));
    }
  }, [me?.id]);

  const ensureThread = useCallback(async () => {
    if (!sessionReady) {
      throw new Error('Session is not ready yet. Please wait a moment and try again.');
    }
    let id = threadId;
    if (!id && threadKey) {
      const stored = window.localStorage?.getItem(threadKey);
      if (stored) {
        id = stored;
        setThreadId(stored);
      }
    }
    if (!id) {
      id = await createThread();
    }
    return id;
  }, [createThread, sessionReady, threadId, threadKey]);

  const clearThread = useCallback(() => {
    if (threadKey) {
      window.localStorage?.removeItem(threadKey);
    }
    setThreadId(null);
    setContextInfo(null);
    setExpandedDetails({});
    setHasUnread(false);
    setFeedbackState({});
    setFeedbackBusy({});
  }, [threadKey]);

  const confirmResetConversation = useCallback(async () => {
    setShowResetConfirm(false);
    setResetting(true);
    stopRequest();
    clearThread();
    setMessages([]);
    setInput('');
    setError(null);
    setPending(false);
    setAssistantStatus(null);
    setLoadingThread(false);
    if (sessionReady && sessionId) {
      try {
        await createThread({ forceNew: true });
      } catch (err) {
        const message = isNetworkError(err)
          ? NETWORK_ERROR_MESSAGE
          : (err instanceof Error ? err.message : 'Failed to start a new chat.');
        setError(message);
      }
    }
    setResetting(false);
  }, [clearThread, createThread, sessionId, sessionReady, stopRequest]);

  useEffect(() => {
    if (!open || !me || !threadKey || resetting) return;
    let cancelled = false;
    const bootstrap = async () => {
      setLoadingThread(true);
      setError(null);
      try {
        let id = await ensureThread();
        let result = await loadMessages(id);
        if (!result) {
          id = await createThread();
          result = { messages: [], context: null };
        }
        if (!cancelled) {
          setMessages(trimMessages(result.messages));
          setContextInfo(result.context);
        }
      } catch (err) {
        if (cancelled) return;
        if (isNetworkError(err)) {
          try {
            await new Promise((resolve) => setTimeout(resolve, 400));
            let id = await ensureThread();
            let result = await loadMessages(id);
            if (!result) {
              id = await createThread();
              result = { messages: [], context: null };
            }
            if (!cancelled) {
              setMessages(trimMessages(result.messages));
              setContextInfo(result.context);
            }
            return;
          } catch (retryErr) {
            if (!cancelled) {
              setError(NETWORK_ERROR_MESSAGE);
            }
            return;
          }
        }
        setError(err instanceof Error ? err.message : 'Failed to load assistant chat.');
      } finally {
        if (!cancelled) {
          setLoadingThread(false);
        }
      }
    };
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [createThread, ensureThread, loadMessages, open, me?.id, resetting, threadKey]);

  useEffect(() => {
    const onAssistantUpdate = (evt: Event) => {
      const detail = (evt as CustomEvent).detail ?? {};
      const targetThreadId = typeof detail.threadId === 'string' ? detail.threadId : null;
      if (!targetThreadId || targetThreadId !== threadIdRef.current) return;
      const incoming = detail.message ?? null;
      if (!incoming || typeof incoming !== 'object') return;
      if (incoming.role !== 'assistant') return;
      setMessages((prev) => {
        if (incoming.id && prev.some((msg) => msg.id === incoming.id)) return prev;
        const next: ChatMessage = {
          id: incoming.id,
          role: incoming.role,
          content: incoming.content ?? '',
          createdAt: incoming.createdAt ?? null,
          selectionContext: (incoming?.meta?.selectionContext ?? null) as AssistantSelectionContext | null,
          trace: incoming?.meta?.trace ?? null,
        };
        return trimMessages([...prev, next]);
      });
      setPending(false);
      setError(null);
      if (!openRef.current || !isUiActive()) {
        setHasUnread(true);
      }
      if (detail.context && typeof detail.context === 'object') {
        setContextInfo(detail.context);
      }
    };
    window.addEventListener('assistant-update', onAssistantUpdate);
    return () => window.removeEventListener('assistant-update', onAssistantUpdate);
  }, [isUiActive]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || pending || loadingThread || resetting || !me || !sessionReady) return;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const selectionSnapshot = selectionContext ? { ...selectionContext } : null;
    const nextMessages = trimMessages([
      ...messages,
      { role: 'user', content: text, selectionContext: selectionSnapshot },
    ]);
    setMessages(nextMessages);
    setInput('');
    setPending(true);
    setError(null);
    if (selectionSnapshot) {
      clearSelectionContext();
    }

    let keepPending = false;
    try {
      const attempt = async () => {
        const id = await ensureThread();
        const res = await fetch(`/api/assistant/threads/${id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-assistant-client': 'widget-v2' },
          signal: controller.signal,
          body: JSON.stringify({
            content: text,
            sessionId,
            selectionContext: selectionSnapshot,
          }),
        });
        const raw = await res.text();
        let data: any = {};
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch {
            data = {};
          }
        }
        if (!res.ok) {
          const fallbackError = data?.error ?? (res.status ? `http_${res.status}` : undefined);
          if (fallbackError === 'thread_session_mismatch' || fallbackError === 'thread_not_found') {
            clearThread();
            return { retry: true };
          }
          const msg = mapErrorMessage(fallbackError);
          setError(msg);
          setMessages((prev) => trimMessages([...prev, { role: 'assistant', content: msg }]));
          return { retry: false };
        }
        if (res.status === 202 || data?.queued) {
          keepPending = true;
          return { retry: false, queued: true };
        }
        const reply = typeof data?.message === 'string' && data.message.trim()
          ? data.message.trim()
          : 'No response returned.';
        const assistantMeta = data?.assistantMessage?.meta ?? null;
        const assistantTrace = assistantMeta?.trace ?? null;
        setMessages((prev) => trimMessages([
          ...prev,
          {
            role: 'assistant',
            content: reply,
            trace: assistantTrace,
            id: data?.assistantMessage?.id,
            createdAt: data?.assistantMessage?.createdAt ?? null,
          },
        ]));
        if (!openRef.current || !isUiActive()) {
          setHasUnread(true);
        }
        if (data?.context && typeof data.context === 'object') {
          setContextInfo(data.context);
        }
        return { retry: false, queued: false };
      };
      const first = await attempt();
      if (first?.retry) {
        const second = await attempt();
        keepPending = !!second?.queued;
      } else {
        keepPending = !!first?.queued;
      }
    } catch (err) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
        return;
      }
      const msg = isNetworkError(err)
        ? NETWORK_ERROR_MESSAGE
        : (err instanceof Error ? err.message : 'Assistant request failed. Please try again.');
      setError(msg);
      setMessages((prev) => trimMessages([...prev, { role: 'assistant', content: msg }]));
    } finally {
      if (!keepPending) {
        setPending(false);
      }
      requestAbortRef.current = null;
    }
  };

  const panelStyle = useMemo(() => {
    const width = isNarrow ? 'calc(var(--visual-width, 100vw) - 24px)' : panelSize.width;
    const height = isNarrow ? 'calc(var(--visual-height, 100vh) - 140px)' : panelSize.height;
    return {
      width,
      height,
      maxHeight: height,
      background: 'rgba(16, 19, 26, 0.96)',
      border: '1px solid var(--border-strong)',
      borderRadius: 18,
      boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      position: 'relative',
      boxSizing: 'border-box',
      transform: open ? 'translateY(0)' : 'translateY(8px)',
      opacity: open ? 1 : 0,
      transition: 'opacity 180ms ease, transform 180ms ease',
      pointerEvents: open ? 'auto' : 'none',
    } as React.CSSProperties;
  }, [isNarrow, open, panelSize]);

  const contextPercent = useMemo(() => {
    const ratio = contextInfo?.remainingRatio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
    const clamped = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    return clamped;
  }, [contextInfo]);

  const selectionCount = useMemo(() => {
    if (!selectionContext) return 0;
    const nodes = selectionContext.nodes?.length ?? 0;
    const edges = selectionContext.edges?.length ?? 0;
    const textBoxes = selectionContext.textBoxes?.length ?? 0;
    const comments = selectionContext.comments?.length ?? 0;
    return nodes + edges + textBoxes + comments;
  }, [selectionContext]);

  const statusLabel = useMemo(() => {
    if (!me) return 'Sign in to use the assistant';
    if (pending || assistantStatus === 'thinking') return 'Thinking...';
    return 'Connected to your canvas';
  }, [assistantStatus, me, pending]);

  const sendDisabled = !input.trim() || pending || loadingThread || resetting || !me || !sessionReady;

  const markdownComponents = useMemo(() => ({
    p: ({ node: _node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
      <p style={{ margin: '0 0 8px', lineHeight: 1.55 }} {...props}>{children}</p>
    ),
    ul: ({ node: _node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
      <ul style={{ margin: '0 0 8px 18px', padding: 0 }} {...props}>{children}</ul>
    ),
    ol: ({ node: _node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
      <ol style={{ margin: '0 0 8px 18px', padding: 0 }} {...props}>{children}</ol>
    ),
    li: ({ node: _node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
      <li style={{ margin: '0 0 4px' }} {...props}>{children}</li>
    ),
    a: ({ node: _node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
      <a
        {...props}
        style={{ color: 'var(--accent-primary)', textDecoration: 'none' }}
        target="_blank"
        rel="noreferrer"
      >
        {children}
      </a>
    ),
    blockquote: ({ node: _node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
      <blockquote
        {...props}
        style={{
          margin: '0 0 8px',
          padding: '6px 10px',
          borderLeft: '3px solid rgba(94,129,172,0.6)',
          color: 'var(--text-secondary)',
          background: 'rgba(255,255,255,0.04)',
          borderRadius: 8,
        }}
      >
        {children}
      </blockquote>
    ),
    code: ({
      node: _node,
      inline,
      children,
      ...props
    }: {
      node?: unknown;
      inline?: boolean;
      children?: React.ReactNode;
    }) => (
      <code
        {...props}
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: 12,
          padding: inline ? '1px 4px' : '8px 10px',
          borderRadius: 8,
          background: 'rgba(15, 20, 28, 0.7)',
          border: '1px solid rgba(255,255,255,0.08)',
          display: inline ? 'inline' : 'block',
          whiteSpace: 'pre-wrap',
        }}
      >
        {children}
      </code>
    ),
    pre: ({ node: _node, children, ...props }: { node?: unknown; children?: React.ReactNode }) => (
      <pre
        {...props}
        style={{
          margin: '0 0 8px',
          whiteSpace: 'pre-wrap',
          overflowX: 'auto',
        }}
      >
        {children}
      </pre>
    ),
  }), []);

  const styleTag = (
    <style>{`
      @keyframes ravenPulse {
        0%, 100% { opacity: 0.55; }
        50% { opacity: 1; }
      }
      @keyframes ravenDot {
        0%, 80%, 100% { opacity: 0.1; }
        40% { opacity: 1; }
      }
    `}</style>
  );

  return (
    <div
      ref={wrapperRef}
      style={{
        position: 'fixed',
        right: 'calc(16px + env(safe-area-inset-right, 0px))',
        bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        zIndex: 1900,
        display: 'grid',
        gap: 10,
        justifyItems: 'end',
      }}
    >
      {styleTag}
      {open && (
        <div style={panelStyle} aria-hidden={!open}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 14px',
              borderBottom: '1px solid var(--border-strong)',
              background: 'rgba(20, 24, 34, 0.95)',
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 12,
                background: 'linear-gradient(135deg, rgba(94,129,172,0.5), rgba(163,190,140,0.4))',
                display: 'grid',
                placeItems: 'center',
                color: '#fff',
              }}
            >
              <Bot size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Raven</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{statusLabel}</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                padding: 4,
              }}
              aria-label="Close assistant"
            >
              <X size={16} />
            </button>
          </div>

          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '14px 12px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              minHeight: 0,
              boxSizing: 'border-box',
              userSelect: 'text',
              WebkitUserSelect: 'text',
            }}
          >
            {messages.length === 0 && (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px dashed var(--border-strong)',
                  color: 'var(--text-secondary)',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                {loadingThread ? 'Loading chat history...' : 'Ask me to summarize the canvas, create nodes, or find connections.'}
              </div>
            )}

            {messages.map((msg, idx) => {
              if (msg.externalReply || (msg.role === 'user' && isExternalReplyContent(msg.content))) {
                return null;
              }
              const isExternal = msg.role === 'user' && !!msg.externalReply;
              const isUser = msg.role === 'user' && !isExternal;
              const isAssistant = msg.role === 'assistant';
              const hasSelection = isUser && !!msg.selectionContext && (
                (msg.selectionContext.nodes?.length ?? 0)
                + (msg.selectionContext.edges?.length ?? 0)
                + (msg.selectionContext.textBoxes?.length ?? 0)
                + (msg.selectionContext.comments?.length ?? 0)
              ) > 0;
              const trace = msg.trace ?? null;
              const hasTrace = isAssistant && !!trace && (
                !!(trace.reasoning && trace.reasoning.trim())
                || ((trace.tools?.length ?? 0) > 0)
              );
              const skillTrace = trace?.skill ?? null;
              const showFeedback = isAssistant && !!skillTrace?.runId && skillTrace?.found === true;
              const messageKey = msg.id ?? `${msg.role}-${idx}`;
              const feedbackValue = feedbackState[messageKey] ?? null;
              const feedbackIsBusy = feedbackBusy[messageKey] ?? false;
              const detailsOpen = expandedDetails[messageKey] ?? false;
              const externalLabel = msg.externalSender
                ? `Reply from ${msg.externalSender}`
                : 'Reply received';
              const channelSuffix = msg.externalChannel === 'telegram' ? 'Telegram' : null;
              return (
                <div
                  key={messageKey}
                  style={{
                    alignSelf: isUser ? 'flex-end' : 'flex-start',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    maxWidth: '85%',
                  }}
                >
                  {isExternal && (
                    <div
                      style={{
                        alignSelf: 'flex-start',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <MessageCircle size={12} />
                      <span>{channelSuffix ? `${externalLabel} · ${channelSuffix}` : externalLabel}</span>
                    </div>
                  )}
                  {hasSelection && (
                    <div
                      style={{
                        alignSelf: 'flex-end',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <Link2 size={12} />
                      <span>Selected objects attached</span>
                    </div>
                  )}
                  {hasTrace && (
                    <button
                      type="button"
                      onClick={() => toggleDetails(messageKey)}
                      style={{
                        alignSelf: 'flex-start',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                        borderRadius: 999,
                        border: '1px solid var(--border-strong)',
                        background: 'rgba(15, 20, 28, 0.55)',
                        padding: '4px 10px',
                        cursor: 'pointer',
                      }}
                    >
                      <span>Details</span>
                      {trace?.tools?.length ? (
                        <span>{`(${trace.tools.length} tools)`}</span>
                      ) : null}
                      {detailsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                  )}
                  {hasTrace && detailsOpen && (
                    <div
                      style={{
                        borderRadius: 12,
                        border: '1px solid var(--border-strong)',
                        background: 'rgba(10, 12, 18, 0.55)',
                        padding: '8px 10px',
                        display: 'grid',
                        gap: 8,
                        color: 'var(--text-secondary)',
                        fontSize: 12,
                        lineHeight: 1.5,
                      }}
                    >
                      {trace?.reasoning && trace.reasoning.trim() && (
                        <div style={{ display: 'grid', gap: 4 }}>
                          <div style={{ fontSize: 11, letterSpacing: 0.3, textTransform: 'uppercase' }}>
                            Reasoning
                          </div>
                          <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>
                            {trace.reasoning}
                          </div>
                        </div>
                      )}
                      {trace?.tools?.length ? (
                        <div style={{ display: 'grid', gap: 6 }}>
                          <div style={{ fontSize: 11, letterSpacing: 0.3, textTransform: 'uppercase' }}>
                            Tools
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {trace.tools.map((tool, toolIdx) => (
                              <span
                                key={`${messageKey}-tool-${toolIdx}`}
                                style={{
                                  borderRadius: 999,
                                  border: '1px solid rgba(255,255,255,0.12)',
                                  background: 'rgba(15, 18, 26, 0.6)',
                                  padding: '4px 8px',
                                  fontSize: 11,
                                  color: 'var(--text-primary)',
                                }}
                              >
                                {tool.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  )}
                  <div
                    style={{
                      background: isUser ? 'rgba(94,129,172,0.22)' : 'rgba(255,255,255,0.04)',
                      color: 'var(--text-primary)',
                      border: isExternal ? '1px dashed var(--border-strong)' : '1px solid var(--border-strong)',
                      borderRadius: 14,
                      padding: '8px 10px',
                      fontSize: 13,
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                      wordBreak: 'break-word',
                      lineHeight: 1.45,
                      userSelect: 'text',
                      WebkitUserSelect: 'text',
                    }}
                  >
                    {isUser ? (
                      msg.content
                    ) : (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {msg.content}
                      </ReactMarkdown>
                    )}
                  </div>
                  {showFeedback && (
                    <div
                      style={{
                        display: 'inline-flex',
                        gap: 6,
                        opacity: 0.7,
                        alignSelf: 'flex-start',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => sendSkillFeedback({
                          messageKey,
                          messageId: msg.id,
                          runId: skillTrace?.runId,
                          rating: 'positive',
                        })}
                        disabled={feedbackIsBusy || !!feedbackValue}
                        aria-label="Thumbs up"
                        style={{
                          width: 26,
                          height: 22,
                          display: 'grid',
                          placeItems: 'center',
                          borderRadius: 999,
                          border: '1px solid rgba(255,255,255,0.18)',
                          background: feedbackValue === 'up' ? 'rgba(163,190,140,0.2)' : 'rgba(255,255,255,0.04)',
                          color: feedbackValue === 'up' ? '#A3BE8C' : 'var(--text-secondary)',
                          cursor: feedbackIsBusy || feedbackValue ? 'not-allowed' : 'pointer',
                          transition: 'opacity 160ms ease, transform 160ms ease',
                        }}
                      >
                        <ThumbsUp size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => sendSkillFeedback({
                          messageKey,
                          messageId: msg.id,
                          runId: skillTrace?.runId,
                          rating: 'negative',
                        })}
                        disabled={feedbackIsBusy || !!feedbackValue}
                        aria-label="Thumbs down"
                        style={{
                          width: 26,
                          height: 22,
                          display: 'grid',
                          placeItems: 'center',
                          borderRadius: 999,
                          border: '1px solid rgba(255,255,255,0.18)',
                          background: feedbackValue === 'down' ? 'rgba(191,97,106,0.22)' : 'rgba(255,255,255,0.04)',
                          color: feedbackValue === 'down' ? '#BF616A' : 'var(--text-secondary)',
                          cursor: feedbackIsBusy || feedbackValue ? 'not-allowed' : 'pointer',
                          transition: 'opacity 160ms ease, transform 160ms ease',
                        }}
                      >
                        <ThumbsDown size={13} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {pending && (
              <div
                style={{
                  alignSelf: 'flex-start',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 14,
                  padding: '8px 10px',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  animation: 'ravenPulse 1.4s ease-in-out infinite',
                }}
              >
                <span>Thinking</span>
                <span style={{ display: 'inline-flex', gap: 2 }}>
                  {[0, 1, 2].map((idx) => (
                    <span
                      key={idx}
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: '50%',
                        background: 'currentColor',
                        display: 'inline-block',
                        animation: 'ravenDot 1.1s ease-in-out infinite',
                        animationDelay: `${idx * 0.2}s`,
                      }}
                    />
                  ))}
                </span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div
            style={{
              borderTop: '1px solid var(--border-strong)',
              padding: '10px 12px 12px',
              display: 'grid',
              gap: 8,
              background: 'rgba(12, 14, 20, 0.9)',
            }}
          >
            {selectionCount > 0 && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                }}
              >
                <Link2 size={12} />
                <span>{`${selectionCount} selected object${selectionCount === 1 ? '' : 's'} attached`}</span>
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Raven..."
              disabled={pending || !me || !sessionReady}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              style={{
                width: '100%',
                borderRadius: 12,
                border: '1px solid var(--border-strong)',
                background: 'rgba(15, 20, 28, 0.7)',
                color: 'var(--text-primary)',
                padding: '8px 10px',
                fontSize: 13,
                minHeight: 54,
                maxHeight: 140,
                resize: 'none',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: contextPercent !== null && contextPercent <= 15 ? '#EBCB8B' : 'var(--text-secondary)',
                    minWidth: 44,
                  }}
                >
                  {contextPercent !== null ? `${contextPercent}%` : '--%'}
                </div>
                <div style={{ fontSize: 11, color: error ? '#EBCB8B' : 'var(--text-secondary)' }}>
                  {error
                    ? error
                    : (sessionReady ? 'Enter to send, Shift+Enter for newline' : 'Waiting for session...')}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setShowResetConfirm(true)}
                  disabled={resetting}
                  aria-label="Start a new Raven chat"
                  title="Start a new chat"
                  style={{
                    borderRadius: 10,
                    border: '1px solid rgba(191,97,106,0.55)',
                    background: 'rgba(191,97,106,0.18)',
                    color: '#BF616A',
                    padding: '6px 8px',
                    fontSize: 12,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: resetting ? 'not-allowed' : 'pointer',
                    opacity: resetting ? 0.6 : 1,
                  }}
                >
                  <Trash2 size={14} />
                </button>
                <button
                  type="button"
                  onClick={pending ? stopRequest : () => void sendMessage()}
                  disabled={pending ? false : sendDisabled}
                  style={{
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: pending ? 'rgba(191,97,106,0.85)' : 'var(--accent-primary)',
                    color: '#fff',
                    padding: '6px 12px',
                    fontSize: 12,
                    cursor: pending ? 'pointer' : (sendDisabled ? 'not-allowed' : 'pointer'),
                  }}
                >
                  {pending ? 'Stop' : 'Send'}
                </button>
              </div>
            </div>
          </div>

          {!isNarrow && (
            <div
              role="presentation"
              onPointerDown={onResizeStart}
              style={{
                position: 'absolute',
                left: 8,
                top: 8,
                width: 18,
                height: 18,
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.04)',
                cursor: RESIZE_FROM_TOP_LEFT ? 'nwse-resize' : 'se-resize',
              }}
            />
          )}
          {showResetConfirm && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(6, 8, 12, 0.7)',
                display: 'grid',
                placeItems: 'center',
                padding: 20,
                zIndex: 20,
              }}
            >
              <div
                style={{
                  width: 'min(320px, 90%)',
                  borderRadius: 14,
                  border: '1px solid var(--border-strong)',
                  background: 'rgba(18, 22, 32, 0.98)',
                  padding: '14px 14px 12px',
                  display: 'grid',
                  gap: 10,
                  boxShadow: '0 12px 36px rgba(0,0,0,0.35)',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  Clear chat history?
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                  Are you sure you want to clear the Raven chat history?
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setShowResetConfirm(false)}
                    disabled={resetting}
                    style={{
                      borderRadius: 10,
                      border: '1px solid var(--border-strong)',
                      background: 'rgba(15, 20, 28, 0.7)',
                      color: 'var(--text-secondary)',
                      padding: '6px 10px',
                      fontSize: 12,
                      cursor: resetting ? 'not-allowed' : 'pointer',
                      opacity: resetting ? 0.6 : 1,
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmResetConversation()}
                    disabled={resetting}
                    style={{
                      borderRadius: 10,
                      border: '1px solid rgba(191,97,106,0.7)',
                      background: 'rgba(191,97,106,0.85)',
                      color: '#fff',
                      padding: '6px 10px',
                      fontSize: 12,
                      cursor: resetting ? 'not-allowed' : 'pointer',
                      opacity: resetting ? 0.7 : 1,
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close assistant' : 'Open assistant'}
        style={{
          width: 52,
          height: 52,
          borderRadius: 16,
          border: '1px solid var(--border-strong)',
          background: open ? 'var(--accent-primary)' : 'rgba(18, 22, 32, 0.9)',
          color: '#fff',
          boxShadow: '0 12px 30px rgba(0,0,0,0.4)',
          cursor: 'pointer',
          display: 'grid',
          placeItems: 'center',
          position: 'relative',
        }}
      >
        {open ? <X size={20} /> : <MessageCircle size={20} />}
        {hasUnread && (
          <span
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#BF616A',
              boxShadow: '0 0 0 2px rgba(18, 22, 32, 0.9)',
            }}
          />
        )}
      </button>
    </div>
  );
};
