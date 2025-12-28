from __future__ import annotations

from typing import Any
import contextvars
import copy
import json
import os
import time
import uuid
import html

from contextlib import asynccontextmanager
from datetime import timedelta
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from openai import APIStatusError, AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field
import httpx
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
import tiktoken
from prometheus_client import Counter, Histogram, Gauge, CONTENT_TYPE_LATEST, generate_latest
from pythonjsonlogger import jsonlogger
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource, SERVICE_NAME
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.util._once import Once

import logging

LOG_LEVEL = os.getenv("AGENT_LOG_LEVEL", os.getenv("LOG_LEVEL", "INFO")).upper()
LOG_TRUNCATE = int(os.getenv("AGENT_LOG_TRUNCATE", "2000"))
LOG_TRACE = os.getenv("LOG_TRACE", "false").lower() == "true"
METRICS_ENABLED = os.getenv("METRICS_ENABLED", "true").lower() != "false"
METRICS_PATH = os.getenv("METRICS_PATH", "/metrics")
OTEL_ENDPOINT = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
OTEL_SERVICE_NAME = os.getenv("OTEL_SERVICE_NAME", "smart-tracker-agent")
OTEL_LOG_LEVEL = os.getenv("OTEL_LOG_LEVEL", "")

request_id_ctx = contextvars.ContextVar("request_id", default=None)


class ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_ctx.get() or ""
        if LOG_TRACE:
            span = trace.get_current_span()
            span_context = span.get_span_context() if span else None
            if span_context and span_context.trace_id:
                record.trace_id = f"{span_context.trace_id:032x}"
                record.span_id = f"{span_context.span_id:016x}"
            else:
                record.trace_id = ""
                record.span_id = ""
        return True


handler = logging.StreamHandler()
formatter = jsonlogger.JsonFormatter(
    "%(asctime)s %(levelname)s %(name)s %(message)s %(request_id)s %(trace_id)s %(span_id)s"
)
handler.setFormatter(formatter)
root_logger = logging.getLogger()
root_logger.handlers = [handler]
root_logger.setLevel(LOG_LEVEL)
root_logger.addFilter(ContextFilter())
if OTEL_LOG_LEVEL:
    logging.getLogger("opentelemetry").setLevel(OTEL_LOG_LEVEL)

app = FastAPI()

logger = logging.getLogger("agent")

_otel_once = Once()


def _init_tracing() -> None:
    if not OTEL_ENDPOINT:
        return
    def _setup() -> None:
        resource = Resource.create({SERVICE_NAME: OTEL_SERVICE_NAME})
        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(endpoint=OTEL_ENDPOINT)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        FastAPIInstrumentor.instrument_app(app)
        HTTPXClientInstrumentor().instrument()
        logger.info("otel_ready", extra={"endpoint": OTEL_ENDPOINT, "service": OTEL_SERVICE_NAME})
    _otel_once.do_once(_setup)


REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests",
    ["method", "path", "status"],
)
REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds",
    ["method", "path", "status"],
)
IN_FLIGHT = Gauge("http_in_flight_requests", "In-flight HTTP requests")


@app.middleware("http")
async def observability_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or request.headers.get("x-correlation-id") or str(uuid.uuid4())
    token = request_id_ctx.set(request_id)
    start = time.time()
    if METRICS_ENABLED:
        IN_FLIGHT.inc()
    try:
        response = await call_next(request)
    except Exception as exc:
        duration = time.time() - start
        if METRICS_ENABLED:
            REQUEST_COUNT.labels(request.method, request.url.path, "500").inc()
            REQUEST_LATENCY.labels(request.method, request.url.path, "500").observe(duration)
            IN_FLIGHT.dec()
        logger.exception("http_error", extra={
            "method": request.method,
            "path": request.url.path,
            "status": 500,
            "duration_ms": int(duration * 1000),
        })
        request_id_ctx.reset(token)
        raise exc
    duration = time.time() - start
    if METRICS_ENABLED:
        REQUEST_COUNT.labels(request.method, request.url.path, str(response.status_code)).inc()
        REQUEST_LATENCY.labels(request.method, request.url.path, str(response.status_code)).observe(duration)
        IN_FLIGHT.dec()
    logger.info("http_request", extra={
        "method": request.method,
        "path": request.url.path,
        "status": response.status_code,
        "duration_ms": int(duration * 1000),
    })
    response.headers["x-request-id"] = request_id
    request_id_ctx.reset(token)
    return response


