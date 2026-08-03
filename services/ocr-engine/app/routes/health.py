"""
Health check endpoints
"""

import asyncio

from fastapi import APIRouter, status
from typing import Dict, Any, Optional
from datetime import datetime

from app.config import settings
from app.services.ocr_engine import ocr_engine
from app.services.llm_provider import get_llm_provider
from app.services.prompt_service import prompt_service
from app.utils.logger import setup_logger

logger = setup_logger(__name__)
router = APIRouter(tags=["health"])


@router.get("/health", status_code=status.HTTP_200_OK)
async def health_check() -> Dict[str, Any]:
    """
    Health check endpoint
    
    Returns service status, basic information, and integration status
    """
    # Quick integration health checks (non-blocking)
    integrations_status = {}
    
    # LLM status
    if settings.ENABLE_LLM_INFERENCE:
        llm_provider = get_llm_provider()
        if llm_provider:
            try:
                llm_available = await llm_provider.check_availability()
                integrations_status["llm"] = {
                    "provider": settings.LLM_PROVIDER,
                    "available": llm_available,
                    "url": settings.OLLAMA_URL if settings.LLM_PROVIDER == "ollama" else "openai"
                }
            except Exception:
                integrations_status["llm"] = {"available": False, "error": "check_failed"}
    
    # Model Training status
    try:
        integrations_status["model_training"] = {
            "url": settings.MODEL_TRAINING_URL,
            "cached_version": prompt_service.cached_version,
            "cache_age_hours": (
                (datetime.utcnow() - prompt_service.cache_timestamp).total_seconds() / 3600
                if prompt_service.cache_timestamp else None
            )
        }
    except Exception:
        integrations_status["model_training"] = {"status": "unknown"}
    
    return {
        "status": "ok",
        "service": settings.SERVICE_NAME,
        "version": settings.VERSION,
        "environment": settings.ENVIRONMENT,
        "integrations": integrations_status,
        "timestamp": datetime.utcnow().isoformat()
    }


@router.get("/health/ready", status_code=status.HTTP_200_OK)
async def readiness_check() -> Dict[str, Any]:
    """
    Readiness check endpoint
    
    Checks if service is ready to accept requests.
    Includes OCR providers, LLM provider, and Model Training service.
    """
    # Check OCR provider availability
    provider_availability = await ocr_engine.is_available()
    
    # Check LLM provider availability (if enabled)
    llm_available: Optional[bool] = None
    if settings.ENABLE_LLM_INFERENCE:
        llm_provider = get_llm_provider()
        if llm_provider:
            try:
                llm_available = await llm_provider.check_availability()
            except Exception as e:
                llm_available = False
    
    # Check Model Training service availability
    model_training_available = False
    try:
        # Hard 2s cap: callers probe /health/ready with short timeouts (the
        # trade-show backend uses 5s), and get_active_prompt() otherwise waits
        # out its full 30s httpx timeout when the training host is down.
        prompt = await asyncio.wait_for(prompt_service.get_active_prompt(), timeout=2.0)
        model_training_available = prompt is not None
    except Exception:
        model_training_available = False
    
    # Service is ready if at least one OCR provider is available
    # LLM and Model Training are optional
    all_ready = any(provider_availability.values())
    
    integrations = {
        "ocr_providers": provider_availability,
        "llm": {
            "enabled": settings.ENABLE_LLM_INFERENCE,
            "available": llm_available,
            "provider": settings.LLM_PROVIDER if settings.ENABLE_LLM_INFERENCE else None
        },
        "model_training": {
            "available": model_training_available,
            "url": settings.MODEL_TRAINING_URL,
            "cached_prompt_version": prompt_service.cached_version
        }
    }
    
    return {
        "ready": all_ready,
        "service": settings.SERVICE_NAME,
        "integrations": integrations,
        "timestamp": datetime.utcnow().isoformat()
    }


@router.get("/health/live", status_code=status.HTTP_200_OK)
async def liveness_check() -> Dict[str, Any]:
    """
    Liveness check endpoint
    
    Simple check that the service is running
    """
    return {
        "alive": True,
        "service": settings.SERVICE_NAME,
        "timestamp": datetime.utcnow().isoformat()
    }


@router.get("/health/ledger", status_code=status.HTTP_200_OK)
async def ledger_health_check() -> Dict[str, Any]:
    """
    Ledger DB health / readiness check.

    Verifies:
    - PostgreSQL connectivity (SELECT 1)
    - Required tables exist: ocr_jobs, provider_calls, alembic_version
    - alembic_version has at least one row
    - Write capability via a rolled-back transaction (no committed rows)

    Returns HTTP 200 with status "ready" or "not_ready" so monitoring scripts
    can rely on the payload rather than the status code.
    """
    from app.db.session import _engine
    from sqlalchemy import text

    connected = False
    tables_ok = False
    alembic_ok = False
    write_ok = False
    db_error: Optional[str] = None
    alembic_version: Optional[str] = None

    if _engine is None:
        db_error = "DB engine not initialised (DATABASE_URL not set or init_db not called)"
    else:
        try:
            async with _engine.connect() as conn:
                # 1. Basic connectivity
                await conn.execute(text("SELECT 1"))
                connected = True

                # 2. Required tables
                required = {"ocr_jobs", "provider_calls", "alembic_version"}
                result = await conn.execute(
                    text(
                        "SELECT tablename FROM pg_tables "
                        "WHERE schemaname = 'public' AND tablename = ANY(:names)"
                    ),
                    {"names": list(required)},
                )
                found = {row[0] for row in result}
                tables_ok = required == found

                # 3. Alembic version row
                if "alembic_version" in found:
                    av_result = await conn.execute(
                        text("SELECT version_num FROM alembic_version LIMIT 1")
                    )
                    row = av_result.fetchone()
                    if row:
                        alembic_ok = True
                        alembic_version = row[0]

                # 4. Write check — insert inside a savepoint then ALWAYS rollback.
                #    conn is already in autobegin; begin_nested() uses SAVEPOINT
                #    so begin() is not called twice. No row is ever committed.
                if tables_ok:
                    trans = await conn.begin_nested()
                    try:
                        await conn.execute(
                            text(
                                "INSERT INTO ocr_jobs "
                                "(id, request_id, status, client_app, workflow, created_at, updated_at) "
                                "VALUES "
                                "(gen_random_uuid(), gen_random_uuid(), 'healthcheck', "
                                "'ledger-healthcheck', 'readiness', NOW(), NOW())"
                            )
                        )
                        write_ok = True
                    except Exception as exc:
                        logger.warning(f"Ledger write check failed: {exc}")
                    finally:
                        await trans.rollback()

        except Exception as exc:
            db_error = str(exc)
            logger.warning(f"Ledger health check error: {exc}")

    overall = "ready" if (connected and tables_ok and alembic_ok and write_ok) else "not_ready"

    return {
        "status": overall,
        "version": settings.VERSION,
        "ledger_db": {
            "connected": connected,
            "tables_ok": tables_ok,
            "alembic_ok": alembic_ok,
            "alembic_version": alembic_version,
            "write_ok": write_ok,
            "error": db_error,
        },
        "require_cost_ledger": settings.REQUIRE_COST_LEDGER,
        "timestamp": datetime.utcnow().isoformat(),
    }

