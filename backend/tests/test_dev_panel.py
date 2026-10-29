from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.app import models, observability, selftests
from backend.app.observability import scrub, track, tracked
from backend.app.staff import PlatformRole

DEV_GET_ROUTES = ["/api/dev/health", "/api/dev/functions", "/api/dev/errors", "/api/dev/selftest/last"]


def _signup(client, email, password="password123"):
    r = client.post("/api/auth/signup", json={"email": email, "password": password, "display_name": email.split("@")[0]})
    assert r.status_code == 201
    return r


def _set_role(db_sessionmaker, email, role):
    with db_sessionmaker() as db:
        user = db.scalar(select(models.User).where(models.User.email == email))
        user.platform_role = role
        db.commit()


@pytest.fixture(autouse=True)
def _fresh_stats():
    observability.reset_for_tests()
    yield
    observability.reset_for_tests()


# ---- access control -------------------------------------------------------------------------------


@pytest.mark.parametrize("path", DEV_GET_ROUTES)
def test_dev_routes_require_authentication(client, path):
    assert client.get(path).status_code == 401


def test_dev_selftest_run_requires_authentication(client):
    assert client.post("/api/dev/selftest/run").status_code == 401


@pytest.mark.parametrize("role", [PlatformRole.USER, PlatformRole.ADMIN])
def test_non_developers_get_403_on_every_dev_route(client, db_sessionmaker, role):
    _signup(client, "staff@example.com")
    _set_role(db_sessionmaker, "staff@example.com", role)
    for path in DEV_GET_ROUTES:
        assert client.get(path).status_code == 403, path
    assert client.post("/api/dev/selftest/run").status_code == 403


def test_developer_can_call_every_dev_route(client, db_sessionmaker):
    _signup(client, "dev@example.com")
    _set_role(db_sessionmaker, "dev@example.com", PlatformRole.DEVELOPER)
    for path in DEV_GET_ROUTES:
        assert client.get(path).status_code == 200, path
    assert client.post("/api/dev/selftest/run").status_code == 200


def test_demotion_takes_effect_on_the_next_request(client, db_sessionmaker):
    _signup(client, "dev2@example.com")
    _set_role(db_sessionmaker, "dev2@example.com", PlatformRole.DEVELOPER)
    assert client.get("/api/dev/health").status_code == 200
    _set_role(db_sessionmaker, "dev2@example.com", PlatformRole.USER)
    assert client.get("/api/dev/health").status_code == 403


def test_me_exposes_platform_role_defaulting_to_user(client, db_sessionmaker):
    assert _signup(client, "plain@example.com").json()["user"]["platform_role"] == "USER"
    _set_role(db_sessionmaker, "plain@example.com", PlatformRole.DEVELOPER)
    assert client.get("/api/auth/me").json()["user"]["platform_role"] == "DEVELOPER"


# ---- health payload ---------------------------------------------------------------------------------


def test_health_payload_has_every_tile_and_valid_statuses(client, db_sessionmaker):
    _signup(client, "dev3@example.com")
    _set_role(db_sessionmaker, "dev3@example.com", PlatformRole.DEVELOPER)
    body = client.get("/api/dev/health").json()
    keys = {t["key"] for t in body["tiles"]}
    assert {"api", "database", "auth", "billing", "upstox", "zerodha", "dhan", "angelone", "email", "host", "browser_sync"} <= keys
    assert all(t["status"] in {"ok", "warn", "down", "idle"} for t in body["tiles"])
    assert body["overall"] in {"ok", "warn", "down"}
    assert next(t for t in body["tiles"] if t["key"] == "database")["status"] in {"ok", "warn"}
    assert len(body["config_checks"]) >= 6


def test_health_never_contains_secret_values(client, db_sessionmaker):
    _signup(client, "dev4@example.com", password="SuperSecretPw123")
    _set_role(db_sessionmaker, "dev4@example.com", PlatformRole.DEVELOPER)
    text = client.get("/api/dev/health").text + client.get("/api/dev/functions").text + client.get("/api/dev/errors").text
    for secret in ("SuperSecretPw123", "placeholder_secret", "placeholder_webhook_secret"):
        assert secret not in text


# ---- tracking ---------------------------------------------------------------------------------------


def test_track_counts_success_failure_and_does_not_swallow_exceptions():
    with track("t.ok"):
        pass
    with pytest.raises(ValueError):
        with track("t.boom"):
            raise ValueError("kaboom")
    with track("t.logical") as t:
        t.fail("upstream said no")
    ok, boom, logical = (observability.one_stat(n) for n in ("t.ok", "t.boom", "t.logical"))
    assert (ok["calls"], ok["errors"]) == (1, 0)
    assert (boom["calls"], boom["errors"]) == (1, 1)
    assert logical["errors"] == 1 and "upstream said no" in logical["last_error_message"]