if METRICS_ENABLED:
    @app.get(METRICS_PATH)
    async def metrics() -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

_init_tracing()

AGENT_MODEL_CONTEXT_TOKENS = int(os.getenv("AGENT_MODEL_CONTEXT_TOKENS", "0"))
ASSISTANT_MODEL_CONTEXT_TOKENS = int(os.getenv("ASSISTANT_MODEL_CONTEXT_TOKENS", "0"))
PROMPT_PATH = os.getenv("AGENT_PROMPT_PATH", "/app/data/prompt.txt")
MODEL_CONTEXT_TOKENS = {
    "gpt-5.2": 400000,
}

DEFAULT_PROMPT_LINES = [
    "You are Raven, the Smart Tracker AI assistant.",
    "You can use MCP tools to read and update the canvas.",
    "Use tools when a user asks to inspect or change the canvas.",
    'Prefer node with action="create" for new cards and action="update" for edits.',
    "When creating edges between new cards, create the cards first and use their returned ids; do not use placeholder ids.",
    "get_state returns a summary by default (titles + metadata). Use node with action=\"read\" for full content when needed.",
    "Full get_state payloads are disabled; use node with action=\"read\" for full card details.",
    "If you only need a list of cards, use node with action=\"read\" and mode=\"summary\".",
    "Nodes have energy from 0 to 100 that represents the effort required to complete the card unless the user specifies otherwise.",
    "Energy propagates along edges from source nodes to target nodes.",
    "Each card has a base (own) energy you set directly; total card energy equals its base plus the sum of incoming energies, capped at 100%.",
    "List responses are capped; if a list is truncated, request specific items by id or use a smaller limit.",
    "Canvas participants are users who saved the canvas; only they can be tagged.",
    "Use MCP tool list_canvas_participants to fetch taggable people (id, name, email).",
    "Use MCP tool send_alert to notify a canvas participant via their enabled alerting channels. Pass userRef as the participant id (preferred) or their name/email/handle from list_canvas_participants.",
    "When tagging someone in a card, include @Name in the content and update node.mentions with {id,label}.",
    "To tag everyone, include @all and add {id:\"all\", label:\"all\"} to node.mentions.",
    "For destructive actions (delete), ask for explicit confirmation first.",
    "If a tool fails, explain what happened and ask how to proceed.",
    "Keep responses concise and actionable.",
]
DEFAULT_PROMPT = "\n".join(DEFAULT_PROMPT_LINES)

_prompt_cache: str | None = None
_prompt_mtime: float | None = None


class MCPConfig(BaseModel):
    model_config = ConfigDict(extra="allow")

    url: str | None = None
    token: str | None = None
    sessionId: str | None = None
    userId: str | None = None
    allowedTools: list[str] | None = None


class AgentRunRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    apiKey: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    instructions: str | None = None
    userName: str | None = None
    input: str | list[dict[str, Any]]
    maxTurns: int | None = None
    temperature: float | None = 0.3
    openaiBaseUrl: str | None = None
    openaiTimeoutMs: int | None = None
    mcp: MCPConfig | None = None


class AgentRunResponse(BaseModel):
    output: str
    lastResponseId: str | None = None
    context: dict[str, Any] | None = None


class AgentContextRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str = Field(..., min_length=1)
    instructions: str | None = None
    input: Any = None
    userName: str | None = None


class AgentContextResponse(BaseModel):
    context: dict[str, Any]


class AssistantResponse(BaseModel):
    message: str

class PromptResponse(BaseModel):
    prompt: str

class PromptUpdateRequest(BaseModel):
    prompt: str = Field(..., min_length=1)


def _format_output(value: Any) -> str:
    if isinstance(value, str):
        return value
    return str(value) if value is not None else ""

