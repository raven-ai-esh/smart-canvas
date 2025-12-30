import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import * as z from 'zod';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHttpLogger, createMetrics, getLogger } from '../observability.js';

const DEFAULT_BASE_URL = process.env.CANVAS_BASE_URL ?? 'http://localhost:8080';
const DEFAULT_SESSION_ID = process.env.CANVAS_SESSION_ID ?? process.env.DEFAULT_SESSION_ID ?? null;
const DEFAULT_CLIENT_ID = process.env.CANVAS_CLIENT_ID ?? `mcp-${randomUUID()}`;

const apiBaseUrl = DEFAULT_BASE_URL.replace(/\/$/, '');
const defaultWsUrl = process.env.CANVAS_WS_URL ?? (() => {
  const url = new URL(DEFAULT_BASE_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  return url.toString();
})();

const nowTs = () => Date.now();
const ts = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const tombstoneFor = (now, updatedAt) => Math.max(now, ts(updatedAt) + 1);
const AI_AUTHOR_NAME = 'Raven';
const MCP_TECH_USER_ID = process.env.MCP_TECH_USER_ID ?? 'raven-bot';
const MCP_WS_ACK_TIMEOUT_MS = Number(process.env.MCP_WS_ACK_TIMEOUT_MS ?? 4000);
const MCP_AUTH_CACHE_TTL_MS = Number(process.env.MCP_AUTH_CACHE_TTL_MS ?? 60_000);
const authCache = new Map();
const MCP_LOG_ENABLED = process.env.MCP_LOG_ENABLED !== 'false';
const MCP_LOG_TRUNCATE = Number(process.env.MCP_LOG_TRUNCATE ?? 800);
const MCP_TOOL_LIST_LIMIT = Number(process.env.MCP_TOOL_LIST_LIMIT ?? 200);

const logger = getLogger('smart-tracker-mcp');
const metrics = createMetrics({ serviceName: 'smart-tracker-mcp' });

const truncateString = (value) => {
  if (typeof value !== 'string') return value;
  if (!Number.isFinite(MCP_LOG_TRUNCATE) || MCP_LOG_TRUNCATE <= 0) return value;
  if (value.length <= MCP_LOG_TRUNCATE) return value;
  return `${value.slice(0, MCP_LOG_TRUNCATE)}...`;
};

const scrubValue = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return truncateString(value);
  if (t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return String(value);
  if (depth >= 3) return '[max_depth]';
  if (Array.isArray(value)) {
    if (value.length > 20) {
      return {
        _type: 'array',
        length: value.length,
        sample: value.slice(0, 5).map((item) => scrubValue(item, depth + 1)),
      };
    }
    return value.map((item) => scrubValue(item, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower.includes('token')) {
      out[key] = '[redacted]';
      continue;
    }
    if (key === 'dataUrl' || key === 'avatarUrl' || key === 'src') {
      out[key] = '[image_omitted]';
      continue;
    }
    out[key] = scrubValue(item, depth + 1);
  }
  return out;
};

const logEvent = (event, payload) => {
  if (!MCP_LOG_ENABLED) return;
  const safe = scrubValue(payload);
  console.log(`[mcp] ${event} ${JSON.stringify(safe)}`);
};

const normalizeListLimit = (limit) => {
  const base = Number.isFinite(MCP_TOOL_LIST_LIMIT) && MCP_TOOL_LIST_LIMIT > 0
    ? Math.floor(MCP_TOOL_LIST_LIMIT)
    : 200;
  if (!Number.isFinite(limit) || limit <= 0) return base;
  return Math.min(Math.floor(limit), base);
};

const limitList = (items, limit) => {
  const list = Array.isArray(items) ? items : [];
  const capped = normalizeListLimit(limit);
  const truncated = list.length > capped;
  return {
    items: truncated ? list.slice(0, capped) : list,
    total: list.length,
    limit: capped,
    truncated,
  };
};

const estimatePayloadSize = (payload) => {
  if (payload === null || payload === undefined) return 0;
  if (typeof payload === 'string') return payload.length;
  try {
    return JSON.stringify(payload).length;
  } catch {
    return 0;
  }
};

const getAuthTokenFromRequest = (req) => {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const alt = req.headers?.['x-mcp-token'];
  if (typeof alt === 'string') return alt.trim();
  if (Array.isArray(alt) && alt.length) return String(alt[0]).trim();
  return null;
};

const getSessionIdFromRequest = (req) => {
  const header = req.headers?.['x-session-id'] ?? req.headers?.['mcp-session-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header.length) return String(header[0]).trim();
  return null;
};

const getUserIdFromRequest = (req) => {
  const header = req.headers?.['x-user-id'] ?? req.headers?.['mcp-user-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header.length) return String(header[0]).trim();
  return null;
};

const normalizeMcpUser = (user) => {
  if (!user || typeof user !== 'object') return null;
  const id = typeof user.id === 'string' ? user.id : null;
  if (!id) return null;
  const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim() : 'User';
  return { id, name };
};

const resolveMcpAuth = async (token) => {
  if (!token) return null;
  const cached = authCache.get(token);
  if (cached) {
    if (cached.expiresAtMs && cached.expiresAtMs <= Date.now()) {
      authCache.delete(token);
    } else if (Date.now() - cached.cachedAt <= MCP_AUTH_CACHE_TTL_MS) {
      return cached;
    }
  }
  const res = await fetch(`${apiBaseUrl}/api/integrations/mcp/verify`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const user = normalizeMcpUser(data?.user);
  if (!user) return null;
  const expiresAt = typeof data?.token?.expiresAt === 'string' ? data.token.expiresAt : null;
  const parsedExpiresAt = expiresAt ? Date.parse(expiresAt) : null;
  const expiresAtMs = Number.isFinite(parsedExpiresAt) ? parsedExpiresAt : null;
  const authInfo = { user, expiresAt, expiresAtMs, cachedAt: Date.now() };
  authCache.set(token, authInfo);
  return authInfo;
};

const resolveAuthorFromExtra = (extra) => {
  const user = extra?.authInfo?.mcpUser;
  if (user) {
    return {
      authorId: user.id,
      authorName: user.name,
    };
  }
  return {
    authorId: null,
    authorName: AI_AUTHOR_NAME,
  };
};

const emptyPatch = () => ({
  nodes: [],
  edges: [],
  drawings: [],
  textBoxes: [],
  comments: [],
  layers: [],
  tombstones: {
    nodes: {},
    edges: {},
    drawings: {},
    textBoxes: {},
    comments: {},
    layers: {},
  },
});

const normalizeTombstones = (input) => {
  const base = input && typeof input === 'object' ? input : {};
  const toMap = (value) => {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const [key, raw] of Object.entries(value)) {
      const num = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw);
      if (!Number.isFinite(num)) continue;
      out[key] = num;
    }
    return out;
  };
  return {
    nodes: toMap(base.nodes),
    edges: toMap(base.edges),
    drawings: toMap(base.drawings),
    textBoxes: toMap(base.textBoxes),
    comments: toMap(base.comments),
    layers: toMap(base.layers),
  };
};

const normalizePatch = (input) => ({
  nodes: Array.isArray(input?.nodes) ? input.nodes : [],
  edges: Array.isArray(input?.edges) ? input.edges : [],
  drawings: Array.isArray(input?.drawings) ? input.drawings : [],
  textBoxes: Array.isArray(input?.textBoxes) ? input.textBoxes : [],
  comments: Array.isArray(input?.comments) ? input.comments : [],
  layers: Array.isArray(input?.layers) ? input.layers : [],
  tombstones: normalizeTombstones(input?.tombstones),
});

class CanvasSessionClient {
  constructor({ baseUrl, wsUrl, sessionId, clientId }) {
    this.baseUrl = baseUrl;
    this.wsUrl = wsUrl;
    this.sessionId = sessionId;
    this.clientId = clientId;
    this.ws = null;
    this.wsSessionId = null;
    this.connecting = null;
    this.pendingAcks = new Map();
  }

  async resolveSessionId(sessionId) {
    if (sessionId) {
      this.sessionId = sessionId;
      return sessionId;
    }
    if (this.sessionId) return this.sessionId;
    throw new Error('session_id_required');
  }

  async fetchSession(sessionId) {
    const id = await this.resolveSessionId(sessionId);
    const res = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(id)}`);
    if (!res.ok) {
      throw new Error(`session_fetch_failed:${res.status}`);
    }
    return res.json();
  }

  async fetchState(sessionId) {
    const session = await this.fetchSession(sessionId);
    return session?.state ?? null;
  }

  async ensureWs(sessionId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.wsSessionId === sessionId) {
      return;
    }

    if (this.connecting) {
      if (this.wsSessionId === sessionId) {
        await this.connecting;
        return;
      }
      try {
        await this.connecting;
      } catch {
        // ignore failed in-flight connection
      }
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }

    if (!this.connecting) {
      const url = new URL(this.wsUrl);
      url.searchParams.set('sessionId', sessionId);
      url.searchParams.set('clientId', this.clientId);
      const ws = new WebSocket(url.toString());
      this.ws = ws;
      this.wsSessionId = sessionId;

      this.connecting = new Promise((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', (err) => reject(err));
        ws.once('close', (code) => reject(new Error(`ws_closed:${code}`)));
      }).finally(() => {
        this.connecting = null;
      });

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg?.type !== 'update') return;
        const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
        if (!requestId) return;
        const entry = this.pendingAcks.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pendingAcks.delete(requestId);
        entry.resolve();
      });

      ws.on('close', (code) => {
        if (this.ws === ws) {
          this.ws = null;
          this.wsSessionId = null;
        }
        for (const [requestId, entry] of this.pendingAcks.entries()) {
          clearTimeout(entry.timer);
          entry.reject(new Error(`ws_closed:${typeof code === 'number' ? code : 1005}`));
          this.pendingAcks.delete(requestId);
        }
      });
    }

    await this.connecting;
  }

  waitForAck(requestId) {
    if (!Number.isFinite(MCP_WS_ACK_TIMEOUT_MS) || MCP_WS_ACK_TIMEOUT_MS <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(requestId);
        reject(new Error('ack_timeout'));
      }, MCP_WS_ACK_TIMEOUT_MS);
      this.pendingAcks.set(requestId, { resolve, reject, timer });
    });
  }

  async sendPatch(sessionId, patch) {
    const id = await this.resolveSessionId(sessionId);
    await this.ensureWs(id);
    const requestId = randomUUID();
    const payload = {
      type: 'update',
      clientId: this.clientId,
      requestId,
      state: patch,
    };
    const sendOnce = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error('ws_not_open');
      }
      this.ws.send(JSON.stringify(payload));
    };
    try {
      const ack = this.waitForAck(requestId);
      sendOnce();
      await ack;
    } catch (err) {
      const existing = this.pendingAcks.get(requestId);
      if (existing) {
        clearTimeout(existing.timer);
        this.pendingAcks.delete(requestId);
      }
      logEvent('patch_retry', { sessionId: id, requestId, error: err?.message ?? String(err) });
      await this.ensureWs(id);
      const ack = this.waitForAck(requestId);
      sendOnce();
      await ack;
    }
    return { sessionId: id, requestId };
  }
}

const client = new CanvasSessionClient({
  baseUrl: apiBaseUrl,
  wsUrl: defaultWsUrl,
  sessionId: DEFAULT_SESSION_ID,
  clientId: DEFAULT_CLIENT_ID,
});

const toolResult = (output) => ({
  content: [{ type: 'text', text: JSON.stringify(output) }],
  structuredContent: output,
});

const NodeType = z.enum(['task', 'idea']);
const NodeStatus = z.enum(['queued', 'in_progress', 'done']);
const CrudAction = z.enum(['create', 'read', 'update', 'delete']);
const StateMode = z.enum(['summary', 'full']);
const TargetKind = z.enum(['canvas', 'node', 'edge', 'textBox']);
const AttachmentKind = z.enum(['image', 'file']);
const PenTool = z.enum(['pen', 'eraser', 'highlighter']);
const ZoomTarget = z.enum(['to_cards', 'to_graph', 'to_fit']);
const ViewAction = z.enum(['focus_node', 'zoom_to_cards', 'zoom_to_graph', 'zoom_to_fit', 'pan']);

const sendCanvasView = async ({ sessionId, action, nodeId, x, y, scale }, extra) => {
  const token = extra?.authInfo?.mcpToken;
  if (!token) throw new Error('mcp_token_required');
  const targetUserId = extra?.authInfo?.actingUserId;
  const resolvedSessionId = await client.resolveSessionId(sessionId);
  const payload = {
    sessionId: resolvedSessionId,
    action,
  };
  if (nodeId) payload.nodeId = nodeId;
  if (Number.isFinite(x)) payload.x = Number(x);
  if (Number.isFinite(y)) payload.y = Number(y);
  if (Number.isFinite(scale)) payload.scale = Number(scale);
  if (typeof targetUserId === 'string' && targetUserId.trim()) {
    payload.targetUserId = targetUserId.trim();
  }
  const res = await fetch(`${apiBaseUrl}/api/integrations/mcp/view`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`view_failed:${res.status}`);
  const data = await res.json().catch(() => ({}));
  return { sessionId: resolvedSessionId, ...data };
};

const requestCanvasSnapshot = async ({ sessionId, timeoutMs }, extra) => {
  const token = extra?.authInfo?.mcpToken;
  if (!token) throw new Error('mcp_token_required');
  const resolvedSessionId = await client.resolveSessionId(sessionId);
  const payload = {
    sessionId: resolvedSessionId,
  };
  if (Number.isFinite(timeoutMs)) {
    payload.timeoutMs = Number(timeoutMs);
  }
  const res = await fetch(`${apiBaseUrl}/api/integrations/mcp/snapshot`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`snapshot_failed:${res.status}`);
  const data = await res.json().catch(() => ({}));
  return { sessionId: resolvedSessionId, ...data };
};

const fetchCanvasParticipants = async ({ sessionId }, extra) => {
  const token = extra?.authInfo?.mcpToken;
  if (!token) throw new Error('mcp_token_required');
  const resolvedSessionId = await client.resolveSessionId(sessionId);
  const res = await fetch(`${apiBaseUrl}/api/integrations/mcp/participants`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId: resolvedSessionId }),
  });
  if (!res.ok) throw new Error(`participants_failed:${res.status}`);
  const data = await res.json().catch(() => ({}));
  const participants = Array.isArray(data?.participants) ? data.participants : [];
  return { sessionId: resolvedSessionId, participants };
};

const sendAlert = async ({ sessionId, userRef, message }, extra) => {
  const token = extra?.authInfo?.mcpToken;
  if (!token) throw new Error('mcp_token_required');
  const resolvedSessionId = await client.resolveSessionId(sessionId);
  const payload = { sessionId: resolvedSessionId, userId: userRef, message };
  const res = await fetch(`${apiBaseUrl}/api/integrations/mcp/alert`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data?.error === 'string' ? `:${data.error}` : '';
    throw new Error(`alert_failed:${res.status}${detail}`);
  }
  return { sessionId: resolvedSessionId, ...data };
};

const normalizeParticipants = (items) => {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items
    .map((item) => ({
      id: typeof item?.id === 'string' ? item.id : '',
      name: typeof item?.name === 'string' ? item.name : '',
      email: typeof item?.email === 'string' ? item.email : '',
      savedAt: item?.savedAt ?? null,
    }))
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
};

const sanitizeAttachments = (attachments) => {
  if (!Array.isArray(attachments)) return attachments;
  return attachments.map((attachment) => {
    if (!attachment || typeof attachment !== 'object') return attachment;
    const { dataUrl, ...rest } = attachment;
    return rest;
  });
};

const sanitizeComment = (comment) => {
  if (!comment || typeof comment !== 'object') return comment;
  const next = { ...comment };
  if (Array.isArray(next.attachments)) {
    next.attachments = sanitizeAttachments(next.attachments);
  }
  if ('avatarUrl' in next) {
    delete next.avatarUrl;
  }
  return next;
};

const sanitizeTextBox = (textBox) => {
  if (!textBox || typeof textBox !== 'object') return textBox;
  const hasSrc = typeof textBox.src === 'string' && textBox.src.trim();
  const isMediaKind = textBox.kind === 'image' || textBox.kind === 'file';
  if (!hasSrc || !isMediaKind) return textBox;
  return { ...textBox, src: null };
};

const sanitizeState = (state) => {
  if (!state || typeof state !== 'object') return state;
  return {
    ...state,
    comments: Array.isArray(state.comments) ? state.comments.map(sanitizeComment) : state.comments,
    textBoxes: Array.isArray(state.textBoxes) ? state.textBoxes.map(sanitizeTextBox) : state.textBoxes,
  };
};

const attachParticipantsToNodes = (nodes, participants) => {
  if (!Array.isArray(nodes)) return [];
  const byId = new Map();
  participants.forEach((person) => {
    if (!person?.id) return;
    byId.set(person.id, person);
  });
  return nodes.map((node) => {
    const mentions = Array.isArray(node?.mentions) ? node.mentions : [];
    if (!mentions.length) return node;
    const seen = new Set();
    const allMentioned = mentions.some((mention) => {
      const id = typeof mention?.id === 'string' ? mention.id : '';
      const label = typeof mention?.label === 'string' ? mention.label : '';
      return id === 'all' || label.trim().toLowerCase() === 'all';
    });
    const nodeParticipants = [];
    if (allMentioned) {
      participants.forEach((person) => {
        if (!person?.id || seen.has(person.id)) return;
        seen.add(person.id);
        nodeParticipants.push({
          id: person.id,
          label: person.name || person.email || 'User',
          name: person.name ?? '',
          email: person.email ?? '',
        });
      });
    }
    mentions.forEach((mention) => {
      const id = typeof mention?.id === 'string' ? mention.id : '';
      if (!id || seen.has(id)) return;
      const label = typeof mention?.label === 'string' ? mention.label : '';
      if (id === 'all' || label.trim().toLowerCase() === 'all') return;
      seen.add(id);
      const person = byId.get(id);
      nodeParticipants.push({
        id,
        label,
        name: person?.name ?? label ?? '',
        email: person?.email ?? '',
      });
    });
    if (!nodeParticipants.length) return node;
    return { ...node, participants: nodeParticipants };
  });
};

const server = new McpServer({
  name: 'smart-tracker-canvas',
  version: '0.1.0',
});

const toolRegistry = new Map();
const registerTool = (name, meta, handler) => {
  toolRegistry.set(name, { meta, handler });
  const wrapped = async (input, extra) => {
    const startedAt = Date.now();
    const authSessionId = typeof extra?.authInfo?.sessionId === 'string' ? extra.authInfo.sessionId : null;
    const resolvedInput = (() => {
      if (!authSessionId) return input;
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const { sessionId: _ignored, ...rest } = input;
        return { ...rest, sessionId: authSessionId };
      }
      return { sessionId: authSessionId };
    })();
    const sessionId = resolvedInput?.sessionId ?? client.sessionId ?? null;
    const userId = extra?.authInfo?.mcpUser?.id ?? null;
    const inputPayload = resolvedInput ?? input;
    logEvent('tool_start', {
      tool: name,
      sessionId,
      userId,
      inputSize: estimatePayloadSize(inputPayload),
      input: inputPayload,
    });
    try {
      const result = await handler(resolvedInput, extra);
      const output = result?.structuredContent ?? result;
      logEvent('tool_ok', {
        tool: name,
        sessionId,
        userId,
        durationMs: Date.now() - startedAt,
        outputSize: estimatePayloadSize(output),
        output,
      });
      return result;
    } catch (err) {
      logEvent('tool_error', {
        tool: name,
        sessionId,
        userId,
        durationMs: Date.now() - startedAt,
        error: err?.message ?? String(err),
      });
      throw err;
    }
  };
  return server.registerTool(name, meta, wrapped);
};

const summarizeNode = (node) => ({
  id: node.id,
  title: node.title,
  type: node.type,
  status: node.status,
  progress: node.progress,
  authorId: node.authorId ?? null,
  authorName: node.authorName ?? null,
  mentions: Array.isArray(node.mentions) ? node.mentions : [],
  createdAt: node.createdAt ?? null,
  updatedAt: node.updatedAt ?? null,
});

const summarizeEdge = (edge) => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  label: edge.label ?? null,
});

const summarizeState = (state, limit) => {
  const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
  const edges = Array.isArray(state?.edges) ? state.edges : [];
  const drawings = Array.isArray(state?.drawings) ? state.drawings : [];
  const textBoxes = Array.isArray(state?.textBoxes) ? state.textBoxes : [];
  const comments = Array.isArray(state?.comments) ? state.comments : [];
  const limitedNodes = limitList(nodes, limit);
  const limitedEdges = limitList(edges, limit);
  return {
    theme: state?.theme ?? 'dark',
    nodes: limitedNodes.items.map(summarizeNode),
    edges: limitedEdges.items.map(summarizeEdge),
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      drawings: drawings.length,
      textBoxes: textBoxes.length,
      comments: comments.length,
    },
    truncated: {
      nodes: limitedNodes.truncated,
      edges: limitedEdges.truncated,
    },
    limit: limitedNodes.limit,
  };
};

const resolveStateMode = (mode, extra) => {
  const requested = mode === 'full' ? 'full' : 'summary';
  const callerId = extra?.authInfo?.mcpUser?.id ?? null;
  if (requested === 'full' && callerId === MCP_TECH_USER_ID) {
    return 'summary';
  }
  return requested;
};

const toJsonSchema = (schema) => {
  if (!schema) return null;
  if (typeof schema?.toJSONSchema === 'function') {
    return schema.toJSONSchema();
  }
  if (typeof schema === 'object' && !Array.isArray(schema)) {
    return z.object(schema).toJSONSchema();
  }
  return null;
};

registerTool(
  'get_state',
  {
    title: 'Get Canvas State',
    description: 'Fetches the current session state (nodes, edges, drawings, textBoxes, comments) and includes participants.',
    inputSchema: { mode: StateMode.optional(), limit: z.number().optional() },
    outputSchema: { id: z.string(), version: z.number(), state: z.any(), meta: z.any(), participants: z.array(z.any()) },
  },
  async ({ sessionId, mode, limit }, extra) => {
    const session = await client.fetchSession(sessionId);
    const participantPayload = await fetchCanvasParticipants({ sessionId }, extra);
    const participants = normalizeParticipants(participantPayload.participants);
    const rawVersion = session?.version;
    const version = typeof rawVersion === 'number' ? rawVersion : Number(rawVersion);
    const state = session?.state && typeof session.state === 'object' ? session.state : {};
    const nodesWithParticipants = attachParticipantsToNodes(state?.nodes ?? [], participants);
    const fullState = sanitizeState({
      ...state,
      nodes: nodesWithParticipants,
    });
    const resolvedMode = resolveStateMode(mode, extra);
    const normalized = {
      ...session,
      version: Number.isFinite(version) ? version : 0,
      participants,
      state: resolvedMode === 'full' ? fullState : summarizeState(fullState, limit),
    };
    return toolResult(normalized);
  }
);

registerTool(
  'list_canvas_participants',
  {
    title: 'List Canvas Participants',
    description: 'Returns users who saved the canvas and can be tagged.',
    inputSchema: { limit: z.number().optional() },
    outputSchema: {
      sessionId: z.string(),
      participants: z.array(z.any()),
      total: z.number().optional(),
      limit: z.number().optional(),
      truncated: z.boolean().optional(),
    },
  },
  async ({ sessionId, limit }, extra) => {
    const payload = await fetchCanvasParticipants({ sessionId }, extra);
    const participants = normalizeParticipants(payload.participants);
    const limited = limitList(participants, limit);
    return toolResult({
      sessionId: payload.sessionId,
      participants: limited.items,
      total: limited.total,
      limit: limited.limit,
      truncated: limited.truncated,
    });
  }
);

registerTool(
  'send_alert',
  {
    title: 'Send Alert',
    description: 'Sends a Raven alert to a canvas participant using their enabled alerting channels. Pass userRef as the participant id (preferred) or their name/email/handle from list_canvas_participants.',
    inputSchema: {
      userRef: z.string(),
      message: z.string(),
    },
    outputSchema: {
      ok: z.boolean().optional(),
      sessionId: z.string().optional(),
      userId: z.string().optional(),
      delivered: z.any().optional(),
    },
  },
  async ({ sessionId, userRef, message }, extra) => {
    if (typeof userRef !== 'string' || !userRef.trim()) throw new Error('user_ref_required');
    if (typeof message !== 'string' || !message.trim()) throw new Error('message_required');
    const result = await sendAlert({ sessionId, userRef: userRef.trim(), message }, extra);
    return toolResult(result);
  }
);

registerTool(
  'node',
  {
    title: 'Node',
    description: 'Creates, reads, updates, or deletes nodes based on the action.',
    inputSchema: {
      action: CrudAction,
      mode: StateMode.optional(),
      limit: z.number().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      content: z.string().optional(),
      type: NodeType.optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      clarity: z.number().optional(),
      energy: z.number().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      status: NodeStatus.optional(),
      progress: z.number().optional(),
      patch: z.any().optional(),
      authorId: z.string().nullable().optional(),
      authorName: z.string().nullable().optional(),
    },
    outputSchema: {
      action: CrudAction,
      node: z.any().optional(),
      nodes: z.array(z.any()).optional(),
      total: z.number().optional(),
      limit: z.number().optional(),
      truncated: z.boolean().optional(),
      deletedNodeId: z.string().optional(),
      deletedEdgeIds: z.array(z.string()).optional(),
      participants: z.array(z.any()).optional(),
      sessionId: z.string().optional(),
      requestId: z.string().optional(),
    },
  },
  async (input, extra) => {
    const action = input.action;
    if (action === 'read') {
      const state = await client.fetchState(input.sessionId);
      const participantPayload = await fetchCanvasParticipants({ sessionId: input.sessionId }, extra);
      const participants = normalizeParticipants(participantPayload.participants);
      const nodesWithParticipants = attachParticipantsToNodes(state?.nodes ?? [], participants);
      if (input.id) {
        const node = nodesWithParticipants.find((n) => n.id === input.id) ?? null;
        return toolResult({ action, node, participants });
      }
      const limited = limitList(nodesWithParticipants, input.limit);
      const resolvedMode = resolveStateMode(input.mode, extra);
      const nodes = resolvedMode === 'full' ? limited.items : limited.items.map(summarizeNode);
      return toolResult({
        action,
        nodes,
        participants,
        total: limited.total,
        limit: limited.limit,
        truncated: limited.truncated,
      });
    }

    if (action === 'create') {
      if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('title_required');
      if (!Number.isFinite(input.x)) throw new Error('x_required');
      if (!Number.isFinite(input.y)) throw new Error('y_required');
      const author = resolveAuthorFromExtra(extra);
      const now = nowTs();
      const node = {
        id: input.id ?? randomUUID(),
        title: input.title,
        content: input.content ?? '',
        type: input.type ?? 'idea',
        x: input.x,
        y: input.y,
        clarity: Number.isFinite(input.clarity) ? input.clarity : 0.5,
        energy: Number.isFinite(input.energy) ? input.energy : 50,
        startDate: input.startDate,
        endDate: input.endDate,
        status: input.status,
        progress: input.progress,
        authorId: author.authorId ?? undefined,
        authorName: author.authorName ?? undefined,
        createdAt: now,
        updatedAt: now,
      };
      const patch = emptyPatch();
      patch.nodes.push(node);
      const result = await client.sendPatch(input.sessionId, patch);
      return toolResult({ action, node, ...result });
    }

    if (action === 'update') {
      if (!input.id) throw new Error('id_required');
      if (!input.patch || typeof input.patch !== 'object') throw new Error('patch_required');
      const state = await client.fetchState(input.sessionId);
      const current = state?.nodes?.find((n) => n.id === input.id);
      if (!current) throw new Error('node_not_found');
      const next = { ...current, ...input.patch, id: input.id, updatedAt: nowTs() };
      const updatePatch = emptyPatch();
      updatePatch.nodes.push(next);
      const result = await client.sendPatch(input.sessionId, updatePatch);
      return toolResult({ action, node: next, ...result });
    }

    if (action === 'delete') {
      if (!input.id) throw new Error('id_required');
      const state = await client.fetchState(input.sessionId);
      const nodes = state?.nodes ?? [];
      const node = nodes.find((n) => n.id === input.id);
      const edges = state?.edges ?? [];
      const edgesById = new Map(edges.map((edge) => [edge.id, edge]));
      const edgeIds = edges.filter((e) => e.source === input.id || e.target === input.id).map((e) => e.id);
      const patch = emptyPatch();
      const now = nowTs();
      patch.tombstones.nodes[input.id] = tombstoneFor(now, node?.updatedAt);
      for (const edgeId of edgeIds) {
        const edge = edgesById.get(edgeId);
        patch.tombstones.edges[edgeId] = tombstoneFor(now, edge?.updatedAt);
      }
      const result = await client.sendPatch(input.sessionId, patch);
      return toolResult({ action, deletedNodeId: input.id, deletedEdgeIds: edgeIds, ...result });
    }

    throw new Error('action_not_supported');
  }
);

registerTool(
  'edge',
  {
    title: 'Edge',
    description: 'Creates, reads, updates, or deletes edges based on the action.',
    inputSchema: {
      action: CrudAction,
      limit: z.number().optional(),
      id: z.string().optional(),
      source: z.string().optional(),
      target: z.string().optional(),
      type: z.enum(['default', 'connection']).optional(),
      energyEnabled: z.boolean().optional(),
      patch: z.any().optional(),
      authorId: z.string().nullable().optional(),
      authorName: z.string().nullable().optional(),
    },
    outputSchema: {
      action: CrudAction,
      edge: z.any().optional(),
      edges: z.array(z.any()).optional(),
      total: z.number().optional(),
      limit: z.number().optional(),
      truncated: z.boolean().optional(),
      deletedEdgeId: z.string().optional(),
      sessionId: z.string().optional(),
      requestId: z.string().optional(),
    },
  },
  async (input, extra) => {
    const action = input.action;
    if (action === 'read') {
      const state = await client.fetchState(input.sessionId);
      if (input.id) {
        const edge = state?.edges?.find((e) => e.id === input.id) ?? null;
        return toolResult({ action, edge });
      }
      const limited = limitList(state?.edges ?? [], input.limit);
      return toolResult({
        action,
        edges: limited.items,
        total: limited.total,
        limit: limited.limit,
        truncated: limited.truncated,
      });
    }

    if (action === 'create') {
      if (!input.source) throw new Error('source_required');
      if (!input.target) throw new Error('target_required');
      const state = await client.fetchState(input.sessionId);
      const nodes = state?.nodes ?? [];
      const nodeIds = new Set(nodes.map((node) => node.id));
      if (!nodeIds.has(input.source)) throw new Error('source_node_not_found');
      if (!nodeIds.has(input.target)) throw new Error('target_node_not_found');
      const author = resolveAuthorFromExtra(extra);
      const now = nowTs();
      const edge = {
        id: input.id ?? randomUUID(),
        source: input.source,
        target: input.target,
        type: input.type ?? 'default',
        energyEnabled: typeof input.energyEnabled === 'boolean' ? input.energyEnabled : undefined,
        authorId: author.authorId ?? undefined,
        authorName: author.authorName ?? undefined,
        createdAt: now,
        updatedAt: now,
      };
      const patch = emptyPatch();
      patch.edges.push(edge);
      const result = await client.sendPatch(input.sessionId, patch);
      return toolResult({ action, edge, ...result });
    }

    if (action === 'update') {
      if (!input.id) throw new Error('id_required');
      if (!input.patch || typeof input.patch !== 'object') throw new Error('patch_required');
      const state = await client.fetchState(input.sessionId);
      const current = state?.edges?.find((e) => e.id === input.id);
      if (!current) throw new Error('edge_not_found');
      const nodes = state?.nodes ?? [];
      if (input.patch.source || input.patch.target) {
        const nodeIds = new Set(nodes.map((node) => node.id));
        if (input.patch.source && !nodeIds.has(input.patch.source)) throw new Error('source_node_not_found');
        if (input.patch.target && !nodeIds.has(input.patch.target)) throw new Error('target_node_not_found');
      }
      const next = { ...current, ...input.patch, id: input.id, updatedAt: nowTs() };
      const updatePatch = emptyPatch();
      updatePatch.edges.push(next);
      const result = await client.sendPatch(input.sessionId, updatePatch);
      return toolResult({ action, edge: next, ...result });
    }

    if (action === 'delete') {
      if (!input.id) throw new Error('id_required');
      const patch = emptyPatch();
      const state = await client.fetchState(input.sessionId);
      const edge = state?.edges?.find((e) => e.id === input.id);
      const now = nowTs();
      patch.tombstones.edges[input.id] = tombstoneFor(now, edge?.updatedAt);
      const result = await client.sendPatch(input.sessionId, patch);
      return toolResult({ action, deletedEdgeId: input.id, ...result });
    }

    throw new Error('action_not_supported');
  }
);

registerTool(
  'textbox',
  {
    title: 'Text Box',
    description: 'Creates, reads, updates, or deletes text boxes based on the action.',
    inputSchema: {
      action: CrudAction,
      limit: z.number().optional(),
      id: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      text: z.string().optional(),
      kind: z.enum(['text', 'image', 'file']).optional(),
      src: z.string().optional(),
      fileName: z.string().optional(),
      fileMime: z.string().optional(),
      fileSize: z.number().optional(),
      patch: z.any().optional(),
      authorId: z.string().nullable().optional(),
      authorName: z.string().nullable().optional(),
    },
    outputSchema: {
      action: CrudAction,
      textBox: z.any().optional(),
      textBoxes: z.array(z.any()).optional(),
      total: z.number().optional(),
      limit: z.number().optional(),
      truncated: z.boolean().optional(),
      deletedTextBoxId: z.string().optional(),
      sessionId: z.string().optional(),
      requestId: z.string().optional(),
    },
  },
  async (input, extra) => {
    const action = input.action;
    if (action === 'read') {
      const state = await client.fetchState(input.sessionId);
      if (input.id) {
        const textBox = state?.textBoxes?.find((tb) => tb.id === input.id) ?? null;
        return toolResult({ action, textBox: sanitizeTextBox(textBox) });
      }
      const limited = limitList(state?.textBoxes ?? [], input.limit);
      return toolResult({
        action,
        textBoxes: limited.items.map(sanitizeTextBox),
        total: limited.total,
        limit: limited.limit,
        truncated: limited.truncated,
      });
    }

    if (action === 'create') {
      if (!Number.isFinite(input.x)) throw new Error('x_required');
      if (!Number.isFinite(input.y)) throw new Error('y_required');
      if (!Number.isFinite(input.width)) throw new Error('width_required');
      if (!Number.isFinite(input.height)) throw new Error('height_required');
      if (typeof input.text !== 'string') throw new Error('text_required');
      const author = resolveAuthorFromExtra(extra);
      const now = nowTs();
      const textBox = {
        id: input.id ?? randomUUID(),
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        text: input.text,
        kind: input.kind,
        src: input.src,
        fileName: input.fileName,
        fileMime: input.fileMime,
        fileSize: input.fileSize,
        authorId: author.authorId ?? undefined,
        authorName: author.authorName ?? undefined,
        createdAt: now,
        updatedAt: now,
      };
      const patch = emptyPatch();
      patch.textBoxes.push(textBox);
      const result = await client.sendPatch(input.sessionId, patch);
      return toolResult({ action, textBox: sanitizeTextBox(textBox), ...result });
    }

    if (action === 'update') {
      if (!input.id) throw new Error('id_required');
      if (!input.patch || typeof input.patch !== 'object') throw new Error('patch_required');
      const state = await client.fetchState(input.sessionId);
      const current = state?.textBoxes?.find((tb) => tb.id === input.id);
      if (!current) throw new Error('textbox_not_found');
      const next = { ...current, ...input.patch, id: input.id, updatedAt: nowTs() };
      const updatePatch = emptyPatch();
      updatePatch.textBoxes.push(next);
      const result = await client.sendPatch(input.sessionId, updatePatch);
      return toolResult({ action, textBox: sanitizeTextBox(next), ...result });
    }

    if (action === 'delete') {
      if (!input.id) throw new Error('id_required');
      const patch = emptyPatch();
      const state = await client.fetchState(input.sessionId);
      const textBox = state?.textBoxes?.find((t) => t.id === input.id);
      const now = nowTs();
      patch.tombstones.textBoxes[input.id] = tombstoneFor(now, textBox?.updatedAt);
      const result = await client.sendPatch(input.sessionId, patch);
      return toolResult({ action, deletedTextBoxId: input.id, ...result });
    }

    throw new Error('action_not_supported');
  }
);

registerTool(
  'comment',
  {
    title: 'Comment',
    description: 'Creates, reads, updates, or deletes comments based on the action.',
    inputSchema: {
      action: CrudAction,
      limit: z.number().optional(),
      id: z.string().optional(),
      targetKind: TargetKind.optional(),
      targetId: z.string().nullable().optional(),
      parentId: z.string().nullable().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      text: z.string().optional(),
      attachments: z.array(z.object({
        id: z.string(),
        kind: AttachmentKind,
        name: z.string(),
        size: z.number(),
        mime: z.string(),
        url: z.string().optional(),
        dataUrl: z.string().optional(),
      })).optional(),
      patch: z.any().optional(),
      authorId: z.string().nullable().optional(),
      authorName: z.string().nullable().optional(),
    },
    outputSchema: {
      action: CrudAction,
      comment: z.any().optional(),
      comments: z.array(z.any()).optional(),
      total: z.number().optional(),
      limit: z.number().optional(),
      truncated: z.boolean().optional(),
      deletedCommentIds: z.array(z.string()).optional(),
      sessionId: z.string().optional(),
      requestId: z.string().optional(),
    },
  },
  async (input, extra) => {
    const action = input.action;
    if (action === 'read') {
      const state = await client.fetchState(input.sessionId);
      if (input.id) {
        const comment = state?.comments?.find((c) => c.id === input.id) ?? null;
        return toolResult({ action, comment: sanitizeComment(comment) });
      }
      const limited = limitList(state?.comments ?? [], input.limit);
      return toolResult({
        action,
        comments: limited.items.map(sanitizeComment),
        total: limited.total,
        limit: limited.limit,
        truncated: limited.truncated,
      });
    }

    if (action === 'create') {
      if (!input.targetKind) throw new Error('target_kind_required');
      if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('text_required');
      const author = resolveAuthorFromExtra(extra);
      const now = nowTs();
      const comment = {
        id: input.id ?? randomUUID(),
        targetKind: input.targetKind,
        targetId: input.targetId ?? undefined,
        parentId: input.parentId ?? undefined,
        x: input.x,
        y: input.y,
        text: input.text,
        attachments: input.attachments,
        authorId: author.authorId ?? undefined,
        authorName: author.authorName ?? undefined,
        createdAt: now,
        updatedAt: now,
      };
      const patch = emptyPatch();
      patch.comments.push(comment);
      const result = await client.sendPatch(input.sessionId, patch);
      return toolResult({ action, comment: sanitizeComment(comment), ...result });
    }

    if (action === 'update') {
      if (!input.id) throw new Error('id_required');
      if (!input.patch || typeof input.patch !== 'object') throw new Error('patch_required');
      const state = await client.fetchState(input.sessionId);
      const current = state?.comments?.find((c) => c.id === input.id);
      if (!current) throw new Error('comment_not_found');
      const next = { ...current, ...input.patch, id: input.id, updatedAt: nowTs() };
      const updatePatch = emptyPatch();
      updatePatch.comments.push(next);
      const result = await client.sendPatch(input.sessionId, updatePatch);
      return toolResult({ action, comment: sanitizeComment(next), ...result });
    }

    if (action === 'delete') {
      if (!input.id) throw new Error('id_required');
      const state = await client.fetchState(input.sessionId);
      const comments = state?.comments ?? [];
      const commentById = new Map();
      const childrenByParent = new Map();
      for (const comment of comments) {
        if (comment?.id) commentById.set(comment.id, comment);
        const parentId = comment.parentId ?? null;
        if (!parentId) continue;
        const list = childrenByParent.get(parentId) ?? [];
        list.push(comment.id);
        childrenByParent.set(parentId, list);
      }

      const toDelete = new Set();
      const stack = [input.id];
      while (stack.length) {
        const next = stack.pop();
        if (!next || toDelete.has(next)) continue;
        toDelete.add(next);
        const children = childrenByParent.get(next) ?? [];
        for (const child of children) stack.push(child);
      }

      const patch = emptyPatch();
      const now = nowTs();
      for (const commentId of toDelete) {
        const comment = commentById.get(commentId);
        patch.tombstones.comments[commentId] = tombstoneFor(now, comment?.updatedAt);
      }

      const result = await client.sendPatch(input.sessionId, patch);
      return toolResult({ action, deletedCommentIds: Array.from(toDelete), ...result });
    }

    throw new Error('action_not_supported');
  }
);

registerTool(
  'drawing',
  {
    title: 'Drawing',
    description: 'Creates, reads, updates, or deletes drawings based on the action.',
    inputSchema: {
      action: CrudAction,
      limit: z.number().optional(),
      id: z.string().optional(),
      points: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
      path: z.string().optional(),
      color: z.string().optional(),
      width: z.number().optional(),
      opacity: z.number().optional(),
      tool: PenTool.optional(),
      patch: z.any().optional(),
      authorId: z.string().nullable().optional(),
      authorName: z.string().nullable().optional(),
    },
    outputSchema: {
      action: CrudAction,
      drawing: z.any().optional(),
      drawings: z.array(z.any()).optional(),
      total: z.number().optional(),
      limit: z.number().optional(),
      truncated: z.boolean().optional(),
      deletedDrawingId: z.string().optional(),
      sessionId: z.string().optional(),
      requestId: z.string().optional(),
    },
  },
  async (input, extra) => {
    const action = input.action;
    if (action === 'read') {
      const state = await client.fetchState(input.sessionId);
      if (input.id) {
        const drawing = state?.drawings?.find((d) => d.id === input.id) ?? null;
        return toolResult({ action, drawing });
      }
      const limited = limitList(state?.drawings ?? [], input.limit);
      return toolResult({
        action,
        drawings: limited.items,
        total: limited.total,
        limit: limited.limit,
        truncated: limited.truncated,
      });
    }

    if (action === 'create') {
      if (!Array.isArray(input.points) || !input.points.length) throw new Error('points_required');
      if (typeof input.color !== 'string' || !input.color) throw new Error('color_required');
      if (!Number.isFinite(input.width)) throw new Error('width_required');
      if (!Number.isFinite(input.opacity)) throw new Error('opacity_required');
      if (!input.tool) throw new Error('tool_required');
      const author = resolveAuthorFromExtra(extra);
      const now = nowTs();
      const drawing = {
        id: input.id ?? randomUUID(),
        points: input.points,
        path: input.path,
        color: input.color,
        width: input.width,
        opacity: input.opacity,
        tool: input.tool,
        authorId: author.authorId ?? undefined,
        authorName: author.authorName ?? undefined,
        createdAt: now,
        updatedAt: now,
      };
      const patch = emptyPatch();
      patch.drawings.push(drawing);
      const result = await client.sendPatch(input.sessionId, patch);
      return toolResult({ action, drawing, ...result });
    }

    if (action === 'update') {
      if (!input.id) throw new Error('id_required');
      if (!input.patch || typeof input.patch !== 'object') throw new Error('patch_required');
      const state = await client.fetchState(input.sessionId);
      const current = state?.drawings?.find((d) => d.id === input.id);
      if (!current) throw new Error('drawing_not_found');
      const next = { ...current, ...input.patch, id: input.id, updatedAt: nowTs() };
      const updatePatch = emptyPatch();
      updatePatch.drawings.push(next);
      const result = await client.sendPatch(input.sessionId, updatePatch);
      return toolResult({ action, drawing: next, ...result });
    }

    if (action === 'delete') {
      if (!input.id) throw new Error('id_required');
      const patch = emptyPatch();
      const state = await client.fetchState(input.sessionId);
      const drawing = state?.drawings?.find((d) => d.id === input.id);
      const now = nowTs();
      patch.tombstones.drawings[input.id] = tombstoneFor(now, drawing?.updatedAt);
      const result = await client.sendPatch(input.sessionId, patch);
      return toolResult({ action, deletedDrawingId: input.id, ...result });
    }

    throw new Error('action_not_supported');
  }
);

registerTool(
  'focus_node',
  {
    title: 'Focus Node',
    description: 'Centers the view on a node for the authenticated MCP user.',
    inputSchema: { id: z.string() },
    outputSchema: { ok: z.boolean().optional(), delivered: z.number().optional(), sessionId: z.string() },
  },
  async ({ sessionId, id }, extra) => {
    const result = await sendCanvasView({ sessionId, action: 'focus_node', nodeId: id }, extra);
    return toolResult(result);
  }
);

registerTool(
  'zoom',
  {
    title: 'Zoom',
    description: 'Zooms the view for the authenticated MCP user.',
    inputSchema: { target: ZoomTarget },
    outputSchema: { ok: z.boolean().optional(), delivered: z.number().optional(), sessionId: z.string() },
  },
  async ({ sessionId, target }, extra) => {
    const action = target === 'to_cards'
      ? 'zoom_to_cards'
      : target === 'to_graph'
        ? 'zoom_to_graph'
        : 'zoom_to_fit';
    const result = await sendCanvasView({ sessionId, action }, extra);
    return toolResult(result);
  }
);

registerTool(
  'pan',
  {
    title: 'Pan',
    description: 'Centers the view on the provided canvas coordinates for the authenticated MCP user.',
    inputSchema: {
      x: z.number(),
      y: z.number(),
      scale: z.number().optional(),
    },
    outputSchema: { ok: z.boolean().optional(), delivered: z.number().optional(), sessionId: z.string() },
  },
  async ({ sessionId, x, y, scale }, extra) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('coords_required');
    const result = await sendCanvasView({ sessionId, action: 'pan', x, y, scale }, extra);
    return toolResult(result);
  }
);

registerTool(
  'get_active_canvas_snapshot',
  {
    title: 'Get Active Canvas Snapshot',
    description: 'Captures a snapshot of the active canvas area and returns only metadata (no image payloads).',
    inputSchema: { timeoutMs: z.number().optional() },
    outputSchema: {
      ok: z.boolean().optional(),
      sessionId: z.string().optional(),
      image: z.object({
        width: z.number().nullable().optional(),
        height: z.number().nullable().optional(),
      }).optional(),
    },
  },
  async ({ sessionId, timeoutMs }, extra) => {
    const result = await requestCanvasSnapshot({ sessionId, timeoutMs }, extra);
    const image = result?.image ?? null;
    const meta = {
      ok: true,
      sessionId: result?.sessionId ?? sessionId ?? null,
      image: {
        width: image?.width ?? null,
        height: image?.height ?? null,
      },
    };
    return toolResult(meta);
  }
);

const transportMode = process.env.MCP_TRANSPORT ?? (process.env.MCP_HTTP_PORT ? 'http' : 'stdio');

if (transportMode === 'http') {
  const port = Number(process.env.MCP_HTTP_PORT ?? 7010);
  const app = express();
  if (metrics.enabled) {
    app.get(metrics.path, metrics.handler);
  }
  app.use(createHttpLogger({
    logger,
    ignorePaths: metrics.enabled ? [metrics.path] : [],
  }));
  app.use(metrics.middleware);
  app.use(express.json({ limit: '2mb' }));

  const renderUiPage = () => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Smart Tracker MCP</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        background: #0b0d12;
        color: #e6e9ef;
      }
      .wrap {
        max-width: 980px;
        margin: 32px auto;
        padding: 0 20px 40px;
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 18px;
      }
      h1 {
        font-size: 18px;
        font-weight: 700;
        margin: 0;
      }
      .chip {
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 999px;
        background: #1c212b;
        color: #9fb4ff;
      }
      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
      }
      .panel {
        background: #121622;
        border: 1px solid #1f2430;
        border-radius: 14px;
        padding: 16px;
        box-shadow: 0 12px 24px rgba(0, 0, 0, 0.24);
      }
      label {
        display: block;
        font-size: 12px;
        color: #9aa5b1;
        margin-bottom: 6px;
      }
      select, input, textarea, button {
        width: 100%;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid #293040;
        background: #0f141c;
        color: #e6e9ef;
        padding: 10px 12px;
        font-size: 13px;
      }
      textarea {
        min-height: 220px;
        resize: vertical;
        font-family: inherit;
      }
      button {
        margin-top: 10px;
        background: #2f6af7;
        border: none;
        font-weight: 600;
        cursor: pointer;
      }
      button:disabled {
        background: #243255;
        cursor: not-allowed;
      }
      details {
        border: 1px solid #1f2430;
        border-radius: 12px;
        padding: 10px 12px;
        background: #0f141c;
      }
      details > summary {
        cursor: pointer;
        font-size: 12px;
        color: #9fb4ff;
      }
      details[open] > summary {
        margin-bottom: 8px;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
        font-size: 12px;
        line-height: 1.45;
      }
      .meta {
        margin-top: 10px;
        font-size: 12px;
        color: #9aa5b1;
      }
      .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .stack > * + * {
        margin-top: 12px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>Smart Tracker MCP</h1>
        <span class="chip">/mcp</span>
      </header>
      <div class="grid">
        <div class="panel stack">
          <div>
            <label for="tool">Tool</label>
            <select id="tool"></select>
          </div>
          <div>
            <label for="input">Input JSON</label>
            <textarea id="input">{}</textarea>
          </div>
          <button id="run">Run Tool</button>
          <div class="meta" id="toolMeta">Loading tools...</div>
          <details id="toolSpec">
            <summary>Specification</summary>
            <pre id="specOutput">Select a tool to view its schema.</pre>
          </details>
        </div>
        <div class="panel">
          <label>Response</label>
          <pre id="output">Ready.</pre>
        </div>
      </div>
    </div>
    <script>
      const state = {
        tools: [],
        selected: null,
      };
      const toolSelect = document.getElementById('tool');
      const inputField = document.getElementById('input');
      const outputField = document.getElementById('output');
      const runBtn = document.getElementById('run');
      const metaField = document.getElementById('toolMeta');
      const specField = document.getElementById('specOutput');

      function renderMeta() {
        if (!state.selected) {
          metaField.textContent = 'Select a tool.';
          specField.textContent = 'Select a tool to view its schema.';
          return;
        }
        const { name, title, description } = state.selected;
        metaField.textContent = (title || name) + (description ? ' — ' + description : '');
        specField.textContent = JSON.stringify(
          {
            inputSchema: state.selected.inputSchema ?? null,
            outputSchema: state.selected.outputSchema ?? null,
          },
          null,
          2
        );
      }

      async function loadTools() {
        const res = await fetch('/ui/tools');
        if (!res.ok) {
          metaField.textContent = 'Failed to load tools.';
          return;
        }
        const data = await res.json();
        state.tools = data.tools || [];
        toolSelect.innerHTML = '';
        for (const tool of state.tools) {
          const opt = document.createElement('option');
          opt.value = tool.name;
          opt.textContent = tool.title ? tool.title : tool.name;
          toolSelect.appendChild(opt);
        }
        state.selected = state.tools[0] || null;
        renderMeta();
      }

      toolSelect.addEventListener('change', () => {
        const name = toolSelect.value;
        state.selected = state.tools.find((t) => t.name === name) || null;
        renderMeta();
      });

      runBtn.addEventListener('click', async () => {
        if (!state.selected) return;
        let input = {};
        const raw = inputField.value.trim() || '{}';
        try {
          input = JSON.parse(raw);
        } catch (err) {
          outputField.textContent = 'Invalid JSON: ' + err.message;
          return;
        }
        runBtn.disabled = true;
        outputField.textContent = 'Running...';
        try {
          const res = await fetch('/ui/tool', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tool: state.selected.name, input }),
          });
          const data = await res.json().catch(() => ({}));
          outputField.textContent = JSON.stringify(data, null, 2);
        } catch (err) {
          outputField.textContent = 'Request failed: ' + err.message;
        } finally {
          runBtn.disabled = false;
        }
      });

      loadTools().catch(() => {
        metaField.textContent = 'Failed to load tools.';
      });
    </script>
  </body>
</html>`;

  app.get('/', (_req, res) => {
    res.type('html').send(renderUiPage());
  });

  app.get('/ui', (_req, res) => {
    res.type('html').send(renderUiPage());
  });

  app.get('/ui/tools', (_req, res) => {
    const tools = Array.from(toolRegistry.entries()).map(([name, entry]) => ({
      name,
      title: entry.meta?.title ?? name,
      description: entry.meta?.description ?? '',
      inputSchema: toJsonSchema(entry.meta?.inputSchema),
      outputSchema: toJsonSchema(entry.meta?.outputSchema),
    }));
    res.json({ tools });
  });

  app.post('/ui/tool', async (req, res) => {
    const toolName = String(req.body?.tool ?? '');
    const entry = toolRegistry.get(toolName);
    if (!entry) {
      res.status(404).json({ ok: false, error: 'tool_not_found' });
      return;
    }
    try {
      const input = req.body?.input;
      const result = await entry.handler(input ?? {});
      res.json({ ok: true, result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err?.message ?? 'tool_failed' });
    }
  });

  app.post('/mcp', async (req, res) => {
    const token = getAuthTokenFromRequest(req);
    const sessionIdFromHeader = getSessionIdFromRequest(req);
    const userIdFromHeader = getUserIdFromRequest(req);
    logEvent('mcp_request', {
      hasToken: !!token,
      sessionId: sessionIdFromHeader ?? null,
    });
    if (token) {
      try {
        const authInfo = await resolveMcpAuth(token);
        if (!authInfo) {
          logEvent('mcp_auth_failed', { reason: 'invalid_token', sessionId: sessionIdFromHeader ?? null });
          res.status(401).json({ error: 'invalid_token' });
          return;
        }
        req.auth = {
          mcpUser: authInfo.user,
          mcpToken: token,
          mcpTokenExpiresAt: authInfo.expiresAt,
          sessionId: sessionIdFromHeader ?? undefined,
          actingUserId: userIdFromHeader ?? undefined,
        };
      } catch {
        logEvent('mcp_auth_failed', { reason: 'auth_unavailable', sessionId: sessionIdFromHeader ?? null });
        res.status(503).json({ error: 'auth_unavailable' });
        return;
      }
    } else if (sessionIdFromHeader) {
      req.auth = {
        sessionId: sessionIdFromHeader,
        actingUserId: userIdFromHeader ?? undefined,
      };
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, () => {
    logger.info({ port }, 'mcp_http_listening');
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
