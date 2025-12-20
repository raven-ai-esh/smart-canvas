# Release Notes
- Session ownership and saving with a top-left Save bar, session name display, and a sessions side panel (new, copy, share, delete).
- Monitoring mode for tasks: in-progress cards pulse and outgoing links animate in the task energy color.
- Task progress UI: status badges, percent progress, and a circular progress ring on the card border.
- Grid snapping, focus mode, and improved control grouping for modes and display.
- Light theme canvas tuning and snow overlay adjustments.

# Living Canvas (Smart Tracker)
A spatial thinking canvas for tasks and ideas. You place nodes in an infinite space, connect them, and let energy and structure emerge. The project combines a realtime canvas frontend with a session-based backend API and WebSocket sync.

## Core Concepts
- Nodes: `idea` and `task` types with energy, clarity, and spatial position.
- Edges: directed links that propagate energy from source to target.
- Views: Graph, Card, and Note (details) views for different zoom levels.
- Sessions: every canvas state lives in a session that can be temporary or saved to an account.

## Features
- Infinite zoomable canvas with pan, selection, and multi-node operations.
- Task cards with status (`queued`, `in_progress`, `done`), start/end dates, and progress ring.
- Realtime sync via WebSocket with server-side state merge.
- Pen mode with pen, eraser, highlighter and touch/stylus optimizations.
- Text boxes for free-form notes.
- Energy propagation and color mapping across edges.
- Modes:
  - Move mode
  - Grid snapping
  - Physics
  - Focus
  - Monitoring
- Display:
  - Light/dark themes
  - Snow overlay

## Sessions and Ownership
- Unsaved sessions are temporary and expire after a TTL (default 7 days).
- Saved sessions are tied to the authenticated user and never expire.
- Side panel actions:
  - New session (opens a new tab)
  - Copy session (creates a new unsaved session with full content)
  - Share (copies a direct link)
  - Delete (blocked for the default session)

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
- `db` container stores sessions, users, and oauth accounts.
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
- `APP_ORIGIN` - app base URL (ex: https://canvas.example.com)
- `CORS_ORIGIN` - CORS setting (`true`, `false`, or origin)
- `DEFAULT_SESSION_ID` - pinned default session id
- `TEMP_SESSION_TTL_DAYS` - TTL for temporary sessions (default 7)
- `SMTP_URL`, `MAIL_FROM` - email verification
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`
- `TELEGRAM_BOT_USERNAME`, `TELEGRAM_BOT_TOKEN`

## API Notes
- `GET /api/sessions/:id` - fetch session state + meta
- `PUT /api/sessions/:id` - merge updates
- `POST /api/sessions/:id/save` - save or rename session
- `GET /api/sessions/mine` - list saved sessions for current user
- `DELETE /api/sessions/:id` - delete owned session

## Troubleshooting
- OAuth `bad_oauth_state` on localhost: set `COOKIE_SECURE=false` in `.env`.
- WebSocket errors: ensure the app is running via Docker and `/ws` is reachable.

## Scripts
- `npm run dev` - frontend dev server
- `npm run dev:api` - run API locally
- `npm run build` - build frontend
- `npm run lint` - lint