def _mask_secret(value: Any, keep: int = 4) -> str:
    raw = value if isinstance(value, str) else str(value) if value is not None else ""
    if not raw:
        return ""
    if len(raw) <= keep * 2:
        return f"{raw[:1]}...{raw[-1:]}"
    return f"{raw[:keep]}...{raw[-keep:]}"

def _summarize_output_items(output: Any) -> dict[str, int]:
    counts: dict[str, int] = {}
    if not isinstance(output, list):
        return counts
    for item in output:
        item_type = item.get("type") if isinstance(item, dict) else getattr(item, "type", None)
        label = item_type if isinstance(item_type, str) and item_type else "unknown"
        counts[label] = counts.get(label, 0) + 1
    return counts


def _extract_response_text(response: Any) -> str:
    if hasattr(response, "output_text") and isinstance(response.output_text, str):
        return response.output_text
    output = getattr(response, "output", None)
    if not isinstance(output, list):
        return ""
    for item in output:
        content = item.get("content") if isinstance(item, dict) else getattr(item, "content", None)
        if not isinstance(content, list):
            continue
        for part in content:
            part_type = part.get("type") if isinstance(part, dict) else getattr(part, "type", None)
            text = part.get("text") if isinstance(part, dict) else getattr(part, "text", None)
            if part_type == "output_text" and isinstance(text, str):
                return text
    return ""

def _ensure_prompt_file() -> str:
    path = PROMPT_PATH
    parent = os.path.dirname(path)
    if parent and not os.path.exists(parent):
        os.makedirs(parent, exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(DEFAULT_PROMPT + "\n")
    return path

def _load_prompt_text() -> str:
    path = _ensure_prompt_file()
    global _prompt_cache, _prompt_mtime
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = None
    if _prompt_cache is not None and mtime is not None and _prompt_mtime == mtime:
        return _prompt_cache
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        text = DEFAULT_PROMPT
    text = text.strip()
    if not text:
        text = DEFAULT_PROMPT
    _prompt_cache = text
    _prompt_mtime = mtime
    return text

def _save_prompt_text(value: str) -> str:
    text = value.strip()
    if not text:
        raise ValueError("prompt_required")
    path = _ensure_prompt_file()
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text + "\n")
    global _prompt_cache, _prompt_mtime
    _prompt_cache = text
    try:
        _prompt_mtime = os.path.getmtime(path)
    except OSError:
        _prompt_mtime = None
    return text

def _build_instructions(user_name: str | None, extra: str | None) -> str:
    parts = [_load_prompt_text()]
    if isinstance(user_name, str) and user_name.strip():
        parts.append(f'The user name is "{user_name.strip()}".')
    if isinstance(extra, str) and extra.strip():
        parts.append(extra.strip())
    return "\n".join(parts)

def _parse_tool_args(raw: Any) -> dict[str, Any]:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return {}

def _normalize_tool_schema(schema: Any) -> dict[str, Any]:
    if isinstance(schema, dict):
        normalized = copy.deepcopy(schema)
    else:
        normalized = {}
    if normalized.get("type") is None:
        normalized["type"] = "object"
    if not isinstance(normalized.get("properties"), dict):
        normalized["properties"] = {}
    for key, prop in normalized["properties"].items():
        if not isinstance(prop, dict):
            normalized["properties"][key] = {"type": "string"}
            continue
        if not any(k in prop for k in ("type", "anyOf", "oneOf", "allOf")):
            prop["type"] = "object"
        if prop.get("type") == "object":
            if not isinstance(prop.get("properties"), dict):
                prop["properties"] = {}
            prop["additionalProperties"] = False
    normalized["additionalProperties"] = False
    return normalized

def _serialize_tool_result(result: Any) -> str:
    if result is None:
        return ""
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        return json.dumps(structured, ensure_ascii=False)
    content = getattr(result, "content", None)
    if isinstance(content, list):
        payload = []
        for block in content:
            if hasattr(block, "model_dump"):
                payload.append(block.model_dump())
            else:
                payload.append(block)
        return json.dumps(payload, ensure_ascii=False)
    return json.dumps(str(result), ensure_ascii=False)

