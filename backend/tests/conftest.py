from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.app import deps, models  # noqa: F401 — models import registers tables on Base
from backend.app.database import Base
from backend.app.main import app


@pytest.fixture()
def db_engine():
    """A fresh in-memory SQLite database per test — never the real journal_dev.db file."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_connection, _connection_record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(bind=engine)
    yield engine
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def db_sessionmaker(db_engine):
    return sessionmaker(autocommit=False, autoflush=False, bind=db_engine)


@pytest.fixture()
def client(db_sessionmaker):
    def override_get_db():
        db = db_sessionmaker()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[deps.get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def set_plan(db_sessionmaker):
    """Puts a workspace on a plan directly in the DB — what a verified Razorpay payment does. Customers can no longer PATCH their own plan."""
    from backend.app import models

    def _set(workspace_id: str, plan: str) -> None:
        with db_sessionmaker() as db:
            db.get(models.Workspace, workspace_id).plan = plan
            db.commit()

    return _set
