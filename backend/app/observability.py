from __future__ import annotations

import datetime as dt
import functools
import re
import threading
import time
import uuid
from collections import deque
from typing import Any, Callable

# In-memory by design (phase 1): cheap, no extra table, nothing sensitive persisted. The trade-off is
# that stats reset when the server restarts — `started_at` on the health payload makes that visible.
_lock = threading.Lock()
STARTED_AT = time.time()
_WINDOW = 500  # recent calls kept per tracked name — percentiles/error-rates are computed over these

_stats: dict[str, "_Stat"] = {}
_requests: deque[tuple[float, int, float]] = deque(maxlen=5000)  # (ts, status, ms) — every real API request
_errors: deque[dict[str, Any]] = deque(maxlen=200)

# Never let a secret reach the dev panel via an error message.
_SECRET_KV = re.compile(r"(?i)(password|passwd|token|secret|authorization|api[_-]?key|pin|totp)\s*[=:]\s*\S+")
_LONG_TOKEN = re.compile(r"[A-Za-z0-9_\-\.]{24,}")


def scrub(text: str, limit: int = 300) -> str:
    cleaned = _SECRET_KV.sub(lambda m: f"{m.group(1)}=[redacted]", text)
    cleaned = _LONG_TOKEN.sub("[redacted]", cleaned)
    return cleaned[:limit]


class _Stat:
    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.calls = 0
        self.errors = 0
        self.window: deque[tuple[float, bool, float]] = deque(maxlen=_WINDOW)  # (ts, ok, ms)
        self.last_success: float | None = None
        self.last_error: float | None = None
        self.last_error_message: str | None = None


def _iso(ts: float | None) -> str | None:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat() if ts else None


def record(name: str, ok: bool, ms: float, error: str | None = None, kind: str = "function") -> None:
    now = time.time()
    with _lock:
        stat = _stats.get(name)
        if stat is None:
            stat = _stats[name] = _Stat(kind)
        stat.calls += 1
        stat.window.append((now, ok, ms))
        if ok:
            stat.last_success = now
        else:
            stat.errors += 1
            stat.last_error = now
            stat.last_error_message = scrub(error or "failed")


def record_error(component: str, message: str, request_id: str | None = None, path: str | None = None, status: int | None = None) -> None:
    with _lock:
        _errors.appendleft(
            {
                "ts": _iso(time.time()),
                "component": component,
                "message": scrub(message),
                "request_id": request_id,
                "path": path,
                "status": status,
            }
        )


def _percentile(sorted_values: list[float], pct: float) -> float | None:
    if not sorted_values:
        return None
    index = min(len(sorted_values) - 1, int(round(pct / 100 * (len(sorted_values) - 1))))
    return round(sorted_values[index], 2)


def _summarise(name: str, stat: _Stat, recent_seconds: float = 300) -> dict[str, Any]:
    cutoff = time.time() - recent_seconds
    durations = sorted(ms for _, _, ms in stat.window)
    recent = [(ok) for ts, ok, _ in stat.window if ts >= cutoff]
    recent_errors = sum(1 for ok in recent if not ok)
    return {
        "name": name,
        "kind": stat.kind,
        "calls": stat.calls,
        "errors": stat.errors,
        "recent_calls": len(recent),
        "recent_errors": recent_errors,
        "recent_error_rate": round(recent_errors / len(recent), 4) if recent else 0.0,
        "p50_ms": _percentile(durations, 50),
        "p95_ms": _percentile(durations, 95),
        "p99_ms": _percentile(durations, 99),
        "last_success": _iso(stat.last_success),
        "last_error": _iso(stat.last_error),
        "last_error_message": stat.last_error_message,
        "status": _status_for(len(recent), recent_errors, stat.calls),
    }


def _status_for(recent_calls: int, recent_errors: int, total_calls: int) -> str:
    """idle = never/not recently called, ok / warn / down by the share of recent calls that failed."""
    if recent_calls == 0:
        return "idle" if total_calls == 0 else "ok"
    rate = recent_errors / recent_calls
    if recent_errors >= 3 and rate >= 0.5:
        return "down"
    if recent_errors >= 1 and rate >= 0.1:
        return "warn"
    return "ok"


