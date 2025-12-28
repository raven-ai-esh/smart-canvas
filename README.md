# Raven Smart Tracker (Living Canvas)
![Raven icon](raven_icon.png)

A spatial thinking canvas for tasks and ideas. Place cards in an infinite space, connect them, and let energy flow across the graph. The project includes a realtime canvas UI, an API + WebSocket backend, an MCP server for tool control, and a Raven AI assistant powered by OpenAI.

## Core Concepts
- Nodes (cards): `idea` or `task` with content, energy, clarity, and status.
- Edges: directed links that propagate energy from source to target.
- Sessions: every canvas state lives in a session (temporary or saved).
- Participants: users who saved a canvas; only participants can be tagged.
- Mentions: use `@name` or `@all` to tag participants in card content.

## Highlights
- Infinite zoomable canvas with pan, selection, multi-node operations, and text boxes.
- Task cards with status (`queued`, `in_progress`, `done`), dates, and progress.
- Monitoring mode with animated tasks and energy-aware connections.
- Raven assistant (OpenAI Responses API) that can operate the canvas via MCP tools.
- Alerting system with email, Telegram, and webhook channels.

## Architecture
Services (Docker):
- `app`: Nginx serving the frontend and proxying `/api` + `/ws`.
- `api`: Express REST API + WebSocket sync, auth, alerting, and AI integration.
- `agent`: FastAPI service that runs the Raven assistant and executes MCP tools.
- `mcp`: MCP server that exposes canvas tools to the assistant.
- `db`: Postgres (with pgvector extension).
- `redis`: caching for assistant and session helpers.
- `prometheus`: metrics store for API/MCP/agent.
- `grafana`: dashboards for metrics/logs/traces.
- `otel-collector`: OpenTelemetry ingest for traces.
- `tempo`: trace storage (Grafana Tempo).
- `loki`: log storage.
- `promtail`: log collector from Docker containers.

## Local Development
### Using Docker (recommended)
```bash
docker compose up -d --build
```
- App: http://localhost:8080
- API + WS: proxied at `http://localhost:8080/api` and `ws://localhost:8080/ws`
- MCP: http://localhost:7010/mcp (debug/testing)
- Agent: http://localhost:8001
- Grafana: http://localhost:3000
- Prometheus: http://localhost:9090
- Tempo: http://localhost:3200
- Loki: http://localhost:3100

### Without Docker
1) Start Postgres and Redis locally.
2) Start API:
```bash
npm run dev:api
```
3) Start MCP server:
```bash
npm run mcp:canvas
```
4) Start the agent service:
```bash
uvicorn agent-service.app:app --host 0.0.0.0 --port 8001
```
5) Start frontend:
```bash
npm run dev
```

## Raven Assistant
- Uses OpenAI Responses API for reasoning and tool calls.
- Requires an OpenAI API key in **Integrations → AI** (stored server-side).
- MCP tools allow the assistant to read and update the canvas.
- Prompt editor: `GET /prompt/ui` on the agent service.

## Alerting
Alerting is configured in **Integrations → Alerting**.

Supported channels:
- Email
- Telegram (via the alerting bot)
- Webhook (POST JSON to your endpoint)

Events:
- Card changes (author or tagged participant)
- Mention added
- Agent reply

Telegram flow:
1) Open the alert bot in Telegram.
2) Send your Raven account email.
3) Confirm in **Integrations → Alerting** when prompted.

Telegram webhook:
- Set `https://<YOUR_DOMAIN>/api/integrations/telegram/webhook` as the bot webhook.

## API Quick Reference
- `GET /api/sessions/:id` - fetch session state + meta
- `PUT /api/sessions/:id` - merge updates
- `POST /api/sessions/:id/save` - save or rename session
- `GET /api/sessions/mine` - list saved sessions for current user
- `DELETE /api/sessions/:id` - delete owned session
- `PATCH /api/auth/me` - update profile fields
- `GET /api/auth/change-email` - confirm email change via token
- `GET /api/integrations/ai/key` - get AI key status
- `POST /api/integrations/ai/key` - set AI key
- `POST /api/integrations/alerting` - save alerting settings
- `POST /api/integrations/telegram/webhook` - Telegram alert bot webhook
- `POST /api/assistant/threads` - create assistant thread
- `POST /api/assistant/threads/:id/messages` - send assistant message

