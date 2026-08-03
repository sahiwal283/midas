"""
Shared OCR processing pipeline.

run_ocr_pipeline() encapsulates the OCR + LLM + quality + cost logic that was
previously inlined in the sync POST /ocr/ route.  Both the sync route and the
future async worker call this function.

Caller responsibilities:
  - Create the cost-ledger job (create_job) before calling.
  - Save and normalise the uploaded file before calling.
  - Clean up the file after this function returns (or raises).
"""

import uuid
from typing import Any, Dict, Optional

from fastapi import HTTPException, status

from app.db.ledger import get_job_cost_summary, update_job
from app.services.llm_enhancement import llm_enhancement_engine
from app.services.ocr_engine import ocr_engine
from app.services.postprocess import field_inference_engine
from app.utils.logger import setup_logger

logger = setup_logger(__name__)

# Minimum Document AI entity confidence to override an LLM-inferred field.
_DOC_AI_FIELD_CONFIDENCE_MIN = 0.72


async def run_ocr_pipeline(
    *,
    file_path: str,
    is_pdf: bool,
    job_id: Optional[uuid.UUID],
    request_id: uuid.UUID,
    ledger_recorded: bool,
) -> Dict[str, Any]:
    """
    Run the full OCR → LLM → quality → cost pipeline.

    Returns the structured response dict (same shape as the sync /ocr/ endpoint).
    Raises HTTPException(500) on OCR hard failure.
    Updates the cost-ledger job row on both success and failure.
    """
    # ------------------------------------------------------------------
    # 1. OCR
    # ------------------------------------------------------------------
    if is_pdf:
        ocr_result = await ocr_engine.process_pdf(file_path, job_id=job_id, request_id=request_id)
    else:
        ocr_result = await ocr_engine.process_image(file_path, job_id=job_id, request_id=request_id)

    if not ocr_result.get("success", True):
        error_msg = ocr_result.get("error", "OCR processing failed")
        logger.error(f"OCR failed: {error_msg}")
        if job_id:
            await update_job(job_id, status="failed", ocr_provider_used=ocr_result.get("provider"))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"OCR processing failed: {error_msg}",
        )

    ocr_text = ocr_result.get("text", "")
    ocr_confidence = ocr_result.get("confidence", 0.0)

    # ------------------------------------------------------------------
    # 2. Empty text — return early with zero fields
    # ------------------------------------------------------------------
    if not ocr_text:
        logger.warning("OCR returned empty text")
        cost_summary = (
            await get_job_cost_summary(job_id) if job_id else {"total_usd": None, "available": False}
        )
        if job_id:
            await update_job(
                job_id,
                status="completed",
                ocr_provider_used=ocr_result.get("provider"),
                total_estimated_cost_usd=cost_summary.get("total_usd"),
            )
        return {
            "success": True,
            "request_id": str(request_id),
            "job_id": str(job_id) if job_id else None,
            "ocr": {
                "text": "",
                "confidence": 0.0,
                "provider": ocr_result.get("provider", "unknown"),
            },
            "fields": {
                "merchant": {"value": None, "confidence": 0, "source": "llm"},
                "amount": {"value": None, "confidence": 0, "source": "llm"},
                "date": {"value": None, "confidence": 0, "source": "llm"},
                "cardLastFour": {"value": None, "confidence": 0, "source": "llm"},
                "category": {"value": None, "confidence": 0, "source": "llm"},
            },
            "categories": [],
            "quality": {
                "overallConfidence": 0.0,
                "needsReview": True,
                "reviewReasons": ["No text extracted from image"],
            },
            "cost": {
                "estimated_usd": cost_summary["total_usd"],
                "ledger_recorded": ledger_recorded and cost_summary["available"],
                "ledger_unavailable_fallback": bool(ocr_result.get("ledger_unavailable_fallback")),
            },
        }

    # ------------------------------------------------------------------
    # 3. LLM field extraction
    # ------------------------------------------------------------------
    logger.info("Using direct LLM extraction (no rule-based step)")
    inferred_fields = await llm_enhancement_engine.extract_fields_directly(
        ocr_text=ocr_text,
        ocr_confidence=ocr_confidence,
        ocr_result=ocr_result,
        job_id=job_id,
        request_id=request_id,
    )

    # ------------------------------------------------------------------
    # 4. Merge Document AI high-confidence entities (when available)
    # ------------------------------------------------------------------
    entities = ocr_result.get("entities")
    if entities and ocr_result.get("provider") == "document_ai":
        inferred_fields = _merge_document_ai_fields(inferred_fields, entities, ocr_text, ocr_confidence)

    # ------------------------------------------------------------------
    # 5. Category suggestions (rule-based)
    # ------------------------------------------------------------------
    category_suggestions = field_inference_engine.suggest_categories(ocr_text, ocr_confidence, top_n=3)

    # ------------------------------------------------------------------
    # 6. Quality
    # ------------------------------------------------------------------
    field_confidences = [
        inferred_fields["merchant"]["confidence"],
        inferred_fields["amount"]["confidence"],
        inferred_fields["date"]["confidence"],
        inferred_fields["category"]["confidence"],
    ]
    field_confidences = [c for c in field_confidences if c > 0]
    avg_field_confidence = sum(field_confidences) / len(field_confidences) if field_confidences else 0
    overall_confidence = (avg_field_confidence * 0.7) + (ocr_confidence * 0.3)

    review_reasons = []
    if ocr_confidence < 0.5:
        review_reasons.append("Low OCR quality")
    if not inferred_fields["merchant"]["value"] or inferred_fields["merchant"]["confidence"] < 0.6:
        review_reasons.append("Merchant unclear")
    if not inferred_fields["amount"]["value"] or inferred_fields["amount"]["confidence"] < 0.6:
        review_reasons.append("Amount unclear")
    if not inferred_fields["date"]["value"] or inferred_fields["date"]["confidence"] < 0.6:
        review_reasons.append("Date unclear")
    needs_review = len(review_reasons) > 0 or overall_confidence < 0.7

    # ------------------------------------------------------------------
    # 7. Cost summary + job completion
    # ------------------------------------------------------------------
    cost_summary = (
        await get_job_cost_summary(job_id) if job_id else {"total_usd": None, "available": False}
    )
    if job_id:
        await update_job(
            job_id,
            status="completed",
            ocr_provider_used=ocr_result.get("provider"),
            total_estimated_cost_usd=cost_summary.get("total_usd"),
        )

    logger.info(f"OCR pipeline complete: confidence={overall_confidence:.2f}, needsReview={needs_review}")

    return {
        "success": True,
        "request_id": str(request_id),
        "job_id": str(job_id) if job_id else None,
        "ocr": {
            "text": ocr_text,
            "confidence": round(ocr_confidence, 4),
            "provider": ocr_result.get("provider", "unknown"),
            "processingTime": ocr_result.get("metadata", {}).get("processing_time"),
            "metadata": ocr_result.get("metadata", {}),
        },
        "fields": inferred_fields,
        "categories": category_suggestions,
        "quality": {
            "overallConfidence": round(overall_confidence, 4),
            "needsReview": needs_review,
            "reviewReasons": review_reasons if needs_review else None,
        },
        "cost": {
            "estimated_usd": cost_summary["total_usd"],
            "ledger_recorded": ledger_recorded and cost_summary["available"],
            "ledger_unavailable_fallback": bool(ocr_result.get("ledger_unavailable_fallback")),
        },
    }


