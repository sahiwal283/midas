"""
Estimated USD for telemetry (rate × usage). Override via TELEMETRY_* env vars; reconcile with GCP Billing.
"""

from __future__ import annotations

import math
import os


def _f(name: str, default: str) -> float:
    return float(os.getenv(name, default))


def estimate_document_ai_usd(page_count: int) -> float:
    """Expense Parser (formerly Receipt Parser): $0.10 per 10-page document chunk.

    Formula: ceil(page_count / 10) * chunk_rate
    Override chunk_rate via TELEMETRY_DOCUMENT_AI_USD_PER_CHUNK.
    """
    pages = max(int(page_count), 1)
    chunk_rate = _f("TELEMETRY_DOCUMENT_AI_USD_PER_CHUNK", "0.10")
    return round(math.ceil(pages / 10) * chunk_rate, 6)


def estimate_google_vision_usd(unit_count: int) -> float:
    """Vision document text detection: default per image/page unit."""
    n = max(int(unit_count), 1)
    rate = _f("TELEMETRY_GOOGLE_VISION_USD_PER_IMAGE", "0.0015")
    return round(n * rate, 6)


def estimate_gemini_usd(total_tokens: int) -> float:
    """Blended $/1M tokens for Gemini (set TELEMETRY_GEMINI_USD_PER_1M_TOKENS to match your model)."""
    t = max(int(total_tokens), 0)
    rate = _f("TELEMETRY_GEMINI_USD_PER_1M_TOKENS", "0.20")
    return round((t / 1_000_000.0) * rate, 6)


def estimate_openai_usd(total_tokens: int) -> float:
    """Blended $/1M tokens for OpenAI (set TELEMETRY_OPENAI_USD_PER_1M_TOKENS to match your model)."""
    t = max(int(total_tokens), 0)
    rate = _f("TELEMETRY_OPENAI_USD_PER_1M_TOKENS", "0.30")
    return round((t / 1_000_000.0) * rate, 6)
