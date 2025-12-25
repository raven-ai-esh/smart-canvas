import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import * as z from 'zod';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

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
const AI_AUTHOR_NAME = 'AI';
const MCP_AUTH_CACHE_TTL_MS = Number(process.env.MCP_AUTH_CACHE_TTL_MS ?? 60_000);
const authCache = new Map();
const MCP_LOG_ENABLED = process.env.MCP_LOG_ENABLED !== 'false';
const MCP_LOG_TRUNCATE = Number(process.env.MCP_LOG_TRUNCATE ?? 800);

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
    if (key === 'dataUrl') {
      out[key] = '[data_url_omitted]';
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

const normalizeMcpUser = (user) => {
  if (!user || typeof user !== 'object') return null;
  const id = typeof user.id === 'string' ? user.id : null;
  if (!id) return null;
  const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim() : 'User';
  const avatarUrl = typeof user.avatarUrl === 'string' && user.avatarUrl.trim() ? user.avatarUrl : null;
  const avatarAnimal = Number.isFinite(user.avatarAnimal) ? Number(user.avatarAnimal) : null;
  const avatarColor = Number.isFinite(user.avatarColor) ? Number(user.avatarColor) : null;
  return { id, name, avatarUrl, avatarAnimal, avatarColor };
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
      avatarUrl: user.avatarUrl ?? null,
      avatarAnimal: user.avatarAnimal ?? null,
      avatarColor: user.avatarColor ?? null,
    };
  }
  return {
    authorId: null,
    authorName: AI_AUTHOR_NAME,
    avatarUrl: null,
    avatarAnimal: null,
    avatarColor: null,
  };
};

