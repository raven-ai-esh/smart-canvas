import http from 'http';
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import { WebSocketServer } from 'ws';
import { randomUUID, createHash, randomBytes, createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';
import Busboy from 'busboy';
import cookieParser from 'cookie-parser';
import cookie from 'cookie';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import OpenAI from 'openai';
import Redis from 'ioredis';
import { Gauge } from 'prom-client';
import { createHttpLogger, createMetrics, getLogger } from './observability.js';

const PORT = Number(process.env.PORT ?? 8787);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/smart_tracker';
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID;
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret';
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'auth_token';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const normalizeEnvValue = (value) => (typeof value === 'string' ? value.trim() : '');
const APP_ORIGIN = normalizeEnvValue(process.env.APP_ORIGIN); // optional: e.g. https://your-domain.com
const SMTP_URL = process.env.SMTP_URL;
const MAIL_FROM = process.env.MAIL_FROM ?? 'no-reply@smart-tracker.local';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const YANDEX_CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const YANDEX_CLIENT_SECRET = process.env.YANDEX_CLIENT_SECRET;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_AUTH_BOT_USERNAME = process.env.TELEGRAM_AUTH_BOT_USERNAME ?? TELEGRAM_BOT_USERNAME;
const TELEGRAM_AUTH_BOT_TOKEN = process.env.TELEGRAM_AUTH_BOT_TOKEN ?? TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_BOT_USERNAME = process.env.TELEGRAM_ALERT_BOT_USERNAME ?? TELEGRAM_BOT_USERNAME;
const TELEGRAM_ALERT_BOT_TOKEN = process.env.TELEGRAM_ALERT_BOT_TOKEN ?? TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALERT_LINK_TTL_HOURS = Number(process.env.TELEGRAM_ALERT_LINK_TTL_HOURS ?? 24);
const TELEGRAM_ALERT_REPLY_TTL_HOURS = Number(process.env.TELEGRAM_ALERT_REPLY_TTL_HOURS ?? 24);
const TELEGRAM_ALERT_WEBHOOK_SECRET = process.env.TELEGRAM_ALERT_WEBHOOK_SECRET ?? '';
const TEST_USER_ENABLED = process.env.TEST_USER_ENABLED ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true');
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL ?? '';
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD ?? '';
const TEST_USER_NAME = process.env.TEST_USER_NAME ?? 'Test User';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SESSION_ACCESS_MODE = String(process.env.SESSION_ACCESS_MODE ?? 'auto').trim().toLowerCase();
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== 'false';
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 1200);
const RATE_LIMIT_AUTH_MAX = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 30);
const TEMP_SESSION_TTL_DAYS = Number(process.env.TEMP_SESSION_TTL_DAYS ?? 7);
const TEMP_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * (Number.isFinite(TEMP_SESSION_TTL_DAYS) && TEMP_SESSION_TTL_DAYS > 0 ? TEMP_SESSION_TTL_DAYS : 7);
const MCP_TOKEN_DEFAULT_TTL_DAYS = Number(process.env.MCP_TOKEN_DEFAULT_TTL_DAYS ?? 90);
const MCP_TOKEN_MAX_TTL_DAYS = Number(process.env.MCP_TOKEN_MAX_TTL_DAYS ?? 365);
const MCP_SNAPSHOT_TIMEOUT_MS = Number(process.env.MCP_SNAPSHOT_TIMEOUT_MS ?? 12000);
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://localhost:7010/mcp';
const MCP_AGENT_ALLOWED_TOOLS = process.env.MCP_AGENT_ALLOWED_TOOLS ?? '';
const MCP_TECH_TOKEN = process.env.MCP_TECH_TOKEN ?? '';
const MCP_TECH_USER_ID = process.env.MCP_TECH_USER_ID ?? 'raven-bot';
const MCP_TECH_USER_NAME = process.env.MCP_TECH_USER_NAME ?? 'Raven';
const MCP_TECH_AVATAR_SEED = process.env.MCP_TECH_AVATAR_SEED ?? 'raven-bot';
const MCP_TECH_AVATAR_URL = process.env.MCP_TECH_AVATAR_URL ?? '';
const MCP_TECH_AVATAR_ANIMAL = process.env.MCP_TECH_AVATAR_ANIMAL ?? '';
const MCP_TECH_AVATAR_COLOR = process.env.MCP_TECH_AVATAR_COLOR ?? '';
const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? 'http://agent:8001/run';
const AGENT_SERVICE_TIMEOUT_MS = Number(process.env.AGENT_SERVICE_TIMEOUT_MS ?? 60000);
const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL ?? 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.2';
const OPENAI_SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL ?? OPENAI_MODEL;
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS ?? 30000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? null;
const ASSISTANT_CONTEXT_LIMIT = Number(process.env.ASSISTANT_CONTEXT_LIMIT ?? 20);
const ASSISTANT_MEMORY_K = Number(process.env.ASSISTANT_MEMORY_K ?? 5);
const ASSISTANT_MEMORY_MAX_CHARS = Number(process.env.ASSISTANT_MEMORY_MAX_CHARS ?? 1200);
const ASSISTANT_SUMMARY_REMAINING_RATIO = Number(process.env.ASSISTANT_SUMMARY_REMAINING_RATIO ?? 0.15);
const ASSISTANT_MAX_TURNS = Number(process.env.ASSISTANT_MAX_TURNS ?? 0);
const ASSISTANT_CACHE_TTL_MS = Number(process.env.ASSISTANT_CACHE_TTL_MS ?? 60000);
const ASSISTANT_MODEL_CONTEXT_TOKENS = Number(process.env.ASSISTANT_MODEL_CONTEXT_TOKENS ?? 0);
const ASSISTANT_TOKEN_ESTIMATE_CHARS = Number(process.env.ASSISTANT_TOKEN_ESTIMATE_CHARS ?? 4);
const ASSISTANT_OUTPUT_RESERVE_TOKENS = Number(process.env.ASSISTANT_OUTPUT_RESERVE_TOKENS ?? 0);
const ALERT_WEBHOOK_TIMEOUT_MS = Number(process.env.ALERT_WEBHOOK_TIMEOUT_MS ?? 5000);
const ALERT_PUBLIC_BASE_URL = normalizeEnvValue(process.env.ALERT_PUBLIC_BASE_URL) || APP_ORIGIN || '';
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR ?? path.join(process.cwd(), 'data', 'attachments');
const ATTACHMENTS_MAX_BYTES_RAW = Number(process.env.ATTACHMENTS_MAX_BYTES ?? 33554432);
const ATTACHMENTS_MAX_BYTES = Number.isFinite(ATTACHMENTS_MAX_BYTES_RAW) && ATTACHMENTS_MAX_BYTES_RAW > 0
  ? Math.floor(ATTACHMENTS_MAX_BYTES_RAW)
  : 33554432;
const ENTITY_COUNT_INTERVAL_MS = Number(process.env.ENTITY_COUNT_INTERVAL_MS ?? 60000);
const REDIS_URL = process.env.REDIS_URL ?? '';
const EMBEDDING_DIM = Number(process.env.OPENAI_EMBEDDING_DIM ?? 1536);
const MODEL_CONTEXT_TOKENS = {
  'gpt-5.2': 400000,
};

const logger = getLogger('smart-tracker-api');
const metrics = createMetrics({ serviceName: 'smart-tracker-api' });
const activeSessionsGauge = metrics.registry ? new Gauge({
  name: 'active_sessions',
  help: 'Active sessions with at least one connected client',
  registers: [metrics.registry],
}) : null;
const activeUsersGauge = metrics.registry ? new Gauge({
  name: 'active_users',
  help: 'Unique authenticated users connected via WebSocket',
  registers: [metrics.registry],
}) : null;
const entityCountGauge = metrics.registry ? new Gauge({
  name: 'entity_count',
  help: 'Row count for core tables',
  labelNames: ['entity'],
  registers: [metrics.registry],
}) : null;

const ALERT_EVENTS = {
  cardChanges: 'card_changes',
  mentionAdded: 'mention_added',
  agentReply: 'agent_reply',
};

const DEFAULT_ALERT_CHANNELS = {
  email: { enabled: false },
  telegram: { enabled: false, chatId: null },
  webhook: { enabled: false, url: null },
};

const DEFAULT_ALERT_EVENTS = {
  [ALERT_EVENTS.cardChanges]: false,
  [ALERT_EVENTS.mentionAdded]: false,
  [ALERT_EVENTS.agentReply]: false,
};
const parseCorsOrigin = (v) => {
  if (v === undefined) return true;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
};
const CORS_ORIGIN = parseCorsOrigin(process.env.CORS_ORIGIN);

const pool = new Pool({ connectionString: DATABASE_URL });
let VECTOR_ENABLED = false;

const memoryCache = new Map();
const redis = REDIS_URL
  ? new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  })
  : null;

if (redis) {
  redis.on('error', (err) => {
    console.warn('[cache] redis error', err?.message ?? err);
  });
}

