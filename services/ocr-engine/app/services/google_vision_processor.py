#!/usr/bin/env python3
"""
Google Cloud Vision API OCR Processor

Fast, cloud-based OCR processing using Google Cloud Vision API.
Provides high accuracy and speed as an alternative to local OCR providers.

Authentication Methods:
1. Service Account JSON (recommended for production):
   Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

2. API Key (simpler for development):
   Set GOOGLE_VISION_API_KEY=your-api-key

Environment Variables:
- GOOGLE_APPLICATION_CREDENTIALS: Path to service account JSON file
- GOOGLE_VISION_API_KEY: API key (alternative to service account)
- GOOGLE_VISION_TIMEOUT: Request timeout in seconds (default: 30)
- GOOGLE_VISION_MAX_RETRIES: Max retry attempts (default: 2)
"""

import sys
import os
import json
import argparse
import warnings
from pathlib import Path
from typing import Dict, List, Optional, Any
import time

# Suppress warnings
warnings.filterwarnings('ignore')

try:
    from google.cloud import vision
    from google.api_core import retry
    from google.api_core.exceptions import GoogleAPIError, RetryError
    import google.auth
except ImportError as e:
    print(json.dumps({
        "success": False,
        "error": f"Missing Google Cloud Vision SDK. Install: pip install google-cloud-vision",
        "text": "",
        "confidence": 0.0,
        "provider": "google_vision"
    }))
    sys.exit(1)


class GoogleVisionOCR:
    """
    Google Cloud Vision API OCR processor
    
    Features:
    - Fast cloud-based processing (typically 2-5s)
    - High accuracy on printed text
    - Built-in text detection and document text recognition
    - Automatic language detection
    - Confidence scores per word
    """
    
    def __init__(
        self,
        api_key: Optional[str] = None,
        credentials_path: Optional[str] = None,
        timeout: int = 30,
        max_retries: int = 2
    ):
        """
        Initialize Google Vision client
        
        Args:
            api_key: Google Vision API key (optional)
            credentials_path: Path to service account JSON (optional)
            timeout: Request timeout in seconds
            max_retries: Maximum retry attempts
        """
        self.timeout = timeout
        self.max_retries = max_retries
        
        # Initialize client with credentials
        try:
            if credentials_path:
                print(f"[GoogleVision] Using service account: {credentials_path}", file=sys.stderr)
                os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = credentials_path
                self.client = vision.ImageAnnotatorClient()
            elif api_key:
                print(f"[GoogleVision] Using API key authentication", file=sys.stderr)
                # For API key, we need to use the REST client
                from google.cloud.vision_v1.services.image_annotator import ImageAnnotatorClient
                from google.api_core.client_options import ClientOptions
                
                client_options = ClientOptions(api_key=api_key)
                self.client = ImageAnnotatorClient(client_options=client_options)
            else:
                # Try default credentials (from environment or gcloud)
                print(f"[GoogleVision] Using default credentials", file=sys.stderr)
                self.client = vision.ImageAnnotatorClient()
            
            print(f"[GoogleVision] Client initialized successfully", file=sys.stderr)
            
        except Exception as e:
            raise ValueError(f"Failed to initialize Google Vision client: {str(e)}")
    
    def recognize(self, image_path: str) -> Dict[str, Any]:
        """
        Process image with Google Cloud Vision API
        
        Args:
            image_path: Path to image file
            
        Returns:
            dict with text, confidence, lines, and metadata
        """
        print(f"[GoogleVision] Processing image: {image_path}", file=sys.stderr)
        
        try:
            # Read image file
            with open(image_path, 'rb') as image_file:
                content = image_file.read()
            
            image = vision.Image(content=content)
            
            # Track timing
            start_time = time.time()
            
            # Call Google Vision API with document_text_detection
            # This is optimized for dense text like receipts
            print(f"[GoogleVision] Calling document_text_detection API...", file=sys.stderr)
            
            response = self.client.document_text_detection(
                image=image,
                timeout=self.timeout
            )
            
            elapsed_time = time.time() - start_time
            print(f"[GoogleVision] API response received in {elapsed_time:.2f}s", file=sys.stderr)
            
            # Check for errors
            if response.error.message:
                raise GoogleAPIError(
                    f"Google Vision API error: {response.error.message}"
                )
            
            # Parse response
            result = self._parse_response(response)
            result['api_time_seconds'] = elapsed_time
            
            return result
            
        except FileNotFoundError:
            return {
                "text": "",
                "confidence": 0.0,
                "error": f"Image file not found: {image_path}",
                "lines": [],
                "word_count": 0
            }
        except GoogleAPIError as e:
            error_msg = str(e)
            print(f"[GoogleVision] API error: {error_msg}", file=sys.stderr)
            
            # Parse common errors
            if "PERMISSION_DENIED" in error_msg:
                error_msg = "API authentication failed. Check credentials or API key."
            elif "RESOURCE_EXHAUSTED" in error_msg:
                error_msg = "API quota exceeded. Check your Google Cloud quota limits."
            elif "INVALID_ARGUMENT" in error_msg:
                error_msg = "Invalid image format or corrupted file."
            
            return {
                "text": "",
                "confidence": 0.0,
                "error": error_msg,
                "lines": [],
                "word_count": 0
            }
        except RetryError as e:
            return {
                "text": "",
                "confidence": 0.0,
                "error": f"API request failed after {self.max_retries} retries: {str(e)}",
                "lines": [],
                "word_count": 0
            }
        except Exception as e:
            return {
                "text": "",
                "confidence": 0.0,
                "error": f"Unexpected error: {str(e)}",
                "lines": [],
                "word_count": 0
            }
    
    def _parse_response(self, response) -> Dict[str, Any]:
        """
        Parse Google Vision API response into standardized format
        
        Args:
            response: Google Vision API response
            
        Returns:
            Standardized OCR result dictionary
        """
        print(f"[GoogleVision] Parsing API response...", file=sys.stderr)
        
        # Get full text annotation
        full_text = response.full_text_annotation
        
        if not full_text or not full_text.text:
            print(f"[GoogleVision] No text detected in image", file=sys.stderr)
            return {
                "text": "",
                "confidence": 0.0,
                "lines": [],
                "word_count": 0
            }
        
        # Extract full text
        text = full_text.text.strip()
        
        # Calculate overall confidence
        # Google Vision provides confidence per word, we'll average them
        all_word_confidences = []
        lines = []
        
        # Parse pages, blocks, paragraphs, words, and symbols
        for page in full_text.pages:
            for block in page.blocks:
                for paragraph in block.paragraphs:
                    # Build paragraph text and calculate confidence
                    paragraph_words = []
                    paragraph_confidences = []
                    
                    for word in paragraph.words:
                        # Build word from symbols
                        word_text = ''.join([symbol.text for symbol in word.symbols])
                        word_confidence = word.confidence if hasattr(word, 'confidence') else 0.95
                        
                        paragraph_words.append(word_text)
                        paragraph_confidences.append(word_confidence)
                        all_word_confidences.append(word_confidence)
                    
                    # Calculate paragraph confidence
                    paragraph_text = ' '.join(paragraph_words)
                    paragraph_confidence = (
                        sum(paragraph_confidences) / len(paragraph_confidences)
                        if paragraph_confidences else 0.95
                    )
                    
                    if paragraph_text:
                        lines.append({
                            "text": paragraph_text,
                            "confidence": paragraph_confidence
                        })
        
        # Calculate overall confidence
        overall_confidence = (
            sum(all_word_confidences) / len(all_word_confidences)
            if all_word_confidences else 0.95
        )
        
        # Count words
        word_count = len(text.split())
        
        print(f"[GoogleVision] Extracted {len(lines)} lines, {word_count} words, "
              f"confidence: {overall_confidence:.2%}", file=sys.stderr)
        
        return {
            "text": text,
            "confidence": overall_confidence,
            "lines": lines,
            "line_count": len(lines),
            "word_count": word_count,
            "metadata": {
                "pages": len(full_text.pages),
                "detected_languages": [
                    lang.language_code 
                    for page in full_text.pages 
                    for lang in page.property.detected_languages
                ] if full_text.pages and full_text.pages[0].property else []
            }
        }