def _extract_function_calls(output: Any) -> list[Any]:
    calls: list[Any] = []
    if not isinstance(output, list):
        return calls
    for item in output:
        item_type = item.get("type") if isinstance(item, dict) else getattr(item, "type", None)
        if item_type == "function_call":
            calls.append(item)
    return calls

def _tool_call_priority(call: Any) -> int:
    name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
    args_raw = call.get("arguments") if isinstance(call, dict) else getattr(call, "arguments", None)
    args = _parse_tool_args(args_raw)
    action = args.get("action") if isinstance(args, dict) else None
    if name == "edge" and action == "create":
        return 10
    return 0

def _prioritize_tool_calls(calls: list[Any]) -> list[Any]:
    indexed = list(enumerate(calls))
    indexed.sort(key=lambda pair: (_tool_call_priority(pair[1]), pair[0]))
    return [call for _, call in indexed]

@asynccontextmanager
async def mcp_session_context(mcp_config: MCPConfig | None, timeout_s: float | None):
    if not mcp_config or not mcp_config.url:
        yield None, []
        return
    headers: dict[str, str] = {}
    if mcp_config.token:
        headers["authorization"] = f"Bearer {mcp_config.token}"
    if mcp_config.sessionId:
        headers["x-session-id"] = mcp_config.sessionId
    if mcp_config.userId:
        headers["x-user-id"] = mcp_config.userId

    http_client = httpx.AsyncClient(headers=headers, timeout=timeout_s)
    async with http_client:
        async with streamable_http_client(mcp_config.url, http_client=http_client, terminate_on_close=True) as streams:
            read_stream, write_stream, _get_session_id = streams
            read_timeout = timedelta(seconds=timeout_s) if timeout_s else None
            async with ClientSession(read_stream, write_stream, read_timeout_seconds=read_timeout) as session:
                await session.initialize()
                tools_result = await session.list_tools()
                yield session, tools_result.tools

def _estimate_size(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, str):
        return len(value)
    try:
        return len(json.dumps(value, ensure_ascii=False))
    except Exception:
        return len(str(value))

def _safe_log_payload(value: Any, max_chars: int | None = None) -> str:
    limit = max_chars if isinstance(max_chars, int) and max_chars > 0 else LOG_TRUNCATE
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False)
        except Exception:
            text = str(value)
    if len(text) <= limit:
        return text
    return f"{text[:limit]}...(+{len(text) - limit} chars)"

def _normalize_model_name(model: str | None) -> str:
    if not isinstance(model, str):
        return ""
    return model.strip().lower()

def _resolve_model_context_tokens(model: str | None) -> int:
    override = AGENT_MODEL_CONTEXT_TOKENS or ASSISTANT_MODEL_CONTEXT_TOKENS
    if isinstance(override, int) and override > 0:
        return override
    normalized = _normalize_model_name(model)
    if not normalized:
        return 0
    if normalized in MODEL_CONTEXT_TOKENS:
        return MODEL_CONTEXT_TOKENS[normalized]
    if normalized.startswith("gpt-5.2"):
        return MODEL_CONTEXT_TOKENS.get("gpt-5.2", 0)
    return 0

def _get_encoder(model: str | None):
    normalized = _normalize_model_name(model)
    if normalized:
        try:
            return tiktoken.encoding_for_model(normalized)
        except KeyError:
            pass
    try:
        return tiktoken.get_encoding("o200k_base")
    except KeyError:
        return tiktoken.get_encoding("cl100k_base")

