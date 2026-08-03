"""
DB helpers for the ocr_async_jobs table.

Design differs from ledger.py for write operations:
  - enqueue_async_job() RAISES AsyncJobDBError on any failure (DB unavailable,
    session None, or insert error).  The route must treat the job as unaccepted
    and clean up the saved file.
  - get_async_job() raises AsyncJobDBError on DB errors, returns None for
    true not-found so the route can distinguish 503 from 404.
  - list_async_jobs() raises AsyncJobDBError on DB errors so the route can
    return 503 rather than an empty 200.
  - Worker helpers (claim_next_async_job, mark_async_job_succeeded,
    mark_async_job_failed, requeue_stale_jobs) raise AsyncJobDBError on DB
    failure so the worker loop can back off.
  - All functions log sanitised errors at WARNING before raising.
"""

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from app.db.session import async_session
from app.utils.logger import setup_logger

logger = setup_logger(__name__)

_JOBS_MAX_LIMIT = 200


class AsyncJobDBError(Exception):
    """Raised when the async_jobs DB operation cannot complete."""


def _async_job_to_dict(job) -> Dict[str, Any]:
    result = None
    if job.result_json:
        try:
            result = json.loads(job.result_json)
        except (ValueError, TypeError):
            result = None

    return {
        "job_id": str(job.id),
        "status": job.status,
        "client_app": job.client_app,
        "workflow": job.workflow,
        "external_reference_id": job.external_reference_id,
        "external_reference_type": job.external_reference_type,
        "input_file_path": job.input_file_path,
        "original_filename": job.original_filename,
        "mime_type": job.mime_type,
        "attempt_count": job.attempt_count,
        "max_attempts": job.max_attempts,
        "queued_at": job.queued_at.isoformat() if job.queued_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "error_summary": job.error_summary,
        "result": result,
    }


