from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect, select, text

from . import models  # noqa: F401 — imported so Base knows about them before create_all
from .config import settings
from .database import Base, SessionLocal, engine
from .routers import accounts, auth, billing, broker, invitations, portfolio_invitations, portfolios, trades, upstox, workspaces, zerodha

app = FastAPI(title="Trading Journal API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    # Dev convenience: also accept the page being opened from a private-LAN address (phone on the same Wi-Fi).
    allow_origin_regex=r"^https?://(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$",
    allow_credentials=True,  # required for the session cookie to be sent cross-port (5173 -> 8000)
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(workspaces.router)
app.include_router(accounts.router)
app.include_router(invitations.router)
app.include_router(broker.router)
app.include_router(trades.router)
app.include_router(portfolios.router)
app.include_router(portfolio_invitations.router)
app.include_router(billing.router)
app.include_router(upstox.router)
app.include_router(zerodha.router)


@app.on_event("startup")
def on_startup() -> None:
    # Local-dev convenience only: creates any missing tables against
    # journal_dev.db. A real migration tool (Alembic) replaces this once
    # there's a schema to migrate, not just create.
    Base.metadata.create_all(bind=engine)
    _ensure_payment_plan_columns()


def _ensure_payment_plan_columns() -> None:
    """
    `create_all` only creates missing tables, not missing columns on a table
    that already exists — `payments` predates `plan_name`/`billing_cycle`.
    Adds them on first run after the upgrade (portable SQL, SQLite + Postgres
    both support plain ADD COLUMN) and backfills any existing rows from their
    subscription's current plan/cycle, since those are the best guess we have
    for payments recorded before this column existed.
    """
    existing_columns = {col["name"] for col in inspect(engine).get_columns("payments")}
    missing = {"plan_name", "billing_cycle"} - existing_columns
    if not missing:
        return

    with engine.begin() as conn:
        if "plan_name" in missing:
            conn.execute(text("ALTER TABLE payments ADD COLUMN plan_name VARCHAR(20)"))
        if "billing_cycle" in missing:
            conn.execute(text("ALTER TABLE payments ADD COLUMN billing_cycle VARCHAR(20)"))

    with SessionLocal() as db:
        unbackfilled = db.scalars(select(models.Payment).where(models.Payment.plan_name.is_(None))).all()
        for payment in unbackfilled:
            subscription = db.get(models.Subscription, payment.subscription_id)
            if subscription is not None:
                payment.plan_name = subscription.plan_name
                payment.billing_cycle = subscription.billing_cycle
                db.add(payment)
        db.commit()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
