from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session as DBSession

from .. import health, models, observability, selftests
from ..deps import get_db
from ..staff import require_developer

# Every route here is developer-only (the role is re-read from the DB on each request) and read-only
# except the self-test trigger, which runs pure in-process checks. Nothing here can return a password,
# session token, or broker credential: stats carry names/counts/timings, and error text is scrubbed.
router = APIRouter(prefix="/api/dev", tags=["developer"], dependencies=[Depends(require_developer)])


@router.get("/health")
def get_health(db: DBSession = Depends(get_db)) -> dict:
    return health.build_health(db)


@router.get("/functions")
def get_functions(kind: str | None = Query(default=None, pattern="^(function|route|upstream)$")) -> dict:
    return {"functions": observability.all_stats(kind)}


@router.get("/errors")
def get_errors(limit: int = Query(default=50, ge=1, le=200)) -> dict:
    return {"errors": observability.recent_errors(limit)}


@router.post("/selftest/run")
def run_selftests() -> dict:
    return selftests.run_all()


@router.get("/selftest/last")
def last_selftests() -> dict:
    return {"last_run": selftests.last_run()}