def main():
    """Command-line interface for Google Vision OCR processor"""
    parser = argparse.ArgumentParser(
        description='Google Cloud Vision API OCR Processor',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Authentication Options:
  1. Service Account JSON (recommended):
     --credentials /path/to/service-account.json
     OR
     GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

  2. API Key:
     --api-key YOUR_API_KEY
     OR
     GOOGLE_VISION_API_KEY=YOUR_API_KEY

  3. Default credentials (gcloud CLI):
     No flags needed, uses `gcloud auth application-default login`

Examples:
  # Using service account
  python google_vision_processor.py receipt.jpg --credentials service-account.json

  # Using API key
  python google_vision_processor.py receipt.jpg --api-key AIza...

  # Using environment variable
  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
  python google_vision_processor.py receipt.jpg
        """
    )
    
    parser.add_argument('image_path', help='Path to receipt image')
    parser.add_argument(
        '--api-key',
        help='Google Vision API key (or set GOOGLE_VISION_API_KEY env var)',
        default=os.getenv('GOOGLE_VISION_API_KEY')
    )
    parser.add_argument(
        '--credentials',
        help='Path to service account JSON (or set GOOGLE_APPLICATION_CREDENTIALS)',
        default=os.getenv('GOOGLE_APPLICATION_CREDENTIALS')
    )
    parser.add_argument(
        '--timeout',
        type=int,
        default=int(os.getenv('GOOGLE_VISION_TIMEOUT', '30')),
        help='Request timeout in seconds (default: 30)'
    )
    parser.add_argument(
        '--max-retries',
        type=int,
        default=int(os.getenv('GOOGLE_VISION_MAX_RETRIES', '2')),
        help='Maximum retry attempts (default: 2)'
    )
    
    args = parser.parse_args()
    
    try:
        # Validate input
        if not Path(args.image_path).exists():
            raise FileNotFoundError(f"Image not found: {args.image_path}")
        
        # Check authentication
        if not args.api_key and not args.credentials:
            print("[GoogleVision] No explicit credentials provided, using default authentication", 
                  file=sys.stderr)
        
        # Initialize Google Vision OCR
        ocr = GoogleVisionOCR(
            api_key=args.api_key,
            credentials_path=args.credentials,
            timeout=args.timeout,
            max_retries=args.max_retries
        )
        
        # Process image
        result = ocr.recognize(args.image_path)
        
        # Build output
        if 'error' in result:
            output = {
                "success": False,
                "error": result['error'],
                "text": result.get('text', ''),
                "confidence": result.get('confidence', 0.0),
                "provider": "google_vision"
            }
        else:
            output = {
                "success": True,
                "text": result['text'],
                "confidence": result['confidence'],
                "lines": result.get('lines', []),
                "line_count": result.get('line_count', 0),
                "word_count": result.get('word_count', 0),
                "provider": "google_vision",
                "metadata": {
                    **result.get('metadata', {}),
                    "api_time_seconds": result.get('api_time_seconds', 0),
                    "timeout": args.timeout,
                    "max_retries": args.max_retries
                }
            }
        
        # Output JSON
        print(json.dumps(output, indent=2))
        sys.exit(0 if output['success'] else 1)
        
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e),
            "text": "",
            "confidence": 0.0,
            "provider": "google_vision"
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()

