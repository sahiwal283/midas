#!/usr/bin/env python3
"""
PDF Receipt Processor with EasyOCR Integration

Converts PDF receipts to images and runs EasyOCR on each page.
Supports both single-page and multi-page PDFs.

Usage:
    python3 pdf_processor.py <pdf_path> [--dpi 300] [--lang en] [--gpu false]
"""

import sys
import json
import argparse
import tempfile
import warnings
from pathlib import Path
from typing import Dict, List

# Suppress warnings
warnings.filterwarnings('ignore')

try:
    from pdf2image import convert_from_path
    import pytesseract
    import cv2
    import numpy as np
except ImportError as e:
    print(json.dumps({
        "success": False,
        "error": f"Missing dependency: {str(e)}. Install: pip install pdf2image pytesseract",
        "text": "",
        "confidence": 0.0,
        "provider": "tesseract-pdf",
        "pages": []
    }))
    sys.exit(1)


class PDFProcessor:
    """PDF to Image converter with OCR"""
    
    def __init__(self, languages: List[str] = ['en'], gpu: bool = False, dpi: int = 300, max_pages: int = 2):
        """
        Initialize PDF processor with EasyOCR
        
        Args:
            languages: List of language codes for OCR
            gpu: Whether to use GPU acceleration
            dpi: DPI for PDF to image conversion (higher = better quality, slower)
        """
        self.dpi = dpi
        self.languages = languages
        self.max_pages = max_pages
        
        self.lang_string = '+'.join(languages) if languages else 'eng'
        print(
            f"[PDF-OCR] Initializing Tesseract with languages: {self.lang_string}, DPI: {dpi}",
            file=sys.stderr
        )

    @staticmethod
    def normalize_languages(languages: List[str]) -> List[str]:
        """Map common OCR language aliases to Tesseract language codes."""
        language_aliases = {
            'en': 'eng',
            'es': 'spa',
            'fr': 'fra',
            'de': 'deu',
            'it': 'ita',
            'pt': 'por',
            'nl': 'nld',
            'ru': 'rus',
            'ja': 'jpn',
            'ko': 'kor',
            'ch_sim': 'chi_sim',
            'ch_tra': 'chi_tra'
        }

        normalized = []
        for lang in languages:
            clean_lang = lang.strip().lower()
            mapped = language_aliases.get(clean_lang, clean_lang)
            if mapped:
                normalized.append(mapped)

        return normalized or ['eng']
    
    def convert_pdf_to_images(self, pdf_path: str) -> List[np.ndarray]:
        """
        Convert PDF pages to images
        
        Args:
            pdf_path: Path to PDF file
            
        Returns:
            List of images (one per page) as numpy arrays
        """
        try:
            # Convert PDF to images (one per page)
            # Uses poppler under the hood
            pil_images = convert_from_path(
                pdf_path,
                dpi=self.dpi,
                fmt='png',
                first_page=1,
                last_page=max(1, self.max_pages),
                thread_count=2  # Parallel processing for multi-page PDFs
            )
            
            # Convert PIL images to OpenCV format (numpy arrays)
            cv_images = []
            for pil_img in pil_images:
                # Convert PIL to numpy array
                img_array = np.array(pil_img)
                
                # Convert RGB to BGR (OpenCV format)
                if len(img_array.shape) == 3 and img_array.shape[2] == 3:
                    img_array = cv2.cvtColor(img_array, cv2.COLOR_RGB2BGR)
                
                cv_images.append(img_array)
            
            print(f"[PDF-OCR] Converted {len(cv_images)} pages from PDF", file=sys.stderr)
            return cv_images
            
        except Exception as e:
            print(f"[PDF-OCR] Error converting PDF: {str(e)}", file=sys.stderr)
            raise
    
    def preprocess_image(self, image: np.ndarray) -> np.ndarray:
        """
        Preprocess image for better OCR accuracy
        
        Args:
            image: Image as numpy array
            
        Returns:
            Preprocessed image
        """
        # Convert to grayscale if color
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image
        
        # Denoise
        denoised = cv2.bilateralFilter(gray, 9, 75, 75)
        
        # Adaptive threshold for text enhancement
        enhanced = cv2.adaptiveThreshold(
            denoised,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            11,
            2
        )
        
        return enhanced
    
    def extract_text_from_image(self, image: np.ndarray, page_num: int) -> Dict:
        """
        Extract text from a single page image
        
        Args:
            image: Image as numpy array
            page_num: Page number (1-indexed)
            
        Returns:
            Dictionary with extracted text and metadata
        """
        try:
            # Preprocess
            preprocessed = self.preprocess_image(image)
            
            # Run Tesseract with TSV output for confidence metrics.
            data = pytesseract.image_to_data(
                preprocessed,
                lang=self.lang_string,
                config='--psm 6',
                output_type=pytesseract.Output.DICT
            )
            
            # Parse results
            text_lines = []
            confidences = []
            
            for i in range(len(data.get('text', []))):
                text = data['text'][i].strip()
                conf_raw = data['conf'][i]
                try:
                    confidence = float(conf_raw)
                except (TypeError, ValueError):
                    confidence = -1

                if text and confidence >= 0:
                    text_lines.append(text)
                    confidences.append(confidence / 100.0)
            
            # Combine text
            full_text = '\n'.join(text_lines)
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
            
            return {
                "page": page_num,
                "text": full_text,
                "confidence": round(avg_confidence, 4),
                "line_count": len(text_lines),
                "lines": [
                    {"text": text, "confidence": round(conf, 4)}
                    for text, conf in zip(text_lines, confidences)
                ]
            }
            
        except Exception as e:
            return {
                "page": page_num,
                "text": "",
                "confidence": 0.0,
                "error": str(e),
                "line_count": 0,
                "lines": []
            }
    
    def process_pdf(self, pdf_path: str) -> Dict:
        """
        Process entire PDF (all pages)
        
        Args:
            pdf_path: Path to PDF file
            
        Returns:
            Dictionary with combined results from all pages
        """
        try:
            # Convert PDF to images
            images = self.convert_pdf_to_images(pdf_path)
            
            if not images:
                return {
                    "success": False,
                    "error": "Failed to convert PDF to images (0 pages extracted)",
                    "text": "",
                    "confidence": 0.0,
                    "provider": "tesseract-pdf",
                    "pages": []
                }
            
            # Process each page
            page_results = []
            all_text = []
            all_confidences = []
            
            for i, image in enumerate(images, start=1):
                print(f"[PDF-OCR] Processing page {i}/{len(images)}", file=sys.stderr)
                
                page_result = self.extract_text_from_image(image, i)
                page_results.append(page_result)
                
                if page_result.get('text'):
                    all_text.append(f"--- Page {i} ---")
                    all_text.append(page_result['text'])
                    all_confidences.append(page_result.get('confidence', 0.0))
            
            # Combine all pages
            combined_text = '\n\n'.join(all_text)
            avg_confidence = sum(all_confidences) / len(all_confidences) if all_confidences else 0.0
            
            return {
                "success": True,
                "text": combined_text,
                "confidence": round(avg_confidence, 4),
                "provider": "tesseract-pdf",
                "page_count": len(images),
                "pages": page_results,
                "metadata": {
                    "dpi": self.dpi,
                    "languages": self.languages,
                    "engine": "tesseract"
                }
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "text": "",
                "confidence": 0.0,
                "provider": "tesseract-pdf",
                "pages": []
            }


