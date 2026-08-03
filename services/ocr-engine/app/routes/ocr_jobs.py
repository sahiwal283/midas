"""
Async OCR job endpoints — Phase 2C Slice 2B (durable enqueue).

POST /ocr/jobs              → 202 only when file saved AND DB row committed
GET  /ocr/jobs/{job_id}     → 200 job, 404 not found, 503 DB unavailable
GET  /admin/ocr/jobs        → paginated list, 503 DB unavailable

Service endpoints (POST /ocr/jobs, GET /ocr/jobs/{id}) require OCR_SERVICE_INTERNAL_TOKEN.
Admin endpoints (GET /admin/ocr/jobs) require OCR_ADMIN_INTERNAL_TOKEN.
OCR processing is done by the async worker (not yet enabled — ASYNC_WORKER_ENABLED=false).
"""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile

from app.db.async_jobs import AsyncJobDBError, enqueue_async_job, get_async_job, list_async_jobs
from app.utils.admin_auth import AdminIdentity, require_admin_token
from app.utils.file_utils import cleanup_async_job_dir, save_async_job_file
from app.utils.logger import setup_logger
from app.utils.ocr_auth import ServiceIdentity, require_service_token

logger = setup_logger(__name__)

router = APIRouter(prefix="/ocr/jobs", tags=["async-ocr"])
admin_router = APIRouter(prefix="/admin/ocr/jobs", tags=["admin-async-ocr"])


@router.post("", status_code=202)
async def enqueue_ocr_job(
    file: UploadFile = File(...),
    client_app: Optional[str] = Header(None, alias="X-Client-App"),
    workflow: Optional[str] = Header(None, alias="X-Workflow"),
    external_reference_id: Optional[str] = Header(None, alias="X-External-Reference-Id"),
    external_reference_type: Optional[str] = Header(None, alias="X-External-Reference-Type"),
    _service: Optional[ServiceIdentity] = Depends(require_service_token),
):
    """
    Enqueue a receipt image/PDF for async OCR processing.

    Returns 202 only when both the file is saved to durable storage AND the
    ocr_async_jobs row is committed to the DB.  If DB persistence fails the
    saved file/directory is cleaned up and 503 is returned — no ghost jobs.
    No OCR calls are made here.
    """
    job_id = uuid.uuid4()
    file_path: Optional[str] = None

    try:
        file_path = await save_async_job_file(file, job_id)

        job_row = await enqueue_async_job(
            job_id=job_id,
            input_file_path=file_path,
            original_filename=file.filename,
            mime_type=file.content_type,
            client_app=client_app,
            workflow=workflow,
            external_reference_id=external_reference_id,
            external_reference_type=external_reference_type,
        )
    except AsyncJobDBError:
        # File was saved but DB failed — remove the orphaned directory.
        if file_path is not None:
            try:
                cleanup_async_job_dir(job_id)
            except Exception as cleanup_exc:
                logger.warning(f"Cleanup failed after DB error: {type(cleanup_exc).__name__}")
        raise HTTPException(
            status_code=503,
            detail="Async OCR job could not be persisted. Please retry.",
        )
    except HTTPException:
        # File validation / size errors from save_async_job_file — pass through.
        raise
    except Exception as exc:
        logger.warning(f"Unexpected enqueue error: {type(exc).__name__}")
        if file_path is not None:
            try:
                cleanup_async_job_dir(job_id)
            except Exception:
                pass
        raise HTTPException(status_code=503, detail="Async OCR job could not be persisted.")

    return {
        "job_id": str(job_id),
        "status": "queued",
        "status_url": f"/ocr/jobs/{job_id}",
    }


@router.get("/{job_id}")
async def get_ocr_job_status(
    job_id: uuid.UUID,
    _service: Optional[ServiceIdentity] = Depends(require_service_token),
):
    """
    Get the current status and metadata of an async OCR job.

    Returns 200 when found, 404 when the job does not exist,
    503 when the DB cannot be reached.
    """
    try:
        job = await get_async_job(job_id)
    except AsyncJobDBError:
        raise HTTPException(
            status_code=503,
            detail="Job status unavailable: database cannot be reached.",
        )

    if job is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    return job


@admin_router.get("")
async def list_ocr_jobs_admin(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: Optional[str] = Query(None),
    client_app: Optional[str] = Query(None),
    _admin: AdminIdentity = Depends(require_admin_token),
):
    """Admin: list async OCR jobs with optional status and client_app filters.
    Returns 503 when the DB cannot be reached."""
    try:
        return await list_async_jobs(
            limit=limit,
            offset=offset,
            status=status,
            client_app=client_app,
        )
    except AsyncJobDBError:
        raise HTTPException(
            status_code=503,
            detail="Job list unavailable: database cannot be reached.",
        )