def test_track_treats_http_4xx_as_healthy_but_5xx_as_failure():
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        with track("t.refusal"):
            raise HTTPException(status_code=403, detail="nope")
    with pytest.raises(HTTPException):
        with track("t.upstream_down"):
            raise HTTPException(status_code=502, detail="down")
    assert observability.one_stat("t.refusal")["errors"] == 0
    assert observability.one_stat("t.upstream_down")["errors"] == 1


def test_tracked_decorator_preserves_return_value_and_name():
    @tracked("t.add")
    def add(a, b):
        return a + b

    assert add(2, 3) == 5 and add.__name__ == "add"
    assert observability.one_stat("t.add")["calls"] == 1


def test_status_turns_down_when_recent_calls_keep_failing():
    for _ in range(4):
        with pytest.raises(RuntimeError):
            with track("t.flaky"):
                raise RuntimeError("x")
    assert observability.one_stat("t.flaky")["status"] == "down"
    for _ in range(20):
        with track("t.flaky"):
            pass
    assert observability.one_stat("t.flaky")["status"] in {"ok", "warn"}


def test_scrub_removes_secrets_and_truncates():
    out = scrub("login failed password=hunter2 token: abcdefghijklmnopqrstuvwxyz0123456789 end")
    assert "hunter2" not in out and "abcdefghijklmnopqrstuvwxyz" not in out
    assert len(scrub("x" * 1000)) <= 300


def test_requests_are_tracked_per_route_template_not_per_id(client, db_sessionmaker):
    _signup(client, "dev5@example.com")
    _set_role(db_sessionmaker, "dev5@example.com", PlatformRole.DEVELOPER)
    client.get("/api/auth/me")
    names = {f["name"] for f in client.get("/api/dev/functions?kind=route").json()["functions"]}
    assert "GET /api/auth/me" in names
    assert not any(n.startswith("GET /api/dev/") for n in names)  # the panel's own polling is excluded


def test_a_real_5xx_is_recorded_in_errors(client, db_sessionmaker):
    from backend.app.main import app

    @app.get("/api/_boom_for_tests")
    def boom():
        raise RuntimeError("deliberate test crash")

    _signup(client, "dev6@example.com")
    _set_role(db_sessionmaker, "dev6@example.com", PlatformRole.DEVELOPER)
    try:
        # A separate client that returns the 500 instead of re-raising the server exception into the test.
        assert TestClient(app, raise_server_exceptions=False).get("/api/_boom_for_tests").status_code == 500
    finally:
        app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", "") != "/api/_boom_for_tests"]
    errors = client.get("/api/dev/errors").json()["errors"]
    assert any("deliberate test crash" in e["message"] for e in errors)
    health = client.get("/api/dev/health").json()
    assert next(t for t in health["tiles"] if t["key"] == "api")["metrics"]["server_errors"] >= 1


# ---- self-tests -------------------------------------------------------------------------------------


def test_all_self_tests_pass_on_healthy_code():
    result = selftests.run_all()
    assert result["failed"] == 0, [r for r in result["results"] if r["status"] == "fail"]
    assert result["passed"] == len(selftests.SELF_TESTS) >= 8


def test_self_test_flags_a_broken_function_as_faulty(monkeypatch):
    from backend.app import plans

    monkeypatch.setattr(plans, "limits_for", lambda plan: plans.PlanLimits(max_trading_accounts=999, max_members_per_account=999))
    result = selftests.run_all()
    failed = [r for r in result["results"] if r["status"] == "fail"]
    assert any(r["key"] == "plan_limits" and "FAULTY" in r["detail"] for r in failed)


def test_self_test_crash_is_reported_not_raised(monkeypatch):
    def explode():
        raise RuntimeError("inside the test itself")

    monkeypatch.setattr(selftests, "SELF_TESTS", [("boom", "Boom", explode)])
    result = selftests.run_all()
    assert result["failed"] == 1 and "CRASHED" in result["results"][0]["detail"]


def test_selftest_last_returns_the_previous_run(client, db_sessionmaker):
    _signup(client, "dev7@example.com")
    _set_role(db_sessionmaker, "dev7@example.com", PlatformRole.DEVELOPER)
    run = client.post("/api/dev/selftest/run").json()
    assert client.get("/api/dev/selftest/last").json()["last_run"]["ran_at"] == run["ran_at"]


# ---- probes -----------------------------------------------------------------------------------------


def test_liveness_and_readiness_probes(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").json() == {"status": "ready"}
