"""
SQLAlchemy ORM models for the Phase 1 cost ledger.

Two tables:
  ocr_jobs       — one row per inbound OCR request
  provider_calls — one row per provider execution attempt within a job
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class OcrJob(Base):
    __tablename__ = "ocr_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # received → processing → completed | failed
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="received")
    client_app: Mapped[Optional[str]] = mapped_column(String(128))
    brand: Mapped[Optional[str]] = mapped_column(String(128))
    workflow: Mapped[Optional[str]] = mapped_column(String(128))
    external_reference_type: Mapped[Optional[str]] = mapped_column(String(64))
    external_reference_id: Mapped[Optional[str]] = mapped_column(String(256))
    caller_env: Mapped[Optional[str]] = mapped_column(String(64))
    caller_version: Mapped[Optional[str]] = mapped_column(String(64))
    user_id: Mapped[Optional[str]] = mapped_column(String(256))
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(512))
    file_name: Mapped[Optional[str]] = mapped_column(String(512))
    file_content_type: Mapped[Optional[str]] = mapped_column(String(128))
    input_file_size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger)
    ocr_provider_used: Mapped[Optional[str]] = mapped_column(String(64))
    total_estimated_cost_usd: Mapped[Optional[float]] = mapped_column(Numeric(12, 8))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        Index("ix_ocr_jobs_request_id", "request_id"),
        Index("ix_ocr_jobs_idempotency_key", "idempotency_key"),
    )


class ProviderCall(Base):
    __tablename__ = "provider_calls"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ocr_jobs.id"), nullable=False
    )
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    provider_name: Mapped[str] = mapped_column(String(64), nullable=False)
    # metered_cloud | local_compute_not_metered
    provider_type: Mapped[str] = mapped_column(String(32), nullable=False)
    # ocr | llm_enhancement
    call_purpose: Mapped[str] = mapped_column(String(64), nullable=False)
    # started | success | error | timeout | blocked | skipped
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="started")
    usage_units: Mapped[Optional[int]] = mapped_column(BigInteger)
    usage_unit_type: Mapped[Optional[str]] = mapped_column(String(32))
    estimated_cost_usd: Mapped[Optional[float]] = mapped_column(Numeric(12, 8))
    unit_price_usd: Mapped[Optional[float]] = mapped_column(Numeric(12, 8))
    pricing_unit: Mapped[Optional[str]] = mapped_column(String(32))
    # "configured_default" or "env_override"
    pricing_source: Mapped[Optional[str]] = mapped_column(String(64))
    pricing_effective_date: Mapped[Optional[str]] = mapped_column(String(16))
    # "metered_cloud_estimate" or "local_compute_not_metered"
    cost_basis: Mapped[Optional[str]] = mapped_column(String(64))
    # JSON blob: rate_reference_url, is_estimate, rate_env_var (when env_override), rate_note
    raw_metadata_json: Mapped[Optional[str]] = mapped_column(Text)
    error_message: Mapped[Optional[str]] = mapped_column(Text)
    duration_ms: Mapped[Optional[float]] = mapped_column(Numeric(12, 3))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_provider_calls_job_id", "job_id"),
        Index("ix_provider_calls_request_id", "request_id"),
    )


class AdminAuditLog(Base):
    """Append-only audit trail for admin actions. Never UPDATE or DELETE rows."""

    __tablename__ = "admin_audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )
    action: Mapped[str] = mapped_column(String(128), nullable=False)
    resource_type: Mapped[Optional[str]] = mapped_column(String(64))
    resource_id: Mapped[Optional[str]] = mapped_column(String(256))
    # "internal_token" | "sso" (future) | "test"
    actor_type: Mapped[str] = mapped_column(String(32), nullable=False)
    # Opaque stable ID: "internal-token-admin" or Authentik UID
    actor_id: Mapped[Optional[str]] = mapped_column(String(256))
    # Human-readable: "internal-token-admin" or SSO username
    actor_username: Mapped[Optional[str]] = mapped_column(String(256))
    # e.g. "x-internal-token" | "authentik-forward-auth" (future)
    actor_source: Mapped[Optional[str]] = mapped_column(String(64))
    request_id: Mapped[Optional[str]] = mapped_column(String(256))
    ip_address: Mapped[Optional[str]] = mapped_column(String(64))
    user_agent: Mapped[Optional[str]] = mapped_column(Text)
    before_json: Mapped[Optional[str]] = mapped_column(Text)
    after_json: Mapped[Optional[str]] = mapped_column(Text)
    metadata_json: Mapped[Optional[str]] = mapped_column(Text)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    error_summary: Mapped[Optional[str]] = mapped_column(Text)

    __table_args__ = (
        Index("ix_admin_audit_logs_created_at", "created_at"),
        Index("ix_admin_audit_logs_action", "action"),
        Index("ix_admin_audit_logs_actor_username", "actor_username"),
    )


class OcrAsyncJob(Base):
    """
    Async job lifecycle table. One row per async OCR submission.
    Linked to ocr_jobs (cost ledger) via nullable FK — the ledger row is created
    when the worker actually runs OCR, so it is absent at enqueue time.
    """

    __tablename__ = "ocr_async_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Set after the worker creates the ledger row (nullable at enqueue time)
    ocr_job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ocr_jobs.id"), nullable=True
    )
    # queued | running | succeeded | failed | cancelled
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    client_app: Mapped[Optional[str]] = mapped_column(String(128))
    workflow: Mapped[Optional[str]] = mapped_column(String(128))
    external_reference_id: Mapped[Optional[str]] = mapped_column(String(256))
    external_reference_type: Mapped[Optional[str]] = mapped_column(String(64))
    original_filename: Mapped[Optional[str]] = mapped_column(String(512))
    mime_type: Mapped[Optional[str]] = mapped_column(String(128))
    # Path on the shared ocr_uploads volume; never the raw file bytes
    input_file_path: Mapped[Optional[str]] = mapped_column(String(1024))
    # Serialised OCR response (same shape as sync /ocr/ response)
    result_json: Mapped[Optional[str]] = mapped_column(Text)
    error_summary: Mapped[Optional[str]] = mapped_column(Text)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    # Worker lock fields — used with SELECT FOR UPDATE SKIP LOCKED
    locked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    locked_by: Mapped[Optional[str]] = mapped_column(String(128))
    queued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=datetime.utcnow
    )
    metadata_json: Mapped[Optional[str]] = mapped_column(Text)

    __table_args__ = (
        Index("ix_ocr_async_jobs_status", "status"),
        Index("ix_ocr_async_jobs_queued_at", "queued_at"),
        Index("ix_ocr_async_jobs_ocr_job_id", "ocr_job_id"),
    )