async function initDb() {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    VECTOR_ENABLED = true;
  } catch {
    VECTOR_ENABLED = false;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  try {
    await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_id TEXT');
  } catch {
    // ignore
  }
  try {
    await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS name TEXT');
  } catch {
    // ignore
  }
  try {
    await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ');
  } catch {
    // ignore
  }
  try {
    await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
  } catch {
    // ignore
  }
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at)');
  } catch {
    // ignore
  }

  try {
    await pool.query(
      'UPDATE sessions SET expires_at = NOW() + $1::interval WHERE saved_at IS NULL AND expires_at IS NULL',
      [`${Math.max(1, Math.floor(Number.isFinite(TEMP_SESSION_TTL_DAYS) ? TEMP_SESSION_TTL_DAYS : 7))} days`],
    );
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      name TEXT NOT NULL,
      avatar_seed TEXT NOT NULL,
      avatar_url TEXT,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Migration: allow OAuth providers without email.
  try {
    await pool.query('ALTER TABLE users ALTER COLUMN email DROP NOT NULL');
  } catch {
    // ignore
  }

  // Migration: allow custom avatars.
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT');
  } catch {
    // ignore
  }
  // Migration: allow custom animal/color avatars.
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_animal INTEGER');
  } catch {
    // ignore
  }
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color INTEGER');
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_savers (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, user_id)
    );
  `);
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS session_savers_user_idx ON session_savers (user_id)');
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size BIGINT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS attachments_session_idx ON attachments (session_id)');
  } catch {
    // ignore
  }
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS session_savers_session_idx ON session_savers (session_id)');
  } catch {
    // ignore
  }
  try {
    await pool.query(`
      INSERT INTO session_savers (session_id, user_id, saved_at)
      SELECT id, owner_id, COALESCE(saved_at, NOW())
      FROM sessions
      WHERE owner_id IS NOT NULL
      ON CONFLICT (session_id, user_id) DO NOTHING
    `);
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_accounts (
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (provider, provider_account_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_alert_links (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  try {
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS telegram_alert_links_chat_idx ON telegram_alert_links (chat_id)');
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_alert_link_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  try {
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS telegram_alert_link_tokens_user_idx ON telegram_alert_link_tokens (user_id)');
  } catch {
    // ignore
  }
  try {
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS telegram_alert_link_tokens_chat_idx ON telegram_alert_link_tokens (chat_id)');
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_alert_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender_user_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      session_id TEXT,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS telegram_alert_messages_chat_idx ON telegram_alert_messages (chat_id)');
  } catch {
    // ignore
  }
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS telegram_alert_messages_sender_idx ON telegram_alert_messages (sender_user_id)');
  } catch {
    // ignore
  }
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS telegram_alert_messages_recipient_idx ON telegram_alert_messages (recipient_user_id)');
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_alert_reply_pending (
      chat_id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES telegram_alert_messages(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_change_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      new_email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ
    );
  `);
  try {
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS mcp_tokens_user_id_idx ON mcp_tokens (user_id)');
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS openai_keys (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      api_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS raven_ai_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      model TEXT,
      web_search_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      base_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS raven_ai_settings_user_id_idx ON raven_ai_settings (user_id)');
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerting_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      channels JSONB NOT NULL DEFAULT '{}'::jsonb,
      events JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_threads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT,
      title TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_message_at TIMESTAMPTZ
    );
  `);
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS assistant_threads_user_id_idx ON assistant_threads (user_id)');
  } catch {
    // ignore
  }
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS assistant_threads_session_id_idx ON assistant_threads (session_id)');
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  try {
    await pool.query("ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb");
  } catch {
    // ignore
  }
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS assistant_messages_thread_id_idx ON assistant_messages (thread_id)');
  } catch {
    // ignore
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_summaries (
      thread_id TEXT PRIMARY KEY REFERENCES assistant_threads(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_contexts (
      thread_id TEXT PRIMARY KEY REFERENCES assistant_threads(id) ON DELETE CASCADE,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  if (VECTOR_ENABLED) {
    const dim = Number.isFinite(EMBEDDING_DIM) && EMBEDDING_DIM > 0 ? Math.floor(EMBEDDING_DIM) : 1536;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assistant_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES assistant_threads(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        embedding vector(${dim}),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    try {
      await pool.query('CREATE INDEX IF NOT EXISTS assistant_memories_user_id_idx ON assistant_memories (user_id)');
    } catch {
      // ignore
    }
    try {
      await pool.query('CREATE INDEX IF NOT EXISTS assistant_memories_thread_id_idx ON assistant_memories (thread_id)');
    } catch {
      // ignore
    }
    try {
      await pool.query('CREATE INDEX IF NOT EXISTS assistant_memories_embedding_idx ON assistant_memories USING ivfflat (embedding vector_cosine_ops)');
    } catch {
      // ignore
    }
  } else {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assistant_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES assistant_threads(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        embedding DOUBLE PRECISION[],
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    try {
      await pool.query('CREATE INDEX IF NOT EXISTS assistant_memories_user_id_idx ON assistant_memories (user_id)');
    } catch {
      // ignore
    }
    try {
      await pool.query('CREATE INDEX IF NOT EXISTS assistant_memories_thread_id_idx ON assistant_memories (thread_id)');
    } catch {
      // ignore
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scrubAssistantLogValue = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return `[len:${value.length}]`;
  if (Array.isArray(value)) return `[len:${value.length}]`;
  if (typeof value === 'object') return '[object]';
  return value;
};

const logAssistantEvent = (event, payload) => {
  const safe = {};
  if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      if (key.toLowerCase().includes('content') || key.toLowerCase().includes('message')) {
        safe[key] = scrubAssistantLogValue(value);
      } else {
        safe[key] = value;
      }
    }
  }
  console.log('[assistant]', event, JSON.stringify(safe));
};

async function initDbWithRetry() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await initDb();
      return;
    } catch (e) {
      lastError = e;
      await sleep(500 + attempt * 200);
    }
  }
  throw lastError;
}

async function getSession(id) {
  const res = await pool.query(
    'SELECT id, state, version, name, owner_id, saved_at, expires_at FROM sessions WHERE id = $1 AND (expires_at IS NULL OR expires_at > NOW())',
    [id],
  );
  const row = res.rows[0] ?? null;
  if (!row) return null;
  const normalized = normalizeState(row.state);
  if (!needsStateRepair(row.state, normalized)) return row;

  try {
    const updated = await pool.query(
      `UPDATE sessions
         SET state = $1, version = version + 1, updated_at = NOW()
       WHERE id = $2 AND version = $3
       RETURNING id, state, version, name, owner_id, saved_at, expires_at`,
      [normalized, row.id, row.version],
    );
    return updated.rows[0] ?? { ...row, state: normalized };
  } catch {
    return { ...row, state: normalized };
  }
}

const ensureDir = async (dirPath) => {
  await fs.promises.mkdir(dirPath, { recursive: true });
};

const safeUnlink = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore
  }
};

const sanitizeFilename = (name) => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const base = trimmed ? path.basename(trimmed) : 'attachment';
  const normalized = base.replace(/[^\w.\- ]+/g, '_').slice(0, 180);
  return normalized || 'attachment';
};

const buildStorageName = (id, originalName) => {
  const ext = path.extname(originalName || '').slice(0, 12);
  return ext ? `${id}${ext}` : id;
};

async function createAttachment({ id, sessionId, userId, name, mime, size, storagePath }) {
  const res = await pool.query(
    `INSERT INTO attachments (id, session_id, user_id, name, mime, size, storage_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, session_id, user_id, name, mime, size, storage_path, created_at`,
    [id, sessionId, userId ?? null, name, mime, size, storagePath],
  );
  return res.rows[0] ?? null;
}

async function getAttachmentById(id) {
  const res = await pool.query(
    'SELECT id, session_id, user_id, name, mime, size, storage_path FROM attachments WHERE id = $1',
    [id],
  );
  return res.rows[0] ?? null;
}

async function listSessionSavers(sessionId) {
  const res = await pool.query(
    `SELECT u.id, u.name, u.email
       FROM session_savers ss
       JOIN users u ON u.id = ss.user_id
      WHERE ss.session_id = $1`,
    [sessionId],
  );
  return res.rows.map((row) => ({
    id: row.id,
    name: row.name ?? 'User',
    email: row.email ?? null,
  }));
}

const normalizeUserLookup = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
};

async function resolveSessionParticipantId({ sessionId, userRef }) {
  const normalized = normalizeUserLookup(userRef);
  if (!normalized) return { error: 'participant_not_found' };
  const res = await pool.query(
    `SELECT u.id, u.name, u.email
       FROM session_savers ss
       JOIN users u ON u.id = ss.user_id
      WHERE ss.session_id = $1`,
    [sessionId],
  );
  const rows = res.rows ?? [];
  const direct = rows.find((row) => row.id === userRef);
  if (direct) return { userId: direct.id };
  const matches = [];
  for (const row of rows) {
    const name = typeof row.name === 'string' ? row.name.trim().toLowerCase() : '';
    const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
    const handle = email ? email.split('@')[0] : '';
    if (name === normalized || email === normalized || handle === normalized) {
      matches.push(row);
    }
  }
  if (matches.length === 1) return { userId: matches[0].id };
  if (matches.length > 1) return { error: 'participant_ambiguous' };
  return { error: 'participant_not_found' };
}

async function getUserById(id) {
  const res = await pool.query('SELECT id, email, name, avatar_seed, avatar_url, avatar_animal, avatar_color, verified FROM users WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}

async function getUserByEmail(email) {
  const res = await pool.query('SELECT id, email, password_hash, name, avatar_seed, avatar_url, avatar_animal, avatar_color, verified FROM users WHERE email = $1', [email]);
  return res.rows[0] ?? null;
}

const normalizeWindowMs = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
};

const normalizeRateLimitMax = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
};

const getClientIp = (req) => {
  if (TRUST_PROXY) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
};

const createRateLimiter = ({ windowMs, max, skip }) => {
  const store = new Map();
  const windowSize = normalizeWindowMs(windowMs, 60000);
  const maxHits = normalizeRateLimitMax(max, 1200);
  return (req, res, next) => {
    if (!RATE_LIMIT_ENABLED) return next();
    if (typeof skip === 'function' && skip(req)) return next();
    const key = `${getClientIp(req)}:${req.path}`;
    const now = Date.now();
    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowSize };
      store.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, maxHits - entry.count);
    res.setHeader('x-ratelimit-limit', String(maxHits));
    res.setHeader('x-ratelimit-remaining', String(remaining));
    res.setHeader('x-ratelimit-reset', String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > maxHits) {
      return res.status(429).json({ error: 'rate_limited' });
    }
    if (store.size > 20000) {
      for (const [entryKey, item] of store.entries()) {
        if (item.resetAt <= now) store.delete(entryKey);
      }
    }
    return next();
  };
};

const isSessionRestricted = (session) => {
  if (!session) return false;
  if (SESSION_ACCESS_MODE === 'public') return false;
  if (SESSION_ACCESS_MODE === 'private') return true;
  return Boolean(session.saved_at || session.owner_id);
};

const isSessionMember = async (sessionId, userId, ownerId) => {
  if (!userId) return false;
  if (ownerId && ownerId === userId) return true;
  const res = await pool.query(
    'SELECT 1 FROM session_savers WHERE session_id = $1 AND user_id = $2',
    [sessionId, userId],
  );
  return res.rows.length > 0;
};

const resolveSessionAccess = async ({ sessionId, auth }) => {
  const session = await getSession(sessionId);
  if (!session) return { error: 'not_found' };
  if (!isSessionRestricted(session)) return { session, access: 'public' };
  if (!auth) return { error: 'unauthorized' };
  const member = await isSessionMember(sessionId, auth.userId, session.owner_id);
  if (!member) return { error: 'forbidden' };
  return { session, access: 'member' };
};

const resolveSessionAccessFromRequest = async ({ sessionId, req }) => {
  const session = await getSession(sessionId);
  if (!session) return { error: 'not_found' };
  if (!isSessionRestricted(session)) return { session, access: 'public' };
  const auth = authUserFromRequest(req);
  if (auth?.userId) {
    const member = await isSessionMember(sessionId, auth.userId, session.owner_id);
    if (!member) return { error: 'forbidden' };
    return { session, access: 'member' };
  }
  const token = getBearerToken(req);
  if (!token) return { error: 'unauthorized' };
  const info = await resolveMcpTokenInfo(token);
  if (!info || info?.error) return { error: 'unauthorized' };
  const accessOk = await ensureSessionAccessForUser({
    session,
    userId: info.userId ?? null,
    allowTech: info.kind === 'tech',
  });
  if (!accessOk) return { error: 'forbidden' };
  return { session, access: info.kind === 'tech' ? 'tech' : 'member' };
};

const ensureSessionAccessForUser = async ({ session, userId, allowTech }) => {
  if (!session) return false;
  if (!isSessionRestricted(session)) return true;
  if (allowTech) return true;
  return isSessionMember(session.id, userId, session.owner_id);
};

function parseBoolLike(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  if (!v) return false;
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

async function ensureTestUser() {
  if (!parseBoolLike(TEST_USER_ENABLED)) return;
  const email = String(TEST_USER_EMAIL ?? '').trim().toLowerCase();
  const password = String(TEST_USER_PASSWORD ?? '').trim();
  if (!email || !password) return;

  const existing = await getUserByEmail(email);
  const passwordHash = await bcrypt.hash(password, 10);
  if (!existing) {
    const id = randomUUID();
    const avatarSeed = id;
    await createUser({
      id,
      email,
      passwordHash,
      name: TEST_USER_NAME || 'Test User',
      avatarSeed,
      verified: true,
    });
    return;
  }

  const nextName = TEST_USER_NAME?.trim();
  const updates = { userId: existing.id, passwordHash };
  if (nextName && nextName !== existing.name) {
    updates.name = nextName;
  }
  await updateUserProfile(updates);
  if (!existing.verified) {
    await setUserVerified(existing.id);
  }
}

async function createUser({ id, email, passwordHash, name, avatarSeed, verified, avatarUrl, avatarAnimal, avatarColor }) {
  const res = await pool.query(
    `INSERT INTO users (id, email, password_hash, name, avatar_seed, avatar_url, avatar_animal, avatar_color, verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, email, name, avatar_seed, avatar_url, avatar_animal, avatar_color, verified`,
    [id, email, passwordHash, name, avatarSeed, avatarUrl ?? null, avatarAnimal ?? null, avatarColor ?? null, verified],
  );
  return res.rows[0];
}

async function updateUserProfile({ userId, name, email, passwordHash, avatarUrl, avatarAnimal, avatarColor }) {
  // Build a partial update so callers can change name/email/password independently.
  const fields = [];
  const values = [];
  let idx = 1;

  if (typeof name === 'string') {
    fields.push(`name = $${idx}`);
    values.push(name);
    idx += 1;
  }
  if (typeof email === 'string') {
    fields.push(`email = $${idx}`);
    values.push(email);
    idx += 1;
  }
  if (typeof passwordHash === 'string') {
    fields.push(`password_hash = $${idx}`);
    values.push(passwordHash);
    idx += 1;
  }
  if (avatarUrl !== undefined) {
    fields.push(`avatar_url = $${idx}`);
    values.push(avatarUrl);
    idx += 1;
  }
  if (avatarAnimal !== undefined) {
    fields.push(`avatar_animal = $${idx}`);
    values.push(avatarAnimal);
    idx += 1;
  }
  if (avatarColor !== undefined) {
    fields.push(`avatar_color = $${idx}`);
    values.push(avatarColor);
    idx += 1;
  }

  if (!fields.length) return null;

  fields.push('updated_at = NOW()');
  values.push(userId);
  const res = await pool.query(
    `UPDATE users
        SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING id, email, name, avatar_seed, avatar_url, avatar_animal, avatar_color, verified`,
    values,
  );
  return res.rows[0] ?? null;
}

async function setUserVerified(userId) {
  await pool.query('UPDATE users SET verified = TRUE, updated_at = NOW() WHERE id = $1', [userId]);
}

async function insertEmailVerificationToken({ tokenHash, userId, expiresAt }) {
  await pool.query(
    `INSERT INTO email_verification_tokens (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [tokenHash, userId, expiresAt],
  );
}

async function insertEmailChangeToken({ tokenHash, userId, newEmail, expiresAt }) {
  await pool.query(
    `INSERT INTO email_change_tokens (token_hash, user_id, new_email, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [tokenHash, userId, newEmail, expiresAt],
  );
}

async function consumeEmailVerificationToken(tokenHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `SELECT token_hash, user_id, expires_at
         FROM email_verification_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('DELETE FROM email_verification_tokens WHERE token_hash = $1', [tokenHash]);
    await client.query('COMMIT');
    return row;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw e;
  } finally {
    client.release();
  }
}

async function consumeEmailChangeToken(tokenHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `SELECT token_hash, user_id, new_email, expires_at
         FROM email_change_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('DELETE FROM email_change_tokens WHERE token_hash = $1', [tokenHash]);
    await client.query('COMMIT');
    return row;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw e;
  } finally {
    client.release();
  }
}

async function getMcpTokenForUser(userId) {
  const res = await pool.query(
    `SELECT id, user_id, token_hash, created_at, expires_at, last_used_at
       FROM mcp_tokens
      WHERE user_id = $1`,
    [userId],
  );
  return res.rows[0] ?? null;
}

async function upsertMcpToken({ userId, tokenHash, expiresAt }) {
  const tokenId = randomUUID();
  const res = await pool.query(
    `INSERT INTO mcp_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash,
           expires_at = EXCLUDED.expires_at,
           created_at = NOW(),
           last_used_at = NULL
     RETURNING id, user_id, created_at, expires_at, last_used_at`,
    [tokenId, userId, tokenHash, expiresAt ?? null],
  );
  return res.rows[0] ?? null;
}

async function deleteMcpToken(userId) {
  await pool.query('DELETE FROM mcp_tokens WHERE user_id = $1', [userId]);
}

async function getMcpTokenByHash(tokenHash) {
  const res = await pool.query(
    `SELECT t.user_id, t.created_at, t.expires_at, t.last_used_at,
            u.id, u.name, u.avatar_seed, u.avatar_url, u.avatar_animal, u.avatar_color
       FROM mcp_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1`,
    [tokenHash],
  );
  return res.rows[0] ?? null;
}

async function touchMcpToken(tokenHash) {
  await pool.query('UPDATE mcp_tokens SET last_used_at = NOW() WHERE token_hash = $1', [tokenHash]);
}

const normalizeTechNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const getTechMcpUser = () => ({
  id: MCP_TECH_USER_ID,
  name: MCP_TECH_USER_NAME,
  avatarSeed: MCP_TECH_AVATAR_SEED,
  avatarUrl: MCP_TECH_AVATAR_URL ? MCP_TECH_AVATAR_URL : null,
  avatarAnimal: normalizeTechNumber(MCP_TECH_AVATAR_ANIMAL),
  avatarColor: normalizeTechNumber(MCP_TECH_AVATAR_COLOR),
});

const isTechMcpToken = (rawToken) => !!(MCP_TECH_TOKEN && rawToken === MCP_TECH_TOKEN);

async function resolveMcpTokenInfo(rawToken) {
  if (isTechMcpToken(rawToken)) {
    return {
      kind: 'tech',
      user: getTechMcpUser(),
      userId: MCP_TECH_USER_ID,
      tokenHash: null,
    };
  }
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const row = await getMcpTokenByHash(tokenHash);
  if (!row) return { error: 'invalid' };
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    await deleteMcpToken(row.user_id);
    return { error: 'expired' };
  }
  await touchMcpToken(tokenHash);
  return {
    kind: 'user',
    tokenHash,
    userId: row.user_id,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    user: {
      id: row.user_id,
      name: row.name,
      avatarSeed: row.avatar_seed,
      avatarUrl: row.avatar_url,
      avatarAnimal: row.avatar_animal,
      avatarColor: row.avatar_color,
    },
  };
}

function maskOpenAiKey(key) {
  const raw = typeof key === 'string' ? key.trim() : '';
  if (!raw) return '';
  if (raw.length <= 10) return `${raw.slice(0, 2)}...`;
  return `${raw.slice(0, 3)}...${raw.slice(-4)}`;
}

function serializeOpenAiKeyRow(row) {
  if (!row) return null;
  const createdAt = row.created_at ? new Date(row.created_at) : null;
  const updatedAt = row.updated_at ? new Date(row.updated_at) : null;
  const lastUsedAt = row.last_used_at ? new Date(row.last_used_at) : null;
  return {
    masked: maskOpenAiKey(row.api_key),
    createdAt: createdAt ? createdAt.toISOString() : null,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    lastUsedAt: lastUsedAt ? lastUsedAt.toISOString() : null,
  };
}

async function getOpenAiKeyForUser(userId) {
  const res = await pool.query(
    `SELECT user_id, api_key, created_at, updated_at, last_used_at
       FROM openai_keys
      WHERE user_id = $1`,
    [userId],
  );
  return res.rows[0] ?? null;
}

async function upsertOpenAiKey({ userId, apiKey }) {
  const res = await pool.query(
    `INSERT INTO openai_keys (user_id, api_key)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET api_key = EXCLUDED.api_key,
           updated_at = NOW()
     RETURNING user_id, api_key, created_at, updated_at, last_used_at`,
    [userId, apiKey],
  );
  return res.rows[0] ?? null;
}

async function deleteOpenAiKey(userId) {
  await pool.query('DELETE FROM openai_keys WHERE user_id = $1', [userId]);
}

async function touchOpenAiKey(userId) {
  await pool.query('UPDATE openai_keys SET last_used_at = NOW() WHERE user_id = $1', [userId]);
}

function normalizeRavenAiSettings(raw) {
  const modelRaw = typeof raw?.model === 'string' ? raw.model.trim() : '';
  const baseUrlRaw = typeof raw?.baseUrl === 'string' ? raw.baseUrl.trim() : '';
  return {
    model: modelRaw ? modelRaw.slice(0, 120) : null,
    webSearchEnabled: coerceBool(raw?.webSearchEnabled, false),
    baseUrl: baseUrlRaw ? sanitizeWebhookUrl(baseUrlRaw) : null,
  };
}

function serializeRavenAiSettingsRow(row) {
  if (!row) return null;
  return {
    model: row.model ?? null,
    webSearchEnabled: row.web_search_enabled ?? false,
    baseUrl: row.base_url ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function resolveRavenAiSettings(settings) {
  const baseUrl = OPENAI_API_BASE_URL ? String(OPENAI_API_BASE_URL) : null;
  return {
    model: settings?.model ?? OPENAI_MODEL,
    webSearchEnabled: typeof settings?.webSearchEnabled === 'boolean' ? settings.webSearchEnabled : false,
    baseUrl: settings?.baseUrl ?? baseUrl,
  };
}

async function getRavenAiSettings(userId) {
  const res = await pool.query(
    `SELECT user_id, model, web_search_enabled, base_url, created_at, updated_at
       FROM raven_ai_settings
      WHERE user_id = $1`,
    [userId],
  );
  return res.rows[0] ? serializeRavenAiSettingsRow(res.rows[0]) : null;
}

async function upsertRavenAiSettings({ userId, settings }) {
  const normalized = normalizeRavenAiSettings(settings ?? {});
  const res = await pool.query(
    `INSERT INTO raven_ai_settings (user_id, model, web_search_enabled, base_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET model = EXCLUDED.model,
           web_search_enabled = EXCLUDED.web_search_enabled,
           base_url = EXCLUDED.base_url,
           updated_at = NOW()
     RETURNING user_id, model, web_search_enabled, base_url, created_at, updated_at`,
    [userId, normalized.model, normalized.webSearchEnabled, normalized.baseUrl],
  );
  return res.rows[0] ? serializeRavenAiSettingsRow(res.rows[0]) : null;
}

const coerceBool = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return Boolean(value);
  return fallback;
};

const sanitizeTelegramChatId = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\s+/g, '');
  if (!/^-?\d+$/.test(normalized)) return null;
  return normalized;
};

const normalizeTelegramChatId = (value) => {
  if (value === undefined || value === null) return null;
  return sanitizeTelegramChatId(String(value));
};

const isEmailLike = (value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
};

const resolveTelegramLinkExpiry = () => {
  const hours = Number.isFinite(TELEGRAM_ALERT_LINK_TTL_HOURS) && TELEGRAM_ALERT_LINK_TTL_HOURS > 0
    ? TELEGRAM_ALERT_LINK_TTL_HOURS
    : 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
};

const resolveTelegramReplyExpiry = () => {
  const hours = Number.isFinite(TELEGRAM_ALERT_REPLY_TTL_HOURS) && TELEGRAM_ALERT_REPLY_TTL_HOURS > 0
    ? TELEGRAM_ALERT_REPLY_TTL_HOURS
    : 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
};

const sanitizeWebhookUrl = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const normalizeAlertingSettings = (raw) => {
  const channels = raw?.channels && typeof raw.channels === 'object' ? raw.channels : {};
  const events = raw?.events && typeof raw.events === 'object' ? raw.events : {};
  return {
    channels: {
      email: { enabled: coerceBool(channels?.email?.enabled, DEFAULT_ALERT_CHANNELS.email.enabled) },
      telegram: {
        enabled: coerceBool(channels?.telegram?.enabled, DEFAULT_ALERT_CHANNELS.telegram.enabled),
        chatId: sanitizeTelegramChatId(channels?.telegram?.chatId) ?? DEFAULT_ALERT_CHANNELS.telegram.chatId,
      },
      webhook: {
        enabled: coerceBool(channels?.webhook?.enabled, DEFAULT_ALERT_CHANNELS.webhook.enabled),
        url: sanitizeWebhookUrl(channels?.webhook?.url) ?? DEFAULT_ALERT_CHANNELS.webhook.url,
      },
    },
    events: {
      [ALERT_EVENTS.cardChanges]: coerceBool(events?.[ALERT_EVENTS.cardChanges], DEFAULT_ALERT_EVENTS[ALERT_EVENTS.cardChanges]),
      [ALERT_EVENTS.mentionAdded]: coerceBool(events?.[ALERT_EVENTS.mentionAdded], DEFAULT_ALERT_EVENTS[ALERT_EVENTS.mentionAdded]),
      [ALERT_EVENTS.agentReply]: coerceBool(events?.[ALERT_EVENTS.agentReply], DEFAULT_ALERT_EVENTS[ALERT_EVENTS.agentReply]),
    },
  };
};

const mergeAlertingSettings = (current, incoming) => {
  const base = normalizeAlertingSettings(current);
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const channels = inc.channels && typeof inc.channels === 'object' ? inc.channels : {};
  const events = inc.events && typeof inc.events === 'object' ? inc.events : {};

  const next = {
    channels: {
      email: {
        enabled: channels?.email?.enabled !== undefined
          ? coerceBool(channels.email.enabled, base.channels.email.enabled)
          : base.channels.email.enabled,
      },
      telegram: {
        enabled: channels?.telegram?.enabled !== undefined
          ? coerceBool(channels.telegram.enabled, base.channels.telegram.enabled)
          : base.channels.telegram.enabled,
        chatId: channels?.telegram?.chatId !== undefined
          ? sanitizeTelegramChatId(channels.telegram.chatId)
          : base.channels.telegram.chatId,
      },
      webhook: {
        enabled: channels?.webhook?.enabled !== undefined
          ? coerceBool(channels.webhook.enabled, base.channels.webhook.enabled)
          : base.channels.webhook.enabled,
        url: channels?.webhook?.url !== undefined
          ? sanitizeWebhookUrl(channels.webhook.url)
          : base.channels.webhook.url,
      },
    },
    events: {
      [ALERT_EVENTS.cardChanges]: events?.[ALERT_EVENTS.cardChanges] !== undefined
        ? coerceBool(events[ALERT_EVENTS.cardChanges], base.events[ALERT_EVENTS.cardChanges])
        : base.events[ALERT_EVENTS.cardChanges],
      [ALERT_EVENTS.mentionAdded]: events?.[ALERT_EVENTS.mentionAdded] !== undefined
        ? coerceBool(events[ALERT_EVENTS.mentionAdded], base.events[ALERT_EVENTS.mentionAdded])
        : base.events[ALERT_EVENTS.mentionAdded],
      [ALERT_EVENTS.agentReply]: events?.[ALERT_EVENTS.agentReply] !== undefined
        ? coerceBool(events[ALERT_EVENTS.agentReply], base.events[ALERT_EVENTS.agentReply])
        : base.events[ALERT_EVENTS.agentReply],
    },
  };
  return normalizeAlertingSettings(next);
};

async function getAlertingSettings(userId) {
  const res = await pool.query(
    'SELECT user_id, channels, events FROM alerting_settings WHERE user_id = $1',
    [userId],
  );
  const row = res.rows[0];
  if (!row) return normalizeAlertingSettings({});
  return normalizeAlertingSettings({ channels: row.channels, events: row.events });
}

async function upsertAlertingSettings({ userId, settings }) {
  const normalized = normalizeAlertingSettings(settings);
  const res = await pool.query(
    `INSERT INTO alerting_settings (user_id, channels, events)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET channels = EXCLUDED.channels,
           events = EXCLUDED.events,
           updated_at = NOW()
     RETURNING user_id, channels, events`,
    [userId, normalized.channels, normalized.events],
  );
  return res.rows[0] ? normalizeAlertingSettings(res.rows[0]) : normalized;
}

async function listAlertingSettingsByUserIds(userIds) {
  if (!userIds.length) return new Map();
  const res = await pool.query(
    'SELECT user_id, channels, events FROM alerting_settings WHERE user_id = ANY($1)',
    [userIds],
  );
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.user_id, normalizeAlertingSettings({ channels: row.channels, events: row.events }));
  }
  return map;
}

async function getTelegramAlertLink(userId) {
  const res = await pool.query(
    'SELECT chat_id, created_at, updated_at FROM telegram_alert_links WHERE user_id = $1',
    [userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    chatId: row.chat_id,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function getTelegramAlertLinkByChatId(chatId) {
  const res = await pool.query(
    'SELECT user_id, chat_id FROM telegram_alert_links WHERE chat_id = $1',
    [chatId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { userId: row.user_id, chatId: row.chat_id };
}

async function upsertTelegramAlertLink({ userId, chatId }) {
  const res = await pool.query(
    `INSERT INTO telegram_alert_links (user_id, chat_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET chat_id = EXCLUDED.chat_id,
           updated_at = NOW()
     RETURNING user_id, chat_id, created_at, updated_at`,
    [userId, chatId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    chatId: row.chat_id,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function deleteTelegramAlertLinkByChatId(chatId) {
  await pool.query('DELETE FROM telegram_alert_links WHERE chat_id = $1', [chatId]);
}

async function getTelegramAlertLinkRequest(userId) {
  const res = await pool.query(
    `SELECT token, chat_id, created_at, expires_at
       FROM telegram_alert_link_tokens
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  if (expiresAt && expiresAt.getTime() < Date.now()) {
    await pool.query('DELETE FROM telegram_alert_link_tokens WHERE token = $1', [row.token]);
    return null;
  }
  return {
    token: row.token,
    chatId: row.chat_id,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

async function createTelegramAlertLinkRequest({ userId, chatId }) {
  const token = randomBytes(18).toString('hex');
  const expiresAt = resolveTelegramLinkExpiry();
  await pool.query('DELETE FROM telegram_alert_link_tokens WHERE user_id = $1 OR chat_id = $2', [userId, chatId]);
  await pool.query(
    `INSERT INTO telegram_alert_link_tokens (token, user_id, chat_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [token, userId, chatId, expiresAt],
  );
  return {
    token,
    chatId,
    expiresAt: expiresAt.toISOString(),
  };
}

async function consumeTelegramAlertLinkRequest({ userId, token }) {
  const res = await pool.query(
    `SELECT token, chat_id, expires_at
       FROM telegram_alert_link_tokens
      WHERE user_id = $1 AND token = $2
      LIMIT 1`,
    [userId, token],
  );
  const row = res.rows[0];
  if (!row) return null;
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  await pool.query('DELETE FROM telegram_alert_link_tokens WHERE token = $1', [token]);
  if (expiresAt && expiresAt.getTime() < Date.now()) return null;
  return { chatId: row.chat_id };
}

async function clearTelegramAlertLinkRequest(userId) {
  await pool.query('DELETE FROM telegram_alert_link_tokens WHERE user_id = $1', [userId]);
}

async function listTelegramAlertLinksByUserIds(userIds) {
  if (!userIds.length) return new Map();
  const res = await pool.query(
    'SELECT user_id, chat_id FROM telegram_alert_links WHERE user_id = ANY($1)',
    [userIds],
  );
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.user_id, row.chat_id);
  }
  return map;
}

async function createTelegramAlertMessage({
  id,
  chatId,
  senderUserId,
  recipientUserId,
  sessionId,
  message,
}) {
  if (!id || !chatId || !senderUserId || !recipientUserId || !message) return null;
  const res = await pool.query(
    `INSERT INTO telegram_alert_messages (id, chat_id, sender_user_id, recipient_user_id, session_id, message)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, chat_id, sender_user_id, recipient_user_id, session_id, message, created_at`,
    [id, chatId, senderUserId, recipientUserId, sessionId ?? null, message],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    senderUserId: row.sender_user_id,
    recipientUserId: row.recipient_user_id,
    sessionId: row.session_id ?? null,
    message: row.message,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function deleteTelegramAlertMessage(alertId) {
  if (!alertId) return;
  await pool.query('DELETE FROM telegram_alert_messages WHERE id = $1', [alertId]);
}

async function getTelegramAlertMessage(alertId) {
  if (!alertId) return null;
  const res = await pool.query(
    `SELECT id, chat_id, sender_user_id, recipient_user_id, session_id, message, created_at
       FROM telegram_alert_messages
      WHERE id = $1`,
    [alertId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    senderUserId: row.sender_user_id,
    recipientUserId: row.recipient_user_id,
    sessionId: row.session_id ?? null,
    message: row.message,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function upsertTelegramAlertReplyPending({ chatId, alertId, expiresAt }) {
  if (!chatId || !alertId) return null;
  const res = await pool.query(
    `INSERT INTO telegram_alert_reply_pending (chat_id, alert_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id) DO UPDATE
       SET alert_id = EXCLUDED.alert_id,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()
     RETURNING chat_id, alert_id, created_at, updated_at, expires_at`,
    [chatId, alertId, expiresAt ?? null],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    chatId: row.chat_id,
    alertId: row.alert_id,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}

async function getTelegramAlertReplyPending(chatId) {
  if (!chatId) return null;
  const res = await pool.query(
    `SELECT chat_id, alert_id, created_at, updated_at, expires_at
       FROM telegram_alert_reply_pending
      WHERE chat_id = $1`,
    [chatId],
  );
  const row = res.rows[0];
  if (!row) return null;
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    await clearTelegramAlertReplyPending(chatId);
    return null;
  }
  return {
    chatId: row.chat_id,
    alertId: row.alert_id,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

async function clearTelegramAlertReplyPending(chatId) {
  if (!chatId) return;
  await pool.query('DELETE FROM telegram_alert_reply_pending WHERE chat_id = $1', [chatId]);
}

async function listUsersByIds(ids) {
  if (!ids.length) return new Map();
  const res = await pool.query(
    `SELECT id, name, email
       FROM users
      WHERE id = ANY($1)`,
    [ids],
  );
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.id, { id: row.id, name: row.name ?? 'User', email: row.email ?? null });
  }
  return map;
}

async function getSetting(key) {
  const res = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return res.rows[0]?.value ?? null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

async function deleteSetting(key) {
  await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
}

const MAX_MESSAGE_CHARS = Number(process.env.ASSISTANT_MESSAGE_MAX_CHARS ?? 0);

const readLocalCache = (key) => {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
};

const writeLocalCache = (key, value, ttlMs) => {
  if (!ttlMs) return;
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
};

const cacheGetJson = async (key) => {
  if (redis) {
    const value = await redis.get(key);
    if (value) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  }
  return readLocalCache(key);
};

const cacheSetJson = async (key, value, ttlMs) => {
  if (redis) {
    await redis.set(key, JSON.stringify(value), 'PX', ttlMs);
  } else {
    writeLocalCache(key, value, ttlMs);
  }
};

const normalizeEmbeddingDim = () => {
  if (Number.isFinite(EMBEDDING_DIM) && EMBEDDING_DIM > 0) return Math.floor(EMBEDDING_DIM);
  return 1536;
};

const toVectorLiteral = (embedding) => `[${embedding.map((val) => (Number.isFinite(val) ? val : 0)).join(',')}]`;

const normalizeMessageContent = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!Number.isFinite(MAX_MESSAGE_CHARS) || MAX_MESSAGE_CHARS <= 0) return trimmed;
  return trimmed.slice(0, MAX_MESSAGE_CHARS);
};

const stripAssistantCitations = (value) => {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(/[\uE000-\uF8FF]cite[\uE000-\uF8FF][^\s]*/g, '');
  return stripped.replace(/\s{2,}/g, ' ').trim();
};

const normalizeAssistantOutput = (value) => {
  const normalized = normalizeMessageContent(value);
  if (!normalized) return '';
  return stripAssistantCitations(normalized);
};

const normalizeAssistantContext = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
};

const clampText = (value, max) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

const clampNumber = (value, min, max) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(max, Math.max(min, num));
};

const normalizeSelectionContext = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = clampText(value.sessionId, 160) || null;
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.slice(0, 40).map((node) => {
      if (!node || typeof node !== 'object') return null;
      const id = clampText(node.id, 200);
      if (!id) return null;
      const type = node.type === 'idea' ? 'idea' : 'task';
      const status = node.status === 'done' || node.status === 'in_progress' || node.status === 'queued'
        ? node.status
        : null;
      const progress = clampNumber(node.progress, 0, 100);
      const energy = clampNumber(node.energy, 0, 100);
      return {
        id,
        title: clampText(node.title, 140) || 'Untitled',
        type,
        status: status ?? undefined,
        progress: progress ?? undefined,
        energy: energy ?? undefined,
        layerId: clampText(node.layerId, 200) || undefined,
        link: clampText(node.link, 600) || undefined,
      };
    }).filter(Boolean)
    : [];
  const edges = Array.isArray(value.edges)
    ? value.edges.slice(0, 60).map((edge) => {
      if (!edge || typeof edge !== 'object') return null;
      const id = clampText(edge.id, 200);
      const source = clampText(edge.source, 200);
      const target = clampText(edge.target, 200);
      if (!id || !source || !target) return null;
      return {
        id,
        source,
        target,
        sourceTitle: clampText(edge.sourceTitle, 140) || undefined,
        targetTitle: clampText(edge.targetTitle, 140) || undefined,
        energyEnabled: typeof edge.energyEnabled === 'boolean' ? edge.energyEnabled : undefined,
      };
    }).filter(Boolean)
    : [];
  const textBoxes = Array.isArray(value.textBoxes)
    ? value.textBoxes.slice(0, 40).map((tb) => {
      if (!tb || typeof tb !== 'object') return null;
      const id = clampText(tb.id, 200);
      if (!id) return null;
      const kind = tb.kind === 'image' || tb.kind === 'file' ? tb.kind : 'text';
      const fileSize = clampNumber(tb.fileSize, 0, Number.MAX_SAFE_INTEGER);
      return {
        id,
        kind,
        text: clampText(tb.text, 320) || undefined,
        fileName: clampText(tb.fileName, 180) || undefined,
        fileMime: clampText(tb.fileMime, 120) || undefined,
        fileSize: fileSize ?? undefined,
        layerId: clampText(tb.layerId, 200) || undefined,
      };
    }).filter(Boolean)
    : [];
  const comments = Array.isArray(value.comments)
    ? value.comments.slice(0, 40).map((comment) => {
      if (!comment || typeof comment !== 'object') return null;
      const id = clampText(comment.id, 200);
      if (!id) return null;
      const targetKind = comment.targetKind === 'canvas'
        || comment.targetKind === 'node'
        || comment.targetKind === 'edge'
        || comment.targetKind === 'textBox'
        ? comment.targetKind
        : undefined;
      return {
        id,
        text: clampText(comment.text, 320) || undefined,
        layerId: clampText(comment.layerId, 200) || undefined,
        targetKind,
        targetId: clampText(comment.targetId, 200) || undefined,
      };
    }).filter(Boolean)
    : [];
  if (!nodes.length && !edges.length && !textBoxes.length && !comments.length) return null;
  return { sessionId, nodes, edges, textBoxes, comments };
};

const normalizeAssistantTraceValue = (value, maxLength) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return clampText(value, maxLength) || undefined;
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length <= maxLength) return value;
    return `${encoded.slice(0, maxLength)}...`;
  } catch {
    return clampText(String(value), maxLength) || undefined;
  }
};

const normalizeAssistantTrace = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reasoning = clampText(value.reasoning, 2400) || undefined;
  const rawTools = Array.isArray(value.tools) ? value.tools : [];
  const tools = rawTools.slice(0, 30).map((tool) => {
    if (!tool || typeof tool !== 'object') return null;
    const name = clampText(tool.name, 160);
    if (!name) return null;
    const callId = clampText(tool.callId ?? tool.id, 200) || undefined;
    const args = normalizeAssistantTraceValue(tool.arguments ?? tool.args, 2400);
    const output = normalizeAssistantTraceValue(tool.output ?? tool.result, 8000);
    return {
      name,
      callId,
      arguments: args,
      output,
      isError: tool.isError === true,
    };
  }).filter(Boolean);
  if (!reasoning && !tools.length) return null;
  return {
    reasoning,
    tools,
  };
};

const normalizeAssistantMessageMeta = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const selectionContext = normalizeSelectionContext(value.selectionContext ?? value.selection ?? value);
  const trace = normalizeAssistantTrace(value.trace);
  const externalReply = value.externalReply === true;
  const externalSender = typeof value.externalSender === 'string' ? value.externalSender.trim() : '';
  const externalChannel = typeof value.externalChannel === 'string' ? value.externalChannel.trim() : '';
  if (!selectionContext && !trace && !externalReply) return null;
  const meta = {};
  if (selectionContext) meta.selectionContext = selectionContext;
  if (trace) meta.trace = trace;
  if (externalReply) {
    meta.externalReply = true;
    if (externalSender) meta.externalSender = externalSender;
    if (externalChannel) meta.externalChannel = externalChannel;
  }
  return meta;
};

const isExternalReplyMessage = (message) => {
  if (!message || typeof message !== 'object') return false;
  if (message.meta?.externalReply) return true;
  if (message.role !== 'user') return false;
  const content = typeof message.content === 'string' ? message.content : '';
  return content.startsWith('Пользователь ')
    && content.includes(' ответил на сообщение ')
    && content.includes(' текстом: ');
};

const formatSelectionContextForAgent = (selectionContext) => {
  if (!selectionContext) return '';
  const nodes = Array.isArray(selectionContext.nodes) ? selectionContext.nodes : [];
  const edges = Array.isArray(selectionContext.edges) ? selectionContext.edges : [];
  const textBoxes = Array.isArray(selectionContext.textBoxes) ? selectionContext.textBoxes : [];
  const comments = Array.isArray(selectionContext.comments) ? selectionContext.comments : [];
  if (!nodes.length && !edges.length && !textBoxes.length && !comments.length) return '';

  const lines = ['Selected objects:'];
  if (nodes.length) {
    lines.push('Nodes:');
    nodes.forEach((node) => {
      const parts = [`id:${node.id}`, `type:${node.type}`];
      if (node.status) parts.push(`status:${node.status}`);
      if (Number.isFinite(node.progress)) parts.push(`progress:${node.progress}`);
      if (Number.isFinite(node.energy)) parts.push(`energy:${node.energy}`);
      if (node.layerId) parts.push(`layer:${node.layerId}`);
      if (node.link) parts.push(`link:${node.link}`);
      lines.push(`- ${node.title} (${parts.join(', ')})`);
    });
  }
  if (edges.length) {
    lines.push('Edges:');
    edges.forEach((edge) => {
      const label = edge.sourceTitle && edge.targetTitle
        ? `${edge.sourceTitle} -> ${edge.targetTitle}`
        : `${edge.source} -> ${edge.target}`;
      const parts = [`id:${edge.id}`];
      if (typeof edge.energyEnabled === 'boolean') parts.push(`energy:${edge.energyEnabled ? 'on' : 'off'}`);
      lines.push(`- ${label} (${parts.join(', ')})`);
    });
  }
  if (textBoxes.length) {
    lines.push('Text boxes:');
    textBoxes.forEach((tb) => {
      const parts = [`id:${tb.id}`, `kind:${tb.kind || 'text'}`];
      if (tb.fileName) parts.push(`file:${tb.fileName}`);
      if (tb.fileMime) parts.push(`mime:${tb.fileMime}`);
      if (Number.isFinite(tb.fileSize)) parts.push(`size:${tb.fileSize}`);
      if (tb.layerId) parts.push(`layer:${tb.layerId}`);
      const text = tb.text ? ` "${tb.text}"` : '';
      lines.push(`- ${parts.join(', ')}${text}`);
    });
  }
  if (comments.length) {
    lines.push('Comments:');
    comments.forEach((comment) => {
      const parts = [`id:${comment.id}`];
      if (comment.targetKind) parts.push(`target:${comment.targetKind}`);
      if (comment.targetId) parts.push(`targetId:${comment.targetId}`);
      if (comment.layerId) parts.push(`layer:${comment.layerId}`);
      const text = comment.text ? ` "${comment.text}"` : '';
      lines.push(`- ${parts.join(', ')}${text}`);
    });
  }
  return lines.join('\n');
};

const createOpenAiClient = (apiKey, baseUrl) => new OpenAI({
  apiKey,
  baseURL: baseUrl || OPENAI_API_BASE_URL,
  timeout: OPENAI_TIMEOUT_MS,
});

const getAgentContextUrl = () => {
  if (AGENT_SERVICE_URL.endsWith('/context')) return AGENT_SERVICE_URL;
  if (AGENT_SERVICE_URL.endsWith('/run')) return AGENT_SERVICE_URL.replace(/\/run$/, '/context');
  return `${AGENT_SERVICE_URL.replace(/\/+$/, '')}/context`;
};

const callAgentService = async ({
  apiKey,
  sessionId,
  userName,
  userId,
  inputItems,
  model,
  openaiBaseUrl,
  webSearchEnabled,
  abortSignal,
}) => {
  const allowedTools = (MCP_AGENT_ALLOWED_TOOLS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const resolvedModel = model || OPENAI_MODEL;
  const resolvedBaseUrl = openaiBaseUrl || OPENAI_API_BASE_URL;
  const payload = {
    apiKey,
    model: resolvedModel,
    userName,
    input: inputItems,
    temperature: 0.3,
    openaiBaseUrl: resolvedBaseUrl,
    openaiTimeoutMs: OPENAI_TIMEOUT_MS,
    webSearchEnabled: !!webSearchEnabled,
    mcp: MCP_SERVER_URL
      ? {
          url: MCP_SERVER_URL,
          token: MCP_TECH_TOKEN || null,
          sessionId: sessionId || null,
          userId: userId || null,
          allowedTools,
        }
      : null,
  };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  const timeout = setTimeout(() => controller.abort(), AGENT_SERVICE_TIMEOUT_MS);
  try {
    const res = await fetch(AGENT_SERVICE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body?.detail ?? body ?? {};
      const err = new Error(detail?.message ?? detail?.error ?? res.statusText ?? 'agent_failed');
      err.status = res.status;
      err.code = detail?.error ?? null;
      throw err;
    }
    return {
      output: typeof body?.output === 'string' ? body.output : '',
      context: body?.context ?? null,
      trace: body?.trace ?? null,
    };
  } finally {
    clearTimeout(timeout);
    if (abortSignal) {
      abortSignal.removeEventListener?.('abort', onAbort);
    }
  }
};

const callAgentContext = async ({ model, input, userName }) => {
  const payload = {
    model,
    input,
    userName,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_SERVICE_TIMEOUT_MS);
  try {
    const res = await fetch(getAgentContextUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body?.detail ?? body ?? {};
      const err = new Error(detail?.message ?? detail?.error ?? res.statusText ?? 'agent_context_failed');
      err.status = res.status;
      err.code = detail?.error ?? null;
      throw err;
    }
    return body?.context ?? null;
  } finally {
    clearTimeout(timeout);
  }
};

const hashText = (value) => createHash('sha256').update(value).digest('hex');

const serializeAssistantThreadRow = (row) => ({
  id: row.id,
  sessionId: row.session_id ?? null,
  title: row.title ?? null,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
});

const serializeAssistantMessageRow = (row) => ({
  id: row.id,
  role: row.role,
  content: row.content,
  meta: normalizeAssistantMessageMeta(row.meta) ?? null,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
});

async function createAssistantThread({ userId, sessionId, title }) {
  const id = randomUUID();
  const res = await pool.query(
    `INSERT INTO assistant_threads (id, user_id, session_id, title)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, session_id, title, created_at, updated_at, last_message_at`,
    [id, userId, sessionId ?? null, title ?? null],
  );
  return res.rows[0] ? serializeAssistantThreadRow(res.rows[0]) : null;
}

async function getAssistantThread(userId, threadId) {
  const res = await pool.query(
    `SELECT id, user_id, session_id, title, created_at, updated_at, last_message_at
       FROM assistant_threads
      WHERE id = $1 AND user_id = $2`,
    [threadId, userId],
  );
  return res.rows[0] ? serializeAssistantThreadRow(res.rows[0]) : null;
}

async function getAssistantThreadBySession(userId, sessionId) {
  if (!sessionId) return null;
  const res = await pool.query(
    `SELECT id, user_id, session_id, title, created_at, updated_at, last_message_at
       FROM assistant_threads
      WHERE user_id = $1 AND session_id = $2
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [userId, sessionId],
  );
  return res.rows[0] ? serializeAssistantThreadRow(res.rows[0]) : null;
}

async function getOrCreateAssistantThreadForSession({ userId, sessionId, title }) {
  if (!userId || !sessionId) return null;
  const existing = await getAssistantThreadBySession(userId, sessionId);
  if (existing) return existing;
  return createAssistantThread({ userId, sessionId, title });
}

async function listAssistantMessages(threadId, limit = ASSISTANT_CONTEXT_LIMIT) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(200, Math.floor(limit)) : ASSISTANT_CONTEXT_LIMIT;
  const res = await pool.query(
    `SELECT id, role, content, meta, created_at
       FROM assistant_messages
      WHERE thread_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [threadId, safeLimit],
  );
  return res.rows.reverse().map(serializeAssistantMessageRow);
}

async function countAssistantMessages(threadId) {
  const res = await pool.query(
    'SELECT COUNT(*) AS count FROM assistant_messages WHERE thread_id = $1',
    [threadId],
  );
  const raw = res.rows[0]?.count;
  const count = typeof raw === 'string' ? Number(raw) : Number(raw ?? 0);
  return Number.isFinite(count) ? count : 0;
}

async function getAssistantMessageStats(threadId) {
  const res = await pool.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(content)), 0) AS total_chars
       FROM assistant_messages
      WHERE thread_id = $1`,
    [threadId],
  );
  const row = res.rows[0] ?? {};
  const rawCount = row.count;
  const rawChars = row.total_chars;
  const count = typeof rawCount === 'string' ? Number(rawCount) : Number(rawCount ?? 0);
  const totalChars = typeof rawChars === 'string' ? Number(rawChars) : Number(rawChars ?? 0);
  return {
    count: Number.isFinite(count) ? count : 0,
    totalChars: Number.isFinite(totalChars) ? totalChars : 0,
  };
}

async function getAssistantContext(threadId) {
  const res = await pool.query(
    'SELECT context, updated_at FROM assistant_contexts WHERE thread_id = $1',
    [threadId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return normalizeAssistantContext(row.context);
}

async function upsertAssistantContext({ threadId, context }) {
  const normalized = normalizeAssistantContext(context);
  if (!normalized) return null;
  const res = await pool.query(
    `INSERT INTO assistant_contexts (thread_id, context)
     VALUES ($1, $2)
     ON CONFLICT (thread_id) DO UPDATE
       SET context = EXCLUDED.context,
           updated_at = NOW()
     RETURNING context, updated_at`,
    [threadId, normalized],
  );
  return normalizeAssistantContext(res.rows[0]?.context);
}

async function listAssistantMessagesPage(threadId, limit, offset) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.floor(limit)) : 200;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const res = await pool.query(
    `SELECT id, role, content, meta, created_at
       FROM assistant_messages
      WHERE thread_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [threadId, safeLimit, safeOffset],
  );
  return res.rows.map(serializeAssistantMessageRow);
}

async function getLastUserMessage(threadId) {
  const res = await pool.query(
    `SELECT content
       FROM assistant_messages
      WHERE thread_id = $1
        AND role = 'user'
      ORDER BY created_at DESC
      LIMIT 1`,
    [threadId],
  );
  const content = res.rows[0]?.content;
  return typeof content === 'string' ? content : '';
}

async function insertAssistantMessage({ threadId, role, content, meta }) {
  const normalizedMeta = normalizeAssistantMessageMeta(meta) ?? {};
  const res = await pool.query(
    `INSERT INTO assistant_messages (id, thread_id, role, content, meta)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, role, content, meta, created_at`,
    [randomUUID(), threadId, role, content, normalizedMeta],
  );
  await pool.query(
    `UPDATE assistant_threads
        SET updated_at = NOW(),
            last_message_at = NOW()
      WHERE id = $1`,
    [threadId],
  );
  return res.rows[0] ? serializeAssistantMessageRow(res.rows[0]) : null;
}

async function getAssistantSummary(threadId) {
  const res = await pool.query(
    `SELECT summary, updated_at
       FROM assistant_summaries
      WHERE thread_id = $1`,
    [threadId],
  );
  return res.rows[0] ?? null;
}

async function upsertAssistantSummary(threadId, summary) {
  await pool.query(
    `INSERT INTO assistant_summaries (thread_id, summary)
     VALUES ($1, $2)
     ON CONFLICT (thread_id) DO UPDATE
       SET summary = EXCLUDED.summary,
           updated_at = NOW()`,
    [threadId, summary],
  );
}

async function insertAssistantMemory({ userId, threadId, content, embedding }) {
  if (!Array.isArray(embedding) || embedding.length === 0) return;
  const vectorValue = VECTOR_ENABLED ? toVectorLiteral(embedding) : embedding;
  await pool.query(
    `INSERT INTO assistant_memories (id, user_id, thread_id, content, embedding)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), userId, threadId, content, vectorValue],
  );
}

async function findAssistantMemories({ userId, threadId, embedding, limit }) {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(20, Math.floor(limit)) : ASSISTANT_MEMORY_K;
  if (!Array.isArray(embedding) || embedding.length === 0) return [];
  if (VECTOR_ENABLED) {
    const vectorLiteral = toVectorLiteral(embedding);
    const res = await pool.query(
      `SELECT content
         FROM assistant_memories
        WHERE user_id = $1
          AND thread_id = $2
        ORDER BY embedding <-> $3
        LIMIT $4`,
      [userId, threadId, vectorLiteral, safeLimit],
    );
    return res.rows.map((row) => row.content);
  }
  const res = await pool.query(
    `SELECT content
       FROM assistant_memories
      WHERE user_id = $1
        AND thread_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [userId, threadId, safeLimit],
  );
  return res.rows.map((row) => row.content);
}

async function embedText(apiKey, text, baseUrl) {
  const input = normalizeMessageContent(text);
  if (!input) return null;
  const cacheBaseUrl = baseUrl || OPENAI_API_BASE_URL || '';
  const cacheKey = `emb:${OPENAI_EMBEDDING_MODEL}:${hashText(`${cacheBaseUrl}:${input}`)}`;
  const cached = await cacheGetJson(cacheKey);
  if (Array.isArray(cached)) return cached;

  try {
    const client = createOpenAiClient(apiKey, baseUrl);
    const res = await client.embeddings.create({
      model: OPENAI_EMBEDDING_MODEL,
      input,
    });
    const embedding = res?.data?.[0]?.embedding;
    if (Array.isArray(embedding)) {
      await cacheSetJson(cacheKey, embedding, ASSISTANT_CACHE_TTL_MS);
      return embedding;
    }
    return null;
  } catch (err) {
    console.warn('[assistant] embedding failed', err?.message ?? err);
    return null;
  }
}

const extractResponseText = (response) => {
  if (typeof response?.output_text === 'string') return response.output_text;
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        return part.text;
      }
    }
  }
  return '';
};

const buildMemoryBlock = (memories) => {
  if (!memories || memories.length === 0) return '';
  const lines = memories.map((m) => `- ${m}`);
  return `Relevant memory:\n${lines.join('\n')}`;
};

const estimateTokensFromChars = (chars) => {
  const perToken = Math.max(1, Math.floor(ASSISTANT_TOKEN_ESTIMATE_CHARS));
  const safeChars = Number.isFinite(chars) && chars > 0 ? chars : 0;
  return Math.ceil(safeChars / perToken);
};

const trimTextToTokens = (text, maxTokens) => {
  if (!text || !Number.isFinite(maxTokens) || maxTokens <= 0) return '';
  const maxChars = Math.floor(maxTokens * Math.max(1, Math.floor(ASSISTANT_TOKEN_ESTIMATE_CHARS)));
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
};

const normalizeModelName = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
};

const resolveModelContextTokens = (modelName) => {
  if (Number.isFinite(ASSISTANT_MODEL_CONTEXT_TOKENS) && ASSISTANT_MODEL_CONTEXT_TOKENS > 0) {
    return Math.floor(ASSISTANT_MODEL_CONTEXT_TOKENS);
  }
  const normalized = normalizeModelName(modelName);
  if (!normalized) return 0;
  if (MODEL_CONTEXT_TOKENS[normalized]) return MODEL_CONTEXT_TOKENS[normalized];
  if (normalized.startsWith('gpt-5.2')) return MODEL_CONTEXT_TOKENS['gpt-5.2'] ?? 0;
  return 0;
};

const getContextBudgetTokens = (modelName = OPENAI_MODEL) => resolveModelContextTokens(modelName);

const getSummaryRemainingRatio = () => (Number.isFinite(ASSISTANT_SUMMARY_REMAINING_RATIO)
  ? Math.min(Math.max(ASSISTANT_SUMMARY_REMAINING_RATIO, 0.05), 0.9)
  : 0.15);

const getMaxInputTokens = (modelName = OPENAI_MODEL) => {
  const budgetTokens = getContextBudgetTokens(modelName);
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
  const reserve = Number.isFinite(ASSISTANT_OUTPUT_RESERVE_TOKENS)
    ? Math.max(0, Math.floor(ASSISTANT_OUTPUT_RESERVE_TOKENS))
    : 0;
  return Math.max(1, budgetTokens - reserve);
};

const shouldRefreshSummary = ({ summaryChars, messageChars, modelName }) => {
  const budgetTokens = getContextBudgetTokens(modelName || OPENAI_MODEL);
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return false;
  const usedTokens = estimateTokensFromChars((summaryChars ?? 0) + (messageChars ?? 0));
  const remainingRatio = (budgetTokens - usedTokens) / budgetTokens;
  return remainingRatio <= getSummaryRemainingRatio();
};

const loadAssistantMessagesForBudget = async ({ threadId, maxTokens }) => {
  if (maxTokens === 0) return [];
  const targetTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : null;
  const pageSize = 200;
  let offset = 0;
  let usedTokens = 0;
  const collected = [];
  while (true) {
    const page = await listAssistantMessagesPage(threadId, pageSize, offset);
    if (!page.length) break;
    for (const message of page) {
      const tokens = estimateTokensFromChars((message?.content ?? '').length);
      if (targetTokens !== null && usedTokens + tokens > targetTokens) {
        return collected;
      }
      collected.push(message);
      usedTokens += tokens;
    }
    offset += page.length;
  }
  return collected;
};

const buildSummaryTranscript = async ({ threadId, maxTokens }) => {
  if (maxTokens === 0) return '';
  const targetTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : null;
  const pageSize = 200;
  let offset = 0;
  let usedTokens = 0;
  const lines = [];
  while (true) {
    const page = await listAssistantMessagesPage(threadId, pageSize, offset);
    if (!page.length) break;
    for (const message of page) {
      const prefix = message.role === 'user' ? 'User' : 'Assistant';
      const line = `${prefix}: ${message.content}`;
      const tokens = estimateTokensFromChars(line.length);
      if (targetTokens !== null && usedTokens + tokens > targetTokens) {
        return lines.reverse().join('\n');
      }
      lines.push(line);
      usedTokens += tokens;
    }
    offset += page.length;
  }
  return lines.reverse().join('\n');
};

const buildAssistantContext = async ({
  threadId,
  userId,
  apiKey,
  includeMemories = true,
  model,
  openaiBaseUrl,
}) => {
  const summaryRow = await getAssistantSummary(threadId);
  const summary = summaryRow?.summary ? summaryRow.summary.trim() : '';
  const lastUserMessage = await getLastUserMessage(threadId);
  let memories = [];
  if (includeMemories && apiKey) {
    const embedding = await embedText(apiKey, lastUserMessage, openaiBaseUrl);
    if (embedding) {
      memories = await findAssistantMemories({
        userId,
        threadId,
        embedding,
        limit: ASSISTANT_MEMORY_K,
      });
    }
  }

  let summaryText = summary ? `Conversation summary:\n${summary}` : '';
  let memoryBlock = buildMemoryBlock(memories);
  const maxInputTokens = getMaxInputTokens(model || OPENAI_MODEL);

  if (maxInputTokens > 0) {
    const summaryTokens = estimateTokensFromChars(summaryText.length);
    let memoryTokens = estimateTokensFromChars(memoryBlock.length);
    if (summaryTokens + memoryTokens > maxInputTokens) {
      const remainingForMemory = Math.max(0, maxInputTokens - summaryTokens);
      memoryBlock = trimTextToTokens(memoryBlock, remainingForMemory);
      memoryTokens = estimateTokensFromChars(memoryBlock.length);
      if (summaryTokens + memoryTokens > maxInputTokens) {
        summaryText = trimTextToTokens(summaryText, Math.max(0, maxInputTokens - memoryTokens));
      }
    }
  }

  const items = [];
  if (summaryText) items.push({ role: 'system', content: summaryText });
  if (memoryBlock) items.push({ role: 'system', content: memoryBlock });

  const systemTokens = estimateTokensFromChars(summaryText.length + memoryBlock.length);
  const remainingTokens = maxInputTokens > 0 ? Math.max(0, maxInputTokens - systemTokens) : null;
  const messages = await loadAssistantMessagesForBudget({ threadId, maxTokens: remainingTokens });
  for (const message of messages.slice().reverse()) {
    if (message.role === 'assistant') {
      items.push({
        role: 'assistant',
        content: message.content,
      });
      continue;
    }
    const selectionContext = message?.meta?.selectionContext ?? null;
    const selectionBlock = formatSelectionContextForAgent(selectionContext);
    const content = selectionBlock ? `${message.content}\n\n${selectionBlock}` : message.content;
    items.push({ role: message.role, content });
  }
  return { items };
};

const refreshAssistantSummary = async ({ threadId, apiKey, remainingRatio, openaiBaseUrl, model }) => {
  const summaryRow = await getAssistantSummary(threadId);
  const existing = summaryRow?.summary ? summaryRow.summary.trim() : '';
  const stats = await getAssistantMessageStats(threadId);
  if (!stats.count) return;
  if (Number.isFinite(remainingRatio) && remainingRatio > getSummaryRemainingRatio()) return;
  if (!Number.isFinite(remainingRatio)) {
    const summaryChars = (existing ? `Conversation summary:\n${existing}` : '').length;
    const messageChars = stats.totalChars;
    if (!shouldRefreshSummary({ summaryChars, messageChars, modelName: model })) return;
  }

  const maxInputTokens = getMaxInputTokens(OPENAI_SUMMARY_MODEL);
  const summaryPrefix = existing ? `Previous summary:\n${existing}` : '';

  const basePrompt = [
    'You are summarizing a user/assistant conversation for future context.',
    'Keep the summary concise and actionable: goals, decisions, preferences, open tasks, and unresolved questions.',
    summaryPrefix,
  ].filter(Boolean).join('\n\n');
  const baseTokens = estimateTokensFromChars(basePrompt.length);
  const availableTokens = maxInputTokens > 0 ? Math.max(0, maxInputTokens - baseTokens) : null;
  const transcript = await buildSummaryTranscript({ threadId, maxTokens: availableTokens });
  if (!transcript) return;

  const prompt = [
    basePrompt,
    `New conversation:\n${transcript}`,
  ].filter(Boolean).join('\n\n');

  const client = createOpenAiClient(apiKey, openaiBaseUrl);
  const response = await client.responses.create({
    model: OPENAI_SUMMARY_MODEL,
    input: prompt,
    temperature: 0.2,
  });
  const summary = normalizeMessageContent(extractResponseText(response));
  if (summary) {
    await upsertAssistantSummary(threadId, summary);
  }
};

const scheduleSummaryRefresh = ({ threadId, apiKey, remainingRatio, openaiBaseUrl, model }) => {
  setTimeout(() => {
    refreshAssistantSummary({ threadId, apiKey, remainingRatio, openaiBaseUrl, model }).catch((err) => {
      console.warn('[assistant] summary refresh failed', err?.message ?? err);
    });
  }, 0);
};

const addAssistantMemory = async ({
  threadId,
  userId,
  apiKey,
  userText,
  assistantText,
  openaiBaseUrl,
}) => {
  const combined = `User: ${userText}\nAssistant: ${assistantText}`.slice(0, ASSISTANT_MEMORY_MAX_CHARS);
  const embedding = await embedText(apiKey, combined, openaiBaseUrl);
  if (!embedding) return;
  await insertAssistantMemory({
    userId,
    threadId,
    content: combined,
    embedding,
  });
};

const runAssistantTurn = async ({
  apiKey,
  sessionId,
  userName,
  userId,
  inputItems,
  model,
  openaiBaseUrl,
  webSearchEnabled,
  abortSignal,
}) => {
  try {
    const result = await callAgentService({
      apiKey,
      sessionId,
      userName,
      userId,
      inputItems,
      model,
      openaiBaseUrl,
      webSearchEnabled,
      abortSignal,
    });
    return {
      output: normalizeAssistantOutput(result?.output ?? '') || '',
      context: result?.context ?? null,
      trace: result?.trace ?? null,
    };
  } catch (err) {
    logAssistantEvent('agent_response_error', {
      sessionId: sessionId ?? null,
      status: err?.status ?? err?.statusCode ?? null,
      code: err?.code ?? err?.error?.code ?? err?.code ?? null,
      detail: err?.message ?? null,
      error: err?.message ?? String(err),
    });
    throw err;
  }
};

const notifyAgentReply = async ({ userId, sessionId, message }) => {
  if (!userId || !message) return;
  const session = sessionId ? await getSession(sessionId) : null;
  const alerts = [
    {
      userId,
      event: ALERT_EVENTS.agentReply,
      sessionId: sessionId ?? null,
      sessionName: session?.name ?? null,
      message,
    },
  ];
  await dispatchAlertEvents(alerts);
};

async function createSession(id, state, opts = {}) {
  const expiresAt = Object.prototype.hasOwnProperty.call(opts, 'expiresAt') ? opts.expiresAt : new Date(Date.now() + TEMP_SESSION_TTL_MS);
  const res = await pool.query(
    `INSERT INTO sessions (id, state, version, name, owner_id, saved_at, expires_at)
     VALUES ($1, $2, 0, $3, $4, $5, $6)
     RETURNING id, state, version, name, owner_id, saved_at, expires_at`,
    [id, state, opts.name ?? null, opts.ownerId ?? null, opts.savedAt ?? null, expiresAt ?? null],
  );
  return res.rows[0];
}

const DEFAULT_LAYER_ID = 'layer-default';
const DEFAULT_LAYER_NAME = 'Base';

function normalizeLayer(raw, now, fallbackIndex) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  if (!id) return null;
  const nameRaw = typeof raw.name === 'string' ? raw.name.trim() : '';
  const name = nameRaw || `Layer ${fallbackIndex + 1}`;
  const visible = raw.visible !== false;
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : now;
  const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : createdAt;
  return { id, name, visible, createdAt, updatedAt };
}

function normalizeLayers(raw, now = Date.now()) {
  const input = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const cleaned = [];
  input.forEach((item, idx) => {
    const layer = normalizeLayer(item, now, idx);
    if (!layer || seen.has(layer.id)) return;
    seen.add(layer.id);
    cleaned.push(layer);
  });
  if (!seen.has(DEFAULT_LAYER_ID)) {
    cleaned.unshift({
      id: DEFAULT_LAYER_ID,
      name: DEFAULT_LAYER_NAME,
      visible: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  return cleaned;
}

function ensureLayersForItems(layers, items, now = Date.now()) {
  const next = layers.slice();
  const seen = new Set(next.map((layer) => layer.id));
  const missing = new Set();
  for (const item of items) {
    const layerId = typeof item?.layerId === 'string' ? item.layerId.trim() : '';
    if (!layerId || seen.has(layerId)) continue;
    missing.add(layerId);
  }
  if (!missing.size) return next;
  const sorted = Array.from(missing).sort((a, b) => a.localeCompare(b));
  for (const layerId of sorted) {
    const name = `Layer ${next.length + 1}`;
    next.push({ id: layerId, name, visible: true, createdAt: now, updatedAt: now });
    seen.add(layerId);
  }
  return next;
}

function ensureItemLayerId(items, layers) {
  const layerIds = new Set(layers.map((layer) => layer.id));
  const fallbackId = layers[0]?.id ?? DEFAULT_LAYER_ID;
  let changed = false;
  const next = items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const layerId = typeof item.layerId === 'string' ? item.layerId : null;
    if (layerId && layerIds.has(layerId)) return item;
    changed = true;
    return { ...item, layerId: fallbackId };
  });
  return changed ? next : items;
}

function normalizeTombstones(raw) {
  if (!raw || typeof raw !== 'object') return { nodes: {}, edges: {}, drawings: {}, textBoxes: {}, comments: {}, layers: {} };
  return {
    nodes: raw.nodes && typeof raw.nodes === 'object' ? raw.nodes : {},
    edges: raw.edges && typeof raw.edges === 'object' ? raw.edges : {},
    drawings: raw.drawings && typeof raw.drawings === 'object' ? raw.drawings : {},
    textBoxes: raw.textBoxes && typeof raw.textBoxes === 'object' ? raw.textBoxes : {},
    comments: raw.comments && typeof raw.comments === 'object' ? raw.comments : {},
    layers: raw.layers && typeof raw.layers === 'object' ? raw.layers : {},
  };
}

function normalizeState(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const now = Date.now();
  const nodes = Array.isArray(obj.nodes) ? obj.nodes : [];
  const drawings = Array.isArray(obj.drawings) ? obj.drawings : [];
  const textBoxes = Array.isArray(obj.textBoxes) ? obj.textBoxes : [];
  const comments = Array.isArray(obj.comments) ? obj.comments : [];
  const baseLayers = normalizeLayers(obj.layers, now);
  const layers = ensureLayersForItems(
    baseLayers,
    [...nodes, ...drawings, ...textBoxes, ...comments],
    now,
  );
  return {
    nodes: ensureItemLayerId(nodes, layers),
    edges: Array.isArray(obj.edges) ? obj.edges : [],
    drawings: ensureItemLayerId(drawings, layers),
    textBoxes: ensureItemLayerId(textBoxes, layers),
    comments: ensureItemLayerId(comments, layers),
    layers,
    theme: obj.theme === 'light' ? 'light' : 'dark',
    tombstones: normalizeTombstones(obj.tombstones),
  };
}

const ts = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

function needsStateRepair(raw, normalized) {
  if (!raw || typeof raw !== 'object') return true;
  const rawLayers = Array.isArray(raw.layers) ? raw.layers : null;
  if (!rawLayers) return true;
  const rawIds = new Set(rawLayers.map((layer) => (typeof layer?.id === 'string' ? layer.id : '')).filter(Boolean));
  const normalizedIds = new Set(normalized.layers.map((layer) => layer.id));
  if (rawIds.size !== normalizedIds.size) return true;
  for (const id of normalizedIds) {
    if (!rawIds.has(id)) return true;
  }
  const tombstones = raw.tombstones;
  if (!tombstones || typeof tombstones !== 'object') return true;
  if (!tombstones.layers || typeof tombstones.layers !== 'object') return true;
  return false;
}

function mergeTombstones(a, b) {
  const ta = normalizeTombstones(a);
  const tb = normalizeTombstones(b);
  const out = {
    nodes: { ...ta.nodes },
    edges: { ...ta.edges },
    drawings: { ...ta.drawings },
    textBoxes: { ...ta.textBoxes },
    comments: { ...ta.comments },
    layers: { ...ta.layers },
  };
  for (const [id, t] of Object.entries(tb.nodes)) out.nodes[id] = Math.max(ts(out.nodes[id]), ts(t));
  for (const [id, t] of Object.entries(tb.edges)) out.edges[id] = Math.max(ts(out.edges[id]), ts(t));
  for (const [id, t] of Object.entries(tb.drawings)) out.drawings[id] = Math.max(ts(out.drawings[id]), ts(t));
  for (const [id, t] of Object.entries(tb.textBoxes)) out.textBoxes[id] = Math.max(ts(out.textBoxes[id]), ts(t));
  for (const [id, t] of Object.entries(tb.comments)) out.comments[id] = Math.max(ts(out.comments[id]), ts(t));
  for (const [id, t] of Object.entries(tb.layers)) out.layers[id] = Math.max(ts(out.layers[id]), ts(t));
  return out;
}

function mergeById(currentItems, incomingItems, tombstoneMap) {
  const byId = new Map();
  const consider = (item) => {
    if (!item || typeof item !== 'object') return;
    const id = item.id;
    if (typeof id !== 'string' || !id) return;
    const deletedAt = ts(tombstoneMap?.[id]);
    const updatedAt = ts(item.updatedAt);
    if (deletedAt && deletedAt >= updatedAt) return;

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, item);
      return;
    }
    if (ts(existing.updatedAt) <= updatedAt) byId.set(id, item);
  };

  currentItems.forEach(consider);
  incomingItems.forEach(consider);
  return Array.from(byId.values());
}

function mergeState(currentRaw, incomingRaw) {
  const current = normalizeState(currentRaw);
  const incoming = normalizeState(incomingRaw);

  const tombstones = mergeTombstones(current.tombstones, incoming.tombstones);
  const nodes = mergeById(current.nodes, incoming.nodes, tombstones.nodes);
  const edges = mergeById(current.edges, incoming.edges, tombstones.edges).filter((e) => {
    const sourceDeletedAt = ts(tombstones.nodes?.[e.source]);
    const targetDeletedAt = ts(tombstones.nodes?.[e.target]);
    const edgeUpdatedAt = ts(e.updatedAt);
    if (sourceDeletedAt && sourceDeletedAt >= edgeUpdatedAt) return false;
    if (targetDeletedAt && targetDeletedAt >= edgeUpdatedAt) return false;
    return true;
  });
  const drawings = mergeById(current.drawings, incoming.drawings, tombstones.drawings);
  const textBoxes = mergeById(current.textBoxes, incoming.textBoxes, tombstones.textBoxes);
  const comments = mergeById(current.comments, incoming.comments, tombstones.comments);
  const layers = mergeById(current.layers, incoming.layers, tombstones.layers);

  return {
    nodes,
    edges,
    drawings,
    textBoxes,
    comments,
    layers,
    theme: current.theme,
    tombstones,
  };
}

const nodeTitle = (node) => {
  const title = typeof node?.title === 'string' ? node.title.trim() : '';
  return title || 'Untitled card';
};

const normalizeBaseUrl = (value) => {
  if (!value || typeof value !== 'string') return '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
};

const escapeHtml = (value) => {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const buildCardUrl = ({ baseUrl, sessionId, nodeId }) => {
  if (!baseUrl || !sessionId || !nodeId) return null;
  const base = normalizeBaseUrl(baseUrl);
  return `${base}/?session=${encodeURIComponent(sessionId)}&card=${encodeURIComponent(nodeId)}`;
};

const buildSessionUrl = ({ baseUrl, sessionId }) => {
  if (!baseUrl || !sessionId) return null;
  const base = normalizeBaseUrl(baseUrl);
  return `${base}/?session=${encodeURIComponent(sessionId)}`;
};

const buildAlertLinkSet = ({ sessionId, nodes }) => {
  const baseUrl = normalizeBaseUrl(ALERT_PUBLIC_BASE_URL);
  if (!baseUrl || !sessionId || !Array.isArray(nodes)) return [];
  const links = [];
  for (const node of nodes) {
    if (!node?.id) continue;
    const url = buildCardUrl({ baseUrl, sessionId, nodeId: node.id });
    if (!url) continue;
    links.push({ title: nodeTitle(node), url });
  }
  return links;
};

const mentionInfo = (mentions) => {
  const ids = new Set();
  let hasAll = false;
  if (!Array.isArray(mentions)) return { ids, hasAll };
  for (const item of mentions) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim().toLowerCase() : '';
    if (id === 'all' || label === 'all') {
      hasAll = true;
      continue;
    }
    if (id) ids.add(id);
  }
  return { ids, hasAll };
};

const diffMentions = (prev, next) => {
  const prevInfo = mentionInfo(prev);
  const nextInfo = mentionInfo(next);
  const addedIds = new Set();
  nextInfo.ids.forEach((id) => {
    if (!prevInfo.ids.has(id)) addedIds.add(id);
  });
  const addedAll = nextInfo.hasAll && !prevInfo.hasAll;
  return { addedIds, addedAll };
};

const attachmentSignature = (attachments) => {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  return attachments
    .map((item) => ({
      id: item?.id ?? '',
      name: item?.name ?? '',
      size: item?.size ?? 0,
      mime: item?.mime ?? '',
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((item) => `${item.id}:${item.name}:${item.size}:${item.mime}`)
    .join('|');
};

const nodeChanged = (prev, next) => {
  if (!prev) return true;
  if (prev.title !== next.title) return true;
  if (prev.content !== next.content) return true;
  if (prev.type !== next.type) return true;
  if (prev.clarity !== next.clarity) return true;
  if (prev.status !== next.status) return true;
  if (prev.progress !== next.progress) return true;
  if (prev.energy !== next.energy) return true;
  if (prev.startDate !== next.startDate) return true;
  if (prev.endDate !== next.endDate) return true;
  if (attachmentSignature(prev.attachments) !== attachmentSignature(next.attachments)) return true;
  const prevMentions = Array.isArray(prev.mentions) ? prev.mentions : [];
  const nextMentions = Array.isArray(next.mentions) ? next.mentions : [];
  if (JSON.stringify(prevMentions) !== JSON.stringify(nextMentions)) return true;
  return false;
};

const collectChangedNodes = (prevState, nextState) => {
  const prevNodes = Array.isArray(prevState?.nodes) ? prevState.nodes : [];
  const nextNodes = Array.isArray(nextState?.nodes) ? nextState.nodes : [];
  const prevById = new Map();
  prevNodes.forEach((node) => {
    if (node && typeof node.id === 'string') prevById.set(node.id, node);
  });
  const changes = [];
  for (const node of nextNodes) {
    if (!node || typeof node.id !== 'string') continue;
    const prev = prevById.get(node.id);
    if (nodeChanged(prev, node)) {
      changes.push({ node, prev });
    }
  }
  return changes;
};

async function mergeAndUpdateSession(sessionId, incomingState) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      'SELECT id, state, version, name, owner_id, saved_at, expires_at FROM sessions WHERE id = $1 AND (expires_at IS NULL OR expires_at > NOW()) FOR UPDATE',
      [sessionId],
    );
    const row = res.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    const previousState = row.state;
    const merged = mergeState(row.state, incomingState);
    const updated = await client.query(
      `UPDATE sessions
         SET state = $1, version = version + 1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, state, version, name, owner_id, saved_at, expires_at`,
      [merged, sessionId],
    );
    await client.query('COMMIT');
    return { updated: updated.rows[0] ?? null, previous: previousState };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw e;
  } finally {
    client.release();
  }
}

const buildSessionAlertEvents = async ({ sessionId, sessionName, prevState, nextState, actor }) => {
  const changes = collectChangedNodes(prevState, nextState);
  if (!changes.length) return [];
  const participants = await listSessionSavers(sessionId);
  const participantIds = new Set(participants.map((p) => p.id));
  const alerts = [];

  for (const change of changes) {
    const { node, prev } = change;
    const summaryLines = limitLines(buildChangeSummary(prev, node));
    const changeSummary = summaryLines.join('\n');
    const mentionDiff = diffMentions(prev?.mentions, node?.mentions);
    const mentionRecipients = new Set();
    if (mentionDiff.addedAll) {
      participantIds.forEach((id) => mentionRecipients.add(id));
    }
    mentionDiff.addedIds.forEach((id) => mentionRecipients.add(id));
    if (actor?.id) mentionRecipients.delete(actor.id);

    const mentions = mentionInfo(node?.mentions);
    const recipients = new Set();
    if (mentions.hasAll) {
      participantIds.forEach((id) => recipients.add(id));
    }
    mentions.ids.forEach((id) => recipients.add(id));
    if (node?.authorId) recipients.add(node.authorId);
    if (actor?.id) recipients.delete(actor.id);
    mentionRecipients.forEach((id) => recipients.delete(id));
    if (recipients.size) {
      for (const userId of recipients) {
        alerts.push({
          userId,
          event: ALERT_EVENTS.cardChanges,
          sessionId,
          sessionName,
          actor,
          nodes: [{ id: node.id, title: nodeTitle(node) }],
          message: changeSummary,
        });
      }
    }

    if (mentionRecipients.size) {
      for (const userId of mentionRecipients) {
        alerts.push({
          userId,
          event: ALERT_EVENTS.mentionAdded,
          fallbackEvent: ALERT_EVENTS.cardChanges,
          sessionId,
          sessionName,
          actor,
          nodes: [{ id: node.id, title: nodeTitle(node) }],
          message: changeSummary,
        });
      }
    }
  }
  return alerts;
};

function serializeSession(row) {
  if (!row) return null;
  const savedAt = row.saved_at ?? null;
  return {
    id: row.id,
    state: row.state,
    version: row.version,
    meta: {
      name: row.name ?? null,
      ownerId: row.owner_id ?? null,
      savedAt,
      expiresAt: row.expires_at ?? null,
      saved: !!savedAt,
    },
  };
}

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const formatNodeList = (nodes) => {
  const list = nodes.map((node) => nodeTitle(node));
  const preview = list.slice(0, 3);
  const extra = list.length - preview.length;
  if (!preview.length) return 'Untitled card';
  return extra > 0 ? `${preview.join(', ')} +${extra} more` : preview.join(', ');
};

const snippetText = (value, maxLen = 180) => {
  if (!value || typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen).trim()}…`;
};

const formatValue = (value, maxLen = 80) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number' && !Number.isNaN(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean) return '—';
    return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen).trim()}…`;
  }
  try {
    return formatValue(JSON.stringify(value), maxLen);
  } catch {
    return '—';
  }
};

const formatPercent = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return formatValue(value);
  return `${num}%`;
};

const buildChangeSummary = (prev, next) => {
  const lines = [];
  lines.push(`Card: ${nodeTitle(next)}`);
  if (!prev) {
    lines.push('Created');
    return lines;
  }
  if (prev.title !== next.title) {
    lines.push(`Title: "${formatValue(prev.title)}" -> "${formatValue(next.title)}"`);
  }
  if (prev.content !== next.content) {
    const nextContent = formatValue(next.content, 140);
    lines.push(nextContent === '—' ? 'Description cleared' : `Description: ${nextContent}`);
  }
  if (prev.status !== next.status) {
    lines.push(`Status: ${formatValue(prev.status)} -> ${formatValue(next.status)}`);
  }
  if (prev.progress !== next.progress) {
    lines.push(`Progress: ${formatPercent(prev.progress)} -> ${formatPercent(next.progress)}`);
  }
  if (prev.energy !== next.energy) {
    lines.push(`Energy: ${formatValue(prev.energy)} -> ${formatValue(next.energy)}`);
  }
  if (prev.clarity !== next.clarity) {
    lines.push(`Clarity: ${formatValue(prev.clarity)} -> ${formatValue(next.clarity)}`);
  }
  if (prev.type !== next.type) {
    lines.push(`Type: ${formatValue(prev.type)} -> ${formatValue(next.type)}`);
  }
  if (prev.startDate !== next.startDate) {
    lines.push(`Start date: ${formatValue(prev.startDate)} -> ${formatValue(next.startDate)}`);
  }
  if (prev.endDate !== next.endDate) {
    lines.push(`End date: ${formatValue(prev.endDate)} -> ${formatValue(next.endDate)}`);
  }
  const prevAttachments = Array.isArray(prev.attachments) ? prev.attachments.length : 0;
  const nextAttachments = Array.isArray(next.attachments) ? next.attachments.length : 0;
  if (prevAttachments !== nextAttachments) {
    lines.push(`Attachments: ${prevAttachments} -> ${nextAttachments}`);
  }
  const prevMentions = Array.isArray(prev.mentions) ? prev.mentions : [];
  const nextMentions = Array.isArray(next.mentions) ? next.mentions : [];
  if (JSON.stringify(prevMentions) !== JSON.stringify(nextMentions)) {
    lines.push('Mentions updated');
  }
  return lines;
};

const limitLines = (lines, maxLines = 8) => {
  if (!Array.isArray(lines) || lines.length <= maxLines) return Array.isArray(lines) ? lines : [];
  const trimmed = lines.slice(0, maxLines);
  trimmed.push('More changes omitted.');
  return trimmed;
};

const resolveTelegramChatId = (settings, linkedId) => (
  settings?.channels?.telegram?.chatId || linkedId || null
);

const renderLinkList = ({ links, max = 3, mode }) => {
  const items = Array.isArray(links) ? links : [];
  if (!items.length) return { text: '', extra: 0 };
  const list = items.slice(0, max);
  const extra = items.length - list.length;
  if (mode === 'html') {
    const html = list.map((item) => `<a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>`).join('<br/>');
    return { text: html, extra };
  }
  if (mode === 'telegram') {
    const html = list.map((item) => `<a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>`).join('\n');
    return { text: html, extra };
  }
  const plain = list.map((item) => `${item.title}: ${item.url}`).join('\n');
  return { text: plain, extra };
};

const buildAlertMessage = (event, payload) => {
  const sessionLabel = payload.sessionName || 'canvas';
  const sessionLabelHtml = escapeHtml(sessionLabel);
  const links = buildAlertLinkSet({ sessionId: payload.sessionId, nodes: payload.nodes || [] });
  const textLinks = renderLinkList({ links, mode: 'text' });
  const htmlLinks = renderLinkList({ links, mode: 'html' });
  const telegramLinks = renderLinkList({ links, mode: 'telegram' });
  const changeLines = typeof payload.message === 'string' && payload.message.trim()
    ? payload.message.split('\n').filter((line) => line.trim())
    : [];
  const quoteText = changeLines.length
    ? changeLines.map((line) => `> ${line}`).join('\n')
    : '';
  const quoteHtml = changeLines.length
    ? `<blockquote>${changeLines.map((line) => escapeHtml(line)).join('<br/>')}</blockquote>`
    : '';
  const quoteTelegram = changeLines.length
    ? changeLines.map((line) => `<i>&gt; ${escapeHtml(line)}</i>`).join('\n')
    : '';

  if (event === ALERT_EVENTS.cardChanges) {
    const actorName = payload.actor?.name ? String(payload.actor.name) : '';
    const actorText = actorName ? ` by ${actorName}` : '';
    const actorTextHtml = actorName ? ` by ${escapeHtml(actorName)}` : '';
    const header = payload.nodes?.length === 1 ? 'Card updated' : 'Cards updated';
    const subject = payload.nodes?.length === 1 ? `Card updated: ${nodeTitle(payload.nodes?.[0])}` : `Cards updated (${payload.nodes?.length || 0})`;
    const textParts = [`${header}${actorText} in ${sessionLabel}`];
    if (textLinks.text) textParts.push(textLinks.text);
    if (textLinks.extra > 0) textParts.push(`+${textLinks.extra} more`);
    const htmlParts = [`${escapeHtml(header)}${actorTextHtml} in ${sessionLabelHtml}`];
    if (htmlLinks.text) htmlParts.push(htmlLinks.text);
    if (htmlLinks.extra > 0) htmlParts.push(`+${htmlLinks.extra} more`);
    const telegramParts = [`${escapeHtml(header)}${actorTextHtml} in ${sessionLabelHtml}`];
    if (telegramLinks.text) telegramParts.push(telegramLinks.text);
    if (telegramLinks.extra > 0) telegramParts.push(`+${telegramLinks.extra} more`);
    if (quoteText) textParts.push('', quoteText);
    if (quoteHtml) htmlParts.push('', quoteHtml);
    if (quoteTelegram) telegramParts.push('', quoteTelegram);
    return {
      subject,
      text: `**${subject}**\n\n${textParts.join('\n')}`,
      html: `<strong>${escapeHtml(subject)}</strong><br/><br/>${htmlParts.join('<br/>')}`,
      telegram: {
        text: `<b>${escapeHtml(subject)}</b>\n\n${telegramParts.join('\n')}`,
        parseMode: 'HTML',
      },
    };
  }
  if (event === ALERT_EVENTS.mentionAdded) {
    const header = payload.nodes?.length === 1 ? 'You were tagged' : 'You were tagged in cards';
    const subject = payload.nodes?.length === 1 ? `You were tagged in ${nodeTitle(payload.nodes?.[0])}` : `You were tagged in ${payload.nodes?.length || 0} cards`;
    const textParts = [`${header} in ${sessionLabel}`];
    if (textLinks.text) textParts.push(textLinks.text);
    if (textLinks.extra > 0) textParts.push(`+${textLinks.extra} more`);
    const htmlParts = [`${escapeHtml(header)} in ${sessionLabelHtml}`];
    if (htmlLinks.text) htmlParts.push(htmlLinks.text);
    if (htmlLinks.extra > 0) htmlParts.push(`+${htmlLinks.extra} more`);
    const telegramParts = [`${escapeHtml(header)} in ${sessionLabelHtml}`];
    if (telegramLinks.text) telegramParts.push(telegramLinks.text);
    if (telegramLinks.extra > 0) telegramParts.push(`+${telegramLinks.extra} more`);
    return {
      subject,
      text: `**${subject}**\n\n${textParts.join('\n')}`,
      html: `<strong>${escapeHtml(subject)}</strong><br/><br/>${htmlParts.join('<br/>')}`,
      telegram: {
        text: `<b>${escapeHtml(subject)}</b>\n\n${telegramParts.join('\n')}`,
        parseMode: 'HTML',
      },
    };
  }
  if (event === ALERT_EVENTS.agentReply) {
    const snippet = snippetText(payload.message || '');
    const suffix = snippet ? `: ${snippet}` : '';
    return {
      subject: 'Raven replied',
      text: `**Raven replied**\n\nRaven replied in ${sessionLabel}${suffix}`,
      html: `<strong>Raven replied</strong><br/><br/>Raven replied in ${sessionLabelHtml}${escapeHtml(suffix)}`,
      telegram: {
        text: `<b>Raven replied</b>\n\nRaven replied in ${sessionLabelHtml}${escapeHtml(suffix)}`,
        parseMode: 'HTML',
      },
    };
  }
  return { subject: 'Notification', text: 'You have a new update.' };
};

const buildDirectAlertMessage = ({ sessionId, sessionName, message }) => {
  const subject = 'Raven message';
  const sessionLabel = sessionName || 'canvas';
  const sessionLabelHtml = escapeHtml(sessionLabel);
  const sessionUrl = buildSessionUrl({ baseUrl: ALERT_PUBLIC_BASE_URL, sessionId });
  const rawMessage = typeof message === 'string' ? message.trim() : '';
  const safeMessage = rawMessage || 'Raven sent a new update.';
  const messageLines = safeMessage.split('\n');
  const messageHtml = messageLines.map((line) => escapeHtml(line)).join('<br/>');
  const messageTelegram = messageLines.map((line) => escapeHtml(line)).join('\n');
  const textParts = [safeMessage];
  const htmlParts = [messageHtml];
  const telegramParts = [messageTelegram];
  if (sessionUrl) {
    textParts.push(`Open ${sessionLabel}: ${sessionUrl}`);
    const linkHtml = `<a href="${escapeHtml(sessionUrl)}">Open ${sessionLabelHtml}</a>`;
    htmlParts.push(linkHtml);
    telegramParts.push(linkHtml);
  }
  return {
    subject,
    text: `**${subject}**\n\n${textParts.join('\n\n')}`,
    html: `<strong>${escapeHtml(subject)}</strong><br/><br/>${htmlParts.join('<br/><br/>')}`,
    telegram: {
      text: `<b>${escapeHtml(subject)}</b>\n\n${telegramParts.join('\n\n')}`,
      parseMode: 'HTML',
    },
  };
};

const sendAlertEmail = async ({ to, subject, text, html }) => {
  if (!SMTP_URL) return false;
  const transport = nodemailer.createTransport(SMTP_URL);
  await transport.sendMail({
    from: MAIL_FROM,
    to,
    subject,
    text,
    html,
  });
  return true;
};

const TELEGRAM_MESSAGE_LIMIT = 4096;

const htmlToPlainText = (value) => {
  let text = String(value ?? '');
  text = text.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_match, href, label) => (
    label ? `${label} (${href})` : href
  ));
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p>/gi, '\n');
  text = text.replace(/<[^>]*>/g, '');
  return text;
};

const splitTextIntoSentences = (text) => {
  const safeText = String(text ?? '');
  if (!safeText) return [];
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('ru', { granularity: 'sentence' });
    const segments = Array.from(segmenter.segment(safeText))
      .map((seg) => seg.segment)
      .filter((seg) => seg && seg.trim());
    if (segments.length) return segments;
  }
  const matches = safeText.match(/[^.!?\n]+[.!?…]+(?:["'”»)]*)|\S+$/g);
  return matches && matches.length ? matches : [safeText];
};

const splitLongSegment = (segment, limit) => {
  const parts = [];
  const tokens = segment.match(/\S+\s*/g) ?? [segment];
  let buffer = '';
  for (const tokenRaw of tokens) {
    const token = buffer ? tokenRaw : tokenRaw.trimStart();
    if (!token) continue;
    if (token.length > limit) {
      if (buffer) {
        parts.push(buffer);
        buffer = '';
      }
      for (let idx = 0; idx < token.length; idx += limit) {
        parts.push(token.slice(idx, idx + limit));
      }
      continue;
    }
    if (buffer.length + token.length > limit) {
      if (buffer) parts.push(buffer);
      buffer = token;
      continue;
    }
    buffer += token;
  }
  if (buffer) parts.push(buffer);
  return parts;
};

const splitTextIntoTelegramChunks = (text, limit) => {
  const sentences = splitTextIntoSentences(text);
  const chunks = [];
  let buffer = '';
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (trimmed.length > limit) {
      const parts = splitLongSegment(trimmed, limit);
      for (const part of parts) {
        if (!part) continue;
        if (buffer) {
          chunks.push(buffer);
          buffer = '';
        }
        chunks.push(part);
      }
      continue;
    }
    const next = buffer ? `${buffer} ${trimmed}` : trimmed;
    if (next.length > limit) {
      if (buffer) chunks.push(buffer);
      buffer = trimmed;
      continue;
    }
    buffer = next;
  }
  if (buffer) chunks.push(buffer);
  return chunks.length ? chunks : [String(text ?? '')];
};

const buildTelegramMessageParts = ({ text, parseMode }) => {
  const rawText = typeof text === 'string' ? text : String(text ?? '');
  let effectiveText = rawText;
  let effectiveParseMode = parseMode;
  if (rawText.length > TELEGRAM_MESSAGE_LIMIT && parseMode === 'HTML') {
    effectiveText = htmlToPlainText(rawText);
    effectiveParseMode = undefined;
  }
  const chunks = effectiveText.length > TELEGRAM_MESSAGE_LIMIT
    ? splitTextIntoTelegramChunks(effectiveText, TELEGRAM_MESSAGE_LIMIT)
    : [effectiveText];
  return chunks.map((chunk) => ({
    text: chunk,
    parseMode: effectiveParseMode,
  }));
};

const sendTelegramAlertMessage = async ({ chatId, text, replyMarkup, parseMode }) => {
  if (!TELEGRAM_ALERT_BOT_TOKEN) return false;
  const url = `https://api.telegram.org/bot${TELEGRAM_ALERT_BOT_TOKEN}/sendMessage`;
  const parts = buildTelegramMessageParts({ text, parseMode });
  let allOk = true;
  for (let idx = 0; idx < parts.length; idx += 1) {
    const part = parts[idx];
    const payload = { chat_id: chatId, text: part.text };
    if (replyMarkup && idx === 0) payload.reply_markup = replyMarkup;
    if (part.parseMode) payload.parse_mode = part.parseMode;
    payload.disable_web_page_preview = true;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      ALERT_WEBHOOK_TIMEOUT_MS,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[telegram] send_failed', {
        status: res.status,
        body: body ? body.slice(0, 500) : null,
      });
      allOk = false;
      break;
    }
  }
  return allOk;
};

