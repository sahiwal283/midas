"""
File utility functions for OCR Service
"""

import os
import shutil
import uuid
from pathlib import Path
from typing import Optional
from fastapi import UploadFile, HTTPException
from app.config import settings
from app.utils.logger import setup_logger

logger = setup_logger(__name__)


def ensure_upload_dir() -> None:
    """Ensure upload directory exists"""
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)


def validate_file_extension(filename: str) -> bool:
    """
    Validate file extension - secure implementation
    
    Prevents extension bypass attacks (e.g., malicious.exe.jpg)
    by checking for dangerous extensions in the filename.
    
    Args:
        filename: Name of the file
    
    Returns:
        True if valid, False otherwise
    """
    if not filename or '.' not in filename:
        return False
    
    # Get the actual extension (last part after last dot)
    extension = filename.rsplit('.', 1)[-1].lower()
    
    # Additional security check: ensure no executable extensions anywhere in filename
    # This prevents bypass attacks like "malicious.exe.jpg"
    dangerous_extensions = ['exe', 'sh', 'bat', 'cmd', 'com', 'scr', 'vbs', 'js', 'jar', 'py', 'php']
    filename_lower = filename.lower()
    # Check if any dangerous extension appears in the filename (not just at the end)
    for ext in dangerous_extensions:
        if f'.{ext}.' in filename_lower or filename_lower.endswith(f'.{ext}'):
            logger.warning(f"Rejected file with dangerous extension: {filename}")
            return False
    
    return extension in settings.ALLOWED_EXTENSIONS


def generate_unique_filename(original_filename: str) -> str:
    """
    Generate unique filename while preserving extension
    
    Args:
        original_filename: Original file name
    
    Returns:
        Unique filename
    """
    extension = original_filename.split('.')[-1].lower()
    unique_id = uuid.uuid4().hex[:12]
    return f"{unique_id}.{extension}"


async def save_upload_file(upload_file: UploadFile) -> str:
    """
    Save uploaded file to disk
    
    Args:
        upload_file: FastAPI UploadFile object
    
    Returns:
        Path to saved file
    
    Raises:
        HTTPException: If file is invalid or save fails
    """
    # Validate file extension
    if not validate_file_extension(upload_file.filename):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(settings.ALLOWED_EXTENSIONS)}"
        )
    
    # Ensure upload directory exists
    ensure_upload_dir()
    
    # Generate unique filename
    filename = generate_unique_filename(upload_file.filename)
    
    # Validate path to prevent traversal (even though UUID filename is safe, validate anyway)
    file_path = validate_file_path(filename, settings.UPLOAD_DIR)
    
    try:
        # Check file size before reading entire file into memory
        # First try to get size from Content-Length header if available
        file_size = None
        if hasattr(upload_file, 'size') and upload_file.size:
            file_size = upload_file.size
        elif hasattr(upload_file, 'headers'):
            content_length = upload_file.headers.get('content-length')
            if content_length:
                try:
                    file_size = int(content_length)
                except (ValueError, TypeError):
                    pass
        
        # If we have size info, check it before reading
        if file_size is not None and file_size > settings.MAX_FILE_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum size: {settings.MAX_FILE_SIZE / 1024 / 1024}MB"
            )
        
        # Stream file in chunks directly to disk to keep memory usage stable for large PDFs.
        size = 0
        chunk_size = 8192  # 8KB chunks
        
        with open(file_path, "wb") as f:
            while True:
                chunk = await upload_file.read(chunk_size)
                if not chunk:
                    break
                
                size += len(chunk)
                if size > settings.MAX_FILE_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large. Maximum size: {settings.MAX_FILE_SIZE / 1024 / 1024}MB"
                    )
                f.write(chunk)
        
        logger.info(f"Saved upload file: {filename} ({size} bytes)")
        return file_path
        
    except HTTPException:
        # Remove partially written files (for example when size limits are exceeded).
        cleanup_file(file_path)
        raise
    except Exception as e:
        logger.error(f"Failed to save upload file: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")


def validate_file_path(file_path: str, base_dir: str) -> str:
    """
    Ensure file_path is within base_dir (prevent path traversal)
    
    Args:
        file_path: Path to validate
        base_dir: Base directory that file_path must be within
    
    Returns:
        Resolved absolute path
    
    Raises:
        ValueError: If path traversal is detected
    """
    resolved_path = os.path.abspath(os.path.join(base_dir, file_path))
    base_dir_abs = os.path.abspath(base_dir)
    
    if not resolved_path.startswith(base_dir_abs):
        logger.error(f"Path traversal detected: {file_path} (base: {base_dir_abs})")
        raise ValueError(f"Path traversal detected: {file_path}")
    
    return resolved_path


async def save_async_job_file(upload_file: UploadFile, job_id: uuid.UUID) -> str:
    """
    Save an async job's upload to a durable per-job directory.

    Path: {UPLOAD_DIR}/async_jobs/{job_id}/input.{ext}

    Raises:
        HTTPException 400 — invalid extension
        HTTPException 413 — file too large
        HTTPException 500 — write failure
    """
    if not validate_file_extension(upload_file.filename):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(settings.ALLOWED_EXTENSIONS)}",
        )

    ext = upload_file.filename.rsplit(".", 1)[-1].lower() if "." in (upload_file.filename or "") else "bin"
    job_dir = os.path.join(settings.UPLOAD_DIR, "async_jobs", str(job_id))
    os.makedirs(job_dir, exist_ok=True)

    file_path = os.path.abspath(os.path.join(job_dir, f"input.{ext}"))
    base_abs = os.path.abspath(os.path.join(settings.UPLOAD_DIR, "async_jobs"))
    if not file_path.startswith(base_abs + os.sep):
        raise HTTPException(status_code=400, detail="Invalid file path")

    try:
        size = 0
        chunk_size = 8192
        with open(file_path, "wb") as f:
            while True:
                chunk = await upload_file.read(chunk_size)
                if not chunk:
                    break
                size += len(chunk)
                if size > settings.MAX_FILE_SIZE:
                    cleanup_file(file_path)
                    raise HTTPException(
                        status_code=413,
                        detail=f"File too large. Maximum size: {settings.MAX_FILE_SIZE / 1024 / 1024}MB",
                    )
                f.write(chunk)
        logger.info(f"Saved async job file: {file_path} ({size} bytes)")
        return file_path
    except HTTPException:
        raise
    except Exception as e:
        cleanup_file(file_path)
        logger.error(f"Failed to save async job file: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save file: {e}")


def cleanup_async_job_dir(job_id: uuid.UUID) -> None:
    """
    Remove the entire async_jobs/{job_id}/ directory.

    Called when DB persistence fails after file save so no orphaned files remain.
    Errors are logged and swallowed — cleanup failure must not mask the DB failure.
    """
    job_dir = os.path.join(settings.UPLOAD_DIR, "async_jobs", str(job_id))
    try:
        if os.path.exists(job_dir):
            shutil.rmtree(job_dir)
            logger.debug(f"Cleaned up async job dir: {job_dir}")
    except Exception as e:
        logger.warning(f"Failed to cleanup async job dir {job_dir}: {e}")


def cleanup_file(file_path: str) -> None:
    """
    Remove file from disk

    Args:
        file_path: Path to file to remove
    """
    try:
        if os.path.exists(file_path):
            os.remove(file_path)
            logger.debug(f"Cleaned up file: {file_path}")
    except FileNotFoundError:
        # File already deleted, ignore
        logger.debug(f"File already deleted: {file_path}")
    except Exception as e:
        logger.warning(f"Failed to cleanup file {file_path}: {str(e)}")

