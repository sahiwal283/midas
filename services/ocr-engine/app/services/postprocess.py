"""
Postprocessing and Field Inference - FALLBACK ONLY

⚠️ IMPORTANT: This module is now used as FALLBACK ONLY when LLM extraction fails.

Primary extraction flow: OCR → LLM (direct extraction)
Fallback flow: OCR → LLM fails → Rule-based (this module)

This module extracts structured fields from OCR text using regex patterns and 
rule-based inference. It is only called when:
1. LLM extraction is disabled (ENABLE_LLM_INFERENCE=false)
2. LLM extraction fails (timeout, error, etc.)
3. LLM provider is unavailable

The `suggest_categories()` method is still used for category suggestions as a 
supplementary feature, but field extraction should always use LLM first.

Migrated from Expense App RuleBasedInferenceEngine.
"""

import re
from typing import Dict, List, Any

try:
    from app.utils.logger import setup_logger
    logger = setup_logger(__name__)
except ImportError:
    # Allows importing the extraction rules standalone (e.g. eval harness)
    # without the service's config stack (pydantic_settings etc.).
    import logging
    logger = logging.getLogger(__name__)

from app.services import extraction_rules


def _keyword_matches_in_text(text_lower: str, keyword: str) -> bool:
    """
    Match a category keyword as a whole word/phrase to avoid false positives
    (e.g. 'gas' matching inside 'Las Vegas', 'mobil' inside 'mobile').
    """
    kw = keyword.strip().lower()
    if not kw:
        return False
    if " " in kw or "-" in kw:
        return kw in text_lower
    return bool(re.search(rf"(?<![a-z0-9]){re.escape(kw)}(?![a-z0-9])", text_lower))