const answerTelegramAlertCallback = async ({ callbackQueryId, text }) => {
  if (!TELEGRAM_ALERT_BOT_TOKEN || !callbackQueryId) return false;
  const url = `https://api.telegram.org/bot${TELEGRAM_ALERT_BOT_TOKEN}/answerCallbackQuery`;
  const payload = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    ALERT_WEBHOOK_TIMEOUT_MS,
  );
  return res.ok;
};

const sendAlertTelegram = async ({ chatId, text, parseMode, replyMarkup }) => (
  sendTelegramAlertMessage({ chatId, text, parseMode, replyMarkup })
);

const sendAlertWebhook = async ({ url, payload }) => {
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-raven-event': payload.event },
      body: JSON.stringify(payload),
    },
    ALERT_WEBHOOK_TIMEOUT_MS,
  );
  return res.ok;
};

const groupAlerts = (alerts) => {
  const grouped = new Map();
  for (const alert of alerts) {
    const key = `${alert.event}:${alert.userId}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...alert, nodes: alert.nodes ? [...alert.nodes] : [] });
      continue;
    }
    if (alert.nodes?.length) {
      const byId = new Map(existing.nodes.map((n) => [n.id, n]));
      for (const node of alert.nodes) {
        if (!node?.id) continue;
        byId.set(node.id, node);
      }
      existing.nodes = Array.from(byId.values());
    }
    if (alert.message) {
      existing.message = existing.message ? `${existing.message}\n\n${alert.message}` : alert.message;
    }
  }
  return Array.from(grouped.values());
};

const dispatchAlertEvents = async (alerts) => {
  if (!alerts.length) return;
  const userIds = Array.from(new Set(alerts.map((item) => item.userId)));
  const [settingsMap, usersMap] = await Promise.all([
    listAlertingSettingsByUserIds(userIds),
    listUsersByIds(userIds),
  ]);
  const telegramLinkedMap = await listTelegramAlertLinksByUserIds(userIds);
  const resolvedAlerts = [];
  for (const alert of alerts) {
    const settings = settingsMap.get(alert.userId) ?? normalizeAlertingSettings({});
    if (settings.events?.[alert.event]) {
      resolvedAlerts.push(alert);
      continue;
    }
    if (alert.fallbackEvent && settings.events?.[alert.fallbackEvent]) {
      resolvedAlerts.push({ ...alert, event: alert.fallbackEvent });
    }
  }
  if (!resolvedAlerts.length) return;
  const grouped = groupAlerts(resolvedAlerts);

  const tasks = [];
  for (const alert of grouped) {
    const settings = settingsMap.get(alert.userId) ?? normalizeAlertingSettings({});
    const user = usersMap.get(alert.userId);
    if (!user) continue;
    const linkedId = telegramLinkedMap.get(alert.userId) ?? null;
    const message = buildAlertMessage(alert.event, alert);
    const webhookPayload = {
      event: alert.event,
      timestamp: new Date().toISOString(),
      user: { id: user.id, name: user.name, email: user.email },
      session: { id: alert.sessionId, name: alert.sessionName ?? null },
      actor: alert.actor ?? null,
      nodes: alert.nodes ?? [],
      message: alert.message ?? null,
    };

    if (settings.channels?.email?.enabled && user.email) {
      tasks.push(sendAlertEmail({ to: user.email, subject: message.subject, text: message.text, html: message.html }).catch((err) => {
        console.warn('[alerting] email failed', err?.message ?? err);
      }));
    }
    if (settings.channels?.telegram?.enabled) {
      const chatId = resolveTelegramChatId(settings, linkedId);
      if (chatId) {
        const tg = message.telegram;
        tasks.push(sendAlertTelegram({
          chatId,
          text: tg?.text ?? message.text,
          parseMode: tg?.parseMode,
        }).catch((err) => {
          console.warn('[alerting] telegram failed', err?.message ?? err);
        }));
      }
    }
    if (settings.channels?.webhook?.enabled && settings.channels.webhook.url) {
      tasks.push(sendAlertWebhook({ url: settings.channels.webhook.url, payload: webhookPayload }).catch((err) => {
        console.warn('[alerting] webhook failed', err?.message ?? err);
      }));
    }
  }
  if (tasks.length) {
    await Promise.allSettled(tasks);
  }
};

const sendDirectAlertToUser = async ({
  userId,
  sessionId,
  sessionName,
  message,
  actor,
  senderUserId,
}) => {
  if (!userId || !message) return { delivered: { email: false, telegram: false, webhook: false } };
  const [settings, user, telegramLink] = await Promise.all([
    getAlertingSettings(userId),
    getUserById(userId),
    getTelegramAlertLink(userId),
  ]);
  if (!user) return { delivered: { email: false, telegram: false, webhook: false } };
  const chatId = resolveTelegramChatId(settings, telegramLink?.chatId ?? null);
  const messagePayload = buildDirectAlertMessage({ sessionId, sessionName, message });
  const webhookPayload = {
    event: 'agent_message',
    timestamp: new Date().toISOString(),
    user: { id: user.id, name: user.name, email: user.email },
    session: { id: sessionId ?? null, name: sessionName ?? null },
    actor: actor ?? null,
    message,
  };

  const delivered = { email: false, telegram: false, webhook: false };
  const tasks = [];
  if (settings.channels?.email?.enabled && user.email) {
    tasks.push((async () => {
      try {
        delivered.email = await sendAlertEmail({
          to: user.email,
          subject: messagePayload.subject,
          text: messagePayload.text,
          html: messagePayload.html,
        });
      } catch (err) {
        console.warn('[alerting] direct email failed', err?.message ?? err);
      }
    })());
  }
  if (settings.channels?.telegram?.enabled && chatId) {
    tasks.push((async () => {
      try {
        const resolvedSender = senderUserId || actor?.id || null;
        let alertId = null;
        let replyMarkup = null;
        if (resolvedSender) {
          const nextId = randomUUID();
          try {
            await createTelegramAlertMessage({
              id: nextId,
              chatId,
              senderUserId: resolvedSender,
              recipientUserId: user.id,
              sessionId,
              message,
            });
            alertId = nextId;
            replyMarkup = { inline_keyboard: [[{ text: 'Ответить', callback_data: `alert_reply:${alertId}` }]] };
          } catch (err) {
            console.warn('[alerting] telegram reply tracking failed', err?.message ?? err);
          }
        }
        delivered.telegram = await sendAlertTelegram({
          chatId,
          text: messagePayload.telegram?.text ?? messagePayload.text,
          parseMode: messagePayload.telegram?.parseMode,
          replyMarkup,
        });
        if (alertId) {
          if (delivered.telegram) {
            const expiresAt = resolveTelegramReplyExpiry();
            await upsertTelegramAlertReplyPending({ chatId, alertId, expiresAt });
          } else {
            await deleteTelegramAlertMessage(alertId);
          }
        }
      } catch (err) {
        console.warn('[alerting] direct telegram failed', err?.message ?? err);
      }
    })());
  }
  if (settings.channels?.webhook?.enabled && settings.channels.webhook.url) {
    tasks.push((async () => {
      try {
        delivered.webhook = await sendAlertWebhook({ url: settings.channels.webhook.url, payload: webhookPayload });
      } catch (err) {
        console.warn('[alerting] direct webhook failed', err?.message ?? err);
      }
    })());
  }
  if (tasks.length) {
    await Promise.allSettled(tasks);
  }
  return { delivered };
};

async function cleanupExpiredSessions() {
  await pool.query('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= NOW()');
}

async function pinSession(sessionId) {
  await pool.query(
    'UPDATE sessions SET saved_at = COALESCE(saved_at, NOW()), expires_at = NULL WHERE id = $1',
    [sessionId],
  );
}

async function ensurePinnedSession(sessionId) {
  const existing = await pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
  if (!existing.rowCount) {
    await createSession(sessionId, normalizeState({}), { expiresAt: null, savedAt: new Date() });
    return;
  }
  await pinSession(sessionId);
}

const app = express();
app.set('trust proxy', TRUST_PROXY);
if (metrics.enabled) {
  app.get(metrics.path, metrics.handler);
}
app.use(createHttpLogger({
  logger,
  ignorePaths: metrics.enabled ? [metrics.path, '/healthz'] : ['/healthz'],
}));
app.use(metrics.middleware);
const generalRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  skip: (req) => req.path === '/healthz' || (metrics.enabled && req.path === metrics.path),
});
app.use(generalRateLimiter);
const authRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_AUTH_MAX,
});
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
  }),
);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/settings/default-session', async (_req, res) => {
  const id = await getSetting('default_session_id');
  res.json({ id });
});

app.put('/api/settings/default-session', async (req, res) => {
  const id = req.body?.id;
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'bad_request' });
  const session = await getSession(id);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  await setSetting('default_session_id', id);
  res.json({ id });
});

function signAuthToken({ userId }) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

function getBaseUrl(req) {
  if (APP_ORIGIN) return APP_ORIGIN.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] ?? (req.secure ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return `${proto}://${host}`;
}

function sanitizeReturnTo(v) {
  if (typeof v !== 'string') return '/';
  if (!v.startsWith('/')) return '/';
  if (v.startsWith('//')) return '/';
  return v;
}

function resolveMcpTokenExpiresAt(raw) {
  if (raw === null) return null;
  const fallback = Number.isFinite(MCP_TOKEN_DEFAULT_TTL_DAYS) && MCP_TOKEN_DEFAULT_TTL_DAYS > 0 ? MCP_TOKEN_DEFAULT_TTL_DAYS : 90;
  const maxDays = Number.isFinite(MCP_TOKEN_MAX_TTL_DAYS) && MCP_TOKEN_MAX_TTL_DAYS > 0 ? MCP_TOKEN_MAX_TTL_DAYS : 365;
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const days = Math.min(Math.floor(value), maxDays);
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function serializeMcpTokenRow(row) {
  if (!row) return null;
  const createdAt = row.created_at ? new Date(row.created_at) : null;
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const lastUsedAt = row.last_used_at ? new Date(row.last_used_at) : null;
  return {
    createdAt: createdAt ? createdAt.toISOString() : null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    lastUsedAt: lastUsedAt ? lastUsedAt.toISOString() : null,
  };
}

function getBearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const alt = req.headers?.['x-mcp-token'];
  if (typeof alt === 'string') return alt.trim();
  if (Array.isArray(alt) && alt.length) return String(alt[0]).trim();
  return null;
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function authUserFromRequest(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = typeof payload?.userId === 'string' ? payload.userId : null;
    return userId ? { userId } : null;
  } catch {
    return null;
  }
}

app.use('/api/assistant', (req, res, next) => {
  const startedAt = Date.now();
  const auth = authUserFromRequest(req);
  res.on('finish', () => {
    const client = req.headers?.['x-assistant-client'];
    console.log('[assistant-http]', JSON.stringify({
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      userId: auth?.userId ?? null,
      client: typeof client === 'string' ? client : null,
      durationMs: Date.now() - startedAt,
    }));
  });
  next();
});

app.get('/api/auth/me', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.json({ user: null });
  const user = await getUserById(auth.userId);
  if (!user) return res.json({ user: null });
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarSeed: user.avatar_seed,
      avatarUrl: user.avatar_url,
      avatarAnimal: user.avatar_animal,
      avatarColor: user.avatar_color,
      verified: user.verified,
    },
  });
});

