from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
import asyncio
import json
import logging
import os
import re
import time
import uuid

import asyncpg
from fastapi import FastAPI, HTTPException
from openai import APIStatusError, AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field
import httpx

LOG_LEVEL = os.getenv("SKILLS_LOG_LEVEL", os.getenv("LOG_LEVEL", "INFO")).upper()
logging.basicConfig(level=LOG_LEVEL)
logger = logging.getLogger("skills")

DATABASE_URL = os.getenv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/smart_tracker")
AGENT_SERVICE_URL = os.getenv("AGENT_SERVICE_URL", "http://agent:8001/run")
AGENT_SERVICE_TIMEOUT_MS = int(os.getenv("AGENT_SERVICE_TIMEOUT_MS", "600000"))
OPENAI_API_BASE_URL = os.getenv("OPENAI_API_BASE_URL", "https://api.openai.com/v1")
OPENAI_EMBEDDING_MODEL = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
OPENAI_TIMEOUT_MS = int(os.getenv("OPENAI_TIMEOUT_MS", "30000"))
OPENAI_EMBEDDING_DIM = int(os.getenv("OPENAI_EMBEDDING_DIM", "1536"))
SKILLS_MATCH_THRESHOLD = float(os.getenv("SKILLS_MATCH_THRESHOLD", "0.25"))
SKILLS_MATCH_SIMILARITY_THRESHOLD = float(os.getenv("SKILLS_MATCH_SIMILARITY_THRESHOLD", "0.75"))
SKILLS_MERGE_SIMILARITY_THRESHOLD = float(os.getenv("SKILLS_MERGE_SIMILARITY_THRESHOLD", "0.75"))
SKILLS_MERGE_SIMILARITY_EPS = float(os.getenv("SKILLS_MERGE_SIMILARITY_EPS", "0.05"))
SKILLS_GENERALIZATION_THRESHOLD = float(os.getenv("SKILLS_GENERALIZATION_THRESHOLD", "0.75"))
SKILLS_MAX_STEPS = int(os.getenv("SKILLS_MAX_STEPS", "8"))
SKILLS_MAX_PARAMETERS = int(os.getenv("SKILLS_MAX_PARAMETERS", "12"))
SKILLS_MAX_PRECONDITIONS = int(os.getenv("SKILLS_MAX_PRECONDITIONS", "8"))
SKILLS_MAX_SUCCESS_CRITERIA = int(os.getenv("SKILLS_MAX_SUCCESS_CRITERIA", "8"))
SKILLS_MAX_EXAMPLES = int(os.getenv("SKILLS_MAX_EXAMPLES", "6"))
SKILLS_MIN_NAME_LEN = 3

VECTOR_ENABLED = False
POOL: asyncpg.Pool | None = None


class MCPConfig(BaseModel):
    model_config = ConfigDict(extra="allow")

    url: str | None = None
    token: str | None = None
    sessionId: str | None = None
    userId: str | None = None
    allowedTools: list[str] | None = None


class SkillRunRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    apiKey: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    input: str | list[dict[str, Any]]
    instructions: str | None = None
    userName: str | None = None
    userId: str | None = None
    threadId: str | None = None
    sessionId: str | None = None
    temperature: float | None = 0.3
    openaiBaseUrl: str | None = None
    openaiTimeoutMs: int | None = None
    webSearchEnabled: bool | None = None
    mcp: MCPConfig | None = None


class SkillRunResponse(BaseModel):
    output: str
    lastResponseId: str | None = None
    context: dict[str, Any] | None = None
    trace: dict[str, Any] | None = None
    skill: dict[str, Any] | None = None


class SkillFeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    apiKey: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    userId: str = Field(..., min_length=1)
    runId: str = Field(..., min_length=1)
    rating: Literal["positive", "neutral", "negative"]
    feedback: str | None = None
    openaiBaseUrl: str | None = None


class SkillFeedbackResponse(BaseModel):
    runId: str
    updated: bool
    skillId: str | None = None
    skillVersionId: str | None = None
    newVersionId: str | None = None


class SkillStep(BaseModel):
    title: str
    instructions: str
    notes: str | None = None


class SkillParameter(BaseModel):
    name: str
    description: str
    example: str | None = None


class SkillExample(BaseModel):
    userInput: str
    outputSummary: str | None = None
    notes: str | None = None
    runId: str | None = None


class SkillDefinition(BaseModel):
    name: str
    description: str
    entrypoint: str
    steps: list[SkillStep]


class GeneralizedSkillDefinition(BaseModel):
    name: str
    description: str
    entrypoint: str
    steps: list[SkillStep]
    parameters: list[SkillParameter] | None = None
    preconditions: list[str] | None = None
    successCriteria: list[str] | None = None
    examples: list[SkillExample] | None = None
    generalizationScore: float | None = None
    rationale: str | None = None


class SkillFix(BaseModel):
    steps: list[SkillStep]
    rationale: str | None = None


@dataclass
class SkillRecord:
    id: str
    name: str
    description: str | None
    entrypoint_text: str
    active_version_id: str | None
    parameters: list[dict[str, Any]] | None
    preconditions: list[str] | None
    success_criteria: list[str] | None
    examples: list[dict[str, Any]] | None
    generalization_score: float | None
    embedding: list[float] | None = None


@dataclass
class SkillVersionRecord:
    id: str
    skill_id: str
    version: int
    steps: list[dict[str, Any]]


@dataclass
class AgentResult:
    output: str
    context: dict[str, Any] | None
    trace: dict[str, Any] | None
    last_response_id: str | None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global POOL, VECTOR_ENABLED
    POOL = await asyncpg.create_pool(DATABASE_URL)
    VECTOR_ENABLED = await _detect_vector_extension(POOL)
    logger.info("skills_ready vector=%s", "yes" if VECTOR_ENABLED else "no")
    yield
    if POOL:
        await POOL.close()


app = FastAPI(lifespan=lifespan)


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _clamp_text(value: str, max_len: int) -> str:
    trimmed = value.strip()
    if not trimmed:
        return ""
    return trimmed[:max_len]


def _normalize_input_items(raw: str | list[dict[str, Any]]) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, str):
        return [{"role": "user", "content": raw}]
    return []


def _extract_last_user_message(items: list[dict[str, Any]]) -> str:
    for item in reversed(items):
        if item.get("role") == "user" and isinstance(item.get("content"), str):
            return item["content"]
    return ""


def _to_vector_literal(embedding: list[float]) -> str:
    return "[" + ",".join(str(float(val) if isinstance(val, (int, float)) else 0.0) for val in embedding) + "]"


