"""
Async SQLAlchemy engine and session factory for the cost ledger.

DATABASE_URL is optional. When absent, all async_session() calls yield None
and ledger functions silently skip writes (best-effort mode).
"""

from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker

from app.utils.logger import setup_logger

logger = setup_logger(__name__)

_engine = None
_session_factory: Optional[async_sessionmaker] = None


def _make_async_url(url: str) -> str:
    """Ensure URL uses the asyncpg driver dialect."""
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


def init_db(database_url: str) -> None:
    """Initialise engine. Called once at application startup."""
    global _engine, _session_factory
    if _engine is not None:
        return
    try:
        _engine = create_async_engine(
            _make_async_url(database_url),
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
        )
        _session_factory = async_sessionmaker(_engine, expire_on_commit=False)
        logger.info("Cost ledger DB engine initialised")
    except Exception as exc:
        logger.error(f"Failed to initialise ledger DB engine: {exc}")
        _engine = None
        _session_factory = None


@asynccontextmanager
async def async_session() -> AsyncIterator[Optional[AsyncSession]]:
    """
    Yield an AsyncSession if the DB is configured, else yield None.

    Callers must check for None and skip writes when ledger is unavailable.
    """
    if _session_factory is None:
        yield None
        return

    session = _session_factory()
    try:
        yield session
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()
