"""
Prompt Service - Fetches and manages prompts from Model Training Service

Handles:
- Fetching prompts from Model Training API
- Caching prompts in memory with TTL
- Periodic refresh and webhook updates
- Version management
"""

import httpx
import asyncio
from typing import Dict, Optional, Any
from datetime import datetime, timedelta
from pathlib import Path
import json

from app.config import settings
from app.utils.logger import setup_logger

logger = setup_logger(__name__)


class PromptService:
    """
    Manages prompts from Model Training Service
    
    Fetches prompts on startup, caches them, and refreshes periodically.
    Supports webhook notifications for immediate updates.
    """
    
    def __init__(
        self,
        model_training_url: str = None,
        max_retries: int = 3,
        retry_delay: float = 1.0
    ):
        # Use provided URL or settings, but don't use hardcoded fallback
        self.model_training_url = model_training_url or settings.MODEL_TRAINING_URL
        if not self.model_training_url:
            logger.warning("MODEL_TRAINING_URL not configured - prompt service may not work")
        self.cached_prompt: Optional[Dict[str, Any]] = None
        self.cached_version: Optional[str] = None
        self.cache_timestamp: Optional[datetime] = None
        self.cache_ttl = timedelta(hours=6)
        self.cache_max_age = timedelta(days=7)  # Fallback expiry
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        
        self.client = httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True
        )
        
        logger.info(f"Prompt Service initialized: {self.model_training_url}, max_retries: {self.max_retries}")
    
    async def get_active_prompt(self) -> Optional[Dict[str, Any]]:
        """
        Get currently active prompt
        
        Returns cached prompt if valid, otherwise fetches fresh.
        Falls back to rule-based if service unavailable and cache expired.
        
        Returns:
            Prompt dictionary with system_prompt, user_prompt_template, etc.
        """
        # Check if cache is still valid
        if self._is_cache_valid():
            logger.debug(f"Using cached prompt version {self.cached_version}")
            return self.cached_prompt
        
        # Cache expired or empty, fetch new prompt
        try:
            prompt = await self._fetch_active_prompt()
            if prompt:
                self._update_cache(prompt)
                return prompt
        except Exception as e:
            logger.error(f"Failed to fetch prompt: {str(e)}")
        
        # If fetch failed, use cached prompt if within max age
        if self.cached_prompt and self._is_cache_usable():
            logger.warning("Using stale cached prompt (fetch failed)")
            return self.cached_prompt
        
        # No usable prompt available
        logger.error("No valid prompt available, falling back to rule-based only")
        return None
    
    async def _fetch_active_prompt(self) -> Optional[Dict[str, Any]]:
        """Fetch active prompt from Model Training API with exponential backoff retries"""
        url = f"{self.model_training_url}/models/active/prompt"
        last_error = None
        
        for attempt in range(self.max_retries + 1):
            try:
                if attempt > 0:
                    # Exponential backoff: 1s, 2s, 4s, etc.
                    delay = self.retry_delay * (2 ** (attempt - 1))
                    logger.info(f"Prompt fetch retry attempt {attempt}/{self.max_retries} after {delay}s delay")
                    await asyncio.sleep(delay)
                
                logger.info(f"Fetching active prompt from {url}")
                
                response = await self.client.get(url)
                response.raise_for_status()
                
                prompt_data = response.json()
                version = prompt_data.get('version', 'unknown')
                
                logger.info(f"Fetched prompt version {version}")
                return prompt_data
                
            except httpx.TimeoutException as e:
                last_error = e
                logger.warning(f"Prompt fetch timeout on attempt {attempt + 1}/{self.max_retries + 1}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Prompt fetch failed after {self.max_retries + 1} attempts (timeout)")
                    break
            except httpx.HTTPStatusError as e:
                # Don't retry on 4xx errors (client errors)
                if 400 <= e.response.status_code < 500:
                    logger.error(f"Prompt fetch client error (no retry): {e.response.status_code} - {str(e)}")
                    return None
                # Retry on 5xx errors (server errors)
                last_error = e
                logger.warning(f"Prompt fetch server error on attempt {attempt + 1}/{self.max_retries + 1}: {e.response.status_code} - {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Prompt fetch failed after {self.max_retries + 1} attempts (HTTP {e.response.status_code})")
                    break
            except httpx.HTTPError as e:
                last_error = e
                logger.warning(f"Prompt fetch HTTP error on attempt {attempt + 1}/{self.max_retries + 1}: {type(e).__name__}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Prompt fetch failed after {self.max_retries + 1} attempts")
                    break
            except Exception as e:
                last_error = e
                logger.warning(f"Prompt fetch unexpected error on attempt {attempt + 1}/{self.max_retries + 1}: {type(e).__name__}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Prompt fetch failed after {self.max_retries + 1} attempts")
                    break
        
        logger.error(f"Prompt fetch failed after all retries: {str(last_error)}")
        return None
    
    async def fetch_specific_version(self, version: str) -> Optional[Dict[str, Any]]:
        """Fetch specific prompt version with exponential backoff retries"""
        url = f"{self.model_training_url}/models/{version}/prompt"
        last_error = None
        
        for attempt in range(self.max_retries + 1):
            try:
                if attempt > 0:
                    # Exponential backoff: 1s, 2s, 4s, etc.
                    delay = self.retry_delay * (2 ** (attempt - 1))
                    logger.info(f"Prompt version fetch retry attempt {attempt}/{self.max_retries} after {delay}s delay")
                    await asyncio.sleep(delay)
                
                logger.info(f"Fetching prompt version {version}")
                
                response = await self.client.get(url)
                response.raise_for_status()
                
                return response.json()
                
            except httpx.TimeoutException as e:
                last_error = e
                logger.warning(f"Prompt version fetch timeout on attempt {attempt + 1}/{self.max_retries + 1}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Prompt version fetch failed after {self.max_retries + 1} attempts (timeout)")
                    break
            except httpx.HTTPStatusError as e:
                # Don't retry on 4xx errors (client errors)
                if 400 <= e.response.status_code < 500:
                    logger.error(f"Prompt version fetch client error (no retry): {e.response.status_code} - {str(e)}")
                    return None
                # Retry on 5xx errors (server errors)
                last_error = e
                logger.warning(f"Prompt version fetch server error on attempt {attempt + 1}/{self.max_retries + 1}: {e.response.status_code} - {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Prompt version fetch failed after {self.max_retries + 1} attempts (HTTP {e.response.status_code})")
                    break
            except httpx.HTTPError as e:
                last_error = e
                logger.warning(f"Prompt version fetch HTTP error on attempt {attempt + 1}/{self.max_retries + 1}: {type(e).__name__}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Prompt version fetch failed after {self.max_retries + 1} attempts")
                    break
            except Exception as e:
                last_error = e
                logger.warning(f"Prompt version fetch unexpected error on attempt {attempt + 1}/{self.max_retries + 1}: {type(e).__name__}: {str(e)}")
                if attempt >= self.max_retries:
                    logger.error(f"Prompt version fetch failed after {self.max_retries + 1} attempts")
                    break
        
        logger.error(f"Prompt version fetch failed after all retries: {str(last_error)}")
        return None
    
    async def check_version_update(self) -> bool:
        """
        Check if a new prompt version is available with exponential backoff retries
        
        Returns:
            True if new version available, False otherwise
        """
        url = f"{self.model_training_url}/models/active/prompt"
        last_error = None
        
        for attempt in range(self.max_retries + 1):
            try:
                if attempt > 0:
                    # Exponential backoff: 1s, 2s, 4s, etc.
                    delay = self.retry_delay * (2 ** (attempt - 1))
                    await asyncio.sleep(delay)
                
                response = await self.client.get(url)
                response.raise_for_status()
                
                data = response.json()
                remote_version = data.get('version')
                
                if remote_version != self.cached_version:
                    logger.info(f"New prompt version available: {remote_version} (current: {self.cached_version})")
                    return True
                
                return False
                
            except Exception as e:
                last_error = e
                if attempt >= self.max_retries:
                    logger.error(f"Error checking version after {self.max_retries + 1} attempts: {str(last_error)}")
                    return False
        
        return False
    
    async def refresh_prompt(self) -> bool:
        """
        Refresh prompt from Model Training service
        
        Returns:
            True if refresh successful, False otherwise
        """
        try:
            prompt = await self._fetch_active_prompt()
            if prompt:
                self._update_cache(prompt)
                logger.info("Prompt refreshed successfully")
                return True
            return False
        except Exception as e:
            logger.error(f"Error refreshing prompt: {str(e)}")
            return False
    
    def _update_cache(self, prompt: Dict[str, Any]):
        """Update cached prompt"""
        self.cached_prompt = prompt
        self.cached_version = prompt.get('version', 'unknown')
        self.cache_timestamp = datetime.now()
        logger.info(f"Cached prompt version {self.cached_version}")
    
    def _is_cache_valid(self) -> bool:
        """Check if cache is still valid (within TTL)"""
        if not self.cached_prompt or not self.cache_timestamp:
            return False
        
        age = datetime.now() - self.cache_timestamp
        return age < self.cache_ttl
    
    def _is_cache_usable(self) -> bool:
        """Check if cache is usable (within max age for fallback)"""
        if not self.cached_prompt or not self.cache_timestamp:
            return False
        
        age = datetime.now() - self.cache_timestamp
        return age < self.cache_max_age
    
    async def start_background_refresh(self):
        """Start background task to periodically refresh prompts"""
        logger.info("Starting background prompt refresh (every 6 hours)")
        
        while True:
            try:
                await asyncio.sleep(6 * 3600)  # 6 hours
                
                # Check if version changed
                if await self.check_version_update():
                    await self.refresh_prompt()
                    logger.info("Background refresh: Prompt updated")
                else:
                    logger.debug("Background refresh: No update needed")
                    
            except Exception as e:
                logger.error(f"Background refresh error: {str(e)}")
    
    async def close(self):
        """Close HTTP client"""
        await self.client.aclose()


# Singleton instance
prompt_service = PromptService()