def _normalize_embedding(raw: Any) -> list[float]:
    if raw is None:
        return []
    if isinstance(raw, list):
        values = []
        for item in raw:
            if isinstance(item, (int, float)):
                values.append(float(item))
            elif isinstance(item, str):
                try:
                    values.append(float(item))
                except ValueError:
                    continue
        return values
    if isinstance(raw, str):
        trimmed = raw.strip()
        if trimmed.startswith("[") and trimmed.endswith("]"):
            trimmed = trimmed[1:-1]
        if not trimmed:
            return []
        parts = [part.strip() for part in trimmed.split(",")]
        values = []
        for part in parts:
            try:
                values.append(float(part))
            except ValueError:
                continue
        return values
    return []


def _cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    if not vec_a or not vec_b:
        return 0.0
    dot = 0.0
    norm_a = 0.0
    norm_b = 0.0
    for a, b in zip(vec_a, vec_b):
        dot += a * b
        norm_a += a * a
        norm_b += b * b
    if norm_a <= 0.0 or norm_b <= 0.0:
        return 0.0
    return dot / (norm_a ** 0.5 * norm_b ** 0.5)


def _summarize_tool_trace(trace: dict[str, Any] | None) -> str:
    if not trace or not isinstance(trace, dict):
        return ""
    tools = trace.get("tools")
    if not isinstance(tools, list) or not tools:
        return ""
    names = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if isinstance(name, str) and name:
            names.append(name)
    if not names:
        return ""
    return ", ".join(names[:20])


def _format_steps_for_prompt(steps: list[dict[str, Any]]) -> str:
    lines = []
    for idx, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        title = str(step.get("title") or f"Step {idx + 1}").strip()
        instructions = str(step.get("instructions") or "").strip()
        if not instructions:
            continue
        lines.append(f"{idx + 1}. {title}: {instructions}")
    return "\n".join(lines)


def _format_step_results_for_prompt(results: list[dict[str, Any]]) -> str:
    lines = []
    for item in results:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "Step").strip()
        output = str(item.get("output") or "").strip()
        if not output:
            continue
        lines.append(f"- {title}: {_clamp_text(output, 800)}")
    return "\n".join(lines)


def _normalize_skill_definition(defn: SkillDefinition, fallback_entrypoint: str) -> SkillDefinition:
    name = _clamp_text(defn.name, 120)
    if len(name) < SKILLS_MIN_NAME_LEN:
        name = "Raven skill"
    description = _clamp_text(defn.description or "", 360)
    entrypoint = _clamp_text(defn.entrypoint or fallback_entrypoint, 800)
    steps = defn.steps or []
    trimmed_steps: list[SkillStep] = []
    for step in steps[:SKILLS_MAX_STEPS]:
        title = _clamp_text(step.title, 140) or "Step"
        instructions = _clamp_text(step.instructions, 2000)
        if not instructions:
            continue
        notes = _clamp_text(step.notes or "", 800) or None
        trimmed_steps.append(SkillStep(title=title, instructions=instructions, notes=notes))
    if not trimmed_steps:
        trimmed_steps = [SkillStep(title="Solve request", instructions="Provide the solution in full.")]
    return SkillDefinition(
        name=name,
        description=description or "Reusable skill generated from a solved request.",
        entrypoint=entrypoint or fallback_entrypoint,
        steps=trimmed_steps,
    )


def _normalize_parameter_name(value: str) -> str:
    trimmed = value.strip()
    if trimmed.startswith("{") and trimmed.endswith("}"):
        trimmed = trimmed[1:-1].strip()
    trimmed = re.sub(r"\s+", "_", trimmed)
    trimmed = trimmed.strip("_")
    return _clamp_text(trimmed, 60)


def _normalize_string_list(value: Any, *, max_items: int, max_len: int) -> list[str]:
    raw_items: list[Any] = []
    if isinstance(value, list):
        raw_items = value
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                raw_items = parsed
            else:
                raw_items = re.split(r"[\\n;]+", value)
        except json.JSONDecodeError:
            raw_items = re.split(r"[\\n;]+", value)
    items: list[str] = []
    for raw in raw_items:
        if not isinstance(raw, str):
            continue
        trimmed = _clamp_text(raw, max_len)
        if not trimmed:
            continue
        items.append(trimmed)
        if len(items) >= max_items:
            break
    return items


def _normalize_parameters(value: Any) -> list[dict[str, Any]]:
    raw_items: list[Any] = []
    if isinstance(value, list):
        raw_items = value
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                raw_items = parsed
        except json.JSONDecodeError:
            raw_items = []
    if not raw_items:
        return []
    params: list[dict[str, Any]] = []
    for raw in raw_items[:SKILLS_MAX_PARAMETERS]:
        if not isinstance(raw, dict):
            continue
        name_raw = raw.get("name")
        if not isinstance(name_raw, str):
            continue
        name = _normalize_parameter_name(name_raw)
        if not name:
            continue
        description = _clamp_text(str(raw.get("description") or ""), 260)
        if not description:
            continue
        example = _clamp_text(str(raw.get("example") or ""), 260) or None
        params.append({"name": name, "description": description, "example": example})
    return params


