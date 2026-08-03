"""
Admin authentication and identity for OCR Service.

Auth modes (ADMIN_AUTH_MODE):
  "internal_token"  — X-Internal-Token shared secret only (default)
  "trusted_headers" — Authentik proxy headers from ADMIN_TRUSTED_PROXY_IPS only
  "both"            — either path accepted; use during NPM Plus rollout

Authentik headers (injected by NPM Plus forward-auth):
  X-authentik-username  — Authentik username
  X-authentik-email     — user email
  X-authentik-groups    — pipe-separated group list (e.g. "ocr-admins|users")

Only headers arriving from a trusted proxy IP (ADMIN_TRUSTED_PROXY_IPS) are
accepted as Authentik identity.  The admin token remains available as break-glass
when ADMIN_AUTH_MODE is "both".

Usage (FastAPI route handler):
    async def my_handler(identity: AdminIdentity = Depends(require_admin_token)):
        ...  # identity.username for logs, identity.groups for permission checks
"""

from dataclasses import dataclass, field
from typing import List, Optional

from fastapi import Header, HTTPException, Request, status

from app.config import settings


@dataclass
class AdminIdentity:
    """
    Caller identity for an authenticated admin request.

    actor_type     = "internal_token" | "authentik_proxy" | "test"
    actor_id       = stable opaque ID (token fingerprint or Authentik username)
    username       = human-readable label
    groups         = [] for token auth; populated from X-authentik-groups for proxy auth
    auth_method    = mirrors actor_type for downstream consumers
    auth_source    = "admin_token" | "authentik_proxy" | "unknown"
    source_ip      = request IP (for audit log; may be proxy IP)
    user_agent     = truncated User-Agent header
    """

    actor_type: str
    actor_id: str
    username: str
    groups: List[str] = field(default_factory=list)
    auth_method: str = "internal_token"
    auth_source: str = "admin_token"
    source_ip: Optional[str] = None
    user_agent: Optional[str] = None

    @classmethod
    def from_internal_token(
        cls,
        source_ip: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> "AdminIdentity":
        return cls(
            actor_type="internal_token",
            actor_id="internal-token-admin",
            username="internal-token-admin",
            groups=[],
            auth_method="internal_token",
            auth_source="admin_token",
            source_ip=source_ip,
            user_agent=(user_agent or "")[:512] or None,
        )

    @classmethod
    def from_authentik_proxy(
        cls,
        username: str,
        groups: List[str],
        source_ip: Optional[str] = None,
        user_agent: Optional[str] = None,
    ) -> "AdminIdentity":
        return cls(
            actor_type="authentik_proxy",
            actor_id=username,
            username=username,
            groups=groups,
            auth_method="authentik_proxy",
            auth_source="authentik_proxy",
            source_ip=source_ip,
            user_agent=(user_agent or "")[:512] or None,
        )

    @classmethod
    def test_identity(cls) -> "AdminIdentity":
        """Convenience constructor for test fixtures."""
        return cls(
            actor_type="test",
            actor_id="test-bypass",
            username="test-bypass",
            groups=[],
            auth_method="test",
            auth_source="unknown",
        )


def _parse_trusted_ips() -> List[str]:
    return [ip.strip() for ip in settings.ADMIN_TRUSTED_PROXY_IPS.split(",") if ip.strip()]


def _parse_authentik_groups(raw: Optional[str]) -> List[str]:
    """Parse pipe-separated Authentik groups header into a list."""
    if not raw:
        return []
    return [g.strip() for g in raw.split("|") if g.strip()]


async def require_admin_token(
    request: Request,
    x_internal_token: Optional[str] = Header(None, alias="X-Internal-Token"),
) -> AdminIdentity:
    """
    FastAPI dependency — enforces admin auth and returns AdminIdentity.

    Behavior depends on ADMIN_AUTH_MODE:
      "internal_token"  — requires valid X-Internal-Token
      "trusted_headers" — requires Authentik headers from a trusted proxy IP
      "both"            — accepts either; token path preferred if header present

    Raises 503 when OCR_ADMIN_INTERNAL_TOKEN is not configured (token modes).
    Raises 401 when auth fails.
    Returns AdminIdentity on success — never returns None.
    The token value is never logged or included in any response.
    """
    auth_mode = settings.ADMIN_AUTH_MODE
    source_ip = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")

    if auth_mode == "trusted_headers":
        return _require_authentik_headers(request, source_ip, user_agent)

    if auth_mode == "both":
        # Try token first (break-glass), then fall through to proxy headers.
        configured_token = settings.OCR_ADMIN_INTERNAL_TOKEN
        if x_internal_token and configured_token and x_internal_token == configured_token:
            return AdminIdentity.from_internal_token(source_ip=source_ip, user_agent=user_agent)
        return _require_authentik_headers(request, source_ip, user_agent)

    # Default: "internal_token"
    return _require_internal_token(x_internal_token, source_ip, user_agent)


def _require_internal_token(
    x_internal_token: Optional[str],
    source_ip: Optional[str],
    user_agent: Optional[str],
) -> AdminIdentity:
    configured_token = settings.OCR_ADMIN_INTERNAL_TOKEN

    if not configured_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Admin auth is not configured. "
                "Set OCR_ADMIN_INTERNAL_TOKEN environment variable to enable /admin endpoints."
            ),
        )

    if x_internal_token != configured_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Token.",
            headers={"WWW-Authenticate": "Token"},
        )

    return AdminIdentity.from_internal_token(source_ip=source_ip, user_agent=user_agent)


def _require_authentik_headers(
    request: Request,
    source_ip: Optional[str],
    user_agent: Optional[str],
) -> AdminIdentity:
    """
    Accept Authentik proxy identity only when the request arrives from a trusted IP.
    Returns AdminIdentity or raises 401.
    """
    trusted_ips = _parse_trusted_ips()

    if source_ip not in trusted_ips:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Request not from a trusted proxy.",
            headers={"WWW-Authenticate": "Token"},
        )

    username = request.headers.get("X-authentik-username", "").strip()
    if not username:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authentik identity headers.",
            headers={"WWW-Authenticate": "Token"},
        )

    groups = _parse_authentik_groups(request.headers.get("X-authentik-groups"))
    required_group = settings.OCR_AUTH_PROXY_REQUIRED_GROUP

    if required_group and required_group not in groups:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Insufficient group membership.",
            headers={"WWW-Authenticate": "Token"},
        )

    return AdminIdentity.from_authentik_proxy(
        username=username,
        groups=groups,
        source_ip=source_ip,
        user_agent=user_agent,
    )
