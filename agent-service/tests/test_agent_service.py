import os
import types
import httpx
import json
import importlib.util
import sys
import tempfile
import builtins
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from openai import APIStatusError


APP_PATH = Path(__file__).resolve().parents[1] / "app.py"
PROMPT_DIR = Path(tempfile.mkdtemp(prefix="agent-prompt-"))
PROMPT_PATH = PROMPT_DIR / "prompt.txt"
os.environ["AGENT_PROMPT_PATH"] = str(PROMPT_PATH)


def load_app_module():
    os.environ.setdefault("AGENT_LOG_LEVEL", "DEBUG")
    os.environ.setdefault("AGENT_LOG_TRUNCATE", "2000")
    spec = importlib.util.spec_from_file_location("agent_app", APP_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules["agent_app"] = module
    spec.loader.exec_module(module)
    module.logger.setLevel(10)
    return module


app_mod = load_app_module()


class FakeResponse:
    def __init__(self, *, output_parsed=None, output_text=None, output=None, response_id="resp_test", usage=None):
        self.output_parsed = output_parsed
        self.output_text = output_text
        self.output = output or []
        self.id = response_id
        self.usage = usage


class FakeResponses:
    def __init__(self, *, result=None, results=None, error=None, capture=None):
        self._result = result
        self._results = list(results) if results is not None else None
        self._error = error
        self._capture = capture

    async def parse(self, **kwargs):
        if self._capture is not None:
            self._capture.update(kwargs)
        if self._error is not None:
            raise self._error
        if self._results is not None and self._results:
            return self._results.pop(0)
        return self._result


class FakeClient:
    def __init__(self, *, result=None, results=None, error=None, capture=None, **_kwargs):
        self.responses = FakeResponses(result=result, results=results, error=error, capture=capture)


class FakeTool:
    def __init__(self, name, description=None, input_schema=None):
        self.name = name
        self.description = description
        self.inputSchema = input_schema or {"type": "object", "properties": {}}


class FakeSession:
    def __init__(self):
        self.calls = []

    async def call_tool(self, name, args):
        self.calls.append((name, args))
        return types.SimpleNamespace(isError=False, structuredContent={"ok": True, "args": args})


@pytest.fixture
def fake_mcp_context():
    @asynccontextmanager
    async def _ctx(_config, _timeout):
        yield FakeSession(), [FakeTool("node", "create node")]

    return _ctx

@pytest.mark.asyncio
async def test_health():
    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_run_missing_key():
    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": " ",
            "model": "gpt-5.2",
            "instructions": "hi",
            "input": "hello",
        })
    assert resp.status_code == 400
    assert resp.json()["detail"] == "openai_key_required"