def _normalize_examples(value: Any, fallback: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    raw_items: list[Any] = []
    if isinstance(value, list):
        raw_items = value
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                raw_items = parsed
        except json.JSONDecodeError:
            raw_items = []
    examples: list[dict[str, Any]] = []
    seen_inputs: set[str] = set()
    for raw in raw_items:
        if isinstance(raw, str):
            raw = {"userInput": raw}
        if not isinstance(raw, dict):
            continue
        user_input = _clamp_text(str(raw.get("userInput") or ""), 900)
        if not user_input:
            continue
        if user_input in seen_inputs:
            continue
        output_summary = _clamp_text(str(raw.get("outputSummary") or ""), 1400) or None
        notes = _clamp_text(str(raw.get("notes") or ""), 800) or None
        run_id = _clamp_text(str(raw.get("runId") or ""), 80) or None
        examples.append({
            "userInput": user_input,
            "outputSummary": output_summary,
            "notes": notes,
            "runId": run_id,
        })
        seen_inputs.add(user_input)
        if len(examples) >= SKILLS_MAX_EXAMPLES:
            break
    if fallback:
        fallback_input = _clamp_text(str(fallback.get("userInput") or ""), 900)
        if fallback_input and fallback_input not in seen_inputs and len(examples) < SKILLS_MAX_EXAMPLES:
            fallback_output = _clamp_text(str(fallback.get("outputSummary") or ""), 1400) or None
            fallback_notes = _clamp_text(str(fallback.get("notes") or ""), 800) or None
            fallback_run = _clamp_text(str(fallback.get("runId") or ""), 80) or None
            examples.append({
                "userInput": fallback_input,
                "outputSummary": fallback_output,
                "notes": fallback_notes,
                "runId": fallback_run,
            })
    return examples


def _merge_parameters(existing: list[dict[str, Any]] | None, incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for param in incoming + (existing or []):
        if not isinstance(param, dict):
            continue
        name = param.get("name")
        if not isinstance(name, str):
            continue
        if name in seen:
            continue
        seen.add(name)
        merged.append(param)
        if len(merged) >= SKILLS_MAX_PARAMETERS:
            break
    return merged


def _merge_string_lists(
    existing: list[str] | None,
    incoming: list[str],
    *,
    max_items: int,
    max_len: int,
) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for item in incoming + (existing or []):
        if not isinstance(item, str):
            continue
        trimmed = _clamp_text(item, max_len)
        if not trimmed:
            continue
        key = trimmed.lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(trimmed)
        if len(merged) >= max_items:
            break
    return merged


def _merge_examples(existing: list[dict[str, Any]] | None, incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in incoming + (existing or []):
        if not isinstance(item, dict):
            continue
        user_input = item.get("userInput")
        if not isinstance(user_input, str):
            continue
        if user_input in seen:
            continue
        seen.add(user_input)
        merged.append(item)
        if len(merged) >= SKILLS_MAX_EXAMPLES:
            break
    return merged


def _count_placeholders(text: str) -> int:
    return len(re.findall(r"\\{[a-zA-Z0-9_\\-]+\\}", text))


def _estimate_generalization_score(defn: SkillDefinition, parameters: list[dict[str, Any]]) -> float:
    placeholders = _count_placeholders(defn.entrypoint)
    for step in defn.steps:
        placeholders += _count_placeholders(step.instructions or "")
    score = 0.35
    score += min(placeholders, 8) * 0.05
    score += min(len(parameters), 8) * 0.04
    return max(0.0, min(1.0, score))


def _tokenize_text(value: str) -> set[str]:
    return set(re.findall(r"[\\w]{2,}", value.lower(), flags=re.UNICODE))


def _build_skill_embedding_text(
    *,
    definition: SkillDefinition,
    parameters: list[dict[str, Any]],
    preconditions: list[str],
    success_criteria: list[str],
) -> str:
    parts = [
        f"Name: {definition.name}",
        f"Description: {definition.description}",
        f"Entrypoint: {definition.entrypoint}",
    ]
    if parameters:
        formatted = []
        for item in parameters:
            name = item.get("name")
            desc = item.get("description")
            if not name or not desc:
                continue
            example = item.get("example") or ""
            if example:
                formatted.append(f"{name}: {desc} (e.g. {example})")
            else:
                formatted.append(f"{name}: {desc}")
        if formatted:
            parts.append("Parameters: " + "; ".join(formatted))
    if preconditions:
        parts.append("Preconditions: " + "; ".join(preconditions))
    if success_criteria:
        parts.append("Success criteria: " + "; ".join(success_criteria))
    if definition.steps:
        step_lines = []
        for idx, step in enumerate(definition.steps):
            step_lines.append(f"{idx + 1}. {step.title}: {step.instructions}")
        parts.append("Steps:\n" + "\n".join(step_lines))
    return "\n".join(parts)


def _step_similarity(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> float:
    if not left or not right:
        return 0.0
    right_tokens = []
    for step in right:
        if not isinstance(step, dict):
            continue
        text = f"{step.get('title') or ''} {step.get('instructions') or ''}"
        tokens = _tokenize_text(text)
        if tokens:
            right_tokens.append(tokens)
    if not right_tokens:
        return 0.0
    total = 0.0
    count = 0
    for step in left:
        if not isinstance(step, dict):
            continue
        text = f"{step.get('title') or ''} {step.get('instructions') or ''}"
        tokens = _tokenize_text(text)
        if not tokens:
            continue
        best = 0.0
        for candidate in right_tokens:
            intersection = tokens & candidate
            union = tokens | candidate
            if not union:
                continue
            score = len(intersection) / len(union)
            if score > best:
                best = score
        total += best
        count += 1
    return total / count if count else 0.0


async def _detect_vector_extension(pool: asyncpg.Pool) -> bool:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS enabled")
        return bool(row and row.get("enabled"))


async def _embed_text(api_key: str, text: str, base_url: str | None) -> list[float] | None:
    trimmed = _clamp_text(text, 4000)
    if not trimmed:
        return None
    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url or OPENAI_API_BASE_URL,
        timeout=OPENAI_TIMEOUT_MS / 1000,
    )
    try:
        response = await client.embeddings.create(
            model=OPENAI_EMBEDDING_MODEL,
            input=trimmed,
        )
    except APIStatusError as exc:
        logger.warning("embedding_failed status=%s message=%s", exc.status_code, str(exc))
        return None
    except Exception as exc:
        logger.warning("embedding_failed error=%s", str(exc))
        return None
    embedding = response.data[0].embedding if response.data else None
    if isinstance(embedding, list):
        return embedding
    return None


async def _find_skill(pool: asyncpg.Pool, user_id: str, embedding: list[float]) -> tuple[SkillRecord | None, float | None]:
    if not embedding:
        return None, None
    if not VECTOR_ENABLED:
        return None, None
    vector_literal = _to_vector_literal(embedding)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, name, description, entrypoint_text, active_version_id,
                   parameters, preconditions, success_criteria, examples, generalization_score,
                   embedding,
                   (embedding <-> $1) AS distance
              FROM assistant_skills
             WHERE user_id = $2
               AND embedding IS NOT NULL
             ORDER BY embedding <-> $1
             LIMIT 1
            """,
            vector_literal,
            user_id,
        )
    if not row:
        return None, None
    parameters = _normalize_parameters(row.get("parameters"))
    preconditions = _normalize_string_list(row.get("preconditions"), max_items=SKILLS_MAX_PRECONDITIONS, max_len=260)
    success_criteria = _normalize_string_list(
        row.get("success_criteria"),
        max_items=SKILLS_MAX_SUCCESS_CRITERIA,
        max_len=260,
    )
    examples = _normalize_examples(row.get("examples"))
    generalization_score = row.get("generalization_score")
    if not isinstance(generalization_score, (int, float)):
        generalization_score = None
    skill = SkillRecord(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        entrypoint_text=row["entrypoint_text"],
        active_version_id=row["active_version_id"],
        parameters=parameters,
        preconditions=preconditions,
        success_criteria=success_criteria,
        examples=examples,
        generalization_score=float(generalization_score) if generalization_score is not None else None,
        embedding=_normalize_embedding(row.get("embedding")),
    )
    return skill, float(row["distance"]) if row.get("distance") is not None else None


async def _load_skill_version(pool: asyncpg.Pool, version_id: str) -> SkillVersionRecord | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, skill_id, version, steps
              FROM assistant_skill_versions
             WHERE id = $1
            """,
            version_id,
        )
    if not row:
        return None
    raw_steps = row["steps"]
    if isinstance(raw_steps, str):
        try:
            raw_steps = json.loads(raw_steps)
        except json.JSONDecodeError:
            raw_steps = []
    steps = raw_steps if isinstance(raw_steps, list) else []
    return SkillVersionRecord(
        id=row["id"],
        skill_id=row["skill_id"],
        version=row["version"],
        steps=steps,
    )


async def _save_skill(
    pool: asyncpg.Pool,
    user_id: str,
    definition: SkillDefinition,
    embedding: list[float],
    *,
    parameters: list[dict[str, Any]] | None = None,
    preconditions: list[str] | None = None,
    success_criteria: list[str] | None = None,
    examples: list[dict[str, Any]] | None = None,
    generalization_score: float | None = None,
) -> tuple[str, str]:
    skill_id = str(uuid.uuid4())
    version_id = str(uuid.uuid4())
    vector_value: Any = embedding
    if VECTOR_ENABLED:
        vector_value = _to_vector_literal(embedding)
    steps_payload = [step.model_dump() for step in definition.steps]
    steps_json = json.dumps(steps_payload, ensure_ascii=False)

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO assistant_skills (
                    id, user_id, name, description, entrypoint_text, embedding, active_version_id,
                    parameters, preconditions, success_criteria, examples, generalization_score
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                """,
                skill_id,
                user_id,
                definition.name,
                definition.description,
                definition.entrypoint,
                vector_value,
                version_id,
                json.dumps(parameters or [], ensure_ascii=False),
                json.dumps(preconditions or [], ensure_ascii=False),
                json.dumps(success_criteria or [], ensure_ascii=False),
                json.dumps(examples or [], ensure_ascii=False),
                generalization_score,
            )
            await conn.execute(
                """
                INSERT INTO assistant_skill_versions (id, skill_id, version, steps, base_prompt)
                VALUES ($1, $2, $3, $4, $5)
                """,
                version_id,
                skill_id,
                1,
                steps_json,
                None,
            )
    return skill_id, version_id


async def _insert_skill_run(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    skill_id: str | None,
    skill_version_id: str | None,
    user_id: str,
    thread_id: str | None,
    session_id: str | None,
    input_text: str | None,
    step_results: list[dict[str, Any]],
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO assistant_skill_runs (id, skill_id, skill_version_id, user_id, thread_id, session_id, input, step_results)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            run_id,
            skill_id,
            skill_version_id,
            user_id,
            thread_id,
            session_id,
            input_text,
            json.dumps(step_results, ensure_ascii=False),
        )


async def _update_skill_run_skill(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    skill_id: str,
    skill_version_id: str,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE assistant_skill_runs
               SET skill_id = $1,
                   skill_version_id = $2,
                   updated_at = NOW()
             WHERE id = $3
               AND user_id = $4
            """,
            skill_id,
            skill_version_id,
            run_id,
            user_id,
        )


async def _get_skill_run(pool: asyncpg.Pool, run_id: str, user_id: str) -> dict[str, Any] | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, skill_id, skill_version_id, input, step_results
              FROM assistant_skill_runs
             WHERE id = $1
               AND user_id = $2
            """,
            run_id,
            user_id,
        )
    if not row:
        return None
    raw_steps = row["step_results"]
    if isinstance(raw_steps, str):
        try:
            raw_steps = json.loads(raw_steps)
        except json.JSONDecodeError:
            raw_steps = []
    step_results = raw_steps if isinstance(raw_steps, list) else []
    return {
        "id": row["id"],
        "skillId": row["skill_id"],
        "skillVersionId": row["skill_version_id"],
        "input": row["input"],
        "stepResults": step_results,
    }


async def _update_skill_run_feedback(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    user_id: str,
    rating: str,
    feedback: str | None,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE assistant_skill_runs
               SET feedback_rating = $1,
                   feedback_text = $2,
                   feedback_at = NOW(),
                   updated_at = NOW()
             WHERE id = $3
               AND user_id = $4
            """,
            rating,
            feedback,
            run_id,
            user_id,
        )


async def _load_skill(pool: asyncpg.Pool, skill_id: str, user_id: str) -> SkillRecord | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, name, description, entrypoint_text, active_version_id,
                   parameters, preconditions, success_criteria, examples, generalization_score
              FROM assistant_skills
             WHERE id = $1
               AND user_id = $2
            """,
            skill_id,
            user_id,
        )
    if not row:
        return None
    parameters = _normalize_parameters(row.get("parameters"))
    preconditions = _normalize_string_list(row.get("preconditions"), max_items=SKILLS_MAX_PRECONDITIONS, max_len=260)
    success_criteria = _normalize_string_list(
        row.get("success_criteria"),
        max_items=SKILLS_MAX_SUCCESS_CRITERIA,
        max_len=260,
    )
    examples = _normalize_examples(row.get("examples"))
    generalization_score = row.get("generalization_score")
    if not isinstance(generalization_score, (int, float)):
        generalization_score = None
    return SkillRecord(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        entrypoint_text=row["entrypoint_text"],
        active_version_id=row["active_version_id"],
        parameters=parameters,
        preconditions=preconditions,
        success_criteria=success_criteria,
        examples=examples,
        generalization_score=float(generalization_score) if generalization_score is not None else None,
    )


async def _get_next_skill_version(pool: asyncpg.Pool, skill_id: str) -> int:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT COALESCE(MAX(version), 0) AS max_version FROM assistant_skill_versions WHERE skill_id = $1",
            skill_id,
        )
    raw = row["max_version"] if row else 0
    return int(raw) + 1


async def _save_skill_fix(pool: asyncpg.Pool, *, skill_id: str, steps: list[SkillStep]) -> str:
    version_id = str(uuid.uuid4())
    version = await _get_next_skill_version(pool, skill_id)
    payload = [step.model_dump() for step in steps]
    steps_json = json.dumps(payload, ensure_ascii=False)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO assistant_skill_versions (id, skill_id, version, steps, base_prompt)
                VALUES ($1, $2, $3, $4, $5)
                """,
                version_id,
                skill_id,
                version,
                steps_json,
                None,
            )
            await conn.execute(
                """
                UPDATE assistant_skills
                   SET active_version_id = $1,
                       updated_at = NOW()
                 WHERE id = $2
                """,
                version_id,
                skill_id,
            )
    return version_id


