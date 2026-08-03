"""
Cost ledger — write and read helpers for ocr_jobs and provider_calls.

Design constraints:
  - Every function opens and closes its own AsyncSession (no session passed in).
  - All functions return plain dicts or primitives, never ORM instances.
  - All exceptions are caught and logged at WARNING; callers receive None / False.
  - When DATABASE_URL is unset, async_session() yields None and writes are silently skipped.
  - Read helpers (get_ledger_summary, list_jobs, list_provider_calls) are read-only and
    safe to call from admin/monitoring endpoints.  They never expose credentials or raw
    file content, and they truncate+sanitise error_message fields before returning.
"""

import json
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from app.db.session import async_session  # imported at module level so tests can patch it
from app.utils.logger import setup_logger

logger = setup_logger(__name__)

METERED_CLOUD_PROVIDERS = frozenset({"document_ai", "google_vision", "gemini", "openai"})

# ISO-8601 timestamp captured once at module load; stored in raw_metadata_json as rate_loaded_at
# so every row records when the in-process pricing config was initialised.
_PRICING_LOADED_AT: str = datetime.now(timezone.utc).isoformat()

# Configured-default pricing for cost estimation.
# metered cloud: estimates only — reconcile against provider billing dashboards.
# local providers: zero cost, not metered per call.
# pricing_source is "configured_default" until an env-var override is added.
_LOCAL_RAW: Dict[str, Any] = {
    "is_estimate": False,
    "rate_note": "Local compute cost is not metered per provider call in Phase 1",
}

_PRICING: Dict[str, Dict[str, Any]] = {
    "document_ai": {
        "unit_price_usd": 0.10,
        "pricing_unit": "per_10_pages_document_chunk",
        "pricing_source": "configured_default",
        "cost_basis": "metered_cloud_estimate",
        "_raw_metadata": {
            "rate_reference_url": "https://cloud.google.com/document-ai/pricing",
            "rate_note": "Expense Parser (formerly Receipt Parser): $0.10 per document chunk (1–10 pages = one chunk)",
            "billing_model": "per_document_chunk",
            "chunk_size_pages": 10,
            "chunk_price_usd": 0.10,
            "formula": "ceil(page_count / 10) * 0.10",
            "is_estimate": True,
        },
    },
    "google_vision": {
        "unit_price_usd": 0.0015,
        "pricing_unit": "image",
        "pricing_source": "configured_default",
        "cost_basis": "metered_cloud_estimate",
        "_raw_metadata": {
            "rate_reference_url": "https://cloud.google.com/vision/pricing",
            "rate_note": "Document text detection, first 1000 units/month",
            "is_estimate": True,
        },
    },
    "gemini": {
        "unit_price_usd": 0.20 / 1_000_000,
        "pricing_unit": "token",
        "pricing_source": "configured_default",
        "cost_basis": "metered_cloud_estimate",
        "_raw_metadata": {
            "rate_reference_url": "https://ai.google.dev/pricing",
            "rate_note": "Gemini 1.5 Flash blended input+output estimate, per token",
            "is_estimate": True,
        },
    },
    "openai": {
        "unit_price_usd": 0.30 / 1_000_000,
        "pricing_unit": "token",
        "pricing_source": "configured_default",
        "cost_basis": "metered_cloud_estimate",
        "_raw_metadata": {
            "rate_reference_url": "https://openai.com/pricing",
            "rate_note": "GPT-4o-mini blended input+output estimate, per token",
            "is_estimate": True,
        },
    },
    "tesseract": {
        "unit_price_usd": 0.0,
        "pricing_unit": "local",
        "pricing_source": "local_not_metered",
        "cost_basis": "local_compute_not_metered",
        "_raw_metadata": _LOCAL_RAW,
    },
    "easyocr": {
        "unit_price_usd": 0.0,
        "pricing_unit": "local",
        "pricing_source": "local_not_metered",
        "cost_basis": "local_compute_not_metered",
        "_raw_metadata": _LOCAL_RAW,
    },
    "rapidocr": {
        "unit_price_usd": 0.0,
        "pricing_unit": "local",
        "pricing_source": "local_not_metered",
        "cost_basis": "local_compute_not_metered",
        "_raw_metadata": _LOCAL_RAW,
    },
    "ollama": {
        "unit_price_usd": 0.0,
        "pricing_unit": "local",
        "pricing_source": "local_not_metered",
        "cost_basis": "local_compute_not_metered",
        "_raw_metadata": _LOCAL_RAW,
    },
}


