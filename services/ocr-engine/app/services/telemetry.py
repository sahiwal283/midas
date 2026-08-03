"""
Optional business telemetry: send API usage events to IngestionAPI for cost tracking.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

import httpx

from app.config import settings
from app.utils.logger import setup_logger

logger = setup_logger(__name__)


async def _send_api_event_payload(
    provider: str,
    usage_units: int,
    usage_unit_type: str = "tokens",
    latency_ms: Optional[float] = None,
    extra: Optional[Dict[str, Any]] = None,
    estimated_cost_usd: Optional[float] = None,
    gcp_product: Optional[str] = None,
    request_id: Optional[str] = None,
) -> None:
    """POST one api-event to TELEMETRY_INGESTION_URL. Called in a background task."""
    url = getattr(settings, "TELEMETRY_INGESTION_URL", None) or ""
    if not url:
        return
    api_key = getattr(settings, "TELEMETRY_API_KEY", "") or "changeme_api_key_here"
    payload: Dict[str, Any] = {
        "provider": (provider or "unknown").lower(),
        "usage_units": usage_units,
        "usage_unit_type": usage_unit_type,
    }
    if latency_ms is not None:
        payload["latency_ms"] = round(latency_ms, 2)
    if estimated_cost_usd is not None:
        payload["estimated_cost_usd"] = round(float(estimated_cost_usd), 6)
    if gcp_product:
        payload["gcp_product"] = gcp_product
    if request_id:
        payload["request_id"] = request_id
    if extra:
        payload.update(extra)
    headers = {"Content-Type": "application/json", "X-Api-Key": api_key}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                logger.warning(
                    "Telemetry ingestion returned %s: %s",
                    resp.status_code,
                    resp.text[:200],
                )
    except Exception as e:
        logger.debug("Telemetry send failed (non-fatal): %s", e)


def send_api_event(
    provider: str,
    usage_units: int,
    usage_unit_type: str = "tokens",
    latency_ms: Optional[float] = None,
    extra: Optional[Dict[str, Any]] = None,
    estimated_cost_usd: Optional[float] = None,
    gcp_product: Optional[str] = None,
    request_id: Optional[str] = None,
) -> None:
    """
    Fire-and-forget: enqueue sending an API usage event to the ingestion service.
    Does not block the current request.
    """
    url = getattr(settings, "TELEMETRY_INGESTION_URL", None) or ""
    if not url:
        return
    asyncio.create_task(
        _send_api_event_payload(
            provider=provider,
            usage_units=usage_units,
            usage_unit_type=usage_unit_type,
            latency_ms=latency_ms,
            extra=extra,
            estimated_cost_usd=estimated_cost_usd,
            gcp_product=gcp_product,
            request_id=request_id,
        )
    )
