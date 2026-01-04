import argparse
import asyncio
from dataclasses import dataclass
from datetime import datetime
import json
import os
from typing import Any

import asyncpg

import app as skills


@dataclass
class ReprocessedSkill:
    skill_id: str
    created_at: datetime
    definition: skills.SkillDefinition
    parameters: list[dict[str, Any]]
    preconditions: list[str]
    success_criteria: list[str]
    examples: list[dict[str, Any]]
    generalization_score: float
    embedding: list[float]
    steps_payload: list[dict[str, Any]]


def _parse_json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


def _build_draft_steps(raw_steps: Any) -> list[skills.SkillStep]:
    steps: list[skills.SkillStep] = []
    for raw in _parse_json_list(raw_steps):
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "Step").strip()
        instructions = str(raw.get("instructions") or "").strip()
        notes = str(raw.get("notes") or "").strip() or None
        if not instructions:
            continue
        steps.append(skills.SkillStep(title=title, instructions=instructions, notes=notes))
    return steps


def _build_base_output(
    description: str | None,
    steps: list[dict[str, Any]],
    examples: list[dict[str, Any]],
) -> str:
    parts: list[str] = []
    if description:
        parts.append(f"Description:\n{description}")
    step_text = skills._format_steps_for_prompt(steps)
    if step_text:
        parts.append("Steps:\n" + step_text)
    example_outputs: list[str] = []
    for example in examples[:2]:
        if not isinstance(example, dict):
            continue
        output = str(example.get("outputSummary") or "").strip()
        if output:
            example_outputs.append(output)
    if example_outputs:
        parts.append("Example outputs:\n" + "\n".join(example_outputs))
    return "\n\n".join(parts)


def _pick_user_query(entrypoint: str, name: str, examples: list[dict[str, Any]]) -> str:
    for example in examples:
        if not isinstance(example, dict):
            continue
        user_input = str(example.get("userInput") or "").strip()
        if user_input:
            return user_input
    if entrypoint:
        return entrypoint
    if name:
        return name
    return "Generalize this skill."


def _merge_score(left: ReprocessedSkill, right: ReprocessedSkill) -> float:
    similarity = skills._cosine_similarity(left.embedding, right.embedding)
    step_sim = skills._step_similarity(left.steps_payload, right.steps_payload)
    weighted = similarity * 0.7 + step_sim * 0.3
    boosted_similarity = min(1.0, similarity + skills.SKILLS_MERGE_SIMILARITY_EPS)
    return max(weighted, boosted_similarity, step_sim)


async def _load_user_id(conn: asyncpg.Connection, *, user_id: str | None, email: str | None) -> str:
    if user_id:
        return user_id
    if not email:
        raise ValueError("user_id_or_email_required")
    row = await conn.fetchrow("SELECT id FROM users WHERE email = $1", email)
    if not row:
        raise ValueError(f"user_not_found:{email}")
    return str(row["id"])


async def _load_api_key(conn: asyncpg.Connection, *, user_id: str) -> str | None:
    row = await conn.fetchrow("SELECT api_key FROM openai_keys WHERE user_id = $1", user_id)
    if not row:
        return None
    api_key = row.get("api_key")
    if isinstance(api_key, str) and api_key.strip():
        return api_key.strip()
    return None


