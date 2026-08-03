"""
OCR Microservice - FastAPI Application

A standalone REST API for OCR processing of receipts and invoices.
Extracted from Expense App for independent deployment and scaling.
"""

from typing import Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import time
import asyncio

from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.utils.logger import setup_logger
from app.routes import health, ocr, ocr_jobs, webhooks, admin, admin_ui
from app.services.prompt_service import prompt_service
from app.services.llm_provider import get_llm_provider
from app.services.metrics import (
    init_build_info_metric,
    classify_endpoint_from_request,
    metrics_response,
    record_http_request,
)

logger = setup_logger(__name__)


def _validate_configuration() -> None:
    """
    Validate application configuration at startup
    
    Raises:
        ValueError: If required configuration is missing or invalid
    """
    # Validate CORS configuration for production
    if settings.ENVIRONMENT == "production":
        if "*" in settings.CORS_ORIGINS:
            logger.error("CORS allows all origins in production - security risk!")
            raise ValueError("CORS_ORIGINS cannot be '*' in production environment")
        if not settings.CORS_ORIGINS or (len(settings.CORS_ORIGINS) == 1 and not settings.CORS_ORIGINS[0]):
            logger.warning("CORS_ORIGINS is empty in production - API may not be accessible")
    
    # Validate LLM configuration if LLM inference is enabled
    if settings.ENABLE_LLM_INFERENCE:
        if not settings.OLLAMA_URL and settings.LLM_PROVIDER == "ollama":
            raise ValueError("OLLAMA_URL is required when LLM inference is enabled with ollama provider")
        if not settings.OPENAI_API_KEY and settings.LLM_PROVIDER == "openai":
            raise ValueError("OPENAI_API_KEY is required when LLM inference is enabled with openai provider")
    
    # Validate Model Training URL if LLM is enabled (needed for prompts)
    if settings.ENABLE_LLM_INFERENCE and not settings.MODEL_TRAINING_URL:
        logger.warning("MODEL_TRAINING_URL not set - prompt service may not work correctly")

    # REQUIRE_COST_LEDGER=true demands a DATABASE_URL so paid providers can be gated.
    if settings.REQUIRE_COST_LEDGER and not settings.DATABASE_URL:
        raise ValueError("DATABASE_URL is required when REQUIRE_COST_LEDGER=true")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager
    
    Handles startup and shutdown events, including:
    - Background task management
    - HTTP client cleanup
    """
    # Startup
    logger.info(f"Starting {settings.SERVICE_NAME} v{settings.VERSION}")
    logger.info(f"Environment: {settings.ENVIRONMENT}")
    logger.info(f"Primary OCR Provider: {settings.PRIMARY_OCR_PROVIDER}")
    logger.info(f"Fallback OCR Provider: {settings.FALLBACK_OCR_PROVIDER}")
    logger.info(f"Metrics instance label: {settings.INSTANCE}")

    # Validate configuration
    _validate_configuration()
    init_build_info_metric()

    # Initialise cost ledger DB engine (no-op when DATABASE_URL is unset)
    if settings.DATABASE_URL:
        from app.db.session import init_db
        init_db(settings.DATABASE_URL)
        logger.info("Cost ledger DB engine initialised")
    else:
        logger.info("DATABASE_URL not set — cost ledger running in best-effort-no-op mode")
    
    # Ensure upload directories exist
    import os
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    os.makedirs(os.path.join(settings.UPLOAD_DIR, "async_jobs"), exist_ok=True)
    logger.info(f"Upload directory: {settings.UPLOAD_DIR}")
    
    # Start background prompt refresh task
    refresh_task = None
    try:
        refresh_task = asyncio.create_task(prompt_service.start_background_refresh())
        logger.info("Background prompt refresh task started")
    except Exception as e:
        logger.warning(f"Failed to start background refresh task: {str(e)}")
    
    yield
    
    # Shutdown
    logger.info("Shutting down OCR Microservice")
    
    # Cancel background task
    if refresh_task:
        try:
            refresh_task.cancel()
            try:
                await refresh_task
            except asyncio.CancelledError:
                logger.info("Background refresh task cancelled successfully")
        except Exception as e:
            logger.warning(f"Error cancelling background task: {str(e)}")
    
    # Close HTTP clients
    try:
        await prompt_service.close()
        logger.info("Prompt service HTTP client closed")
    except Exception as e:
        logger.warning(f"Error closing prompt service client: {str(e)}")
    
    try:
        llm = get_llm_provider()
        if llm:
            await llm.close()
            logger.info("LLM provider HTTP client closed")
    except Exception as e:
        logger.warning(f"Error closing LLM provider client: {str(e)}")
    
    logger.info("Shutdown complete")


# Create FastAPI application
app = FastAPI(
    title="OCR Microservice",
    description=(
        "Standalone REST API for OCR processing of receipts and invoices.\n\n"
        f"**Made with ♥ by your haute tech team · OCR Service v{settings.VERSION}**"
    ),
    version=settings.VERSION,
    lifespan=lifespan
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Prometheus metrics middleware (same pattern as zoho-integration-service / shipping-app)
class HTTPMetricsMiddleware(BaseHTTPMiddleware):
    """Capture request volume and latency for all HTTP requests."""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        start = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            latency_seconds = max(time.perf_counter() - start, 0.0)
            record_http_request(
                method=request.method,
                path=request.url.path,
                status_code=status_code,
                duration_seconds=latency_seconds,
                endpoint_class=classify_endpoint_from_request(request),
            )
            logger.info(
                f"{request.method} {request.url.path} completed in {latency_seconds:.3f}s "
                f"(status: {status_code})"
            )


app.add_middleware(HTTPMetricsMiddleware)


# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Handle uncaught exceptions"""
    logger.error(f"Unhandled exception: {str(exc)}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error",
            "error": str(exc) if settings.ENVIRONMENT == "development" else "An unexpected error occurred"
        }
    )


# Include routers
app.include_router(health.router)
app.include_router(ocr.router)
app.include_router(ocr_jobs.router)
app.include_router(ocr_jobs.admin_router)
app.include_router(webhooks.router)
app.include_router(admin.auth_router)
app.include_router(admin.router)
app.include_router(admin.providers_router)
app.include_router(admin.audit_router)
app.include_router(admin.settings_router)
app.include_router(admin_ui.router)

# Backward compatibility routes for old API versions
app.include_router(ocr.router, prefix="/api/v1")  # Adds /api/v1/ocr/* routes
app.include_router(ocr.router, prefix="/api")     # Adds /api/ocr/* routes


# Root endpoint
@app.get("/")
async def root():
    """Root endpoint with service information"""
    return {
        "service": settings.SERVICE_NAME,
        "version": settings.VERSION,
        "environment": settings.ENVIRONMENT,
        "status": "running",
        "branding": f"Made with ♥ by your haute tech team · OCR Service v{settings.VERSION}",
        "endpoints": {
            "health": "/health",
            "ready": "/health/ready",
            "live": "/health/live",
            "ocr": "/ocr/",
            "providers": "/ocr/providers",
            "webhook_prompt_update": "/webhooks/prompt-updated",
            "metrics": "/metrics",
            "docs": "/docs",
            "openapi": "/openapi.json"
        }
    }


@app.get("/metrics", include_in_schema=False)
def prometheus_metrics() -> Response:
    """Prometheus metrics endpoint (same pattern as zoho-integration-service)."""
    return metrics_response()


if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.RELOAD,
        log_level=settings.LOG_LEVEL.lower()
    )