def test_helpers_cover_branches():
    assert app_mod._format_output("ok") == "ok"
    assert app_mod._format_output(123) == "123"
    assert app_mod._format_output(None) == ""

    assert app_mod._mask_secret("") == ""
    assert app_mod._mask_secret("abcd", keep=2) == "a...d"
    assert app_mod._mask_secret("0123456789", keep=2) == "01...89"

    assert app_mod._summarize_output_items("bad") == {}
    assert app_mod._summarize_output_items([{ "type": "mcp_call" }, { "type": "mcp_call" }]) == {"mcp_call": 2}

    assert app_mod._normalize_tool_schema(None) == {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    }
    assert app_mod._normalize_tool_schema({"type": "object", "properties": [], "additionalProperties": True}) == {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    }
    patch_schema = app_mod._normalize_tool_schema({"properties": {"patch": {}}})["properties"]["patch"]
    assert patch_schema["type"] == "object"
    assert patch_schema["additionalProperties"] is False
    assert app_mod._normalize_tool_schema({"properties": {"id": "raw"}})["properties"]["id"]["type"] == "string"

    class Obj:
        def __init__(self, t):
            self.type = t

    assert app_mod._summarize_output_items([Obj("foo"), Obj(None)]) == {"foo": 1, "unknown": 1}

    assert app_mod._estimate_size(None) == 0
    assert app_mod._estimate_size("abc") == 3
    assert app_mod._estimate_size({"a": 1}) > 0
    assert app_mod._estimate_size({"bad": set([1, 2])}) == len(str({"bad": set([1, 2])}))

    assert app_mod._safe_log_payload("short", max_chars=10) == "short"
    assert "..." in app_mod._safe_log_payload("x" * 20, max_chars=10)
    assert app_mod._safe_log_payload({"a": "b"}, max_chars=10).startswith("{")
    assert "..." in app_mod._safe_log_payload({"bad": set([1, 2])}, max_chars=10)

    assert app_mod._parse_tool_args("") == {}
    assert app_mod._parse_tool_args({"a": 1}) == {"a": 1}
    assert app_mod._parse_tool_args("{\"a\": 2}") == {"a": 2}
    assert app_mod._parse_tool_args("bad") == {}
    assert app_mod._parse_tool_args(123) == {}

    result = types.SimpleNamespace(structuredContent={"ok": True}, content=[{"text": "skip"}])
    assert json.loads(app_mod._serialize_tool_result(result)) == {"ok": True}

    class Block:
        def model_dump(self):
            return {"text": "hi"}

    result = types.SimpleNamespace(structuredContent=None, content=[Block()])
    assert json.loads(app_mod._serialize_tool_result(result)) == [{"text": "hi"}]

    result = types.SimpleNamespace(structuredContent=None, content=["plain"])
    assert json.loads(app_mod._serialize_tool_result(result)) == ["plain"]

    result = types.SimpleNamespace(structuredContent=None, content="nope")
    assert "nope" in json.loads(app_mod._serialize_tool_result(result))

    assert app_mod._serialize_tool_result(None) == ""

    calls = app_mod._extract_function_calls([{"type": "function_call", "name": "x"}])
    assert len(calls) == 1
    assert app_mod._extract_function_calls("bad") == []
    edge_call = {"name": "edge", "arguments": "{\"action\":\"create\"}"}
    node_call = {"name": "node", "arguments": "{\"action\":\"create\"}"}
    assert app_mod._tool_call_priority(edge_call) > app_mod._tool_call_priority(node_call)
    ordered = app_mod._prioritize_tool_calls([edge_call, node_call])
    assert ordered[0] is node_call

    assert app_mod._normalize_model_name(None) == ""
    assert app_mod._normalize_model_name(" GPT-5.2 ") == "gpt-5.2"
    old_agent = app_mod.AGENT_MODEL_CONTEXT_TOKENS
    old_assistant = app_mod.ASSISTANT_MODEL_CONTEXT_TOKENS
    app_mod.AGENT_MODEL_CONTEXT_TOKENS = 0
    app_mod.ASSISTANT_MODEL_CONTEXT_TOKENS = 0
    assert app_mod._resolve_model_context_tokens("gpt-5.2") == 400000
    app_mod.AGENT_MODEL_CONTEXT_TOKENS = 128
    assert app_mod._resolve_model_context_tokens("unknown") == 128
    app_mod.AGENT_MODEL_CONTEXT_TOKENS = 0
    app_mod.ASSISTANT_MODEL_CONTEXT_TOKENS = 256
    assert app_mod._resolve_model_context_tokens("unknown") == 256
    app_mod.AGENT_MODEL_CONTEXT_TOKENS = old_agent
    app_mod.ASSISTANT_MODEL_CONTEXT_TOKENS = old_assistant

    chunks = app_mod._extract_text_chunks([
        {"content": "hi"},
        {"content": [{"text": "part"}]},
        "raw",
        {"other": 1},
    ])
    assert "hi" in chunks
    assert "part" in chunks
    assert "raw" in chunks
    assert any("other" in chunk for chunk in chunks)

    assert app_mod._extract_text_chunks({"content": "solo"}) == ["solo"]
    assert app_mod._extract_text_chunks({"content": [{"text": "solo"}]}) == ["solo"]
    assert app_mod._extract_text_chunks(123) == ["123"]

    def _bad_encoder(_model):
        raise Exception("boom")

    original_get_encoder = app_mod._get_encoder
    app_mod._get_encoder = _bad_encoder
    assert app_mod._count_tokens("abcd", "gpt-5.2") == 1
    app_mod._get_encoder = original_get_encoder

    context = app_mod._calculate_context("gpt-5.2", "hello", [{"content": "world"}], ["done"])
    assert context["usedTokens"] > 0


def test_extract_response_text_variants():
    class OutputText:
        output_text = "inline"

    assert app_mod._extract_response_text(OutputText()) == "inline"

    response = FakeResponse(output=[{"content": [{"type": "output_text", "text": "nested"}]}])
    assert app_mod._extract_response_text(response) == "nested"

    response = FakeResponse(output=[{"content": [{"type": "other", "text": "skip"}]}])
    assert app_mod._extract_response_text(response) == ""
    class NoOutput:
        pass
    assert app_mod._extract_response_text(NoOutput()) == ""
    response = FakeResponse(output=None)
    assert app_mod._extract_response_text(response) == ""
    response = FakeResponse(output=[{"content": "not-a-list"}])
    assert app_mod._extract_response_text(response) == ""