def is_metered_cloud(provider_name: str) -> bool:
    return provider_name in METERED_CLOUD_PROVIDERS


async def create_job(
    request_id: uuid.UUID,
    client_app: Optional[str] = None,
    brand: Optional[str] = None,
    workflow: Optional[str] = None,
    external_reference_type: Optional[str] = None,
    external_reference_id: Optional[str] = None,
    caller_env: Optional[str] = None,
    caller_version: Optional[str] = None,
    user_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    file_name: Optional[str] = None,
    file_content_type: Optional[str] = None,
    input_file_size_bytes: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """
    Insert an ocr_jobs row.

    Returns {"id": str, "request_id": str, "status": "received"} on success,
    or None when the DB is unavailable.
    """
    try:
        from app.db.models import OcrJob

        job_id = uuid.uuid4()
        now = datetime.now(timezone.utc)

        async with async_session() as session:
            if session is None:
                logger.debug("Ledger DB unavailable — skipping create_job")
                return None

            job = OcrJob(
                id=job_id,
                request_id=request_id,
                status="received",
                client_app=client_app,
                brand=brand,
                workflow=workflow,
                external_reference_type=external_reference_type,
                external_reference_id=external_reference_id,
                caller_env=caller_env,
                caller_version=caller_version,
                user_id=user_id,
                idempotency_key=idempotency_key,
                file_name=file_name,
                file_content_type=file_content_type,
                input_file_size_bytes=input_file_size_bytes,
                created_at=now,
                updated_at=now,
            )
            session.add(job)

        return {"id": str(job_id), "request_id": str(request_id), "status": "received"}
    except Exception as exc:
        logger.warning(f"Ledger create_job failed: {exc}")
        return None


async def update_job(
    job_id: uuid.UUID,
    status: Optional[str] = None,
    ocr_provider_used: Optional[str] = None,
    total_estimated_cost_usd: Optional[float] = None,
) -> bool:
    """Update ocr_jobs fields. Valid statuses: received, processing, completed, failed."""
    try:
        from app.db.models import OcrJob
        from sqlalchemy import select

        async with async_session() as session:
            if session is None:
                return False

            row = (await session.execute(select(OcrJob).where(OcrJob.id == job_id))).scalar_one_or_none()
            if row is None:
                logger.warning(f"Ledger update_job: job {job_id} not found")
                return False

            if status is not None:
                row.status = status
            if ocr_provider_used is not None:
                row.ocr_provider_used = ocr_provider_used
            if total_estimated_cost_usd is not None:
                row.total_estimated_cost_usd = total_estimated_cost_usd
            row.updated_at = datetime.now(timezone.utc)

        return True
    except Exception as exc:
        logger.warning(f"Ledger update_job failed: {exc}")
        return False


async def start_provider_call(
    job_id: uuid.UUID,
    request_id: uuid.UUID,
    provider_name: str,
    call_purpose: str,
) -> Optional[uuid.UUID]:
    """
    Insert a provider_calls row with status='started'.

    Returns the new call UUID on success, or None when the DB is unavailable.
    """
    try:
        from app.db.models import ProviderCall

        call_id = uuid.uuid4()
        provider_type = "metered_cloud" if is_metered_cloud(provider_name) else "local_compute_not_metered"

        async with async_session() as session:
            if session is None:
                return None

            call = ProviderCall(
                id=call_id,
                job_id=job_id,
                request_id=request_id,
                provider_name=provider_name,
                provider_type=provider_type,
                call_purpose=call_purpose,
                status="started",
                started_at=datetime.now(timezone.utc),
            )
            session.add(call)

        return call_id
    except Exception as exc:
        logger.warning(f"Ledger start_provider_call failed: {exc}")
        return None


async def complete_provider_call(
    call_id: uuid.UUID,
    status: str,
    provider_name: Optional[str] = None,
    usage_units: Optional[int] = None,
    usage_unit_type: Optional[str] = None,
    estimated_cost_usd: Optional[float] = None,
    error_message: Optional[str] = None,
    duration_ms: Optional[float] = None,
) -> bool:
    """Update provider_calls row with final outcome. Returns True on success."""
    try:
        from app.db.models import ProviderCall
        from sqlalchemy import select

        pricing = _PRICING.get(provider_name or "", {})
        raw_meta = dict(pricing.get("_raw_metadata", {}))
        raw_meta["rate_loaded_at"] = _PRICING_LOADED_AT

        # Default zero cost for local (non-metered) providers when caller didn't supply a value
        unit_price = pricing.get("unit_price_usd")
        if estimated_cost_usd is None and unit_price == 0:
            estimated_cost_usd = 0.0

        now = datetime.now(timezone.utc)

        async with async_session() as session:
            if session is None:
                return False

            row = (
                await session.execute(select(ProviderCall).where(ProviderCall.id == call_id))
            ).scalar_one_or_none()
            if row is None:
                logger.warning(f"Ledger complete_provider_call: call {call_id} not found")
                return False

            row.status = status
            row.usage_units = usage_units
            row.usage_unit_type = usage_unit_type
            row.estimated_cost_usd = estimated_cost_usd
            row.unit_price_usd = unit_price
            row.pricing_unit = pricing.get("pricing_unit")
            row.pricing_source = pricing.get("pricing_source")
            # pricing_effective_date = date this row was priced (not module-load date)
            row.pricing_effective_date = now.date().isoformat()
            row.cost_basis = pricing.get("cost_basis")
            row.raw_metadata_json = json.dumps(raw_meta)
            row.error_message = error_message
            row.duration_ms = duration_ms
            row.completed_at = now

        return True
    except Exception as exc:
        logger.warning(f"Ledger complete_provider_call failed: {exc}")
        return False


async def get_job_cost_summary(job_id: uuid.UUID) -> Dict[str, Any]:
    """
    Sum estimated_cost_usd for all successful provider_calls in a job.

    Returns {"total_usd": float, "available": True} or {"total_usd": None, "available": False}.
    """
    try:
        from app.db.models import ProviderCall
        from sqlalchemy import select, func

        async with async_session() as session:
            if session is None:
                return {"total_usd": None, "available": False}

            result = await session.execute(
                select(func.sum(ProviderCall.estimated_cost_usd)).where(
                    ProviderCall.job_id == job_id,
                    ProviderCall.status == "success",
                )
            )
            total = result.scalar_one_or_none()
            return {"total_usd": float(total) if total is not None else 0.0, "available": True}
    except Exception as exc:
        logger.warning(f"Ledger get_job_cost_summary failed: {exc}")
        return {"total_usd": None, "available": False}


# ---------------------------------------------------------------------------
# Read helpers (admin / cost monitoring)
# ---------------------------------------------------------------------------

_JOBS_MAX_LIMIT = 200
_CALLS_MAX_LIMIT = 200


def _safe_float(v) -> Optional[float]:
    return float(v) if v is not None else None


def _sanitise_error(msg: Optional[str]) -> Optional[str]:
    """Truncate and strip credential URLs from error messages."""
    if not msg:
        return None
    s = str(msg)[:300]
    return s.split("@")[-1] if "@" in s else s


def _job_to_dict(job) -> Dict[str, Any]:
    return {
        "id": str(job.id),
        "request_id": str(job.request_id),
        "client_app": job.client_app,
        "workflow": job.workflow,
        "brand": job.brand,
        "external_reference_type": job.external_reference_type,
        "external_reference_id": job.external_reference_id,
        "ocr_provider_used": job.ocr_provider_used,
        "status": job.status,
        "total_estimated_cost_usd": _safe_float(job.total_estimated_cost_usd),
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
    }


def _call_to_dict(call) -> Dict[str, Any]:
    return {
        "id": str(call.id),
        "job_id": str(call.job_id),
        "provider_name": call.provider_name,
        "provider_type": call.provider_type,
        "call_purpose": call.call_purpose,
        "status": call.status,
        "usage_units": call.usage_units,
        "usage_unit_type": call.usage_unit_type,
        "estimated_cost_usd": _safe_float(call.estimated_cost_usd),
        "pricing_source": call.pricing_source,
        "pricing_effective_date": call.pricing_effective_date,
        "cost_basis": call.cost_basis,
        "error_summary": _sanitise_error(call.error_message),
        "duration_ms": _safe_float(call.duration_ms),
        "started_at": call.started_at.isoformat() if call.started_at else None,
        "completed_at": call.completed_at.isoformat() if call.completed_at else None,
    }


async def get_ledger_summary() -> Dict[str, Any]:
    """
    Aggregate cost and call stats across the last 30 days.
    Returns dict with 'available': False when DB is unreachable.
    """
    try:
        from sqlalchemy import text

        async with async_session() as session:
            if session is None:
                return {"available": False}

            # Cost totals by time window (ocr_jobs)
            totals_row = (await session.execute(text("""
                SELECT
                    SUM(CASE WHEN created_at >= NOW() - INTERVAL '1 day'
                             THEN total_estimated_cost_usd ELSE 0 END)  AS cost_1d,
                    SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days'
                             THEN total_estimated_cost_usd ELSE 0 END)  AS cost_7d,
                    SUM(total_estimated_cost_usd)                        AS cost_30d,
                    COUNT(*)                                             AS jobs_30d,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END)       AS failures_30d
                FROM ocr_jobs
                WHERE created_at >= NOW() - INTERVAL '30 days'
            """))).mappings().one()

            # Calls by provider (provider_calls)
            provider_rows = (await session.execute(text("""
                SELECT
                    provider_name,
                    COUNT(*)                                                          AS call_count,
                    SUM(estimated_cost_usd)                                           AS estimated_cost_usd,
                    COUNT(CASE WHEN status IN ('error','timeout','blocked') THEN 1 END) AS failure_count
                FROM provider_calls
                WHERE started_at >= NOW() - INTERVAL '30 days'
                GROUP BY provider_name
                ORDER BY estimated_cost_usd DESC NULLS LAST
            """))).mappings().all()

            # Top client apps by cost (ocr_jobs)
            app_rows = (await session.execute(text("""
                SELECT
                    client_app,
                    COUNT(*)                        AS job_count,
                    SUM(total_estimated_cost_usd)   AS estimated_cost_usd
                FROM ocr_jobs
                WHERE created_at >= NOW() - INTERVAL '30 days'
                  AND client_app IS NOT NULL
                GROUP BY client_app
                ORDER BY estimated_cost_usd DESC NULLS LAST
                LIMIT 10
            """))).mappings().all()

            return {
                "available": True,
                "window_days": 30,
                "cost_usd": {
                    "last_1d": _safe_float(totals_row["cost_1d"]),
                    "last_7d": _safe_float(totals_row["cost_7d"]),
                    "last_30d": _safe_float(totals_row["cost_30d"]),
                },
                "jobs": {
                    "last_30d": int(totals_row["jobs_30d"] or 0),
                    "failures_30d": int(totals_row["failures_30d"] or 0),
                },
                "by_provider": [
                    {
                        "provider": r["provider_name"],
                        "call_count": int(r["call_count"]),
                        "estimated_cost_usd": _safe_float(r["estimated_cost_usd"]),
                        "failure_count": int(r["failure_count"]),
                    }
                    for r in provider_rows
                ],
                "top_client_apps": [
                    {
                        "client_app": r["client_app"],
                        "job_count": int(r["job_count"]),
                        "estimated_cost_usd": _safe_float(r["estimated_cost_usd"]),
                    }
                    for r in app_rows
                ],
            }
    except Exception as exc:
        logger.warning(f"Ledger get_ledger_summary failed: {exc}")
        return {"available": False, "error": type(exc).__name__}


async def list_jobs(
    limit: int = 50,
    offset: int = 0,
    status: Optional[str] = None,
    client_app: Optional[str] = None,
    workflow: Optional[str] = None,
    external_reference_type: Optional[str] = None,
    external_reference_id: Optional[str] = None,
    created_after: Optional[datetime] = None,
    created_before: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Paginated ocr_jobs list (read-only, no file content).

    Returns {"available": False} when DB is unreachable.
    """
    limit = min(max(1, limit), _JOBS_MAX_LIMIT)
    try:
        from app.db.models import OcrJob
        from sqlalchemy import select, func

        async with async_session() as session:
            if session is None:
                return {"available": False, "total": 0, "items": []}

            base_q = select(OcrJob)
            if status:
                base_q = base_q.where(OcrJob.status == status)
            if client_app:
                base_q = base_q.where(OcrJob.client_app == client_app)
            if workflow:
                base_q = base_q.where(OcrJob.workflow == workflow)
            if external_reference_type:
                base_q = base_q.where(OcrJob.external_reference_type == external_reference_type)
            if external_reference_id:
                base_q = base_q.where(OcrJob.external_reference_id == external_reference_id)
            if created_after:
                base_q = base_q.where(OcrJob.created_at >= created_after)
            if created_before:
                base_q = base_q.where(OcrJob.created_at <= created_before)

            total = (
                await session.execute(select(func.count()).select_from(base_q.subquery()))
            ).scalar_one_or_none() or 0

            rows = (
                await session.execute(
                    base_q.order_by(OcrJob.created_at.desc()).limit(limit).offset(offset)
                )
            ).scalars().all()

            return {
                "available": True,
                "total": int(total),
                "limit": limit,
                "offset": offset,
                "items": [_job_to_dict(j) for j in rows],
            }
    except Exception as exc:
        logger.warning(f"Ledger list_jobs failed: {exc}")
        return {"available": False, "total": 0, "items": []}


async def list_provider_calls(
    limit: int = 50,
    offset: int = 0,
    provider_name: Optional[str] = None,
    status: Optional[str] = None,
    job_id: Optional[uuid.UUID] = None,
    started_after: Optional[datetime] = None,
    started_before: Optional[datetime] = None,
) -> Dict[str, Any]:
    """
    Paginated provider_calls list (read-only, error messages sanitised).

    Returns {"available": False} when DB is unreachable.
    """
    limit = min(max(1, limit), _CALLS_MAX_LIMIT)
    try:
        from app.db.models import ProviderCall
        from sqlalchemy import select, func

        async with async_session() as session:
            if session is None:
                return {"available": False, "total": 0, "items": []}

            base_q = select(ProviderCall)
            if provider_name:
                base_q = base_q.where(ProviderCall.provider_name == provider_name)
            if status:
                base_q = base_q.where(ProviderCall.status == status)
            if job_id:
                base_q = base_q.where(ProviderCall.job_id == job_id)
            if started_after:
                base_q = base_q.where(ProviderCall.started_at >= started_after)
            if started_before:
                base_q = base_q.where(ProviderCall.started_at <= started_before)

            total = (
                await session.execute(select(func.count()).select_from(base_q.subquery()))
            ).scalar_one_or_none() or 0

            rows = (
                await session.execute(
                    base_q.order_by(ProviderCall.started_at.desc()).limit(limit).offset(offset)
                )
            ).scalars().all()

            return {
                "available": True,
                "total": int(total),
                "limit": limit,
                "offset": offset,
                "items": [_call_to_dict(c) for c in rows],
            }
    except Exception as exc:
        logger.warning(f"Ledger list_provider_calls failed: {exc}")
        return {"available": False, "total": 0, "items": []}


async def list_filter_options() -> Dict[str, Any]:
    """
    Return distinct filter values for dashboard dropdowns.

    Queries DISTINCT values from ocr_jobs and provider_calls.
    Nulls are excluded; values sorted alphabetically; max 50 per category.
    Returns {"available": False} when DB is unreachable.
    """
    try:
        from app.db.models import OcrJob, ProviderCall
        from sqlalchemy import select, distinct

        async with async_session() as session:
            if session is None:
                return {"available": False}

            async def _distinct_col(col, limit: int = 50) -> List[str]:
                rows = (
                    await session.execute(
                        select(distinct(col)).where(col.isnot(None)).order_by(col).limit(limit)
                    )
                ).scalars().all()
                return [str(v) for v in rows]

            client_apps = await _distinct_col(OcrJob.client_app)
            workflows = await _distinct_col(OcrJob.workflow)
            ext_ref_types = await _distinct_col(OcrJob.external_reference_type)
            job_statuses = await _distinct_col(OcrJob.status)
            providers = await _distinct_col(ProviderCall.provider_name)
            call_statuses = await _distinct_col(ProviderCall.status)

            return {
                "available": True,
                "client_apps": client_apps,
                "workflows": workflows,
                "external_reference_types": ext_ref_types,
                "job_statuses": job_statuses,
                "providers": providers,
                "call_statuses": call_statuses,
            }
    except Exception as exc:
        logger.warning(f"Ledger list_filter_options failed: {exc}")
        return {"available": False}


async def get_dashboard_data(
    client_app: Optional[str] = None,
    workflow: Optional[str] = None,
    days: int = 30,
) -> Dict[str, Any]:
    """
    Aggregated analytics: daily timeseries, cost by provider/client, status breakdown, recent jobs.
    Returns {"available": False} when DB is unreachable.
    """
    days = min(max(1, days), 90)
    try:
        from sqlalchemy import text, select
        from app.db.models import OcrJob

        async with async_session() as session:
            if session is None:
                return {"available": False}

            params: Dict[str, Any] = {"days_val": days}

            # Build WHERE clauses for ocr_jobs
            simple_parts = ["created_at >= NOW() - :days_val * INTERVAL '1 day'"]
            if client_app:
                simple_parts.append("client_app = :client_app")
                params["client_app"] = client_app
            if workflow:
                simple_parts.append("workflow = :workflow")
                params["workflow"] = workflow
            simple_where = " AND ".join(simple_parts)

            # Build WHERE for provider_calls JOIN
            call_parts = [
                "pc.started_at >= NOW() - :days_val * INTERVAL '1 day'",
                "pc.status = 'success'",
            ]
            if client_app:
                call_parts.append("j.client_app = :client_app")
            if workflow:
                call_parts.append("j.workflow = :workflow")
            call_where = " AND ".join(call_parts)

            ts_rows = (await session.execute(text(f"""
                SELECT DATE(created_at) AS day,
                    COALESCE(SUM(total_estimated_cost_usd), 0) AS cost_usd,
                    COUNT(*) AS job_count
                FROM ocr_jobs
                WHERE {simple_where}
                GROUP BY DATE(created_at)
                ORDER BY day ASC
            """), params)).mappings().all()

            prov_rows = (await session.execute(text(f"""
                SELECT pc.provider_name,
                    COALESCE(SUM(pc.estimated_cost_usd), 0) AS cost_usd,
                    COUNT(*) AS call_count
                FROM provider_calls pc
                JOIN ocr_jobs j ON pc.job_id = j.id
                WHERE {call_where}
                GROUP BY pc.provider_name
                ORDER BY cost_usd DESC NULLS LAST
            """), params)).mappings().all()

            app_rows = (await session.execute(text(f"""
                SELECT client_app,
                    COALESCE(SUM(total_estimated_cost_usd), 0) AS cost_usd,
                    COUNT(*) AS job_count
                FROM ocr_jobs
                WHERE {simple_where}
                  AND client_app IS NOT NULL
                GROUP BY client_app
                ORDER BY cost_usd DESC NULLS LAST
                LIMIT 10
            """), params)).mappings().all()

            st_rows = (await session.execute(text(f"""
                SELECT status, COUNT(*) AS count
                FROM ocr_jobs
                WHERE {simple_where}
                GROUP BY status
                ORDER BY count DESC
            """), params)).mappings().all()

            # Recent 10 jobs and last 5 failures via ORM
            recent_q = select(OcrJob)
            fail_q = select(OcrJob).where(OcrJob.status == "failed")
            for q in (recent_q, fail_q):
                pass
            if client_app:
                recent_q = recent_q.where(OcrJob.client_app == client_app)
                fail_q = fail_q.where(OcrJob.client_app == client_app)
            if workflow:
                recent_q = recent_q.where(OcrJob.workflow == workflow)
                fail_q = fail_q.where(OcrJob.workflow == workflow)
            recent = (
                await session.execute(recent_q.order_by(OcrJob.created_at.desc()).limit(10))
            ).scalars().all()
            failures = (
                await session.execute(fail_q.order_by(OcrJob.created_at.desc()).limit(5))
            ).scalars().all()

            return {
                "available": True,
                "window_days": days,
                "timeseries": [
                    {
                        "date": str(r["day"]),
                        "cost_usd": float(r["cost_usd"] or 0),
                        "job_count": int(r["job_count"]),
                    }
                    for r in ts_rows
                ],
                "cost_by_provider": [
                    {
                        "provider": r["provider_name"],
                        "cost_usd": float(r["cost_usd"] or 0),
                        "call_count": int(r["call_count"]),
                    }
                    for r in prov_rows
                ],
                "cost_by_client_app": [
                    {
                        "client_app": r["client_app"],
                        "cost_usd": float(r["cost_usd"] or 0),
                        "job_count": int(r["job_count"]),
                    }
                    for r in app_rows
                ],
                "status_breakdown": [
                    {"status": r["status"], "count": int(r["count"])}
                    for r in st_rows
                ],
                "recent_jobs": [_job_to_dict(j) for j in recent],
                "recent_failures": [_job_to_dict(j) for j in failures],
            }
    except Exception as exc:
        logger.warning(f"Ledger get_dashboard_data failed: {exc}")
        return {"available": False, "error": type(exc).__name__}


async def job_lookup(
    job_id: Optional[str] = None,
    request_id: Optional[str] = None,
    external_reference_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Look up a single OCR job with nested provider calls.
    Returns {"available": False} when DB unreachable, {"found": False} when not found.
    """
    if not any([job_id, request_id, external_reference_id]):
        return {"found": False, "error": "At least one search parameter required"}
    try:
        from app.db.models import OcrJob, ProviderCall
        from sqlalchemy import select

        async with async_session() as session:
            if session is None:
                return {"available": False}

            q = select(OcrJob)
            if job_id:
                try:
                    q = q.where(OcrJob.id == uuid.UUID(job_id))
                except ValueError:
                    return {"found": False, "error": "job_id must be a valid UUID"}
            elif request_id:
                try:
                    q = q.where(OcrJob.request_id == uuid.UUID(request_id))
                except ValueError:
                    return {"found": False, "error": "request_id must be a valid UUID"}
            else:
                q = q.where(OcrJob.external_reference_id == external_reference_id)

            job = (await session.execute(q.limit(1))).scalar_one_or_none()
            if job is None:
                return {"available": True, "found": False}

            calls = (
                await session.execute(
                    select(ProviderCall)
                    .where(ProviderCall.job_id == job.id)
                    .order_by(ProviderCall.started_at.asc())
                )
            ).scalars().all()

            job_dict = _job_to_dict(job)
            job_dict["provider_calls"] = [_call_to_dict(c) for c in calls]
            return {"available": True, "found": True, "job": job_dict}
    except Exception as exc:
        logger.warning(f"Ledger job_lookup failed: {exc}")
        return {"available": False, "error": type(exc).__name__}
