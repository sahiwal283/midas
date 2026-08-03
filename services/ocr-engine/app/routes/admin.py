"""
Read-only admin / cost monitoring and provider configuration endpoints.

INTERNAL USE ONLY.
All routes require X-Internal-Token: <OCR_ADMIN_INTERNAL_TOKEN>.
Planned: migrate to Authentik SSO via NPM Plus trusted headers (Phase 2A SSO).
See docs/OCR_AUTHENTIK_SETUP.md for NPM/Authentik configuration.

Routers exported:
    router           — /admin/ledger/*    (cost ledger read endpoints)
    providers_router — /admin/providers/* (provider config read + validation)
    audit_router     — /admin/audit/*     (audit log read endpoint)
    settings_router  — /admin/settings/*  (settings dashboard + preview)

All handlers receive an AdminIdentity from require_admin_token().
Audit events are written as BackgroundTasks — best-effort, never break the response.
"""

import base64
import hashlib
import hmac as _hmac
import json
import os
import shutil
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
import uuid

from pydantic import BaseModel

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request, Response

from app.config import settings
from app.db.audit import list_audit_logs, write_audit_log
from app.db.ledger import (
    METERED_CLOUD_PROVIDERS,
    get_dashboard_data,
    get_ledger_summary,
    job_lookup,
    list_filter_options,
    list_jobs,
    list_provider_calls,
)
from app.db.session import async_session  # module-level so tests can patch it
from app.utils.admin_auth import AdminIdentity, require_admin_token
from app.utils.logger import setup_logger

logger = setup_logger(__name__)