def test_context_helper_branches(monkeypatch):
    old_agent = app_mod.AGENT_MODEL_CONTEXT_TOKENS
    old_assistant = app_mod.ASSISTANT_MODEL_CONTEXT_TOKENS
    app_mod.AGENT_MODEL_CONTEXT_TOKENS = 0
    app_mod.ASSISTANT_MODEL_CONTEXT_TOKENS = 0
    assert app_mod._resolve_model_context_tokens(None) == 0
    assert app_mod._resolve_model_context_tokens("gpt-5.2-mini") == 400000
    assert app_mod._resolve_model_context_tokens("unknown") == 0
    app_mod.AGENT_MODEL_CONTEXT_TOKENS = old_agent
    app_mod.ASSISTANT_MODEL_CONTEXT_TOKENS = old_assistant

    class FakeEncoder:
        def encode(self, text):
            return list(text)

    def fake_encoding_for_model(_model):
        raise KeyError("missing")

    def fake_get_encoding(name):
        if name == "o200k_base":
            raise KeyError("missing")
        return FakeEncoder()

    monkeypatch.setattr(app_mod.tiktoken, "encoding_for_model", fake_encoding_for_model)
    monkeypatch.setattr(app_mod.tiktoken, "get_encoding", fake_get_encoding)
    encoder = app_mod._get_encoder("unknown-model")
    assert isinstance(encoder, FakeEncoder)

    assert app_mod._count_tokens("", "gpt-5.2") == 0
    assert app_mod._stringify_payload("raw") == "raw"
    assert app_mod._stringify_payload(set([1, 2])).startswith("{")

    assert app_mod._extract_text_chunks(None) == []
    assert "textpart" in app_mod._extract_text_chunks([{"content": ["textpart"]}])
    chunks = app_mod._extract_text_chunks([{"content": [{"text": 123}, 456]}])
    assert any("123" in chunk for chunk in chunks)
    assert any("456" in chunk for chunk in chunks)

    dict_chunks = app_mod._extract_text_chunks({"content": ["alpha", {"text": 7}, 8]})
    assert "alpha" in dict_chunks
    assert any("7" in chunk for chunk in dict_chunks)
    assert any("8" in chunk for chunk in dict_chunks)
    assert app_mod._extract_text_chunks({"content": None, "other": 1}) == [app_mod._stringify_payload({"content": None, "other": 1})]


def test_prompt_file_creation_in_new_dir(tmp_path):
    original_path = app_mod.PROMPT_PATH
    original_cache = app_mod._prompt_cache
    original_mtime = app_mod._prompt_mtime
    new_path = tmp_path / "nested" / "prompt.txt"
    app_mod.PROMPT_PATH = str(new_path)
    app_mod._prompt_cache = None
    app_mod._prompt_mtime = None
    try:
        prompt = app_mod._load_prompt_text()
        assert "Raven" in prompt
        assert new_path.exists()
    finally:
        app_mod.PROMPT_PATH = original_path
        app_mod._prompt_cache = original_cache
        app_mod._prompt_mtime = original_mtime


def test_prompt_load_falls_back_on_empty(tmp_path):
    original_path = app_mod.PROMPT_PATH
    original_cache = app_mod._prompt_cache
    original_mtime = app_mod._prompt_mtime
    path = tmp_path / "prompt.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("   ")
    app_mod.PROMPT_PATH = str(path)
    app_mod._prompt_cache = None
    app_mod._prompt_mtime = None
    try:
        prompt = app_mod._load_prompt_text()
        assert "Raven" in prompt
    finally:
        app_mod.PROMPT_PATH = original_path
        app_mod._prompt_cache = original_cache
        app_mod._prompt_mtime = original_mtime


def test_prompt_load_handles_getmtime_error(monkeypatch, tmp_path):
    original_path = app_mod.PROMPT_PATH
    original_cache = app_mod._prompt_cache
    original_mtime = app_mod._prompt_mtime
    path = tmp_path / "prompt.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("Hello")
    app_mod.PROMPT_PATH = str(path)
    app_mod._prompt_cache = None
    app_mod._prompt_mtime = None
    monkeypatch.setattr(app_mod.os.path, "getmtime", lambda _path: (_ for _ in ()).throw(OSError("boom")))
    try:
        prompt = app_mod._load_prompt_text()
        assert "Hello" in prompt
    finally:
        app_mod.PROMPT_PATH = original_path
        app_mod._prompt_cache = original_cache
        app_mod._prompt_mtime = original_mtime