class FieldInferenceEngine:
    """
    Extract structured fields from OCR text
    
    Supported fields:
    - merchant: Business name
    - amount: Transaction total
    - date: Transaction date
    - cardLastFour: Last 4 digits of payment card
    - category: Expense category
    - location: Address/location
    - taxAmount: Tax amount
    - tipAmount: Tip/gratuity amount
    """
    
    # Category keywords with weights
    CATEGORY_KEYWORDS = {
        'Booth / Marketing / Tools': {
            'keywords': ['booth', 'display', 'banner', 'signage', 'marketing', 'promotion', 'brochure', 'flyer', 'tools', 'equipment'],
            'weight': 1.0
        },
        'Travel - Flight': {
            'keywords': ['airline', 'airways', 'flight', 'aviation', 'airport', 'boarding', 'departure', 'arrival'],
            'weight': 1.0
        },
        'Accommodation - Hotel': {
            'keywords': ['hotel', 'motel', 'inn', 'resort', 'marriott', 'hilton', 'hyatt', 'holiday inn', 'best western', 'lodging', 'accommodation', 'night', 'stay'],
            'weight': 1.0
        },
        'Transportation - Uber / Lyft / Others': {
            'keywords': ['uber', 'uberx', 'lyft', 'taxi', 'cab', 'rideshare', 'ride-share', 'ride with', 'transport', 'your ride', 'trip with', 'pickup', 'drop-off', 'dropoff', 'driver'],
            'weight': 1.0
        },
        'Parking Fees': {
            'keywords': ['parking', 'parked', 'valet', 'parking garage', 'parking fee', 'park fee'],
            'weight': 1.0
        },
        'Rental - Car / U-haul': {
            'keywords': ['rental', 'hertz', 'enterprise', 'avis', 'budget', 'u-haul', 'uhaul', 'car hire', 'vehicle rental'],
            'weight': 1.0
        },
        'Meal and Entertainment': {
            'keywords': [
                'restaurant', 'cafe', 'coffee', 'diner', 'bistro', 'grill', 'kitchen', 'bar', 'pub',
                'food', 'dining', 'breakfast', 'lunch', 'dinner', 'meal', 'entertainment',
                'bagel', 'deli', 'bakery', 'cappuccino', 'espresso', 'sandwich', 'catering',
                'starbucks',
            ],
            'weight': 1.0
        },
        'Gas / Fuel': {
            'keywords': ['gas', 'fuel', 'gasoline', 'diesel', 'petrol', 'shell', 'bp', 'exxon', 'chevron', 'mobil'],
            'weight': 1.0
        },
        'Show Allowances - Per Diem': {
            'keywords': ['per diem', 'allowance', 'daily allowance', 'show allowance'],
            'weight': 1.0
        },
        'Model': {
            'keywords': ['model', 'talent', 'contractor', 'appearance'],
            'weight': 1.0
        },
        'Shipping Charges': {
            'keywords': ['shipping', 'freight', 'delivery', 'courier', 'fedex', 'ups', 'usps', 'dhl'],
            'weight': 1.0
        },
        'Other': {
            'keywords': ['misc', 'miscellaneous', 'other'],
            'weight': 0.5
        }
    }
    
    def infer_fields(self, ocr_text: str, ocr_confidence: float) -> Dict[str, Any]:
        """
        Extract all fields from OCR text - FALLBACK ONLY
        
        ⚠️ This method is only called when LLM extraction fails or is disabled.
        It should NOT be called directly from the OCR route. The normal flow is:
        OCR → LLM extraction → (fallback to this only if LLM fails)
        
        Called from: `llm_enhancement._fallback_to_rule_based()`
        
        Args:
            ocr_text: Raw OCR text
            ocr_confidence: OCR confidence score (0-1)
        
        Returns:
            Dictionary with inferred fields
        """
        logger.warning("Using rule-based field inference (FALLBACK - LLM extraction failed or disabled)")
        logger.info("Starting field inference...")
        
        lines = [line.strip() for line in ocr_text.split('\n') if line.strip()]
        text_lower = ocr_text.lower()
        
        return {
            'merchant': self._extract_merchant(lines, ocr_confidence),
            'amount': self._extract_amount(ocr_text, text_lower, ocr_confidence),
            'date': self._extract_date(ocr_text, ocr_confidence),
            'cardLastFour': self._extract_card_last_four(ocr_text, ocr_confidence),
            'category': self._predict_category(text_lower, ocr_confidence),
            'location': self._extract_location(ocr_text, ocr_confidence),
            'taxAmount': self._extract_tax_amount(ocr_text, ocr_confidence),
            'tipAmount': self._extract_tip_amount(ocr_text, ocr_confidence)
        }
    
    def suggest_categories(self, ocr_text: str, ocr_confidence: float, top_n: int = 3) -> List[Dict[str, Any]]:
        """
        Suggest multiple possible categories
        
        Note: This method is still actively used for category suggestions as a 
        supplementary feature alongside LLM extraction. It provides rule-based 
        category suggestions that complement LLM-extracted categories.
        
        Args:
            ocr_text: Raw OCR text
            ocr_confidence: OCR confidence score
            top_n: Number of suggestions to return
        
        Returns:
            List of category suggestions with confidence scores
        """
        text_lower = ocr_text.lower()
        suggestions = []
        
        for category, data in self.CATEGORY_KEYWORDS.items():
            keywords = data['keywords']
            weight = data['weight']
            
            matched_keywords = [kw for kw in keywords if _keyword_matches_in_text(text_lower, kw)]
            
            if matched_keywords:
                match_score = len(matched_keywords) / len(keywords)
                confidence = min((0.5 + match_score * 0.4) * weight * ocr_confidence, 0.95)
                
                suggestions.append({
                    'category': category,
                    'confidence': round(confidence, 4),
                    'keywords': matched_keywords,
                    'source': 'rule-based'
                })
        
        # Sort by confidence and return top N
        suggestions.sort(key=lambda x: x['confidence'], reverse=True)
        return suggestions[:top_n]
    
    def _extract_merchant(self, lines: List[str], ocr_confidence: float) -> Dict[str, Any]:
        """Extract merchant name (known brands, then receipt-header line scoring)"""
        result = extraction_rules.extract_merchant(lines, ocr_confidence)
        if result['value']:
            logger.info(f"Merchant: {result['value']} (confidence: {result['confidence']})")
        return result

    def _extract_amount(self, text: str, text_lower: str, ocr_confidence: float) -> Dict[str, Any]:
        """Extract transaction amount (labeled totals ranked over bare amounts)"""
        result = extraction_rules.extract_amount(text, ocr_confidence)
        if result['value']:
            logger.info(f"Amount: ${result['value']:.2f} (confidence: {result['confidence']})")
        return result

    def _extract_date(self, text: str, ocr_confidence: float) -> Dict[str, Any]:
        """Extract and normalize date to ISO format"""
        result = extraction_rules.extract_date(text, ocr_confidence)
        if result['value']:
            logger.info(f"Date: {result['value']} (confidence: {result['confidence']})")
        return result

    def _extract_card_last_four(self, text: str, ocr_confidence: float) -> Dict[str, Any]:
        """Extract last 4 digits of payment card"""
        patterns = [
            (r'\*+(\d{4})', 0.9),
            (r'x{4,}(\d{4})', 0.9),
            (r'ending\s+(?:in\s+)?(\d{4})', 0.95),
            (r'(?:visa|mastercard|amex|discover)\s+\*+(\d{4})', 1.0),
        ]
        
        for pattern, pattern_conf in patterns:
            match = re.search(pattern, text, re.I)
            if match:
                last_four = match.group(1)
                confidence = min(pattern_conf * ocr_confidence, 0.98)
                logger.info(f"Card: ****{last_four}")
                return {
                    'value': last_four,
                    'confidence': round(confidence, 4),
                    'source': 'inference'
                }
        
        return {'value': None, 'confidence': 0, 'source': 'inference'}
    
    def _predict_category(self, text_lower: str, ocr_confidence: float) -> Dict[str, Any]:
        """Predict expense category (weighted keyword-occurrence scoring)"""
        result = extraction_rules.predict_category(text_lower, ocr_confidence)
        if result['value']:
            logger.info(f"Category: {result['value']} (confidence: {result['confidence']})")
        return result
    
    def _extract_location(self, text: str, ocr_confidence: float) -> Dict[str, Any]:
        """Extract location/address"""
        patterns = [
            (r'[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?', 0.95),
            (r'[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}\b', 0.85),
        ]
        
        for pattern, pattern_conf in patterns:
            match = re.search(pattern, text)
            if match:
                location = match.group(0).strip()
                confidence = min(pattern_conf * ocr_confidence, 0.98)
                logger.info(f"Location: {location}")
                return {
                    'value': location,
                    'confidence': round(confidence, 4),
                    'source': 'inference'
                }
        
        return {'value': None, 'confidence': 0, 'source': 'inference'}
    
    def _extract_tax_amount(self, text: str, ocr_confidence: float) -> Dict[str, Any]:
        """Extract tax amount"""
        patterns = [
            r'tax[\s:]*\$?\s*(\d+[.,]\d{2})',
            r'sales\s+tax[\s:]*\$?\s*(\d+[.,]\d{2})'
        ]
        
        for pattern in patterns:
            match = re.search(pattern, text, re.I)
            if match:
                amount = float(match.group(1).replace(',', '.'))
                if 0 <= amount <= 10000:
                    confidence = min(0.85 * ocr_confidence, 0.90)
                    return {
                        'value': amount,
                        'confidence': round(confidence, 4),
                        'source': 'inference'
                    }
        
        return {'value': None, 'confidence': 0, 'source': 'inference'}
    
    def _extract_tip_amount(self, text: str, ocr_confidence: float) -> Dict[str, Any]:
        """Extract tip/gratuity amount"""
        patterns = [
            r'tip[\s:]*\$?\s*(\d+[.,]\d{2})',
            r'gratuity[\s:]*\$?\s*(\d+[.,]\d{2})'
        ]
        
        for pattern in patterns:
            match = re.search(pattern, text, re.I)
            if match:
                amount = float(match.group(1).replace(',', '.'))
                if 0 <= amount <= 10000:
                    confidence = min(0.85 * ocr_confidence, 0.90)
                    return {
                        'value': amount,
                        'confidence': round(confidence, 4),
                        'source': 'inference'
                    }
        
        return {'value': None, 'confidence': 0, 'source': 'inference'}


# Singleton instance
field_inference_engine = FieldInferenceEngine()