def main():
    """Main entry point for command-line usage"""
    parser = argparse.ArgumentParser(description='PDF Receipt Processor with EasyOCR')
    parser.add_argument('pdf_path', help='Path to PDF receipt')
    parser.add_argument('--dpi', type=int, default=300, help='DPI for conversion (default: 300)')
    parser.add_argument('--lang', default='en', help='Language code (default: en)')
    parser.add_argument('--max-pages', type=int, default=2, help='Max pages to process in fallback mode')
    parser.add_argument('--gpu', default='false', help='Use GPU (default: false)')
    
    args = parser.parse_args()
    
    # Validate PDF exists
    if not Path(args.pdf_path).exists():
        print(json.dumps({
            "success": False,
            "error": f"PDF not found: {args.pdf_path}",
            "text": "",
            "confidence": 0.0,
            "provider": "tesseract-pdf",
            "pages": []
        }))
        sys.exit(1)
    
    # Parse arguments
    raw_languages = [lang.strip() for lang in args.lang.split(',')]
    languages = PDFProcessor.normalize_languages(raw_languages)
    use_gpu = args.gpu.lower() in ('true', '1', 'yes')
    
    # Initialize processor
    try:
        processor = PDFProcessor(
            languages=languages,
            gpu=use_gpu,
            dpi=args.dpi,
            max_pages=max(1, args.max_pages)
        )
        
        # Process PDF
        result = processor.process_pdf(args.pdf_path)
        
        # Output JSON result
        print(json.dumps(result, indent=2))
        
        # Exit with appropriate code
        sys.exit(0 if result.get('success', False) else 1)
        
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": f"Processor initialization failed: {str(e)}",
            "text": "",
            "confidence": 0.0,
            "provider": "tesseract-pdf",
            "pages": []
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()