async def _fetch_skills(conn: asyncpg.Connection, user_id: str) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT s.id,
               s.name,
               s.description,
               s.entrypoint_text,
               s.parameters,
               s.preconditions,
               s.success_criteria,
               s.examples,
               s.generalization_score,
               s.created_at,
               v.steps
          FROM assistant_skills s
     LEFT JOIN assistant_skill_versions v ON v.id = s.active_version_id
         WHERE s.user_id = $1
         ORDER BY s.created_at ASC
        """,
        user_id,
    )
    return [dict(row) for row in rows]


async def _reprocess_skill(
    *,
    row: dict[str, Any],
    api_key: str,
    model: str,
    base_url: str | None,
) -> ReprocessedSkill | None:
    name = str(row.get("name") or "Raven skill")
    description = str(row.get("description") or "")
    entrypoint = str(row.get("entrypoint_text") or "")
    raw_steps = row.get("steps")

    steps = _build_draft_steps(raw_steps)
    if not steps:
        steps = [skills.SkillStep(title="Solve request", instructions="Provide the solution in full.")]

    raw_examples = skills._normalize_examples(row.get("examples"))
    user_query = _pick_user_query(entrypoint, name, raw_examples)
    base_output = _build_base_output(description, [step.model_dump() for step in steps], raw_examples)
    base_output = skills._clamp_text(base_output, 2400)

    draft = skills.SkillDefinition(
        name=name,
        description=description or "Reusable skill.",
        entrypoint=entrypoint or user_query,
        steps=steps,
    )

    generalized = await skills._generalize_skill(
        api_key=api_key,
        model=model,
        base_url=base_url,
        user_query=user_query,
        base_output=base_output,
        draft=draft,
        trace=None,
    )

    if generalized:
        normalized = skills._normalize_skill_definition(
            skills.SkillDefinition(
                name=generalized.name,
                description=generalized.description,
                entrypoint=generalized.entrypoint,
                steps=generalized.steps,
            ),
            user_query,
        )
        parameters = skills._normalize_parameters(generalized.parameters)
        preconditions = skills._normalize_string_list(
            generalized.preconditions,
            max_items=skills.SKILLS_MAX_PRECONDITIONS,
            max_len=260,
        )
        success_criteria = skills._normalize_string_list(
            generalized.successCriteria,
            max_items=skills.SKILLS_MAX_SUCCESS_CRITERIA,
            max_len=260,
        )
        examples = skills._normalize_examples(
            generalized.examples,
            fallback={"userInput": user_query, "outputSummary": base_output},
        )
        generalization_score = generalized.generalizationScore
        if not isinstance(generalization_score, (int, float)):
            generalization_score = skills._estimate_generalization_score(normalized, parameters)
        generalization_score = max(0.0, min(1.0, float(generalization_score)))
    else:
        normalized = skills._normalize_skill_definition(draft, user_query)
        parameters = skills._normalize_parameters(row.get("parameters"))
        preconditions = skills._normalize_string_list(
            row.get("preconditions"),
            max_items=skills.SKILLS_MAX_PRECONDITIONS,
            max_len=260,
        )
        success_criteria = skills._normalize_string_list(
            row.get("success_criteria"),
            max_items=skills.SKILLS_MAX_SUCCESS_CRITERIA,
            max_len=260,
        )
        examples = raw_examples
        generalization_score = skills._estimate_generalization_score(normalized, parameters)

    embedding_text = skills._build_skill_embedding_text(
        definition=normalized,
        parameters=parameters,
        preconditions=preconditions,
        success_criteria=success_criteria,
    )
    embedding = await skills._embed_text(api_key, embedding_text, base_url)
    if not embedding:
        return None

    steps_payload = [step.model_dump() for step in normalized.steps]
    created_at = row.get("created_at") or datetime.utcnow()

    return ReprocessedSkill(
        skill_id=str(row["id"]),
        created_at=created_at,
        definition=normalized,
        parameters=parameters,
        preconditions=preconditions,
        success_criteria=success_criteria,
        examples=examples,
        generalization_score=generalization_score,
        embedding=embedding,
        steps_payload=steps_payload,
    )


async def _merge_cluster(
    *,
    pool: asyncpg.Pool,
    cluster: list[ReprocessedSkill],
    api_key: str,
    base_url: str | None,
) -> tuple[str, str]:
    if not cluster:
        raise ValueError("empty_cluster")
    base = max(
        cluster,
        key=lambda item: (
            item.generalization_score,
            -item.created_at.timestamp() if isinstance(item.created_at, datetime) else 0.0,
        ),
    )
    merged_params = base.parameters
    merged_preconditions = base.preconditions
    merged_success = base.success_criteria
    merged_examples = base.examples
    merged_score = base.generalization_score

    for item in cluster:
        if item is base:
            continue
        merged_params = skills._merge_parameters(merged_params, item.parameters)
        merged_preconditions = skills._merge_string_lists(
            merged_preconditions,
            item.preconditions,
            max_items=skills.SKILLS_MAX_PRECONDITIONS,
            max_len=260,
        )
        merged_success = skills._merge_string_lists(
            merged_success,
            item.success_criteria,
            max_items=skills.SKILLS_MAX_SUCCESS_CRITERIA,
            max_len=260,
        )
        merged_examples = skills._merge_examples(merged_examples, item.examples)
        merged_score = max(merged_score, item.generalization_score)

    embedding_text = skills._build_skill_embedding_text(
        definition=base.definition,
        parameters=merged_params,
        preconditions=merged_preconditions,
        success_criteria=merged_success,
    )
    embedding = await skills._embed_text(api_key, embedding_text, base_url)
    if not embedding:
        embedding = base.embedding

    new_version_id = await skills._save_skill_merge(
        pool,
        skill_id=base.skill_id,
        definition=base.definition,
        embedding=embedding,
        parameters=merged_params,
        preconditions=merged_preconditions,
        success_criteria=merged_success,
        examples=merged_examples,
        generalization_score=merged_score,
    )
    return base.skill_id, new_version_id


async def _apply_merge(
    *,
    pool: asyncpg.Pool,
    base_skill_id: str,
    version_id: str,
    merged_skill_ids: list[str],
) -> None:
    if not merged_skill_ids:
        return
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE assistant_skill_runs
               SET skill_id = $1,
                   skill_version_id = $2,
                   updated_at = NOW()
             WHERE skill_id = ANY($3::text[])
            """,
            base_skill_id,
            version_id,
            merged_skill_ids,
        )
        await conn.execute(
            "DELETE FROM assistant_skills WHERE id = ANY($1::text[])",
            merged_skill_ids,
        )


