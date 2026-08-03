"""
Tests for the cost block in the /ocr/ response.

Verifies that:
  - request_id and job_id are always present in the response
  - cost.estimated_usd and cost.ledger_recorded are present
  - cost.ledger_recorded=False when DB is unavailable
  - cost.ledger_recorded=True when DB recorded successfully
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_ocr_result(provider="tesseract", text="TOTAL $12.99"):
    return {
        "success": True,
        "text": text,
        "confidence": 0.85,
        "provider": provider,
        "metadata": {},
    }


def _make_inferred_fields():
    return {
        "merchant": {"value": "Test Store", "confidence": 0.9, "source": "llm"},
        "amount": {"value": "12.99", "confidence": 0.9, "source": "llm"},
        "date": {"value": "2026-05-08", "confidence": 0.9, "source": "llm"},
        "category": {"value": "Groceries", "confidence": 0.85, "source": "llm"},
        "cardLastFour": {"value": None, "confidence": 0, "source": "llm"},
        "location": {"value": None, "confidence": 0, "source": "llm"},
        "taxAmount": {"value": None, "confidence": 0, "source": "llm"},
        "tipAmount": {"value": None, "confidence": 0, "source": "llm"},
    }


# ---------------------------------------------------------------------------
# cost block shape
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ocr_response_shape_preserved():
    """Existing nested ocr shape and top-level keys must remain intact."""
    from app.main import app

    job_id_val = uuid.uuid4()
    req_id_val = uuid.uuid4()

    with (
        patch("app.routes.ocr.save_upload_file", new_callable=AsyncMock, return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.normalize_upload_for_ocr", return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.ocr_engine") as mock_engine,
        patch("app.routes.ocr.llm_enhancement_engine") as mock_llm,
        patch("app.routes.ocr.field_inference_engine") as mock_post,
        patch("app.routes.ocr.cleanup_file"),
        patch("app.routes.ocr.create_job", new_callable=AsyncMock,
              return_value={"id": str(job_id_val), "request_id": str(req_id_val), "status": "received"}),
        patch("app.routes.ocr.update_job", new_callable=AsyncMock, return_value=True),
        patch("app.routes.ocr.get_job_cost_summary", new_callable=AsyncMock,
              return_value={"total_usd": 0.06, "available": True}),
        patch("os.path.exists", return_value=False),
    ):
        mock_engine.process_image = AsyncMock(return_value=_make_ocr_result(
            text="TOTAL $12.99", provider="tesseract"
        ))
        mock_llm.extract_fields_directly = AsyncMock(return_value=_make_inferred_fields())
        mock_post.suggest_categories = MagicMock(return_value=[{"name": "Groceries", "confidence": 0.8}])

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            import io
            response = await client.post(
                "/ocr/",
                files={"file": ("receipt.jpg", io.BytesIO(b"fake-image"), "image/jpeg")},
            )

    assert response.status_code == 200
    body = response.json()

    # Top-level keys required by the existing contract
    for key in ("success", "ocr", "fields", "categories", "quality"):
        assert key in body, f"Missing top-level key: {key}"

    # Phase 1 additions present
    for key in ("request_id", "job_id", "cost"):
        assert key in body, f"Missing Phase-1 key: {key}"

    # Nested ocr shape intact
    ocr = body["ocr"]
    assert "text" in ocr
    assert "confidence" in ocr
    assert "provider" in ocr
    assert "processingTime" in ocr
    assert "metadata" in ocr

    # text/confidence/provider must NOT be flattened to top-level
    assert "text" not in body, "text must be nested under ocr, not top-level"
    assert "confidence" not in body, "confidence must be nested under ocr, not top-level"
    assert "provider" not in body, "provider must be nested under ocr, not top-level"

    # quality shape
    quality = body["quality"]
    assert "overallConfidence" in quality
    assert "needsReview" in quality

    # cost shape
    cost = body["cost"]
    assert "estimated_usd" in cost
    assert "ledger_recorded" in cost


@pytest.mark.asyncio
async def test_cost_block_present_in_response():
    """Response must always contain request_id, job_id, and cost block."""
    from app.main import app

    job_id_val = uuid.uuid4()
    req_id_val = uuid.uuid4()

    with (
        patch("app.routes.ocr.save_upload_file", new_callable=AsyncMock, return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.normalize_upload_for_ocr", return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.ocr_engine") as mock_engine,
        patch("app.routes.ocr.llm_enhancement_engine") as mock_llm,
        patch("app.routes.ocr.field_inference_engine") as mock_post,
        patch("app.routes.ocr.cleanup_file"),
        patch("app.routes.ocr.create_job", new_callable=AsyncMock,
              return_value={"id": str(job_id_val), "request_id": str(req_id_val), "status": "received"}),
        patch("app.routes.ocr.update_job", new_callable=AsyncMock, return_value=True),
        patch("app.routes.ocr.get_job_cost_summary", new_callable=AsyncMock,
              return_value={"total_usd": 0.06, "available": True}),
        patch("os.path.exists", return_value=False),
    ):
        mock_engine.process_image = AsyncMock(return_value=_make_ocr_result())
        mock_llm.extract_fields_directly = AsyncMock(return_value=_make_inferred_fields())
        mock_post.suggest_categories = MagicMock(return_value=[])

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            import io
            response = await client.post(
                "/ocr/",
                files={"file": ("receipt.jpg", io.BytesIO(b"fake-image"), "image/jpeg")},
            )

    assert response.status_code == 200
    body = response.json()
    assert "request_id" in body
    assert "job_id" in body
    assert "cost" in body
    cost = body["cost"]
    assert "estimated_usd" in cost
    assert "ledger_recorded" in cost


@pytest.mark.asyncio
async def test_cost_ledger_recorded_false_when_db_unavailable():
    """When create_job returns None (DB down), ledger_recorded must be False."""
    from app.main import app

    with (
        patch("app.routes.ocr.save_upload_file", new_callable=AsyncMock, return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.normalize_upload_for_ocr", return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.ocr_engine") as mock_engine,
        patch("app.routes.ocr.llm_enhancement_engine") as mock_llm,
        patch("app.routes.ocr.field_inference_engine") as mock_post,
        patch("app.routes.ocr.cleanup_file"),
        patch("app.routes.ocr.create_job", new_callable=AsyncMock, return_value=None),
        patch("app.routes.ocr.update_job", new_callable=AsyncMock, return_value=False),
        patch("app.routes.ocr.get_job_cost_summary", new_callable=AsyncMock,
              return_value={"total_usd": None, "available": False}),
        patch("os.path.exists", return_value=False),
    ):
        mock_engine.process_image = AsyncMock(return_value=_make_ocr_result())
        mock_llm.extract_fields_directly = AsyncMock(return_value=_make_inferred_fields())
        mock_post.suggest_categories = MagicMock(return_value=[])

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            import io
            response = await client.post(
                "/ocr/",
                files={"file": ("receipt.jpg", io.BytesIO(b"fake-image"), "image/jpeg")},
            )

    assert response.status_code == 200
    body = response.json()
    assert body["cost"]["ledger_recorded"] is False
    assert body["cost"]["estimated_usd"] is None
    assert body["job_id"] is None


@pytest.mark.asyncio
async def test_request_id_accepted_from_header():
    """X-Request-ID header value must appear in response request_id."""
    from app.main import app

    custom_request_id = str(uuid.uuid4())

    with (
        patch("app.routes.ocr.save_upload_file", new_callable=AsyncMock, return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.normalize_upload_for_ocr", return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.ocr_engine") as mock_engine,
        patch("app.routes.ocr.llm_enhancement_engine") as mock_llm,
        patch("app.routes.ocr.field_inference_engine") as mock_post,
        patch("app.routes.ocr.cleanup_file"),
        patch("app.routes.ocr.create_job", new_callable=AsyncMock,
              return_value={"id": str(uuid.uuid4()), "request_id": custom_request_id, "status": "received"}),
        patch("app.routes.ocr.update_job", new_callable=AsyncMock, return_value=True),
        patch("app.routes.ocr.get_job_cost_summary", new_callable=AsyncMock,
              return_value={"total_usd": 0.0, "available": True}),
        patch("os.path.exists", return_value=False),
    ):
        mock_engine.process_image = AsyncMock(return_value=_make_ocr_result())
        mock_llm.extract_fields_directly = AsyncMock(return_value=_make_inferred_fields())
        mock_post.suggest_categories = MagicMock(return_value=[])

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            import io
            response = await client.post(
                "/ocr/",
                files={"file": ("receipt.jpg", io.BytesIO(b"fake-image"), "image/jpeg")},
                headers={"X-Request-ID": custom_request_id},
            )

    assert response.status_code == 200
    body = response.json()
    assert body["request_id"] == custom_request_id


@pytest.mark.asyncio
async def test_cost_estimated_usd_populated():
    """estimated_usd should reflect what the ledger returned."""
    from app.main import app

    with (
        patch("app.routes.ocr.save_upload_file", new_callable=AsyncMock, return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.normalize_upload_for_ocr", return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.ocr_engine") as mock_engine,
        patch("app.routes.ocr.llm_enhancement_engine") as mock_llm,
        patch("app.routes.ocr.field_inference_engine") as mock_post,
        patch("app.routes.ocr.cleanup_file"),
        patch("app.routes.ocr.create_job", new_callable=AsyncMock,
              return_value={"id": str(uuid.uuid4()), "request_id": str(uuid.uuid4()), "status": "received"}),
        patch("app.routes.ocr.update_job", new_callable=AsyncMock, return_value=True),
        patch("app.routes.ocr.get_job_cost_summary", new_callable=AsyncMock,
              return_value={"total_usd": 0.06, "available": True}),
        patch("os.path.exists", return_value=False),
    ):
        mock_engine.process_image = AsyncMock(return_value=_make_ocr_result())
        mock_llm.extract_fields_directly = AsyncMock(return_value=_make_inferred_fields())
        mock_post.suggest_categories = MagicMock(return_value=[])

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            import io
            response = await client.post(
                "/ocr/",
                files={"file": ("receipt.jpg", io.BytesIO(b"fake-image"), "image/jpeg")},
            )

    assert response.status_code == 200
    body = response.json()
    assert body["cost"]["estimated_usd"] == pytest.approx(0.06)
    assert body["cost"]["ledger_recorded"] is True


# ---------------------------------------------------------------------------
# X-Expense-ID conflict handling
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_expense_id_conflict_logs_warning_and_explicit_wins(caplog):
    """When X-External-Reference-ID and X-Expense-ID differ, explicit ID wins and a warning is logged."""
    import logging
    from app.main import app

    explicit_ref = str(uuid.uuid4())
    legacy_expense = str(uuid.uuid4())  # different value

    captured_create_job_kwargs = {}

    async def _fake_create_job(**kwargs):
        captured_create_job_kwargs.update(kwargs)
        return {"id": str(uuid.uuid4()), "request_id": str(uuid.uuid4()), "status": "received"}

    with (
        patch("app.routes.ocr.save_upload_file", new_callable=AsyncMock, return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.normalize_upload_for_ocr", return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.ocr_engine") as mock_engine,
        patch("app.routes.ocr.llm_enhancement_engine") as mock_llm,
        patch("app.routes.ocr.field_inference_engine") as mock_post,
        patch("app.routes.ocr.cleanup_file"),
        patch("app.routes.ocr.create_job", side_effect=_fake_create_job),
        patch("app.routes.ocr.update_job", new_callable=AsyncMock, return_value=True),
        patch("app.routes.ocr.get_job_cost_summary", new_callable=AsyncMock,
              return_value={"total_usd": 0.0, "available": True}),
        patch("os.path.exists", return_value=False),
    ):
        mock_engine.process_image = AsyncMock(return_value=_make_ocr_result())
        mock_llm.extract_fields_directly = AsyncMock(return_value=_make_inferred_fields())
        mock_post.suggest_categories = MagicMock(return_value=[])

        # setup_logger sets propagate=False so caplog's root hook misses these records.
        # Attach caplog's handler directly to the module logger for the duration of the call.
        import logging as _logging
        _ocr_log = _logging.getLogger("app.routes.ocr")
        _ocr_log.addHandler(caplog.handler)
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                import io
                response = await client.post(
                    "/ocr/",
                    files={"file": ("receipt.jpg", io.BytesIO(b"fake-image"), "image/jpeg")},
                    headers={
                        "X-External-Reference-ID": explicit_ref,
                        "X-Expense-ID": legacy_expense,
                        "X-Client-App": "test-caller",
                    },
                )
        finally:
            _ocr_log.removeHandler(caplog.handler)

    assert response.status_code == 200

    # X-External-Reference-ID must win
    assert captured_create_job_kwargs.get("external_reference_id") == explicit_ref

    # Warning must contain both header names (not the values — callers may treat them as sensitive)
    conflict_warnings = [
        r for r in caplog.records
        if r.levelno >= logging.WARNING
        and "X-External-Reference-ID" in r.getMessage()
        and "X-Expense-ID" in r.getMessage()
    ]
    assert conflict_warnings, "Expected a warning about X-External-Reference-ID / X-Expense-ID conflict"


@pytest.mark.asyncio
async def test_expense_id_no_conflict_when_same_value(caplog):
    """No warning when X-External-Reference-ID and X-Expense-ID carry the same value."""
    import logging
    from app.main import app

    shared_id = str(uuid.uuid4())

    with (
        patch("app.routes.ocr.save_upload_file", new_callable=AsyncMock, return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.normalize_upload_for_ocr", return_value="/tmp/test.jpg"),
        patch("app.routes.ocr.ocr_engine") as mock_engine,
        patch("app.routes.ocr.llm_enhancement_engine") as mock_llm,
        patch("app.routes.ocr.field_inference_engine") as mock_post,
        patch("app.routes.ocr.cleanup_file"),
        patch("app.routes.ocr.create_job", new_callable=AsyncMock,
              return_value={"id": str(uuid.uuid4()), "request_id": str(uuid.uuid4()), "status": "received"}),
        patch("app.routes.ocr.update_job", new_callable=AsyncMock, return_value=True),
        patch("app.routes.ocr.get_job_cost_summary", new_callable=AsyncMock,
              return_value={"total_usd": 0.0, "available": True}),
        patch("os.path.exists", return_value=False),
    ):
        mock_engine.process_image = AsyncMock(return_value=_make_ocr_result())
        mock_llm.extract_fields_directly = AsyncMock(return_value=_make_inferred_fields())
        mock_post.suggest_categories = MagicMock(return_value=[])

        import logging as _logging
        _ocr_log = _logging.getLogger("app.routes.ocr")
        _ocr_log.addHandler(caplog.handler)
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                import io
                response = await client.post(
                    "/ocr/",
                    files={"file": ("receipt.jpg", io.BytesIO(b"fake-image"), "image/jpeg")},
                    headers={
                        "X-External-Reference-ID": shared_id,
                        "X-Expense-ID": shared_id,
                    },
                )
        finally:
            _ocr_log.removeHandler(caplog.handler)

    assert response.status_code == 200
    conflict_warnings = [
        r for r in caplog.records
        if r.levelno >= logging.WARNING
        and "X-External-Reference-ID" in r.getMessage()
        and "X-Expense-ID" in r.getMessage()
    ]
    assert not conflict_warnings, "Should not warn when both IDs are identical"
