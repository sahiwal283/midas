"""
LLM Provider - Interface for calling LLMs for OCR enhancement

Supports:
- Ollama (local, preferred)
- OpenAI (fallback)
- Google Gemini (cloud, fast)
- Anthropic Claude (future)
"""

import httpx
import json
import asyncio
import time
import uuid
from typing import Dict, Optional, Any, List
from enum import Enum

from app.config import settings
from app.utils.logger import setup_logger
from app.services.metrics import record_external_api_call
from app.services.telemetry import send_api_event
from app.services.usage_pricing import estimate_gemini_usd, estimate_openai_usd

logger = setup_logger(__name__)


class LLMProviderType(str, Enum):
    """Supported LLM providers"""
    OLLAMA = "ollama"
    OPENAI = "openai"
    GEMINI = "gemini"
    ANTHROPIC = "anthropic"


class LLMProvider:
    """
    LLM Provider for OCR field enhancement
    
    Calls configured LLM to enhance/validate OCR field extraction
    when confidence is low or results are ambiguous.
    """
    
    def __init__(
        self,
        provider: str = None,
        ollama_url: str = None,
        ollama_model: str = "llama3.1",
        openai_api_key: str = None,
        openai_model: str = "gpt-4o-mini",
        gemini_api_key: str = None,
        gemini_model: str = "gemini-1.5-flash",
        max_retries: int = 3,
        retry_delay: float = 1.0
    ):
        self.provider = provider or settings.LLM_PROVIDER or LLMProviderType.OLLAMA
        # Use provided URL or fallback to localhost only if not explicitly None
        self.ollama_url = ollama_url if ollama_url is not None else "http://localhost:11434"
        self.ollama_model = ollama_model
        self.openai_api_key = openai_api_key
        self.openai_model = openai_model
        self.gemini_api_key = gemini_api_key
        self.gemini_model = gemini_model
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        
        # Validate required settings based on provider
        if self.provider == LLMProviderType.OLLAMA and not self.ollama_url:
            raise ValueError("OLLAMA_URL is required when using ollama provider")
        if self.provider == LLMProviderType.OPENAI and not self.openai_api_key:
            raise ValueError("OPENAI_API_KEY is required when using openai provider")
        if self.provider == LLMProviderType.GEMINI and not self.gemini_api_key:
            raise ValueError("GEMINI_API_KEY is required when using gemini provider")
        
        self.client = httpx.AsyncClient(timeout=120.0)  # Increase timeout for LLM calls
        
        logger.info(f"LLM Provider initialized: {self.provider}, Ollama URL: {self.ollama_url}, max_retries: {self.max_retries}")
    
    async def enhance_fields(
        self,
        ocr_text: str,
        rule_based_fields: Dict[str, Any],
        system_prompt: str,
        user_prompt_template: str,
        job_id: Optional[uuid.UUID] = None,
        request_id: Optional[uuid.UUID] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Enhance OCR fields using LLM

        Args:
            ocr_text: Raw OCR text
            rule_based_fields: Fields extracted by rule-based inference
            system_prompt: System prompt from Model Training
            user_prompt_template: User prompt template with {ocr_text} placeholder
            job_id: Cost-ledger job UUID (None when ledger is unavailable)
            request_id: Correlation UUID

        Returns:
            Enhanced fields dictionary or None if LLM fails
        """
        try:
            # Format user prompt with OCR text
            user_prompt = user_prompt_template.replace("{ocr_text}", ocr_text)

            # Add context about rule-based results
            user_prompt += f"\n\nExisting rule-based extraction for reference:\n{json.dumps(rule_based_fields, indent=2)}"

            # Call appropriate provider
            if self.provider == LLMProviderType.OLLAMA:
                result = await self._call_ollama(system_prompt, user_prompt, job_id=job_id, request_id=request_id)
            elif self.provider == LLMProviderType.OPENAI:
                result = await self._call_openai(system_prompt, user_prompt, job_id=job_id, request_id=request_id)
            elif self.provider == LLMProviderType.GEMINI:
                result = await self._call_gemini(system_prompt, user_prompt, job_id=job_id, request_id=request_id)
            else:
                logger.error(f"Unsupported provider: {self.provider}")
                return None

            if result:
                logger.info("LLM enhancement successful")
                return result

            return None

        except Exception as e:
            logger.error(f"LLM enhancement error: {str(e)}")
            return None
    
    async def _call_ollama(
        self,
        system_prompt: str,
        user_prompt: str,
        job_id: Optional[uuid.UUID] = None,
        request_id: Optional[uuid.UUID] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Call Ollama API with exponential backoff retries.
        Ollama is local_compute_not_metered — never blocked by REQUIRE_COST_LEDGER.
        """
        url = f"{self.ollama_url}/api/generate"
        start = time.perf_counter()

        # Combine system and user prompts as per Model Training recommendation
        combined_prompt = f"{system_prompt}\n\n{user_prompt}"

        payload = {
            "model": self.ollama_model,
            "prompt": combined_prompt,
            "stream": False,
            "format": "json",
            "options": {
                "temperature": 0.1,
                "top_p": 0.9
            }
        }

        # Best-effort ledger write (ollama = local_compute_not_metered, never blocked)
        call_id: Optional[uuid.UUID] = None
        if job_id and request_id:
            from app.db.ledger import start_provider_call, complete_provider_call
            call_id = await start_provider_call(job_id, request_id, "ollama", "llm_enhancement")

        last_error = None

        for attempt in range(self.max_retries + 1):
            try:
                if attempt > 0:
                    delay = self.retry_delay * (2 ** (attempt - 1))
                    logger.info(f"Ollama retry attempt {attempt}/{self.max_retries} after {delay}s delay")
                    await asyncio.sleep(delay)

                logger.info(f"Calling Ollama: {url} with model {self.ollama_model}, prompt length: {len(combined_prompt)}")

                response = await self.client.post(url, json=payload)
                response.raise_for_status()

                logger.info(f"Ollama response received: status {response.status_code}")

                data = response.json()
                response_text = data.get("response", "")

                try:
                    parsed = json.loads(response_text)
                    duration = time.perf_counter() - start
                    logger.info("Ollama JSON parsed successfully")
                    record_external_api_call("ollama", "success", duration)
                    if call_id:
                        from app.db.ledger import complete_provider_call
                        await complete_provider_call(
                            call_id, "success", provider_name="ollama",
                            estimated_cost_usd=0.0, duration_ms=duration * 1000.0,
                        )
                    return parsed
                except json.JSONDecodeError:
                    duration = time.perf_counter() - start
                    logger.error(f"Failed to parse Ollama JSON response: {response_text[:200]}")
                    record_external_api_call("ollama", "error", duration)
                    if call_id:
                        from app.db.ledger import complete_provider_call
                        await complete_provider_call(
                            call_id, "error", provider_name="ollama",
                            error_message="JSON parse failed", duration_ms=duration * 1000.0,
                        )
                    return None

            except httpx.TimeoutException as e:
                last_error = e
                logger.warning(f"Ollama timeout on attempt {attempt + 1}/{self.max_retries + 1}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Ollama request failed after {self.max_retries + 1} attempts (timeout)")
                    break
            except httpx.HTTPStatusError as e:
                if 400 <= e.response.status_code < 500:
                    logger.error(f"Ollama client error (no retry): {e.response.status_code} - {str(e)}")
                    record_external_api_call("ollama", "error", time.perf_counter() - start)
                    return None
                last_error = e
                logger.warning(f"Ollama server error on attempt {attempt + 1}/{self.max_retries + 1}: {e.response.status_code} - {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Ollama request failed after {self.max_retries + 1} attempts (HTTP {e.response.status_code})")
                    break
            except httpx.HTTPError as e:
                last_error = e
                logger.warning(f"Ollama HTTP error on attempt {attempt + 1}/{self.max_retries + 1}: {type(e).__name__}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Ollama request failed after {self.max_retries + 1} attempts")
                    break
            except Exception as e:
                last_error = e
                logger.warning(f"Ollama unexpected error on attempt {attempt + 1}/{self.max_retries + 1}: {type(e).__name__}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Ollama request failed after {self.max_retries + 1} attempts")
                    break

        duration = time.perf_counter() - start
        logger.error(f"Ollama call failed after all retries: {str(last_error)}")
        record_external_api_call("ollama", "error", duration)
        if call_id:
            from app.db.ledger import complete_provider_call
            await complete_provider_call(
                call_id, "error", provider_name="ollama",
                error_message=str(last_error), duration_ms=duration * 1000.0,
            )
        return None
    
    async def _call_openai(
        self,
        system_prompt: str,
        user_prompt: str,
        job_id: Optional[uuid.UUID] = None,
        request_id: Optional[uuid.UUID] = None,
    ) -> Optional[Dict[str, Any]]:
        """Call OpenAI API with exponential backoff retries. OpenAI is metered_cloud."""
        if not self.openai_api_key:
            logger.error("OpenAI API key not configured")
            return None

        # Cost-ledger guard — block if REQUIRE_COST_LEDGER=true and ledger is unavailable
        from app.db.ledger import start_provider_call, complete_provider_call
        call_id: Optional[uuid.UUID] = None
        if settings.REQUIRE_COST_LEDGER and not (job_id and request_id):
            logger.warning("Blocking openai: REQUIRE_COST_LEDGER=true but ledger DB unavailable")
            return None
        if job_id and request_id:
            call_id = await start_provider_call(job_id, request_id, "openai", "llm_enhancement")
            if call_id is None and settings.REQUIRE_COST_LEDGER:
                logger.warning("Blocking openai: REQUIRE_COST_LEDGER=true but ledger write failed")
                return None

        url = "https://api.openai.com/v1/chat/completions"
        start = time.perf_counter()

        headers = {
            "Authorization": f"Bearer {self.openai_api_key}",
            "Content-Type": "application/json"
        }

        payload = {
            "model": self.openai_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_object"}
        }

        last_error = None

        for attempt in range(self.max_retries + 1):
            try:
                if attempt > 0:
                    delay = self.retry_delay * (2 ** (attempt - 1))
                    logger.info(f"OpenAI retry attempt {attempt}/{self.max_retries} after {delay}s delay")
                    await asyncio.sleep(delay)

                logger.debug(f"Calling OpenAI: {self.openai_model}")

                response = await self.client.post(url, json=payload, headers=headers)
                response.raise_for_status()

                data = response.json()
                message_content = data["choices"][0]["message"]["content"]

                try:
                    parsed = json.loads(message_content)
                    logger.info("OpenAI JSON parsed successfully")
                    duration = time.perf_counter() - start
                    usage = (data.get("usage") or {}).get("total_tokens", 0)
                    record_external_api_call("openai", "success", duration)
                    send_api_event(
                        "openai", usage, "tokens", duration * 1000.0,
                        estimated_cost_usd=estimate_openai_usd(usage),
                        gcp_product="openai.com",
                    )
                    if call_id:
                        await complete_provider_call(
                            call_id, "success", provider_name="openai",
                            usage_units=usage, usage_unit_type="tokens",
                            estimated_cost_usd=estimate_openai_usd(usage),
                            duration_ms=duration * 1000.0,
                        )
                    return parsed
                except json.JSONDecodeError:
                    duration = time.perf_counter() - start
                    logger.error(f"Failed to parse OpenAI JSON response: {message_content[:200]}")
                    record_external_api_call("openai", "error", duration)
                    if call_id:
                        await complete_provider_call(
                            call_id, "error", provider_name="openai",
                            error_message="JSON parse failed", duration_ms=duration * 1000.0,
                        )
                    return None

            except httpx.TimeoutException as e:
                last_error = e
                logger.warning(f"OpenAI timeout on attempt {attempt + 1}/{self.max_retries + 1}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"OpenAI request failed after {self.max_retries + 1} attempts (timeout)")
                    break
            except httpx.HTTPStatusError as e:
                if 400 <= e.response.status_code < 500:
                    logger.error(f"OpenAI client error (no retry): {e.response.status_code} - {str(e)}")
                    record_external_api_call("openai", "error", time.perf_counter() - start)
                    if call_id:
                        await complete_provider_call(
                            call_id, "error", provider_name="openai",
                            error_message=f"HTTP {e.response.status_code}",
                        )
                    return None
                last_error = e
                logger.warning(f"OpenAI server error on attempt {attempt + 1}/{self.max_retries + 1}: {e.response.status_code} - {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"OpenAI request failed after {self.max_retries + 1} attempts (HTTP {e.response.status_code})")
                    break
            except httpx.HTTPError as e:
                last_error = e
                logger.warning(f"OpenAI HTTP error on attempt {attempt + 1}/{self.max_retries + 1}: {type(e).__name__}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"OpenAI request failed after {self.max_retries + 1} attempts")
                    break
            except Exception as e:
                last_error = e
                logger.warning(f"OpenAI unexpected error on attempt {attempt + 1}/{self.max_retries + 1}: {type(e).__name__}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"OpenAI request failed after {self.max_retries + 1} attempts")
                    break

        duration = time.perf_counter() - start
        logger.error(f"OpenAI call failed after all retries: {str(last_error)}")
        record_external_api_call("openai", "error", duration)
        if call_id:
            await complete_provider_call(
                call_id, "error", provider_name="openai",
                error_message=str(last_error), duration_ms=duration * 1000.0,
            )
        return None
    
    async def _call_gemini(
        self,
        system_prompt: str,
        user_prompt: str,
        job_id: Optional[uuid.UUID] = None,
        request_id: Optional[uuid.UUID] = None,
    ) -> Optional[Dict[str, Any]]:
        """Call Google Gemini API with exponential backoff retries. Gemini is metered_cloud."""
        if not self.gemini_api_key:
            logger.error("Gemini API key not configured")
            return None

        # Cost-ledger guard — block if REQUIRE_COST_LEDGER=true and ledger is unavailable
        from app.db.ledger import start_provider_call, complete_provider_call
        call_id: Optional[uuid.UUID] = None
        if settings.REQUIRE_COST_LEDGER and not (job_id and request_id):
            logger.warning("Blocking gemini: REQUIRE_COST_LEDGER=true but ledger DB unavailable")
            return None
        if job_id and request_id:
            call_id = await start_provider_call(job_id, request_id, "gemini", "llm_enhancement")
            if call_id is None and settings.REQUIRE_COST_LEDGER:
                logger.warning("Blocking gemini: REQUIRE_COST_LEDGER=true but ledger write failed")
                return None

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.gemini_model}:generateContent"
        start = time.perf_counter()

        combined_prompt = f"{system_prompt}\n\n{user_prompt}"

        payload = {
            "contents": [{"parts": [{"text": combined_prompt}]}],
            "generationConfig": {
                "temperature": 0.1,
                "topP": 0.9,
                "responseMimeType": "application/json"
            }
        }

        params = {"key": self.gemini_api_key}
        last_error = None

        for attempt in range(self.max_retries + 1):
            try:
                if attempt > 0:
                    delay = self.retry_delay * (2 ** (attempt - 1))
                    logger.info(f"Gemini retry attempt {attempt}/{self.max_retries} after {delay}s delay")
                    await asyncio.sleep(delay)

                logger.info(f"Calling Gemini: {self.gemini_model}, prompt length: {len(combined_prompt)}")

                response = await self.client.post(url, json=payload, params=params)
                response.raise_for_status()

                logger.info(f"Gemini response received: status {response.status_code}")

                data = response.json()

                if "candidates" not in data or not data["candidates"]:
                    logger.error("Gemini response missing candidates")
                    record_external_api_call("gemini", "error", time.perf_counter() - start)
                    return None

                candidate = data["candidates"][0]
                if "content" not in candidate or "parts" not in candidate["content"]:
                    logger.error("Gemini response missing content/parts")
                    record_external_api_call("gemini", "error", time.perf_counter() - start)
                    return None

                parts = candidate["content"]["parts"]
                if not parts or "text" not in parts[0]:
                    logger.error("Gemini response missing text")
                    record_external_api_call("gemini", "error", time.perf_counter() - start)
                    return None

                response_text = parts[0]["text"]
                usage_meta = data.get("usageMetadata") or {}
                usage = usage_meta.get("totalTokenCount", 0) or (
                    usage_meta.get("promptTokenCount", 0) + usage_meta.get("candidatesTokenCount", 0)
                )

                try:
                    parsed = json.loads(response_text)
                    logger.info("Gemini JSON parsed successfully")
                    duration = time.perf_counter() - start
                    record_external_api_call("gemini", "success", duration)
                    send_api_event(
                        "gemini", usage, "tokens", duration * 1000.0,
                        estimated_cost_usd=estimate_gemini_usd(usage),
                        gcp_product="generativelanguage.googleapis.com",
                    )
                    if call_id:
                        await complete_provider_call(
                            call_id, "success", provider_name="gemini",
                            usage_units=usage, usage_unit_type="tokens",
                            estimated_cost_usd=estimate_gemini_usd(usage),
                            duration_ms=duration * 1000.0,
                        )
                    return parsed
                except json.JSONDecodeError:
                    duration = time.perf_counter() - start
                    logger.error(f"Failed to parse Gemini JSON response: {response_text[:200]}")
                    record_external_api_call("gemini", "error", duration)
                    if call_id:
                        await complete_provider_call(
                            call_id, "error", provider_name="gemini",
                            error_message="JSON parse failed", duration_ms=duration * 1000.0,
                        )
                    return None

            except httpx.TimeoutException as e:
                last_error = e
                logger.warning(f"Gemini timeout on attempt {attempt + 1}/{self.max_retries + 1}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Gemini request failed after {self.max_retries + 1} attempts (timeout)")
                    break
            except httpx.HTTPStatusError as e:
                if 400 <= e.response.status_code < 500:
                    error_detail = "Unknown error"
                    try:
                        error_data = e.response.json()
                        error_detail = error_data.get("error", {}).get("message", str(e))
                    except Exception:
                        error_detail = str(e)
                    logger.error(f"Gemini client error (no retry): {e.response.status_code} - {error_detail}")
                    record_external_api_call("gemini", "error", time.perf_counter() - start)
                    if call_id:
                        await complete_provider_call(
                            call_id, "error", provider_name="gemini",
                            error_message=f"HTTP {e.response.status_code}: {error_detail}",
                        )
                    return None
                last_error = e
                logger.warning(f"Gemini server error on attempt {attempt + 1}/{self.max_retries + 1}: {e.response.status_code} - {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Gemini request failed after {self.max_retries + 1} attempts (HTTP {e.response.status_code})")
                    break
            except httpx.HTTPError as e:
                last_error = e
                logger.warning(f"Gemini HTTP error on attempt {attempt + 1}/{self.max_retries + 1}: {type(e).__name__}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Gemini request failed after {self.max_retries + 1} attempts")
                    break
            except Exception as e:
                last_error = e
                logger.warning(f"Gemini unexpected error on attempt {attempt + 1}/{self.max_retries + 1}: {type(e).__name__}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Gemini request failed after {self.max_retries + 1} attempts")
                    break

        duration = time.perf_counter() - start
        logger.error(f"Gemini call failed after all retries: {str(last_error)}")
        record_external_api_call("gemini", "error", duration)
        if call_id:
            await complete_provider_call(
                call_id, "error", provider_name="gemini",
                error_message=str(last_error), duration_ms=duration * 1000.0,
            )
        return None
    
    async def check_availability(self) -> bool:
        """
        Check if LLM provider is available
        
        Returns:
            True if provider is reachable, False otherwise
        """
        try:
            if self.provider == LLMProviderType.OLLAMA:
                response = await self.client.get(f"{self.ollama_url}/api/tags")
                return response.status_code == 200
            elif self.provider == LLMProviderType.OPENAI:
                # Simple check - would need API key validation in production
                return self.openai_api_key is not None
            elif self.provider == LLMProviderType.GEMINI:
                # Simple check - would need API key validation in production
                # Could make a lightweight API call to verify, but for now just check key exists
                return self.gemini_api_key is not None
            return False
        except Exception:
            return False
    
    async def close(self):
        """Close HTTP client"""
        await self.client.aclose()


# Singleton instance (will be initialized when LLM is enabled)
llm_provider: Optional[LLMProvider] = None


def get_llm_provider() -> Optional[LLMProvider]:
    """Get or create LLM provider instance"""
    global llm_provider
    
    if not settings.ENABLE_LLM_INFERENCE:
        return None
    
    if llm_provider is None:
        llm_provider = LLMProvider(
            provider=settings.LLM_PROVIDER,
            ollama_url=settings.OLLAMA_URL,
            ollama_model=settings.OLLAMA_MODEL,
            openai_api_key=settings.OPENAI_API_KEY,
            openai_model=settings.OPENAI_MODEL,
            gemini_api_key=getattr(settings, 'GEMINI_API_KEY', None),
            gemini_model=getattr(settings, 'GEMINI_MODEL', 'gemini-1.5-flash')
        )
    
    return llm_provider

