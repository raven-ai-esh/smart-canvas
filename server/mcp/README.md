# MCP Canvas Server

This MCP server exposes tools to control Smart Tracker canvas objects (nodes, edges, text boxes, files, images, comments, drawings) via the existing session sync WebSocket.

## Run (stdio)

```bash
npm run mcp:canvas
```

## Run (HTTP)

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=7010 npm run mcp:canvas
```

## UI

Open `http://localhost:7010/` for a minimal tool runner UI.

## Auth

To attribute MCP-created objects to a user, pass the MCP token in requests to `/mcp`:

- `Authorization: Bearer <token>` (preferred)
- `X-MCP-Token: <token>`

If no token is provided, objects are authored as `AI`.

## Environment

- `CANVAS_BASE_URL` (default: `http://localhost:8080`)
- `CANVAS_WS_URL` (default: derived from `CANVAS_BASE_URL` + `/ws`)
- `CANVAS_SESSION_ID` (optional active session id)
- `CANVAS_CLIENT_ID` (optional MCP client id)

If no session is set, the server tries `/api/settings/default-session`.

## Notes

- Updates are sent over WebSocket so connected clients update immediately.
- Deletions are applied using tombstones and `updatedAt` timestamps.
- `get_active_canvas_snapshot` returns only snapshot metadata (no image payloads) and requires the user session to be open in a browser.