// Allow authenticated users to update profile fields from the settings modal.
app.patch('/api/auth/me', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const current = await getUserById(auth.userId);
  if (!current) return res.status(401).json({ error: 'unauthorized' });

  const updates = {};
  const rawName = req.body?.name;
  const rawEmail = req.body?.email;
  const rawPassword = req.body?.password;
  const rawAvatarData = req.body?.avatarData;
  const rawAvatarRemove = req.body?.avatarRemove;
  const rawAvatarAnimal = req.body?.avatarAnimal;
  const rawAvatarColor = req.body?.avatarColor;
  let pendingEmail = null;
  let emailChangeSent = false;
  let devEmailChangeUrl = null;

  if (typeof rawName === 'string') {
    const nextName = rawName.trim();
    if (!nextName || nextName.length < 2) return res.status(400).json({ error: 'bad_name' });
    if (nextName !== current.name) updates.name = nextName.slice(0, 120);
  }

  if (typeof rawEmail === 'string') {
    const nextEmail = rawEmail.trim().toLowerCase();
    const currentEmail = (current.email ?? '').toLowerCase();
    if (!nextEmail || !nextEmail.includes('@')) return res.status(400).json({ error: 'bad_email' });
    if (nextEmail !== currentEmail) {
      const existing = await getUserByEmail(nextEmail);
      if (existing && existing.id !== current.id) return res.status(409).json({ error: 'email_in_use' });
      pendingEmail = nextEmail;
    }
  }

  if (typeof rawPassword === 'string' && rawPassword.length) {
    if (rawPassword.length < 8) return res.status(400).json({ error: 'bad_password' });
    // Hash the new password so OAuth users can set one, too.
    updates.passwordHash = await bcrypt.hash(rawPassword, 10);
  }

  if (rawAvatarRemove === true) {
    updates.avatarUrl = null;
  } else if (typeof rawAvatarData === 'string' && rawAvatarData.length) {
    if (!rawAvatarData.startsWith('data:image/')) return res.status(400).json({ error: 'bad_avatar' });
    if (rawAvatarData.length > 2_000_000) return res.status(400).json({ error: 'avatar_too_large' });
    updates.avatarUrl = rawAvatarData;
  }

  const validateAvatarIndex = (value) => {
    if (value === null) return null;
    if (!Number.isFinite(value)) return undefined;
    const idx = Number(value);
    if (!Number.isInteger(idx)) return undefined;
    if (idx < 0 || idx >= 100) return undefined;
    return idx;
  };

  if (rawAvatarAnimal !== undefined) {
    const nextAnimal = validateAvatarIndex(rawAvatarAnimal);
    if (nextAnimal === undefined) return res.status(400).json({ error: 'bad_avatar_animal' });
    if (nextAnimal !== current.avatar_animal) updates.avatarAnimal = nextAnimal;
  }
  if (rawAvatarColor !== undefined) {
    const nextColor = validateAvatarIndex(rawAvatarColor);
    if (nextColor === undefined) return res.status(400).json({ error: 'bad_avatar_color' });
    if (nextColor !== current.avatar_color) updates.avatarColor = nextColor;
  }

  if (!Object.keys(updates).length && !pendingEmail) {
    return res.status(400).json({ error: 'no_changes' });
  }

  let updated = current;
  if (Object.keys(updates).length) {
    updated = await updateUserProfile({
      userId: current.id,
      name: updates.name,
      passwordHash: updates.passwordHash,
      avatarUrl: updates.avatarUrl,
      avatarAnimal: updates.avatarAnimal,
      avatarColor: updates.avatarColor,
    });
    if (!updated) return res.status(500).json({ error: 'update_failed' });
  }

  if (pendingEmail) {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
    await insertEmailChangeToken({ tokenHash, userId: current.id, newEmail: pendingEmail, expiresAt });
    const confirmUrl = `${getBaseUrl(req)}/api/auth/change-email?token=${encodeURIComponent(rawToken)}`;
    if (SMTP_URL) {
      const transport = nodemailer.createTransport(SMTP_URL);
      await transport.sendMail({
        from: MAIL_FROM,
        to: pendingEmail,
        subject: 'Confirm your new email',
        text: `Confirm your new email: ${confirmUrl}`,
        html: `<p>Confirm your new email:</p><p><a href="${confirmUrl}">${confirmUrl}</a></p>`,
      });
      emailChangeSent = true;
    } else {
      devEmailChangeUrl = confirmUrl;
    }
  }

  if (updates.passwordHash && current.email && SMTP_URL) {
    try {
      const transport = nodemailer.createTransport(SMTP_URL);
      await transport.sendMail({
        from: MAIL_FROM,
        to: current.email,
        subject: 'Password changed',
        text: 'Your password was changed. If this was not you, please reset your password immediately.',
        html: '<p>Your password was changed. If this was not you, please reset your password immediately.</p>',
      });
    } catch {
      // Ignore email errors so profile updates still succeed.
    }
  }

  res.json({
    user: {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      avatarSeed: updated.avatar_seed,
      avatarUrl: updated.avatar_url,
      avatarAnimal: updated.avatar_animal,
      avatarColor: updated.avatar_color,
      verified: updated.verified,
    },
    emailChangePending: !!pendingEmail,
    pendingEmail,
    emailChangeSent,
    devEmailChangeUrl,
  });
});

