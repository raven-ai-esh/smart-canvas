import os
import subprocess
import time
from pathlib import Path

import httpx
import pytest


def load_env_file():
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip()


def get_db_key(email: str) -> str:
    container = os.getenv("DB_CONTAINER_NAME", "smart-tracker-db-1")
    safe_email = email.replace("'", "''")
    query = (
        "SELECT ok.api_key "
        "FROM openai_keys ok "
        "JOIN users u ON u.id = ok.user_id "
        f"WHERE lower(u.email) = '{safe_email}' "
        "LIMIT 1;"
    )
    cmd = [
        "docker",
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "smart_tracker",
        "-Atc",
        query,
    ]
    try:
        output = subprocess.check_output(cmd, text=True).strip()
    except subprocess.CalledProcessError as exc:
        raise AssertionError(f"failed to read OpenAI key from db: {exc}") from exc
    if not output:
        raise AssertionError("OpenAI key not found for test user")
    return output


def login_and_get_key(api_base: str, email: str, password: str) -> str:
    client = httpx.Client(base_url=api_base)
    login = client.post("/api/auth/login", json={"email": email, "password": password})
    assert login.status_code == 200, login.text
    return get_db_key(email)


def create_session(api_base: str) -> str:
    client = httpx.Client(base_url=api_base)
    resp = client.post("/api/sessions", json={"state": {"nodes": [], "edges": [], "drawings": [], "textBoxes": [], "comments": []}})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def fetch_session(api_base: str, session_id: str) -> dict:
    client = httpx.Client(base_url=api_base)
    resp = client.get(f"/api/sessions/{session_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_agent_creates_node_via_mcp():
    load_env_file()
    api_base = os.getenv("API_BASE_URL", "http://localhost:8080")
    agent_base = os.getenv("AGENT_BASE_URL", "http://localhost:8001")
    mcp_url = os.getenv("MCP_URL", "http://mcp:7010/mcp")
    mcp_token = os.getenv("MCP_TECH_TOKEN", "raven_tech_token")
    email = os.getenv("TEST_USER_EMAIL", "test@raven-ai.local").strip().lower()
    password = os.getenv("TEST_USER_PASSWORD", "test1234")

    api_key = login_and_get_key(api_base, email, password)
    session_id = create_session(api_base)
    title = f"MCP Integration {int(time.time())}"

    payload = {
        "apiKey": api_key,
        "model": os.getenv("OPENAI_MODEL", "gpt-5.2"),
        "userName": "Test User",
        "input": f"Create a node titled '{title}' at x=120, y=80 and confirm with 'done'.",
        "temperature": 0.2,
        "openaiTimeoutMs": 120000,
        "mcp": {
            "url": mcp_url,
            "token": mcp_token,
            "sessionId": session_id,
            "allowedTools": ["node"],
        },
    }

    async with httpx.AsyncClient(base_url=agent_base, timeout=180) as client:
        resp = await client.post("/run", json=payload)
    assert resp.status_code == 200, resp.text
    assert resp.json().get("output"), "assistant output missing"

    found = False
    for _ in range(6):
        state = fetch_session(api_base, session_id)
        nodes = state.get("state", {}).get("nodes", [])
        if any(node.get("title") == title for node in nodes):
            found = True
            break
        time.sleep(0.5)

    assert found, "node created by MCP not found in session state"
