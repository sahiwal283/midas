"""
OCR processing endpoints
"""

import uuid
from fastapi import APIRouter, Depends, File, Header, UploadFile, HTTPException, status
from typing import Dict, Any, Optional
import os

from app.utils.ocr_auth import ServiceIdentity, require_service_token

from app.config import settings
from app.utils.logger import setup_logger
from app.utils.file_utils import save_upload_file, cleanup_file
from app.utils.image_normalize import normalize_upload_for_ocr
from app.db.ledger import create_job, update_job
from app.services.ocr_engine import ocr_engine
from app.services.ocr_pipeline import run_ocr_pipeline

router = APIRouter(prefix="/ocr", tags=["ocr"])
logger = setup_logger(__name__)


@router.post("/", status_code=status.HTTP_200_OK)
@router.post("/process", status_code=status.HTTP_200_OK)  # Backward compatibility
async def process_ocr(
    file: UploadFile = File(...),
    x_request_id: Optional[str] = Header(None, alias="X-Request-ID"),
    x_client_app: Optional[str] = Header(None, alias="X-Client-App"),
    x_brand: Optional[str] = Header(None, alias="X-Brand"),
    x_workflow: Optional[str] = Header(None, alias="X-Workflow"),
    x_external_reference_type: Optional[str] = Header(None, alias="X-External-Reference-Type"),
    x_external_reference_id: Optional[str] = Header(None, alias="X-External-Reference-ID"),
    x_user_id: Optional[str] = Header(None, alias="X-User-ID"),
    x_caller_env: Optional[str] = Header(None, alias="X-Caller-Env"),
    x_caller_version: Optional[str] = Header(None, alias="X-Caller-Version"),
    x_idempotency_key: Optional[str] = Header(None, alias="X-Idempotency-Key"),
    # Backward-compatible: X-Expense-ID maps to external_reference_type=expense
    x_expense_id: Optional[str] = Header(None, alias="X-Expense-ID"),
    _service: Optional[ServiceIdentity] = Depends(require_service_token),
) -> Dict[str, Any]:
    """
    Process image or PDF with OCR and extract structured fields.

    Returns OCR result with extracted text, confidence, inferred fields, and cost tracking metadata.
    """
    file_path = None
    job_id: Optional[uuid.UUID] = None
    ledger_recorded = False

    # Resolve request_id: accept from caller or generate server-side
    try:
        request_id = uuid.UUID(x_request_id) if x_request_id else uuid.uuid4()
    except ValueError:
        request_id = uuid.uuid4()

    try:
        file_size: Optional[int] = None
        try:
            file_size = file.size  # available on UploadFile when spooled to disk
        except Exception:
            pass

        # X-Expense-ID backward compat: map to generic reference fields when explicit type absent.
        # When both X-External-Reference-ID and X-Expense-ID are present and differ,
        # X-External-Reference-ID takes precedence; log a warning so the caller can clean up.
        ext_ref_type = x_external_reference_type or ("expense" if x_expense_id else None)
        ext_ref_id = x_external_reference_id or x_expense_id
        if x_external_reference_id and x_expense_id and x_external_reference_id != x_expense_id:
            logger.warning(
                "Both X-External-Reference-ID and X-Expense-ID were provided with different values; "
                "X-External-Reference-ID takes precedence (X-Expense-ID treated as legacy). "
                "client_app=%r request_id=%s",
                x_client_app,
                request_id,
            )

        job_dict = await create_job(
            request_id=request_id,
            client_app=x_client_app,
            brand=x_brand,
            workflow=x_workflow,
            external_reference_type=ext_ref_type,
            external_reference_id=ext_ref_id,
            caller_env=x_caller_env,
            caller_version=x_caller_version,
            user_id=x_user_id,
            idempotency_key=x_idempotency_key,
            file_name=file.filename,
            file_content_type=file.content_type,
            input_file_size_bytes=file_size,
        )
        if job_dict:
            job_id = uuid.UUID(job_dict["id"])
            ledger_recorded = True

        # Save and normalise the uploaded file
        file_path = await save_upload_file(file)
        file_path = normalize_upload_for_ocr(file_path)
        logger.info(f"Processing file: {file.filename} -> {file_path} (request_id={request_id})")

        is_pdf = file_path.lower().endswith(".pdf")

        return await run_ocr_pipeline(
            file_path=file_path,
            is_pdf=is_pdf,
            job_id=job_id,
            request_id=request_id,
            ledger_recorded=ledger_recorded,
        )

    except HTTPException:
        # Safety net: update job for failures that occurred before or inside the pipeline.
        # The pipeline already updates the job on OCR hard failure; this is a double-update
        # safety net for failures in the file-handling phase.
        if job_id:
            await update_job(job_id, status="failed")
        raise
    except Exception as e:
        logger.error(f"OCR endpoint error: {str(e)}", exc_info=True)
        if job_id:
            await update_job(job_id, status="failed")
        error_detail = str(e) if settings.ENVIRONMENT == "development" else "Internal server error"
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=error_detail,
        )
    finally:
        # Cleanup uploaded file regardless of outcome
        if file_path and os.path.exists(file_path):
            cleanup_file(file_path)


@router.get("/providers", status_code=status.HTTP_200_OK)
async def get_providers() -> Dict[str, Any]:
    """
    Get available OCR providers and their status.
    """
    availability = await ocr_engine.is_available()

    return {
        "providers": {
            "primary": settings.PRIMARY_OCR_PROVIDER,
            "fallback": settings.FALLBACK_OCR_PROVIDER,
            "availability": availability,
        },
        "languages": settings.OCR_LANGUAGES,
        "confidenceThreshold": settings.OCR_CONFIDENCE_THRESHOLD,
    }
