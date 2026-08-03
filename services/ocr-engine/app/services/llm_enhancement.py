"""
LLM Enhancement Layer

Two usage modes coexist:
  1. enhance_if_needed() — rule-based first, then selective LLM (legacy path, kept for tests and callers)
  2. extract_fields_directly() — always LLM, two-tier prompt based on complexity (current route path)
"""

import json
import random
import uuid
from typing import Dict, Any, Optional, List

from app.config import settings
from app.utils.logger import setup_logger
from app.services.prompt_service import prompt_service
from app.services.llm_provider import get_llm_provider
from app.services.complexity_analyzer import complexity_analyzer
from app.services.postprocess import field_inference_engine

logger = setup_logger(__name__)


class LLMEnhancementEngine:
    # Confidence thresholds used by enhance_if_needed / _should_enhance
    OVERALL_CONFIDENCE_THRESHOLD = 0.70
    CRITICAL_FIELD_THRESHOLD = 0.60
    CATEGORY_THRESHOLD = 0.60
    CRITICAL_FIELDS = ['amount', 'merchant', 'date', 'category']

    def __init__(self):
        self.enabled = settings.ENABLE_LLM_INFERENCE
        self.sample_rate = settings.HIGH_CONFIDENCE_SAMPLE_RATE
        logger.info(f"LLM Enhancement Engine initialized (enabled: {self.enabled}, sample_rate: {self.sample_rate})")

    # ------------------------------------------------------------------
    # Direct extraction path (current route pipeline)
    # ------------------------------------------------------------------

    async def extract_fields_directly(
        self,
        ocr_text: str,
        ocr_confidence: float,
        ocr_result: Optional[Dict[str, Any]] = None,
        job_id: Optional[uuid.UUID] = None,
        request_id: Optional[uuid.UUID] = None,
    ) -> Dict[str, Any]:
        """Extract fields directly from OCR text using LLM (always)."""
        if not self.enabled:
            logger.debug("LLM extraction disabled, using rule-based fallback")
            return self._fallback_to_rule_based(ocr_text, ocr_confidence)

        if ocr_result is None:
            ocr_result = {'confidence': ocr_confidence}

        complexity_result = complexity_analyzer.analyze(ocr_result, ocr_text)
        is_complex = complexity_result['is_complex']
        tier = complexity_result['tier']
        logger.info(f"Receipt complexity: {complexity_result['complexity_score']:.2f}, tier: {tier}")

        prompt_data = await prompt_service.get_active_prompt()
        if not prompt_data:
            logger.warning("No prompt available, using rule-based fallback")
            return self._fallback_to_rule_based(ocr_text, ocr_confidence)

        llm = get_llm_provider()
        if not llm:
            logger.warning("LLM provider not available, using rule-based fallback")
            return self._fallback_to_rule_based(ocr_text, ocr_confidence)

        system_prompt = prompt_data.get('system_prompt', '')
        user_prompt_template = prompt_data.get('user_prompt_template', '')

        if is_complex:
            user_prompt = self._build_full_prompt(ocr_text, user_prompt_template, prompt_data)
        else:
            user_prompt = self._build_minimal_prompt(ocr_text, user_prompt_template)

        llm_fields = await llm.enhance_fields(
            ocr_text=ocr_text,
            rule_based_fields={},
            system_prompt=system_prompt,
            user_prompt_template=user_prompt,
            job_id=job_id,
            request_id=request_id,
        )

        if not llm_fields:
            logger.warning("LLM extraction failed, using rule-based fallback")
            return self._fallback_to_rule_based(ocr_text, ocr_confidence)

        extracted_fields = self._format_llm_fields(llm_fields)
        logger.info(f"LLM extraction successful (tier: {tier})")
        return extracted_fields

    # ------------------------------------------------------------------
    # Selective enhancement path (legacy / tests)
    # ------------------------------------------------------------------

    async def enhance_if_needed(
        self,
        ocr_text: str,
        ocr_confidence: float,
        rule_based_fields: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Enhance fields with LLM if confidence is low."""
        if not self.enabled:
            logger.debug("LLM enhancement disabled")
            return rule_based_fields

        needs_enhancement, reasons = self._should_enhance(rule_based_fields, ocr_confidence)
        if not needs_enhancement:
            logger.debug("No LLM enhancement needed (confidence sufficient)")
            return rule_based_fields

        logger.info(f"LLM enhancement triggered: {', '.join(reasons)}")

        prompt_data = await prompt_service.get_active_prompt()
        if not prompt_data:
            logger.warning("No prompt available, using rule-based only")
            return rule_based_fields

        llm = get_llm_provider()
        if not llm:
            logger.warning("LLM provider not available")
            return rule_based_fields

        system_prompt = prompt_data.get('system_prompt', '')
        user_prompt_template = prompt_data.get('user_prompt_template', '')

        llm_fields = await llm.enhance_fields(
            ocr_text=ocr_text,
            rule_based_fields=rule_based_fields,
            system_prompt=system_prompt,
            user_prompt_template=user_prompt_template,
        )

        if not llm_fields:
            logger.warning("LLM enhancement failed, using rule-based")
            return rule_based_fields

        enhanced_fields = self._merge_fields(rule_based_fields, llm_fields, prompt_data)
        logger.info("LLM enhancement successful")
        return enhanced_fields

    def _should_enhance(
        self,
        fields: Dict[str, Any],
        ocr_confidence: float,
    ) -> tuple:
        """Determine if LLM enhancement is needed. Returns (needs_enhancement, reasons)."""
        reasons = []

        field_confidences = [
            fields.get(field, {}).get('confidence', 0)
            for field in self.CRITICAL_FIELDS
            if fields.get(field, {}).get('value') is not None
        ]

        if not field_confidences:
            reasons.append("No fields extracted")
            return True, reasons

        avg_field_confidence = sum(field_confidences) / len(field_confidences)
        overall_confidence = (avg_field_confidence * 0.7) + (ocr_confidence * 0.3)

        if overall_confidence < self.OVERALL_CONFIDENCE_THRESHOLD:
            reasons.append(f"Overall confidence low ({overall_confidence:.2f})")

        for field in self.CRITICAL_FIELDS:
            field_data = fields.get(field, {})
            field_conf = field_data.get('confidence', 0)
            field_value = field_data.get('value')
            if field_value is None or field_conf < self.CRITICAL_FIELD_THRESHOLD:
                reasons.append(f"{field} unclear (conf: {field_conf:.2f})")

        category_conf = fields.get('category', {}).get('confidence', 0)
        if category_conf < self.CATEGORY_THRESHOLD:
            reasons.append(f"Category ambiguous (conf: {category_conf:.2f})")

        if len(reasons) > 0:
            return True, reasons

        if random.random() < self.sample_rate:
            reasons.append(f"Random sampling (high confidence validation, rate={self.sample_rate})")
            logger.info(f"Sampling high-confidence receipt (conf: {overall_confidence:.2f})")
            return True, reasons

        return False, []

    def _merge_fields(
        self,
        rule_based: Dict[str, Any],
        llm_enhanced: Dict[str, Any],
        prompt_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Merge rule-based and LLM fields; use LLM when it has higher confidence."""
        merged = {}
        for field_name in self.CRITICAL_FIELDS + ['location', 'cardLastFour', 'taxAmount', 'tipAmount']:
            rule_field = rule_based.get(field_name, {})
            rule_value = rule_field.get('value')
            rule_conf = rule_field.get('confidence', 0)

            llm_value = None
            llm_conf = 0.85

            if field_name in llm_enhanced:
                llm_data = llm_enhanced[field_name]
                if isinstance(llm_data, dict):
                    llm_value = llm_data.get('value')
                    llm_conf = llm_data.get('confidence', 0.85)
                else:
                    llm_value = llm_data

            if llm_value is not None and (rule_value is None or llm_conf > rule_conf):
                merged[field_name] = {'value': llm_value, 'confidence': round(llm_conf, 4), 'source': 'llm'}
            else:
                merged[field_name] = rule_field

        return merged

    # ------------------------------------------------------------------
    # Shared helpers
    # ------------------------------------------------------------------

    def _build_minimal_prompt(self, ocr_text: str, user_prompt_template: str) -> str:
        return user_prompt_template.replace("{ocr_text}", ocr_text)

    def _build_full_prompt(self, ocr_text: str, user_prompt_template: str, prompt_data: Dict[str, Any]) -> str:
        user_prompt = user_prompt_template.replace("{ocr_text}", ocr_text)
        examples = prompt_data.get('examples', [])
        if examples:
            user_prompt += "\n\nExamples:\n"
            for i, example in enumerate(examples[:5], 1):
                user_prompt += f"\nExample {i}:\n{json.dumps(example, indent=2)}\n"
        return user_prompt

    def _format_llm_fields(self, llm_fields: Dict[str, Any]) -> Dict[str, Any]:
        formatted = {}
        for field_name in ['merchant', 'amount', 'date', 'category', 'location',
                           'cardLastFour', 'taxAmount', 'tipAmount']:
            if field_name in llm_fields:
                field_data = llm_fields[field_name]
                if isinstance(field_data, dict):
                    formatted[field_name] = {
                        'value': field_data.get('value'),
                        'confidence': field_data.get('confidence', 0.85),
                        'source': 'llm',
                    }
                else:
                    formatted[field_name] = {'value': field_data, 'confidence': 0.85, 'source': 'llm'}
            else:
                formatted[field_name] = {'value': None, 'confidence': 0, 'source': 'llm'}
        return formatted

    def _fallback_to_rule_based(self, ocr_text: str, ocr_confidence: float) -> Dict[str, Any]:
        logger.info("Using rule-based extraction as fallback")
        return field_inference_engine.infer_fields(ocr_text, ocr_confidence)


# Singleton instance
llm_enhancement_engine = LLMEnhancementEngine()
