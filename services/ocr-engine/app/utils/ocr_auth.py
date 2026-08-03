"""
Service-to-service authentication for OCR processing endpoints.

Separate from admin auth (OCR_ADMIN_INTERNAL_TOKEN).
Callers (e.g. Midas) must present X-Internal-Token: <OCR_SERVICE_INTERNAL_TOKEN>.

Controlled by:
    OCR_SERVICE_INTERNAL_TOKEN  — the shared secret for service-to-service calls
    OCR_REQUIRE_SERVICE_TOKEN   — enforcement flag (default false for backward compat)
                                  Set to true in production before any external caller connects.

Response behaviour:
    OCR_REQUIRE_SERVICE_TOKEN=false          → pass through (no check; backward compat)
    token not configured, enforcement=true   → 503
    header missing, enforcement=true         → 401
    wrong token, enforcement=true            → 403
    correct token                            → ServiceIdentity returned
"""

from dataclasses import dataclass
from typing import Optional

from fastapi import Header, HTTPException, Request, status

from app.config import settings


@dataclass
class ServiceIdentity:
    """Caller identity for an authenticated service-to-service OCR request."""

    actor_type: str = "service_token"
    actor_id: str = "service-token-caller"
    username: str = "service-token-caller"
    source_ip: Optional[str] = None
    user_agent: Optional[str] = None

    @classmethod
    def from_token(
        cls,
        source_ip: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> "ServiceIdentity":
        return cls(
            source_ip=source_ip,
            user_agent=(user_agent or "")[:512] or None,
        )

    @classmethod
    def test_identity(cls) -> "ServiceIdentity":
        return cls(actor_type="test", actor_id="test-bypass", username="test-bypass")


async def require_service_token(
    request: Request,
    x_internal_token: Optional[str] = Header(None, alias="X-Internal-Token"),
) -> Optional["ServiceIdentity"]:
    """
    FastAPI dependency — enforces X-Internal-Token for OCR processing endpoints.

    When OCR_REQUIRE_SERVICE_TOKEN=false (default), passes through without checking.
    When true:
      - 503 if OCR_SERVICE_INTERNAL_TOKEN is not configured
      - 401 if header is missing
      - 403 if header value is wrong
      - Returns ServiceIdentity on success

    The token value is never logged or included in any response.
    """
    if not settings.OCR_REQUIRE_SERVICE_TOKEN:
        return None  # enforcement disabled — backward compat pass-through

    configured = settings.OCR_SERVICE_INTERNAL_TOKEN
    if not configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Service auth is not configured. "
                "Set OCR_SERVICE_INTERNAL_TOKEN and OCR_REQUIRE_SERVICE_TOKEN=true "
                "to enable service-to-service auth on OCR endpoints."
            ),
        )

    if x_internal_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-Internal-Token. OCR endpoints require service-to-service authentication.",
            headers={"WWW-Authenticate": "Token"},
        )

    if x_internal_token != configured:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid X-Internal-Token. Access denied.",
        )

    source_ip = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")
    return ServiceIdentity.from_token(source_ip=source_ip, user_agent=user_agent)