async def enqueue_async_job(
    job_id: uuid.UUID,
    input_file_path: str,
    original_filename: Optional[str] = None,
    mime_type: Optional[str] = None,
    client_app: Optional[str] = None,
    workflow: Optional[str] = None,
    external_reference_id: Optional[str] = None,
    external_reference_type: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Insert an ocr_async_jobs row with status=queued.

    Returns the new job dict on success.
    Raises AsyncJobDBError when the DB is unavailable or the insert fails.
    The caller must clean up the saved file on failure.
    """
    try:
        from app.db.models import OcrAsyncJob

        now = datetime.now(timezone.utc)
        async with async_session() as session:
            if session is None:
                raise AsyncJobDBError("Job persistence is unavailable: database not configured")

            job = OcrAsyncJob(
                id=job_id,
                status="queued",
                input_file_path=input_file_path,
                original_filename=original_filename,
                mime_type=mime_type,
                client_app=client_app,
                workflow=workflow,
                external_reference_id=external_reference_id,
                external_reference_type=external_reference_type,
                attempt_count=0,
                max_attempts=3,
                queued_at=now,
                created_at=now,
                updated_at=now,
            )
            session.add(job)

        return _async_job_to_dict(job)
    except AsyncJobDBError:
        raise
    except Exception as exc:
        logger.warning(f"enqueue_async_job failed: {type(exc).__name__}")
        raise AsyncJobDBError(f"Job persistence failed: {type(exc).__name__}") from exc


async def get_async_job(job_id: uuid.UUID) -> Optional[Dict[str, Any]]:
    """
    Fetch a single ocr_async_jobs row by primary key.

    Returns None when the row does not exist (true not-found → 404).
    Raises AsyncJobDBError when the DB is unavailable or the query fails (→ 503).
    """
    try:
        from app.db.models import OcrAsyncJob
        from sqlalchemy import select

        async with async_session() as session:
            if session is None:
                raise AsyncJobDBError("Job status is unavailable: database not configured")

            row = (
                await session.execute(select(OcrAsyncJob).where(OcrAsyncJob.id == job_id))
            ).scalar_one_or_none()

            if row is None:
                return None

            return _async_job_to_dict(row)
    except AsyncJobDBError:
        raise
    except Exception as exc:
        logger.warning(f"get_async_job failed: {type(exc).__name__}")
        raise AsyncJobDBError(f"Job lookup failed: {type(exc).__name__}") from exc


async def list_async_jobs(
    limit: int = 50,
    offset: int = 0,
    status: Optional[str] = None,
    client_app: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Paginated list of ocr_async_jobs (read-only).

    Returns the paginated result dict on success.
    Raises AsyncJobDBError when the DB is unavailable or the query fails (→ 503).
    """
    limit = min(max(1, limit), _JOBS_MAX_LIMIT)
    try:
        from app.db.models import OcrAsyncJob
        from sqlalchemy import select, func

        async with async_session() as session:
            if session is None:
                raise AsyncJobDBError("Job list is unavailable: database not configured")

            base_q = select(OcrAsyncJob)
            if status:
                base_q = base_q.where(OcrAsyncJob.status == status)
            if client_app:
                base_q = base_q.where(OcrAsyncJob.client_app == client_app)

            total = (
                await session.execute(select(func.count()).select_from(base_q.subquery()))
            ).scalar_one_or_none() or 0

            rows = (
                await session.execute(
                    base_q.order_by(OcrAsyncJob.queued_at.desc()).limit(limit).offset(offset)
                )
            ).scalars().all()

            return {
                "available": True,
                "total": int(total),
                "limit": limit,
                "offset": offset,
                "items": [_async_job_to_dict(j) for j in rows],
            }
    except AsyncJobDBError:
        raise
    except Exception as exc:
        logger.warning(f"list_async_jobs failed: {type(exc).__name__}")
        raise AsyncJobDBError(f"Job list failed: {type(exc).__name__}") from exc


# ---------------------------------------------------------------------------
# Worker helpers
# ---------------------------------------------------------------------------

async def claim_next_async_job(worker_id: str) -> Optional[Dict[str, Any]]:
    """
    Atomically claim one queued job using SELECT FOR UPDATE SKIP LOCKED.

    Sets status=running, increments attempt_count, records locked_at/locked_by
    and started_at (on first attempt only).  Returns the updated job dict, or
    None when no queued jobs exist.
    Raises AsyncJobDBError on DB failure.
    """
    try:
        from app.db.models import OcrAsyncJob
        from sqlalchemy import select

        now = datetime.now(timezone.utc)

        async with async_session() as session:
            if session is None:
                raise AsyncJobDBError("DB unavailable for job claim")

            stmt = (
                select(OcrAsyncJob)
                .where(OcrAsyncJob.status == "queued")
                .order_by(OcrAsyncJob.queued_at.asc())
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            result = await session.execute(stmt)
            job = result.scalar_one_or_none()

            if job is None:
                return None

            job.status = "running"
            job.attempt_count = (job.attempt_count or 0) + 1
            job.locked_at = now
            job.locked_by = worker_id
            if job.started_at is None:
                job.started_at = now
            job.updated_at = now

        return _async_job_to_dict(job)
    except AsyncJobDBError:
        raise
    except Exception as exc:
        logger.warning(f"claim_next_async_job failed: {type(exc).__name__}")
        raise AsyncJobDBError(f"Job claim failed: {type(exc).__name__}") from exc


async def mark_async_job_succeeded(
    job_id: uuid.UUID,
    result_json: str,
    ocr_job_id: Optional[uuid.UUID] = None,
) -> bool:
    """
    Mark a job succeeded: status=succeeded, store result_json, set completed_at.

    Returns True on success, False if the row was not found.
    Raises AsyncJobDBError on DB failure.
    """
    try:
        from app.db.models import OcrAsyncJob
        from sqlalchemy import select

        now = datetime.now(timezone.utc)

        async with async_session() as session:
            if session is None:
                raise AsyncJobDBError("DB unavailable for mark_async_job_succeeded")

            row = (
                await session.execute(select(OcrAsyncJob).where(OcrAsyncJob.id == job_id))
            ).scalar_one_or_none()

            if row is None:
                logger.warning(f"mark_async_job_succeeded: job {job_id} not found")
                return False

            row.status = "succeeded"
            row.result_json = result_json
            row.completed_at = now
            row.locked_at = None
            row.locked_by = None
            row.updated_at = now
            if ocr_job_id is not None:
                row.ocr_job_id = ocr_job_id

        return True
    except AsyncJobDBError:
        raise
    except Exception as exc:
        logger.warning(f"mark_async_job_succeeded failed: {type(exc).__name__}")
        raise AsyncJobDBError(f"mark_async_job_succeeded failed: {type(exc).__name__}") from exc


async def mark_async_job_failed(
    job_id: uuid.UUID,
    error_summary: str,
    requeue: bool = False,
) -> bool:
    """
    Mark a job failed or re-queue it for another attempt.

    requeue=False  → status=failed, completed_at=now (terminal)
    requeue=True   → status=queued, locked_at/locked_by cleared (will be retried)

    Returns True on success, False if row not found.
    Raises AsyncJobDBError on DB failure.
    """
    try:
        from app.db.models import OcrAsyncJob
        from sqlalchemy import select

        now = datetime.now(timezone.utc)

        async with async_session() as session:
            if session is None:
                raise AsyncJobDBError("DB unavailable for mark_async_job_failed")

            row = (
                await session.execute(select(OcrAsyncJob).where(OcrAsyncJob.id == job_id))
            ).scalar_one_or_none()

            if row is None:
                logger.warning(f"mark_async_job_failed: job {job_id} not found")
                return False

            row.error_summary = str(error_summary)[:500]
            row.locked_at = None
            row.locked_by = None
            row.updated_at = now

            if requeue:
                row.status = "queued"
            else:
                row.status = "failed"
                row.completed_at = now

        return True
    except AsyncJobDBError:
        raise
    except Exception as exc:
        logger.warning(f"mark_async_job_failed failed: {type(exc).__name__}")
        raise AsyncJobDBError(f"mark_async_job_failed failed: {type(exc).__name__}") from exc


async def update_async_job_file_path(job_id: uuid.UUID, new_path: str) -> bool:
    """
    Update input_file_path after format normalization (WebP/HEIC → JPEG).

    Called by the worker when normalize_upload_for_ocr() converts a file and
    deletes the original, so the DB reflects the current path on disk.

    Returns True on success, False if the row was not found.
    Raises AsyncJobDBError on DB failure.
    """
    try:
        from app.db.models import OcrAsyncJob
        from sqlalchemy import select

        now = datetime.now(timezone.utc)

        async with async_session() as session:
            if session is None:
                raise AsyncJobDBError("DB unavailable for update_async_job_file_path")

            row = (
                await session.execute(select(OcrAsyncJob).where(OcrAsyncJob.id == job_id))
            ).scalar_one_or_none()

            if row is None:
                logger.warning(f"update_async_job_file_path: job {job_id} not found")
                return False

            row.input_file_path = new_path
            row.updated_at = now

        return True
    except AsyncJobDBError:
        raise
    except Exception as exc:
        logger.warning(f"update_async_job_file_path failed: {type(exc).__name__}")
        raise AsyncJobDBError(f"update_async_job_file_path failed: {type(exc).__name__}") from exc


async def requeue_stale_jobs(stale_timeout_seconds: int = 600) -> int:
    """
    Detect jobs stuck in status=running beyond stale_timeout_seconds.

    - If attempt_count < max_attempts: reset to status=queued (will be retried).
    - If attempt_count >= max_attempts: mark status=failed.

    Returns the count of jobs processed.  Raises AsyncJobDBError on DB failure.
    """
    try:
        from app.db.models import OcrAsyncJob
        from sqlalchemy import select

        cutoff = datetime.now(timezone.utc) - timedelta(seconds=stale_timeout_seconds)
        now = datetime.now(timezone.utc)
        processed = 0

        async with async_session() as session:
            if session is None:
                raise AsyncJobDBError("DB unavailable for requeue_stale_jobs")

            rows = (
                await session.execute(
                    select(OcrAsyncJob).where(
                        OcrAsyncJob.status == "running",
                        OcrAsyncJob.locked_at < cutoff,
                    )
                )
            ).scalars().all()

            for row in rows:
                row.locked_at = None
                row.locked_by = None
                row.updated_at = now
                if (row.attempt_count or 0) < (row.max_attempts or 3):
                    row.status = "queued"
                    logger.info(f"Requeued stale job {row.id} (attempt {row.attempt_count})")
                else:
                    row.status = "failed"
                    row.completed_at = now
                    row.error_summary = "Exceeded max attempts after worker crash"
                    logger.warning(f"Failed stale job {row.id}: max attempts exceeded")
                processed += 1

        return processed
    except AsyncJobDBError:
        raise
    except Exception as exc:
        logger.warning(f"requeue_stale_jobs failed: {type(exc).__name__}")
        raise AsyncJobDBError(f"requeue_stale_jobs failed: {type(exc).__name__}") from exc
