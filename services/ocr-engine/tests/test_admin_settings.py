"""
Tests for GET /admin/settings, POST /admin/settings/preview, and POST /admin/settings/apply.

DB is not required for these endpoints.
Auth is tested in test_admin_auth.py; here it is bypassed for functional tests,
and explicitly tested for the auth-gate tests using the raw client.
"""

import pytest as _pytest_module
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

_TOKEN = "test-settings-admin-token"

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def bypass_admin_auth():
    """Override require_admin_token so functional tests skip real token checks."""
    from app.utils.admin_auth import require_admin_token, AdminIdentity
    from app.main import app as fa
    fa.dependency_overrides[require_admin_token] = lambda: AdminIdentity.test_identity()
    yield
    fa.dependency_overrides.pop(require_admin_token, None)


@pytest.fixture()
def client(bypass_admin_auth):
    """Authenticated test client (auth bypassed)."""
    from app.main import app
    return TestClient(app)


@pytest.fixture()
def raw_client():
    """Unauthenticated test client — real token check applies."""
    from app.main import app
    return TestClient(app)


# ---------------------------------------------------------------------------
# GET /admin/settings — auth gate
# ---------------------------------------------------------------------------


class TestAdminSettingsAuth:
    def test_no_token_env_returns_503(self, raw_client):
        with patch("app.utils.admin_auth.settings") as s:
            s.OCR_ADMIN_INTERNAL_TOKEN = None
            resp = raw_client.get("/admin/settings")
        assert resp.status_code == 503

    def test_missing_token_header_returns_401(self, raw_client):
        with patch("app.utils.admin_auth.settings") as s:
            s.OCR_ADMIN_INTERNAL_TOKEN = _TOKEN
            resp = raw_client.get("/admin/settings")
        assert resp.status_code == 401

    def test_wrong_token_returns_401(self, raw_client):
        with patch("app.utils.admin_auth.settings") as s:
            s.OCR_ADMIN_INTERNAL_TOKEN = _TOKEN
            resp = raw_client.get(
                "/admin/settings",
                headers={"X-Internal-Token": "completely-wrong"},
            )
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GET /admin/settings — response shape and content
# ---------------------------------------------------------------------------


class TestAdminSettingsGet:
    def test_returns_200(self, client):
        resp = client.get("/admin/settings")
        assert resp.status_code == 200

    def test_has_internal_only_header(self, client):
        resp = client.get("/admin/settings")
        assert resp.headers.get("x-internal-only") == "true"

    def test_has_service_version(self, client):
        resp = client.get("/admin/settings")
        assert "service_version" in resp.json()

    def test_has_require_cost_ledger(self, client):
        resp = client.get("/admin/settings")
        assert "require_cost_ledger" in resp.json()

    def test_has_primary_ocr_provider(self, client):
        resp = client.get("/admin/settings")
        assert "primary_ocr_provider" in resp.json()

    def test_has_fallback_ocr_provider(self, client):
        resp = client.get("/admin/settings")
        assert "fallback_ocr_provider" in resp.json()

    def test_has_providers_metadata(self, client):
        resp = client.get("/admin/settings")
        body = resp.json()
        assert "providers" in body
        providers = body["providers"]
        assert "document_ai" in providers
        assert "tesseract" in providers

    def test_providers_have_current_role(self, client):
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "google_vision"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = "tesseract"
            s.REQUIRE_COST_LEDGER = True
            s.ASYNC_WORKER_ENABLED = False
            s.ADMIN_AUTH_MODE = "internal_token"
            s.ENABLE_LLM_INFERENCE = False
            s.VERSION = "0.8.0"
            s.ENVIRONMENT = "test"
            resp = client.get("/admin/settings")
        providers = resp.json()["providers"]
        assert "primary" in providers["document_ai"]["current_role"]
        assert "fallback" in providers["google_vision"]["current_role"]
        assert "ledger_unavailable_fallback" in providers["tesseract"]["current_role"]

    def test_allowed_for_ledger_fallback_false_for_metered(self, client):
        resp = client.get("/admin/settings")
        providers = resp.json()["providers"]
        assert providers["document_ai"]["allowed_for_ledger_unavailable_fallback"] is False
        assert providers["google_vision"]["allowed_for_ledger_unavailable_fallback"] is False

    def test_allowed_for_ledger_fallback_true_for_local(self, client):
        resp = client.get("/admin/settings")
        providers = resp.json()["providers"]
        assert providers["tesseract"]["allowed_for_ledger_unavailable_fallback"] is True
        assert providers["easyocr"]["allowed_for_ledger_unavailable_fallback"] is True

    def test_async_worker_block_present(self, client):
        resp = client.get("/admin/settings")
        body = resp.json()
        assert "async_worker" in body
        aw = body["async_worker"]
        assert "api_container_enabled" in aw
        assert "worker_container_state" in aw
        assert "worker_container_note" in aw

    def test_worker_container_state_is_unknown(self, client):
        resp = client.get("/admin/settings")
        aw = resp.json()["async_worker"]
        assert aw["worker_container_state"] == "unknown"

    def test_sso_enabled_is_false(self, client):
        resp = client.get("/admin/settings")
        assert resp.json()["sso_enabled"] is False

    def test_no_secrets_in_response(self, client):
        resp = client.get("/admin/settings")
        text = resp.text
        # Should not contain sensitive fields
        for forbidden in ("DATABASE_URL", "postgresql", "OCR_ADMIN_INTERNAL_TOKEN",
                          "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_API_KEY",
                          "OPENAI_API_KEY", "GOOGLE_VISION_API_KEY"):
            assert forbidden not in text, f"Response should not contain {forbidden}"

    def test_internal_only_flag(self, client):
        resp = client.get("/admin/settings")
        assert resp.json()["_internal_only"] is True