async def main() -> None:
    parser = argparse.ArgumentParser(description="Reprocess and merge existing skills for a user.")
    parser.add_argument("--user-id", dest="user_id", help="User id to reprocess skills for.")
    parser.add_argument("--email", dest="email", help="User email to reprocess skills for.")
    parser.add_argument("--api-key", dest="api_key", help="OpenAI API key (or set OPENAI_API_KEY).")
    parser.add_argument("--model", dest="model", default="gpt-5.2", help="Model to use.")
    parser.add_argument("--base-url", dest="base_url", default=os.getenv("OPENAI_API_BASE_URL"))
    args = parser.parse_args()

    pool = await asyncpg.create_pool(os.getenv("DATABASE_URL"))
    skills.POOL = pool
    skills.VECTOR_ENABLED = await skills._detect_vector_extension(pool)

    async with pool.acquire() as conn:
        user_id = await _load_user_id(conn, user_id=args.user_id, email=args.email)
        api_key = args.api_key or os.getenv("OPENAI_API_KEY") or await _load_api_key(conn, user_id=user_id)
        if not api_key:
            await pool.close()
            raise SystemExit("Missing API key. Provide --api-key or OPENAI_API_KEY.")
        rows = await _fetch_skills(conn, user_id)

    if not rows:
        print("No skills found.")
        await pool.close()
        return

    candidates: list[ReprocessedSkill] = []
    for row in rows:
        item = await _reprocess_skill(
            row=row,
            api_key=api_key,
            model=args.model,
            base_url=args.base_url,
        )
        if item:
            candidates.append(item)

    if not candidates:
        print("No skills reprocessed (embedding failed).")
        await pool.close()
        return

    count = len(candidates)
    parent = list(range(count))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        root_a = find(a)
        root_b = find(b)
        if root_a != root_b:
            parent[root_b] = root_a

    for i in range(count):
        for j in range(i + 1, count):
            score = _merge_score(candidates[i], candidates[j])
            if score >= skills.SKILLS_MERGE_SIMILARITY_THRESHOLD:
                union(i, j)

    clusters: dict[int, list[ReprocessedSkill]] = {}
    for idx, item in enumerate(candidates):
        clusters.setdefault(find(idx), []).append(item)

    merged_total = 0
    for cluster in clusters.values():
        base_skill_id, version_id = await _merge_cluster(
            pool=pool,
            cluster=cluster,
            api_key=api_key,
            base_url=args.base_url,
        )
        merged_ids = [item.skill_id for item in cluster if item.skill_id != base_skill_id]
        if merged_ids:
            await _apply_merge(
                pool=pool,
                base_skill_id=base_skill_id,
                version_id=version_id,
                merged_skill_ids=merged_ids,
            )
            merged_total += len(merged_ids)

    await pool.close()
    print(f"Reprocessed skills: {len(candidates)} clusters={len(clusters)} merged={merged_total}")


if __name__ == "__main__":
    asyncio.run(main())
