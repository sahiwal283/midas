#!/usr/bin/env python3
"""
Google Document AI Receipt Processor

Uses Google Cloud Document AI's pre-trained receipt parser
to extract structured data from receipts.
"""

import argparse
import json
import os
import sys
import warnings
from typing import Dict, Any, List, Optional

# Suppress FutureWarning about Python version
warnings.filterwarnings("ignore", category=FutureWarning)

from google.cloud import documentai_v1 as documentai
from google.api_core.exceptions import GoogleAPIError, RetryError
import time


class DocumentAIProcessor:
    """
    Google Document AI receipt processor with structured field extraction.
    
    Unlike Vision API (which only does OCR), Document AI:
    - Extracts structured fields (merchant, amount, date, etc.)
    - Understands document layout and context
    - Returns higher accuracy for receipts/invoices
    """
    
    def __init__(
        self,
        project_id: str,
        location: str = "us",
        processor_id: Optional[str] = None,
        timeout: int = 30,
        max_retries: int = 2
    ):
        """
        Initialize Document AI processor.
        
        Args:
            project_id: Google Cloud project ID
            location: Processor location (default: 'us')
            processor_id: Optional specific processor ID
            timeout: Request timeout in seconds
            max_retries: Maximum number of retry attempts
        """
        self.project_id = project_id
        self.location = location
        self.processor_id = processor_id
        self.timeout = timeout
        self.max_retries = max_retries
        
        # Initialize the Document AI client
        self.client = documentai.DocumentProcessorServiceClient()
        
        # If no processor_id provided, use the default receipt parser
        if not self.processor_id:
            # Format: projects/{project}/locations/{location}/processors/{processor}
            # For receipt parser, we'll use the pre-trained processor type
            self.processor_name = f"projects/{project_id}/locations/{location}/processors/pretrained-receipt-v1"
        else:
            self.processor_name = f"projects/{project_id}/locations/{location}/processors/{processor_id}"
    
    def process_image(self, image_path: str) -> Dict[str, Any]:
        """
        Process receipt image and extract structured data.
        
        Args:
            image_path: Path to the receipt image
            
        Returns:
            Dictionary with OCR result including structured fields
        """
        try:
            # Read the image file
            with open(image_path, 'rb') as image_file:
                image_content = image_file.read()
            
            # Determine MIME type
            mime_type = self._get_mime_type(image_path)
            
            # Create the document
            raw_document = documentai.RawDocument(
                content=image_content,
                mime_type=mime_type
            )
            
            # Configure the process request
            request = documentai.ProcessRequest(
                name=self.processor_name,
                raw_document=raw_document
            )
            
            # Process the document with retries
            for attempt in range(self.max_retries + 1):
                try:
                    result = self.client.process_document(
                        request=request,
                        timeout=self.timeout
                    )
                    break
                except (GoogleAPIError, RetryError) as e:
                    if attempt >= self.max_retries:
                        raise
                    time.sleep(2 ** attempt)  # Exponential backoff
            
            # Extract the document
            document = result.document
            
            # Get the full text
            text = document.text
            
            # Extract structured entities
            entities = self._extract_entities(document)
            
            # Calculate confidence (average of all entity confidences)
            confidence = self._calculate_confidence(document)
            
            # Build the response in the same format as other providers
            page_count = len(document.pages) if document.pages else 1
            return {
                'success': True,
                'text': text,
                'confidence': confidence,
                'provider': 'document_ai',
                'entities': entities,  # NEW: Structured fields
                'lines': self._extract_lines(document),
                'line_count': len(document.pages[0].lines) if document.pages else 0,
                'page_count': page_count,
                'word_count': len(text.split())
            }
            
        except FileNotFoundError:
            return {
                'success': False,
                'error': f'Image file not found: {image_path}',
                'provider': 'document_ai'
            }
        except GoogleAPIError as e:
            return {
                'success': False,
                'error': f'Google Document AI API error: {str(e)}',
                'provider': 'document_ai'
            }
        except Exception as e:
            return {
                'success': False,
                'error': f'Unexpected error: {str(e)}',
                'provider': 'document_ai'
            }
    
    def _extract_entities(self, document: documentai.Document) -> Dict[str, Any]:
        """
        Extract structured entities from the document.
        
        Returns fields like:
        - merchant_name
        - receipt_date
        - total_amount
        - currency
        - line_items
        - etc.
        """
        entities = {}
        
        for entity in document.entities:
            # Entity type (e.g., "receipt_date", "supplier_name", "total_amount")
            entity_type = entity.type_
            
            # Entity value
            mention_text = entity.mention_text
            
            # Confidence
            confidence = entity.confidence
            
            # Normalized value (for dates, amounts, etc.)
            normalized_value = None
            if entity.normalized_value:
                if entity.normalized_value.text:
                    normalized_value = entity.normalized_value.text
                elif entity.normalized_value.money_value:
                    money = entity.normalized_value.money_value
                    normalized_value = {
                        'amount': money.units + (money.nanos / 1e9),
                        'currency': money.currency_code
                    }
                elif entity.normalized_value.date_value:
                    date = entity.normalized_value.date_value
                    normalized_value = f"{date.year:04d}-{date.month:02d}-{date.day:02d}"
            
            # Map entity types to our standard field names
            field_mapping = {
                'supplier_name': 'merchant',
                'receipt_date': 'date',
                'total_amount': 'amount',
                'currency': 'currency',
                'line_item': 'line_items',
                'supplier_address': 'location',
                'payment_method': 'payment_method',
                'tax_amount': 'tax',
                'tip_amount': 'tip'
            }
            
            standard_field = field_mapping.get(entity_type, entity_type)
            
            # Handle line items specially (they're repeated)
            if standard_field == 'line_items':
                if 'line_items' not in entities:
                    entities['line_items'] = []
                entities['line_items'].append({
                    'text': mention_text,
                    'confidence': confidence
                })
            else:
                entities[standard_field] = {
                    'value': normalized_value or mention_text,
                    'raw_text': mention_text,
                    'confidence': confidence
                }
        
        return entities
    
    def _extract_lines(self, document: documentai.Document) -> List[Dict[str, Any]]:
        """Extract line-by-line text with confidence scores."""
        lines = []
        
        if not document.pages:
            return lines
        
        for page in document.pages:
            for line in page.lines:
                text = self._get_text_from_layout(line.layout, document.text)
                confidence = line.layout.confidence if line.layout.confidence else 0.0
                
                lines.append({
                    'text': text,
                    'confidence': confidence
                })
        
        return lines
    
    def _get_text_from_layout(self, layout, full_text: str) -> str:
        """Extract text from a layout element using text anchors."""
        text_segments = []
        
        for segment in layout.text_anchor.text_segments:
            start_index = int(segment.start_index) if segment.start_index else 0
            end_index = int(segment.end_index) if segment.end_index else len(full_text)
            text_segments.append(full_text[start_index:end_index])
        
        return ''.join(text_segments)
    
    def _calculate_confidence(self, document: documentai.Document) -> float:
        """Calculate overall confidence score."""
        confidences = []
        
        # Get entity confidences
        for entity in document.entities:
            if entity.confidence:
                confidences.append(entity.confidence)
        
        # Get line confidences
        for page in document.pages:
            for line in page.lines:
                if line.layout.confidence:
                    confidences.append(line.layout.confidence)
        
        return sum(confidences) / len(confidences) if confidences else 0.0
    
    def _get_mime_type(self, file_path: str) -> str:
        """Determine MIME type from file extension."""
        ext = os.path.splitext(file_path)[1].lower()
        mime_types = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.pdf': 'application/pdf',
            '.gif': 'image/gif',
            '.tiff': 'image/tiff',
            '.tif': 'image/tiff'
        }
        return mime_types.get(ext, 'image/jpeg')


def main():
    parser = argparse.ArgumentParser(description='Process receipt with Google Document AI')
    parser.add_argument('image_path', help='Path to the receipt image')
    parser.add_argument('--project-id', required=True, help='Google Cloud project ID')
    parser.add_argument('--location', default='us', help='Processor location')
    parser.add_argument('--processor-id', help='Specific processor ID')
    parser.add_argument('--timeout', type=int, default=30, help='Request timeout')
    parser.add_argument('--max-retries', type=int, default=2, help='Max retries')
    
    args = parser.parse_args()
    
    # Initialize processor
    processor = DocumentAIProcessor(
        project_id=args.project_id,
        location=args.location,
        processor_id=args.processor_id,
        timeout=args.timeout,
        max_retries=args.max_retries
    )
    
    # Process the image
    result = processor.process_image(args.image_path)
    
    # Output as JSON
    print(json.dumps(result, indent=2))
    
    # Exit with appropriate code
    sys.exit(0 if result.get('success') else 1)


if __name__ == '__main__':
    main()

