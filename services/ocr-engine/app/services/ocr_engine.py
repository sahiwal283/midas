"""
OCR Engine - Core OCR processing orchestrator

Coordinates OCR providers, inference engines, and postprocessing.
Migrated from Expense App OCR Service.
"""

import subprocess
import json
import os
import re
import time
import uuid
from typing import Dict, Optional, List, Any
from pathlib import Path

from app.config import settings
from app.services.metrics import record_external_api_call
from app.services.telemetry import send_api_event
from app.services.usage_pricing import estimate_document_ai_usd, estimate_google_vision_usd
from app.utils.logger import setup_logger

logger = setup_logger(__name__)


def sanitize_path(path: str) -> str:
    """
    Sanitize file path to prevent command injection
    
    Args:
        path: Path to sanitize
    
    Returns:
        Absolute path if valid
    
    Raises:
        ValueError: If path contains dangerous characters
    """
    if not path:
        raise ValueError("Path cannot be empty")
    
    # Check for shell metacharacters that could be exploited
    dangerous_chars = [';', '&', '|', '$', '`', '\n', '\r', '\t']
    if any(c in path for c in dangerous_chars):
        logger.error(f"Invalid characters detected in path: {path}")
        raise ValueError(f"Invalid characters in path: {path}")
    
    return os.path.abspath(path)


def sanitize_executable(executable: str) -> str:
    """
    Sanitize executable command name/path used with subprocess.

    Allows either:
    - absolute/relative paths without shell metacharacters
    - simple command names like 'python3'
    """
    if not executable:
        raise ValueError("Executable cannot be empty")

    dangerous_chars = [';', '&', '|', '$', '`', '\n', '\r', '\t']
    if any(c in executable for c in dangerous_chars):
        logger.error(f"Invalid characters detected in executable: {executable}")
        raise ValueError(f"Invalid characters in executable: {executable}")

    # If path-like input, return absolute path for deterministic execution.
    if '/' in executable:
        return os.path.abspath(executable)

    # Command names should only contain safe characters.
    if not re.match(r'^[a-zA-Z0-9._-]+$', executable):
        raise ValueError(f"Invalid executable name: {executable}")

    return executable


