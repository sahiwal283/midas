"""
Receipt Complexity Analyzer

Analyzes OCR results to determine receipt complexity and select appropriate prompt tier.
Used for two-tier prompt system: simple receipts use minimal prompt, complex receipts use full prompt.
"""

import re
from typing import Dict, Any
from app.utils.logger import setup_logger

logger = setup_logger(__name__)


class ReceiptComplexityAnalyzer:
    """
    Analyzes receipt complexity to determine prompt tier
    
    Complexity factors:
    1. OCR confidence (most important)
    2. Text length (very short or very long = complex)
    3. Missing critical fields (amount, date, merchant)
    4. Unusual characters (poor OCR quality indicator)
    5. Line count (layout complexity)
    6. Ambiguous patterns (unusual formats)
    """
    
    # Complexity threshold for prompt tier selection
    COMPLEXITY_THRESHOLD = 0.4
    
    # Ambiguous patterns that indicate complexity
    AMBIGUOUS_PATTERNS = [
        r'[A-Z]{2,}\s+\d+',  # State codes + numbers
        r'\$\d+\.\d{3}',  # Amounts with 3 decimals (unusual)
    ]
    
    def analyze(self, ocr_result: Dict[str, Any], ocr_text: str) -> Dict[str, Any]:
        """
        Analyze receipt and return complexity metrics
        
        Args:
            ocr_result: OCR result dictionary with 'confidence' key
            ocr_text: Raw OCR text
        
        Returns:
            Dictionary with:
            - complexity_score: float (0.0 = simple, 1.0 = complex)
            - is_complex: bool (True if >= threshold)
            - tier: str ('simple' or 'complex')
            - factors: dict with individual factor values
        """
        complexity_score = self._calculate_complexity(ocr_result, ocr_text)
        is_complex = complexity_score >= self.COMPLEXITY_THRESHOLD
        
        return {
            "complexity_score": round(complexity_score, 4),
            "is_complex": is_complex,
            "tier": "complex" if is_complex else "simple",
            "factors": {
                "ocr_confidence": ocr_result.get('confidence', 0.0),
                "text_length": len(ocr_text),
                "missing_fields": self._count_missing_fields(ocr_text),
                "unusual_chars": self._count_unusual_chars(ocr_text),
                "line_count": len([l for l in ocr_text.split('\n') if l.strip()])
            }
        }
    
    def _calculate_complexity(self, ocr_result: Dict[str, Any], ocr_text: str) -> float:
        """
        Calculate complexity score (0.0 = simple, 1.0 = complex)
        
        Uses 6 factors with weighted average:
        - OCR confidence (weight: 0.3) - most important
        - Text length (weight: 0.15)
        - Missing fields (weight: 0.25)
        - Unusual characters (weight: 0.15)
        - Line count (weight: 0.1)
        - Ambiguous patterns (weight: 0.05)
        """
        complexity_factors = []
        
        # Factor 1: OCR Confidence (0-1)
        # Low confidence = complex
        ocr_confidence = ocr_result.get('confidence', 0.5)
        complexity_factors.append(1.0 - ocr_confidence)  # Invert: low conf = high complexity
        
        # Factor 2: Text Length (normalized)
        text_length = len(ocr_text)
        if text_length < 50:  # Too short, might be missing info
            complexity_factors.append(0.8)
        elif text_length > 2000:  # Very long, might be multi-page or complex
            complexity_factors.append(0.6)
        else:
            complexity_factors.append(0.2)  # Normal length = simple
        
        # Factor 3: Missing Critical Fields (from quick scan)
        missing_fields = self._count_missing_fields(ocr_text)
        complexity_factors.append(missing_fields * 0.3)  # Each missing field = +0.3 complexity
        
        # Factor 4: Unusual Characters (poor OCR quality indicator)
        unusual_chars = self._count_unusual_chars(ocr_text)
        unusual_ratio = unusual_chars / max(len(ocr_text), 1)
        complexity_factors.append(min(unusual_ratio * 10, 1.0))  # Cap at 1.0
        
        # Factor 5: Line Count (layout complexity)
        line_count = len([l for l in ocr_text.split('\n') if l.strip()])
        if line_count < 3:  # Too few lines = might be incomplete
            complexity_factors.append(0.7)
        elif line_count > 30:  # Many lines = complex layout
            complexity_factors.append(0.5)
        else:
            complexity_factors.append(0.1)  # Normal = simple
        
        # Factor 6: Ambiguous Patterns
        ambiguous_count = sum(
            1 for pattern in self.AMBIGUOUS_PATTERNS 
            if re.search(pattern, ocr_text)
        )
        complexity_factors.append(ambiguous_count * 0.2)
        
        # Calculate weighted average
        weights = [0.3, 0.15, 0.25, 0.15, 0.1, 0.05]  # OCR confidence most important
        complexity_score = sum(f * w for f, w in zip(complexity_factors, weights))
        
        return min(complexity_score, 1.0)  # Cap at 1.0
    
    def _count_missing_fields(self, ocr_text: str) -> int:
        """
        Count missing critical fields (amount, date, merchant)
        
        Returns:
            Number of missing fields (0-3)
        """
        has_amount = bool(re.search(r'\$?\d+\.?\d{0,2}', ocr_text))
        has_date = bool(re.search(r'\d{1,2}[/-]\d{1,2}[/-]\d{2,4}', ocr_text))
        has_merchant = len([line for line in ocr_text.split('\n')[:3] if line.strip()]) > 0
        
        missing = sum([not has_amount, not has_date, not has_merchant])
        return missing
    
    def _count_unusual_chars(self, ocr_text: str) -> int:
        """
        Count unusual characters (indicators of poor OCR quality)
        
        Returns:
            Number of unusual characters
        """
        # Match characters that are not: word chars, whitespace, common punctuation
        unusual_chars = re.findall(r'[^\w\s\$\.\,\:\-\(\)\/]', ocr_text)
        return len(unusual_chars)


# Singleton instance
complexity_analyzer = ReceiptComplexityAnalyzer()