def all_stats(kind: str | None = None) -> list[dict[str, Any]]:
    with _lock:
        rows = [_summarise(name, stat) for name, stat in _stats.items() if kind is None or stat.kind == kind]
    return sorted(rows, key=lambda r: (r["status"] == "ok", r["status"] == "idle", r["name"]))


def one_stat(name: str) -> dict[str, Any] | None:
    with _lock:
        stat = _stats.get(name)
        return _summarise(name, stat) if stat else None


def recent_errors(limit: int = 50) -> list[dict[str, Any]]:
    with _lock:
        return list(_errors)[:limit]


def request_summary(window_seconds: float = 300) -> dict[str, Any]:
    cutoff = time.time() - window_seconds
    with _lock:
        recent = [(status, ms) for ts, status, ms in _requests if ts >= cutoff]
        total = len(_requests)
    durations = sorted(ms for _, ms in recent)
    server_errors = sum(1 for status, _ in recent if status >= 500)
    return {
        "window_seconds": window_seconds,
        "requests": len(recent),
        "total_since_start": total,
        "server_errors": server_errors,
        "error_rate": round(server_errors / len(recent), 4) if recent else 0.0,
        "p50_ms": _percentile(durations, 50),
        "p95_ms": _percentile(durations, 95),
        "p99_ms": _percentile(durations, 99),
    }


def reset_for_tests() -> None:
    with _lock:
        _stats.clear()
        _requests.clear()
        _errors.clear()


class track:
    """
    `with track("upstox.exchange_token") as t:` — times the block, counts an exception as a failure
    (and re-raises it), and lets the caller mark a *logical* failure without raising via `t.fail(msg)`.
    A fresh instance per use, so concurrent requests never share state.
    """

    def __init__(self, name: str, kind: str = "function") -> None:
        self.name = name
        self.kind = kind
        self._failure: str | None = None
        self._start = 0.0

    def fail(self, message: str) -> None:
        self._failure = message

    def __enter__(self) -> "track":
        self._start = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc, _tb) -> bool:  # noqa: ANN001
        ms = (time.perf_counter() - self._start) * 1000
        # An HTTPException below 500 (401/403/404/400...) is the code correctly refusing a request, not the
        # function being broken — it must not make a healthy authz/validation function look faulty.
        if exc is not None and getattr(exc, "status_code", 500) < 500:
            record(self.name, True, ms, kind=self.kind)
        elif exc is not None:
            message = f"{exc_type.__name__}: {exc}"
            record(self.name, False, ms, message, self.kind)
            record_error(self.name, message)
        elif self._failure is not None:
            record(self.name, False, ms, self._failure, self.kind)
            record_error(self.name, self._failure)
        else:
            record(self.name, True, ms, kind=self.kind)
        return False  # never swallow the exception


def tracked(name: str, kind: str = "function") -> Callable:
    """
    Decorator for plain helper functions (hashing, signature checks, plan math). Deliberately NOT used on
    FastAPI route handlers: wrapping a handler hides its string annotations from FastAPI, so routes are
    covered by the request middleware instead.
    """

    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with track(name, kind):
                return fn(*args, **kwargs)

        return wrapper

    return decorator


_SKIP_PREFIXES = ("/api/dev/", "/api/health", "/healthz", "/readyz", "/docs", "/openapi.json")


async def observability_middleware(request, call_next):  # noqa: ANN001
    """Request id + per-route timing/error stats. The dev panel's own polling is excluded so it can't skew the numbers."""
    request_id = uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    path = request.url.path
    skip = path.startswith(_SKIP_PREFIXES)
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception as exc:
        ms = (time.perf_counter() - start) * 1000
        if not skip:
            with _lock:
                _requests.append((time.time(), 500, ms))
            record(f"{request.method} {path}", False, ms, f"{type(exc).__name__}: {exc}", "route")
            record_error("api", f"{type(exc).__name__}: {exc}", request_id, path, 500)
        raise

    ms = (time.perf_counter() - start) * 1000
    if not skip:
        route = request.scope.get("route")
        template = getattr(route, "path", None) or path
        ok = response.status_code < 500
        with _lock:
            _requests.append((time.time(), response.status_code, ms))
        record(f"{request.method} {template}", ok, ms, None if ok else f"HTTP {response.status_code}", "route")
        if not ok:
            record_error("api", f"HTTP {response.status_code}", request_id, template, response.status_code)
    response.headers["X-Request-ID"] = request_id
    return response
