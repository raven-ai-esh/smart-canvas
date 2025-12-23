# Release Notes
- Account settings modal: update profile, set or remove avatars, and confirm password changes.
- Email change now requires confirmation via link, and password updates trigger an email notice.
- Display controls (day/night, snow) are now in the avatar menu.
- Monitoring mode: in-progress tasks pulse, outgoing links animate, and done tasks stop energy when monitoring is on.
- Mobile note view margins and keyboard-safe focus behavior.

# Living Canvas (Smart Tracker)
![Raven icon](raven_icon.png)

A spatial thinking canvas for tasks and ideas. Place nodes in an infinite space, connect them, and let energy and structure emerge. The project combines a realtime canvas frontend with a session-based backend API and WebSocket sync.

## Core Concepts
- Nodes: `idea` and `task` types with energy, clarity, and spatial position.
- Edges: directed links that propagate energy from source to target.
- Views: Graph, Card, and Note (detail) views that appear based on zoom and focus.
- Sessions: every canvas state lives in a session that can be temporary or saved to an account.

## Highlights
- Infinite zoomable canvas with pan, selection, multi-node operations, and text boxes.
- Task cards with status (`queued`, `in_progress`, `done`), dates, and a progress ring.
- Monitoring mode with animated tasks and energy-aware connections.
- Pen mode with pen/eraser/highlighter, plus touch and stylus optimizations.
- Local UI modes: grid snapping, focus, monitorin, and move.
- Display: light/dark themes and snow overlay, now available from the avatar menu.

## Accounts and Sessions
- Unsaved sessions are temporary and expire after a TTL (default 7 days).
- Saved sessions are tied to the authenticated user and never expire.
- Session side panel:
  - New session (opens a new tab)
  - Copy session (creates a new unsaved session with full content)
  - Share (copies a direct link)
  - Delete (blocked for the default session)
- Account settings:
  - Change name, email, and password
  - Email change requires confirmation link
  - Password change sends a notification email
  - Upload, change, or remove a custom avatar

## Auth
- Email/password with verification.
- OAuth providers: Google, Yandex, Telegram (when configured).

## Tech Stack
- Frontend: React 19 + Vite + Zustand
- Backend: Express + WebSocket (`ws`)
- Database: Postgres
- Docker + Nginx for local and deployment

## Architecture Overview
- `app` container serves the static frontend with Nginx.
- `api` container hosts REST and WebSocket endpoints.
- `db` container stores sessions, users, oauth accounts, and email tokens.
- WebSocket path: `/ws`
- API path: `/api/*`

## Local Development
### Using Docker (recommended)
```bash
docker compose up -d --build
```
- App: http://localhost:8080
- API (internal): http://api:8787

### Without Docker
1) Start Postgres locally and set `DATABASE_URL`.
2) Start API:
```bash
npm run dev:api
```
3) Start frontend:
```bash
npm run dev
```

## Environment Variables
Create `.env` (see `.env.example`) and configure:
- `DATABASE_URL` - Postgres connection string
- `JWT_SECRET` - auth token secret
- `AUTH_COOKIE_NAME` - auth cookie name
- `COOKIE_SECURE` - set `false` for localhost, `true` for HTTPS
- `APP_ORIGIN` - app base URL (example: https://canvas.example.com)
- `CORS_ORIGIN` - CORS setting (`true`, `false`, or origin)
- `DEFAULT_SESSION_ID` - pinned default session id
- `TEMP_SESSION_TTL_DAYS` - TTL for temporary sessions (default 7)
- `SMTP_URL`, `MAIL_FROM` - email verification and account notifications
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`
- `TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_TOKEN`

## API Notes
- `GET /api/sessions/:id` - fetch session state + meta
- `PUT /api/sessions/:id` - merge updates
- `POST /api/sessions/:id/save` - save or rename session
- `GET /api/sessions/mine` - list saved sessions for current user
- `DELETE /api/sessions/:id` - delete owned session
- `PATCH /api/auth/me` - update profile fields (name, password, avatar, email change request)
- `GET /api/auth/change-email` - confirm a new email via token

## Troubleshooting
- OAuth `bad_oauth_state` on localhost: set `COOKIE_SECURE=false` in `.env`.
- WebSocket errors: ensure the app is running via Docker and `/ws` is reachable.
- No SMTP configured: email confirmations are returned as dev links in API responses.

## Scripts
- `npm run dev` - frontend dev server
- `npm run dev:api` - run API locally
- `npm run build` - build frontend
- `npm run lint` - lint
