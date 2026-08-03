"""
Admin audit log — write and read helpers.

Design:
  - write_audit_log() is intentionally fire-and-forget / best-effort.
    Callers invoke it via BackgroundTasks; a write failure never breaks the admin response.
  - list_audit_logs() is read-only, newest-first, paginated.
  - No secrets, tokens, or document content are ever written to this table.
  - The table is append-only; no UPDATE or DELETE operations exist here.

Actor fields for current (token) auth:
  actor_type     = "internal_token"
  actor_id       = "internal-token-admin"
  actor_username = "internal-token-admin"
  actor_source   = "x-internal-token"

Actor fields for future SSO auth (Authentik trusted headers):
  actor_type     = "sso"
  actor_id       = <X-authentik-uid>
  actor_username = <X-authentik-username>
  actor_source   = "authentik-forward-auth"
"""

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.db.session import async_session
from app.utils.logger import setup_logger

logger = setup_logger(__name__)

_AUDIT_LOGS_MAX_LIMIT = 200


def _actor_source_for(actor_type: str) -> str:
    return {
        "internal_token": "x-internal-token",
        "sso": "authentik-forward-auth",
        "test": "test",
    }.get(actor_type, actor_type)


async def write_audit_log(
    *,
    action: str,
    actor_type: str,
    actor_id: Optional[str],
    actor_username: Optional[str],
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    source_ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    before_value: Optional[Any] = None,
    after_value: Optional[Any] = None,
    metadata: Optional[Dict[str, Any]] = None,
    success: bool = True,
    error_summary: Optional[str] = None,
) -> None:
    """
    Best-effort audit log write. Exceptions are logged as warnings and swallowed.

    Called via BackgroundTasks — the HTTP response has already been sent when this runs.
    Never write token values, credentials, or document contents here.
    """
    try:
        from app.db.models import AdminAuditLog

        now = datetime.now(timezone.utc)

        # Truncate user_agent to avoid runaway values
        ua = (user_agent or "")[:512] or None

        # Serialize before/after safely
        def _to_json(v: Any) -> Optional[str]:
            if v is None:
                return None
            try:
                return json.dumps(v, default=str)
            except Exception:
                return str(v)[:1000]

        row = AdminAuditLog(
            created_at=now,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            actor_type=actor_type,
            actor_id=actor_id,
            actor_username=actor_username,
            actor_source=_actor_source_for(actor_type),
            ip_address=source_ip,
            user_agent=ua,
            before_json=_to_json(before_value),
            after_json=_to_json(after_value),
            metadata_json=_to_json(metadata),
            success=success,
            error_summary=(error_summary or "")[:500] or None,
        )

        async with async_session() as session:
            if session is None:
                return  # DB unavailable — skip silently
            session.add(row)

    except Exception as exc:
        logger.warning(f"Audit log write failed (non-fatal): {exc}")


def _audit_row_to_dict(row) -> Dict[str, Any]:
    return {
        "id": str(row.id),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "action": row.action,
        "resource_type": row.resource_type,
        "resource_id": row.resource_id,
        "actor_type": row.actor_type,
        "actor_username": row.actor_username,
        "actor_source": row.actor_source,
        "source_ip": row.ip_address,
        "success": row.success,
        "error_summary": (row.error_summary or "")[:200] or None,
    }


async def list_audit_logs(
    limit: int = 50,
    offset: int = 0,
    action_filter: Optional[str] = None,
    actor_username_filter: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Paginated audit log (newest first). Read-only, sanitized output only.
    Returns {"available": False} when DB is unreachable.
    """
    limit = min(max(1, limit), _AUDIT_LOGS_MAX_LIMIT)
    try:
        from app.db.models import AdminAuditLog
        from sqlalchemy import select, func

        async with async_session() as session:
            if session is None:
                return {"available": False, "total": 0, "items": []}

            base_q = select(AdminAuditLog)
            if action_filter:
                base_q = base_q.where(AdminAuditLog.action == action_filter)
            if actor_username_filter:
                base_q = base_q.where(AdminAuditLog.actor_username == actor_username_filter)

            total = (
                await session.execute(select(func.count()).select_from(base_q.subquery()))
            ).scalar_one_or_none() or 0

            rows = (
                await session.execute(
                    base_q.order_by(AdminAuditLog.created_at.desc()).limit(limit).offset(offset)
                )
            ).scalars().all()

            return {
                "available": True,
                "total": int(total),
                "limit": limit,
                "offset": offset,
                "items": [_audit_row_to_dict(r) for r in rows],
            }
    except Exception as exc:
        logger.warning(f"Audit list_audit_logs failed: {exc}")
        return {"available": False, "total": 0, "items": []}
