import os

# Disable uvloop
os.environ["UVICORN_LOOP"] = "asyncio"

bind = "0.0.0.0:8000"
workers = 4
worker_class = "uvicorn.workers.UvicornWorker"
timeout = 120
accesslog = "-"
errorlog = "-"
loglevel = "info"

# Force asyncio loop instead of uvloop
worker_connections = 1000