# ---------------------------------------------------------------------------
# POST /admin/settings/preview — auth gate
# ---------------------------------------------------------------------------


class TestAdminSettingsPreviewAuth:
    def test_no_token_env_returns_503(self, raw_client):
        with patch("app.utils.admin_auth.settings") as s:
            s.OCR_ADMIN_INTERNAL_TOKEN = None
            resp = raw_client.post("/admin/settings/preview", json={})
        assert resp.status_code == 503

    def test_missing_token_returns_401(self, raw_client):
        with patch("app.utils.admin_auth.settings") as s:
            s.OCR_ADMIN_INTERNAL_TOKEN = _TOKEN
            resp = raw_client.post("/admin/settings/preview", json={})
        assert resp.status_code == 401

    def test_wrong_token_returns_401(self, raw_client):
        with patch("app.utils.admin_auth.settings") as s:
            s.OCR_ADMIN_INTERNAL_TOKEN = _TOKEN
            resp = raw_client.post(
                "/admin/settings/preview",
                json={"primary_ocr_provider": "tesseract"},
                headers={"X-Internal-Token": "bad-token"},
            )
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# POST /admin/settings/preview — functional tests
# ---------------------------------------------------------------------------


class TestAdminSettingsPreview:
    def test_returns_200(self, client):
        resp = client.post("/admin/settings/preview", json={})
        assert resp.status_code == 200

    def test_apply_supported_false_for_noop(self, client):
        """proposed == current → no change → apply_supported=False, no token."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "tesseract"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
            })
        assert resp.json()["apply_supported"] is False
        assert resp.json()["preview_token"] is None

    def test_apply_note_present(self, client):
        resp = client.post("/admin/settings/preview", json={})
        assert "apply_note" in resp.json()
        assert resp.json()["apply_note"]

    def test_valid_flag_present(self, client):
        resp = client.post("/admin/settings/preview", json={})
        assert "valid" in resp.json()

    def test_valid_current_config(self, client):
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "google_vision"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = "tesseract"
            resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "document_ai",
                "fallback_ocr_provider": "google_vision",
                "ledger_unavailable_fallback_provider": "tesseract",
            })
        body = resp.json()
        assert body["valid"] is True
        assert body["errors"] == []

    def test_rejects_unknown_primary_provider(self, client):
        resp = client.post("/admin/settings/preview", json={
            "primary_ocr_provider": "super_ocr_v9",
        })
        body = resp.json()
        assert body["valid"] is False
        assert any("super_ocr_v9" in e for e in body["errors"])

    def test_rejects_metered_ledger_unavailable_fallback(self, client):
        resp = client.post("/admin/settings/preview", json={
            "primary_ocr_provider": "document_ai",
            "fallback_ocr_provider": "google_vision",
            "ledger_unavailable_fallback_provider": "document_ai",
        })
        body = resp.json()
        assert body["valid"] is False
        assert any("metered" in e.lower() for e in body["errors"])

    def test_warns_paid_async_worker_mode(self, client):
        resp = client.post("/admin/settings/preview", json={
            "async_worker_mode": "paid_normal",
        })
        body = resp.json()
        assert any("paid_normal" in w or "metered" in w.lower() for w in body["warnings"])

    def test_rejects_unknown_worker_mode(self, client):
        resp = client.post("/admin/settings/preview", json={
            "async_worker_mode": "turbo_mode",
        })
        body = resp.json()
        assert body["valid"] is False
        assert any("turbo_mode" in e for e in body["errors"])

    def test_valid_local_only_config(self, client):
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "tesseract"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = "tesseract"
            resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
                "fallback_ocr_provider": "tesseract",
                "ledger_unavailable_fallback_provider": "tesseract",
            })
        body = resp.json()
        assert body["valid"] is True
        assert body["errors"] == []

    def test_would_change_populated_when_different(self, client):
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "google_vision"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = "tesseract"
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
            })
        body = resp.json()
        changes = {c["field"]: c for c in body["would_change"]}
        assert "primary_ocr_provider" in changes
        assert changes["primary_ocr_provider"]["current"] == "document_ai"
        assert changes["primary_ocr_provider"]["proposed"] == "tesseract"

    def test_would_change_empty_when_same(self, client):
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "google_vision"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = "tesseract"
            resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "document_ai",
                "fallback_ocr_provider": "google_vision",
                "ledger_unavailable_fallback_provider": "tesseract",
            })
        body = resp.json()
        assert body["would_change"] == []
        assert body["requires_restart"] is False

    def test_requires_restart_true_when_changes(self, client):
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "google_vision"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = "tesseract"
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
            })
        assert resp.json()["requires_restart"] is True

    def test_does_not_mutate_settings(self, client):
        from app.config import settings as real_settings
        original_primary = real_settings.PRIMARY_OCR_PROVIDER
        client.post("/admin/settings/preview", json={
            "primary_ocr_provider": "tesseract",
            "fallback_ocr_provider": "tesseract",
        })
        assert real_settings.PRIMARY_OCR_PROVIDER == original_primary

    def test_worker_mode_in_would_change(self, client):
        resp = client.post("/admin/settings/preview", json={
            "async_worker_mode": "local_only",
        })
        body = resp.json()
        changes = {c["field"]: c for c in body["would_change"]}
        assert "async_worker_mode" in changes
        assert changes["async_worker_mode"]["proposed"] == "local_only"


# ---------------------------------------------------------------------------
# POST /admin/settings/preview — B2 token issuance tests
# ---------------------------------------------------------------------------


class TestAdminSettingsPreviewB2:
    def test_apply_supported_true_for_valid_provider_change(self, client):
        """A single valid provider change returns apply_supported=True and a token."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
            })
        body = resp.json()
        assert body["apply_supported"] is True
        assert body["preview_token"] is not None
        assert body["expires_at"] is not None

    def test_preview_token_structure(self, client):
        """Token must be base64url_payload.hex_sig (64-char SHA-256 hex signature)."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
            })
        token = resp.json()["preview_token"]
        parts = token.split(".", 1)
        assert len(parts) == 2, "Token must contain exactly one dot separator"
        assert len(parts[1]) == 64, "Signature must be 64-char SHA-256 hex"

    def test_apply_supported_false_worker_mode_only(self, client):
        """Worker-mode-only change → apply_supported=False (not a provider-only change)."""
        resp = client.post("/admin/settings/preview", json={
            "async_worker_mode": "local_only",
        })
        body = resp.json()
        assert body["apply_supported"] is False
        assert body["preview_token"] is None

    def test_apply_supported_false_mixed_provider_and_worker(self, client):
        """Provider + worker mode change → apply_supported=False (non-provider change present)."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
                "async_worker_mode": "local_only",
            })
        body = resp.json()
        assert body["apply_supported"] is False
        assert body["preview_token"] is None
        assert body["apply_note"]  # async note present

    def test_no_token_for_invalid_config(self, client):
        """Invalid provider → apply_supported=False even if there are changes."""
        resp = client.post("/admin/settings/preview", json={
            "primary_ocr_provider": "nonexistent_provider_xyz",
        })
        body = resp.json()
        assert body["valid"] is False
        assert body["apply_supported"] is False
        assert body["preview_token"] is None

    def test_multiple_provider_changes_get_token(self, client):
        """All three provider fields changed → apply_supported=True, token covers all fields."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "google_vision"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
                "fallback_ocr_provider": "easyocr",
                "ledger_unavailable_fallback_provider": "tesseract",
            })
        body = resp.json()
        assert body["apply_supported"] is True
        assert body["preview_token"] is not None
        assert len(body["would_change"]) == 3


# ---------------------------------------------------------------------------
# Shared fixture for apply tests
# ---------------------------------------------------------------------------


@_pytest_module.fixture()
def tmp_env_file(tmp_path):
    """Minimal .env file for apply tests; isolated per test."""
    env_path = tmp_path / ".env"
    env_path.write_text(
        "PRIMARY_OCR_PROVIDER=document_ai\n"
        "FALLBACK_OCR_PROVIDER=tesseract\n"
        "LEDGER_UNAVAILABLE_FALLBACK_PROVIDER=\n"
        "OTHER_KEY=should_not_change\n"
        "REQUIRE_COST_LEDGER=true\n"
    )
    return env_path


# ---------------------------------------------------------------------------
# POST /admin/settings/apply — auth gate
# ---------------------------------------------------------------------------


class TestAdminSettingsApplyAuth:
    def test_no_token_env_returns_503(self, raw_client):
        with patch("app.utils.admin_auth.settings") as s:
            s.OCR_ADMIN_INTERNAL_TOKEN = None
            resp = raw_client.post("/admin/settings/apply", json={"preview_token": "x"})
        assert resp.status_code == 503

    def test_missing_token_header_returns_401(self, raw_client):
        with patch("app.utils.admin_auth.settings") as s:
            s.OCR_ADMIN_INTERNAL_TOKEN = _TOKEN
            resp = raw_client.post("/admin/settings/apply", json={"preview_token": "x"})
        assert resp.status_code == 401

    def test_wrong_token_returns_401(self, raw_client):
        with patch("app.utils.admin_auth.settings") as s:
            s.OCR_ADMIN_INTERNAL_TOKEN = _TOKEN
            resp = raw_client.post(
                "/admin/settings/apply",
                json={"preview_token": "x"},
                headers={"X-Internal-Token": "completely-wrong"},
            )
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# POST /admin/settings/apply — functional tests
# ---------------------------------------------------------------------------


class TestAdminSettingsApply:
    # --- helper ---

    def _preview_and_apply(self, client, tmp_env_file, proposed: dict, admin_token: str = "test-admin-tok"):
        """Run preview→apply in a single patched-settings context and return the apply response."""
        from app.config import settings as real_s
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = admin_token
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            s.OCR_ENV_WRITABLE_PATH = str(tmp_env_file)
            preview = client.post("/admin/settings/preview", json=proposed)
            token = preview.json().get("preview_token")
            apply_resp = client.post(
                "/admin/settings/apply",
                json={**proposed, "preview_token": token},
            )
        return apply_resp

    # --- no changes ---

    def test_returns_400_when_no_changes(self, client, tmp_env_file):
        """Submitting proposed values identical to current values → 400 (nothing to apply)."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-admin-tok"
            s.OCR_ENV_WRITABLE_PATH = str(tmp_env_file)
            resp = client.post("/admin/settings/apply", json={
                "primary_ocr_provider": "document_ai",  # same as current mock
                "preview_token": "does_not_matter",
            })
        assert resp.status_code == 400
        assert "no provider changes" in resp.json()["detail"].lower()

    # --- token rejection ---

    def test_rejects_malformed_token(self, client, tmp_env_file):
        """Token with no dot separator fails validation."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-admin-tok"
            s.OCR_ENV_WRITABLE_PATH = str(tmp_env_file)
            resp = client.post("/admin/settings/apply", json={
                "primary_ocr_provider": "tesseract",
                "preview_token": "nodotsinhere",
            })
        assert resp.status_code == 400
        detail = resp.json()["detail"].lower()
        assert "invalid" in detail or "token" in detail

    def test_rejects_tampered_signature(self, client, tmp_env_file):
        """Corrupting the hex signature causes HMAC failure → 400."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-admin-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            s.OCR_ENV_WRITABLE_PATH = str(tmp_env_file)
            preview_resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
            })
            token = preview_resp.json()["preview_token"]
            tampered = token[:-4] + "xxxx"  # corrupt last 4 chars of hex sig
            resp = client.post("/admin/settings/apply", json={
                "primary_ocr_provider": "tesseract",
                "preview_token": tampered,
            })
        assert resp.status_code == 400
        assert "invalid" in resp.json()["detail"].lower()

    def test_rejects_expired_token(self, client, tmp_env_file):
        """Token with exp in the past → 400 expired."""
        from app.routes.admin import _make_preview_token
        changes = [{"field": "primary_ocr_provider", "current": "document_ai", "proposed": "tesseract"}]
        # Generate an already-expired token (TTL = -1 second)
        with patch("app.routes.admin.settings") as s:
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-admin-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = -1
            expired_token, _ = _make_preview_token(changes)

        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-admin-tok"  # same key → HMAC matches
            s.OCR_ENV_WRITABLE_PATH = str(tmp_env_file)
            resp = client.post("/admin/settings/apply", json={
                "primary_ocr_provider": "tesseract",
                "preview_token": expired_token,
            })
        assert resp.status_code == 400
        assert "expired" in resp.json()["detail"].lower()

    def test_rejects_mismatched_proposed_value(self, client, tmp_env_file):
        """Token was for tesseract but apply submits easyocr → proposed-value mismatch → 400."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-admin-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            s.OCR_ENV_WRITABLE_PATH = str(tmp_env_file)
            preview_resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",  # token for tesseract
            })
            token = preview_resp.json()["preview_token"]
            # submit with different proposed value
            resp = client.post("/admin/settings/apply", json={
                "primary_ocr_provider": "easyocr",
                "preview_token": token,
            })
        assert resp.status_code == 400
        assert "match" in resp.json()["detail"].lower() or "mismatch" in resp.json()["detail"].lower() or "does not match" in resp.json()["detail"].lower()

    def test_rejects_extra_field_not_in_token(self, client, tmp_env_file):
        """Token covers primary only; apply adds fallback → field-set mismatch → 400."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "google_vision"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-admin-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            s.OCR_ENV_WRITABLE_PATH = str(tmp_env_file)
            preview_resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",  # token only covers primary
            })
            token = preview_resp.json()["preview_token"]
            # apply adds fallback_ocr_provider not in token
            resp = client.post("/admin/settings/apply", json={
                "primary_ocr_provider": "tesseract",
                "fallback_ocr_provider": "easyocr",  # extra field not in token
                "preview_token": token,
            })
        assert resp.status_code == 400

    # --- successful apply ---

    def test_valid_apply_returns_200(self, client, tmp_env_file):
        resp = self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        assert resp.status_code == 200

    def test_valid_apply_applied_true(self, client, tmp_env_file):
        resp = self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        assert resp.json()["applied"] is True

    def test_valid_apply_restart_required_true(self, client, tmp_env_file):
        resp = self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        assert resp.json()["restart_required"] is True

    def test_valid_apply_includes_changed_fields(self, client, tmp_env_file):
        resp = self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        body = resp.json()
        assert "changed_fields" in body
        fields = {c["field"] for c in body["changed_fields"]}
        assert "primary_ocr_provider" in fields

    def test_valid_apply_includes_backup_filename(self, client, tmp_env_file):
        resp = self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        body = resp.json()
        assert "backup_filename" in body
        assert body["backup_filename"].endswith(".bak")

    def test_valid_apply_includes_restart_command(self, client, tmp_env_file):
        resp = self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        body = resp.json()
        assert "restart_command" in body
        assert "docker" in body["restart_command"]

    # --- env file assertions ---

    def test_env_file_updated_with_new_value(self, client, tmp_env_file):
        self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        content = tmp_env_file.read_text()
        assert "PRIMARY_OCR_PROVIDER=tesseract" in content

    def test_env_file_preserves_other_keys(self, client, tmp_env_file):
        self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        content = tmp_env_file.read_text()
        assert "OTHER_KEY=should_not_change" in content

    def test_env_file_require_cost_ledger_unchanged(self, client, tmp_env_file):
        """REQUIRE_COST_LEDGER is never rewritten by apply — value in file stays as-is."""
        self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        content = tmp_env_file.read_text()
        # Original file had REQUIRE_COST_LEDGER=true; apply must not have changed it
        assert "REQUIRE_COST_LEDGER=true" in content

    def test_env_file_backup_exists_and_has_original_value(self, client, tmp_env_file):
        resp = self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        backup_name = resp.json()["backup_filename"]
        backup_path = tmp_env_file.parent / backup_name
        assert backup_path.exists()
        backup_content = backup_path.read_text()
        assert "PRIMARY_OCR_PROVIDER=document_ai" in backup_content

    # --- whitelisted fields only ---

    def test_async_worker_enabled_cannot_be_changed_via_apply(self, client, tmp_env_file):
        """ApplyRequest has no async_worker_enabled field; extra JSON fields are silently ignored."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-admin-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            s.OCR_ENV_WRITABLE_PATH = str(tmp_env_file)
            preview_resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
            })
            token = preview_resp.json()["preview_token"]
            resp = client.post("/admin/settings/apply", json={
                "primary_ocr_provider": "tesseract",
                "async_worker_enabled": "true",  # not a model field → ignored
                "preview_token": token,
            })
        assert resp.status_code == 200
        content = tmp_env_file.read_text()
        # ASYNC_WORKER_ENABLED must not have been added to the file by apply
        lines = [ln for ln in content.splitlines() if ln.startswith("ASYNC_WORKER_ENABLED=")]
        assert len(lines) == 0, "apply must not write ASYNC_WORKER_ENABLED"

    # --- no secrets in response ---

    def test_no_secrets_in_apply_response(self, client, tmp_env_file):
        resp = self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
        text = resp.text
        for forbidden in ("DATABASE_URL", "postgresql", "OCR_ADMIN_INTERNAL_TOKEN",
                          "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_API_KEY",
                          "OPENAI_API_KEY", "GOOGLE_VISION_API_KEY"):
            assert forbidden not in text, f"Response must not contain {forbidden}"

    # --- no container restart ---

    def test_apply_does_not_call_restart(self, client, tmp_env_file):
        """Apply only writes .env; it never triggers a subprocess restart."""
        import subprocess
        with patch("subprocess.run") as mock_run, \
             patch("subprocess.Popen") as mock_popen:
            self._preview_and_apply(client, tmp_env_file, {"primary_ocr_provider": "tesseract"})
            mock_run.assert_not_called()
            mock_popen.assert_not_called()

    # --- missing .env file → 500 ---

    def test_returns_500_when_env_file_missing(self, client):
        """If OCR_ENV_WRITABLE_PATH does not exist, apply returns 500."""
        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-admin-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            preview_resp = client.post("/admin/settings/preview", json={
                "primary_ocr_provider": "tesseract",
            })
            token = preview_resp.json()["preview_token"]

        with patch("app.routes.admin.settings") as s:
            s.PRIMARY_OCR_PROVIDER = "document_ai"
            s.FALLBACK_OCR_PROVIDER = "tesseract"
            s.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER = None
            s.OCR_ADMIN_INTERNAL_TOKEN = "test-admin-tok"
            s.PREVIEW_TOKEN_TTL_SECONDS = 900
            s.OCR_ENV_WRITABLE_PATH = "/nonexistent/path/.env"
            resp = client.post("/admin/settings/apply", json={
                "primary_ocr_provider": "tesseract",
                "preview_token": token,
            })
        assert resp.status_code == 500
        assert "bind-mounted" in resp.json()["detail"] or "not found" in resp.json()["detail"].lower() or "Config file" in resp.json()["detail"]