## Environment Variables
Create `.env` (see `.env.example`) and configure as needed.

Core:
- `DATABASE_URL`
- `JWT_SECRET`
- `AUTH_COOKIE_NAME`
- `COOKIE_SECURE`
- `CORS_ORIGIN`
- `APP_ORIGIN`
- `DEFAULT_SESSION_ID`
- `TEMP_SESSION_TTL_DAYS`
- `REDIS_URL`

Observability:
- `LOG_LEVEL` (default `info`)
- `LOG_TRACE` (adds trace_id/span_id to logs when tracing is enabled)
- `METRICS_ENABLED` (default `true`)
- `METRICS_PATH` (default `/metrics`)
- `OTEL_EXPORTER_OTLP_ENDPOINT` (set to enable OpenTelemetry traces)
- `OTEL_SERVICE_NAME` (optional override for service name)
- `OTEL_LOG_LEVEL` (optional OpenTelemetry diag logging)

Email:
- `SMTP_URL`
- `MAIL_FROM`

OAuth:
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`
- `TELEGRAM_AUTH_BOT_USERNAME`, `TELEGRAM_AUTH_BOT_TOKEN`

Alerting:
- `ALERT_PUBLIC_BASE_URL` (links in alerts; falls back to `APP_ORIGIN`)
- `TELEGRAM_ALERT_BOT_USERNAME`, `TELEGRAM_ALERT_BOT_TOKEN`
- `TELEGRAM_ALERT_LINK_TTL_HOURS`
- `TELEGRAM_ALERT_WEBHOOK_SECRET` (optional)

AI / Agent:
- `OPENAI_API_KEY`
- `OPENAI_API_BASE_URL`
- `OPENAI_MODEL`
- `OPENAI_SUMMARY_MODEL`
- `OPENAI_EMBEDDING_MODEL`
- `OPENAI_TIMEOUT_MS`
- `AGENT_SERVICE_URL`
- `AGENT_SERVICE_TIMEOUT_MS`
- `AGENT_LOG_LEVEL`
- `AGENT_LOG_TRUNCATE`
- `AGENT_PROMPT_PATH`

curl -X POST "https://api.telegram.org/bot8579736745:AAEJK7mo2TTR4l3Gp6KLZECvFJwEA73jVwc/setWebhook" \
    -d "url=https://canvas.raven-ai.ru/api/integrations/telegram/webhook" \
    -d "secret_token=19308292be814f396d6b052c2f8d1ee86d36b1329b3de3c76e56b9d9fc34d28b"

MCP:
- `MCP_SERVER_URL`
- `MCP_TECH_TOKEN`
- `MCP_TECH_USER_ID`
- `MCP_TECH_USER_NAME`
- `MCP_TECH_AVATAR_SEED`
- `MCP_AGENT_ALLOWED_TOOLS`
- `MCP_SNAPSHOT_TIMEOUT_MS`

Testing defaults:
- `TEST_USER_ENABLED`
- `TEST_USER_EMAIL`
- `TEST_USER_PASSWORD`
- `TEST_USER_NAME`

## Troubleshooting
- Telegram alerts not arriving: confirm the chat is linked and the webhook points to `/api/integrations/telegram/webhook`.
- Alert hyperlinks missing: set `ALERT_PUBLIC_BASE_URL` or `APP_ORIGIN`.
- OAuth `bad_oauth_state` on localhost: set `COOKIE_SECURE=false`.
- WebSocket errors: ensure `/ws` is reachable via Nginx.
- Metrics: check that `METRICS_ENABLED=true` and access `/metrics` on API/MCP.
- Traces missing: set `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP).

## Scripts
- `npm run dev` - frontend dev server
- `npm run dev:api` - API locally
- `npm run mcp:canvas` - MCP server locally
- `npm run build` - build frontend
- `npm run lint` - lint