const emptyPatch = () => ({
  nodes: [],
  edges: [],
  drawings: [],
  textBoxes: [],
  comments: [],
  tombstones: {
    nodes: {},
    edges: {},
    drawings: {},
    textBoxes: {},
    comments: {},
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
  };
};

const normalizePatch = (input) => ({
  nodes: Array.isArray(input?.nodes) ? input.nodes : [],
  edges: Array.isArray(input?.edges) ? input.edges : [],
  drawings: Array.isArray(input?.drawings) ? input.drawings : [],
  textBoxes: Array.isArray(input?.textBoxes) ? input.textBoxes : [],
  comments: Array.isArray(input?.comments) ? input.comments : [],
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
  }

  async resolveSessionId(sessionId) {
    if (sessionId) {
      this.sessionId = sessionId;
      return sessionId;
    }
    if (this.sessionId) return this.sessionId;

    const res = await fetch(`${this.baseUrl}/api/settings/default-session`);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const id = typeof data?.id === 'string' ? data.id : null;
      if (id) {
        this.sessionId = id;
        return id;
      }
    }

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

      ws.on('close', () => {
        if (this.ws === ws) {
          this.ws = null;
          this.wsSessionId = null;
        }
      });
    }

    await this.connecting;
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
    this.ws.send(JSON.stringify(payload));
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
const TargetKind = z.enum(['canvas', 'node', 'edge', 'textBox']);
const AttachmentKind = z.enum(['image', 'file']);
const PenTool = z.enum(['pen', 'eraser', 'highlighter']);
const ViewAction = z.enum(['focus_node', 'zoom_to_cards', 'zoom_to_graph', 'zoom_to_fit']);

const sendCanvasView = async ({ sessionId, action, nodeId }, extra) => {
  const token = extra?.authInfo?.mcpToken;
  if (!token) throw new Error('mcp_token_required');
  const resolvedSessionId = await client.resolveSessionId(sessionId);
  const payload = {
    sessionId: resolvedSessionId,
    action,
  };
  if (nodeId) payload.nodeId = nodeId;
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

const parseImageDataUrl = (dataUrl) => {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
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

const server = new McpServer({
  name: 'smart-tracker-canvas',
  version: '0.1.0',
});

const toolRegistry = new Map();
const registerTool = (name, meta, handler) => {
  toolRegistry.set(name, { meta, handler });
  const wrapped = async (input, extra) => {
    const startedAt = Date.now();
    const sessionId = input?.sessionId ?? client.sessionId ?? null;
    const userId = extra?.authInfo?.mcpUser?.id ?? null;
    logEvent('tool_start', { tool: name, sessionId, userId, input });
    try {
      const result = await handler(input, extra);
      const output = result?.structuredContent ?? result;
      logEvent('tool_ok', { tool: name, sessionId, userId, durationMs: Date.now() - startedAt, output });
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
  'set_session',
  {
    title: 'Set Active Session',
    description: 'Sets the active session id for subsequent tool calls.',
    inputSchema: { sessionId: z.string() },
    outputSchema: { sessionId: z.string() },
  },
  async ({ sessionId }) => {
    client.sessionId = sessionId;
    return toolResult({ sessionId });
  }
);

registerTool(
  'get_session',
  {
    title: 'Get Active Session',
    description: 'Returns the current active session id and MCP client id.',
    inputSchema: {},
    outputSchema: {
      sessionId: z.string().nullable(),
      clientId: z.string(),
      baseUrl: z.string(),
      wsUrl: z.string(),
    },
  },
  async () => toolResult({
    sessionId: client.sessionId,
    clientId: client.clientId,
    baseUrl: client.baseUrl,
    wsUrl: client.wsUrl,
  })
);

registerTool(
  'get_state',
  {
    title: 'Get Canvas State',
    description: 'Fetches the current session state (nodes, edges, drawings, textBoxes, comments).',
    inputSchema: { sessionId: z.string().optional() },
    outputSchema: { id: z.string(), version: z.number(), state: z.any(), meta: z.any() },
  },
  async ({ sessionId }) => {
    const session = await client.fetchSession(sessionId);
    const rawVersion = session?.version;
    const version = typeof rawVersion === 'number' ? rawVersion : Number(rawVersion);
    const normalized = {
      ...session,
      version: Number.isFinite(version) ? version : 0,
    };
    return toolResult(normalized);
  }
);

registerTool(
  'apply_patch',
  {
    title: 'Apply Session Patch',
    description: 'Applies a partial session state update via WebSocket sync.',
    inputSchema: {
      sessionId: z.string().optional(),
      patch: z.any(),
    },
    outputSchema: { ok: z.boolean(), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, patch }) => {
    if (!patch || typeof patch !== 'object') {
      throw new Error('patch_required');
    }
    const normalized = normalizePatch(patch);
    const result = await client.sendPatch(sessionId, normalized);
    return toolResult({ ok: true, ...result });
  }
);

registerTool(
  'list_nodes',
  {
    title: 'List Nodes',
    description: 'Returns all nodes in the session.',
    inputSchema: { sessionId: z.string().optional() },
    outputSchema: { nodes: z.array(z.any()) },
  },
  async ({ sessionId }) => {
    const state = await client.fetchState(sessionId);
    return toolResult({ nodes: state?.nodes ?? [] });
  }
);

registerTool(
  'get_node',
  {
    title: 'Get Node',
    description: 'Returns a single node by id.',
    inputSchema: { sessionId: z.string().optional(), id: z.string() },
    outputSchema: { node: z.any().nullable() },
  },
  async ({ sessionId, id }) => {
    const state = await client.fetchState(sessionId);
    const node = state?.nodes?.find((n) => n.id === id) ?? null;
    return toolResult({ node });
  }
);

registerTool(
  'create_node',
  {
    title: 'Create Node',
    description: 'Creates a new node.',
    inputSchema: {
      sessionId: z.string().optional(),
      id: z.string().optional(),
      title: z.string(),
      content: z.string().optional(),
      type: NodeType.optional(),
      x: z.number(),
      y: z.number(),
      clarity: z.number().optional(),
      energy: z.number().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      status: NodeStatus.optional(),
      progress: z.number().optional(),
      authorId: z.string().nullable().optional(),
      authorName: z.string().nullable().optional(),
    },
    outputSchema: { node: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async (input, extra) => {
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
    return toolResult({ node, ...result });
  }
);

registerTool(
  'update_node',
  {
    title: 'Update Node',
    description: 'Updates an existing node by id.',
    inputSchema: {
      sessionId: z.string().optional(),
      id: z.string(),
      patch: z.any(),
    },
    outputSchema: { node: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, id, patch }) => {
    if (!patch || typeof patch !== 'object') throw new Error('patch_required');
    const state = await client.fetchState(sessionId);
    const current = state?.nodes?.find((n) => n.id === id);
    if (!current) throw new Error('node_not_found');
    const next = { ...current, ...patch, id, updatedAt: nowTs() };
    const updatePatch = emptyPatch();
    updatePatch.nodes.push(next);
    const result = await client.sendPatch(sessionId, updatePatch);
    return toolResult({ node: next, ...result });
  }
);

registerTool(
  'delete_node',
  {
    title: 'Delete Node',
    description: 'Deletes a node and its connected edges.',
    inputSchema: { sessionId: z.string().optional(), id: z.string() },
    outputSchema: { deletedNodeId: z.string(), deletedEdgeIds: z.array(z.string()), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, id }) => {
    const state = await client.fetchState(sessionId);
    const nodes = state?.nodes ?? [];
    const node = nodes.find((n) => n.id === id);
    const edges = state?.edges ?? [];
    const edgesById = new Map(edges.map((edge) => [edge.id, edge]));
    const edgeIds = edges.filter((e) => e.source === id || e.target === id).map((e) => e.id);
    const patch = emptyPatch();
    const now = nowTs();
    patch.tombstones.nodes[id] = tombstoneFor(now, node?.updatedAt);
    for (const edgeId of edgeIds) {
      const edge = edgesById.get(edgeId);
      patch.tombstones.edges[edgeId] = tombstoneFor(now, edge?.updatedAt);
    }
    const result = await client.sendPatch(sessionId, patch);
    return toolResult({ deletedNodeId: id, deletedEdgeIds: edgeIds, ...result });
  }
);

registerTool(
  'list_edges',
  {
    title: 'List Edges',
    description: 'Returns all edges in the session.',
    inputSchema: { sessionId: z.string().optional() },
    outputSchema: { edges: z.array(z.any()) },
  },
  async ({ sessionId }) => {
    const state = await client.fetchState(sessionId);
    return toolResult({ edges: state?.edges ?? [] });
  }
);

registerTool(
  'create_edge',
  {
    title: 'Create Edge',
    description: 'Creates a new edge between nodes.',
    inputSchema: {
      sessionId: z.string().optional(),
      id: z.string().optional(),
      source: z.string(),
      target: z.string(),
      type: z.enum(['default', 'connection']).optional(),
      energyEnabled: z.boolean().optional(),
      authorId: z.string().nullable().optional(),
      authorName: z.string().nullable().optional(),
    },
    outputSchema: { edge: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async (input, extra) => {
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
    return toolResult({ edge, ...result });
  }
);

registerTool(
  'update_edge',
  {
    title: 'Update Edge',
    description: 'Updates an existing edge by id.',
    inputSchema: { sessionId: z.string().optional(), id: z.string(), patch: z.any() },
    outputSchema: { edge: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, id, patch }) => {
    if (!patch || typeof patch !== 'object') throw new Error('patch_required');
    const state = await client.fetchState(sessionId);
    const current = state?.edges?.find((e) => e.id === id);
    if (!current) throw new Error('edge_not_found');
    const next = { ...current, ...patch, id, updatedAt: nowTs() };
    const updatePatch = emptyPatch();
    updatePatch.edges.push(next);
    const result = await client.sendPatch(sessionId, updatePatch);
    return toolResult({ edge: next, ...result });
  }
);

registerTool(
  'delete_edge',
  {
    title: 'Delete Edge',
    description: 'Deletes an edge.',
    inputSchema: { sessionId: z.string().optional(), id: z.string() },
    outputSchema: { deletedEdgeId: z.string(), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, id }) => {
    const patch = emptyPatch();
    const state = await client.fetchState(sessionId);
    const edge = state?.edges?.find((e) => e.id === id);
    const now = nowTs();
    patch.tombstones.edges[id] = tombstoneFor(now, edge?.updatedAt);
    const result = await client.sendPatch(sessionId, patch);
    return toolResult({ deletedEdgeId: id, ...result });
  }
);

registerTool(
  'list_textboxes',
  {
    title: 'List Text Boxes',
    description: 'Returns all text boxes in the session.',
    inputSchema: { sessionId: z.string().optional() },
    outputSchema: { textBoxes: z.array(z.any()) },
  },
  async ({ sessionId }) => {
    const state = await client.fetchState(sessionId);
    return toolResult({ textBoxes: state?.textBoxes ?? [] });
  }
);

registerTool(
  'create_textbox',
  {
    title: 'Create Text Box',
    description: 'Creates a new text box.',
    inputSchema: {
      sessionId: z.string().optional(),
      id: z.string().optional(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      text: z.string(),
      kind: z.enum(['text', 'image']).optional(),
      src: z.string().optional(),
      authorId: z.string().nullable().optional(),
      authorName: z.string().nullable().optional(),
    },
    outputSchema: { textBox: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async (input, extra) => {
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
      authorId: author.authorId ?? undefined,
      authorName: author.authorName ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    const patch = emptyPatch();
    patch.textBoxes.push(textBox);
    const result = await client.sendPatch(input.sessionId, patch);
    return toolResult({ textBox, ...result });
  }
);

registerTool(
  'update_textbox',
  {
    title: 'Update Text Box',
    description: 'Updates an existing text box by id.',
    inputSchema: { sessionId: z.string().optional(), id: z.string(), patch: z.any() },
    outputSchema: { textBox: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, id, patch }) => {
    if (!patch || typeof patch !== 'object') throw new Error('patch_required');
    const state = await client.fetchState(sessionId);
    const current = state?.textBoxes?.find((tb) => tb.id === id);
    if (!current) throw new Error('textbox_not_found');
    const next = { ...current, ...patch, id, updatedAt: nowTs() };
    const updatePatch = emptyPatch();
    updatePatch.textBoxes.push(next);
    const result = await client.sendPatch(sessionId, updatePatch);
    return toolResult({ textBox: next, ...result });
  }
);

registerTool(
  'delete_textbox',
  {
    title: 'Delete Text Box',
    description: 'Deletes a text box.',
    inputSchema: { sessionId: z.string().optional(), id: z.string() },
    outputSchema: { deletedTextBoxId: z.string(), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, id }) => {
    const patch = emptyPatch();
    const state = await client.fetchState(sessionId);
    const textBox = state?.textBoxes?.find((t) => t.id === id);
    const now = nowTs();
    patch.tombstones.textBoxes[id] = tombstoneFor(now, textBox?.updatedAt);
    const result = await client.sendPatch(sessionId, patch);
    return toolResult({ deletedTextBoxId: id, ...result });
  }
);

registerTool(
  'list_comments',
  {
    title: 'List Comments',
    description: 'Returns all comments in the session.',
    inputSchema: { sessionId: z.string().optional() },
    outputSchema: { comments: z.array(z.any()) },
  },
  async ({ sessionId }) => {
    const state = await client.fetchState(sessionId);
    return toolResult({ comments: state?.comments ?? [] });
  }
);

registerTool(
  'create_comment',
  {
    title: 'Create Comment',
    description: 'Creates a new comment on the canvas or an object.',
    inputSchema: {
      sessionId: z.string().optional(),
      id: z.string().optional(),
      targetKind: TargetKind,
      targetId: z.string().nullable().optional(),
      parentId: z.string().nullable().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      text: z.string(),
      attachments: z.array(z.object({
        id: z.string(),
        kind: AttachmentKind,
        name: z.string(),
        size: z.number(),
        mime: z.string(),
        dataUrl: z.string(),
      })).optional(),
      authorId: z.string().nullable().optional(),
      authorName: z.string().nullable().optional(),
      avatarUrl: z.string().nullable().optional(),
      avatarAnimal: z.number().nullable().optional(),
      avatarColor: z.number().nullable().optional(),
    },
    outputSchema: { comment: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async (input, extra) => {
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
      avatarUrl: author.avatarUrl ?? undefined,
      avatarAnimal: author.avatarAnimal ?? undefined,
      avatarColor: author.avatarColor ?? undefined,
      createdAt: now,
      updatedAt: now,
    };
    const patch = emptyPatch();
    patch.comments.push(comment);
    const result = await client.sendPatch(input.sessionId, patch);
    return toolResult({ comment, ...result });
  }
);

registerTool(
  'update_comment',
  {
    title: 'Update Comment',
    description: 'Updates an existing comment by id.',
    inputSchema: { sessionId: z.string().optional(), id: z.string(), patch: z.any() },
    outputSchema: { comment: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, id, patch }) => {
    if (!patch || typeof patch !== 'object') throw new Error('patch_required');
    const state = await client.fetchState(sessionId);
    const current = state?.comments?.find((c) => c.id === id);
    if (!current) throw new Error('comment_not_found');
    const next = { ...current, ...patch, id, updatedAt: nowTs() };
    const updatePatch = emptyPatch();
    updatePatch.comments.push(next);
    const result = await client.sendPatch(sessionId, updatePatch);
    return toolResult({ comment: next, ...result });
  }
);

registerTool(
  'delete_comment',
  {
    title: 'Delete Comment',
    description: 'Deletes a comment and its replies.',
    inputSchema: { sessionId: z.string().optional(), id: z.string() },
    outputSchema: { deletedCommentIds: z.array(z.string()), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, id }) => {
    const state = await client.fetchState(sessionId);
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
    const stack = [id];
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

    const result = await client.sendPatch(sessionId, patch);
    return toolResult({ deletedCommentIds: Array.from(toDelete), ...result });
  }
);

registerTool(
  'list_drawings',
  {
    title: 'List Drawings',
    description: 'Returns all drawings in the session.',
    inputSchema: { sessionId: z.string().optional() },
    outputSchema: { drawings: z.array(z.any()) },
  },
  async ({ sessionId }) => {
    const state = await client.fetchState(sessionId);
    return toolResult({ drawings: state?.drawings ?? [] });
  }
);

registerTool(
  'create_drawing',
  {
    title: 'Create Drawing',
    description: 'Creates a new drawing path.',
    inputSchema: {
      sessionId: z.string().optional(),
      id: z.string().optional(),
      points: z.array(z.object({ x: z.number(), y: z.number() })),
      path: z.string().optional(),
      color: z.string(),
      width: z.number(),
      opacity: z.number(),
      tool: PenTool,
      authorId: z.string().nullable().optional(),
      authorName: z.string().nullable().optional(),
    },
    outputSchema: { drawing: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async (input, extra) => {
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
    return toolResult({ drawing, ...result });
  }
);

registerTool(
  'update_drawing',
  {
    title: 'Update Drawing',
    description: 'Updates an existing drawing by id.',
    inputSchema: { sessionId: z.string().optional(), id: z.string(), patch: z.any() },
    outputSchema: { drawing: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, id, patch }) => {
    if (!patch || typeof patch !== 'object') throw new Error('patch_required');
    const state = await client.fetchState(sessionId);
    const current = state?.drawings?.find((d) => d.id === id);
    if (!current) throw new Error('drawing_not_found');
    const next = { ...current, ...patch, id, updatedAt: nowTs() };
    const updatePatch = emptyPatch();
    updatePatch.drawings.push(next);
    const result = await client.sendPatch(sessionId, updatePatch);
    return toolResult({ drawing: next, ...result });
  }
);

registerTool(
  'delete_drawing',
  {
    title: 'Delete Drawing',
    description: 'Deletes a drawing by id.',
    inputSchema: { sessionId: z.string().optional(), id: z.string() },
    outputSchema: { deletedDrawingId: z.string(), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId, id }) => {
    const patch = emptyPatch();
    const state = await client.fetchState(sessionId);
    const drawing = state?.drawings?.find((d) => d.id === id);
    const now = nowTs();
    patch.tombstones.drawings[id] = tombstoneFor(now, drawing?.updatedAt);
    const result = await client.sendPatch(sessionId, patch);
    return toolResult({ deletedDrawingId: id, ...result });
  }
);

registerTool(
  'clear_canvas',
  {
    title: 'Clear Canvas',
    description: 'Deletes all nodes, edges, drawings, text boxes, and comments.',
    inputSchema: { sessionId: z.string().optional() },
    outputSchema: { deleted: z.any(), sessionId: z.string(), requestId: z.string() },
  },
  async ({ sessionId }) => {
    const state = await client.fetchState(sessionId);
    const patch = emptyPatch();
    const now = nowTs();
    const deleted = {
      nodes: [],
      edges: [],
      drawings: [],
      textBoxes: [],
      comments: [],
    };

    for (const node of state?.nodes ?? []) {
      patch.tombstones.nodes[node.id] = tombstoneFor(now, node.updatedAt);
      deleted.nodes.push(node.id);
    }
    for (const edge of state?.edges ?? []) {
      patch.tombstones.edges[edge.id] = tombstoneFor(now, edge.updatedAt);
      deleted.edges.push(edge.id);
    }
    for (const drawing of state?.drawings ?? []) {
      patch.tombstones.drawings[drawing.id] = tombstoneFor(now, drawing.updatedAt);
      deleted.drawings.push(drawing.id);
    }
    for (const textBox of state?.textBoxes ?? []) {
      patch.tombstones.textBoxes[textBox.id] = tombstoneFor(now, textBox.updatedAt);
      deleted.textBoxes.push(textBox.id);
    }
    for (const comment of state?.comments ?? []) {
      patch.tombstones.comments[comment.id] = tombstoneFor(now, comment.updatedAt);
      deleted.comments.push(comment.id);
    }

    const result = await client.sendPatch(sessionId, patch);
    return toolResult({ deleted, ...result });
  }
);

registerTool(
  'focus_node',
  {
    title: 'Focus Node',
    description: 'Centers the view on a node for the authenticated MCP user.',
    inputSchema: { sessionId: z.string().optional(), id: z.string() },
    outputSchema: { ok: z.boolean().optional(), delivered: z.number().optional(), sessionId: z.string() },
  },
  async ({ sessionId, id }, extra) => {
    const result = await sendCanvasView({ sessionId, action: 'focus_node', nodeId: id }, extra);
    return toolResult(result);
  }
);

registerTool(
  'zoom_to_cards',
  {
    title: 'Zoom To Cards',
    description: 'Zooms the view to the detailed card scale for the authenticated MCP user.',
    inputSchema: { sessionId: z.string().optional() },
    outputSchema: { ok: z.boolean().optional(), delivered: z.number().optional(), sessionId: z.string() },
  },
  async ({ sessionId }, extra) => {
    const result = await sendCanvasView({ sessionId, action: 'zoom_to_cards' }, extra);
    return toolResult(result);
  }
);

registerTool(
  'zoom_to_graph',
  {
    title: 'Zoom To Graph',
    description: 'Zooms the view to the graph scale for the authenticated MCP user.',
    inputSchema: { sessionId: z.string().optional() },
    outputSchema: { ok: z.boolean().optional(), delivered: z.number().optional(), sessionId: z.string() },
  },
  async ({ sessionId }, extra) => {
    const result = await sendCanvasView({ sessionId, action: 'zoom_to_graph' }, extra);
    return toolResult(result);
  }
);

registerTool(
  'zoom_to_fit',
  {
    title: 'Zoom To Fit',
    description: 'Zooms the view to fit visible content for the authenticated MCP user.',
    inputSchema: { sessionId: z.string().optional() },
    outputSchema: { ok: z.boolean().optional(), delivered: z.number().optional(), sessionId: z.string() },
  },
  async ({ sessionId }, extra) => {
    const result = await sendCanvasView({ sessionId, action: 'zoom_to_fit' }, extra);
    return toolResult(result);
  }
);

registerTool(
  'get_active_canvas_snapshot',
  {
    title: 'Get Active Canvas Snapshot',
    description: 'Captures a PNG snapshot of the active canvas area (all objects) for the authenticated MCP user.',
    inputSchema: { sessionId: z.string().optional(), timeoutMs: z.number().optional() },
    outputSchema: {
      ok: z.boolean().optional(),
      sessionId: z.string().optional(),
      image: z.object({
        dataUrl: z.string().nullable().optional(),
        width: z.number().nullable().optional(),
        height: z.number().nullable().optional(),
        mimeType: z.string().nullable().optional(),
      }).optional(),
    },
  },
  async ({ sessionId, timeoutMs }, extra) => {
    const result = await requestCanvasSnapshot({ sessionId, timeoutMs }, extra);
    const image = result?.image ?? null;
    const dataUrl = image?.dataUrl ?? null;
    const parsed = parseImageDataUrl(dataUrl);
    const meta = {
      ok: true,
      sessionId: result?.sessionId ?? sessionId ?? null,
      image: {
        dataUrl: dataUrl ?? null,
        width: image?.width ?? null,
        height: image?.height ?? null,
        mimeType: parsed?.mimeType ?? null,
      },
    };
    if (!parsed) {
      return {
        content: [{ type: 'text', text: JSON.stringify(meta) }],
        structuredContent: meta,
      };
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, sessionId: meta.sessionId, image: { width: meta.image.width, height: meta.image.height } }) },
        { type: 'image', data: parsed.data, mimeType: parsed.mimeType },
      ],
      structuredContent: meta,
    };
  }
);

const transportMode = process.env.MCP_TRANSPORT ?? (process.env.MCP_HTTP_PORT ? 'http' : 'stdio');

if (transportMode === 'http') {
  const port = Number(process.env.MCP_HTTP_PORT ?? 7010);
  const app = express();
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
          <div class="row">
            <div>
              <label for="session">Session ID (optional)</label>
              <input id="session" placeholder="leave empty to use default" />
            </div>
            <div>
              <label for="tool">Tool</label>
              <select id="tool"></select>
            </div>
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
      const sessionField = document.getElementById('session');
      const toolSelect = document.getElementById('tool');
      const inputField = document.getElementById('input');
      const outputField = document.getElementById('output');
      const runBtn = document.getElementById('run');
      const metaField = document.getElementById('toolMeta');
      const specField = document.getElementById('specOutput');

      const defaultSession = ${JSON.stringify(client.sessionId ?? '')};
      if (defaultSession) sessionField.value = defaultSession;

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
        const sessionId = sessionField.value.trim();
        if (sessionId && typeof input === 'object' && input !== null && !Array.isArray(input)) {
          input.sessionId = sessionId;
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
    if (token) {
      try {
        const authInfo = await resolveMcpAuth(token);
        if (!authInfo) {
          res.status(401).json({ error: 'invalid_token' });
          return;
        }
        req.auth = {
          mcpUser: authInfo.user,
          mcpToken: token,
          mcpTokenExpiresAt: authInfo.expiresAt,
        };
      } catch {
        res.status(503).json({ error: 'auth_unavailable' });
        return;
      }
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
    console.log(`[mcp] canvas server listening on :${port}/mcp`);
    console.log(`[mcp] ui available on :${port}/`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
