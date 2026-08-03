# OCR Microservice

A standalone REST API service for OCR (Optical Character Recognition) processing of receipts and invoices. This service was extracted from the Expense App to enable independent deployment, scaling, and reuse across multiple applications.

## Overview

The OCR Microservice provides high-accuracy text extraction and structured field inference from receipt and invoice images. It supports multiple OCR providers (Tesseract, EasyOCR) with automatic fallback and confidence-based quality assessment.

### Key Features

- **Multiple OCR Providers**: Tesseract (CPU-compatible), EasyOCR (high accuracy)
- **Automatic Fallback**: Falls back to secondary provider if primary confidence is low
- **Field Extraction**: Intelligent extraction of merchant, amount, date, category, etc.
- **PDF Support**: Multi-page PDF processing
- **Quality Assessment**: Confidence scoring and review flagging
- **Category Prediction**: Rule-based expense category suggestions
- **RESTful API**: Clean FastAPI interface with OpenAPI docs
- **Dockerized**: Ready for container orchestration
- **Health Checks**: Kubernetes-ready liveness and readiness probes

## Architecture

```
ocrService/
├── app/
│   ├── main.py                 # FastAPI application
│   ├── config.py               # Configuration management
│   ├── routes/
│   │   ├── health.py           # Health check endpoints
│   │   └── ocr.py              # OCR processing endpoints
│   ├── services/
│   │   ├── ocr_engine.py       # OCR orchestration
│   │   ├── postprocess.py      # Field inference
│   │   ├── tesseract_processor.py
│   │   ├── easyocr_processor.py
│   │   └── pdf_processor.py
│   └── utils/
│       ├── logger.py
│       └── file_utils.py
├── sample_data/                # Test images
├── tests/                      # Unit tests
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
└── README.md
```

## Quick Start

### Local Development

1. **Install Dependencies**

```bash
# Install Python 3.10+
python3 --version

# Install system dependencies (Ubuntu/Debian)
sudo apt-get update
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng poppler-utils

# Install system dependencies (macOS)
brew install tesseract poppler

# Install Python dependencies
pip install -r requirements.txt
```

2. **Configure Environment**

```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Run Service**

```bash
# Development mode (auto-reload)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Production mode
python -m app.main
```

4. **Access API**

- API: http://localhost:8000
- Docs: http://localhost:8000/docs
- Health: http://localhost:8000/health

### Docker Deployment

1. **Build and Run**

```bash
# Build image
docker build -t ocr-service:latest .

# Run container
docker run -d -p 8000:8000 --name ocr_service ocr-service:latest

# Or use docker-compose
docker-compose up -d
```

2. **View Logs**

```bash
docker logs -f ocr_service
```

3. **Stop Service**

```bash
docker-compose down
```

## API Endpoints

### Health Checks

#### GET /health
Basic health check

**Response:**
```json
{
  "status": "ok",
  "service": "OCR Microservice",
  "version": "0.1.0",
  "environment": "production",
  "timestamp": "2024-01-01T12:00:00"
}
```

#### GET /health/ready
Readiness check (includes provider availability)

**Response:**
```json
{
  "ready": true,
  "service": "OCR Microservice",
  "providers": {
    "tesseract": true,
    "easyocr": false
  },
  "timestamp": "2024-01-01T12:00:00"
}
```

### OCR Processing

#### POST /ocr/
Process image or PDF with OCR

**Request:**
- Method: POST
- Content-Type: multipart/form-data
- Body: `file` (image or PDF)

**Supported Formats:**
- Images: JPEG, PNG, HEIC, WebP
- Documents: PDF (multi-page supported)

**Example:**
```bash
curl -X POST http://localhost:8000/ocr/ \
  -F "file=@receipt.jpg"