def test_prompt_load_handles_read_error(monkeypatch, tmp_path):
    original_path = app_mod.PROMPT_PATH
    original_cache = app_mod._prompt_cache
    original_mtime = app_mod._prompt_mtime
    path = tmp_path / "prompt.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("Hello")
    app_mod.PROMPT_PATH = str(path)
    app_mod._prompt_cache = None
    app_mod._prompt_mtime = None
    monkeypatch.setattr(app_mod, "_ensure_prompt_file", lambda: str(path))
    monkeypatch.setattr(builtins, "open", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("boom")))
    try:
        prompt = app_mod._load_prompt_text()
        assert "Raven" in prompt
    finally:
        app_mod.PROMPT_PATH = original_path
        app_mod._prompt_cache = original_cache
        app_mod._prompt_mtime = original_mtime


def test_prompt_save_handles_getmtime_error(monkeypatch, tmp_path):
    original_path = app_mod.PROMPT_PATH
    original_cache = app_mod._prompt_cache
    original_mtime = app_mod._prompt_mtime
    path = tmp_path / "prompt.txt"
    app_mod.PROMPT_PATH = str(path)
    app_mod._prompt_cache = None
    app_mod._prompt_mtime = None
    monkeypatch.setattr(app_mod.os.path, "getmtime", lambda _path: (_ for _ in ()).throw(OSError("boom")))
    try:
        saved = app_mod._save_prompt_text("Hello")
        assert saved == "Hello"
        assert app_mod._prompt_mtime is None
    finally:
        app_mod.PROMPT_PATH = original_path
        app_mod._prompt_cache = original_cache
        app_mod._prompt_mtime = original_mtime


@pytest.mark.asyncio
async def test_run_success_with_parsed_response(monkeypatch):
    capture = {}
    result = FakeResponse(output_parsed=app_mod.AssistantResponse(message="hi"), response_id="resp_1")
    monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(result=result, capture=capture, **kwargs))

    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": "sk-test",
            "model": "gpt-5.2",
            "input": "hello",
            "maxTurns": 3,
            "openaiTimeoutMs": 1500,
        })

    assert resp.status_code == 200
    assert resp.json()["output"] == "hi"
    assert resp.json()["context"]["maxTokens"] == 400000


@pytest.mark.asyncio
async def test_run_success_with_dict_parsed(monkeypatch):
    result = FakeResponse(output_parsed={"message": "dict"}, response_id="resp_2")
    monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(result=result, **kwargs))

    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": "sk-test",
            "model": "gpt-5.2",
            "instructions": "hi",
            "input": "hello",
        })

    assert resp.status_code == 200
    assert resp.json()["output"] == "dict"


@pytest.mark.asyncio
async def test_run_fallback_to_output_text(monkeypatch):
    result = FakeResponse(output_parsed=None, output_text="fallback", response_id="resp_3")
    monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(result=result, **kwargs))

    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": "sk-test",
            "model": "gpt-5.2",
            "instructions": "hi",
            "input": "hello",
        })

    assert resp.status_code == 200
    assert resp.json()["output"] == "fallback"


@pytest.mark.asyncio
async def test_run_with_mcp_tool_config(monkeypatch, fake_mcp_context):
    capture = {}
    result = FakeResponse(output_parsed=app_mod.AssistantResponse(message="ok"), response_id="resp_4")
    monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(result=result, capture=capture, **kwargs))
    monkeypatch.setattr(app_mod, "mcp_session_context", fake_mcp_context)

    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": "sk-test",
            "model": "gpt-5.2",
            "instructions": "hi",
            "input": "hello",
            "mcp": {
                "url": "http://mcp",
                "token": "mcp_token",
                "sessionId": "session-123",
                "allowedTools": ["node", "  ", "edge"],
            },
        })

    assert resp.status_code == 200
    tools = capture.get("tools")
    assert tools and tools[0]["type"] == "function"
    assert tools[0]["name"] == "node"