def _count_tokens(text: str | None, model: str | None) -> int:
    if not isinstance(text, str) or not text:
        return 0
    try:
        encoder = _get_encoder(model)
        return len(encoder.encode(text))
    except Exception:
        return max(1, len(text) // 4)

def _stringify_payload(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)

def _extract_text_chunks(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        chunks: list[str] = []
        for item in value:
            if isinstance(item, str):
                chunks.append(item)
                continue
            if isinstance(item, dict):
                content = item.get("content")
                if isinstance(content, str):
                    chunks.append(content)
                    continue
                if isinstance(content, list):
                    for part in content:
                        if isinstance(part, str):
                            chunks.append(part)
                        elif isinstance(part, dict):
                            text = part.get("text")
                            if isinstance(text, str):
                                chunks.append(text)
                            else:
                                chunks.append(_stringify_payload(part))
                        else:
                            chunks.append(_stringify_payload(part))
                    continue
            chunks.append(_stringify_payload(item))
        return chunks
    if isinstance(value, dict):
        content = value.get("content")
        if isinstance(content, str):
            return [content]
        if isinstance(content, list):
            chunks = []
            for part in content:
                if isinstance(part, str):
                    chunks.append(part)
                elif isinstance(part, dict):
                    text = part.get("text")
                    if isinstance(text, str):
                        chunks.append(text)
                    else:
                        chunks.append(_stringify_payload(part))
                else:
                    chunks.append(_stringify_payload(part))
            return chunks
        return [_stringify_payload(value)]
    return [str(value)]

def _calculate_context(model: str | None, instructions: str | None, input_value: Any, extra_chunks: list[str] | None = None) -> dict[str, Any]:
    chunks = []
    if isinstance(instructions, str) and instructions.strip():
        chunks.append(instructions)
    chunks.extend(_extract_text_chunks(input_value))
    if extra_chunks:
        for chunk in extra_chunks:
            if isinstance(chunk, str) and chunk:
                chunks.append(chunk)
    used_tokens = sum(_count_tokens(chunk, model) for chunk in chunks)
    max_tokens = _resolve_model_context_tokens(model)
    remaining = max(max_tokens - used_tokens, 0) if max_tokens else 0
    remaining_ratio = remaining / max_tokens if max_tokens else 0
    return {
        "maxTokens": max_tokens,
        "usedTokens": used_tokens,
        "remainingTokens": remaining,
        "remainingRatio": remaining_ratio,
    }


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}

@app.get("/prompt", response_model=PromptResponse)
async def get_prompt() -> PromptResponse:
    return PromptResponse(prompt=_load_prompt_text())

@app.post("/prompt", response_model=PromptResponse)
async def update_prompt(req: PromptUpdateRequest) -> PromptResponse:
    try:
        prompt = _save_prompt_text(req.prompt)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return PromptResponse(prompt=prompt)

@app.get("/prompt/ui", response_class=HTMLResponse)
async def prompt_ui() -> HTMLResponse:
    prompt = html.escape(_load_prompt_text())
    page = f"""
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Raven Prompt Editor</title>
  <style>
    :root {{
      color-scheme: light;
    }}
    body {{
      margin: 0;
      font-family: "IBM Plex Sans", "SF Pro Text", "Segoe UI", sans-serif;
      background: linear-gradient(135deg, #eef2f7, #f7f5f2);
      color: #1b1f2a;
    }}
    .wrap {{
      max-width: 920px;
      margin: 48px auto;
      padding: 0 20px 40px;
    }}
    .card {{
      background: #ffffff;
      border-radius: 18px;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
      border: 1px solid #e1e6ef;
      padding: 28px;
    }}
    h1 {{
      font-size: 22px;
      margin: 0 0 6px;
      letter-spacing: -0.01em;
    }}
    p {{
      margin: 0 0 18px;
      color: #4c5566;
    }}
    textarea {{
      width: 100%;
      min-height: 320px;
      resize: vertical;
      border-radius: 12px;
      border: 1px solid #d2d9e5;
      padding: 14px;
      font-size: 14px;
      font-family: "IBM Plex Mono", "SFMono-Regular", ui-monospace, monospace;
      line-height: 1.5;
      box-sizing: border-box;
      background: #f9fafc;
      color: #0f172a;
    }}
    .row {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 18px;
    }}
    button {{
      border: none;
      border-radius: 12px;
      padding: 10px 18px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      background: #111827;
      color: #ffffff;
    }}
    button[disabled] {{
      opacity: 0.6;
      cursor: not-allowed;
    }}
    .status {{
      font-size: 13px;
      color: #64748b;
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Raven Prompt Editor</h1>
      <p>Edit the system prompt used by the agent service.</p>
      <textarea id="prompt">{prompt}</textarea>
      <div class="row">
        <span class="status" id="status">Ready.</span>
        <button id="save">Save</button>
      </div>
    </div>
  </div>
  <script>
    const statusEl = document.getElementById('status');
    const saveBtn = document.getElementById('save');
    const promptEl = document.getElementById('prompt');

    const setStatus = (text) => {{
      statusEl.textContent = text;
    }};

    saveBtn.addEventListener('click', async () => {{
      const text = promptEl.value || '';
      if (!text.trim()) {{
        setStatus('Prompt cannot be empty.');
        return;
      }}
      saveBtn.disabled = true;
      setStatus('Saving...');
      try {{
        const res = await fetch('/prompt', {{
          method: 'POST',
          headers: {{ 'content-type': 'application/json' }},
          body: JSON.stringify({{ prompt: text }}),
        }});
        const body = await res.json().catch(() => ({{}}));
        if (!res.ok) {{
          setStatus(body?.detail || 'Save failed.');
          return;
        }}
        setStatus('Saved.');
      }} catch (err) {{
        setStatus('Save failed.');
      }} finally {{
        saveBtn.disabled = false;
      }}
    }});
  </script>
</body>
</html>
"""
    return HTMLResponse(content=page)

@app.post("/context", response_model=AgentContextResponse)
async def get_context(req: AgentContextRequest) -> AgentContextResponse:
    instructions = _build_instructions(req.userName, req.instructions)
    context = _calculate_context(req.model, instructions, req.input)
    return AgentContextResponse(context=context)


@app.post("/run", response_model=AgentRunResponse)
async def run_agent(req: AgentRunRequest) -> AgentRunResponse:
    if not req.apiKey or not req.apiKey.strip():
        raise HTTPException(status_code=400, detail="openai_key_required")

    run_id = str(uuid.uuid4())
    started = time.monotonic()
    input_size = _estimate_size(req.input)
    logger.info(
        "run_start id=%s model=%s maxTurns=%s inputSize=%s mcp=%s",
        run_id,
        req.model,
        req.maxTurns,
        input_size,
        "yes" if (req.mcp and req.mcp.url) else "no",
    )
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(
            "run_context id=%s apiKey=%s baseUrl=%s timeoutMs=%s temperature=%s",
            run_id,
            _mask_secret(req.apiKey),
            req.openaiBaseUrl,
            req.openaiTimeoutMs,
            req.temperature,
        )
        logger.debug("run_input id=%s payload=%s", run_id, _safe_log_payload(req.input))

    timeout = None
    if isinstance(req.openaiTimeoutMs, int) and req.openaiTimeoutMs > 0:
        timeout = req.openaiTimeoutMs / 1000

    client = AsyncOpenAI(
        api_key=req.apiKey,
        base_url=req.openaiBaseUrl or None,
        timeout=timeout,
    )

    allowed = []
    if req.mcp and req.mcp.allowedTools:
        allowed = [name for name in req.mcp.allowedTools if isinstance(name, str) and name.strip()]

    if req.mcp and req.mcp.url:
        logger.info(
            "mcp_config id=%s url=%s sessionId=%s allowedTools=%s",
            run_id,
            req.mcp.url,
            req.mcp.sessionId,
            len(allowed),
        )
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(
                "mcp_details id=%s token=%s allowed=%s",
                run_id,
                _mask_secret(req.mcp.token),
                allowed,
            )

    instructions = _build_instructions(req.userName, req.instructions)
    try:
        async with mcp_session_context(req.mcp, timeout) as (mcp_session, mcp_tools):
            function_tools = []
            if mcp_session:
                for tool in mcp_tools:
                    name = getattr(tool, "name", None)
                    if not isinstance(name, str) or not name:
                        continue
                    if allowed and name not in allowed:
                        continue
                    function_tools.append(
                        {
                            "type": "function",
                            "name": name,
                            "description": getattr(tool, "description", None),
                            "parameters": _normalize_tool_schema(getattr(tool, "inputSchema", None)),
                            "strict": False,
                        }
                    )
                logger.info(
                    "mcp_tools id=%s total=%s allowed=%s",
                    run_id,
                    len(mcp_tools),
                    len(function_tools),
                )

            tools_enabled = bool(function_tools)
            parse_kwargs: dict[str, Any] = {
                "model": req.model,
                "instructions": instructions,
                "input": req.input,
                "temperature": req.temperature,
                "tools": function_tools if tools_enabled else None,
                "parallel_tool_calls": tools_enabled,
                "text_format": AssistantResponse,
            }
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug(
                    "openai_request id=%s toolCount=%s",
                    run_id,
                    len(function_tools),
                )
            response = await client.responses.parse(**parse_kwargs)

            tool_output_chunks: list[str] = []
            last_context = _calculate_context(req.model, instructions, req.input)

            while mcp_session:
                tool_calls = _prioritize_tool_calls(_extract_function_calls(getattr(response, "output", None)))
                if not tool_calls:
                    break

                outputs = []
                for call in tool_calls:
                    call_id = call.get("call_id") if isinstance(call, dict) else getattr(call, "call_id", None)
                    name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
                    args_raw = call.get("arguments") if isinstance(call, dict) else getattr(call, "arguments", None)
                    if not call_id or not name:
                        continue
                    args = _parse_tool_args(args_raw)
                    result = await mcp_session.call_tool(name, args)
                    payload = {
                        "isError": bool(getattr(result, "isError", False)),
                        "content": json.loads(_serialize_tool_result(result) or "null"),
                    }
                    outputs.append(
                        {
                            "type": "function_call_output",
                            "call_id": call_id,
                            "output": json.dumps(payload, ensure_ascii=False),
                        }
                    )
                    serialized = _serialize_tool_result(result)
                    if serialized:
                        tool_output_chunks.append(serialized)
                        last_context = _calculate_context(req.model, req.instructions, req.input, tool_output_chunks)
                    if logger.isEnabledFor(logging.DEBUG):
                        logger.debug(
                            "tool_call id=%s name=%s args=%s error=%s",
                            run_id,
                            name,
                            _safe_log_payload(args),
                            payload["isError"],
                        )

                if not outputs:
                    break

                parse_kwargs = {
                    "model": req.model,
                    "instructions": instructions,
                    "input": outputs,
                    "temperature": req.temperature,
                    "tools": function_tools if tools_enabled else None,
                    "parallel_tool_calls": tools_enabled,
                    "text_format": AssistantResponse,
                    "previous_response_id": getattr(response, "id", None),
                }
                response = await client.responses.parse(**parse_kwargs)

            parsed = getattr(response, "output_parsed", None)
            output = ""
            if isinstance(parsed, AssistantResponse):
                output = parsed.message
            elif isinstance(parsed, dict) and isinstance(parsed.get("message"), str):
                output = parsed["message"]
            if not output:
                output = _extract_response_text(response)
            output = _format_output(output).strip()
            elapsed = int((time.monotonic() - started) * 1000)
            logger.info(
                "run_done id=%s ms=%s outputSize=%s lastResponseId=%s",
                run_id,
                elapsed,
                len(output),
                getattr(response, "id", None),
            )
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug("run_output id=%s payload=%s", run_id, _safe_log_payload(output))
                logger.debug(
                    "openai_response id=%s usage=%s outputTypes=%s",
                    run_id,
                    _safe_log_payload(getattr(response, "usage", None)),
                    _summarize_output_items(getattr(response, "output", None)),
                )
            extra_chunks = tool_output_chunks[:]
            if output:
                extra_chunks.append(output)
            context = _calculate_context(req.model, instructions, req.input, extra_chunks) if extra_chunks else last_context
            return AgentRunResponse(
                output=output,
                lastResponseId=getattr(response, "id", None),
                context=context,
            )
    except APIStatusError as exc:
        code = None
        message = str(exc)
        if isinstance(exc.body, dict):
            err = exc.body.get("error") or {}
            if isinstance(err, dict):
                code = err.get("code") or err.get("type")
                message = err.get("message") or message
        elapsed = int((time.monotonic() - started) * 1000)
        logger.error(
            "run_error id=%s ms=%s status=%s code=%s message=%s",
            run_id,
            elapsed,
            exc.status_code,
            code,
            message,
        )
        raise HTTPException(
            status_code=exc.status_code or 500,
            detail={"error": code or "openai_error", "message": message},
        ) from exc
