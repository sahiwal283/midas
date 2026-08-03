#!/usr/bin/env python3
"""
Advanced Tesseract OCR Processor for Receipt Processing

Optimized for maximum accuracy on receipts and invoices through:
- Advanced OpenCV preprocessing (denoise, deskew, adaptive threshold, DPI normalization)
- Custom Tesseract configurations (PSM modes, character whitelists)
- Structured output with confidence metrics

Hardware: Optimized for Sandy Bridge CPUs (AVX-only, no AVX2)
"""

import sys
import os
import json
import argparse
import subprocess
import warnings
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import tempfile

# Suppress warnings
warnings.filterwarnings('ignore')

try:
    import cv2
    import numpy as np
    from PIL import Image
    import pytesseract
except ImportError as e:
    print(json.dumps({
        "success": False,
        "error": f"Missing dependency: {str(e)}",
        "text": "",
        "confidence": 0.0,
        "provider": "tesseract"
    }))
    sys.exit(1)


class AdvancedImagePreprocessor:
    """
    Advanced image preprocessing optimized for receipt OCR
    
    Implements best practices:
    - DPI normalization (300 DPI target)
    - Noise reduction (bilateral filter, morphology)
    - Deskewing (rotation correction)
    - Adaptive thresholding (binarization)
    - Edge cropping (remove dark borders)
    - Contrast enhancement
    """
    
    def __init__(self, target_dpi: int = 300):
        self.target_dpi = target_dpi
        
    def normalize_dpi(self, image: np.ndarray, current_dpi: int = 72) -> np.ndarray:
        """Resize image to target DPI for optimal OCR"""
        if current_dpi == self.target_dpi:
            return image
            
        scale_factor = self.target_dpi / current_dpi
        if scale_factor == 1.0:
            return image
            
        height, width = image.shape[:2]
        new_width = int(width * scale_factor)
        new_height = int(height * scale_factor)
        
        print(f"[Preprocessor] Normalizing DPI: {current_dpi} -> {self.target_dpi} (scale: {scale_factor:.2f}x)", file=sys.stderr)
        return cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_CUBIC)
    
    def denoise(self, image: np.ndarray) -> np.ndarray:
        """Remove noise while preserving text edges"""
        print("[Preprocessor] Applying bilateral denoise filter...", file=sys.stderr)
        # Bilateral filter: reduces noise while keeping edges sharp
        denoised = cv2.bilateralFilter(image, 9, 75, 75)
        
        # Additional morphological noise reduction
        kernel = np.ones((1, 1), np.uint8)
        denoised = cv2.morphologyEx(denoised, cv2.MORPH_CLOSE, kernel)
        
        return denoised
    
    def deskew(self, image: np.ndarray) -> Tuple[np.ndarray, float]:
        """Correct image rotation/skew"""
        print("[Preprocessor] Detecting and correcting skew...", file=sys.stderr)
        
        # Convert to grayscale if needed
        gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        
        # Detect edges
        edges = cv2.Canny(gray, 50, 150, apertureSize=3)
        
        # Detect lines using Hough Transform
        lines = cv2.HoughLines(edges, 1, np.pi / 180, 200)
        
        if lines is None or len(lines) == 0:
            print("[Preprocessor] No skew detected", file=sys.stderr)
            return image, 0.0
        
        # Calculate average angle
        angles = []
        for line in lines[:min(50, len(lines))]:  # Use top 50 lines
            rho, theta = line[0]
            angle = np.degrees(theta) - 90
            if -45 < angle < 45:  # Filter out near-horizontal lines
                angles.append(angle)
        
        if not angles:
            return image, 0.0
        
        median_angle = np.median(angles)
        
        # Only deskew if angle is significant
        if abs(median_angle) < 0.5:
            print(f"[Preprocessor] Skew negligible: {median_angle:.2f}°", file=sys.stderr)
            return image, median_angle
        
        print(f"[Preprocessor] Correcting skew: {median_angle:.2f}°", file=sys.stderr)
        
        # Rotate image
        height, width = image.shape[:2]
        center = (width // 2, height // 2)
        rotation_matrix = cv2.getRotationMatrix2D(center, median_angle, 1.0)
        
        # Calculate new dimensions to avoid cropping
        cos = np.abs(rotation_matrix[0, 0])
        sin = np.abs(rotation_matrix[0, 1])
        new_width = int((height * sin) + (width * cos))
        new_height = int((height * cos) + (width * sin))
        
        rotation_matrix[0, 2] += (new_width / 2) - center[0]
        rotation_matrix[1, 2] += (new_height / 2) - center[1]
        
        deskewed = cv2.warpAffine(image, rotation_matrix, (new_width, new_height), 
                                   flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
        
        return deskewed, median_angle
    
    def adaptive_threshold(self, image: np.ndarray) -> np.ndarray:
        """Apply adaptive thresholding for binarization"""
        print("[Preprocessor] Applying adaptive thresholding...", file=sys.stderr)
        
        # Convert to grayscale if needed
        gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        
        # Apply adaptive threshold
        binary = cv2.adaptiveThreshold(
            gray, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            11,  # Block size
            2    # Constant subtracted from mean
        )
        
        # Check if image is inverted (more white pixels than black)
        # Tesseract expects black text on white background
        white_pixels = np.sum(binary == 255)
        black_pixels = np.sum(binary == 0)
        
        if black_pixels > white_pixels:
            print("[Preprocessor] Inverting binary image (detected white text on black background)", file=sys.stderr)
            binary = cv2.bitwise_not(binary)
        
        return binary
    
    def crop_borders(self, image: np.ndarray) -> np.ndarray:
        """Remove dark borders/edges from image"""
        print("[Preprocessor] Cropping borders...", file=sys.stderr)
        
        gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        
        # Find non-black regions
        _, thresh = cv2.threshold(gray, 1, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        if not contours:
            return image
        
        # Get bounding box of largest contour
        largest_contour = max(contours, key=cv2.contourArea)
        x, y, w, h = cv2.boundingRect(largest_contour)
        
        # Add small margin
        margin = 10
        x = max(0, x - margin)
        y = max(0, y - margin)
        w = min(image.shape[1] - x, w + 2 * margin)
        h = min(image.shape[0] - y, h + 2 * margin)
        
        cropped = image[y:y+h, x:x+w]
        print(f"[Preprocessor] Cropped to {w}x{h} (from {image.shape[1]}x{image.shape[0]})", file=sys.stderr)
        
        return cropped
    
    def enhance_contrast(self, image: np.ndarray) -> np.ndarray:
        """Enhance contrast using CLAHE"""
        print("[Preprocessor] Enhancing contrast with CLAHE...", file=sys.stderr)
        
        gray = image if len(image.shape) == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        
        # Create CLAHE (Contrast Limited Adaptive Histogram Equalization)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        
        return enhanced
    
    def sharpen(self, image: np.ndarray) -> np.ndarray:
        """Sharpen image to enhance text edges"""
        print("[Preprocessor] Sharpening image...", file=sys.stderr)
        
        kernel = np.array([[-1, -1, -1],
                           [-1,  9, -1],
                           [-1, -1, -1]])
        sharpened = cv2.filter2D(image, -1, kernel)
        
        return sharpened
    
    def process(self, image_path: str, save_debug: bool = False) -> Tuple[np.ndarray, Dict]:
        """
        Complete preprocessing pipeline for receipt OCR
        
        Returns:
            processed_image: Optimized image for OCR
            metadata: Processing metadata (DPI, skew, dimensions, etc.)
        """
        print(f"[Preprocessor] Loading image: {image_path}", file=sys.stderr)
        
        # Load image
        image = cv2.imread(image_path)
        if image is None:
            raise ValueError(f"Could not load image: {image_path}")
        
        metadata = {
            "original_size": {"width": image.shape[1], "height": image.shape[0]},
            "steps_applied": []
        }
        
        # Step 1: Normalize DPI
        image = self.normalize_dpi(image)
        metadata["steps_applied"].append("dpi_normalization")
        
        # Step 2: Convert to grayscale
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        metadata["steps_applied"].append("grayscale_conversion")
        
        # Step 3: Crop borders
        gray = self.crop_borders(gray)
        metadata["steps_applied"].append("border_cropping")
        
        # Step 4: Denoise
        gray = self.denoise(gray)
        metadata["steps_applied"].append("denoising")
        
        # Step 5: Deskew
        gray, skew_angle = self.deskew(gray)
        metadata["skew_angle"] = float(skew_angle)
        metadata["steps_applied"].append("deskewing")
        
        # Step 6: Enhance contrast
        gray = self.enhance_contrast(gray)
        metadata["steps_applied"].append("contrast_enhancement")
        
        # Step 7: Sharpen
        gray = self.sharpen(gray)
        metadata["steps_applied"].append("sharpening")
        
        # Step 8: Simple Otsu's thresholding (more reliable than adaptive for receipts)
        # Otsu's method automatically determines optimal threshold
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        metadata["steps_applied"].append("otsu_threshold")
        
        metadata["final_size"] = {"width": binary.shape[1], "height": binary.shape[0]}
        
        # Save debug image if requested
        if save_debug:
            debug_path = image_path.replace('.', '_preprocessed.')
            cv2.imwrite(debug_path, binary)
            print(f"[Preprocessor] Saved debug image: {debug_path}", file=sys.stderr)
            metadata["debug_image"] = debug_path
        
        print(f"[Preprocessor] Pipeline complete: {len(metadata['steps_applied'])} steps applied", file=sys.stderr)
        
        return binary, metadata


class TesseractOCR:
    """
    Optimized Tesseract OCR for receipts
    
    Features:
    - Multiple PSM modes tested and selected
    - Custom character whitelist for receipts
    - Confidence scoring per line and overall
    """
    
    # Character whitelist optimized for receipts
    RECEIPT_WHITELIST = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz$€£¥.,/:@#&*()+-= \n\t'
    
    # PSM modes to try (in order of preference for receipts)
    PSM_MODES = [
        6,  # Uniform block of text (best for receipts)
        4,  # Single column of text
        3,  # Fully automatic page segmentation
    ]
    
    def __init__(self, language: str = 'eng'):
        self.language = language
        
    def recognize(self, image: np.ndarray, psm_mode: int = 6) -> Dict:
        """
        Run Tesseract OCR with specified PSM mode
        
        Args:
            image: Preprocessed image (numpy array)
            psm_mode: Page segmentation mode
            
        Returns:
            dict with text, confidence, and metadata
        """
        print(f"[Tesseract] Running OCR with PSM mode {psm_mode}...", file=sys.stderr)
        
        # Custom config for receipts
        custom_config = f'--psm {psm_mode} -c preserve_interword_spaces=1'
        # Note: tessedit_char_whitelist can be restrictive, use with caution
        # custom_config += f' -c tessedit_char_whitelist="{self.RECEIPT_WHITELIST}"'
        
        try:
            # Extract text with confidence data
            data = pytesseract.image_to_data(
                image,
                lang=self.language,
                config=custom_config,
                output_type=pytesseract.Output.DICT
            )
            
            # Calculate overall confidence (average of confident words)
            confidences = [int(conf) for conf in data['conf'] if int(conf) > 0]
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
            
            # Extract per-line confidence and build full text
            lines = []
            all_words = []
            current_line = []
            current_line_conf = []
            current_line_num = -1
            
            for i in range(len(data['text'])):
                # Group by line_num for proper line extraction
                line_num = data['line_num'][i]
                
                if line_num != current_line_num:
                    # Save previous line
                    if current_line:
                        line_text = ' '.join(current_line)
                        line_conf = sum(current_line_conf) / len(current_line_conf) if current_line_conf else 0
                        lines.append({"text": line_text, "confidence": line_conf / 100})
                    # Start new line
                    current_line = []
                    current_line_conf = []
                    current_line_num = line_num
                
                word = data['text'][i].strip()
                conf = int(data['conf'][i])
                
                if word and conf > 0:
                    current_line.append(word)
                    current_line_conf.append(conf)
                    all_words.append(word)
            
            # Add last line
            if current_line:
                line_text = ' '.join(current_line)
                line_conf = sum(current_line_conf) / len(current_line_conf) if current_line_conf else 0
                lines.append({"text": line_text, "confidence": line_conf / 100})
            
            # Build full text from lines (preserves structure better than joining all words)
            text = '\n'.join([line['text'] for line in lines])
            
            return {
                "text": text.strip(),
                "confidence": avg_confidence / 100,  # Convert to 0-1 range
                "line_count": len(lines),
                "lines": lines,
                "word_count": len(data['text']),
                "psm_mode": psm_mode
            }
            
        except Exception as e:
            print(f"[Tesseract] OCR error: {str(e)}", file=sys.stderr)
            return {
                "text": "",
                "confidence": 0.0,
                "error": str(e),
                "psm_mode": psm_mode
            }
    
    def recognize_best(self, image: np.ndarray) -> Dict:
        """
        Try multiple PSM modes and return best result
        """
        best_result = None
        best_confidence = 0.0
        
        for psm in self.PSM_MODES:
            result = self.recognize(image, psm)
            
            if result.get('confidence', 0) > best_confidence:
                best_confidence = result['confidence']
                best_result = result
        
        print(f"[Tesseract] Best PSM mode: {best_result['psm_mode']} (confidence: {best_confidence:.2%})", file=sys.stderr)
        return best_result


def main():
    parser = argparse.ArgumentParser(description='Advanced Tesseract OCR Processor')
    parser.add_argument('image_path', help='Path to receipt image')
    parser.add_argument('--lang', default='eng', help='Language code (default: eng)')
    parser.add_argument('--psm', type=int, default=6, help='Page segmentation mode (default: 6)')
    parser.add_argument('--try-all-psm', action='store_true', help='Try all PSM modes and pick best')
    parser.add_argument('--save-debug', action='store_true', help='Save preprocessed image for debugging')
    parser.add_argument('--target-dpi', type=int, default=300, help='Target DPI for normalization (default: 300)')
    
    args = parser.parse_args()
    
    try:
        # Validate input
        if not Path(args.image_path).exists():
            raise FileNotFoundError(f"Image not found: {args.image_path}")
        
        # Preprocess image
        preprocessor = AdvancedImagePreprocessor(target_dpi=args.target_dpi)
        processed_image, preprocessing_metadata = preprocessor.process(
            args.image_path,
            save_debug=args.save_debug
        )
        
        # Run OCR
        ocr = TesseractOCR(language=args.lang)
        
        if args.try_all_psm:
            ocr_result = ocr.recognize_best(processed_image)
        else:
            ocr_result = ocr.recognize(processed_image, psm_mode=args.psm)
        
        # Combine results
        output = {
            "success": True,
            "text": ocr_result.get("text", ""),
            "confidence": ocr_result.get("confidence", 0.0),
            "line_count": ocr_result.get("line_count", 0),
            "lines": ocr_result.get("lines", []),
            "provider": "tesseract",
            "metadata": {
                **preprocessing_metadata,
                "psm_mode": ocr_result.get("psm_mode"),
                "word_count": ocr_result.get("word_count"),
                "language": args.lang,
                "target_dpi": args.target_dpi
            }
        }
        
        # Output JSON
        print(json.dumps(output, indent=2))
        sys.exit(0)
        
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e),
            "text": "",
            "confidence": 0.0,
            "provider": "tesseract"
        }), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()