app.get('/api/integrations/mcp/token', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const row = await getMcpTokenForUser(auth.userId);
  if (!row) return res.json({ token: null });
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    await deleteMcpToken(auth.userId);
    return res.json({ token: null });
  }
  res.json({ token: serializeMcpTokenRow(row) });
});

app.post('/api/integrations/mcp/token', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const expiresAt = resolveMcpTokenExpiresAt(req.body?.expiresInDays);
  if (expiresAt === undefined) return res.status(400).json({ error: 'bad_expiry' });
  const rawToken = `mcp_${randomBytes(24).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const row = await upsertMcpToken({ userId: auth.userId, tokenHash, expiresAt });
  if (!row) return res.status(500).json({ error: 'token_create_failed' });
  res.json({
    token: serializeMcpTokenRow(row),
    rawToken,
  });
});

app.delete('/api/integrations/mcp/token', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  await deleteMcpToken(auth.userId);
  res.json({ ok: true });
});

app.get('/api/raven-ai/key', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const row = await getOpenAiKeyForUser(auth.userId);
  res.json({ key: row ? serializeOpenAiKeyRow(row) : null });
});

app.post('/api/raven-ai/key', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const rawKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!rawKey || rawKey.length < 10) return res.status(400).json({ error: 'bad_api_key' });
  const row = await upsertOpenAiKey({ userId: auth.userId, apiKey: rawKey });
  res.json({ key: serializeOpenAiKeyRow(row) });
});

app.delete('/api/raven-ai/key', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  await deleteOpenAiKey(auth.userId);
  res.json({ ok: true });
});

app.get('/api/raven-ai/settings', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const settings = await getRavenAiSettings(auth.userId);
  res.json({
    settings,
    defaults: resolveRavenAiSettings(null),
  });
});

app.post('/api/raven-ai/settings', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const hasModel = Object.prototype.hasOwnProperty.call(body, 'model');
  const hasWebSearch = Object.prototype.hasOwnProperty.call(body, 'webSearchEnabled');
  const hasBaseUrl = Object.prototype.hasOwnProperty.call(body, 'baseUrl');
  const rawBaseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  const baseUrl = rawBaseUrl ? sanitizeWebhookUrl(rawBaseUrl) : null;
  if (hasBaseUrl && rawBaseUrl && !baseUrl) {
    return res.status(400).json({ error: 'bad_base_url' });
  }

  const current = await getRavenAiSettings(auth.userId);
  const normalized = normalizeRavenAiSettings(body);
  const merged = {
    model: hasModel ? normalized.model : current?.model ?? null,
    webSearchEnabled: hasWebSearch ? normalized.webSearchEnabled : current?.webSearchEnabled ?? false,
    baseUrl: hasBaseUrl ? baseUrl : current?.baseUrl ?? null,
  };
  const saved = await upsertRavenAiSettings({ userId: auth.userId, settings: merged });
  res.json({
    settings: saved,
    defaults: resolveRavenAiSettings(null),
  });
});

app.get('/api/integrations/ai/key', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const row = await getOpenAiKeyForUser(auth.userId);
  res.json({ key: row ? serializeOpenAiKeyRow(row) : null });
});

app.post('/api/integrations/ai/key', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const rawKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!rawKey || rawKey.length < 10) return res.status(400).json({ error: 'bad_api_key' });
  const row = await upsertOpenAiKey({ userId: auth.userId, apiKey: rawKey });
  res.json({ key: serializeOpenAiKeyRow(row) });
});

app.delete('/api/integrations/ai/key', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  await deleteOpenAiKey(auth.userId);
  res.json({ ok: true });
});

app.get('/api/integrations/alerting', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const user = await getUserById(auth.userId);
  const settings = await getAlertingSettings(auth.userId);
  const telegramLink = await getTelegramAlertLink(auth.userId);
  const telegramPending = await getTelegramAlertLinkRequest(auth.userId);
  res.json({
    settings,
    meta: {
      email: user?.email ?? null,
      emailVerified: !!user?.verified,
      telegramLinkedId: telegramLink?.chatId ?? null,
      telegramPending: telegramPending
        ? { token: telegramPending.token, requestedAt: telegramPending.createdAt ?? null, expiresAt: telegramPending.expiresAt ?? null }
        : null,
      telegramConfigured: !!(TELEGRAM_ALERT_BOT_USERNAME && TELEGRAM_ALERT_BOT_TOKEN),
      telegramBotUsername: TELEGRAM_ALERT_BOT_USERNAME || null,
      telegramBotLink: TELEGRAM_ALERT_BOT_USERNAME ? `https://t.me/${TELEGRAM_ALERT_BOT_USERNAME}` : null,
      webhookConfigured: true,
    },
  });
});