# ------------------------------------------------------------------
# Document AI entity helpers (moved from ocr.py)
# ------------------------------------------------------------------

def _merge_document_ai_fields(
    inferred_fields: Dict[str, Any],
    entities: Dict[str, Any],
    ocr_text: str,
    ocr_confidence: float,
) -> Dict[str, Any]:
    """Override inferred fields with Document AI entities when confidence is high enough."""
    doc_fields = _convert_doc_ai_entities(entities, ocr_text, ocr_confidence)
    merged = dict(inferred_fields)
    for key, doc_field in doc_fields.items():
        if not isinstance(doc_field, dict):
            continue
        val = doc_field.get("value")
        conf = float(doc_field.get("confidence") or 0.0)
        if val is not None and conf >= _DOC_AI_FIELD_CONFIDENCE_MIN:
            merged[key] = doc_field

    # If Document AI did not extract a date, drop invented dates when OCR text has no
    # parseable date (prevents LLM hallucinations from surviving the merge).
    raw_date_entity = entities.get("date")
    has_doc_date = isinstance(raw_date_entity, dict) and raw_date_entity.get("value") not in (None, "")
    if not has_doc_date:
        rb_date = field_inference_engine._extract_date(ocr_text, ocr_confidence)
        if rb_date.get("value") is None:
            merged["date"] = {"value": None, "confidence": 0, "source": "document_ai"}

    return merged


def _convert_doc_ai_entities(
    entities: Dict[str, Any],
    ocr_text: str,
    ocr_confidence: float,
) -> Dict[str, Any]:
    """Convert Document AI entities dict to standard field format."""

    def get_entity(key: str, default_conf: float = 0.0) -> Dict[str, Any]:
        entity = entities.get(key, {})
        if isinstance(entity, dict):
            return {
                "value": entity.get("value"),
                "confidence": entity.get("confidence", default_conf),
                "source": "document_ai",
            }
        return {"value": None, "confidence": 0, "source": "document_ai"}

    merchant = get_entity("merchant")
    amount_entity = get_entity("amount")
    date = get_entity("date")
    location = get_entity("location")
    tax = get_entity("tax")
    tip = get_entity("tip")

    if amount_entity["value"] and isinstance(amount_entity["value"], dict):
        amount_entity["value"] = amount_entity["value"].get("amount")

    category_result = field_inference_engine._predict_category(ocr_text.lower(), ocr_confidence)

    if merchant.get("value") and merchant.get("confidence", 0) > 0.8:
        merchant_name = str(merchant["value"]).lower()
        if any(brand in merchant_name for brand in ("uber", "lyft")):
            category_result = {
                "value": "Transportation - Uber / Lyft / Others",
                "confidence": 0.95,
                "source": "document_ai",
            }
        elif any(brand in merchant_name for brand in ("hertz", "enterprise", "avis", "budget")):
            category_result = {
                "value": "Rental - Car / U-haul",
                "confidence": 0.95,
                "source": "document_ai",
            }
        elif any(
            w in merchant_name
            for w in ("restaurant", "cafe", "coffee", "bagel", "deli", "bakery", "grill", "kitchen", "bistro")
        ):
            category_result = {
                "value": "Meal and Entertainment",
                "confidence": 0.90,
                "source": "document_ai",
            }

    payment_method = entities.get("payment_method")
    card_last_four: Dict[str, Any] = {"value": None, "confidence": 0, "source": "document_ai"}
    if isinstance(payment_method, dict) and payment_method.get("value"):
        card_last_four = field_inference_engine._extract_card_last_four(
            str(payment_method["value"]),
            min(float(ocr_confidence or 0.9), 0.95),
        )
        card_last_four["source"] = "document_ai"

    return {
        "merchant": merchant,
        "amount": amount_entity,
        "date": date,
        "cardLastFour": card_last_four,
        "category": category_result,
        "location": location,
        "taxAmount": tax,
        "tipAmount": tip,
    }