async def _save_skill_merge(
    pool: asyncpg.Pool,
    *,
    skill_id: str,
    definition: SkillDefinition,
    embedding: list[float],
    parameters: list[dict[str, Any]],
    preconditions: list[str],
    success_criteria: list[str],
    examples: list[dict[str, Any]],
    generalization_score: float | None,
) -> str:
    version_id = str(uuid.uuid4())
    version = await _get_next_skill_version(pool, skill_id)
    vector_value: Any = embedding
    if VECTOR_ENABLED:
        vector_value = _to_vector_literal(embedding)
    steps_json = json.dumps([step.model_dump() for step in definition.steps], ensure_ascii=False)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO assistant_skill_versions (id, skill_id, version, steps, base_prompt)
                VALUES ($1, $2, $3, $4, $5)
                """,
                version_id,
                skill_id,
                version,
                steps_json,
                None,
            )
            await conn.execute(
                """
                UPDATE assistant_skills
                   SET name = $1,
                       description = $2,
                       entrypoint_text = $3,
                       embedding = $4,
                       active_version_id = $5,
                       parameters = $6,
                       preconditions = $7,
                       success_criteria = $8,
                       examples = $9,
                       generalization_score = $10,
                       updated_at = NOW()
                 WHERE id = $11
                """,
                definition.name,
                definition.description,
                definition.entrypoint,
                vector_value,
                version_id,
                json.dumps(parameters or [], ensure_ascii=False),
                json.dumps(preconditions or [], ensure_ascii=False),
                json.dumps(success_criteria or [], ensure_ascii=False),
                json.dumps(examples or [], ensure_ascii=False),
                generalization_score,
                skill_id,
            )
    return version_id

def _build_step_instructions(
    *,
    skill: SkillRecord,
    step: dict[str, Any],
    index: int,
    total: int,
    prior_results: list[dict[str, Any]],
) -> str:
    title = str(step.get("title") or "Step").strip()
    instructions = str(step.get("instructions") or "").strip()
    notes = str(step.get("notes") or "").strip()
    lines = [
        "You are executing a reusable skill step-by-step.",
        f"Skill: {skill.name}",
        f"Step {index + 1} of {total}: {title}",
        "Follow the step instructions precisely and report only the result of this step.",
    ]
    if instructions:
        lines.append(f"Step instructions: {instructions}")
    if notes:
        lines.append(f"Notes: {notes}")
    if prior_results:
        compact = []
        for item in prior_results[-3:]:
            label = item.get("title") or "Step"
            output = item.get("output") or ""
            compact.append(f"- {label}: {output}")
        lines.append("Previous step results:\n" + "\n".join(compact))
    return "\n\n".join(lines)


async def _call_agent_service(payload: dict[str, Any]) -> AgentResult:
    timeout = max(1.0, AGENT_SERVICE_TIMEOUT_MS / 1000)
    async with httpx.AsyncClient(timeout=timeout) as client:
        res = await client.post(AGENT_SERVICE_URL, json=payload)
    body = None
    try:
        body = res.json()
    except Exception:
        body = None
    if not res.is_success:
        detail = body.get("detail") if isinstance(body, dict) else None
        message = None
        code = None
        if isinstance(detail, dict):
            message = detail.get("message")
            code = detail.get("error")
        message = message or (body.get("error") if isinstance(body, dict) else None) or res.reason_phrase
        logger.warning("agent_call_failed status=%s code=%s message=%s", res.status_code, code, message)
        raise HTTPException(status_code=res.status_code, detail={"error": code or "agent_failed", "message": message})
    return AgentResult(
        output=str(body.get("output") or ""),
        context=body.get("context") if isinstance(body, dict) else None,
        trace=body.get("trace") if isinstance(body, dict) else None,
        last_response_id=body.get("lastResponseId") if isinstance(body, dict) else None,
    )


async def _run_agent_once(req: SkillRunRequest, input_items: list[dict[str, Any]], instructions: str | None) -> AgentResult:
    combined_instructions = None
    if req.instructions and instructions:
        combined_instructions = f"{req.instructions}\n\n{instructions}"
    elif req.instructions:
        combined_instructions = req.instructions
    else:
        combined_instructions = instructions
    payload = {
        "apiKey": req.apiKey,
        "model": req.model,
        "userName": req.userName,
        "instructions": combined_instructions,
        "input": input_items,
        "temperature": req.temperature if req.temperature is not None else 0.3,
        "openaiBaseUrl": req.openaiBaseUrl,
        "openaiTimeoutMs": req.openaiTimeoutMs or OPENAI_TIMEOUT_MS,
        "webSearchEnabled": bool(req.webSearchEnabled),
        "mcp": req.mcp.model_dump() if req.mcp else None,
    }
    return await _call_agent_service(payload)


async def _decompose_skill(
    *,
    api_key: str,
    model: str,
    base_url: str | None,
    user_query: str,
    base_output: str,
    trace: dict[str, Any] | None,
) -> SkillDefinition | None:
    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url or OPENAI_API_BASE_URL,
        timeout=OPENAI_TIMEOUT_MS / 1000,
    )
    trace_summary = _summarize_tool_trace(trace)
    prompt = [
        "You are creating a reusable skill from a solved request.",
        "Write the skill in English only.",
        "Return a concise JSON object with: name, description, entrypoint, steps.",
        "Each step must include title and instructions. Keep steps minimal and executable.",
        f"Limit steps to {SKILLS_MAX_STEPS}.",
    ]
    input_parts = [
        f"User request:\n{_clamp_text(user_query, 2000)}",
        f"Base solution:\n{_clamp_text(base_output, 2400)}",
    ]
    if trace_summary:
        input_parts.append(f"Tools used: {trace_summary}")
    try:
        response = await client.responses.parse(
            model=model,
            instructions="\n".join(prompt),
            input="\n\n".join(input_parts),
            temperature=0.2,
            text_format=SkillDefinition,
        )
    except Exception as exc:
        logger.warning("skill_decompose_failed error=%s", str(exc))
        return None
    parsed = getattr(response, "output_parsed", None)
    if isinstance(parsed, SkillDefinition):
        return parsed
    if isinstance(parsed, dict):
        try:
            return SkillDefinition.model_validate(parsed)
        except Exception:
            return None
    return None


async def _generalize_skill(
    *,
    api_key: str,
    model: str,
    base_url: str | None,
    user_query: str,
    base_output: str,
    draft: SkillDefinition,
    trace: dict[str, Any] | None,
) -> GeneralizedSkillDefinition | None:
    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url or OPENAI_API_BASE_URL,
        timeout=OPENAI_TIMEOUT_MS / 1000,
    )
    trace_summary = _summarize_tool_trace(trace)
    prompt = [
        "You are generalizing a reusable skill so it can handle similar tasks.",
        "All output fields must be in English. Translate any non-English content.",
        "Replace specific details (names, paths, ids, dates) with parameters like {project_path}.",
        "If the input already describes a skill, rewrite it in a more general, reusable form.",
        "Return a JSON object with: name, description, entrypoint, steps, parameters, preconditions, successCriteria, examples, generalizationScore.",
        "Parameters must include name and description; add an example if useful.",
        "Preconditions and successCriteria should be short lists.",
        "generalizationScore must be a number from 0 to 1.",
        f"Limit steps to {SKILLS_MAX_STEPS}.",
    ]
    draft_text = _format_steps_for_prompt([step.model_dump() for step in draft.steps])
    input_parts = [
        f"User request:\n{_clamp_text(user_query, 2000)}",
        f"Base solution:\n{_clamp_text(base_output, 2400)}",
        f"Draft skill name: {draft.name}",
        f"Draft description: {draft.description}",
        f"Draft entrypoint: {draft.entrypoint}",
        "Draft steps:\n" + (draft_text or "None"),
    ]
    if trace_summary:
        input_parts.append(f"Tools used: {trace_summary}")
    try:
        response = await client.responses.parse(
            model=model,
            instructions="\n".join(prompt),
            input="\n\n".join(input_parts),
            temperature=0.2,
            text_format=GeneralizedSkillDefinition,
        )
    except Exception as exc:
        logger.warning("skill_generalize_failed error=%s", str(exc))
        return None
    parsed = getattr(response, "output_parsed", None)
    if isinstance(parsed, GeneralizedSkillDefinition):
        return parsed
    if isinstance(parsed, dict):
        try:
            return GeneralizedSkillDefinition.model_validate(parsed)
        except Exception:
            return None
    return None


async def _fix_skill_steps(
    *,
    api_key: str,
    model: str,
    base_url: str | None,
    skill: SkillRecord,
    current_steps: list[dict[str, Any]],
    step_results: list[dict[str, Any]],
    feedback: str,
) -> SkillFix | None:
    client = AsyncOpenAI(
        api_key=api_key,
        base_url=base_url or OPENAI_API_BASE_URL,
        timeout=OPENAI_TIMEOUT_MS / 1000,
    )
    prompt = [
        "You are improving a reusable skill based on human feedback.",
        "Return the updated steps in English only (translate if needed).",
        "Return a JSON object with updated steps only.",
        "Each step must include title and instructions.",
        f"Limit steps to {SKILLS_MAX_STEPS}.",
    ]
    input_parts = [
        f"Skill name: {skill.name}",
        f"Skill description: {skill.description or ''}",
        f"Entrypoint: {skill.entrypoint_text}",
        "Current steps:\n" + _format_steps_for_prompt(current_steps),
        "Step results from last run:\n" + (_format_step_results_for_prompt(step_results) or "No step results."),
        f"Human feedback:\n{_clamp_text(feedback, 2000)}",
    ]
    try:
        response = await client.responses.parse(
            model=model,
            instructions="\n".join(prompt),
            input="\n\n".join(input_parts),
            temperature=0.2,
            text_format=SkillFix,
        )
    except Exception as exc:
        logger.warning("skill_fix_failed error=%s", str(exc))
        return None
    parsed = getattr(response, "output_parsed", None)
    if isinstance(parsed, SkillFix):
        return parsed
    if isinstance(parsed, dict):
        try:
            return SkillFix.model_validate(parsed)
        except Exception:
            return None
    return None


async def _record_skill_background(
    *,
    run_id: str,
    user_id: str,
    api_key: str,
    model: str,
    base_url: str | None,
    user_query: str,
    base_output: str,
    trace: dict[str, Any] | None,
) -> None:
    if not POOL:
        logger.warning("skill_record_async_skip id=%s reason=no_pool", run_id)
        return
    logger.info("skill_record_async_start id=%s user=%s", run_id, user_id)
    try:
        definition = await _decompose_skill(
            api_key=api_key,
            model=model,
            base_url=base_url,
            user_query=user_query,
            base_output=base_output,
            trace=trace,
        )
        if not definition:
            logger.warning("skill_record_async_skip id=%s reason=decompose_failed", run_id)
            return
        generalized = await _generalize_skill(
            api_key=api_key,
            model=model,
            base_url=base_url,
            user_query=user_query,
            base_output=base_output,
            draft=definition,
            trace=trace,
        )
        if not generalized:
            logger.warning("skill_record_async_skip id=%s reason=generalize_failed", run_id)
            return

        normalized = _normalize_skill_definition(
            SkillDefinition(
                name=generalized.name,
                description=generalized.description,
                entrypoint=generalized.entrypoint,
                steps=generalized.steps,
            ),
            user_query,
        )

        parameters = _normalize_parameters(generalized.parameters)
        preconditions = _normalize_string_list(
            generalized.preconditions,
            max_items=SKILLS_MAX_PRECONDITIONS,
            max_len=260,
        )
        success_criteria = _normalize_string_list(
            generalized.successCriteria,
            max_items=SKILLS_MAX_SUCCESS_CRITERIA,
            max_len=260,
        )
        fallback_example = {
            "userInput": user_query,
            "outputSummary": _clamp_text(base_output, 1400),
            "runId": run_id,
        }
        examples = _normalize_examples(generalized.examples, fallback=fallback_example)
        generalization_score = generalized.generalizationScore
        if not isinstance(generalization_score, (int, float)):
            generalization_score = _estimate_generalization_score(normalized, parameters)
        generalization_score = max(0.0, min(1.0, float(generalization_score)))

        logger.info(
            "skill_generalized id=%s name=%s score=%.2f params=%s preconditions=%s success=%s examples=%s steps=%s",
            run_id,
            normalized.name,
            generalization_score,
            len(parameters),
            len(preconditions),
            len(success_criteria),
            len(examples),
            len(normalized.steps),
        )

        if generalization_score < SKILLS_GENERALIZATION_THRESHOLD:
            logger.info(
                "skill_record_async_skip id=%s reason=generalization_low score=%.2f threshold=%.2f",
                run_id,
                generalization_score,
                SKILLS_GENERALIZATION_THRESHOLD,
            )
            return

        embedding_text = _build_skill_embedding_text(
            definition=normalized,
            parameters=parameters,
            preconditions=preconditions,
            success_criteria=success_criteria,
        )
        embedding = await _embed_text(api_key, embedding_text, base_url)
        if not embedding:
            logger.warning("skill_record_async_skip id=%s reason=embedding_failed", run_id)
            return

        candidate = None
        candidate_distance = None
        candidate_steps: list[dict[str, Any]] = []
        candidate_version_id = None
        candidate_version = None
        if user_id:
            candidate, candidate_distance = await _find_skill(POOL, user_id, embedding)
            if candidate and candidate.active_version_id:
                candidate_version = await _load_skill_version(POOL, candidate.active_version_id)
                candidate_version_id = candidate.active_version_id
                if candidate_version:
                    candidate_steps = candidate_version.steps

        if candidate:
            similarity = None
            if candidate.embedding and embedding:
                similarity = _cosine_similarity(candidate.embedding, embedding)
            elif candidate_distance is not None:
                distance = float(candidate_distance)
                similarity = 1.0 - (distance * distance / 2.0)
            if similarity is not None:
                similarity = max(0.0, min(1.0, float(similarity)))
            step_sim = _step_similarity(
                [step.model_dump() for step in normalized.steps],
                candidate_steps,
            )
            if similarity is None:
                merge_score = step_sim
            else:
                weighted = similarity * 0.7 + step_sim * 0.3
                boosted_similarity = min(1.0, similarity + SKILLS_MERGE_SIMILARITY_EPS)
                merge_score = max(weighted, boosted_similarity, step_sim)
            logger.info(
                "skill_merge_eval id=%s skill=%s similarity=%s step=%.2f score=%.2f threshold=%.2f",
                run_id,
                candidate.id,
                f"{similarity:.2f}" if similarity is not None else "none",
                step_sim,
                merge_score,
                SKILLS_MERGE_SIMILARITY_THRESHOLD,
            )
            if merge_score >= SKILLS_MERGE_SIMILARITY_THRESHOLD:
                merged_params = _merge_parameters(candidate.parameters, parameters)
                merged_preconditions = _merge_string_lists(
                    candidate.preconditions,
                    preconditions,
                    max_items=SKILLS_MAX_PRECONDITIONS,
                    max_len=260,
                )
                merged_success = _merge_string_lists(
                    candidate.success_criteria,
                    success_criteria,
                    max_items=SKILLS_MAX_SUCCESS_CRITERIA,
                    max_len=260,
                )
                merged_examples = _merge_examples(candidate.examples, examples)
                merged_score = generalization_score
                if candidate.generalization_score is not None:
                    merged_score = max(candidate.generalization_score, generalization_score)
                new_version_id = await _save_skill_merge(
                    POOL,
                    skill_id=candidate.id,
                    definition=normalized,
                    embedding=embedding,
                    parameters=merged_params,
                    preconditions=merged_preconditions,
                    success_criteria=merged_success,
                    examples=merged_examples,
                    generalization_score=merged_score,
                )
                await _update_skill_run_skill(
                    POOL,
                    run_id=run_id,
                    user_id=user_id,
                    skill_id=candidate.id,
                    skill_version_id=new_version_id,
                )
                logger.info(
                    "skill_merge_saved id=%s skill=%s from_version=%s new_version=%s",
                    run_id,
                    candidate.id,
                    candidate_version_id or "none",
                    new_version_id,
                )
                return
            logger.info(
                "skill_merge_skip id=%s skill=%s score=%.2f",
                run_id,
                candidate.id,
                merge_score,
            )

        created_skill_id, created_version_id = await _save_skill(
            POOL,
            user_id,
            normalized,
            embedding,
            parameters=parameters,
            preconditions=preconditions,
            success_criteria=success_criteria,
            examples=examples,
            generalization_score=generalization_score,
        )
        await _update_skill_run_skill(
            POOL,
            run_id=run_id,
            user_id=user_id,
            skill_id=created_skill_id,
            skill_version_id=created_version_id,
        )
        logger.info(
            "skill_record_async_saved id=%s skill=%s version=%s steps=%s",
            run_id,
            created_skill_id,
            created_version_id,
            len(normalized.steps),
        )
    except Exception as exc:
        logger.exception("skill_record_async_failed id=%s error=%s", run_id, str(exc))


@app.post("/run", response_model=SkillRunResponse)
async def run_skill(req: SkillRunRequest) -> SkillRunResponse:
    if not req.apiKey or not req.apiKey.strip():
        raise HTTPException(status_code=400, detail="openai_key_required")
    if not POOL:
        raise HTTPException(status_code=503, detail="skills_pool_unavailable")

    run_id = str(uuid.uuid4())
    started = time.monotonic()
    input_items = _normalize_input_items(req.input)
    user_query = _extract_last_user_message(input_items)
    user_query = _clamp_text(user_query, 2000)
    logger.info(
        "run_start id=%s user=%s thread=%s session=%s inputSize=%s",
        run_id,
        req.userId or "unknown",
        req.threadId or "none",
        req.sessionId or "none",
        len(user_query),
    )

    skill: SkillRecord | None = None
    skill_version: SkillVersionRecord | None = None
    match_distance = None

    if req.userId and user_query:
        embedding = await _embed_text(req.apiKey, user_query, req.openaiBaseUrl)
        logger.info(
            "skill_search id=%s user=%s hasEmbedding=%s",
            run_id,
            req.userId,
            "yes" if embedding else "no",
        )
        if embedding:
            skill, match_distance = await _find_skill(POOL, req.userId, embedding)
            match_similarity = None
            if skill:
                if skill.embedding and embedding:
                    match_similarity = _cosine_similarity(skill.embedding, embedding)
                elif match_distance is not None:
                    match_similarity = 1.0 - (float(match_distance) ** 2) / 2.0
                if match_similarity is not None:
                    match_similarity = max(0.0, min(1.0, float(match_similarity)))
                    if match_similarity < SKILLS_MATCH_SIMILARITY_THRESHOLD:
                        logger.info(
                            "skill_miss id=%s user=%s similarity=%.4f threshold=%.4f distance=%.4f",
                            run_id,
                            req.userId,
                            match_similarity,
                            SKILLS_MATCH_SIMILARITY_THRESHOLD,
                            match_distance if match_distance is not None else -1.0,
                        )
                        skill = None
                    else:
                        logger.info(
                            "skill_hit id=%s user=%s skill=%s similarity=%.4f distance=%.4f",
                            run_id,
                            req.userId,
                            skill.id,
                            match_similarity,
                            match_distance if match_distance is not None else -1.0,
                        )
                elif match_distance is None or match_distance > SKILLS_MATCH_THRESHOLD:
                    logger.info(
                        "skill_miss id=%s user=%s distance=%.4f threshold=%.4f",
                        run_id,
                        req.userId,
                        match_distance if match_distance is not None else -1.0,
                        SKILLS_MATCH_THRESHOLD,
                    )
                    skill = None
                else:
                    logger.info(
                        "skill_hit id=%s user=%s skill=%s distance=%.4f",
                        run_id,
                        req.userId,
                        skill.id,
                        match_distance if match_distance is not None else -1.0,
                    )
    else:
        logger.info(
            "skill_search_skipped id=%s reason=%s",
            run_id,
            "missing_user" if not req.userId else "empty_query",
        )

    if skill and skill.active_version_id:
        skill_version = await _load_skill_version(POOL, skill.active_version_id)
        if not skill_version:
            logger.warning(
                "skill_version_missing id=%s skill=%s version=%s",
                run_id,
                skill.id,
                skill.active_version_id,
            )

    skill_found = bool(skill and skill_version and skill_version.steps)
    if skill_found:
        step_results: list[dict[str, Any]] = []
        last_result: AgentResult | None = None
        for idx, step in enumerate(skill_version.steps):
            logger.info(
                "skill_step_start id=%s skill=%s step=%s",
                run_id,
                skill.id,
                idx + 1,
            )
            instructions = _build_step_instructions(
                skill=skill,
                step=step,
                index=idx,
                total=len(skill_version.steps),
                prior_results=step_results,
            )
            last_result = await _run_agent_once(req, input_items, instructions)
            step_results.append({
                "index": idx,
                "title": step.get("title") if isinstance(step, dict) else None,
                "output": last_result.output,
                "trace": last_result.trace,
                "timestamp": _now_iso(),
            })
            logger.info(
                "skill_step_done id=%s skill=%s step=%s outputSize=%s",
                run_id,
                skill.id,
                idx + 1,
                len(last_result.output),
            )

        if req.userId:
            await _insert_skill_run(
                POOL,
                run_id=run_id,
                skill_id=skill.id,
                skill_version_id=skill_version.id,
                user_id=req.userId,
                thread_id=req.threadId,
                session_id=req.sessionId,
                input_text=user_query or None,
                step_results=step_results,
            )
            logger.info(
                "skill_run_saved id=%s skill=%s version=%s steps=%s",
                run_id,
                skill.id,
                skill_version.id,
                len(step_results),
            )

        final_output = last_result.output if last_result else ""
        elapsed = int((time.monotonic() - started) * 1000)
        logger.info("run_done id=%s mode=skill ms=%s", run_id, elapsed)
        return SkillRunResponse(
            output=final_output,
            lastResponseId=last_result.last_response_id if last_result else None,
            context=last_result.context if last_result else None,
            trace=last_result.trace if last_result else None,
            skill={
                "runId": run_id,
                "skillId": skill.id if skill else None,
                "skillVersionId": skill_version.id if skill_version else None,
                "found": True,
                "matchDistance": match_distance,
            },
        )

    base_result = await _run_agent_once(req, input_items, None)
    logger.info(
        "base_solution_done id=%s outputSize=%s",
        run_id,
        len(base_result.output),
    )

    created_skill_id: str | None = None
    created_version_id: str | None = None
    if req.userId:
        await _insert_skill_run(
            POOL,
            run_id=run_id,
            skill_id=created_skill_id,
            skill_version_id=created_version_id,
            user_id=req.userId,
            thread_id=req.threadId,
            session_id=req.sessionId,
            input_text=user_query or None,
            step_results=[],
        )
        logger.info(
            "skill_run_saved id=%s skill=%s version=%s steps=0",
            run_id,
            created_skill_id or "none",
            created_version_id or "none",
        )

    if req.userId and user_query and not skill_found:
        logger.info("skill_record_async_queue id=%s user=%s", run_id, req.userId)
        asyncio.create_task(_record_skill_background(
            run_id=run_id,
            user_id=req.userId,
            api_key=req.apiKey,
            model=req.model,
            base_url=req.openaiBaseUrl,
            user_query=user_query,
            base_output=base_result.output,
            trace=base_result.trace,
        ))

    elapsed = int((time.monotonic() - started) * 1000)
    logger.info("run_done id=%s mode=base ms=%s", run_id, elapsed)
    return SkillRunResponse(
        output=base_result.output,
        lastResponseId=base_result.last_response_id,
        context=base_result.context,
        trace=base_result.trace,
        skill={
            "runId": run_id,
            "skillId": created_skill_id,
            "skillVersionId": created_version_id,
            "found": False,
            "matchDistance": match_distance,
        },
    )


@app.post("/feedback", response_model=SkillFeedbackResponse)
async def skill_feedback(req: SkillFeedbackRequest) -> SkillFeedbackResponse:
    if not POOL:
        raise HTTPException(status_code=503, detail="skills_pool_unavailable")

    feedback_id = str(uuid.uuid4())
    started = time.monotonic()
    feedback_text = _clamp_text(req.feedback or "", 2000) or None
    logger.info(
        "feedback_start id=%s run=%s user=%s rating=%s",
        feedback_id,
        req.runId,
        req.userId,
        req.rating,
    )

    run = await _get_skill_run(POOL, req.runId, req.userId)
    if not run:
        logger.warning("feedback_missing id=%s run=%s", feedback_id, req.runId)
        raise HTTPException(status_code=404, detail="skill_run_not_found")

    await _update_skill_run_feedback(
        POOL,
        run_id=req.runId,
        user_id=req.userId,
        rating=req.rating,
        feedback=feedback_text,
    )

    skill_id = run.get("skillId")
    version_id = run.get("skillVersionId")
    if req.rating != "negative" or not skill_id or not version_id:
        logger.info(
            "feedback_skip id=%s run=%s reason=%s",
            feedback_id,
            req.runId,
            "rating" if req.rating != "negative" else "missing_skill",
        )
        elapsed = int((time.monotonic() - started) * 1000)
        logger.info("feedback_done id=%s updated=no ms=%s", feedback_id, elapsed)
        return SkillFeedbackResponse(
            runId=req.runId,
            updated=False,
            skillId=skill_id,
            skillVersionId=version_id,
            newVersionId=None,
        )

    skill = await _load_skill(POOL, skill_id, req.userId)
    if not skill:
        logger.warning("feedback_skill_missing id=%s skill=%s", feedback_id, skill_id)
        return SkillFeedbackResponse(
            runId=req.runId,
            updated=False,
            skillId=skill_id,
            skillVersionId=version_id,
            newVersionId=None,
        )

    skill_version = await _load_skill_version(POOL, version_id)
    if not skill_version:
        logger.warning("feedback_version_missing id=%s version=%s", feedback_id, version_id)
        return SkillFeedbackResponse(
            runId=req.runId,
            updated=False,
            skillId=skill_id,
            skillVersionId=version_id,
            newVersionId=None,
        )

    logger.info(
        "feedback_fix_start id=%s skill=%s version=%s",
        feedback_id,
        skill_id,
        version_id,
    )
    fix = await _fix_skill_steps(
        api_key=req.apiKey,
        model=req.model,
        base_url=req.openaiBaseUrl,
        skill=skill,
        current_steps=skill_version.steps,
        step_results=run.get("stepResults") or [],
        feedback=feedback_text or "Negative feedback",
    )

    if not fix:
        logger.warning("feedback_fix_failed id=%s run=%s", feedback_id, req.runId)
        return SkillFeedbackResponse(
            runId=req.runId,
            updated=False,
            skillId=skill_id,
            skillVersionId=version_id,
            newVersionId=None,
        )

    normalized = _normalize_skill_definition(
        SkillDefinition(
            name=skill.name,
            description=skill.description or "",
            entrypoint=skill.entrypoint_text,
            steps=fix.steps,
        ),
        skill.entrypoint_text,
    )
    new_version_id = await _save_skill_fix(POOL, skill_id=skill_id, steps=normalized.steps)
    elapsed = int((time.monotonic() - started) * 1000)
    logger.info(
        "feedback_updated id=%s skill=%s version=%s ms=%s",
        feedback_id,
        skill_id,
        new_version_id,
        elapsed,
    )
    return SkillFeedbackResponse(
        runId=req.runId,
        updated=True,
        skillId=skill_id,
        skillVersionId=version_id,
        newVersionId=new_version_id,
    )
