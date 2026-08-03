"""
Async OCR worker — Phase 2C Slice 3.

Polls the ocr_async_jobs table, claims queued jobs with SELECT FOR UPDATE
SKIP LOCKED, runs run_ocr_pipeline(), and writes the result back.

Disabled by default. Set ASYNC_WORKER_ENABLED=true to activate.

Run as a separate process:
    python -m app.services.ocr_worker

Or via docker-compose (profiles: [worker]):
    docker compose --profile worker up -d ocr_worker
"""

import asyncio
import json
import os
import socket
import sys
import time
import uuid
from typing import Any, Dict, Optional

from app.config import settings
from app.db.async_jobs import (
    AsyncJobDBError,
    claim_next_async_job,
    mark_async_job_failed,
    mark_async_job_succeeded,
    requeue_stale_jobs,
    update_async_job_file_path,
)
from app.db.ledger import create_job
from app.services.ocr_pipeline import run_ocr_pipeline
from app.utils.image_normalize import normalize_upload_for_ocr
from app.utils.logger import setup_logger

logger = setup_logger(__name__)

_HEARTBEAT_FILE = "/tmp/ocr_worker_heartbeat"


def _write_heartbeat() -> None:
    """Write a timestamp to the heartbeat file so Docker healthcheck stays green."""
    try:
        with open(_HEARTBEAT_FILE, "w") as fh:
            fh.write(str(time.time()))
    except OSError:
        pass


def _worker_id() -> str:
    """Return a stable worker identity string for lock attribution."""
    if settings.ASYNC_WORKER_ID:
        return settings.ASYNC_WORKER_ID
    return f"{socket.gethostname()}:{os.getpid()}"


async def process_async_job(job: Dict[str, Any]) -> None:
    """
    Process one claimed async job end-to-end.

    1. Validate the input file exists.
    2. Create a cost-ledger (ocr_jobs) row.
    3. Run run_ocr_pipeline().
    4. Write result_json and mark succeeded.
    5. On any failure: mark failed or requeue depending on attempt_count.

    File cleanup is NOT performed here — files are retained for debugging.
    """
    async_job_id = uuid.UUID(job["job_id"])
    file_path: Optional[str] = job.get("input_file_path")
    attempt = job.get("attempt_count", 1)
    max_attempts = job.get("max_attempts", 3)

    logger.info(
        f"Processing async job {async_job_id} "
        f"(attempt {attempt}/{max_attempts}, file={file_path})"
    )

    # ------------------------------------------------------------------
    # 1. Validate input file
    # ------------------------------------------------------------------
    if not file_path or not os.path.exists(file_path):
        logger.error(f"Input file missing for job {async_job_id}: {file_path!r}")
        # Missing file will not be fixed by retrying — mark permanently failed.
        try:
            await mark_async_job_failed(
                async_job_id,
                error_summary="Input file not found on disk",
                requeue=False,
            )
        except AsyncJobDBError as exc:
            logger.warning(f"Could not mark job {async_job_id} failed: {exc}")
        return

    # ------------------------------------------------------------------
    # 2. Normalize image format (WebP/HEIC → JPEG)
    # ------------------------------------------------------------------
    normalized_path = normalize_upload_for_ocr(file_path)

    # When normalization converts the file, the original is deleted and
    # input_file_path in the DB now points to a missing file.  Update it
    # so subsequent status checks and any requeue see the current path.
    if normalized_path != file_path:
        try:
            await update_async_job_file_path(async_job_id, normalized_path)
        except AsyncJobDBError as exc:
            logger.warning(f"Could not update file path for job {async_job_id}: {exc}")

    # ------------------------------------------------------------------
    # 3. Create cost-ledger row
    # ------------------------------------------------------------------
    request_id = uuid.uuid4()
    job_dict = await create_job(
        request_id=request_id,
        client_app=job.get("client_app"),
        workflow=job.get("workflow"),
        external_reference_id=job.get("external_reference_id"),
        external_reference_type=job.get("external_reference_type"),
        file_name=job.get("original_filename"),
        file_content_type=job.get("mime_type"),
    )
    ledger_job_id: Optional[uuid.UUID] = uuid.UUID(job_dict["id"]) if job_dict else None
    ledger_recorded = ledger_job_id is not None

    # ------------------------------------------------------------------
    # 4. Run pipeline
    # ------------------------------------------------------------------
    is_pdf = normalized_path.lower().endswith(".pdf")
    try:
        result = await run_ocr_pipeline(
            file_path=normalized_path,
            is_pdf=is_pdf,
            job_id=ledger_job_id,
            request_id=request_id,
            ledger_recorded=ledger_recorded,
        )
        result_json = json.dumps(result)
        await mark_async_job_succeeded(
            async_job_id,
            result_json=result_json,
            ocr_job_id=ledger_job_id,
        )
        logger.info(f"Job {async_job_id} succeeded")

    except Exception as exc:
        error_summary = f"{type(exc).__name__}: {str(exc)[:300]}"
        logger.warning(f"Job {async_job_id} failed (attempt {attempt}): {error_summary}")

        should_requeue = attempt < max_attempts
        try:
            await mark_async_job_failed(
                async_job_id,
                error_summary=error_summary,
                requeue=should_requeue,
            )
        except AsyncJobDBError as db_exc:
            logger.warning(f"Could not mark job {async_job_id} failed: {db_exc}")

        if should_requeue:
            logger.info(f"Job {async_job_id} requeued for attempt {attempt + 1}/{max_attempts}")