_SECURITY_HEADERS = {
    "X-Internal-Only": "true",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


def _mark_internal(response: Response) -> None:
    for k, v in _SECURITY_HEADERS.items():
        response.headers[k] = v


def _queue_audit(
    background_tasks: BackgroundTasks,
    identity: AdminIdentity,
    action: str,
    resource_type: Optional[str] = None,
    success: bool = True,
    error_summary: Optional[str] = None,
) -> None:
    """Enqueue a best-effort audit write — never blocks the response."""
    background_tasks.add_task(
        write_audit_log,
        action=action,
        actor_type=identity.actor_type,
        actor_id=identity.actor_id,
        actor_username=identity.username,
        resource_type=resource_type,
        source_ip=identity.source_ip,
        user_agent=identity.user_agent,
        success=success,
        error_summary=error_summary,
    )


def _parse_datetime(value: Optional[str], param_name: str) -> Optional[datetime]:
    """Parse ISO-8601 date or datetime string; raises 422 on bad format."""
    if not value:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(value, fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    from fastapi import HTTPException, status as http_status
    raise HTTPException(
        status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=f"{param_name} must be ISO-8601 date (YYYY-MM-DD) or datetime (YYYY-MM-DDTHH:MM:SS)",
    )


# ---------------------------------------------------------------------------
# Auth status router — /admin/auth/*  (no auth dependency — safe for public UI)
# ---------------------------------------------------------------------------

auth_router = APIRouter(prefix="/admin/auth", tags=["admin"], include_in_schema=False)


@auth_router.get("/status")
async def admin_auth_status(request: Request):
    """
    Public endpoint — returns current admin auth state for the UI to decide
    whether to show the SSO button or the dashboard.

    Does NOT require authentication.  Never returns tokens or secrets.
    Safe to call from an unauthenticated browser session.
    """
    from app.utils.admin_auth import _require_authentik_headers

    auth_mode = settings.ADMIN_AUTH_MODE
    sso_url = settings.OCR_ADMIN_SSO_URL or None
    break_glass_available = bool(settings.OCR_ADMIN_INTERNAL_TOKEN) and auth_mode in (
        "internal_token",
        "both",
    )

    if auth_mode in ("trusted_headers", "both"):
        try:
            source_ip = request.client.host if request.client else None
            user_agent = request.headers.get("user-agent")
            identity = _require_authentik_headers(request, source_ip, user_agent)
            return {
                "authenticated": True,
                "auth_source": "authentik_proxy",
                "username": identity.username,
                "email": request.headers.get("X-authentik-email", ""),
                "groups": identity.groups,
                "sso_url": sso_url,
                "break_glass_available": break_glass_available,
            }
        except Exception:
            pass

    return {
        "authenticated": False,
        "auth_source": None,
        "username": None,
        "email": None,
        "groups": [],
        "sso_url": sso_url,
        "break_glass_available": break_glass_available,
    }


# ---------------------------------------------------------------------------
# Ledger router — /admin/ledger/*
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/admin/ledger", tags=["admin"])


@router.get("/summary")
async def admin_ledger_summary(
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
):
    """
    Aggregated cost and call stats for the last 30 days.

    Includes cost by time window, call/failure counts by provider,
    and top client apps by estimated spend.
    """
    _mark_internal(response)
    result = await get_ledger_summary()
    _queue_audit(background_tasks, identity, "admin.ledger.summary.view", "ledger")
    return result


@router.get("/jobs")
async def admin_ledger_jobs(
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    status: Optional[str] = Query(default=None, description="Filter by job status"),
    client_app: Optional[str] = Query(default=None, description="Filter by client app"),
    workflow: Optional[str] = Query(default=None, description="Filter by workflow"),
    external_reference_type: Optional[str] = Query(
        default=None, description="Filter by external reference type (e.g. expense_receipt)"
    ),
    external_reference_id: Optional[str] = Query(
        default=None, description="Filter by external reference ID (e.g. receipt:<uuid>)"
    ),
    created_after: Optional[str] = Query(
        default=None, description="Filter jobs created at or after (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)"
    ),
    created_before: Optional[str] = Query(
        default=None, description="Filter jobs created at or before (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)"
    ),
):
    """
    Paginated list of OCR jobs.

    Returns job metadata only — no file content, no uploaded documents.
    Supports filtering by: status, client_app, workflow, external_reference_type,
    external_reference_id, created_after, created_before.
    """
    _mark_internal(response)
    after_dt = _parse_datetime(created_after, "created_after")
    before_dt = _parse_datetime(created_before, "created_before")
    result = await list_jobs(
        limit=limit,
        offset=offset,
        status=status,
        client_app=client_app,
        workflow=workflow,
        external_reference_type=external_reference_type,
        external_reference_id=external_reference_id,
        created_after=after_dt,
        created_before=before_dt,
    )
    _queue_audit(background_tasks, identity, "admin.ledger.jobs.view", "ledger")
    return result


@router.get("/provider-calls")
async def admin_ledger_provider_calls(
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    provider_name: Optional[str] = Query(default=None, description="Filter by provider name"),
    status: Optional[str] = Query(default=None, description="Filter by call status (success/error/started/timeout/blocked/skipped)"),
    job_id: Optional[str] = Query(default=None, description="Filter by job UUID"),
    started_after: Optional[str] = Query(
        default=None, description="Filter calls started at or after (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)"
    ),
    started_before: Optional[str] = Query(
        default=None, description="Filter calls started at or before (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)"
    ),
):
    """
    Paginated list of provider call records.

    Error messages are sanitised (credential URLs stripped) before returning.
    Supports filtering by: provider_name, status, job_id, started_after, started_before.
    """
    _mark_internal(response)
    parsed_job_id: Optional[uuid.UUID] = None
    if job_id:
        try:
            parsed_job_id = uuid.UUID(job_id)
        except ValueError:
            from fastapi import HTTPException, status as http_status
            raise HTTPException(
                status_code=http_status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="job_id must be a valid UUID",
            )

    after_dt = _parse_datetime(started_after, "started_after")
    before_dt = _parse_datetime(started_before, "started_before")

    result = await list_provider_calls(
        limit=limit,
        offset=offset,
        provider_name=provider_name,
        status=status,
        job_id=parsed_job_id,
        started_after=after_dt,
        started_before=before_dt,
    )
    _queue_audit(background_tasks, identity, "admin.ledger.provider_calls.view", "provider_calls")
    return result


@router.get("/health")
async def admin_ledger_health(
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
):
    """
    Lightweight DB availability check plus service configuration snapshot.

    For the full deep-check (tables, alembic, write probe) use GET /health/ledger.
    """
    _mark_internal(response)

    db_ok = False
    try:
        from sqlalchemy import text

        async with async_session() as session:
            if session is not None:
                await session.execute(text("SELECT 1"))
                db_ok = True
    except Exception:
        pass

    result = {
        "db_available": db_ok,
        "require_cost_ledger": settings.REQUIRE_COST_LEDGER,
        # async_worker_enabled reflects THIS container's config (ocr_service).
        # The ocr_worker container may have ASYNC_WORKER_ENABLED=true independently.
        # Use GET /admin/settings for full async worker context.
        "async_worker_enabled": settings.ASYNC_WORKER_ENABLED,
        "web_service_async_worker_enabled": settings.ASYNC_WORKER_ENABLED,
        "worker_introspection_note": (
            "Worker status reflects API container config only. "
            "Runtime introspection of ocr_worker container requires host Docker socket access, "
            "which is not mounted in the API container. See GET /admin/settings for details."
        ),
        "primary_provider": settings.PRIMARY_OCR_PROVIDER,
        "fallback_provider": settings.FALLBACK_OCR_PROVIDER,
        "ledger_unavailable_fallback_provider": settings.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER,
        "version": settings.VERSION,
        "_note": "Use GET /health/ledger for the full deep-check including write probe.",
        "_internal_only": True,
    }
    _queue_audit(background_tasks, identity, "admin.ledger.health.view", "health")
    return result


@router.get("/filter-options")
async def admin_ledger_filter_options(
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
):
    """
    Distinct filter values for dashboard dropdowns.

    Returns client_apps, workflows, external_reference_types, job_statuses,
    providers, and call_statuses drawn from the live ledger.
    Values are sorted alphabetically; nulls excluded; max 50 per category.
    Returns {"available": False} when DB is unreachable.
    """
    _mark_internal(response)
    result = await list_filter_options()
    _queue_audit(background_tasks, identity, "admin.ledger.filter_options.view", "ledger")
    return result


@router.get("/dashboard")
async def admin_ledger_dashboard(
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
    client_app: Optional[str] = Query(default=None, description="Filter by client app"),
    workflow: Optional[str] = Query(default=None, description="Filter by workflow"),
    days: int = Query(default=30, ge=1, le=90, description="Look-back window in days (max 90)"),
):
    """
    Dashboard aggregations: daily timeseries, cost by provider/client, status breakdown, recent jobs.

    Supports optional client_app and workflow filters plus a configurable look-back window.
    Returns {"available": False} when DB is unreachable.
    """
    _mark_internal(response)
    result = await get_dashboard_data(client_app=client_app, workflow=workflow, days=days)
    _queue_audit(background_tasks, identity, "admin.ledger.dashboard.view", "ledger")
    return result


@router.get("/job-lookup")
async def admin_ledger_job_lookup(
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
    job_id: Optional[str] = Query(default=None, description="OCR job UUID"),
    request_id: Optional[str] = Query(default=None, description="Request UUID"),
    external_reference_id: Optional[str] = Query(
        default=None, description="External reference ID (e.g. receipt:<uuid>)"
    ),
):
    """
    Look up a single OCR job with its nested provider calls.

    Exactly one of job_id, request_id, or external_reference_id must be provided.
    Returns {"found": False} when no matching job exists.
    """
    from fastapi import HTTPException

    if not any([job_id, request_id, external_reference_id]):
        raise HTTPException(
            status_code=422,
            detail="At least one of job_id, request_id, external_reference_id is required",
        )
    _mark_internal(response)
    result = await job_lookup(
        job_id=job_id,
        request_id=request_id,
        external_reference_id=external_reference_id,
    )
    _queue_audit(background_tasks, identity, "admin.ledger.job_lookup.view", "ledger")
    return result


# ---------------------------------------------------------------------------
# Providers router — /admin/providers/*
# ---------------------------------------------------------------------------

providers_router = APIRouter(prefix="/admin/providers", tags=["admin"])

_KNOWN_PROVIDERS = {
    "document_ai": {
        "display_name": "Google Document AI",
        "provider_type": "metered_cloud",
        "is_metered": True,
        "cost_basis": "per document chunk ($0.10 / 10 pages)",
        "notes": "Receipt/Expense Parser; recommended for production accuracy.",
    },
    "google_vision": {
        "display_name": "Google Cloud Vision",
        "provider_type": "metered_cloud",
        "is_metered": True,
        "cost_basis": "per image ($0.0015)",
        "notes": "General text detection; fallback for document_ai.",
    },
    "tesseract": {
        "display_name": "Tesseract OCR",
        "provider_type": "local_compute_not_metered",
        "is_metered": False,
        "cost_basis": "local compute (free)",
        "notes": "Open-source; lower accuracy than cloud providers.",
    },
    "easyocr": {
        "display_name": "EasyOCR",
        "provider_type": "local_compute_not_metered",
        "is_metered": False,
        "cost_basis": "local compute (free)",
        "notes": "Deep-learning local OCR; requires scipy (may be unavailable in current build).",
    },
    "rapidocr": {
        "display_name": "RapidOCR (PP-OCR / onnxruntime)",
        "provider_type": "local_compute_not_metered",
        "is_metered": False,
        "cost_basis": "local compute (free)",
        "notes": "PaddleOCR PP-OCR models on onnxruntime; best local accuracy/speed balance on CPU.",
    },
}


def validate_provider_order(
    primary: Optional[str],
    fallback: Optional[str],
    ledger_unavailable_fallback: Optional[str],
) -> list:
    """
    Validate provider configuration. Returns a list of error strings (empty = valid).

    Rules:
    - primary is required and must be a known provider ID.
    - fallback, if set, must be a known provider ID.
    - ledger_unavailable_fallback, if set, must be a known non-metered provider.
    - No paid calls are made; this is a pure config validation function.
    """
    errors = []
    known = set(_KNOWN_PROVIDERS.keys())

    if not primary:
        errors.append("primary_provider is required and cannot be empty.")
    elif primary not in known:
        errors.append(f"primary_provider {primary!r} is not a known provider ID. Known: {sorted(known)}")

    if fallback and fallback not in known:
        errors.append(f"fallback_provider {fallback!r} is not a known provider ID. Known: {sorted(known)}")

    if ledger_unavailable_fallback:
        if ledger_unavailable_fallback not in known:
            errors.append(
                f"ledger_unavailable_fallback_provider {ledger_unavailable_fallback!r} "
                f"is not a known provider ID. Known: {sorted(known)}"
            )
        elif ledger_unavailable_fallback in METERED_CLOUD_PROVIDERS:
            errors.append(
                f"ledger_unavailable_fallback_provider {ledger_unavailable_fallback!r} "
                "is a metered cloud provider. It must be a local provider (rapidocr, tesseract, or easyocr) "
                "to avoid costs when the ledger is unavailable."
            )

    return errors


@providers_router.get("/config")
async def admin_providers_config(
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
):
    """
    Current provider configuration with metadata, validation errors, and warnings.

    Read-only. To change providers: update container .env and restart.
    Write endpoint (PUT /admin/providers/config) is not yet implemented;
    blocked until audit log (Feature 2) is complete.
    """
    _mark_internal(response)

    primary = settings.PRIMARY_OCR_PROVIDER
    fallback = settings.FALLBACK_OCR_PROVIDER
    ledger_fallback = settings.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER

    validation_errors = validate_provider_order(primary, fallback, ledger_fallback)

    warnings = []
    if primary in METERED_CLOUD_PROVIDERS and (fallback or "") in METERED_CLOUD_PROVIDERS:
        warnings.append(
            "Both primary and fallback providers are metered cloud. "
            "A cloud API outage will block all OCR unless LEDGER_UNAVAILABLE_FALLBACK_PROVIDER is set."
        )
    if ledger_fallback and ledger_fallback in METERED_CLOUD_PROVIDERS:
        warnings.append(
            f"LEDGER_UNAVAILABLE_FALLBACK_PROVIDER={ledger_fallback!r} is a metered cloud provider — "
            "this defeats the purpose. Set it to a local provider (rapidocr, tesseract, or easyocr)."
        )
    if not ledger_fallback and settings.REQUIRE_COST_LEDGER:
        warnings.append(
            "REQUIRE_COST_LEDGER=true but LEDGER_UNAVAILABLE_FALLBACK_PROVIDER is not set. "
            "A ledger DB outage will block all OCR requests."
        )

    result = {
        "primary_provider": primary,
        "fallback_provider": fallback,
        "ledger_unavailable_fallback_provider": ledger_fallback,
        "providers": _KNOWN_PROVIDERS,
        "validation_errors": validation_errors,
        "warnings": warnings,
        "notes": [
            "Provider changes require an environment variable update and container restart.",
            "Write endpoint (PUT /admin/providers/config) is not yet implemented.",
            "Blocked until audit log (Feature 2) is complete. See docs/OCR_PHASE2_ROADMAP.md.",
        ],
        "_internal_only": True,
    }
    _queue_audit(background_tasks, identity, "admin.providers.config.view", "provider_config")
    return result


# ---------------------------------------------------------------------------
# Audit router — /admin/audit/*
# ---------------------------------------------------------------------------

audit_router = APIRouter(prefix="/admin/audit", tags=["admin"])


@audit_router.get("/logs")
async def admin_audit_logs(
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    action: Optional[str] = Query(default=None, description="Filter by exact action name"),
    actor_username: Optional[str] = Query(default=None, description="Filter by actor username"),
):
    """
    Paginated admin audit log (newest first).

    Returns sanitized records only — no token values, no document content.
    Viewing the audit log is itself an audited action.
    """
    _mark_internal(response)
    result = await list_audit_logs(
        limit=limit,
        offset=offset,
        action_filter=action,
        actor_username_filter=actor_username,
    )
    _queue_audit(background_tasks, identity, "admin.audit.logs.view", "audit_logs")
    return result


# ---------------------------------------------------------------------------
# Settings router — /admin/settings/*
# ---------------------------------------------------------------------------

settings_router = APIRouter(prefix="/admin/settings", tags=["admin"])

_VALID_WORKER_MODES = {"stopped", "local_only", "paid_normal"}

# Fields that can be written via POST /admin/settings/apply (env-key → request field).
_ALLOWED_APPLY_FIELDS = frozenset({
    "primary_ocr_provider",
    "fallback_ocr_provider",
    "ledger_unavailable_fallback_provider",
})
_FIELD_TO_ENV_KEY = {
    "primary_ocr_provider": "PRIMARY_OCR_PROVIDER",
    "fallback_ocr_provider": "FALLBACK_OCR_PROVIDER",
    "ledger_unavailable_fallback_provider": "LEDGER_UNAVAILABLE_FALLBACK_PROVIDER",
}

_APPLY_NOTE_ASYNC = (
    "Async worker mode changes require manual container configuration "
    "(update ocr_worker environment vars in docker-compose.yml and restart the worker container). "
    "Apply is not supported for async worker mode via this endpoint."
)

_WORKER_INTROSPECTION_NOTE = (
    "Runtime introspection unavailable: API container does not have host Docker socket access. "
    "Worker mode shown here reflects API container config only. "
    "Check the ocr_worker container environment directly to confirm worker provider settings."
)


# ---------------------------------------------------------------------------
# Preview token — HMAC-signed, 15-min TTL
# ---------------------------------------------------------------------------

def _preview_token_key() -> bytes:
    """Derive a stable HMAC key from the configured admin token."""
    secret = settings.OCR_ADMIN_INTERNAL_TOKEN or "unconfigured-admin-token"
    return hashlib.sha256(f"ocr-preview-v1:{secret}".encode()).digest()


def _make_preview_token(changes: List[Dict]) -> Tuple[str, str]:
    """
    Sign a preview token encoding the proposed changes.

    Payload includes the full change list (field, current, proposed) so verify
    can check replay protection (current values still match) at apply time.

    Returns (token_string, expires_at_iso_string).
    """
    now = datetime.now(timezone.utc)
    ttl = getattr(settings, "PREVIEW_TOKEN_TTL_SECONDS", 900)
    expires = now + timedelta(seconds=ttl)
    payload: Dict[str, Any] = {
        "changes": changes,
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
    }
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    payload_b64 = base64.urlsafe_b64encode(payload_json.encode()).rstrip(b"=").decode()
    sig = _hmac.new(_preview_token_key(), payload_json.encode(), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}", expires.isoformat()


def _verify_preview_token(token: str, proposed_changes: List[Dict]) -> Tuple[bool, str]:
    """
    Verify a preview token against the changes in an apply request.

    Checks: HMAC valid, not expired, proposed values match, current env values
    still match what was captured at preview time (replay / stale-state protection).

    Returns (ok: bool, error_message: str).
    """
    if not token:
        return False, "preview_token is required"

    parts = token.split(".", 1)
    if len(parts) != 2:
        return False, "Invalid token format"
    payload_b64, claimed_sig = parts

    try:
        padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
        payload_json = base64.urlsafe_b64decode(padded).decode()
        payload = json.loads(payload_json)
    except Exception:
        return False, "Invalid token encoding"

    # HMAC constant-time compare
    expected_sig = _hmac.new(_preview_token_key(), payload_json.encode(), hashlib.sha256).hexdigest()
    if not _hmac.compare_digest(expected_sig, claimed_sig):
        return False, "Invalid token signature"

    # Expiry
    if int(datetime.now(timezone.utc).timestamp()) > payload.get("exp", 0):
        return False, "Preview token has expired; please re-run preview"

    # Build lookup maps
    token_changes_by_field: Dict[str, Dict] = {c["field"]: c for c in payload.get("changes", [])}
    apply_changes_by_field: Dict[str, str] = {c["field"]: c["proposed"] for c in proposed_changes}

    # Fields must match exactly
    if set(token_changes_by_field.keys()) != set(apply_changes_by_field.keys()):
        return False, "Apply request fields do not match preview token"

    current_map = {
        "primary_ocr_provider": settings.PRIMARY_OCR_PROVIDER,
        "fallback_ocr_provider": settings.FALLBACK_OCR_PROVIDER,
        "ledger_unavailable_fallback_provider": settings.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER,
    }
    for field, token_change in token_changes_by_field.items():
        # Proposed value must match
        if apply_changes_by_field.get(field) != token_change["proposed"]:
            return False, f"Proposed value for {field!r} does not match token"
        # Current value must still match (replay / stale-state protection)
        if current_map.get(field) != token_change["current"]:
            return False, (
                f"Current value of {field!r} has changed since preview was generated. "
                "Please re-run preview."
            )

    return True, ""


# ---------------------------------------------------------------------------
# .env atomic write helper
# ---------------------------------------------------------------------------

def _atomic_update_env(path: str, updates: Dict[str, str]) -> str:
    """
    Atomically update only the whitelisted env keys in the file at `path`.

    Algorithm:
    1. Create a dated backup of the file (chmod 600).
    2. Read current lines.
    3. Replace matching key lines; append any missing keys.
    4. Write to .tmp then os.replace() for atomicity.
    5. chmod 600 the updated file.

    Returns the backup file path.
    Raises OSError on any filesystem error.
    """
    if not os.path.exists(path):
        raise OSError(
            f"Config file not found at {path!r}. "
            "Ensure the .env file is bind-mounted as a writable volume into the container "
            "(./.env:/app/.env.writable:rw) and OCR_ENV_WRITABLE_PATH is correct."
        )

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_path = path + f".pre-provider-config-{ts}.bak"
    shutil.copy2(path, backup_path)
    try:
        os.chmod(backup_path, 0o600)
    except OSError:
        pass

    with open(path, "r") as f:
        lines = f.readlines()

    found_keys: set = set()
    new_lines = []
    for line in lines:
        stripped = line.rstrip("\n").strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            new_lines.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            new_lines.append(f"{key}={updates[key]}\n")
            found_keys.add(key)
        else:
            new_lines.append(line)

    for key, value in updates.items():
        if key not in found_keys:
            new_lines.append(f"{key}={value}\n")

    tmp_path = path + ".tmp"
    with open(tmp_path, "w") as f:
        f.writelines(new_lines)
    try:
        os.chmod(tmp_path, 0o600)
    except OSError:
        pass
    os.replace(tmp_path, path)

    return backup_path


def _read_env_file_provider_config(path: str) -> Dict[str, Optional[str]]:
    """
    Read only the three provider keys from the .env file at `path`.

    Returns a dict with None values for missing keys.
    Never reads secrets — only the three whitelisted provider keys are returned.
    Safe to call even if the file does not exist.
    """
    result: Dict[str, Optional[str]] = {
        "primary_ocr_provider": None,
        "fallback_ocr_provider": None,
        "ledger_unavailable_fallback_provider": None,
    }
    _env_key_map = {
        "PRIMARY_OCR_PROVIDER": "primary_ocr_provider",
        "FALLBACK_OCR_PROVIDER": "fallback_ocr_provider",
        "LEDGER_UNAVAILABLE_FALLBACK_PROVIDER": "ledger_unavailable_fallback_provider",
    }
    if not os.path.exists(path):
        return result
    try:
        with open(path, "r") as f:
            for line in f:
                stripped = line.rstrip("\n").strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue
                key, _, value = stripped.partition("=")
                key = key.strip()
                value = value.strip() or None
                if key in _env_key_map:
                    result[_env_key_map[key]] = value
    except OSError:
        pass
    return result


def _build_providers_with_roles(
    primary: Optional[str],
    fallback: Optional[str],
    ledger_fallback: Optional[str],
) -> Dict[str, Any]:
    """Return _KNOWN_PROVIDERS enriched with current_role and allowed_for_ledger_fallback."""
    result = {}
    for pid, meta in _KNOWN_PROVIDERS.items():
        roles = []
        if pid == primary:
            roles.append("primary")
        if pid == fallback:
            roles.append("fallback")
        if pid == ledger_fallback:
            roles.append("ledger_unavailable_fallback")
        result[pid] = {
            **meta,
            "current_role": roles if roles else None,
            "allowed_for_ledger_unavailable_fallback": not meta["is_metered"],
        }
    return result


class SettingsPreviewRequest(BaseModel):
    primary_ocr_provider: Optional[str] = None
    fallback_ocr_provider: Optional[str] = None
    ledger_unavailable_fallback_provider: Optional[str] = None
    async_worker_mode: Optional[str] = None  # stopped | local_only | paid_normal


@settings_router.get("")
async def admin_settings_get(
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
):
    """
    Full read-only settings snapshot for the OCR service API container.

    Returns safe, non-secret config fields only. Tokens, DB URLs, and credential
    file paths are never included. Use GET /health/ledger for DB deep-check.
    """
    _mark_internal(response)

    primary = settings.PRIMARY_OCR_PROVIDER
    fallback = settings.FALLBACK_OCR_PROVIDER
    ledger_fallback = settings.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER

    warnings = validate_provider_order(primary, fallback, ledger_fallback)
    providers_with_roles = _build_providers_with_roles(primary, fallback, ledger_fallback)

    # Runtime config (current in-memory values from container env)
    runtime_config = {
        "primary_ocr_provider": primary,
        "fallback_ocr_provider": fallback,
        "ledger_unavailable_fallback_provider": ledger_fallback,
    }
    # File config (values in .env.writable — may differ from runtime before restart)
    file_config = _read_env_file_provider_config(settings.OCR_ENV_WRITABLE_PATH)
    changed_fields = [
        {"field": k, "runtime_value": runtime_config[k], "file_value": file_config[k]}
        for k in runtime_config
        if file_config[k] is not None and file_config[k] != runtime_config[k]
    ]
    pending_restart = len(changed_fields) > 0

    result: Dict[str, Any] = {
        "service_version": settings.VERSION,
        "environment": settings.ENVIRONMENT,
        "require_cost_ledger": settings.REQUIRE_COST_LEDGER,
        "admin_auth_mode": settings.ADMIN_AUTH_MODE,
        "sso_enabled": settings.ADMIN_AUTH_MODE in ("trusted_headers", "both"),
        "sso_url": settings.OCR_ADMIN_SSO_URL or None,
        "llm_inference_enabled": settings.ENABLE_LLM_INFERENCE,
        "primary_ocr_provider": primary,
        "fallback_ocr_provider": fallback,
        "ledger_unavailable_fallback_provider": ledger_fallback,
        "async_worker": {
            "api_container_enabled": settings.ASYNC_WORKER_ENABLED,
            "worker_container_state": "unknown",
            "worker_container_note": _WORKER_INTROSPECTION_NOTE,
            "worker_mode": "unknown",
        },
        "providers": providers_with_roles,
        "runtime_config": runtime_config,
        "file_config": file_config,
        "pending_restart": pending_restart,
        "changed_fields": changed_fields,
        "restart_command": "docker compose up -d --force-recreate ocr_service" if pending_restart else None,
        "warnings": warnings,
        "_internal_only": True,
    }

    _queue_audit(background_tasks, identity, "admin.settings.view", "settings")
    return result


@settings_router.post("/preview")
async def admin_settings_preview(
    body: SettingsPreviewRequest,
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
):
    """
    Validate a proposed provider/settings change without applying it.

    Returns validation errors, warnings, what would change, and whether a container
    restart would be required. apply_supported is always false in this version.
    No config files are written and no live behavior is changed.
    """
    _mark_internal(response)

    errors: List[str] = []
    warnings: List[str] = []
    would_change = []

    proposed_primary = body.primary_ocr_provider
    proposed_fallback = body.fallback_ocr_provider
    proposed_ledger_fallback = body.ledger_unavailable_fallback_provider
    proposed_worker_mode = body.async_worker_mode

    known = set(_KNOWN_PROVIDERS.keys())

    # --- Provider validation ---
    effective_primary = proposed_primary or settings.PRIMARY_OCR_PROVIDER
    effective_fallback = proposed_fallback if body.fallback_ocr_provider is not None else settings.FALLBACK_OCR_PROVIDER
    effective_ledger_fallback = (
        proposed_ledger_fallback
        if body.ledger_unavailable_fallback_provider is not None
        else settings.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER
    )

    validation_errors = validate_provider_order(
        effective_primary, effective_fallback, effective_ledger_fallback
    )
    errors.extend(validation_errors)

    # --- Worker mode validation ---
    if proposed_worker_mode is not None:
        if proposed_worker_mode not in _VALID_WORKER_MODES:
            errors.append(
                f"async_worker_mode {proposed_worker_mode!r} is not valid. "
                f"Allowed values: {sorted(_VALID_WORKER_MODES)}"
            )
        elif proposed_worker_mode == "paid_normal":
            warnings.append(
                "async_worker_mode=paid_normal will enable metered cloud providers for async jobs. "
                "Ensure REQUIRE_COST_LEDGER=true and the worker container has GCP credentials mounted."
            )

    # --- Cross-field warnings ---
    if effective_primary in METERED_CLOUD_PROVIDERS and (effective_fallback or "") in METERED_CLOUD_PROVIDERS:
        if "Both primary and fallback providers are metered cloud" not in " ".join(warnings):
            warnings.append(
                "Both primary and fallback providers are metered cloud. "
                "A cloud API outage will block all OCR unless LEDGER_UNAVAILABLE_FALLBACK_PROVIDER is set."
            )

    # --- would_change computation ---
    provider_fields = [
        ("primary_ocr_provider", proposed_primary, settings.PRIMARY_OCR_PROVIDER),
        ("fallback_ocr_provider", proposed_fallback, settings.FALLBACK_OCR_PROVIDER),
        (
            "ledger_unavailable_fallback_provider",
            proposed_ledger_fallback,
            settings.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER,
        ),
    ]
    for field_name, proposed, current in provider_fields:
        if proposed is not None and proposed != current:
            would_change.append({"field": field_name, "current": current, "proposed": proposed})

    if proposed_worker_mode is not None:
        would_change.append({
            "field": "async_worker_mode",
            "current": "unknown (requires worker container inspection)",
            "proposed": proposed_worker_mode,
            "note": (
                "Requires worker container restart with updated "
                "ASYNC_WORKER_ENABLED / PRIMARY_OCR_PROVIDER / FALLBACK_OCR_PROVIDER env vars."
            ),
        })

    # --- Token issuance for provider-only changes ---
    provider_changes = [c for c in would_change if c["field"] in _ALLOWED_APPLY_FIELDS]
    non_provider_changes = [c for c in would_change if c["field"] not in _ALLOWED_APPLY_FIELDS]

    issue_token = (
        len(errors) == 0
        and len(provider_changes) > 0
        and len(non_provider_changes) == 0
    )

    result: Dict[str, Any] = {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "would_change": would_change,
        "requires_restart": len(would_change) > 0,
        "apply_supported": issue_token,
        "preview_token": None,
        "expires_at": None,
        "apply_note": None,
    }

    if issue_token:
        token, expires_at = _make_preview_token(provider_changes)
        result["preview_token"] = token
        result["expires_at"] = expires_at
    elif non_provider_changes:
        result["apply_note"] = _APPLY_NOTE_ASYNC
    elif not would_change:
        result["apply_note"] = (
            "No provider changes detected — nothing to apply. "
            "Update at least one of: primary_ocr_provider, fallback_ocr_provider, "
            "ledger_unavailable_fallback_provider."
        )
    elif errors:
        result["apply_note"] = "Fix validation errors before apply is available."

    _queue_audit(
        background_tasks,
        identity,
        "admin.settings.preview",
        "settings",
        success=len(errors) == 0,
        error_summary=("; ".join(errors[:2]) if errors else None),
    )
    return result


class ApplyRequest(BaseModel):
    primary_ocr_provider: Optional[str] = None
    fallback_ocr_provider: Optional[str] = None
    ledger_unavailable_fallback_provider: Optional[str] = None
    preview_token: str


@settings_router.post("/apply")
async def admin_settings_apply(
    body: ApplyRequest,
    response: Response,
    background_tasks: BackgroundTasks,
    identity: AdminIdentity = Depends(require_admin_token),
):
    """
    Apply a validated provider config change to the .env file.

    Requires a valid preview_token from POST /admin/settings/preview.
    Writes only PRIMARY_OCR_PROVIDER, FALLBACK_OCR_PROVIDER, and
    LEDGER_UNAVAILABLE_FALLBACK_PROVIDER. All other keys are preserved.

    Creates a dated .env backup before writing. Does NOT restart the service.
    The running service continues using its current env until manually restarted.
    """
    from fastapi import HTTPException

    _mark_internal(response)

    # Build the proposed would_change list from the request
    provider_proposals = [
        ("primary_ocr_provider", body.primary_ocr_provider, settings.PRIMARY_OCR_PROVIDER),
        ("fallback_ocr_provider", body.fallback_ocr_provider, settings.FALLBACK_OCR_PROVIDER),
        (
            "ledger_unavailable_fallback_provider",
            body.ledger_unavailable_fallback_provider,
            settings.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER,
        ),
    ]
    would_change = [
        {"field": f, "current": current, "proposed": proposed}
        for f, proposed, current in provider_proposals
        if proposed is not None and proposed != current
    ]

    if not would_change:
        raise HTTPException(status_code=400, detail="No provider changes to apply.")

    # Verify preview token
    token_ok, token_err = _verify_preview_token(body.preview_token, would_change)
    if not token_ok:
        await write_audit_log(
            action="admin.settings.apply.rejected",
            actor_type=identity.actor_type,
            actor_id=identity.actor_id,
            actor_username=identity.username,
            resource_type="settings",
            source_ip=identity.source_ip,
            user_agent=identity.user_agent,
            success=False,
            error_summary=f"Token rejected: {token_err}",
        )
        raise HTTPException(status_code=400, detail=f"Preview token invalid: {token_err}")

    # Re-validate the proposed config (defence in depth)
    effective_primary = body.primary_ocr_provider or settings.PRIMARY_OCR_PROVIDER
    effective_fallback = (
        body.fallback_ocr_provider
        if body.fallback_ocr_provider is not None
        else settings.FALLBACK_OCR_PROVIDER
    )
    effective_ledger_fallback = (
        body.ledger_unavailable_fallback_provider
        if body.ledger_unavailable_fallback_provider is not None
        else settings.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER
    )
    validation_errors = validate_provider_order(
        effective_primary, effective_fallback, effective_ledger_fallback
    )
    if validation_errors:
        await write_audit_log(
            action="admin.settings.apply.rejected",
            actor_type=identity.actor_type,
            actor_id=identity.actor_id,
            actor_username=identity.username,
            resource_type="settings",
            source_ip=identity.source_ip,
            user_agent=identity.user_agent,
            success=False,
            error_summary="; ".join(validation_errors[:2]),
        )
        raise HTTPException(status_code=400, detail={"errors": validation_errors})

    # Build the env key → value update map
    env_updates = {
        _FIELD_TO_ENV_KEY[c["field"]]: c["proposed"]
        for c in would_change
    }

    # Write atomically to the writable .env bind-mount
    env_path = settings.OCR_ENV_WRITABLE_PATH
    try:
        backup_path = _atomic_update_env(env_path, env_updates)
    except OSError as exc:
        logger.warning(f"admin_settings_apply: env write failed: {exc}")
        await write_audit_log(
            action="admin.settings.apply.rejected",
            actor_type=identity.actor_type,
            actor_id=identity.actor_id,
            actor_username=identity.username,
            resource_type="settings",
            source_ip=identity.source_ip,
            user_agent=identity.user_agent,
            success=False,
            error_summary=f"File write failed: {type(exc).__name__}",
        )
        raise HTTPException(
            status_code=500,
            detail=(
                "Config file write failed. "
                "Ensure the .env file is bind-mounted as writable "
                "(./.env:/app/.env.writable:rw) and OCR_ENV_WRITABLE_PATH is correct. "
                f"Detail: {exc}"
            ),
        )

    _queue_audit(background_tasks, identity, "admin.settings.apply", "settings", success=True)

    return {
        "applied": True,
        "restart_required": True,
        "changed_fields": would_change,
        "backup_filename": os.path.basename(backup_path),
        "message": (
            "Provider config written to .env. "
            "The running ocr_service container still uses the previous configuration. "
            "Restart the container to apply changes."
        ),
        "restart_command": "docker compose up -d --force-recreate ocr_service",
    }
