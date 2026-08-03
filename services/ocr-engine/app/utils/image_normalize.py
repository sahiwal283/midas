"""
Normalize uploaded images so cloud OCR receives supported formats and MIME types.

Telegram and mobile clients often send WebP or HEIC; Document AI expects JPEG/PNG/PDF/GIF/TIFF.
"""

from pathlib import Path

from app.utils.logger import setup_logger
from app.utils.file_utils import cleanup_file

logger = setup_logger(__name__)

# Extensions we convert to JPEG before OCR (Document AI / Vision compatibility).
_CONVERT_TO_JPEG = frozenset({"webp", "heif", "heic"})


def normalize_upload_for_ocr(file_path: str) -> str:
    """
    If the file is WebP/HEIC, convert to JPEG in the same directory and remove the original.

    Returns:
        Path to the file OCR should read (unchanged if already a common format).
    """
    ext = Path(file_path).suffix.lower().lstrip(".")
    if ext not in _CONVERT_TO_JPEG:
        return file_path

    try:
        from PIL import Image, UnidentifiedImageError

        with Image.open(file_path) as img:
            if img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            elif img.mode != "RGB":
                img = img.convert("RGB")

            new_path = str(Path(file_path).with_suffix(".jpg"))
            img.save(new_path, "JPEG", quality=92, optimize=True)

        if new_path != file_path:
            cleanup_file(file_path)
        logger.info(f"Normalized {ext} upload for OCR: {new_path}")
        return new_path
    except UnidentifiedImageError:
        logger.warning("Could not identify image for normalization, using original: %s", file_path)
        return file_path
    except Exception as e:
        logger.warning("Image normalization failed (%s), using original: %s", e, file_path)
        return file_path