app.post('/api/integrations/alerting', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const current = await getAlertingSettings(auth.userId);
  const merged = mergeAlertingSettings(current, req.body);
  const user = await getUserById(auth.userId);
  const telegramLink = await getTelegramAlertLink(auth.userId);
  const telegramPending = await getTelegramAlertLinkRequest(auth.userId);

  if (merged.channels.webhook.enabled && !merged.channels.webhook.url) {
    return res.status(400).json({ error: 'bad_webhook_url' });
  }
  if (merged.channels.telegram.enabled && !merged.channels.telegram.chatId && !telegramLink?.chatId) {
    return res.status(400).json({ error: 'telegram_not_linked' });
  }
  if (merged.channels.email.enabled && !user?.email) {
    return res.status(400).json({ error: 'email_missing' });
  }

  const saved = await upsertAlertingSettings({ userId: auth.userId, settings: merged });
  res.json({
    settings: saved,
    meta: {
      email: user?.email ?? null,
      emailVerified: !!user?.verified,
      telegramLinkedId: telegramLink?.chatId ?? null,
      telegramPending: telegramPending
        ? { token: telegramPending.token, requestedAt: telegramPending.createdAt ?? null, expiresAt: telegramPending.expiresAt ?? null }
        : null,
      telegramConfigured: !!(TELEGRAM_ALERT_BOT_USERNAME && TELEGRAM_ALERT_BOT_TOKEN),
      telegramBotUsername: TELEGRAM_ALERT_BOT_USERNAME || null,
      telegramBotLink: TELEGRAM_ALERT_BOT_USERNAME ? `https://t.me/${TELEGRAM_ALERT_BOT_USERNAME}` : null,
      webhookConfigured: true,
    },
  });
});

app.post('/api/integrations/alerting/telegram/confirm', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) return res.status(400).json({ error: 'bad_token' });

  const pending = await consumeTelegramAlertLinkRequest({ userId: auth.userId, token });
  if (!pending) return res.status(404).json({ error: 'link_not_found' });

  const chatId = normalizeTelegramChatId(pending.chatId);
  if (!chatId) return res.status(400).json({ error: 'bad_chat_id' });
  const existing = await getTelegramAlertLinkByChatId(chatId);
  if (existing && existing.userId !== auth.userId) {
    return res.status(409).json({ error: 'telegram_already_linked' });
  }

  await upsertTelegramAlertLink({ userId: auth.userId, chatId });
  const disconnectLabel = 'Отписаться от уведомлений';
  const disconnectKeyboard = {
    keyboard: [[{ text: disconnectLabel }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
  await sendTelegramAlertMessage({
    chatId,
    text: 'Оповещения подключены. Теперь я буду присылать алерты сюда.',
    replyMarkup: disconnectKeyboard,
  }).catch(() => {});

  res.json({ ok: true });
});

app.post('/api/integrations/alerting/telegram/decline', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  await clearTelegramAlertLinkRequest(auth.userId);
  res.json({ ok: true });
});

app.post('/api/integrations/telegram/webhook', async (req, res) => {
  if (TELEGRAM_ALERT_WEBHOOK_SECRET) {
    const secret = req.headers?.['x-telegram-bot-api-secret-token'];
    const headerValue = Array.isArray(secret) ? secret[0] : secret;
    if (headerValue !== TELEGRAM_ALERT_WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false });
    }
  }
  const update = req.body ?? {};
  const callback = update.callback_query ?? null;
  if (callback && typeof callback.data === 'string') {
    const data = callback.data.trim();
    if (data.startsWith('alert_reply:')) {
      const chatId = normalizeTelegramChatId(callback.message?.chat?.id ?? null);
      const alertId = data.slice('alert_reply:'.length).trim();
      if (!chatId || !alertId) {
        await answerTelegramAlertCallback({ callbackQueryId: callback.id, text: 'Не удалось открыть ответ.' }).catch(() => {});
        return res.json({ ok: true });
      }
      const alert = await getTelegramAlertMessage(alertId);
      if (!alert || alert.chatId !== chatId) {
        await answerTelegramAlertCallback({ callbackQueryId: callback.id, text: 'Не удалось найти сообщение для ответа.' }).catch(() => {});
        return res.json({ ok: true });
      }
      const expiresAt = resolveTelegramReplyExpiry();
      await upsertTelegramAlertReplyPending({ chatId, alertId: alert.id, expiresAt });
      const snippet = snippetText(alert.message, 240);
      const promptLines = ['Напишите ответ для Raven.'];
      if (snippet) promptLines.push(`Сообщение: "${snippet}"`);
      await sendTelegramAlertMessage({
        chatId,
        text: promptLines.join('\n'),
      }).catch(() => {});
      await answerTelegramAlertCallback({ callbackQueryId: callback.id }).catch(() => {});
      return res.json({ ok: true });
    }
  }

  const message = update.message || update.edited_message || null;
  const chatIdRaw = message?.chat?.id ?? null;
  const chatId = normalizeTelegramChatId(chatIdRaw);
  if (!chatId) return res.json({ ok: true });

  const textRaw = typeof message?.text === 'string' ? message.text : '';
  const text = String(textRaw || '').trim();
  const pending = await getTelegramAlertReplyPending(chatId);
  if (pending && text && !text.startsWith('/')) {
    const alert = await getTelegramAlertMessage(pending.alertId);
    if (!alert || alert.chatId !== chatId) {
      await clearTelegramAlertReplyPending(chatId);
      await sendTelegramAlertMessage({
        chatId,
        text: 'Не удалось найти исходное сообщение. Попробуйте нажать кнопку ответа снова.',
      }).catch(() => {});
      return res.json({ ok: true });
    }
    const responder = await getUserById(alert.recipientUserId);
    const responderLabel = responder?.name || responder?.email || alert.recipientUserId || 'Пользователь';
    const originalSnippet = snippetText(alert.message, 500);
    const replySnippet = snippetText(text, 500);
    const replyMessage = `Пользователь ${responderLabel} ответил на сообщение "${originalSnippet}" текстом: "${replySnippet}"`;
    const senderUser = alert.senderUserId ? await getUserById(alert.senderUserId) : null;
    if (!senderUser) {
      await clearTelegramAlertReplyPending(chatId);
      await sendTelegramAlertMessage({
        chatId,
        text: 'Не удалось найти получателя ответа. Попробуйте позже.',
      }).catch(() => {});
      return res.json({ ok: true });
    }
    const thread = await getOrCreateAssistantThreadForSession({
      userId: senderUser.id,
      sessionId: alert.sessionId,
      title: null,
    });
    if (!thread) {
      await sendTelegramAlertMessage({
        chatId,
        text: 'Не удалось передать ответ. Попробуйте позже.',
      }).catch(() => {});
      return res.json({ ok: true });
    }
    await clearTelegramAlertReplyPending(chatId);
    await sendTelegramAlertMessage({
      chatId,
      text: 'Спасибо! Ответ передан Raven.',
    }).catch(() => {});
    await insertAssistantMessage({
      threadId: thread.id,
      role: 'user',
      content: replyMessage,
      meta: {
        externalReply: true,
        externalSender: responderLabel,
        externalChannel: 'telegram',
      },
    });
    sendAssistantStatusToUser({
      sessionId: alert.sessionId,
      userId: senderUser.id,
      threadId: thread.id,
      status: 'thinking',
      reason: 'external_reply',
    });
    void (async () => {
      try {
        const keyRow = await getOpenAiKeyForUser(senderUser.id);
        const apiKey = keyRow?.api_key ?? OPENAI_API_KEY;
        if (!apiKey) {
          console.warn('[telegram] reply ignored: missing_openai_key', senderUser.id);
          return;
        }
        const aiSettings = await getRavenAiSettings(senderUser.id);
        const resolvedAi = resolveRavenAiSettings(aiSettings);
        const { items: inputItems } = await buildAssistantContext({
          threadId: thread.id,
          userId: senderUser.id,
          apiKey,
          model: resolvedAi.model,
          openaiBaseUrl: resolvedAi.baseUrl,
        });
        const assistantResult = await runAssistantTurn({
          apiKey,
          sessionId: alert.sessionId,
          userName: senderUser.name ?? null,
          userId: senderUser.id,
          inputItems,
          model: resolvedAi.model,
          openaiBaseUrl: resolvedAi.baseUrl,
          webSearchEnabled: resolvedAi.webSearchEnabled,
        });
        const assistantText = assistantResult?.output ?? '';
        const reply = assistantText || 'No response returned.';
        const assistantTrace = assistantResult?.trace ? { trace: assistantResult.trace } : null;
        const assistantMessage = await insertAssistantMessage({
          threadId: thread.id,
          role: 'assistant',
          content: reply,
          meta: assistantTrace,
        });
        sendAssistantUpdateToUser({
          sessionId: alert.sessionId,
          userId: senderUser.id,
          threadId: thread.id,
          message: assistantMessage,
          context: assistantResult?.context ?? null,
        });
        void notifyAgentReply({
          userId: senderUser.id,
          sessionId: alert.sessionId ?? null,
          message: reply,
        }).catch((err) => {
          console.warn('[alerting] agent reply failed', err?.message ?? err);
        });
        let context = assistantResult?.context ?? null;
        if (!context) {
          const contextItems = inputItems.concat({ role: 'assistant', content: reply });
          context = await callAgentContext({
            model: resolvedAi.model,
            input: contextItems,
            userName: senderUser.name ?? null,
          }).catch(() => null);
        }
        if (context) {
          void upsertAssistantContext({ threadId: thread.id, context }).catch((err) => {
            console.warn('[assistant] context_upsert_failed', err?.message ?? err);
          });
          const remainingRatio = Number.isFinite(context?.remainingRatio) ? context.remainingRatio : null;
          if (remainingRatio !== null && remainingRatio <= getSummaryRemainingRatio()) {
            scheduleSummaryRefresh({
              threadId: thread.id,
              apiKey,
              remainingRatio,
              openaiBaseUrl: resolvedAi.baseUrl,
              model: resolvedAi.model,
            });
          }
        }
        if (replyMessage && reply) {
          await addAssistantMemory({
            threadId: thread.id,
            userId: senderUser.id,
            apiKey,
            userText: replyMessage,
            assistantText: reply,
            openaiBaseUrl: resolvedAi.baseUrl,
          });
        }
        if (keyRow) {
          await touchOpenAiKey(senderUser.id);
        }
        logAssistantEvent('telegram_reply_processed', {
          userId: senderUser.id,
          threadId: thread.id,
          assistantMessageId: assistantMessage?.id ?? null,
        });
      } catch (err) {
        console.warn('[telegram] reply processing failed', err?.message ?? err);
      } finally {
        sendAssistantStatusToUser({
          sessionId: alert.sessionId,
          userId: senderUser.id,
          threadId: thread.id,
          status: 'idle',
          reason: 'external_reply',
        });
      }
    })();
    return res.json({ ok: true });
  }
  const connectLabel = 'Подключить уведомления';
  const disconnectLabel = 'Отписаться от уведомлений';
  const existingLink = await getTelegramAlertLinkByChatId(chatId);
  const hasLink = !!existingLink;
  const keyboard = {
    keyboard: [[{ text: hasLink ? disconnectLabel : connectLabel }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
  const lower = text.toLowerCase();
  const wantsDisconnect = text === disconnectLabel
    || lower.includes('отпис')
    || lower.includes('unsubscribe')
    || lower === '/stop';
  const wantsConnect = !text
    || text === connectLabel
    || text.startsWith('/start')
    || lower.includes('подключ');

  if (wantsDisconnect) {
    if (!hasLink) {
      await sendTelegramAlertMessage({
        chatId,
        text: 'Уведомления уже отключены.',
        replyMarkup: keyboard,
      }).catch(() => {});
      return res.json({ ok: true });
    }
    await deleteTelegramAlertLinkByChatId(chatId);
    await clearTelegramAlertLinkRequest(existingLink.userId);
    const reconnectKeyboard = {
      keyboard: [[{ text: connectLabel }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    };
    await sendTelegramAlertMessage({
      chatId,
      text: 'Оповещения отключены. Если захотите вернуть, нажмите кнопку ниже.',
      replyMarkup: reconnectKeyboard,
    }).catch(() => {});
    return res.json({ ok: true });
  }

  if (wantsConnect) {
    if (hasLink) {
      await sendTelegramAlertMessage({
        chatId,
        text: 'Оповещения уже подключены. Если хотите отключить, нажмите кнопку ниже.',
        replyMarkup: keyboard,
      }).catch(() => {});
      return res.json({ ok: true });
    }
    await sendTelegramAlertMessage({
      chatId,
      text: 'Чтобы подключить алерты, нажмите кнопку ниже и отправьте email, который используете в Raven.',
      replyMarkup: keyboard,
    }).catch(() => {});
    return res.json({ ok: true });
  }

  if (!isEmailLike(text)) {
    await sendTelegramAlertMessage({
      chatId,
      text: 'Отправьте email, который используете в Raven, чтобы подключить алерты.',
      replyMarkup: keyboard,
    }).catch(() => {});
    return res.json({ ok: true });
  }

  const email = text.trim().toLowerCase();
  const user = await getUserByEmail(email);
  if (!user) {
    await sendTelegramAlertMessage({
      chatId,
      text: 'Не нашел аккаунт с таким email. Проверьте адрес и попробуйте снова.',
    }).catch(() => {});
    return res.json({ ok: true });
  }

  if (existingLink && existingLink.userId !== user.id) {
    await sendTelegramAlertMessage({
      chatId,
      text: 'Этот чат уже привязан к другому аккаунту.',
    }).catch(() => {});
    return res.json({ ok: true });
  }
  if (existingLink && existingLink.userId === user.id) {
    await sendTelegramAlertMessage({
      chatId,
      text: 'Этот Telegram уже подключен к вашему аккаунту.',
      replyMarkup: keyboard,
    }).catch(() => {});
    return res.json({ ok: true });
  }

  await createTelegramAlertLinkRequest({ userId: user.id, chatId });
  await sendTelegramAlertMessage({
    chatId,
    text: 'Готово! Откройте Raven → Integrations → Alerting и подтвердите подключение.',
  }).catch(() => {});

  res.json({ ok: true });
});

app.post('/api/assistant/chat', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (auth) {
    logAssistantEvent('legacy_chat', { userId: auth.userId, hasMessages: Array.isArray(req.body?.messages) });
  } else {
    logAssistantEvent('legacy_chat', { userId: null });
  }
  res.status(410).json({ error: 'assistant_chat_deprecated' });
});

app.post('/api/assistant/threads', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!sessionId) return res.status(400).json({ error: 'session_required' });
  const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const title = rawTitle ? rawTitle.slice(0, 120) : null;
  const thread = await getOrCreateAssistantThreadForSession({
    userId: auth.userId,
    sessionId,
    title,
  });
  logAssistantEvent('thread_create', {
    userId: auth.userId,
    threadId: thread?.id ?? null,
    sessionId: thread?.sessionId ?? null,
  });
  res.json({ thread });
});

app.get('/api/assistant/threads/:id', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const threadId = req.params?.id;
  if (!threadId) return res.status(400).json({ error: 'thread_required' });
  const thread = await getAssistantThread(auth.userId, threadId);
  if (!thread) return res.status(404).json({ error: 'thread_not_found' });
  logAssistantEvent('thread_get', { userId: auth.userId, threadId });
  res.json({ thread });
});

app.get('/api/assistant/threads/:id/messages', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const threadId = req.params?.id;
  if (!threadId) return res.status(400).json({ error: 'thread_required' });
  const thread = await getAssistantThread(auth.userId, threadId);
  if (!thread) return res.status(404).json({ error: 'thread_not_found' });
  const querySessionId = typeof req.query?.sessionId === 'string' ? req.query.sessionId.trim() : '';
  if (querySessionId && thread.sessionId && querySessionId !== thread.sessionId) {
    return res.status(409).json({ error: 'thread_session_mismatch' });
  }
  const rawLimit = req.query?.limit;
  const parsedLimit = typeof rawLimit === 'string' ? Number(rawLimit) : Number(rawLimit ?? NaN);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : ASSISTANT_CONTEXT_LIMIT;
  const messages = (await listAssistantMessages(threadId, limit))
    .filter((msg) => !isExternalReplyMessage(msg));
  const aiSettings = await getRavenAiSettings(auth.userId);
  const resolvedAi = resolveRavenAiSettings(aiSettings);
  let context = await getAssistantContext(threadId);
  if (!context) {
    const user = await getUserById(auth.userId);
    const { items } = await buildAssistantContext({
      threadId,
      userId: auth.userId,
      apiKey: null,
      includeMemories: false,
      model: resolvedAi.model,
    });
    context = await callAgentContext({
      model: resolvedAi.model,
      input: items,
      userName: user?.name ?? null,
    }).catch(() => null);
    if (context) {
      void upsertAssistantContext({ threadId, context }).catch((err) => {
        console.warn('[assistant] context_upsert_failed', err?.message ?? err);
      });
    }
  }
  logAssistantEvent('thread_messages', {
    userId: auth.userId,
    threadId,
    limit,
    count: messages.length,
  });
  res.json({ messages, context });
});

app.post('/api/assistant/threads/:id/messages', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const threadId = req.params?.id;
  if (!threadId) return res.status(400).json({ error: 'thread_required' });
  const thread = await getAssistantThread(auth.userId, threadId);
  if (!thread) return res.status(404).json({ error: 'thread_not_found' });

  const incomingSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!incomingSessionId) return res.status(400).json({ error: 'session_required' });
  const session = await getSession(incomingSessionId);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (thread.sessionId && thread.sessionId !== incomingSessionId) {
    return res.status(409).json({ error: 'thread_session_mismatch' });
  }
  if (!thread.sessionId || thread.sessionId !== incomingSessionId) {
    await pool.query(
      'UPDATE assistant_threads SET session_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
      [incomingSessionId, threadId, auth.userId],
    );
    thread.sessionId = incomingSessionId;
  }

  const userText = normalizeMessageContent(req.body?.content);
  if (!userText) return res.status(400).json({ error: 'content_required' });
  const selectionContext = normalizeSelectionContext(req.body?.selectionContext);

  const user = await getUserById(auth.userId);
  const keyRow = await getOpenAiKeyForUser(auth.userId);
  const apiKey = keyRow?.api_key ?? OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'openai_key_required' });
  const aiSettings = await getRavenAiSettings(auth.userId);
  const resolvedAi = resolveRavenAiSettings(aiSettings);
  const requestAbort = new AbortController();
  let connectionClosed = false;
  req.on('close', () => {
    if (res.writableEnded) return;
    connectionClosed = true;
    requestAbort.abort();
  });

  try {
    logAssistantEvent('message_start', {
      userId: auth.userId,
      threadId,
      sessionId: thread.sessionId ?? null,
      content: userText,
    });
    const userMessage = await insertAssistantMessage({
      threadId,
      role: 'user',
      content: userText,
      meta: selectionContext ? { selectionContext } : null,
    });
    const { items: inputItems } = await buildAssistantContext({
      threadId,
      userId: auth.userId,
      apiKey,
      model: resolvedAi.model,
      openaiBaseUrl: resolvedAi.baseUrl,
    });
    const assistantResult = await runAssistantTurn({
      apiKey,
      sessionId: thread.sessionId,
      userName: user?.name ?? null,
      userId: auth.userId,
      inputItems,
      model: resolvedAi.model,
      openaiBaseUrl: resolvedAi.baseUrl,
      webSearchEnabled: resolvedAi.webSearchEnabled,
      abortSignal: requestAbort.signal,
    });
    const assistantText = assistantResult?.output ?? '';
    const reply = assistantText || 'No response returned.';
    const assistantTrace = assistantResult?.trace ? { trace: assistantResult.trace } : null;
    const assistantMessage = await insertAssistantMessage({
      threadId,
      role: 'assistant',
      content: reply,
      meta: assistantTrace,
    });
    void notifyAgentReply({
      userId: auth.userId,
      sessionId: thread.sessionId ?? null,
      message: reply,
    }).catch((err) => {
      console.warn('[alerting] agent reply failed', err?.message ?? err);
    });
    let context = assistantResult?.context ?? null;
    if (!context) {
      const contextItems = inputItems.concat({ role: 'assistant', content: reply });
      context = await callAgentContext({
        model: resolvedAi.model,
        input: contextItems,
        userName: user?.name ?? null,
      }).catch(() => null);
    }
    if (context) {
      void upsertAssistantContext({ threadId, context }).catch((err) => {
        console.warn('[assistant] context_upsert_failed', err?.message ?? err);
      });
    }
    const remainingRatio = Number.isFinite(context?.remainingRatio) ? context.remainingRatio : null;
    if (remainingRatio !== null && remainingRatio <= getSummaryRemainingRatio()) {
      scheduleSummaryRefresh({
        threadId,
        apiKey,
        remainingRatio,
        openaiBaseUrl: resolvedAi.baseUrl,
        model: resolvedAi.model,
      });
    }
    if (userText && reply) {
      await addAssistantMemory({
        threadId,
        userId: auth.userId,
        apiKey,
        userText,
        assistantText: reply,
        openaiBaseUrl: resolvedAi.baseUrl,
      });
    }
    if (keyRow) {
      await touchOpenAiKey(auth.userId);
    }
    logAssistantEvent('message_done', {
      userId: auth.userId,
      threadId,
      assistantMessageId: assistantMessage?.id ?? null,
    });
    if (connectionClosed) return;
    res.json({
      message: reply,
      userMessage,
      assistantMessage,
      context,
    });
  } catch (err) {
    if (connectionClosed || err?.name === 'AbortError') return;
    const status = err?.statusCode ?? err?.status;
    logAssistantEvent('message_error', {
      userId: auth.userId,
      threadId,
      status: status ?? null,
      code: err?.code ?? err?.error?.code ?? null,
      type: err?.error?.type ?? null,
      detail: err?.error?.message ?? null,
      error: err?.message ?? String(err),
    });
    if (status === 401) return res.status(401).json({ error: 'invalid_openai_key' });
    if (status === 429) return res.status(429).json({ error: 'openai_rate_limited' });
    res.status(502).json({ error: err?.message ?? 'assistant_failed' });
  }
});

app.post('/api/integrations/mcp/verify', async (req, res) => {
  const headerToken = getBearerToken(req);
  const bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const rawToken = headerToken || bodyToken;
  if (!rawToken) return res.status(400).json({ error: 'token_required' });
  const info = await resolveMcpTokenInfo(rawToken);
  if (info?.error === 'invalid') return res.status(401).json({ error: 'invalid_token' });
  if (info?.error === 'expired') return res.status(401).json({ error: 'token_expired' });
  if (!info?.user) return res.status(401).json({ error: 'invalid_token' });
  res.json({
    ok: true,
    token: {
      expiresAt: info.kind === 'user' ? info.expiresAt ?? null : null,
    },
    user: {
      id: info.user.id,
      name: info.user.name,
      avatarSeed: info.user.avatarSeed ?? '',
      avatarUrl: info.user.avatarUrl ?? null,
      avatarAnimal: info.user.avatarAnimal ?? null,
      avatarColor: info.user.avatarColor ?? null,
    },
  });
});