class OCREngine:
    """
    Main OCR processing engine
    
    Supports multiple OCR providers:
    - Document AI (RECOMMENDED: cloud-based, receipt-specific, extracts structured fields)
    - Google Vision (cloud-based OCR, fast, highly accurate general text)
    - RapidOCR (PaddleOCR PP-OCR models on onnxruntime; fast + accurate on CPU)
    - Tesseract (CPU-compatible, reliable fallback)
    - EasyOCR (high accuracy, no AVX2 required)
    - PaddleOCR (alternative provider)
    """
    
    def __init__(
        self,
        primary_provider: str = None,
        fallback_provider: Optional[str] = None,
        languages: List[str] = None
    ):
        self.primary_provider = primary_provider or settings.PRIMARY_OCR_PROVIDER
        self.fallback_provider = fallback_provider or settings.FALLBACK_OCR_PROVIDER
        self.languages = languages or settings.OCR_LANGUAGES
        self.python_path = settings.PYTHON_PATH
        
        # Path to processor scripts
        self.script_dir = Path(__file__).parent
        
        logger.info(
            f"OCR Engine initialized: primary={self.primary_provider}, "
            f"fallback={self.fallback_provider}, languages={self.languages}"
        )
    
    async def process_image(
        self,
        image_path: str,
        job_id: Optional[uuid.UUID] = None,
        request_id: Optional[uuid.UUID] = None,
    ) -> Dict[str, Any]:
        """
        Process image with OCR

        Args:
            image_path: Path to image file
            job_id: Cost-ledger job UUID (None when ledger is unavailable)
            request_id: Correlation UUID for this inbound request

        Returns:
            OCR result dictionary with text, confidence, and metadata
        """
        logger.info(f"Processing image: {image_path}")

        # Try primary provider
        result = await self._run_ocr_provider(
            self.primary_provider, image_path, job_id=job_id, request_id=request_id
        )

        # Log the raw OCR result
        logger.info(f"OCR Provider: {result.get('provider', 'unknown')}")
        logger.info(f"OCR Confidence: {result.get('confidence', 0):.4f}")
        logger.info(f"OCR Text Preview: {result.get('text', '')[:200]}...")

        # If confidence is low and fallback is configured, try fallback
        if (result.get('confidence', 0) < settings.OCR_CONFIDENCE_THRESHOLD and
                self.fallback_provider):
            logger.info(
                f"Primary confidence {result.get('confidence', 0):.2f} below threshold, "
                f"trying fallback provider: {self.fallback_provider}"
            )
            fallback_result = await self._run_ocr_provider(
                self.fallback_provider, image_path, job_id=job_id, request_id=request_id
            )

            # Use fallback if better
            if fallback_result.get('confidence', 0) > result.get('confidence', 0):
                logger.info("Using fallback result (better confidence)")
                result = fallback_result

        # When REQUIRE_COST_LEDGER=true and ledger is unavailable, all metered providers
        # are blocked (result.blocked=True).  If a local fallback is explicitly configured,
        # run it so images still process in degraded mode instead of failing hard.
        if result.get('blocked') and settings.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER:
            from app.db.ledger import is_metered_cloud
            local_provider = settings.LEDGER_UNAVAILABLE_FALLBACK_PROVIDER
            if not is_metered_cloud(local_provider):
                logger.warning(
                    "All metered providers blocked (REQUIRE_COST_LEDGER=true, ledger unavailable). "
                    f"Attempting local fallback: {local_provider}"
                )
                local_result = await self._run_ocr_provider(
                    local_provider, image_path, job_id=None, request_id=None
                )
                if local_result.get('success'):
                    local_result['ledger_unavailable_fallback'] = True
                    result = local_result

        return result
    
    async def process_pdf(
        self,
        pdf_path: str,
        dpi: int = 300,
        job_id: Optional[uuid.UUID] = None,
        request_id: Optional[uuid.UUID] = None,
    ) -> Dict[str, Any]:
        """
        Process PDF with OCR

        Args:
            pdf_path: Path to PDF file
            dpi: DPI for PDF to image conversion
            job_id: Cost-ledger job UUID (None when ledger is unavailable)
            request_id: Correlation UUID for this inbound request

        Returns:
            OCR result dictionary with text, confidence, and metadata
        """
        logger.info(f"Processing PDF: {pdf_path}")

        # Prefer providers with native PDF support for better multi-page receipt extraction.
        primary_result: Optional[Dict[str, Any]] = None
        if self._provider_supports_pdf(self.primary_provider):
            if self.primary_provider == 'document_ai':
                primary_result = await self._run_document_ai_pdf_provider(
                    pdf_path, job_id=job_id, request_id=request_id
                )
            else:
                primary_result = await self._run_ocr_provider(
                    self.primary_provider, pdf_path, job_id=job_id, request_id=request_id
                )
            if primary_result.get('success'):
                logger.info(
                    f"Primary PDF provider succeeded: {self.primary_provider} "
                    f"(confidence={primary_result.get('confidence', 0):.4f})"
                )

        if (
            primary_result
            and primary_result.get('success')
            and primary_result.get('confidence', 0) >= settings.OCR_CONFIDENCE_THRESHOLD
        ):
            return primary_result

        if self._provider_supports_pdf(self.fallback_provider):
            fallback_result = await self._run_ocr_provider(
                self.fallback_provider, pdf_path, job_id=job_id, request_id=request_id
            )
            if fallback_result.get('success'):
                logger.info(
                    f"Fallback PDF provider succeeded: {self.fallback_provider} "
                    f"(confidence={fallback_result.get('confidence', 0):.4f})"
                )
                if (
                    not primary_result
                    or not primary_result.get('success')
                    or fallback_result.get('confidence', 0) > primary_result.get('confidence', 0)
                ):
                    return fallback_result

        if primary_result and primary_result.get('success'):
            # Primary provider succeeded but below threshold and fallback was not better.
            return primary_result

        # Fall back to local PDF->image OCR pipeline when cloud/native PDF paths are unavailable.
        return self._run_local_pdf_processor(pdf_path, dpi)

    def _record_gcp_ocr_telemetry(
        self, provider: str, parsed: Dict[str, Any], duration_s: float
    ) -> None:
        """Prometheus + optional ingestion for Google Document AI / Vision subprocess runs."""
        if provider not in ("document_ai", "google_vision"):
            return
        ok = bool(parsed.get("success"))
        status = "success" if ok else "error"
        record_external_api_call(provider, status, duration_s)
        if not ok:
            return
        latency_ms = duration_s * 1000.0
        if provider == "document_ai":
            pages = int(parsed.get("page_count") or 1)
            pages = max(pages, 1)
            est = estimate_document_ai_usd(pages)
            send_api_event(
                "document_ai",
                pages,
                "pages",
                latency_ms=latency_ms,
                estimated_cost_usd=est,
                gcp_product="documentai.googleapis.com",
            )
        else:
            meta = parsed.get("metadata") or {}
            pages = int(meta.get("pages") or 1)
            pages = max(pages, 1)
            est = estimate_google_vision_usd(pages)
            send_api_event(
                "google_vision",
                pages,
                "pages",
                latency_ms=latency_ms,
                estimated_cost_usd=est,
                gcp_product="vision.googleapis.com",
            )

    def _provider_supports_pdf(self, provider: Optional[str]) -> bool:
        """Return True when provider can process PDFs directly."""
        return provider in {'document_ai'}

    def _run_local_pdf_processor(self, pdf_path: str, dpi: int) -> Dict[str, Any]:
        """Run local PDF processor as last-resort OCR path."""
        # Sanitize paths to prevent injection
        pdf_path = sanitize_path(pdf_path)
        python_path = sanitize_executable(self.python_path)

        script_path = self.script_dir / "pdf_processor.py"
        args = [
            python_path,
            str(script_path),
            pdf_path,
            '--dpi', str(dpi),
            '--lang', ','.join(self.languages),
            '--max-pages', str(settings.PDF_FALLBACK_MAX_PAGES),
            '--gpu', 'false'
        ]

        try:
            return self._execute_python_script(args)
        except Exception as e:
            logger.error(f"PDF processing error: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'text': '',
                'confidence': 0.0,
                'provider': 'pdf-processor'
            }

    async def _run_document_ai_pdf_provider(
        self,
        pdf_path: str,
        job_id: Optional[uuid.UUID] = None,
        request_id: Optional[uuid.UUID] = None,
    ) -> Dict[str, Any]:
        """Run Document AI specifically for PDFs with tighter latency controls."""
        pdf_path = sanitize_path(pdf_path)
        python_path = sanitize_executable(self.python_path)

        if not settings.GOOGLE_CLOUD_PROJECT_ID:
            return {
                'success': False,
                'error': 'GOOGLE_CLOUD_PROJECT_ID is required when using document_ai provider',
                'text': '',
                'confidence': 0.0,
                'provider': 'document_ai'
            }

        script_path = self.script_dir / "document_ai_processor.py"
        args = [
            python_path,
            str(script_path),
            pdf_path,
            '--project-id', settings.GOOGLE_CLOUD_PROJECT_ID
        ]

        if settings.GOOGLE_APPLICATION_CREDENTIALS:
            os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = settings.GOOGLE_APPLICATION_CREDENTIALS
        if settings.DOCUMENT_AI_LOCATION:
            args.extend(['--location', settings.DOCUMENT_AI_LOCATION])
        if settings.DOCUMENT_AI_PROCESSOR_ID:
            args.extend(['--processor-id', settings.DOCUMENT_AI_PROCESSOR_ID])

        args.extend([
            '--timeout', str(settings.DOCUMENT_AI_PDF_TIMEOUT),
            '--max-retries', str(settings.DOCUMENT_AI_PDF_MAX_RETRIES)
        ])

        # Cost ledger: open a provider_calls row before executing the script.
        # document_ai is metered_cloud — block if REQUIRE_COST_LEDGER=true and ledger is unavailable.
        call_id: Optional[uuid.UUID] = None
        if settings.REQUIRE_COST_LEDGER and not (job_id and request_id):
            logger.warning("Blocking document_ai PDF: REQUIRE_COST_LEDGER=true but ledger DB unavailable (no job_id)")
            return {
                'success': False,
                'error': 'document_ai blocked: REQUIRE_COST_LEDGER=true but cost ledger is unavailable',
                'text': '',
                'confidence': 0.0,
                'provider': 'document_ai',
                'blocked': True,
            }
        if job_id and request_id:
            from app.db.ledger import start_provider_call
            call_id = await start_provider_call(job_id, request_id, "document_ai", "ocr")
            if call_id is None and settings.REQUIRE_COST_LEDGER:
                logger.warning("Blocking document_ai PDF: REQUIRE_COST_LEDGER=true but ledger write failed")
                return {
                    'success': False,
                    'error': 'document_ai blocked: REQUIRE_COST_LEDGER=true but cost ledger is unavailable',
                    'text': '',
                    'confidence': 0.0,
                    'provider': 'document_ai',
                    'blocked': True,
                }

        try:
            start = time.perf_counter()
            parsed = self._execute_python_script(
                args, timeout_seconds=settings.PDF_PRIMARY_SCRIPT_TIMEOUT
            )
            duration = time.perf_counter() - start
            self._record_gcp_ocr_telemetry("document_ai", parsed, duration)

            # Record outcome in ledger
            if call_id:
                from app.db.ledger import complete_provider_call
                pages = int(parsed.get("page_count") or 1)
                ok = bool(parsed.get("success"))
                await complete_provider_call(
                    call_id,
                    status="success" if ok else "error",
                    provider_name="document_ai",
                    usage_units=pages,
                    usage_unit_type="pages",
                    estimated_cost_usd=estimate_document_ai_usd(pages) if ok else None,
                    duration_ms=duration * 1000.0,
                    error_message=parsed.get("error") if not ok else None,
                )
            return parsed
        except Exception as e:
            if call_id:
                from app.db.ledger import complete_provider_call
                await complete_provider_call(
                    call_id, status="error", provider_name="document_ai",
                    error_message=str(e),
                )
            logger.error(f"PDF provider document_ai error: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'text': '',
                'confidence': 0.0,
                'provider': 'document_ai'
            }
    
    async def _run_ocr_provider(
        self,
        provider: str,
        image_path: str,
        job_id: Optional[uuid.UUID] = None,
        request_id: Optional[uuid.UUID] = None,
    ) -> Dict[str, Any]:
        """
        Run specific OCR provider

        Args:
            provider: Provider name (document_ai, google_vision, rapidocr, tesseract, easyocr, paddleocr)
            image_path: Path to image
            job_id: Cost-ledger job UUID (None when ledger is unavailable)
            request_id: Correlation UUID

        Returns:
            OCR result dictionary

        Raises:
            ValueError: If required configuration is missing or paths are invalid
        """
        # Sanitize image path to prevent injection
        image_path = sanitize_path(image_path)

        # Sanitize python path
        python_path = sanitize_executable(self.python_path)

        if provider == 'document_ai':
            # Validate required configuration
            if not settings.GOOGLE_CLOUD_PROJECT_ID:
                raise ValueError("GOOGLE_CLOUD_PROJECT_ID is required when using document_ai provider")
            
            script_path = self.script_dir / "document_ai_processor.py"
            args = [
                python_path,
                str(script_path),
                image_path,
                '--project-id', settings.GOOGLE_CLOUD_PROJECT_ID
            ]
            # Add optional configurations
            if settings.GOOGLE_APPLICATION_CREDENTIALS:
                os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = sanitize_path(settings.GOOGLE_APPLICATION_CREDENTIALS)
            if settings.DOCUMENT_AI_LOCATION:
                args.extend(['--location', settings.DOCUMENT_AI_LOCATION])
            if settings.DOCUMENT_AI_PROCESSOR_ID:
                args.extend(['--processor-id', settings.DOCUMENT_AI_PROCESSOR_ID])
            args.extend([
                '--timeout', str(settings.DOCUMENT_AI_TIMEOUT),
                '--max-retries', str(settings.DOCUMENT_AI_MAX_RETRIES)
            ])
        elif provider == 'google_vision':
            script_path = self.script_dir / "google_vision_processor.py"
            args = [
                python_path,
                str(script_path),
                image_path
            ]
            # Add credentials if configured
            if settings.GOOGLE_APPLICATION_CREDENTIALS:
                # Sanitize credentials path if it's a file path
                creds_path = sanitize_path(settings.GOOGLE_APPLICATION_CREDENTIALS)
                args.extend(['--credentials', creds_path])
            elif settings.GOOGLE_VISION_API_KEY:
                args.extend(['--api-key', settings.GOOGLE_VISION_API_KEY])
            
            # Add timeout and retries
            args.extend([
                '--timeout', str(settings.GOOGLE_VISION_TIMEOUT),
                '--max-retries', str(settings.GOOGLE_VISION_MAX_RETRIES)
            ])
        elif provider == 'rapidocr':
            script_path = self.script_dir / "rapidocr_processor.py"
            args = [
                python_path,
                str(script_path),
                image_path,
                '--lang', ','.join(self.languages)
            ]
        elif provider == 'tesseract':
            script_path = self.script_dir / "tesseract_processor.py"
            args = [
                python_path,
                str(script_path),
                image_path,
                '--lang', ','.join(self.languages),
                '--try-all-psm',
                '--target-dpi', '300'
            ]
        elif provider == 'easyocr':
            script_path = self.script_dir / "easyocr_processor.py"
            args = [
                python_path,
                str(script_path),
                image_path,
                '--lang', ','.join(self.languages),
                '--gpu', 'false',
                '--preprocess', 'true'
            ]
        elif provider == 'paddleocr':
            script_path = self.script_dir / "paddleocr_processor.py"
            args = [
                python_path,
                str(script_path),
                image_path,
                '--lang', ','.join(self.languages),
                '--gpu', 'false'
            ]
        else:
            raise ValueError(f"Unknown OCR provider: {provider}")

        # Cost-ledger guard for metered cloud providers
        from app.db.ledger import start_provider_call, complete_provider_call, is_metered_cloud
        call_id: Optional[uuid.UUID] = None
        if is_metered_cloud(provider):
            if settings.REQUIRE_COST_LEDGER and not (job_id and request_id):
                logger.warning(f"Blocking {provider}: REQUIRE_COST_LEDGER=true but ledger DB unavailable")
                return {
                    'success': False,
                    'error': f'{provider} blocked: REQUIRE_COST_LEDGER=true but cost ledger is unavailable',
                    'text': '',
                    'confidence': 0.0,
                    'provider': provider,
                    'blocked': True,
                }
            if job_id and request_id:
                call_id = await start_provider_call(job_id, request_id, provider, "ocr")
                if call_id is None and settings.REQUIRE_COST_LEDGER:
                    logger.warning(f"Blocking {provider}: REQUIRE_COST_LEDGER=true but ledger write failed")
                    return {
                        'success': False,
                        'error': f'{provider} blocked: REQUIRE_COST_LEDGER=true but cost ledger is unavailable',
                        'text': '',
                        'confidence': 0.0,
                        'provider': provider,
                        'blocked': True,
                    }
        elif job_id and request_id:
            # Local provider — best-effort ledger write, never blocked
            call_id = await start_provider_call(job_id, request_id, provider, "ocr")

        try:
            start = time.perf_counter()
            parsed = self._execute_python_script(args)
            duration = time.perf_counter() - start
            self._record_gcp_ocr_telemetry(provider, parsed, duration)

            # Record outcome in ledger
            if call_id:
                ok = bool(parsed.get("success"))
                cost_usd = None
                usage = None
                usage_type = None
                if ok and provider == "document_ai":
                    usage = int(parsed.get("page_count") or 1)
                    usage_type = "pages"
                    cost_usd = estimate_document_ai_usd(usage)
                elif ok and provider == "google_vision":
                    meta = parsed.get("metadata") or {}
                    usage = int(meta.get("pages") or 1)
                    usage_type = "images"
                    cost_usd = estimate_google_vision_usd(usage)
                await complete_provider_call(
                    call_id,
                    status="success" if ok else "error",
                    provider_name=provider,
                    usage_units=usage,
                    usage_unit_type=usage_type,
                    estimated_cost_usd=cost_usd,
                    duration_ms=duration * 1000.0,
                    error_message=parsed.get("error") if not ok else None,
                )
            return parsed
        except Exception as e:
            if call_id:
                await complete_provider_call(
                    call_id, status="error", provider_name=provider, error_message=str(e)
                )
            logger.error(f"OCR provider {provider} error: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'text': '',
                'confidence': 0.0,
                'provider': provider
            }
    
    def _execute_python_script(self, args: List[str], timeout_seconds: int = 120) -> Dict[str, Any]:
        """
        Execute Python script and parse JSON output
        
        Args:
            args: Command line arguments
        
        Returns:
            Parsed JSON result
        """
        try:
            # Set environment to suppress Python warnings (like FutureWarning from Google API)
            env = os.environ.copy()
            env['PYTHONWARNINGS'] = 'ignore'
            
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
                env=env
            )
            
            # Filter out FutureWarning from stderr (it's not an actual error)
            stderr_filtered = result.stderr
            if stderr_filtered and 'FutureWarning' in stderr_filtered:
                # Only keep actual errors, not warnings
                stderr_lines = [line for line in stderr_filtered.split('\n') 
                               if line.strip() and 'FutureWarning' not in line and 'warnings.warn' not in line]
                stderr_filtered = '\n'.join(stderr_lines)
            
            if result.returncode != 0 and stderr_filtered.strip():
                logger.error(f"Script error: {stderr_filtered}")
                return {
                    'success': False,
                    'error': stderr_filtered or 'Script execution failed',
                    'text': '',
                    'confidence': 0.0
                }
            
            # Parse JSON output
            output = result.stdout.strip()
            parsed = json.loads(output)
            
            return parsed
            
        except subprocess.TimeoutExpired:
            logger.error("Script execution timeout")
            return {
                'success': False,
                'error': f'Processing timeout (>{timeout_seconds}s)',
                'text': '',
                'confidence': 0.0
            }
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse JSON output: {str(e)}")
            # Safely get raw output - result may not exist if error occurred before subprocess.run
            raw_output = getattr(result, 'stdout', 'N/A') if 'result' in locals() else 'N/A'
            logger.debug(f"Raw output: {raw_output}")
            return {
                'success': False,
                'error': f'Invalid JSON response: {str(e)}',
                'text': '',
                'confidence': 0.0
            }
        except Exception as e:
            logger.error(f"Script execution error: {str(e)}")
            return {
                'success': False,
                'error': str(e),
                'text': '',
                'confidence': 0.0
            }
    
    async def is_available(self) -> Dict[str, bool]:
        """
        Check availability of OCR providers
        
        Returns:
            Dictionary mapping provider names to availability status
        """
        availability = {}
        
        for provider in [self.primary_provider, self.fallback_provider]:
            if provider:
                try:
                    # Simple check: try to import required modules
                    if provider == 'document_ai':
                        check_cmd = [self.python_path, '-c', 'from google.cloud import documentai_v1; print("OK")']
                    elif provider == 'google_vision':
                        check_cmd = [self.python_path, '-c', 'from google.cloud import vision; print("OK")']
                    elif provider == 'tesseract':
                        check_cmd = [self.python_path, '-c', 'import cv2, pytesseract; pytesseract.get_tesseract_version()']
                    elif provider == 'rapidocr':
                        # find_spec instead of a real import: importing rapidocr pulls in
                        # cv2/onnxruntime (~seconds), and this check runs on every
                        # /health/ready probe, which callers hit with short timeouts.
                        check_cmd = [
                            self.python_path, '-c',
                            'import importlib.util as u; '
                            'assert u.find_spec("rapidocr") or u.find_spec("rapidocr_onnxruntime"); '
                            'print("OK")'
                        ]
                    elif provider == 'easyocr':
                        check_cmd = [self.python_path, '-c', 'import easyocr; print("OK")']
                    elif provider == 'paddleocr':
                        check_cmd = [self.python_path, '-c', 'import paddleocr; print("OK")']
                    else:
                        availability[provider] = False
                        continue
                    
                    result = subprocess.run(
                        check_cmd,
                        capture_output=True,
                        text=True,
                        timeout=10,
                        check=False
                    )
                    
                    availability[provider] = result.returncode == 0
                except Exception as e:
                    logger.warning(f"Provider {provider} availability check failed: {str(e)}")
                    availability[provider] = False
        
        return availability


# Singleton instance
ocr_engine = OCREngine()

