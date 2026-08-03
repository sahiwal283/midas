"""
Configuration management for OCR Service
"""

import os
from typing import List, Optional
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables"""
    
    # Service Info
    SERVICE_NAME: str = os.getenv("SERVICE_NAME", "ocr-service")
    VERSION: str = "0.15.0"  # v0.15.0: corrections-driven extraction rules (merchant/amount/date/category accuracy overhaul)
    APP_VERSION: str = os.getenv("APP_VERSION", "0.3.0")
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development")
    
    # Server Config
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    INSTANCE: str = os.getenv("INSTANCE", "0.0.0.0:8080")
    RELOAD: bool = os.getenv("ENVIRONMENT", "development") == "development"
    
    # OCR Provider Config
    PRIMARY_OCR_PROVIDER: str = os.getenv("PRIMARY_OCR_PROVIDER", "document_ai")  # document_ai, google_vision, rapidocr, tesseract
    FALLBACK_OCR_PROVIDER: Optional[str] = os.getenv("FALLBACK_OCR_PROVIDER", "tesseract")
    OCR_LANGUAGES: List[str] = ["eng"]  # Tesseract uses 3-letter codes
    OCR_CONFIDENCE_THRESHOLD: float = 0.6
    
    # Google Document AI Config (RECOMMENDED for receipts)
    GOOGLE_CLOUD_PROJECT_ID: Optional[str] = os.getenv("GOOGLE_CLOUD_PROJECT_ID")
    GOOGLE_APPLICATION_CREDENTIALS: Optional[str] = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    DOCUMENT_AI_LOCATION: str = os.getenv("DOCUMENT_AI_LOCATION", "us")
    DOCUMENT_AI_PROCESSOR_ID: Optional[str] = os.getenv("DOCUMENT_AI_PROCESSOR_ID")  # Optional: use specific processor
    DOCUMENT_AI_TIMEOUT: int = int(os.getenv("DOCUMENT_AI_TIMEOUT", "30"))
    DOCUMENT_AI_MAX_RETRIES: int = int(os.getenv("DOCUMENT_AI_MAX_RETRIES", "2"))
    DOCUMENT_AI_PDF_TIMEOUT: int = int(os.getenv("DOCUMENT_AI_PDF_TIMEOUT", "15"))
    DOCUMENT_AI_PDF_MAX_RETRIES: int = int(os.getenv("DOCUMENT_AI_PDF_MAX_RETRIES", "0"))
    PDF_PRIMARY_SCRIPT_TIMEOUT: int = int(os.getenv("PDF_PRIMARY_SCRIPT_TIMEOUT", "45"))
    PDF_FALLBACK_MAX_PAGES: int = int(os.getenv("PDF_FALLBACK_MAX_PAGES", "2"))
    
    # Google Vision API Config (fallback for general OCR)
    GOOGLE_VISION_API_KEY: Optional[str] = os.getenv("GOOGLE_VISION_API_KEY")
    GOOGLE_VISION_TIMEOUT: int = int(os.getenv("GOOGLE_VISION_TIMEOUT", "30"))
    GOOGLE_VISION_MAX_RETRIES: int = int(os.getenv("GOOGLE_VISION_MAX_RETRIES", "2"))
    
    # Python Settings
    PYTHON_PATH: str = os.getenv("PYTHON_PATH", "python3")
    
    # File Upload Settings
    MAX_FILE_SIZE: int = int(os.getenv("MAX_FILE_SIZE", "10485760"))  # 10MB default
    ALLOWED_EXTENSIONS: List[str] = ["jpg", "jpeg", "png", "pdf", "heic", "heif", "webp"]
    UPLOAD_DIR: str = os.getenv("UPLOAD_DIR", "/tmp/ocr_uploads")
    
    # Training & Inference
    ENABLE_LLM_INFERENCE: bool = os.getenv("ENABLE_LLM_INFERENCE", "false").lower() == "true"
    LLM_PROVIDER: Optional[str] = os.getenv("LLM_PROVIDER", "ollama")  # ollama, openai, gemini, claude
    
    # LLM Provider Settings
    OLLAMA_URL: Optional[str] = os.getenv("OLLAMA_URL")
    OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "dolphin-llama3")
    OPENAI_API_KEY: Optional[str] = os.getenv("OPENAI_API_KEY")
    OPENAI_MODEL: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    GEMINI_API_KEY: Optional[str] = os.getenv("GEMINI_API_KEY")
    GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
    
    # Model Training Service
    MODEL_TRAINING_URL: Optional[str] = os.getenv("MODEL_TRAINING_URL")
    
    # LLM Enhancement Strategy
    HIGH_CONFIDENCE_SAMPLE_RATE: float = float(os.getenv("HIGH_CONFIDENCE_SAMPLE_RATE", "0.00"))  # Disabled: Ollama too slow for sampling
    
    # Logging
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    LOG_OCR_RESULTS: bool = os.getenv("LOG_OCR_RESULTS", "true").lower() == "true"
    
    # CORS
    CORS_ORIGINS: List[str] = os.getenv("CORS_ORIGINS", "").split(",") if os.getenv("CORS_ORIGINS") else []
    
    # Cache & Performance
    ENABLE_CACHE: bool = os.getenv("ENABLE_CACHE", "false").lower() == "true"
    CACHE_TTL: int = int(os.getenv("CACHE_TTL", "3600"))  # 1 hour
    
    # Model Retraining Schedule
    RETRAINING_INTERVAL_HOURS: int = int(os.getenv("RETRAINING_INTERVAL_HOURS", "24"))
    
    # Cost ledger (Phase 1 durable cost tracking)
    DATABASE_URL: Optional[str] = os.getenv("DATABASE_URL")
    # When True, paid cloud providers (document_ai, google_vision, openai, gemini) are blocked
    # if the cost ledger DB is unavailable. Requires DATABASE_URL to be set.
    REQUIRE_COST_LEDGER: bool = os.getenv("REQUIRE_COST_LEDGER", "false").lower() == "true"
    # Local OCR provider to use for images when REQUIRE_COST_LEDGER=true and all metered
    # providers are blocked (ledger unavailable).  Must be a non-metered provider (tesseract
    # or easyocr).  Unset by default — blocked behaviour is preserved unless explicitly opted in.
    LEDGER_UNAVAILABLE_FALLBACK_PROVIDER: Optional[str] = os.getenv("LEDGER_UNAVAILABLE_FALLBACK_PROVIDER")

    # Phase 2C async job worker
    ASYNC_WORKER_ENABLED: bool = os.getenv("ASYNC_WORKER_ENABLED", "false").lower() == "true"
    # How long the worker sleeps between polls when no queued jobs are found (seconds).
    ASYNC_WORKER_POLL_INTERVAL_SECONDS: int = int(os.getenv("ASYNC_WORKER_POLL_INTERVAL_SECONDS", "5"))
    # Jobs stuck in status=running beyond this many seconds are considered stale and requeued/failed.
    ASYNC_WORKER_LOCK_TIMEOUT_SECONDS: int = int(os.getenv("ASYNC_WORKER_LOCK_TIMEOUT_SECONDS", "600"))
    # Stable identifier for this worker process/container. Defaults to hostname:pid at runtime.
    ASYNC_WORKER_ID: Optional[str] = os.getenv("ASYNC_WORKER_ID")

    # Path to the .env file inside the container for admin apply writes.
    # Must be a writable bind mount of the host .env (e.g. ./.env:/app/.env.writable:rw).
    # If this file does not exist, POST /admin/settings/apply returns 500 with a clear message.
    OCR_ENV_WRITABLE_PATH: str = os.getenv("OCR_ENV_WRITABLE_PATH", "/app/.env.writable")
    # TTL in seconds for preview tokens issued by POST /admin/settings/preview.
    PREVIEW_TOKEN_TTL_SECONDS: int = int(os.getenv("PREVIEW_TOKEN_TTL_SECONDS", "900"))

    # Admin API auth (interim until Authentik forward-auth integration)
    # Set OCR_ADMIN_INTERNAL_TOKEN to a long random secret.
    # If unset, /admin/* endpoints return 503 (not silently open).
    OCR_ADMIN_INTERNAL_TOKEN: Optional[str] = os.getenv("OCR_ADMIN_INTERNAL_TOKEN")

    # Service-to-service auth for OCR processing endpoints (separate from admin token)
    OCR_SERVICE_INTERNAL_TOKEN: Optional[str] = os.getenv("OCR_SERVICE_INTERNAL_TOKEN")
    # When true, POST /ocr/ and /ocr/jobs/* require X-Internal-Token: <OCR_SERVICE_INTERNAL_TOKEN>
    # Set to true in production before wiring up any external caller (e.g. Midas).
    OCR_REQUIRE_SERVICE_TOKEN: bool = os.getenv("OCR_REQUIRE_SERVICE_TOKEN", "false").lower() == "true"

    # Phase 2A — Authentik forward-auth via NPM Plus trusted headers.
    # ADMIN_AUTH_MODE controls which auth path is accepted:
    #   "internal_token" (default/current) — only X-Internal-Token
    #   "trusted_headers" — only Authentik-injected headers from ADMIN_TRUSTED_PROXY_IPS
    #   "both" (migration) — either path accepted (use during NPM Plus rollout)
    # Do not set to "trusted_headers" or "both" until NPM Plus → Authentik is fully wired.
    ADMIN_AUTH_MODE: str = os.getenv("ADMIN_AUTH_MODE", "internal_token")

    # Comma-separated list of trusted proxy IPs that may inject Authentik identity headers.
    # Used only when ADMIN_AUTH_MODE is "trusted_headers" or "both".
    # Default: NPM Plus static IP on this network.
    ADMIN_TRUSTED_PROXY_IPS: str = os.getenv("ADMIN_TRUSTED_PROXY_IPS", "")

    # Authentik group that grants OCR admin access.
    # X-authentik-groups header (pipe-separated) must contain this group.
    # Used only when ADMIN_AUTH_MODE is "trusted_headers" or "both".
    OCR_AUTH_PROXY_REQUIRED_GROUP: str = os.getenv("OCR_AUTH_PROXY_REQUIRED_GROUP", "ocr-admins")

    # URL of the Authentik-protected OCR admin UI (through NPM Plus proxy).
    # Shown as the SSO sign-in target in the admin UI when no trusted headers are present.
    # Example: https://ocr.your-domain.org/admin/ui
    # Leave empty until NPM Plus proxy host for OCR is configured.
    OCR_ADMIN_SSO_URL: Optional[str] = os.getenv("OCR_ADMIN_SSO_URL")

    # Business telemetry (optional – LLM/API cost tracking)
    TELEMETRY_INGESTION_URL: Optional[str] = os.getenv("TELEMETRY_INGESTION_URL")
    TELEMETRY_API_KEY: str = os.getenv("TELEMETRY_API_KEY", "changeme_api_key_here")
    # Estimated USD rates (optional overrides; see app/services/usage_pricing.py)
    # TELEMETRY_DOCUMENT_AI_USD_PER_CHUNK, TELEMETRY_GOOGLE_VISION_USD_PER_IMAGE,
    # TELEMETRY_GEMINI_USD_PER_1M_TOKENS, TELEMETRY_OPENAI_USD_PER_1M_TOKENS
    
    class Config:
        env_file = ".env"
        case_sensitive = True


# Global settings instance
settings = Settings()