app.post('/api/integrations/mcp/participants', async (req, res) => {
  const headerToken = getBearerToken(req);
  const bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const rawToken = headerToken || bodyToken;
  if (!rawToken) return res.status(400).json({ error: 'token_required' });
  const info = await resolveMcpTokenInfo(rawToken);
  if (info?.error === 'invalid') return res.status(401).json({ error: 'invalid_token' });
  if (info?.error === 'expired') return res.status(401).json({ error: 'token_expired' });

  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!sessionId) return res.status(400).json({ error: 'session_id_required' });
  const session = await getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  const allowTech = info?.kind === 'tech';
  const accessOk = await ensureSessionAccessForUser({
    session,
    userId: info?.userId ?? null,
    allowTech,
  });
  if (!accessOk) return res.status(403).json({ error: 'forbidden' });

  const rows = await pool.query(
    `SELECT u.id, u.name, u.email, u.avatar_seed, u.avatar_url, u.avatar_animal, u.avatar_color, ss.saved_at
       FROM session_savers ss
       JOIN users u ON u.id = ss.user_id
      WHERE ss.session_id = $1
      ORDER BY ss.saved_at ASC`,
    [sessionId],
  );

  res.json({
    ok: true,
    sessionId,
    participants: rows.rows.map((item) => ({
      id: item.id,
      name: item.name ?? '',
      email: item.email ?? '',
      avatarSeed: item.avatar_seed ?? '',
      avatarUrl: item.avatar_url ?? null,
      avatarAnimal: Number.isFinite(item.avatar_animal) ? item.avatar_animal : null,
      avatarColor: Number.isFinite(item.avatar_color) ? item.avatar_color : null,
      savedAt: item.saved_at ?? null,
    })),
  });
});

const MCP_VIEW_ACTIONS = new Set(['focus_node', 'zoom_to_cards', 'zoom_to_graph', 'zoom_to_fit', 'pan']);

app.post('/api/integrations/mcp/view', async (req, res) => {
  const headerToken = getBearerToken(req);
  const bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const rawToken = headerToken || bodyToken;
  if (!rawToken) return res.status(400).json({ error: 'token_required' });

  const info = await resolveMcpTokenInfo(rawToken);
  if (info?.error === 'invalid') return res.status(401).json({ error: 'invalid_token' });
  if (info?.error === 'expired') return res.status(401).json({ error: 'token_expired' });
  const requestedTargetUserId = typeof req.body?.targetUserId === 'string' ? req.body.targetUserId.trim() : '';
  if (requestedTargetUserId && info?.kind !== 'tech') {
    return res.status(403).json({ error: 'target_user_forbidden' });
  }
  const infoUserId = info && typeof info.userId === 'string' ? info.userId : null;
  const userId = requestedTargetUserId || infoUserId;

  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!sessionId) return res.status(400).json({ error: 'session_id_required' });

  const action = typeof req.body?.action === 'string' ? req.body.action : '';
  if (!MCP_VIEW_ACTIONS.has(action)) return res.status(400).json({ error: 'bad_action' });

  const session = await getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  const allowTech = info?.kind === 'tech' && !requestedTargetUserId;
  const accessUserId = requestedTargetUserId || infoUserId;
  const accessOk = await ensureSessionAccessForUser({
    session,
    userId: accessUserId,
    allowTech,
  });
  if (!accessOk) return res.status(403).json({ error: 'forbidden' });

  const payload = {
    type: 'canvas_view',
    action,
    sessionId,
  };

  if (action === 'focus_node') {
    const nodeId = typeof req.body?.nodeId === 'string' ? req.body.nodeId.trim() : '';
    if (!nodeId) return res.status(400).json({ error: 'node_id_required' });
    payload.nodeId = nodeId;
  }
  if (action === 'pan') {
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return res.status(400).json({ error: 'coords_required' });
    payload.x = x;
    payload.y = y;
  }

  if (Number.isFinite(req.body?.scale)) {
    payload.scale = Number(req.body.scale);
  }

  const delivered = userId ? sendCanvasViewToUser(sessionId, userId, payload) : 0;
  console.log('[mcp-view]', JSON.stringify({
    action,
    sessionId,
    userId,
    targetUserId: requestedTargetUserId || null,
    delivered,
    nodeId: payload.nodeId ?? null,
    scale: payload.scale ?? null,
    x: Number.isFinite(payload.x) ? payload.x : null,
    y: Number.isFinite(payload.y) ? payload.y : null,
  }));
  res.json({ ok: true, delivered, sessionId });
});

app.post('/api/integrations/mcp/snapshot', async (req, res) => {
  const headerToken = getBearerToken(req);
  const bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const rawToken = headerToken || bodyToken;
  if (!rawToken) return res.status(400).json({ error: 'token_required' });

  const info = await resolveMcpTokenInfo(rawToken);
  if (info?.error === 'invalid') return res.status(401).json({ error: 'invalid_token' });
  if (info?.error === 'expired') return res.status(401).json({ error: 'token_expired' });
  const userId = info?.userId ?? null;

  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!sessionId) return res.status(400).json({ error: 'session_id_required' });

  const session = await getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  const allowTech = info?.kind === 'tech';
  const accessOk = await ensureSessionAccessForUser({
    session,
    userId,
    allowTech,
  });
  if (!accessOk) return res.status(403).json({ error: 'forbidden' });

  try {
    const rawTimeout = req.body?.timeoutMs;
    const timeoutMs = Number.isFinite(rawTimeout)
      ? Number(rawTimeout)
      : (typeof rawTimeout === 'string' && rawTimeout.trim() ? Number(rawTimeout) : undefined);
    if (!userId) return res.status(409).json({ error: 'client_not_connected' });
    const result = await requestCanvasSnapshot(sessionId, userId, { timeoutMs });
    res.json({
      ok: true,
      sessionId,
      image: {
        dataUrl: result.dataUrl ?? null,
        width: result.width ?? null,
        height: result.height ?? null,
      },
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (msg === 'snapshot_client_not_connected') return res.status(409).json({ error: 'client_not_connected' });
    if (msg === 'snapshot_timeout') return res.status(504).json({ error: 'snapshot_timeout' });
    res.status(500).json({ error: 'snapshot_failed' });
  }
});

app.post('/api/integrations/mcp/alert', async (req, res) => {
  const headerToken = getBearerToken(req);
  const bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const rawToken = headerToken || bodyToken;
  if (!rawToken) return res.status(400).json({ error: 'token_required' });

  const info = await resolveMcpTokenInfo(rawToken);
  if (info?.error === 'invalid') return res.status(401).json({ error: 'invalid_token' });
  if (info?.error === 'expired') return res.status(401).json({ error: 'token_expired' });

  const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!sessionId) return res.status(400).json({ error: 'session_id_required' });
  const session = await getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'session_not_found' });

  const userRef = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
  if (!userRef) return res.status(400).json({ error: 'user_id_required' });
  if (info?.kind !== 'tech' && userRef !== info?.userId) {
    return res.status(403).json({ error: 'user_forbidden' });
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'message_required' });

  const senderUserIdRaw = typeof req.body?.senderUserId === 'string' ? req.body.senderUserId.trim() : '';
  let senderUserId = null;
  if (senderUserIdRaw) {
    if (info?.kind === 'tech') {
      senderUserId = senderUserIdRaw;
    } else if (info?.userId && senderUserIdRaw === info.userId) {
      senderUserId = senderUserIdRaw;
    }
  }
  let senderUser = null;
  if (senderUserId) {
    senderUser = await getUserById(senderUserId);
    if (!senderUser) senderUserId = null;
  }

  const resolved = await resolveSessionParticipantId({ sessionId, userRef });
  if (resolved?.error === 'participant_ambiguous') {
    return res.status(409).json({ error: 'participant_ambiguous' });
  }
  if (!resolved?.userId) return res.status(404).json({ error: 'participant_not_found' });
  const userId = resolved.userId;

  const actor = senderUser
    ? { id: senderUser.id, name: senderUser.name }
    : (info?.user ? { id: info.user.id, name: info.user.name } : null);
  const result = await sendDirectAlertToUser({
    userId,
    sessionId,
    sessionName: session?.name ?? null,
    message,
    actor,
    senderUserId,
  });
  res.json({
    ok: true,
    sessionId,
    userId,
    delivered: result.delivered,
  });
});

app.get('/api/auth/providers', async (_req, res) => {
  res.json({
    email: true,
    google: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    yandex: !!(YANDEX_CLIENT_ID && YANDEX_CLIENT_SECRET),
    telegram: !!(TELEGRAM_AUTH_BOT_USERNAME && TELEGRAM_AUTH_BOT_TOKEN),
    telegramBotUsername: TELEGRAM_AUTH_BOT_USERNAME || null,
  });
});

app.post('/api/auth/logout', async (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/signup', authRateLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const name = String(req.body?.name ?? '').trim() || null;

  if (!email || !email.includes('@')) return res.status(400).json({ error: 'bad_email' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'bad_password' });

  const existing = await getUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'email_in_use' });

  const id = randomUUID();
  const avatarSeed = id;
  const passwordHash = await bcrypt.hash(password, 10);
  const created = await createUser({
    id,
    email,
    passwordHash,
    name: name ?? `User ${email.split('@')[0]}`,
    avatarSeed,
    verified: false,
  });

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await insertEmailVerificationToken({ tokenHash, userId: created.id, expiresAt });

  const verifyUrl = `${getBaseUrl(req)}/api/auth/verify?token=${encodeURIComponent(rawToken)}`;

  if (SMTP_URL) {
    const transport = nodemailer.createTransport(SMTP_URL);
    await transport.sendMail({
      from: MAIL_FROM,
      to: email,
      subject: 'Confirm your email',
      text: `Confirm your email: ${verifyUrl}`,
      html: `<p>Confirm your email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
    });
    res.json({ ok: true, sent: true });
    return;
  }

  res.json({ ok: true, sent: false, devVerifyUrl: verifyUrl });
});

app.get('/api/auth/verify', authRateLimiter, async (req, res) => {
  const token = String(req.query?.token ?? '');
  if (!token) return res.status(400).send('bad_request');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const row = await consumeEmailVerificationToken(tokenHash);
  if (!row) return res.status(404).send('invalid_token');
  const expiresAt = new Date(row.expires_at);
  if (Number.isFinite(expiresAt.valueOf()) && expiresAt.getTime() < Date.now()) return res.status(410).send('expired');

  await setUserVerified(row.user_id);
  const user = await getUserById(row.user_id);
  if (user) setAuthCookie(res, signAuthToken({ userId: user.id }));
  res.redirect(`${getBaseUrl(req)}/?verified=1`);
});

app.get('/api/auth/change-email', authRateLimiter, async (req, res) => {
  const token = String(req.query?.token ?? '');
  if (!token) return res.status(400).send('bad_request');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const row = await consumeEmailChangeToken(tokenHash);
  if (!row) return res.status(404).send('invalid_token');
  const expiresAt = new Date(row.expires_at);
  if (Number.isFinite(expiresAt.valueOf()) && expiresAt.getTime() < Date.now()) return res.status(410).send('expired');

  const nextEmail = String(row.new_email ?? '').trim().toLowerCase();
  if (!nextEmail || !nextEmail.includes('@')) return res.status(400).send('bad_email');
  const existing = await getUserByEmail(nextEmail);
  if (existing && existing.id !== row.user_id) return res.status(409).send('email_in_use');

  const updated = await updateUserProfile({ userId: row.user_id, email: nextEmail });
  if (!updated) return res.status(500).send('update_failed');
  await setUserVerified(row.user_id);
  setAuthCookie(res, signAuthToken({ userId: row.user_id }));
  res.redirect(`${getBaseUrl(req)}/?emailChanged=1`);
});

app.post('/api/auth/login', authRateLimiter, async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'bad_email' });
  if (!password) return res.status(400).json({ error: 'bad_password' });

  const user = await getUserByEmail(email);
  if (!user?.password_hash) return res.status(401).json({ error: 'invalid_credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
  if (!user.verified) return res.status(403).json({ error: 'email_not_verified' });

  setAuthCookie(res, signAuthToken({ userId: user.id }));
  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarSeed: user.avatar_seed,
      avatarUrl: user.avatar_url,
      avatarAnimal: user.avatar_animal,
      avatarColor: user.avatar_color,
      verified: user.verified,
    },
  });
});

app.get('/api/auth/google/start', async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.status(501).json({ error: 'google_not_configured' });
  const base = getBaseUrl(req);
  const redirectUri = `${base}/api/auth/google/callback`;
  const returnTo = sanitizeReturnTo(req.query?.returnTo);
  const state = randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' });
  res.cookie('oauth_return_to', returnTo, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  res.redirect(url.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.status(501).send('google_not_configured');
  const base = getBaseUrl(req);
  const redirectUri = `${base}/api/auth/google/callback`;
  const code = typeof req.query?.code === 'string' ? req.query.code : null;
  const state = typeof req.query?.state === 'string' ? req.query.state : null;
  const expectedState = req.cookies?.oauth_state;
  const returnTo = req.cookies?.oauth_return_to ?? '/';
  res.clearCookie('oauth_state', { path: '/' });
  res.clearCookie('oauth_return_to', { path: '/' });
  if (!code || !state || !expectedState || state !== expectedState) return res.status(400).send('bad_oauth_state');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return res.status(502).send('token_exchange_failed');
  const tokens = await tokenRes.json();
  const accessToken = tokens?.access_token;
  if (!accessToken) return res.status(502).send('no_access_token');

  const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!infoRes.ok) return res.status(502).send('userinfo_failed');
  const info = await infoRes.json();
  const email = String(info?.email ?? '').trim().toLowerCase();
  const providerAccountId = String(info?.id ?? '');
  const name = String(info?.name ?? '').trim();
  if (!email || !providerAccountId) return res.status(502).send('bad_userinfo');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_account_id = $2',
      ['google', providerAccountId],
    );
    let userId = existing.rows[0]?.user_id ?? null;
    if (!userId) {
      const userByEmail = await client.query('SELECT id FROM users WHERE email = $1', [email]);
      userId = userByEmail.rows[0]?.id ?? null;
    }
    if (!userId) {
      userId = randomUUID();
      await client.query(
        `INSERT INTO users (id, email, password_hash, name, avatar_seed, verified)
         VALUES ($1, $2, NULL, $3, $4, TRUE)`,
        [userId, email, name || `User ${email.split('@')[0]}`, userId],
      );
    } else {
      await client.query('UPDATE users SET verified = TRUE, updated_at = NOW() WHERE id = $1', [userId]);
    }
    await client.query(
      `INSERT INTO oauth_accounts (provider, provider_account_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider, provider_account_id) DO NOTHING`,
      ['google', providerAccountId, userId],
    );
    await client.query('COMMIT');
    setAuthCookie(res, signAuthToken({ userId }));
    res.redirect(returnTo);
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(500).send('oauth_failed');
  } finally {
    client.release();
  }
});

app.get('/api/auth/yandex/start', async (req, res) => {
  if (!YANDEX_CLIENT_ID || !YANDEX_CLIENT_SECRET) return res.status(501).json({ error: 'yandex_not_configured' });
  const base = getBaseUrl(req);
  const redirectUri = `${base}/api/auth/yandex/callback`;
  const returnTo = sanitizeReturnTo(req.query?.returnTo);
  const state = randomBytes(16).toString('hex');
  res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' });
  res.cookie('oauth_return_to', returnTo, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' });

  const url = new URL('https://oauth.yandex.com/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', YANDEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/api/auth/yandex/callback', async (req, res) => {
  if (!YANDEX_CLIENT_ID || !YANDEX_CLIENT_SECRET) return res.status(501).send('yandex_not_configured');
  const base = getBaseUrl(req);
  const redirectUri = `${base}/api/auth/yandex/callback`;
  const code = typeof req.query?.code === 'string' ? req.query.code : null;
  const state = typeof req.query?.state === 'string' ? req.query.state : null;
  const expectedState = req.cookies?.oauth_state;
  const returnTo = req.cookies?.oauth_return_to ?? '/';
  res.clearCookie('oauth_state', { path: '/' });
  res.clearCookie('oauth_return_to', { path: '/' });
  if (!code || !state || !expectedState || state !== expectedState) return res.status(400).send('bad_oauth_state');

  const tokenRes = await fetch('https://oauth.yandex.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: YANDEX_CLIENT_ID,
      client_secret: YANDEX_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) return res.status(502).send('token_exchange_failed');
  const tokens = await tokenRes.json();
  const accessToken = tokens?.access_token;
  if (!accessToken) return res.status(502).send('no_access_token');

  const infoRes = await fetch('https://login.yandex.ru/info?format=json', {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!infoRes.ok) return res.status(502).send('userinfo_failed');
  const info = await infoRes.json();
  const email = String(info?.default_email ?? '').trim().toLowerCase();
  const providerAccountId = String(info?.id ?? '');
  const name = String(info?.real_name ?? info?.display_name ?? '').trim();
  if (!email || !providerAccountId) return res.status(502).send('bad_userinfo');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_account_id = $2',
      ['yandex', providerAccountId],
    );
    let userId = existing.rows[0]?.user_id ?? null;
    if (!userId) {
      const userByEmail = await client.query('SELECT id FROM users WHERE email = $1', [email]);
      userId = userByEmail.rows[0]?.id ?? null;
    }
    if (!userId) {
      userId = randomUUID();
      await client.query(
        `INSERT INTO users (id, email, password_hash, name, avatar_seed, verified)
         VALUES ($1, $2, NULL, $3, $4, TRUE)`,
        [userId, email, name || `User ${email.split('@')[0]}`, userId],
      );
    } else {
      await client.query('UPDATE users SET verified = TRUE, updated_at = NOW() WHERE id = $1', [userId]);
    }
    await client.query(
      `INSERT INTO oauth_accounts (provider, provider_account_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider, provider_account_id) DO NOTHING`,
      ['yandex', providerAccountId, userId],
    );
    await client.query('COMMIT');
    setAuthCookie(res, signAuthToken({ userId }));
    res.redirect(returnTo);
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(500).send('oauth_failed');
  } finally {
    client.release();
  }
});

const parseTelegramAuthPayload = (query, botToken) => {
  const q = query ?? {};
  if (!botToken) return { error: 'telegram_not_configured' };
  const hash = typeof q.hash === 'string' ? q.hash : null;
  const id = typeof q.id === 'string' ? q.id : null;
  const authDateStr = typeof q.auth_date === 'string' ? q.auth_date : null;
  if (!hash || !id || !authDateStr) return { error: 'bad_request' };

  const authDate = Number(authDateStr);
  if (!Number.isFinite(authDate)) return { error: 'bad_request' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - authDate) > 60 * 60 * 24) return { error: 'auth_date_too_old' };

  const allowed = new Set(['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date']);
  const entries = Object.entries(q)
    .filter(([k]) => k !== 'hash' && allowed.has(k))
    .map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => [k, String(v)]);

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = createHash('sha256').update(botToken).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash.toLowerCase()) return { error: 'invalid_hash' };

  return {
    data: {
      id,
      firstName: typeof q.first_name === 'string' ? q.first_name : '',
      lastName: typeof q.last_name === 'string' ? q.last_name : '',
      username: typeof q.username === 'string' ? q.username : '',
    },
  };
};

const renderTelegramWidgetPage = ({
  title,
  hint,
  callbackUrl,
  returnTo,
  botUsername,
}) => `<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0f18; color:#e6e6e6; }
  .wrap { min-height:100vh; display:grid; place-items:center; padding:24px; }
  .card { max-width:520px; width:100%; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); border-radius:16px; padding:18px; }
  .title { font-weight:600; margin-bottom:10px; }
  .hint { font-size:12px; opacity:.75; margin-top:10px; }
</style>
</head><body>
<div class="wrap"><div class="card">
  <div class="title">${title}</div>
  <div class="hint" id="hint">${hint}</div>
  <script async src="https://telegram.org/js/telegram-widget.js?22"
    data-telegram-login="${String(botUsername)}"
    data-size="large"
    data-radius="12"
    data-userpic="false"
    data-onauth="onTelegramAuth(user)">
  </script>
  <script>
    const CALLBACK_URL = ${JSON.stringify(callbackUrl)};
    const RETURN_TO = ${JSON.stringify(returnTo)};
    function onTelegramAuth(user) {
      try {
        const hint = document.getElementById('hint');
        if (hint) hint.textContent = 'Готово, возвращаемся…';
        const params = new URLSearchParams();
        if (user && typeof user === 'object') {
          for (const [k, v] of Object.entries(user)) {
            if (v === undefined || v === null) continue;
            params.set(k, String(v));
          }
        }
        params.set('returnTo', RETURN_TO);
        window.location.href = CALLBACK_URL + '?' + params.toString();
      } catch (e) {
        window.location.href = CALLBACK_URL;
      }
    }
  </script>
</div></div>
</body></html>`;

app.get('/api/integrations/telegram/start', async (req, res) => {
  if (!TELEGRAM_ALERT_BOT_USERNAME || !TELEGRAM_ALERT_BOT_TOKEN) return res.status(501).json({ error: 'telegram_not_configured' });
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).send('unauthorized');

  const returnTo = sanitizeReturnTo(req.query?.returnTo);
  res.cookie('telegram_link_return_to', returnTo, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' });
  const callbackUrl = `${getBaseUrl(req)}/api/integrations/telegram/callback`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderTelegramWidgetPage({
    title: 'Подключение Telegram',
    hint: 'Подтвердите подключение…',
    callbackUrl,
    returnTo,
    botUsername: TELEGRAM_ALERT_BOT_USERNAME,
  }));
});

app.get('/api/integrations/telegram/callback', async (req, res) => {
  if (!TELEGRAM_ALERT_BOT_USERNAME || !TELEGRAM_ALERT_BOT_TOKEN) return res.status(501).send('telegram_not_configured');
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).send('unauthorized');
  const returnTo = req.cookies?.telegram_link_return_to ?? sanitizeReturnTo(req.query?.returnTo) ?? '/';
  res.clearCookie('telegram_link_return_to', { path: '/' });

  const parsed = parseTelegramAuthPayload(req.query, TELEGRAM_ALERT_BOT_TOKEN);
  if (parsed.error === 'invalid_hash') return res.status(401).send('invalid_hash');
  if (parsed.error) return res.status(400).send(parsed.error);
  const providerAccountId = parsed.data.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_account_id = $2',
      ['telegram', providerAccountId],
    );
    const linkedUserId = existing.rows[0]?.user_id ?? null;
    if (linkedUserId && linkedUserId !== auth.userId) {
      await client.query('ROLLBACK');
      return res.status(409).send('telegram_already_linked');
    }

    await client.query('DELETE FROM oauth_accounts WHERE provider = $1 AND user_id = $2', ['telegram', auth.userId]);
    await client.query(
      `INSERT INTO oauth_accounts (provider, provider_account_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider, provider_account_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
      ['telegram', providerAccountId, auth.userId],
    );
    await client.query('COMMIT');
    res.redirect(sanitizeReturnTo(returnTo));
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(500).send('telegram_link_failed');
  } finally {
    client.release();
  }
});

app.get('/api/auth/telegram/start', async (req, res) => {
  if (!TELEGRAM_AUTH_BOT_USERNAME || !TELEGRAM_AUTH_BOT_TOKEN) return res.status(501).json({ error: 'telegram_not_configured' });
  const returnTo = sanitizeReturnTo(req.query?.returnTo);
  res.cookie('oauth_return_to', returnTo, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' });
  const callbackUrl = `${getBaseUrl(req)}/api/auth/telegram/callback`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(renderTelegramWidgetPage({
    title: 'Вход через Telegram',
    hint: 'Ожидание входа…',
    callbackUrl,
    returnTo,
    botUsername: TELEGRAM_AUTH_BOT_USERNAME,
  }));
});

app.get('/api/auth/telegram/callback', async (req, res) => {
  if (!TELEGRAM_AUTH_BOT_USERNAME || !TELEGRAM_AUTH_BOT_TOKEN) return res.status(501).send('telegram_not_configured');
  const returnTo = req.cookies?.oauth_return_to ?? sanitizeReturnTo(req.query?.returnTo) ?? '/';
  res.clearCookie('oauth_return_to', { path: '/' });

  const parsed = parseTelegramAuthPayload(req.query, TELEGRAM_AUTH_BOT_TOKEN);
  if (parsed.error === 'invalid_hash') return res.status(401).send('invalid_hash');
  if (parsed.error) return res.status(400).send(parsed.error);

  const { id, firstName, lastName, username } = parsed.data;
  const name = [firstName, lastName].filter(Boolean).join(' ').trim() || (username ? `@${username}` : `Telegram ${id}`);

  const providerAccountId = id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_account_id = $2',
      ['telegram', providerAccountId],
    );
    let userId = existing.rows[0]?.user_id ?? null;
    if (!userId) {
      userId = randomUUID();
      await client.query(
        `INSERT INTO users (id, email, password_hash, name, avatar_seed, verified)
         VALUES ($1, NULL, NULL, $2, $3, TRUE)`,
        [userId, name, `telegram:${providerAccountId}`],
      );
      await client.query(
        `INSERT INTO oauth_accounts (provider, provider_account_id, user_id)
         VALUES ($1, $2, $3)`,
        ['telegram', providerAccountId, userId],
      );
    } else {
      await client.query('UPDATE users SET verified = TRUE, updated_at = NOW() WHERE id = $1', [userId]);
    }
    await client.query('COMMIT');
    setAuthCookie(res, signAuthToken({ userId }));
    res.redirect(sanitizeReturnTo(returnTo));
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(500).send('oauth_failed');
  } finally {
    client.release();
  }
});

