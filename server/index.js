import http from 'http';
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import { WebSocketServer } from 'ws';
import { randomUUID, createHash, randomBytes, createHmac } from 'crypto';
import cookieParser from 'cookie-parser';
import cookie from 'cookie';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';

const PORT = Number(process.env.PORT ?? 8787);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/smart_tracker';
const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID;
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-jwt-secret';
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'auth_token';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const APP_ORIGIN = process.env.APP_ORIGIN; // optional: e.g. https://your-domain.com
const SMTP_URL = process.env.SMTP_URL;
const MAIL_FROM = process.env.MAIL_FROM ?? 'no-reply@smart-tracker.local';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const YANDEX_CLIENT_ID = process.env.YANDEX_CLIENT_ID;
const YANDEX_CLIENT_SECRET = process.env.YANDEX_CLIENT_SECRET;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEST_USER_ENABLED = process.env.TEST_USER_ENABLED ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true');
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL ?? '';
const TEST_USER_PASSWORD = process.env.TEST_USER_PASSWORD ?? '';
const TEST_USER_NAME = process.env.TEST_USER_NAME ?? 'Test User';
const TEMP_SESSION_TTL_DAYS = Number(process.env.TEMP_SESSION_TTL_DAYS ?? 7);
const TEMP_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * (Number.isFinite(TEMP_SESSION_TTL_DAYS) && TEMP_SESSION_TTL_DAYS > 0 ? TEMP_SESSION_TTL_DAYS : 7);
const parseCorsOrigin = (v) => {
  if (v === undefined) return true;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
};
const CORS_ORIGIN = parseCorsOrigin(process.env.CORS_ORIGIN);

const pool = new Pool({ connectionString: DATABASE_URL });

