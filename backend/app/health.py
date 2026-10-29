from __future__ import annotations

import datetime as dt
import shutil
import time
from pathlib import Path
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session as DBSession

from . import models, observability
from .audit import AuditAction
from .config import settings
from .database import engine

try:  # optional: without it the host tile just reports disk and says how to get CPU/RAM
    import psutil
except ImportError:  # pragma: no cover
    psutil = None

_SEVERITY = {"idle": 0, "ok": 1, "warn": 2, "down": 3}


def _tile(key: str, label: str, status: str, summary: str, metrics: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "status": status,
        "summary": summary,
        "metrics": metrics or {},
        "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }


def _api_tile() -> dict[str, Any]:
    req = observability.request_summary()
    uptime = int(time.time() - observability.STARTED_AT)
    status, summary = "ok", f"{req['requests']} requests in the last 5 min"
    if req["requests"] == 0:
        status, summary = "ok", "No traffic in the last 5 min"
    elif req["server_errors"] >= 3 and req["error_rate"] >= 0.10:
        status, summary = "down", f"{req['server_errors']} server errors ({req['error_rate']:.0%}) in the last 5 min"
    elif req["server_errors"] >= 1 and req["error_rate"] >= 0.02:
        status, summary = "warn", f"{req['server_errors']} server error(s) in the last 5 min"
    elif (req["p95_ms"] or 0) > 2000:
        status, summary = "warn", f"Slow: p95 latency {req['p95_ms']} ms"
    return _tile("api", "API", status, summary, {**req, "uptime_seconds": uptime})


def _database_tile(db: DBSession) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        db.execute(text("SELECT 1"))
        query_ms = round((time.perf_counter() - started) * 1000, 2)
        counts = {
            "users": db.scalar(select(func.count()).select_from(models.User)) or 0,
            "workspaces": db.scalar(select(func.count()).select_from(models.Workspace)) or 0,
            "trading_accounts": db.scalar(select(func.count()).select_from(models.TradingAccount)) or 0,
            "trades": db.scalar(select(func.count()).select_from(models.Trade)) or 0,
        }
    except Exception as exc:
        observability.record_error("database", f"{type(exc).__name__}: {exc}")
        return _tile("database", "Database", "down", f"Cannot query the database: {type(exc).__name__}")

    metrics: dict[str, Any] = {"dialect": engine.dialect.name, "query_ms": query_ms, **counts}
    status, summary = "ok", f"{engine.dialect.name} responding in {query_ms} ms"
    if engine.dialect.name == "sqlite":
        path = Path(engine.url.database or "")
        if path.exists():
            metrics["db_file_mb"] = round(path.stat().st_size / 1_048_576, 2)
        free_pct = _disk_free_pct(path.parent if path.exists() else Path("."))
        metrics["disk_free_pct"] = free_pct
        if free_pct < 10:
            status, summary = "warn", f"Low disk space ({free_pct}% free)"
    if query_ms > 250 and status == "ok":
        status, summary = "warn", f"Slow query: {query_ms} ms"
    return _tile("database", "Database", status, summary, metrics)


def _disk_free_pct(path: Path) -> float:
    usage = shutil.disk_usage(path)
    return round(usage.free / usage.total * 100, 1)


def _auth_tile(db: DBSession) -> dict[str, Any]:
    now = dt.datetime.utcnow()
    hour_ago, quarter_ago = now - dt.timedelta(hours=1), now - dt.timedelta(minutes=15)

    def count(action: str, since: dt.datetime) -> int:
        return db.scalar(select(func.count()).select_from(models.AuditLog).where(models.AuditLog.action == action, models.AuditLog.created_at >= since)) or 0

    ok_1h, failed_1h = count(AuditAction.LOGIN_SUCCESS, hour_ago), count(AuditAction.LOGIN_FAILED, hour_ago)
    failed_15m = count(AuditAction.LOGIN_FAILED, quarter_ago)
    active_sessions = db.scalar(select(func.count()).select_from(models.Session).where(models.Session.expires_at > now)) or 0
    status, summary = "ok", f"{ok_1h} logins, {failed_1h} failed in the last hour"
    if failed_15m >= 20:
        status, summary = "down", f"Failed-login spike: {failed_15m} in 15 min"
    elif failed_1h >= 5 and failed_1h > ok_1h:
        status, summary = "warn", f"More failed logins ({failed_1h}) than successful ({ok_1h}) in the last hour"
    return _tile("auth", "Auth", status, summary, {"logins_1h": ok_1h, "failed_logins_1h": failed_1h, "failed_logins_15m": failed_15m, "active_sessions": active_sessions})


def _billing_tile(db: DBSession) -> dict[str, Any]:
    configured = not settings.razorpay_key_id.startswith("rzp_test_placeholder") and settings.razorpay_key_secret != "placeholder_secret"
    last_webhook = db.scalar(select(func.max(models.WebhookEvent.processed_at)))
    verify_failures = db.scalar(
        select(func.count()).select_from(models.AuditLog).where(
            models.AuditLog.action == AuditAction.PAYMENT_VERIFICATION_FAILED,
            models.AuditLog.created_at >= dt.datetime.utcnow() - dt.timedelta(hours=24),
        )
    ) or 0
    signature = observability.one_stat("security.verify_razorpay_signature")
    status, summary = "ok", "Razorpay configured"
    if not configured:
        status, summary = "warn", "Razorpay keys are still placeholders — checkout will fail"
    elif verify_failures:
        status, summary = "warn", f"{verify_failures} payment verification failure(s) in 24 h"
    return _tile(
        "billing", "Billing (Razorpay)", status, summary,
        {
            "configured": configured,
            "last_webhook_at": last_webhook.isoformat() if last_webhook else None,
            "verification_failures_24h": verify_failures,
            "signature_checks": signature["calls"] if signature else 0,
        },
    )


def _upstream_tile(key: str, label: str, stat_name: str, secret_configured: bool | None, note: str) -> dict[str, Any]:
    stat = observability.one_stat(stat_name)
    metrics: dict[str, Any] = {"secret_configured": secret_configured} if secret_configured is not None else {}
    if stat:
        metrics.update({k: stat[k] for k in ("calls", "errors", "recent_calls", "recent_errors", "p50_ms", "p95_ms", "last_success", "last_error", "last_error_message")})
    if secret_configured is False:
        return _tile(key, label, "warn", f"Server secret not set — {note}", metrics)
    if not stat:
        return _tile(key, label, "idle", "No calls yet since the server started", metrics)
    summaries = {
        "ok": f"{stat['calls']} call(s), {stat['errors']} failed in total",
        "warn": f"{stat['recent_errors']} of {stat['recent_calls']} recent calls failed",
        "down": f"Failing: {stat['recent_errors']} of {stat['recent_calls']} recent calls failed",
        "idle": "No recent calls",
    }
    return _tile(key, label, stat["status"], summaries[stat["status"]], metrics)


def _angel_tile(db: DBSession) -> dict[str, Any]:
    stored = db.scalar(select(func.count()).select_from(models.BrokerConnection)) or 0
    return _tile("angelone", "Angel One (server-side)", "ok" if stored else "idle", f"{stored} stored encrypted connection(s) — values are never shown", {"stored_connections": stored})


def _email_tile() -> dict[str, Any]:
    return _tile("email", "Email", "warn", "No email provider wired — password reset returns its token in the API response", {"configured": False, "reset_token_exposed": settings.expose_reset_token_in_response})


def _host_tile() -> dict[str, Any]:
    disk_free = _disk_free_pct(Path("."))
    metrics: dict[str, Any] = {"disk_free_pct": disk_free}
    status, summary = "ok", f"Disk {disk_free}% free"
    if psutil is not None:
        cpu, mem = psutil.cpu_percent(interval=None), psutil.virtual_memory().percent
        metrics.update({"cpu_pct": cpu, "memory_pct": mem})
        summary = f"CPU {cpu}% · RAM {mem}% · disk {disk_free}% free"
        if mem > 90 or cpu > 95:
            status = "warn"
    else:
        summary += " (install psutil for CPU/RAM)"
    if disk_free < 10:
        status = "warn"
    return _tile("host", "Host", status, summary, metrics)


def _telemetry_tile() -> dict[str, Any]:
    return _tile("browser_sync", "Browser sync telemetry", "idle", "Opt-in telemetry is not enabled — broker sync runs in each user's browser and is invisible to the server", {})


def config_checks() -> list[dict[str, Any]]:
    """Production-readiness gates. Informational: red here in local dev is expected and does not affect overall health."""
    def check(key: str, label: str, ok: bool, detail: str) -> dict[str, Any]:
        return {"key": key, "label": label, "ok": ok, "detail": detail}

    cors_local = any("localhost" in origin or "127.0.0.1" in origin for origin in settings.cors_origins)
    return [
        check("cookie_secure", "Session cookie is Secure", settings.cookie_secure, "Set JOURNAL_COOKIE_SECURE=true once served over HTTPS"),
        check("reset_token", "Reset token not returned in API response", not settings.expose_reset_token_in_response, "Set JOURNAL_EXPOSE_RESET_TOKEN_IN_RESPONSE=false and wire an email provider"),
        check("database", "Production database (not SQLite)", engine.dialect.name != "sqlite", f"Currently {engine.dialect.name}"),
        check("cors", "CORS origins are not localhost", not cors_local, "Replace local origins with the real frontend origin"),
        check("encryption_key", "Broker encryption key set explicitly", bool(settings.broker_encryption_key.strip()), "Set JOURNAL_BROKER_ENCRYPTION_KEY per environment"),
        check("razorpay", "Razorpay keys configured", not settings.razorpay_key_id.startswith("rzp_test_placeholder"), "Real keys come from backend/.env"),
        check("upstox_secret", "Upstox client secret configured", bool(settings.upstox_client_secret), "Value is never shown"),
        check("zerodha_secret", "Zerodha API secret configured", bool(settings.zerodha_api_secret), "Value is never shown"),
    ]


def build_health(db: DBSession) -> dict[str, Any]:
    tiles = [
        _api_tile(),
        _database_tile(db),
        _auth_tile(db),
        _billing_tile(db),
        _upstream_tile("upstox", "Upstox token exchange", "upstox.exchange_token", bool(settings.upstox_client_secret), "set JOURNAL_UPSTOX_CLIENT_SECRET"),
        _upstream_tile("zerodha", "Zerodha token exchange", "zerodha.exchange_token", bool(settings.zerodha_api_secret), "set JOURNAL_ZERODHA_API_SECRET"),
        _upstream_tile("dhan", "Dhan proxy", "dhan.get_trades", None, ""),
        _angel_tile(db),
        _email_tile(),
        _host_tile(),
        _telemetry_tile(),
    ]
    overall = max((t["status"] for t in tiles), key=lambda s: _SEVERITY[s])
    return {
        "overall": overall if overall != "idle" else "ok",
        "started_at": dt.datetime.fromtimestamp(observability.STARTED_AT, dt.timezone.utc).isoformat(),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "tiles": tiles,
        "config_checks": config_checks(),
    }
