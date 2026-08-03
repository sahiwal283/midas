"""
Prometheus metrics for OCR service monitoring.

Aligned with zoho-integration-service and shipping-app patterns:
- Class-based middleware, endpoint classification from request/route, metrics_response().
"""

from __future__ import annotations

import re
from typing import Optional

from fastapi import Request
from fastapi.responses import Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

from app.config import settings

HTTP_REQUESTS_TOTAL = Counter(
    "http_requests_total",
    "Total HTTP requests handled by the service.",
    ["service", "environment", "instance", "method", "status", "endpoint_class"],
)

HTTP_REQUEST_DURATION_SECONDS = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds.",
    ["service", "environment", "instance", "method", "status", "endpoint_class"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

APP_BUILD_INFO = Gauge(
    "app_build_info",
    "Application build information.",
    ["version", "service", "environment", "instance"],
)

EXTERNAL_API_CALLS_TOTAL = Counter(
    "external_api_calls_total",
    "Total external API calls made by provider.",
    ["service", "environment", "instance", "provider", "status"],
)

EXTERNAL_API_DURATION_SECONDS = Histogram(
    "external_api_duration_seconds",
    "Latency for external API calls by provider.",
    ["service", "environment", "instance", "provider", "status"],
    buckets=(0.1, 0.5, 1.0, 2.5, 5.0, 10.0),
)

_NUMERIC_SEGMENT_RE = re.compile(r"/\d+(?=/|$)")
_UUID_SEGMENT_RE = re.compile(
    r"/[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}(?=/|$)"
)
_HEX_SEGMENT_RE = re.compile(r"/[0-9a-fA-F]{16,}(?=/|$)")


def init_build_info_metric() -> None:
    """Set build info metric to 1 at startup."""
    APP_BUILD_INFO.labels(
        version=settings.APP_VERSION,
        service=settings.SERVICE_NAME,
        environment=settings.ENVIRONMENT,
        instance=settings.INSTANCE,
    ).set(1)


def normalize_path(path: str) -> str:
    """Normalize dynamic path segments to avoid unbounded metric labels."""
    if not path:
        return "/"

    normalized = _NUMERIC_SEGMENT_RE.sub("/{id}", path)
    normalized = _UUID_SEGMENT_RE.sub("/{id}", normalized)
    normalized = _HEX_SEGMENT_RE.sub("/{id}", normalized)
    return normalized


def classify_endpoint(path: str) -> str:
    """Map path to a bounded endpoint class label."""
    normalized_path = normalize_path(path)

    if normalized_path.startswith("/auth"):
        return "auth"
    if normalized_path.startswith("/billing"):
        return "billing"
    if "/upload" in normalized_path or normalized_path.startswith("/ocr") or "/ocr" in normalized_path:
        return "upload"
    return "api"


def classify_endpoint_from_request(request: Request) -> str:
    """
    Classify endpoint from matched route when available (like zoho-integration-service).
    Falls back to path-based classification otherwise.
    """
    route = request.scope.get("route")
    route_path = getattr(route, "path", None) if route else None
    raw_path = route_path or request.url.path
    normalized_path = re.sub(r"/{2,}", "/", raw_path).strip("/")

    if not normalized_path:
        return "root"

    first_segment = normalized_path.split("/", 1)[0]
    if first_segment in {"health", "live", "ready", "status"}:
        return "health"
    if first_segment == "ocr" or "ocr" in normalized_path:
        return "upload"
    if first_segment == "webhooks":
        return "webhooks"
    if first_segment == "metrics":
        return "metrics"
    if first_segment in {"auth"}:
        return "auth"
    if first_segment in {"billing"}:
        return "billing"
    return first_segment if first_segment else "api"


def record_http_request(
    method: str,
    path: str,
    status_code: int,
    duration_seconds: float,
    endpoint_class: Optional[str] = None,
) -> None:
    """Record HTTP request count and duration metrics."""
    if endpoint_class is None:
        endpoint_class = classify_endpoint(path)
    status = str(status_code)

    labels = {
        "service": settings.SERVICE_NAME,
        "environment": settings.ENVIRONMENT,
        "instance": settings.INSTANCE,
        "method": method,
        "status": status,
        "endpoint_class": endpoint_class,
    }

    HTTP_REQUESTS_TOTAL.labels(**labels).inc()
    HTTP_REQUEST_DURATION_SECONDS.labels(**labels).observe(duration_seconds)


def record_external_api_call(provider: str, status: str, duration_seconds: float) -> None:
    """Record external API metrics using a bounded provider label."""
    normalized_provider = (provider or "unknown").lower()
    normalized_status = (status or "unknown").lower()

    labels = {
        "service": settings.SERVICE_NAME,
        "environment": settings.ENVIRONMENT,
        "instance": settings.INSTANCE,
        "provider": normalized_provider,
        "status": normalized_status,
    }
    EXTERNAL_API_CALLS_TOTAL.labels(**labels).inc()
    EXTERNAL_API_DURATION_SECONDS.labels(**labels).observe(duration_seconds)


def render_metrics() -> bytes:
    """Render Prometheus metrics payload."""
    return generate_latest()


def metrics_content_type() -> str:
    """Prometheus response content type."""
    return CONTENT_TYPE_LATEST


def metrics_response() -> Response:
    """Return Prometheus metrics in text exposition format (same pattern as zoho-integration-service)."""
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)

