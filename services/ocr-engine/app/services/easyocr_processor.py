#!/usr/bin/env python3
"""
EasyOCR Processor for Receipt Image Analysis

This script uses EasyOCR for high-accuracy text extraction from receipt images.
EasyOCR supports 80+ languages and works well with complex receipt layouts.

Key advantages over Tesseract/PaddleOCR:
- Better accuracy on real-world receipts with varied fonts/layouts
- No AVX2 requirement (CPU compatible)
- Strong performance on skewed/rotated text
- Built-in text detection and recognition

Usage:
    python3 easyocr_processor.py <image_path> [--lang en] [--gpu false]
"""

import sys
import os
import json
import argparse
import warnings
from pathlib import Path
from typing import Dict, List, Tuple

# Set EasyOCR cache directory explicitly BEFORE importing easyocr
os.environ['EASYOCR_MODULE_PATH'] = os.environ.get('EASYOCR_MODULE_PATH', '/var/lib/expenseapp/.EasyOCR')
os.environ['HOME'] = os.environ.get('HOME', '/var/lib/expenseapp')

# Disable PyTorch CPU optimizations that require AVX2 (for older CPUs like Sandy Bridge)
# These settings prevent SIGILL (Illegal Instruction) errors on older hardware
os.environ['MKL_THREADING_LAYER'] = 'GNU'
os.environ['MKL_SERVICE_FORCE_INTEL'] = '0'
os.environ['OMP_NUM_THREADS'] = '1'
os.environ['PYTORCH_NNPACK_DISABLE'] = '1'

# Suppress warnings
warnings.filterwarnings('ignore')

try:
    import easyocr
    import cv2
    import numpy as np
except ImportError as e:
    print(json.dumps({
        "success": False,
        "error": f"Missing dependency: {str(e)}",
        "text": "",
        "confidence": 0.0,
        "provider": "easyocr"
    }))
    sys.exit(1)


class ReceiptPreprocessor:
    """Image preprocessing for optimal OCR accuracy"""
    
    @staticmethod
    def preprocess(image_path: str) -> np.ndarray:
        """
        Apply preprocessing steps to enhance OCR accuracy:
        - Resize if too large (memory optimization)
        - Convert to grayscale
        - Denoise with bilateral filter
        - Adaptive threshold for text enhancement
        - Deskew if rotated
        
        Args:
            image_path: Path to receipt image
            
        Returns:
            Preprocessed image as numpy array
        """
        # Read image
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Failed to load image: {image_path}")
        
        # Resize if too large (max 2000px on longest side)
        height, width = img.shape[:2]
        max_dim = 2000
        if max(height, width) > max_dim:
            scale = max_dim / max(height, width)
            new_width = int(width * scale)
            new_height = int(height * scale)
            img = cv2.resize(img, (new_width, new_height), interpolation=cv2.INTER_AREA)
        
        # Convert to grayscale
        if len(img.shape) == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        else:
            gray = img
        
        # Denoise (preserve edges)
        denoised = cv2.bilateralFilter(gray, 9, 75, 75)
        
        # Adaptive threshold for text enhancement
        # This works better than global threshold for receipts with uneven lighting
        enhanced = cv2.adaptiveThreshold(
            denoised,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            11,
            2
        )
        
        # Optional: Deskew (detect and correct rotation)
        # For now, EasyOCR handles rotation well, so we skip this
        # Can add deskewing if needed for specific receipt types
        
        return enhanced


class EasyOCRProcessor:
    """EasyOCR-based receipt text extraction"""
    
    def __init__(self, languages: List[str] = ['en'], gpu: bool = False):
        """
        Initialize EasyOCR reader
        
        Args:
            languages: List of language codes (e.g., ['en', 'es'])
            gpu: Whether to use GPU acceleration (requires CUDA)
        """
        print(f"[EasyOCR] Initializing with languages: {languages}, GPU: {gpu}", file=sys.stderr)
        
        # Initialize reader (downloads models on first run)
        self.reader = easyocr.Reader(
            languages,
            gpu=gpu,
            model_storage_directory='/tmp/easyocr_models',  # Cache models
            download_enabled=True,
            verbose=False
        )
        
        print("[EasyOCR] Reader initialized successfully", file=sys.stderr)
    
    def extract_text(self, image_path: str, preprocess: bool = True) -> Dict:
        """
        Extract text from receipt image using EasyOCR
        
        Args:
            image_path: Path to receipt image
            preprocess: Whether to apply preprocessing
            
        Returns:
            Dictionary with extracted text, confidence, and metadata
        """
        try:
            # Preprocess image if requested
            if preprocess:
                image = ReceiptPreprocessor.preprocess(image_path)
            else:
                image = cv2.imread(image_path)
            
            # Run EasyOCR
            # Returns list of ([bbox], text, confidence)
            results = self.reader.readtext(
                image,
                detail=1,  # Return bounding boxes and confidence
                paragraph=False,  # Return line by line
                min_size=10,  # Minimum text box size
                text_threshold=0.7,  # Confidence threshold for text detection
                low_text=0.4,  # Lower bound for text detection
                link_threshold=0.4,  # Threshold for linking text boxes
                canvas_size=2560,  # Canvas size for detection
                mag_ratio=1.5  # Magnification ratio
            )
            
            # Parse results
            text_lines = []
            confidences = []
            
            for bbox, text, confidence in results:
                if text.strip():  # Skip empty detections
                    text_lines.append(text.strip())
                    confidences.append(confidence)
            
            # Combine all text
            full_text = '\n'.join(text_lines)
            
            # Calculate average confidence
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
            
            # Build structured response
            return {
                "success": True,
                "text": full_text,
                "confidence": round(avg_confidence, 4),
                "provider": "easyocr",
                "line_count": len(text_lines),
                "lines": [
                    {
                        "text": text,
                        "confidence": round(conf, 4)
                    }
                    for text, conf in zip(text_lines, confidences)
                ],
                "metadata": {
                    "preprocessed": preprocess,
                    "detection_count": len(results)
                }
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "text": "",
                "confidence": 0.0,
                "provider": "easyocr"
            }


def main():
    """Main entry point for command-line usage"""
    parser = argparse.ArgumentParser(description='EasyOCR Receipt Processor')
    parser.add_argument('image_path', help='Path to receipt image')
    parser.add_argument('--lang', default='en', help='Language code (default: en)')
    parser.add_argument('--gpu', default='false', help='Use GPU (default: false)')
    parser.add_argument('--preprocess', default='true', help='Apply preprocessing (default: true)')
    
    args = parser.parse_args()
    
    # Validate image exists
    if not Path(args.image_path).exists():
        print(json.dumps({
            "success": False,
            "error": f"Image not found: {args.image_path}",
            "text": "",
            "confidence": 0.0,
            "provider": "easyocr"
        }))
        sys.exit(1)
    
    # Parse arguments
    languages = [lang.strip() for lang in args.lang.split(',')]
    use_gpu = args.gpu.lower() in ('true', '1', 'yes')
    do_preprocess = args.preprocess.lower() in ('true', '1', 'yes')
    
    # Initialize processor
    try:
        processor = EasyOCRProcessor(languages=languages, gpu=use_gpu)
        
        # Extract text
        result = processor.extract_text(args.image_path, preprocess=do_preprocess)
        
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
            "provider": "easyocr"
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()