```

**Response:**
```json
{
  "success": true,
  "ocr": {
    "text": "Starbucks\n123 Main St\n...",
    "confidence": 0.92,
    "provider": "tesseract",
    "processingTime": 1234
  },
  "fields": {
    "merchant": {
      "value": "Starbucks",
      "confidence": 0.95,
      "source": "inference"
    },
    "amount": {
      "value": 12.50,
      "confidence": 0.98,
      "source": "inference"
    },
    "date": {
      "value": "2024-01-15",
      "confidence": 0.95,
      "source": "inference"
    },
    "cardLastFour": {
      "value": "1234",
      "confidence": 0.90,
      "source": "inference"
    },
    "category": {
      "value": "Meal and Entertainment",
      "confidence": 0.85,
      "source": "inference"
    }
  },
  "categories": [
    {
      "category": "Meal and Entertainment",
      "confidence": 0.85,
      "keywords": ["coffee", "starbucks"],
      "source": "rule-based"
    }
  ],
  "quality": {
    "overallConfidence": 0.91,
    "needsReview": false,
    "reviewReasons": null
  }
}
```

#### GET /ocr/providers
Get OCR provider information

**Response:**
```json
{
  "providers": {
    "primary": "tesseract",
    "fallback": "easyocr",
    "availability": {
      "tesseract": true,
      "easyocr": true
    }
  },
  "languages": ["en"],
  "confidenceThreshold": 0.6
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENVIRONMENT` | Environment (development, production) | `development` |
| `PRIMARY_OCR_PROVIDER` | Primary OCR engine (tesseract, easyocr) | `tesseract` |
| `FALLBACK_OCR_PROVIDER` | Fallback OCR engine | `None` |
| `OCR_CONFIDENCE_THRESHOLD` | Minimum confidence for primary provider | `0.6` |
| `PYTHON_PATH` | Python interpreter path | `python3` |
| `MAX_FILE_SIZE` | Max upload file size (bytes) | `10485760` |
| `UPLOAD_DIR` | Temporary file upload directory | `/tmp/ocr_uploads` |
| `LOG_LEVEL` | Logging level (DEBUG, INFO, WARNING, ERROR) | `INFO` |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated) | `*` |

## OCR Providers

### Tesseract
- **Pros**: CPU-compatible, reliable, no external dependencies
- **Cons**: Lower accuracy on complex layouts
- **Best For**: Standard receipts with good quality
- **Configuration**: `PRIMARY_OCR_PROVIDER=tesseract`

### EasyOCR
- **Pros**: High accuracy (80-90%), handles rotated text, 80+ languages
- **Cons**: Slower, larger memory footprint
- **Best For**: Complex receipts, degraded images
- **Configuration**: `PRIMARY_OCR_PROVIDER=easyocr`

## Field Extraction

The service extracts the following fields from receipts:

| Field | Description | Example |
|-------|-------------|---------|
| `merchant` | Business name | "Starbucks" |
| `amount` | Total amount | 12.50 |
| `date` | Transaction date (ISO format) | "2024-01-15" |
| `cardLastFour` | Last 4 digits of card | "1234" |
| `category` | Expense category | "Meal and Entertainment" |
| `location` | Address/city/state | "San Francisco, CA" |
| `taxAmount` | Tax amount | 1.25 |
| `tipAmount` | Tip/gratuity | 2.50 |

## Confidence Scoring

Each field includes a confidence score (0-1):
- **0.9-1.0**: High confidence (likely correct)
- **0.7-0.9**: Medium confidence (review recommended)
- **0.0-0.7**: Low confidence (manual verification needed)

The service also provides an overall confidence score and flags receipts that need review.

## Integration with Expense App

The Expense App should call the OCR service via HTTP:

```javascript
// Example integration
const OCR_BASE_URL = process.env.OCR_BASE_URL || 'http://localhost:8000';

async function processReceipt(file) {
  const formData = new FormData();
  formData.append('file', file);
  
  const response = await fetch(`${OCR_BASE_URL}/ocr/`, {
    method: 'POST',
    body: formData
  });
  
  return await response.json();
}
```

## Future Enhancements

### Planned Features (Not Yet Implemented)

1. **Shared Training Data Pool**
   - Centralized dataset for model training
   - External mount for large datasets
   - Collaborative learning across instances

2. **LLM Integration**
   - Optional LLM-based field enhancement
   - Support for OpenAI, Claude, Ollama
   - Hybrid inference (rules + LLM)

3. **Model Retraining**
   - Automatic retraining on 24-hour schedule
   - User correction feedback loop
   - Incremental learning

4. **Caching**
   - Redis-based result caching
   - Duplicate detection
   - Performance optimization

5. **Analytics**
   - OCR accuracy tracking
   - Performance metrics
   - Provider comparison

## Testing

```bash
# Run unit tests
pytest tests/

# Run with coverage
pytest --cov=app tests/

# Test specific endpoint
curl -X GET http://localhost:8000/health
```

## Monitoring

The service provides several health check endpoints for monitoring:

- `/health` - Basic liveness check
- `/health/ready` - Readiness check (validates OCR providers)
- `/health/live` - Simple liveness probe

These endpoints are compatible with Kubernetes liveness/readiness probes.

## Deployment

### Production Deployment

1. **Environment Variables**
   - Set `ENVIRONMENT=production`
   - Configure `PRIMARY_OCR_PROVIDER` based on hardware
   - Set appropriate `LOG_LEVEL=WARNING` or `ERROR`

2. **Resource Requirements**
   - CPU: 2+ cores recommended
   - RAM: 2GB minimum, 4GB recommended
   - Storage: 1GB for dependencies + upload directory

3. **Scaling**
   - Horizontal: Deploy multiple instances behind load balancer
   - Vertical: Increase CPU/RAM for faster processing

### Docker Compose (Production)

```yaml
version: "3.9"
services:
  ocr_service:
    image: ocr-service:0.1.0
    container_name: ocr_service
    restart: always
    ports:
      - "8000:8000"
    environment:
      - ENVIRONMENT=production
      - PRIMARY_OCR_PROVIDER=tesseract
      - LOG_LEVEL=WARNING
    volumes:
      - /var/ocr_uploads:/tmp/ocr_uploads
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Troubleshooting

### Common Issues

**Issue: "Tesseract not found"**
- Solution: Install tesseract-ocr system package
- Ubuntu: `sudo apt-get install tesseract-ocr`
- macOS: `brew install tesseract`

**Issue: "PDF processing fails"**
- Solution: Install poppler-utils
- Ubuntu: `sudo apt-get install poppler-utils`
- macOS: `brew install poppler`

**Issue: "Low OCR confidence"**
- Solution: Try EasyOCR provider (`PRIMARY_OCR_PROVIDER=easyocr`)
- Or increase image DPI before upload

**Issue: "File upload fails"**
- Check `MAX_FILE_SIZE` environment variable
- Ensure `UPLOAD_DIR` exists and is writable

## Version History

### v0.1.0 (Initial Release)
- Core OCR functionality with Tesseract and EasyOCR
- Field extraction and inference
- PDF support
- FastAPI REST interface
- Docker containerization
- Health checks and monitoring

## License

This project is part of the Expense App ecosystem.

## Support

For issues or questions, contact the development team or open an issue in the repository.