@pytest.mark.asyncio
async def test_run_handles_api_status_error(monkeypatch):
    response = httpx.Response(
        401,
        request=httpx.Request("POST", "https://api.openai.com/v1/responses"),
        json={"error": {"message": "bad key", "code": "invalid_api_key"}},
    )
    err = APIStatusError("bad key", response=response, body={"error": {"message": "bad key", "code": "invalid_api_key"}})
    monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(error=err, **kwargs))

    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": "sk-test",
            "model": "gpt-5.2",
            "instructions": "hi",
            "input": "hello",
        })

    assert resp.status_code == 401
    detail = resp.json()["detail"]
    assert detail["error"] == "invalid_api_key"
    assert detail["message"] == "bad key"


@pytest.mark.asyncio
async def test_run_tool_loop_executes_calls(monkeypatch):
    session = FakeSession()

    @asynccontextmanager
    async def _ctx(_config, _timeout):
        yield session, [FakeTool("node", "create node")]

    first = FakeResponse(
        output=[
            {
                "type": "function_call",
                "call_id": "call_1",
                "name": "node",
                "arguments": "{\"title\": \"Test\", \"x\": 1, \"y\": 2}",
            }
        ],
        response_id="resp_1",
    )
    second = FakeResponse(output_parsed=app_mod.AssistantResponse(message="done"), response_id="resp_2")
    monkeypatch.setattr(app_mod, "mcp_session_context", _ctx)
    monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(results=[first, second], **kwargs))

    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": "sk-test",
            "model": "gpt-5.2",
            "instructions": "hi",
            "input": "hello",
            "mcp": {
                "url": "http://mcp",
                "sessionId": "session-123",
                "allowedTools": ["node"],
            },
        })

    assert resp.status_code == 200
    assert resp.json()["output"] == "done"
    assert session.calls == [("node", {"title": "Test", "x": 1, "y": 2})]


@pytest.mark.asyncio
async def test_run_tool_loop_exhausts_calls(monkeypatch):
    session = FakeSession()

    @asynccontextmanager
    async def _ctx(_config, _timeout):
        yield session, [FakeTool("node", "create node")]

    first = FakeResponse(
        output=[
            {"type": "function_call", "call_id": "call_1", "name": "node", "arguments": "{}"},
            {"type": "function_call", "call_id": "call_2", "name": "node", "arguments": "{}"},
        ],
        response_id="resp_exhaust_1",
    )
    second = FakeResponse(
        output_text="exhausted",
        response_id="resp_exhaust_2",
    )
    monkeypatch.setattr(app_mod, "mcp_session_context", _ctx)
    monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(results=[first, second], **kwargs))

    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": "sk-test",
            "model": "gpt-5.2",
            "instructions": "hi",
            "input": "hello",
            "maxTurns": 1,
            "mcp": {"url": "http://mcp"},
        })

    assert resp.status_code == 200
    assert resp.json()["output"] == "exhausted"
    assert session.calls == [("node", {}), ("node", {})]


@pytest.mark.asyncio
async def test_context_endpoint():
    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/context", json={
            "model": "gpt-5.2",
            "input": [{"content": "Hello"}],
        })
    assert resp.status_code == 200
    context = resp.json()["context"]
    assert context["maxTokens"] == 400000
    assert context["usedTokens"] > 0


@pytest.mark.asyncio
async def test_run_tool_loop_limit(monkeypatch):
    session = FakeSession()

    @asynccontextmanager
    async def _ctx(_config, _timeout):
        yield session, [FakeTool("node", "create node")]

    first = FakeResponse(
        output=[
            {
                "type": "function_call",
                "call_id": "call_1",
                "name": "node",
                "arguments": "{\"title\": \"Test\"}",
            }
        ],
        response_id="resp_1",
    )
    second = FakeResponse(
        output_text="limit",
        response_id="resp_2",
    )
    monkeypatch.setattr(app_mod, "mcp_session_context", _ctx)
    monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(results=[first, second], **kwargs))

    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": "sk-test",
            "model": "gpt-5.2",
            "instructions": "hi",
            "input": "hello",
            "maxTurns": 0,
            "mcp": {
                "url": "http://mcp",
            },
        })

    assert resp.status_code == 200
    assert resp.json()["output"] == "limit"
    assert session.calls == [("node", {"title": "Test"})]


