"""
Webhook endpoints for external service notifications
"""

from fastapi import APIRouter, HTTPException, status, Header
from typing import Dict, Any, Optional
from pydantic import BaseModel, Field

from app.utils.logger import setup_logger
from app.services.prompt_service import prompt_service

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
logger = setup_logger(__name__)


class PromptUpdateWebhook(BaseModel):
    """Webhook payload model for prompt updates"""
    version: Optional[str] = Field(None, description="New prompt version")
    timestamp: Optional[str] = Field(None, description="Update timestamp")
    changes: Optional[str] = Field(None, description="Description of changes")


@router.post("/prompt-updated", status_code=status.HTTP_200_OK)
async def prompt_updated_webhook(
    payload: PromptUpdateWebhook,
    x_webhook_secret: Optional[str] = Header(None, alias="X-Webhook-Secret")
) -> Dict[str, Any]:
    """
    Webhook endpoint for Model Training to notify of prompt updates
    
    When Model Training publishes a new prompt version, it can POST here
    to trigger immediate refresh instead of waiting for periodic check.
    
    Expected payload:
    {
        "version": "v1.1.0",
        "timestamp": "2025-10-23T12:00:00",
        "changes": "Improved category inference"
    }
    
    Optional header:
    - X-Webhook-Secret: Secret token for webhook authentication (future use)
    
    Returns:
        Acknowledgment message with update status
    """
    try:
        version = payload.version or 'unknown'
        logger.info(f"Webhook: Prompt update notification received for version {version}")
        
        # Log webhook metadata
        if payload.timestamp:
            logger.info(f"Webhook timestamp: {payload.timestamp}")
        if payload.changes:
            logger.info(f"Webhook changes: {payload.changes}")
        
        # Store previous version for response
        previous_version = prompt_service.cached_version
        
        # Trigger prompt refresh
        success = await prompt_service.refresh_prompt()
        
        if success:
            new_version = prompt_service.cached_version
            logger.info(f"Webhook: Prompt refreshed successfully from {previous_version} to {new_version}")
            return {
                "status": "success",
                "message": f"Prompt updated to version {new_version}",
                "previous_version": previous_version,
                "new_version": new_version,
                "webhook_version": version
            }
        else:
            logger.error("Webhook: Prompt refresh failed - service may be unavailable")
            # Return 200 but indicate failure in response
            # This prevents webhook sender from retrying immediately
            return {
                "status": "failed",
                "message": "Failed to refresh prompt - service may be unavailable",
                "previous_version": previous_version,
                "webhook_version": version,
                "error": "refresh_failed"
            }
    
    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        logger.error(f"Webhook processing error: {str(e)}", exc_info=True)
        # Return 200 with error details to prevent webhook retries
        # The webhook sender can check the status field
        return {
            "status": "error",
            "message": f"Webhook processing error: {str(e)}",
            "error": "processing_failed"
        }


@router.get("/test", status_code=status.HTTP_200_OK)
async def test_webhook() -> Dict[str, str]:
    """Test endpoint to verify webhook routing works"""
    return {
        "status": "ok",
        "message": "Webhook endpoint is operational"
    }