app.post('/api/sessions', async (req, res) => {
  const state = normalizeState(req.body?.state);
  const id = randomUUID();
  const created = await createSession(id, state);
  res.status(201).json(serializeSession(created));
});

app.get('/api/sessions/mine', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const rows = await pool.query(
    `SELECT s.id, s.name, s.saved_at, s.updated_at
       FROM sessions s
       JOIN session_savers ss ON ss.session_id = s.id
      WHERE ss.user_id = $1
      ORDER BY s.updated_at DESC`,
    [auth.userId],
  );
  res.json({
    sessions: rows.rows.map((row) => ({
      id: row.id,
      name: row.name ?? null,
      savedAt: row.saved_at ?? null,
      updatedAt: row.updated_at ?? null,
    })),
  });
});

// Fast server-side clone: avoids uploading large session state from the client.
app.post('/api/sessions/:id/clone', async (req, res) => {
  const auth = authUserFromRequest(req);
  const access = await resolveSessionAccess({ sessionId: req.params.id, auth });
  if (access.error === 'unauthorized') return res.status(401).json({ error: 'unauthorized' });
  if (access.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (access.error === 'not_found') return res.status(404).json({ error: 'not_found' });
  const source = access.session;
  const id = randomUUID();
  const created = await createSession(id, normalizeState(source.state));
  res.status(201).json(serializeSession(created));
});

app.get('/api/sessions/:id', async (req, res) => {
  const access = await resolveSessionAccessFromRequest({ sessionId: req.params.id, req });
  if (access.error === 'unauthorized') return res.status(401).json({ error: 'unauthorized' });
  if (access.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (access.error === 'not_found') return res.status(404).json({ error: 'not_found' });
  res.json(serializeSession(access.session));
});

app.post('/api/attachments', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });

  let sessionId = typeof req.query?.sessionId === 'string' ? req.query.sessionId.trim() : '';
  const tmpDir = path.join(ATTACHMENTS_DIR, 'tmp');
  await ensureDir(tmpDir);

  let fileMeta = null;
  let uploadError = null;
  let writePromise = null;

  try {
    await new Promise((resolve, reject) => {
      const bb = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: ATTACHMENTS_MAX_BYTES },
      });

      bb.on('field', (name, value) => {
        if (name === 'sessionId' && !sessionId) {
          sessionId = String(value ?? '').trim();
        }
      });

      bb.on('file', (name, file, info) => {
        if (name !== 'file') {
          file.resume();
          return;
        }
        if (fileMeta) {
          file.resume();
          return;
        }
        const filename = sanitizeFilename(info?.filename || 'attachment');
        const mime = info?.mimeType || 'application/octet-stream';
        const tmpId = randomUUID();
        const tmpPath = path.join(tmpDir, `${tmpId}.upload`);
        const writeStream = fs.createWriteStream(tmpPath);
        let size = 0;

        writePromise = new Promise((resolveWrite, rejectWrite) => {
          writeStream.on('finish', resolveWrite);
          writeStream.on('error', rejectWrite);
        });

        file.on('data', (chunk) => {
          size += chunk.length;
        });
        file.on('limit', () => {
          uploadError = 'file_too_large';
          file.unpipe(writeStream);
          writeStream.destroy();
        });
        file.on('error', () => {
          uploadError = 'file_stream_failed';
        });
        writeStream.on('error', () => {
          uploadError = 'file_write_failed';
        });
        file.on('end', () => {
          fileMeta = { filename, mime, size, tmpPath };
        });

        file.pipe(writeStream);
      });

      bb.on('error', reject);
      bb.on('finish', resolve);
      req.pipe(bb);
    });
  } catch {
    return res.status(400).json({ error: 'upload_failed' });
  }

  try {
    if (writePromise) await writePromise;
  } catch {
    uploadError = uploadError ?? 'file_write_failed';
  }

  if (uploadError === 'file_too_large') {
    await safeUnlink(fileMeta?.tmpPath);
    return res.status(413).json({ error: 'file_too_large' });
  }

  if (uploadError) {
    await safeUnlink(fileMeta?.tmpPath);
    return res.status(400).json({ error: uploadError });
  }

  if (!fileMeta) {
    return res.status(400).json({ error: 'file_required' });
  }
  if (!sessionId) {
    await safeUnlink(fileMeta.tmpPath);
    return res.status(400).json({ error: 'session_id_required' });
  }

  const access = await resolveSessionAccess({ sessionId, auth });
  if (access.error === 'unauthorized') {
    await safeUnlink(fileMeta.tmpPath);
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (access.error === 'forbidden') {
    await safeUnlink(fileMeta.tmpPath);
    return res.status(403).json({ error: 'forbidden' });
  }
  if (access.error === 'not_found') {
    await safeUnlink(fileMeta.tmpPath);
    return res.status(404).json({ error: 'not_found' });
  }

  await ensureDir(ATTACHMENTS_DIR);
  const id = randomUUID();
  const storageName = buildStorageName(id, fileMeta.filename);
  const finalPath = path.join(ATTACHMENTS_DIR, storageName);
  try {
    await fs.promises.rename(fileMeta.tmpPath, finalPath);
  } catch {
    await safeUnlink(fileMeta.tmpPath);
    return res.status(500).json({ error: 'storage_failed' });
  }

  const row = await createAttachment({
    id,
    sessionId,
    userId: auth.userId,
    name: fileMeta.filename,
    mime: fileMeta.mime,
    size: fileMeta.size,
    storagePath: storageName,
  });
  if (!row) return res.status(500).json({ error: 'storage_failed' });

  res.status(201).json({
    id: row.id,
    url: `/api/attachments/${row.id}`,
    name: row.name,
    size: row.size,
    mime: row.mime,
  });
});

app.get('/api/attachments/:id', async (req, res) => {
  const auth = authUserFromRequest(req);
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'bad_request' });

  const attachment = await getAttachmentById(id);
  if (!attachment) return res.status(404).json({ error: 'not_found' });

  const access = await resolveSessionAccess({ sessionId: attachment.session_id, auth });
  if (access.error === 'unauthorized') return res.status(401).json({ error: 'unauthorized' });
  if (access.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (access.error === 'not_found') return res.status(404).json({ error: 'not_found' });

  const filePath = path.join(ATTACHMENTS_DIR, attachment.storage_path);
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    return res.status(404).json({ error: 'not_found' });
  }

  const safeName = (attachment.name || 'attachment').replace(/"/g, '');
  const encoded = encodeURIComponent(safeName);
  res.setHeader('Content-Type', attachment.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"; filename*=UTF-8''${encoded}`);
  res.sendFile(filePath);
});

app.get('/api/sessions/:id/savers', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const sessionId = req.params.id;
  const access = await resolveSessionAccess({ sessionId, auth });
  if (access.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (access.error === 'not_found') return res.status(404).json({ error: 'not_found' });
  const rows = await pool.query(
    `SELECT u.id, u.name, u.email, u.avatar_seed, u.avatar_url, u.avatar_animal, u.avatar_color, ss.saved_at
       FROM session_savers ss
       JOIN users u ON u.id = ss.user_id
      WHERE ss.session_id = $1
      ORDER BY ss.saved_at ASC`,
    [sessionId],
  );
  res.json({
    savers: rows.rows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      email: row.email ?? '',
      avatarSeed: row.avatar_seed ?? '',
      avatarUrl: row.avatar_url ?? null,
      avatarAnimal: Number.isFinite(row.avatar_animal) ? row.avatar_animal : null,
      avatarColor: Number.isFinite(row.avatar_color) ? row.avatar_color : null,
      savedAt: row.saved_at ?? null,
    })),
  });
});

app.put('/api/sessions/:id', async (req, res) => {
  const auth = authUserFromRequest(req);
  const access = await resolveSessionAccess({ sessionId: req.params.id, auth });
  if (access.error === 'unauthorized') return res.status(401).json({ error: 'unauthorized' });
  if (access.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (access.error === 'not_found') return res.status(404).json({ error: 'not_found' });
  const state = req.body?.state;
  if (!state) return res.status(400).json({ error: 'bad_request' });
  const result = await mergeAndUpdateSession(req.params.id, state);
  if (!result?.updated) return res.status(404).json({ error: 'not_found' });
  res.json(serializeSession(result.updated));
  void (async () => {
    try {
      const actorUser = auth?.userId ? await getUserById(auth.userId) : null;
      const actor = actorUser ? { id: actorUser.id, name: actorUser.name ?? null } : null;
      const alerts = await buildSessionAlertEvents({
        sessionId: req.params.id,
        sessionName: result.updated?.name ?? null,
        prevState: result.previous,
        nextState: result.updated?.state,
        actor,
      });
      await dispatchAlertEvents(alerts);
    } catch (err) {
      console.warn('[alerting] session update failed', err?.message ?? err);
    }
  })();
});

app.delete('/api/sessions/:id', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const sessionId = req.params.id;
  const defaultId = await getSetting('default_session_id');
  if (defaultId && defaultId === sessionId) return res.status(409).json({ error: 'cannot_delete_default' });

  const existing = await pool.query('SELECT owner_id FROM sessions WHERE id = $1', [sessionId]);
  const row = existing.rows[0];
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (!row.owner_id || row.owner_id !== auth.userId) return res.status(403).json({ error: 'forbidden' });

  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/save', async (req, res) => {
  const auth = authUserFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'unauthorized' });
  const access = await resolveSessionAccess({ sessionId: req.params.id, auth });
  if (access.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (access.error === 'not_found') return res.status(404).json({ error: 'not_found' });
  const rawName = String(req.body?.name ?? '').trim();
  const incomingName = rawName ? rawName.slice(0, 120) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, name, owner_id, saved_at, expires_at FROM sessions WHERE id = $1 AND (expires_at IS NULL OR expires_at > NOW()) FOR UPDATE',
      [req.params.id],
    );
    const row = existing.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    const canRename = !row.owner_id || row.owner_id === auth.userId;
    if (!row.name && !incomingName) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'name_required' });
    }
    if (!canRename && !row.name) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!canRename && incomingName && row.name && incomingName !== row.name) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'forbidden' });
    }
    const nextName = canRename && incomingName ? incomingName : (row.name ?? incomingName);
    const nextOwnerId = row.owner_id ?? auth.userId;
    const updated = await client.query(
      `UPDATE sessions
         SET name = $1, owner_id = $2, saved_at = COALESCE(saved_at, NOW()), expires_at = NULL, updated_at = NOW()
       WHERE id = $3
       RETURNING id, state, version, name, owner_id, saved_at, expires_at`,
      [nextName, nextOwnerId, req.params.id],
    );
    await client.query(
      `INSERT INTO session_savers (session_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (session_id, user_id) DO UPDATE SET saved_at = NOW()`,
      [req.params.id, auth.userId],
    );
    await client.query('COMMIT');
    const payload = serializeSession(updated.rows[0]);
    if (payload?.meta) {
      broadcast(req.params.id, { type: 'session_meta', meta: payload.meta });
    }
    res.json(payload);
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    res.status(500).json({ error: 'save_failed' });
  } finally {
    client.release();
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();
const snapshotRequests = new Map();

function updatePresenceMetrics() {
  if (!metrics.enabled) return;
  if (activeSessionsGauge) {
    activeSessionsGauge.set(rooms.size);
  }
  if (activeUsersGauge) {
    const userIds = new Set();
    for (const clients of rooms.values()) {
      for (const ws of clients) {
        const meta = ws._meta;
        if (meta?.userId) userIds.add(meta.userId);
      }
    }
    activeUsersGauge.set(userIds.size);
  }
}
updatePresenceMetrics();

const ENTITY_COUNT_QUERIES = [
  { entity: 'users', sql: 'SELECT COUNT(*)::int AS count FROM users' },
  { entity: 'sessions', sql: 'SELECT COUNT(*)::int AS count FROM sessions' },
  { entity: 'session_savers', sql: 'SELECT COUNT(*)::int AS count FROM session_savers' },
  { entity: 'oauth_accounts', sql: 'SELECT COUNT(*)::int AS count FROM oauth_accounts' },
  { entity: 'alerting_settings', sql: 'SELECT COUNT(*)::int AS count FROM alerting_settings' },
  { entity: 'telegram_alert_links', sql: 'SELECT COUNT(*)::int AS count FROM telegram_alert_links' },
  { entity: 'openai_keys', sql: 'SELECT COUNT(*)::int AS count FROM openai_keys' },
  { entity: 'mcp_tokens', sql: 'SELECT COUNT(*)::int AS count FROM mcp_tokens' },
  { entity: 'assistant_threads', sql: 'SELECT COUNT(*)::int AS count FROM assistant_threads' },
  { entity: 'assistant_messages', sql: 'SELECT COUNT(*)::int AS count FROM assistant_messages' },
  { entity: 'assistant_summaries', sql: 'SELECT COUNT(*)::int AS count FROM assistant_summaries' },
  { entity: 'assistant_contexts', sql: 'SELECT COUNT(*)::int AS count FROM assistant_contexts' },
  { entity: 'assistant_memories', sql: 'SELECT COUNT(*)::int AS count FROM assistant_memories' },
  { entity: 'attachments', sql: 'SELECT COUNT(*)::int AS count FROM attachments' },
];

const normalizeIntervalMs = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
};

async function refreshEntityCounts() {
  if (!entityCountGauge) return;
  for (const entry of ENTITY_COUNT_QUERIES) {
    try {
      const res = await pool.query(entry.sql);
      const count = Number(res.rows?.[0]?.count ?? 0);
      entityCountGauge.set({ entity: entry.entity }, Number.isFinite(count) ? count : 0);
    } catch (err) {
      entityCountGauge.set({ entity: entry.entity }, 0);
      logger.warn({ entity: entry.entity, error: err?.message ?? String(err) }, 'entity_count_failed');
    }
  }
}

function roomFor(sessionId) {
  let set = rooms.get(sessionId);
  if (!set) {
    set = new Set();
    rooms.set(sessionId, set);
  }
  return set;
}

function broadcast(sessionId, message) {
  const data = JSON.stringify(message);
  const clients = roomFor(sessionId);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function sendToUser(sessionId, userId, message, logTag) {
  const clients = rooms.get(sessionId);
  if (!clients) return 0;
  const data = JSON.stringify(message);
  let delivered = 0;
  const connectedUserIds = [];
  for (const ws of clients) {
    const meta = ws._meta;
    if (!meta || meta.userId !== userId) continue;
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(data);
    delivered += 1;
  }
  if (delivered === 0) {
    for (const ws of clients) {
      const meta = ws._meta;
      if (!meta) continue;
      connectedUserIds.push(meta.userId ?? null);
    }
    const tag = typeof logTag === 'string' && logTag ? logTag : 'ws-send';
    console.log(`[${tag}]`, JSON.stringify({
      action: message?.action ?? null,
      sessionId,
      userId,
      delivered,
      connectedUsers: connectedUserIds,
    }));
  }
  return delivered;
}

function sendCanvasViewToUser(sessionId, userId, message) {
  return sendToUser(sessionId, userId, message, 'mcp-view');
}

function sendSnapshotRequestToUser(sessionId, userId, message) {
  return sendToUser(sessionId, userId, message, 'mcp-snapshot');
}

function sendAssistantUpdateToUser({ sessionId, userId, threadId, message, context }) {
  if (!sessionId || !userId || !message) return 0;
  return sendToUser(sessionId, userId, {
    type: 'assistant_update',
    threadId: threadId ?? null,
    message,
    context: context ?? null,
  }, 'assistant-update');
}

function sendAssistantStatusToUser({ sessionId, userId, threadId, status, reason }) {
  if (!sessionId || !userId || !status) return 0;
  return sendToUser(sessionId, userId, {
    type: 'assistant_status',
    threadId: threadId ?? null,
    status,
    reason: reason ?? null,
  }, 'assistant-status');
}

function requestCanvasSnapshot(sessionId, userId, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1000, Math.min(30000, Number(options.timeoutMs)))
    : MCP_SNAPSHOT_TIMEOUT_MS;
  const requestId = randomUUID();
  const delivered = sendSnapshotRequestToUser(sessionId, userId, {
    type: 'canvas_snapshot_request',
    requestId,
    sessionId,
  });
  if (!delivered) {
    throw new Error('snapshot_client_not_connected');
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      snapshotRequests.delete(requestId);
      reject(new Error('snapshot_timeout'));
    }, timeoutMs);
    snapshotRequests.set(requestId, {
      resolve,
      reject,
      sessionId,
      userId,
      timer,
    });
  });
}

function resolveSnapshotResponse(ws, message) {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : null;
  if (!requestId) return;
  const entry = snapshotRequests.get(requestId);
  if (!entry) return;
  const meta = ws?._meta;
  if (!meta || meta.userId !== entry.userId || meta.sessionId !== entry.sessionId) return;
  clearTimeout(entry.timer);
  snapshotRequests.delete(requestId);
  const error = typeof message?.error === 'string' ? message.error : null;
  if (error) {
    entry.reject(new Error(error));
    return;
  }
  const dataUrl = typeof message?.dataUrl === 'string' ? message.dataUrl : null;
  const width = Number.isFinite(message?.width) ? Number(message.width) : null;
  const height = Number.isFinite(message?.height) ? Number(message.height) : null;
  entry.resolve({ requestId, dataUrl, width, height });
}
function authUserFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  try {
    const parsed = cookie.parse(cookieHeader);
    const token = parsed?.[COOKIE_NAME];
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = typeof payload?.userId === 'string' ? payload.userId : null;
    return userId ? { userId } : null;
  } catch {
    return null;
  }
}

function getMcpTokenFromWsRequest(req, url) {
  const headerToken = getBearerToken(req);
  if (headerToken) return headerToken;
  const queryToken = url?.searchParams?.get('mcpToken') || url?.searchParams?.get('token');
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();
  return null;
}

function guestNameFromClientId(clientId) {
  if (!clientId || typeof clientId !== 'string') return 'Guest';
  return `Guest ${clientId.slice(0, 4)}`;
}

function sendPresence(sessionId) {
  const clients = roomFor(sessionId);
  const peers = [];
  const registeredMap = new Map();
  for (const ws of clients) {
    const meta = ws._meta;
    if (!meta) continue;
    if (meta.userId) {
      if (!registeredMap.has(meta.userId)) {
        registeredMap.set(meta.userId, {
          id: meta.userId,
          name: meta.name,
          avatarSeed: meta.avatarSeed,
          avatarUrl: meta.avatarUrl,
          avatarAnimal: meta.avatarAnimal,
          avatarColor: meta.avatarColor,
          registered: true,
        });
      }
      continue;
    }
    peers.push({
      id: meta.connId,
      name: meta.name,
      avatarSeed: meta.avatarSeed,
      avatarUrl: meta.avatarUrl,
      avatarAnimal: meta.avatarAnimal,
      avatarColor: meta.avatarColor,
      registered: false,
    });
  }
  const registeredPeers = Array.from(registeredMap.values());
  const peerList = registeredPeers.concat(peers);

  for (const ws of clients) {
    const meta = ws._meta;
    if (!meta) continue;
    if (ws.readyState !== ws.OPEN) continue;
    const selfId = meta.userId || meta.connId;
    ws.send(JSON.stringify({ type: 'presence', selfId, peers: peerList }));
  }
}

wss.on('connection', async (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  const clientId = url.searchParams.get('clientId');
  const mcpToken = getMcpTokenFromWsRequest(req, url);
  let mcpInfo = null;
  if (mcpToken) {
    const info = await resolveMcpTokenInfo(mcpToken);
    if (info && !info?.error) mcpInfo = info;
  }
  if (!sessionId) {
    ws.close(1008, 'sessionId_required');
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    ws.close(1008, 'session_not_found');
    return;
  }

  const connId = randomUUID();
  const auth = authUserFromCookieHeader(req.headers.cookie);
  if (isSessionRestricted(session)) {
    if (auth?.userId) {
      const member = await isSessionMember(sessionId, auth.userId, session.owner_id);
      if (!member) {
        ws.close(1008, 'forbidden');
        return;
      }
    } else if (mcpInfo) {
      const accessOk = await ensureSessionAccessForUser({
        session,
        userId: mcpInfo.userId ?? null,
        allowTech: mcpInfo.kind === 'tech',
      });
      if (!accessOk) {
        ws.close(1008, 'forbidden');
        return;
      }
    } else {
      ws.close(1008, 'unauthorized');
      return;
    }
  }
  let user = null;
  let userId = auth?.userId ?? null;
  let usingMcpUser = false;
  if (!userId && mcpInfo?.user) {
    user = mcpInfo.user;
    userId = mcpInfo.user.id ?? null;
    usingMcpUser = true;
  }
  if (userId && !usingMcpUser) {
    try {
      user = await getUserById(userId);
    } catch {
      user = null;
    }
  }

  const name = user?.name ?? guestNameFromClientId(clientId);
  const avatarSeed = user?.avatar_seed ?? user?.avatarSeed ?? (clientId || connId);
  const avatarUrl = user?.avatar_url ?? user?.avatarUrl ?? null;
  const avatarAnimal = user?.avatar_animal ?? user?.avatarAnimal ?? null;
  const avatarColor = user?.avatar_color ?? user?.avatarColor ?? null;
  ws._meta = { sessionId, connId, clientId, userId, name, avatarSeed, avatarUrl, avatarAnimal, avatarColor };
  logger.info({ sessionId, userId: user?.id ?? null, clientId, connId }, 'ws_connect');

  roomFor(sessionId).add(ws);
  metrics.wsConnections?.inc();
  updatePresenceMetrics();
  const payload = serializeSession(session);
  ws.send(JSON.stringify({ type: 'sync', ...payload }));
  sendPresence(sessionId);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg?.type === 'canvas_snapshot_response') {
      resolveSnapshotResponse(ws, msg);
      return;
    }

    if (msg?.type !== 'update') return;
    const clientId = typeof msg?.clientId === 'string' ? msg.clientId : null;
    const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
    const state = msg?.state;
    if (!state) return;

    const result = await mergeAndUpdateSession(sessionId, state);
    if (!result?.updated) return;
    const payload = serializeSession(result.updated);
    broadcast(sessionId, { type: 'update', ...payload, sourceClientId: clientId, requestId });

    const actorMeta = ws._meta;
    const actor = actorMeta?.userId ? { id: actorMeta.userId, name: actorMeta.name ?? null } : null;
    void (async () => {
      try {
        const alerts = await buildSessionAlertEvents({
          sessionId,
          sessionName: result.updated?.name ?? null,
          prevState: result.previous,
          nextState: result.updated?.state,
          actor,
        });
        await dispatchAlertEvents(alerts);
      } catch (err) {
        console.warn('[alerting] ws update failed', err?.message ?? err);
      }
    })();
  });

  ws.on('close', (code, reason) => {
    const clients = rooms.get(sessionId);
    if (!clients) return;
    clients.delete(ws);
    if (clients.size === 0) rooms.delete(sessionId);
    else sendPresence(sessionId);
    metrics.wsConnections?.dec();
    updatePresenceMetrics();
    const meta = ws._meta;
    logger.info({
      sessionId: meta?.sessionId ?? sessionId,
      userId: meta?.userId ?? null,
      clientId: meta?.clientId ?? null,
      connId: meta?.connId ?? null,
      code: typeof code === 'number' ? code : null,
      reason: reason ? String(reason) : null,
    }, 'ws_close');
  });
});

// Keepalive: helps iPad/Safari + nginx keep WS open and detects dead peers.
const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);
wss.on('close', () => clearInterval(pingInterval));

await initDbWithRetry();
try {
  await ensureTestUser();
} catch {
  // ignore startup test user initialization errors
}
if (entityCountGauge) {
  const intervalMs = normalizeIntervalMs(ENTITY_COUNT_INTERVAL_MS, 60000);
  const run = () => {
    refreshEntityCounts().catch((err) => {
      logger.warn({ error: err?.message ?? String(err) }, 'entity_count_refresh_failed');
    });
  };
  run();
  setInterval(run, intervalMs);
}
try {
  await cleanupExpiredSessions();
} catch {
  // ignore
}
setInterval(() => {
  cleanupExpiredSessions().catch(() => undefined);
}, 1000 * 60 * 60);

// Default session is optional; if not configured, clear the setting to avoid forced redirects.
try {
  if (DEFAULT_SESSION_ID) {
    await ensurePinnedSession(DEFAULT_SESSION_ID);
    await setSetting('default_session_id', DEFAULT_SESSION_ID);
  } else {
    await deleteSetting('default_session_id');
  }
} catch {
  // ignore startup default initialization errors
}

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'sessions_api_listening');
});
