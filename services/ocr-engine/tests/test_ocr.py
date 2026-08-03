"""
Basic tests for OCR endpoints
"""

import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_root():
    """Test root endpoint"""
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "running"
    assert "service" in data
    assert "version" in data


def test_health_check():
    """Test health check endpoint"""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"


def test_readiness_check():
    """Test readiness check endpoint"""
    response = client.get("/health/ready")
    assert response.status_code == 200
    data = response.json()
    assert "ready" in data
    assert "providers" in data


def test_liveness_check():
    """Test liveness check endpoint"""
    response = client.get("/health/live")
    assert response.status_code == 200
    data = response.json()
    assert data["alive"] == True


def test_providers_endpoint():
    """Test providers info endpoint"""
    response = client.get("/ocr/providers")
    assert response.status_code == 200
    data = response.json()
    assert "providers" in data
    assert "languages" in data


def test_ocr_no_file():
    """Test OCR endpoint without file"""
    response = client.post("/ocr/")
    assert response.status_code == 422  # Unprocessable entity


# Add more tests as needed with actual test images