async function initDb() {
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
    CREATE TABLE IF NOT EXISTS oauth_accounts (
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (provider, provider_account_id)
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
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return res.rows[0] ?? null;
}

async function getUserById(id) {
  const res = await pool.query('SELECT id, email, name, avatar_seed, avatar_url, avatar_animal, avatar_color, verified FROM users WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}

async function getUserByEmail(email) {
  const res = await pool.query('SELECT id, email, password_hash, name, avatar_seed, avatar_url, avatar_animal, avatar_color, verified FROM users WHERE email = $1', [email]);
  return res.rows[0] ?? null;
}

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

function normalizeTombstones(raw) {
  if (!raw || typeof raw !== 'object') return { nodes: {}, edges: {}, drawings: {}, textBoxes: {} };
  return {
    nodes: raw.nodes && typeof raw.nodes === 'object' ? raw.nodes : {},
    edges: raw.edges && typeof raw.edges === 'object' ? raw.edges : {},
    drawings: raw.drawings && typeof raw.drawings === 'object' ? raw.drawings : {},
    textBoxes: raw.textBoxes && typeof raw.textBoxes === 'object' ? raw.textBoxes : {},
  };
}

function normalizeState(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    nodes: Array.isArray(obj.nodes) ? obj.nodes : [],
    edges: Array.isArray(obj.edges) ? obj.edges : [],
    drawings: Array.isArray(obj.drawings) ? obj.drawings : [],
    textBoxes: Array.isArray(obj.textBoxes) ? obj.textBoxes : [],
    theme: obj.theme === 'light' ? 'light' : 'dark',
    tombstones: normalizeTombstones(obj.tombstones),
  };
}

const ts = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

function mergeTombstones(a, b) {
  const ta = normalizeTombstones(a);
  const tb = normalizeTombstones(b);
  const out = { nodes: { ...ta.nodes }, edges: { ...ta.edges }, drawings: { ...ta.drawings }, textBoxes: { ...ta.textBoxes } };
  for (const [id, t] of Object.entries(tb.nodes)) out.nodes[id] = Math.max(ts(out.nodes[id]), ts(t));
  for (const [id, t] of Object.entries(tb.edges)) out.edges[id] = Math.max(ts(out.edges[id]), ts(t));
  for (const [id, t] of Object.entries(tb.drawings)) out.drawings[id] = Math.max(ts(out.drawings[id]), ts(t));
  for (const [id, t] of Object.entries(tb.textBoxes)) out.textBoxes[id] = Math.max(ts(out.textBoxes[id]), ts(t));
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

  return {
    nodes,
    edges,
    drawings,
    textBoxes,
    theme: current.theme,
    tombstones,
  };
}

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
    const merged = mergeState(row.state, incomingState);
    const updated = await client.query(
      `UPDATE sessions
         SET state = $1, version = version + 1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, state, version, name, owner_id, saved_at, expires_at`,
      [merged, sessionId],
    );
    await client.query('COMMIT');
    return updated.rows[0] ?? null;
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

app.get('/api/auth/providers', async (_req, res) => {
  res.json({
    email: true,
    google: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    yandex: !!(YANDEX_CLIENT_ID && YANDEX_CLIENT_SECRET),
    telegram: !!(TELEGRAM_BOT_USERNAME && TELEGRAM_BOT_TOKEN),
    telegramBotUsername: TELEGRAM_BOT_USERNAME || null,
  });
});

app.post('/api/auth/logout', async (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/signup', async (req, res) => {
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

app.get('/api/auth/verify', async (req, res) => {
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

app.get('/api/auth/change-email', async (req, res) => {
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

app.post('/api/auth/login', async (req, res) => {
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

app.get('/api/auth/telegram/start', async (req, res) => {
  if (!TELEGRAM_BOT_USERNAME || !TELEGRAM_BOT_TOKEN) return res.status(501).json({ error: 'telegram_not_configured' });
  const returnTo = sanitizeReturnTo(req.query?.returnTo);
  res.cookie('oauth_return_to', returnTo, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/' });
  const authUrl = `${getBaseUrl(req)}/api/auth/telegram/callback`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Telegram login</title>
<style>
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0f18; color:#e6e6e6; }
  .wrap { min-height:100vh; display:grid; place-items:center; padding:24px; }
  .card { max-width:520px; width:100%; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); border-radius:16px; padding:18px; }
  .title { font-weight:600; margin-bottom:10px; }
  .hint { font-size:12px; opacity:.75; margin-top:10px; }
</style>
</head><body>
<div class="wrap"><div class="card">
  <div class="title">Вход через Telegram</div>
  <div class="hint" id="hint">Ожидание входа…</div>
  <script async src="https://telegram.org/js/telegram-widget.js?22"
    data-telegram-login="${String(TELEGRAM_BOT_USERNAME)}"
    data-size="large"
    data-radius="12"
    data-userpic="false"
    data-onauth="onTelegramAuth(user)">
  </script>
  <script>
    const AUTH_URL = ${JSON.stringify(authUrl)};
    const RETURN_TO = ${JSON.stringify(returnTo)};
    function onTelegramAuth(user) {
      try {
        const hint = document.getElementById('hint');
        if (hint) hint.textContent = 'Входим…';
        const params = new URLSearchParams();
        if (user && typeof user === 'object') {
          for (const [k, v] of Object.entries(user)) {
            if (v === undefined || v === null) continue;
            params.set(k, String(v));
          }
        }
        params.set('returnTo', RETURN_TO);
        window.location.href = AUTH_URL + '?' + params.toString();
      } catch (e) {
        window.location.href = AUTH_URL;
      }
    }
  </script>
</div></div>
</body></html>`);
});

app.get('/api/auth/telegram/callback', async (req, res) => {
  if (!TELEGRAM_BOT_USERNAME || !TELEGRAM_BOT_TOKEN) return res.status(501).send('telegram_not_configured');
  const returnTo = req.cookies?.oauth_return_to ?? sanitizeReturnTo(req.query?.returnTo) ?? '/';
  res.clearCookie('oauth_return_to', { path: '/' });

  const q = req.query ?? {};
  const hash = typeof q.hash === 'string' ? q.hash : null;
  const id = typeof q.id === 'string' ? q.id : null;
  const authDateStr = typeof q.auth_date === 'string' ? q.auth_date : null;
  if (!hash || !id || !authDateStr) return res.status(400).send('bad_request');

  const authDate = Number(authDateStr);
  if (!Number.isFinite(authDate)) return res.status(400).send('bad_request');
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - authDate) > 60 * 60 * 24) return res.status(400).send('auth_date_too_old');

  const allowed = new Set(['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date']);
  const entries = Object.entries(q)
    .filter(([k]) => k !== 'hash' && allowed.has(k))
    .map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
    .filter(([, v]) => typeof v === 'string')
    .map(([k, v]) => [k, String(v)]);

  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash.toLowerCase()) return res.status(401).send('invalid_hash');

  const firstName = typeof q.first_name === 'string' ? q.first_name : '';
  const lastName = typeof q.last_name === 'string' ? q.last_name : '';
  const username = typeof q.username === 'string' ? q.username : '';
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
    `SELECT id, name, saved_at, updated_at
       FROM sessions
      WHERE owner_id = $1 AND saved_at IS NOT NULL
      ORDER BY updated_at DESC`,
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
  const source = await getSession(req.params.id);
  if (!source) return res.status(404).json({ error: 'not_found' });
  const id = randomUUID();
  const created = await createSession(id, normalizeState(source.state));
  res.status(201).json(serializeSession(created));
});

app.get('/api/sessions/:id', async (req, res) => {
  const session = await getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'not_found' });
  res.json(serializeSession(session));
});

app.put('/api/sessions/:id', async (req, res) => {
  const state = req.body?.state;
  if (!state) return res.status(400).json({ error: 'bad_request' });
  const updated = await mergeAndUpdateSession(req.params.id, state);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  res.json(serializeSession(updated));
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
  const rawName = String(req.body?.name ?? '').trim();
  if (!rawName) return res.status(400).json({ error: 'name_required' });
  const name = rawName.slice(0, 120);

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
    if (row.owner_id && row.owner_id !== auth.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'forbidden' });
    }
    const updated = await client.query(
      `UPDATE sessions
         SET name = $1, owner_id = $2, saved_at = NOW(), expires_at = NULL, updated_at = NOW()
       WHERE id = $3
       RETURNING id, state, version, name, owner_id, saved_at, expires_at`,
      [name, auth.userId, req.params.id],
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

function guestNameFromClientId(clientId) {
  if (!clientId || typeof clientId !== 'string') return 'Guest';
  return `Guest ${clientId.slice(0, 4)}`;
}

function sendPresence(sessionId) {
  const clients = roomFor(sessionId);
  const peers = [];
  for (const ws of clients) {
    const meta = ws._meta;
    if (!meta) continue;
    peers.push({
      id: meta.connId,
      name: meta.name,
      avatarSeed: meta.avatarSeed,
      avatarUrl: meta.avatarUrl,
      avatarAnimal: meta.avatarAnimal,
      avatarColor: meta.avatarColor,
      registered: !!meta.userId,
    });
  }

  for (const ws of clients) {
    const meta = ws._meta;
    if (!meta) continue;
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(JSON.stringify({ type: 'presence', selfId: meta.connId, peers }));
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
  let user = null;
  if (auth?.userId) {
    try {
      user = await getUserById(auth.userId);
    } catch {
      user = null;
    }
  }

  const name = user?.name ?? guestNameFromClientId(clientId);
  const avatarSeed = user?.avatar_seed ?? (clientId || connId);
  const avatarUrl = user?.avatar_url ?? null;
  const avatarAnimal = user?.avatar_animal ?? null;
  const avatarColor = user?.avatar_color ?? null;
  ws._meta = { sessionId, connId, clientId, userId: user?.id ?? null, name, avatarSeed, avatarUrl, avatarAnimal, avatarColor };

  roomFor(sessionId).add(ws);
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

    if (msg?.type !== 'update') return;
    const clientId = typeof msg?.clientId === 'string' ? msg.clientId : null;
    const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
    const state = msg?.state;
    if (!state) return;

    const updated = await mergeAndUpdateSession(sessionId, state);
    if (!updated) return;
    const payload = serializeSession(updated);
    broadcast(sessionId, { type: 'update', ...payload, sourceClientId: clientId, requestId });
  });

  ws.on('close', () => {
    const clients = rooms.get(sessionId);
    if (!clients) return;
    clients.delete(ws);
    if (clients.size === 0) rooms.delete(sessionId);
    else sendPresence(sessionId);
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
try {
  await cleanupExpiredSessions();
} catch {
  // ignore
}
setInterval(() => {
  cleanupExpiredSessions().catch(() => undefined);
}, 1000 * 60 * 60);

// Ensure there is a default session for "landing" opens (no ?session=...).
// If DEFAULT_SESSION_ID is provided, it becomes the default (and is created if missing).
try {
  if (DEFAULT_SESSION_ID) {
    await ensurePinnedSession(DEFAULT_SESSION_ID);
    await setSetting('default_session_id', DEFAULT_SESSION_ID);
  } else {
    const current = await getSetting('default_session_id');
    if (current) {
      await ensurePinnedSession(current);
    } else {
      const id = randomUUID();
      await ensurePinnedSession(id);
      await setSetting('default_session_id', id);
    }
  }
} catch {
  // ignore startup default initialization errors
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[sessions-api] listening on :${PORT}`);
});
