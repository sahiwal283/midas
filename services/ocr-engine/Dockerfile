FROM python:3.12-slim

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies.
# EasyOCR pulls CUDA-enabled PyTorch by default (~2GB+ extra). CPU wheels are enough for this API
# (primary paths: Document AI, Vision, Tesseract subprocesses).
COPY requirements.txt .
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu \
    && grep -v '^easyocr' requirements.txt > /tmp/requirements_no_easyocr.txt \
    && pip install --no-cache-dir -r /tmp/requirements_no_easyocr.txt \
    && pip install --no-cache-dir easyocr==1.7.2 --no-deps

# RapidOCR ships without models; run one warmup inference at build time so the
# default PP-OCR det/cls/rec models are downloaded into the image layer and
# inference never needs network access at runtime.
RUN python -c "from PIL import Image, ImageDraw; img = Image.new('RGB', (400, 120), 'white'); d = ImageDraw.Draw(img); d.text((20, 40), 'WARMUP TOTAL 12.34', fill='black'); img.save('/tmp/rapidocr_warmup.png')" \
    && python -c "from rapidocr import RapidOCR; print(RapidOCR()('/tmp/rapidocr_warmup.png').txts)" \
    && rm /tmp/rapidocr_warmup.png

# Copy application code
COPY ./app ./app

# Create upload directory
RUN mkdir -p /tmp/ocr_uploads

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8000/health')" || exit 1

# Run the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