@pytest.mark.asyncio
async def test_run_tool_loop_skips_invalid_calls(monkeypatch):
    session = FakeSession()

    @asynccontextmanager
    async def _ctx(_config, _timeout):
        yield session, [FakeTool("node", "create node")]

    response = FakeResponse(
        output=[{"type": "function_call", "name": "node", "arguments": "{}"}],
        output_text="skip",
        response_id="resp_1",
    )
    monkeypatch.setattr(app_mod, "mcp_session_context", _ctx)
    monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(result=response, **kwargs))

    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": "sk-test",
            "model": "gpt-5.2",
            "instructions": "hi",
            "input": "hello",
            "mcp": {
                "url": "http://mcp",
            },
        })

    assert resp.status_code == 200
    assert resp.json()["output"] == "skip"
    assert session.calls == []


@pytest.mark.asyncio
async def test_run_filters_mcp_tools(monkeypatch):
    tools = [FakeTool(None), FakeTool("node")]
    session = FakeSession()

    @asynccontextmanager
    async def _ctx(_config, _timeout):
        yield session, tools

    capture = {}
    result = FakeResponse(output_parsed=app_mod.AssistantResponse(message="ok"), response_id="resp_filter")
    monkeypatch.setattr(app_mod, "mcp_session_context", _ctx)
    monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(result=result, capture=capture, **kwargs))

    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/run", json={
            "apiKey": "sk-test",
            "model": "gpt-5.2",
            "instructions": "hi",
            "input": "hello",
            "mcp": {
                "url": "http://mcp",
                "allowedTools": ["edge"],
            },
        })

    assert resp.status_code == 200
    assert capture.get("tools") is None


@pytest.mark.asyncio
async def test_mcp_session_context_no_config():
    async with app_mod.mcp_session_context(None, None) as (session, tools):
        assert session is None
        assert tools == []


@pytest.mark.asyncio
async def test_mcp_session_context_with_fake_stream(monkeypatch):
    captured_headers = {}
    class DummySession:
        def __init__(self, _read, _write, read_timeout_seconds=None):
            self.initialized = False

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def initialize(self):
            self.initialized = True

        async def list_tools(self):
            return types.SimpleNamespace(tools=[FakeTool("node")])

    @asynccontextmanager
    async def fake_streamable_http_client(_url, http_client=None, terminate_on_close=True):
        if http_client is not None:
            captured_headers.update(dict(http_client.headers))
        yield (None, None, None)

    monkeypatch.setattr(app_mod, "ClientSession", DummySession)
    monkeypatch.setattr(app_mod, "streamable_http_client", fake_streamable_http_client)

    config = app_mod.MCPConfig(url="http://mcp", token="tok", sessionId="sid", userId="user-1")
    async with app_mod.mcp_session_context(config, 1.0) as (session, tools):
        assert session is not None
        assert tools and tools[0].name == "node"
        assert captured_headers.get("x-user-id") == "user-1"


@pytest.mark.asyncio
async def test_prompt_endpoints():
    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        initial = await client.get("/prompt")
        assert initial.status_code == 200
        original = initial.json()["prompt"]
        assert "Raven" in original

        updated = "You are Raven. Stay concise."
        resp = await client.post("/prompt", json={"prompt": updated})
        assert resp.status_code == 200
        assert resp.json()["prompt"] == updated

        reread = await client.get("/prompt")
        assert reread.status_code == 200
        assert reread.json()["prompt"] == updated

        ui = await client.get("/prompt/ui")
        assert ui.status_code == 200
        assert "<textarea" in ui.text

        reset = await client.post("/prompt", json={"prompt": original})
        assert reset.status_code == 200


@pytest.mark.asyncio
async def test_prompt_update_rejects_empty():
    transport = httpx.ASGITransport(app=app_mod.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/prompt", json={"prompt": "  "})
    assert resp.status_code == 400
    assert resp.json()["detail"] == "prompt_required"


@pytest.mark.asyncio
async def test_run_builds_instructions_with_prompt(monkeypatch):
    capture = {}
    original = app_mod._load_prompt_text()
    app_mod._save_prompt_text("Base prompt.")
    try:
        result = FakeResponse(output_parsed=app_mod.AssistantResponse(message="ok"), response_id="resp_9")
        monkeypatch.setattr(app_mod, "AsyncOpenAI", lambda **kwargs: FakeClient(result=result, capture=capture, **kwargs))

        transport = httpx.ASGITransport(app=app_mod.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/run", json={
                "apiKey": "sk-test",
                "model": "gpt-5.2",
                "input": "hello",
                "userName": "Ada",
                "instructions": "Extra.",
            })
    finally:
        app_mod._save_prompt_text(original)

    assert resp.status_code == 200
    built = capture.get("instructions", "")
    assert "Base prompt." in built
    assert 'The user name is "Ada".' in built
    assert "Extra." in built
