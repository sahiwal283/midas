#!/usr/bin/env python3
"""
RapidOCR Processor for Receipt Processing

PaddleOCR PP-OCR detection/recognition models exported to ONNX and executed
via onnxruntime. This is the same model family SnapOtter/PaddleOCR use on GPU,
but the ONNX CPU path runs fast on modest hardware and needs no CUDA.

Why this provider exists:
- Tesseract struggles on real-world receipts (thermal paper, skew, dot-matrix).
- EasyOCR is accurate but drags in PyTorch and is slow on CPU.
- RapidOCR gives PaddleOCR-grade accuracy with a small onnxruntime footprint.

Hardware: CPU-only friendly, including AVX-only CPUs (no AVX2 required).
Models are baked into the Docker image at build time (see Dockerfile warmup),
so no network access is needed at inference time.

Output contract matches tesseract_processor.py: JSON on stdout with
success/text/confidence/line_count/lines/provider/metadata.
"""

import argparse
import json
import sys
import time
import warnings

warnings.filterwarnings('ignore')

PROVIDER_NAME = "rapidocr"


def _fail(message: str) -> None:
    print(json.dumps({
        "success": False,
        "error": message,
        "text": "",
        "confidence": 0.0,
        "provider": PROVIDER_NAME
    }))
    sys.exit(1)


def _load_engine():
    """
    Load a RapidOCR engine, preferring the current unified `rapidocr` package
    (v2/v3 API) and falling back to the legacy `rapidocr_onnxruntime` package
    (v1 API, models bundled in the wheel).

    Returns:
        Tuple of (engine, api_version) where api_version is "v3" or "v1".
    """
    try:
        from rapidocr import RapidOCR  # v2/v3 unified package
        return RapidOCR(), "v3"
    except ImportError:
        pass

    try:
        from rapidocr_onnxruntime import RapidOCR  # legacy package
        return RapidOCR(), "v1"
    except ImportError as e:
        raise ImportError(f"rapidocr not installed: {e}")


def _extract_lines(raw_result, api_version: str):
    """
    Normalize engine output to a list of {"text": str, "confidence": float}.

    v3 API returns a RapidOCROutput object with .txts and .scores tuples.
    v1 API returns (list_of_[box, text, score], elapse).
    """
    lines = []

    if api_version == "v3":
        txts = getattr(raw_result, "txts", None) or ()
        scores = getattr(raw_result, "scores", None) or ()
        for i, txt in enumerate(txts):
            score = float(scores[i]) if i < len(scores) else 0.0
            lines.append({"text": str(txt), "confidence": score})
    else:
        result = raw_result[0] if isinstance(raw_result, tuple) else raw_result
        for entry in result or []:
            # entry: [box, text, score]
            if len(entry) >= 3:
                lines.append({"text": str(entry[1]), "confidence": float(entry[2])})

    return lines


def main() -> None:
    parser = argparse.ArgumentParser(description="RapidOCR receipt processor")
    parser.add_argument("image_path", help="Path to image file")
    parser.add_argument("--lang", default="eng",
                        help="Language hint (informational; default models cover en)")
    parser.add_argument("--min-confidence", type=float, default=0.0,
                        help="Drop lines below this recognition confidence")
    args = parser.parse_args()

    try:
        start = time.perf_counter()
        engine, api_version = _load_engine()
        load_seconds = time.perf_counter() - start
    except ImportError as e:
        _fail(f"Missing dependency: {e}")
        return

    try:
        start = time.perf_counter()
        if api_version == "v3":
            raw_result = engine(args.image_path)
        else:
            raw_result = engine(args.image_path)
        infer_seconds = time.perf_counter() - start

        lines = _extract_lines(raw_result, api_version)
        if args.min_confidence > 0:
            lines = [ln for ln in lines if ln["confidence"] >= args.min_confidence]

        text = "\n".join(ln["text"] for ln in lines)
        confidence = (
            sum(ln["confidence"] for ln in lines) / len(lines) if lines else 0.0
        )

        output = {
            "success": True,
            "text": text,
            "confidence": round(confidence, 4),
            "line_count": len(lines),
            "lines": lines,
            "provider": PROVIDER_NAME,
            "metadata": {
                "api_version": api_version,
                "detection_count": len(lines),
                "language": args.lang,
                "engine_load_seconds": round(load_seconds, 3),
                "inference_seconds": round(infer_seconds, 3),
            }
        }
        print(json.dumps(output, indent=2))
        sys.exit(0)

    except Exception as e:
        _fail(str(e))


if __name__ == "__main__":
    main()