async def _worker_loop(worker_id: str) -> None:
    """Main polling loop — runs indefinitely until the process is killed."""
    poll_interval = settings.ASYNC_WORKER_POLL_INTERVAL_SECONDS
    lock_timeout = settings.ASYNC_WORKER_LOCK_TIMEOUT_SECONDS

    logger.info(f"Worker loop started: id={worker_id!r}, poll={poll_interval}s, lock_timeout={lock_timeout}s")

    while True:
        _write_heartbeat()
        try:
            # Recover stale jobs from crashed workers before claiming new work.
            staled = await requeue_stale_jobs(stale_timeout_seconds=lock_timeout)
            if staled:
                logger.info(f"Recovered {staled} stale job(s)")

            job = await claim_next_async_job(worker_id)

            if job is None:
                # No work available — sleep before polling again.
                await asyncio.sleep(poll_interval)
                continue

            logger.info(f"Claimed job {job['job_id']} (attempt {job['attempt_count']})")
            await process_async_job(job)
            # No sleep — immediately look for the next queued job.

        except AsyncJobDBError as exc:
            logger.warning(f"DB error in worker loop: {exc} — sleeping {poll_interval}s")
            await asyncio.sleep(poll_interval)
        except asyncio.CancelledError:
            logger.info("Worker loop cancelled — exiting cleanly")
            break
        except Exception as exc:
            logger.error(f"Unexpected worker loop error: {exc}", exc_info=True)
            await asyncio.sleep(poll_interval)


def main() -> None:
    """
    CLI entrypoint.

    Exits immediately (code 0) when ASYNC_WORKER_ENABLED=false so the container
    can be started with the profile but remains dormant until the flag is set.
    """
    if not settings.ASYNC_WORKER_ENABLED:
        logger.info("ASYNC_WORKER_ENABLED=false — worker is disabled, exiting")
        sys.exit(0)

    # Initialise the DB engine (lifespan doesn't run for a bare Python process).
    if settings.DATABASE_URL:
        from app.db.session import init_db
        init_db(settings.DATABASE_URL)
        logger.info("DB engine initialised")
    else:
        logger.warning("DATABASE_URL not set — worker cannot persist jobs; exiting")
        sys.exit(1)

    worker_id = _worker_id()
    logger.info(f"Starting OCR async worker v{settings.VERSION}: {worker_id}")

    try:
        asyncio.run(_worker_loop(worker_id))
    except KeyboardInterrupt:
        logger.info("Worker stopped by keyboard interrupt")


if __name__ == "__main__":
    main()
