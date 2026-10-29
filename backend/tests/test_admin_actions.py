from __future__ import annotations

import datetime as dt
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.app import models
from backend.app.main import app
from backend.app.routers import admin_actions
from backend.app.staff_guard import clear_step_up_failures

PW = "password123"


@pytest.fixture(autouse=True)
def _reset_step_up_lock():
    clear_step_up_failures()
    yield
    clear_step_up_failures()


def _signup(c, email, password=PW):
    r = c.post("/api/auth/signup", json={"email": email, "password": password, "display_name": email.split("@")[0]})
    assert r.status_code == 201, r.text
    return r.json()


def _promote(db_sessionmaker, email, role):
    with db_sessionmaker() as db:
        db.scalar(select(models.User).where(models.User.email == email)).platform_role = role
        db.commit()


def _uid(db_sessionmaker, email):
    with db_sessionmaker() as db:
        return db.scalar(select(models.User).where(models.User.email == email)).id


def _new_client():
    return TestClient(app)


def _staff(client, db_sessionmaker, email="boss@example.com", role="ADMIN"):
    _signup(client, email)
    _promote(db_sessionmaker, email, role)
    return client


def _csrf(client):
    return {"X-CSRF-Token": client.get("/api/admin/csrf").json()["token"]}


def _post(client, path, reason="Customer called support", password=PW, extra=None, headers=True):
    body = {"reason": reason, "password": password, **(extra or {})}
    return client.post(path, json=body, headers=_csrf(client) if headers else {})


def _customer(db_sessionmaker, email="victim@example.com"):
    """A separate logged-in customer (own cookie jar), so staff and customer can be exercised side by side."""
    c = _new_client()
    data = _signup(c, email)
    return c, data


def _audit(db_sessionmaker, action):
    with db_sessionmaker() as db:
        return db.scalars(select(models.AuditLog).where(models.AuditLog.action == action)).all()


# ---- CSRF -------------------------------------------------------------------------------------------------


def test_csrf_token_endpoint_is_staff_only(client, db_sessionmaker):
    assert client.get("/api/admin/csrf").status_code == 401
    _signup(client, "cust@example.com")
    assert client.get("/api/admin/csrf").status_code == 403


def test_every_staff_write_requires_the_csrf_header(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    for path in (f"/api/admin/users/{uid}/disable", f"/api/admin/users/{uid}/enable", f"/api/admin/users/{uid}/force-logout", f"/api/admin/users/{uid}/password-reset"):
        r = _post(client, path, headers=False)
        assert r.status_code == 403 and "CSRF" in r.json()["detail"], path
        wrong = client.post(path, json={"reason": "long enough", "password": PW}, headers={"X-CSRF-Token": "not-the-token"})
        assert wrong.status_code == 403, path
    assert _post(client, "/api/admin/view-as", extra={"user_id": uid}, headers=False).status_code == 403
    assert client.post("/api/admin/view-as/x/end").status_code == 403
    with db_sessionmaker() as db:
        assert db.get(models.User, uid).is_active is True  # nothing happened


def test_csrf_token_belongs_to_the_session_it_was_issued_for(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    first = client.get("/api/admin/csrf").json()["token"]
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"email": "boss@example.com", "password": PW})
    second = client.get("/api/admin/csrf").json()["token"]
    assert first != second
    _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    stale = client.post(f"/api/admin/users/{uid}/force-logout", json={"reason": "long enough", "password": PW}, headers={"X-CSRF-Token": first})
    assert stale.status_code == 403


def test_every_post_route_in_the_actions_router_requires_csrf():
    posts = [r for r in admin_actions.router.routes if "POST" in getattr(r, "methods", set())]
    assert len(posts) >= 5
    for route in posts:
        names = {getattr(d.call, "__name__", "") for d in route.dependant.dependencies}
        assert "require_csrf" in names, route.path


# ---- who may call them -----------------------------------------------------------------------------------


def test_customers_and_anonymous_cannot_use_staff_actions(client, db_sessionmaker):
    victim, _ = _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    assert client.post(f"/api/admin/users/{uid}/disable", json={"reason": "long enough", "password": PW}).status_code == 401
    _signup(client, "other@example.com")
    r = client.post(f"/api/admin/users/{uid}/disable", json={"reason": "long enough", "password": PW})
    assert r.status_code == 403
    assert victim.get("/api/auth/me").status_code == 200


# ---- step-up password + reason ---------------------------------------------------------------------------


def test_wrong_password_is_refused_and_audited_and_nothing_changes(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    r = _post(client, f"/api/admin/users/{uid}/disable", password="wrong-password")
    assert r.status_code == 403 and "password" in r.json()["detail"].lower()
    with db_sessionmaker() as db:
        assert db.get(models.User, uid).is_active is True
    assert len(_audit(db_sessionmaker, "STEP_UP_FAILED")) == 1


def test_five_wrong_passwords_lock_staff_actions_even_for_the_right_password(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    for _ in range(5):
        assert _post(client, f"/api/admin/users/{uid}/force-logout", password="nope").status_code == 403
    locked = _post(client, f"/api/admin/users/{uid}/force-logout", password=PW)
    assert locked.status_code == 429


def test_a_reason_is_required_and_must_be_meaningful(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    assert _post(client, f"/api/admin/users/{uid}/disable", reason="").status_code == 422
    assert _post(client, f"/api/admin/users/{uid}/disable", reason="ok").status_code == 422
    assert client.post(f"/api/admin/users/{uid}/disable", json={"password": PW}, headers=_csrf(client)).status_code == 422
    assert client.post(f"/api/admin/users/{uid}/disable", json={"reason": "long enough reason"}, headers=_csrf(client)).status_code == 422


# ---- disable / enable / force-logout ---------------------------------------------------------------------


def test_disabling_locks_the_user_out_immediately_and_enabling_restores_access(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    victim, _ = _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    assert victim.get("/api/auth/me").status_code == 200

    r = _post(client, f"/api/admin/users/{uid}/disable", reason="Suspected account takeover")
    assert r.status_code == 200 and r.json() == {"id": uid, "is_active": False, "sessions_ended": 1}

    assert victim.get("/api/auth/me").status_code == 401  # their live session died at once, not at next login
    login = _new_client().post("/api/auth/login", json={"email": "victim@example.com", "password": PW})
    assert login.status_code == 403 and "disabled" in login.json()["detail"].lower()

    rows = _audit(db_sessionmaker, "USER_DISABLED")
    assert len(rows) == 1 and rows[0].target_user_id == uid and "Suspected account takeover" in rows[0].metadata_json
    assert rows[0].user_id == _uid(db_sessionmaker, "boss@example.com")

    assert _post(client, f"/api/admin/users/{uid}/disable").status_code == 409  # already disabled
    assert _post(client, f"/api/admin/users/{uid}/enable", reason="Verified identity by phone").status_code == 200
    assert _new_client().post("/api/auth/login", json={"email": "victim@example.com", "password": PW}).status_code == 200
    assert len(_audit(db_sessionmaker, "USER_ENABLED")) == 1
    assert _post(client, f"/api/admin/users/{uid}/enable").status_code == 409  # already active


def test_force_logout_ends_every_session_but_leaves_the_account_usable(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    victim, _ = _customer(db_sessionmaker)
    second_device = _new_client()
    second_device.post("/api/auth/login", json={"email": "victim@example.com", "password": PW})
    uid = _uid(db_sessionmaker, "victim@example.com")

    r = _post(client, f"/api/admin/users/{uid}/force-logout")
    assert r.status_code == 200 and r.json()["sessions_ended"] == 2
    assert victim.get("/api/auth/me").status_code == 401 and second_device.get("/api/auth/me").status_code == 401
    assert _new_client().post("/api/auth/login", json={"email": "victim@example.com", "password": PW}).status_code == 200
    assert len(_audit(db_sessionmaker, "USER_FORCE_LOGOUT")) == 1


def test_unknown_user_is_404(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    assert _post(client, "/api/admin/users/does-not-exist/disable").status_code == 404


# ---- guard rails between staff accounts ------------------------------------------------------------------


def test_staff_cannot_act_on_their_own_account(client, db_sessionmaker):
    _staff(client, db_sessionmaker, role="DEVELOPER")
    me = _uid(db_sessionmaker, "boss@example.com")
    for action in ("disable", "enable", "force-logout", "password-reset"):
        assert _post(client, f"/api/admin/users/{me}/{action}").status_code == 403, action
    assert _post(client, "/api/admin/view-as", extra={"user_id": me}).status_code == 403


def test_an_admin_cannot_touch_other_staff_but_a_developer_can(client, db_sessionmaker):
    _signup(_new_client(), "peer@example.com")
    _promote(db_sessionmaker, "peer@example.com", "ADMIN")
    _signup(_new_client(), "chief@example.com")
    _promote(db_sessionmaker, "chief@example.com", "DEVELOPER")
    peer, chief = _uid(db_sessionmaker, "peer@example.com"), _uid(db_sessionmaker, "chief@example.com")

    _staff(client, db_sessionmaker)  # boss is an ADMIN
    for target in (peer, chief):
        for action in ("disable", "force-logout", "password-reset"):
            assert _post(client, f"/api/admin/users/{target}/{action}").status_code == 403, (target, action)

    client.post("/api/auth/logout")
    _signup(client, "dev@example.com")
    _promote(db_sessionmaker, "dev@example.com", "DEVELOPER")
    assert _post(client, f"/api/admin/users/{peer}/disable").status_code == 200  # a developer may manage an admin


# ---- password recovery -----------------------------------------------------------------------------------


def _token_from(url: str) -> str:
    return parse_qs(urlparse(url).query)["reset_token"][0]


def test_staff_issued_reset_link_lets_the_customer_set_their_own_password(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    victim, _ = _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")

    r = _post(client, f"/api/admin/users/{uid}/password-reset", reason="Locked out, verified by callback")
    assert r.status_code == 200
    body = r.json()
    assert r.headers["cache-control"] == "no-store"
    assert body["email"] == "victim@example.com" and body["valid_minutes"] > 0 and body["expires_at"].endswith("Z")
    assert urlparse(body["reset_url"]).path == "/app"
    token = _token_from(body["reset_url"])

    stranger = _new_client()
    assert stranger.post("/api/auth/reset-password", json={"token": token, "new_password": "BrandNewPass9"}).status_code == 204

    assert victim.get("/api/auth/me").status_code == 401  # completing a reset signs the customer out everywhere
    assert _new_client().post("/api/auth/login", json={"email": "victim@example.com", "password": PW}).status_code == 401
    assert _new_client().post("/api/auth/login", json={"email": "victim@example.com", "password": "BrandNewPass9"}).status_code == 200
    assert stranger.post("/api/auth/reset-password", json={"token": token, "new_password": "AnotherPass99"}).status_code == 400  # single use


def test_a_new_link_replaces_the_previous_one(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    first = _token_from(_post(client, f"/api/admin/users/{uid}/password-reset").json()["reset_url"])
    second = _token_from(_post(client, f"/api/admin/users/{uid}/password-reset").json()["reset_url"])
    assert first != second
    c = _new_client()
    assert c.post("/api/auth/reset-password", json={"token": first, "new_password": "BrandNewPass9"}).status_code == 400
    assert c.post("/api/auth/reset-password", json={"token": second, "new_password": "BrandNewPass9"}).status_code == 204


def test_the_reset_token_is_never_stored_or_logged_in_plaintext(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    token = _token_from(_post(client, f"/api/admin/users/{uid}/password-reset").json()["reset_url"])
    with db_sessionmaker() as db:
        stored = [row.token_hash for row in db.scalars(select(models.PasswordResetToken)).all()]
        logged = " ".join((row.metadata_json or "") for row in db.scalars(select(models.AuditLog)).all())
    assert token not in stored and token not in logged
    rows = _audit(db_sessionmaker, "PASSWORD_RESET_ISSUED_BY_STAFF")
    assert len(rows) == 1 and rows[0].target_user_id == uid
    # and it can't be fetched again afterwards — the admin read API has no such field
    detail = client.get(f"/api/admin/users/{uid}").text
    assert token not in detail


def test_no_reset_link_for_a_disabled_account(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    _post(client, f"/api/admin/users/{uid}/disable")
    r = _post(client, f"/api/admin/users/{uid}/password-reset")
    assert r.status_code == 409 and "enable" in r.json()["detail"].lower()


# ---- view as user ----------------------------------------------------------------------------------------


def _seed_trades(victim):
    ws = victim.get("/api/auth/me").json()["workspaces"][0]["id"]
    account = victim.post("/api/accounts", json={"workspace_id": ws, "name": "Main", "broker_name": "Angel One"}).json()
    base = {"segment": "CASH", "reason": "PRIVATE REASON TEXT", "notes": "PRIVATE JOURNAL NOTE", "exit_price": 0, "gross_pnl": 0}
    for i, (status, pnl) in enumerate([("CLOSED", 120.5), ("CLOSED", -40.0), ("OPEN", 0.0)]):
        r = victim.post(f"/api/accounts/{account['id']}/trades", json={**base, "trade_date": f"2026-01-0{i + 1}", "script_name": f"SYM{i}", "side": "BUY", "quantity": 1, "entry_price": 10, "status": status, "net_pnl": pnl})
        assert r.status_code == 201, r.text
    return account["id"]


def _start_view(client, db_sessionmaker, email="victim@example.com"):
    r = _post(client, "/api/admin/view-as", reason="Investigating missing trades", extra={"user_id": _uid(db_sessionmaker, email)})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_view_as_shows_the_customers_server_side_dashboard_read_only(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    victim, _ = _customer(db_sessionmaker)
    account_id = _seed_trades(victim)
    vid = _start_view(client, db_sessionmaker)

    d = client.get(f"/api/admin/view-as/{vid}")
    assert d.status_code == 200
    body = d.json()
    assert body["user"]["email"] == "victim@example.com"
    assert body["totals"] == {"accounts": 1, "trades": 3, "open_trades": 1, "net_pnl": 80.5, "win_rate": 50.0}
    assert body["accounts"][0]["name"] == "Main" and body["accounts"][0]["trades"] == 3 and body["accounts"][0]["net_pnl"] == 80.5
    assert {t["script_name"] for t in body["recent_trades"]} == {"SYM0", "SYM1", "SYM2"}
    for private in ("PRIVATE REASON TEXT", "PRIVATE JOURNAL NOTE", "password_hash"):
        assert private not in d.text

    trades = client.get(f"/api/admin/view-as/{vid}/accounts/{account_id}/trades?status=closed&page_size=1")
    assert trades.json()["total"] == 2 and len(trades.json()["items"]) == 1
    assert "PRIVATE" not in trades.text
    assert client.get(f"/api/admin/view-as/{vid}/accounts/{account_id}/trades?status=open").json()["total"] == 1

    # there is no way to change anything through this session
    assert client.post(f"/api/admin/view-as/{vid}/accounts/{account_id}/trades", json={}).status_code in (404, 405)
    assert client.delete(f"/api/admin/view-as/{vid}").status_code == 405


def test_view_as_data_feeds_the_real_dashboard_screen_without_private_writing(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    victim, _ = _customer(db_sessionmaker)
    account_id = _seed_trades(victim)
    vid = _start_view(client, db_sessionmaker)

    r = client.get(f"/api/admin/view-as/{vid}/data")
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["email"] == "victim@example.com"
    assert [a["id"] for a in body["accounts"]] == [account_id] and body["accounts"][0]["role"] == "VIEWER"
    assert {t["script_name"] for t in body["trades"]} == {"SYM0", "SYM1", "SYM2"}
    assert body["total_trades"] == 3 and body["truncated"] is False
    # the same fields the customer's own dashboard receives, so the real screen can render it
    assert {"trade_date", "segment", "quantity", "entry_price", "exit_price", "status", "net_pnl", "reason", "notes", "created_at"} <= set(body["trades"][0])
    for private in ("PRIVATE REASON TEXT", "PRIVATE JOURNAL NOTE", "password_hash"):
        assert private not in r.text
    # read-only: no write route exists on it
    assert client.post(f"/api/admin/view-as/{vid}/data", json={}).status_code in (404, 405)

    client.post(f"/api/admin/view-as/{vid}/end", headers=_csrf(client))
    assert client.get(f"/api/admin/view-as/{vid}/data").status_code == 410


def test_view_as_needs_password_and_reason_and_is_audited_and_visible_to_the_customer(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    victim, _ = _customer(db_sessionmaker)
    uid = _uid(db_sessionmaker, "victim@example.com")
    assert _post(client, "/api/admin/view-as", password="wrong", extra={"user_id": uid}).status_code == 403
    assert _post(client, "/api/admin/view-as", reason="no", extra={"user_id": uid}).status_code == 422
    assert victim.get("/api/auth/support-access").json()["sessions"] == []  # nothing happened yet

    vid = _start_view(client, db_sessionmaker)
    started = _audit(db_sessionmaker, "ADMIN_VIEW_AS_STARTED")
    assert len(started) == 1 and started[0].target_user_id == uid and "Investigating missing trades" in started[0].metadata_json

    seen = victim.get("/api/auth/support-access").json()["sessions"]
    assert len(seen) == 1 and seen[0]["by"] == "Platform support" and seen[0]["ended_at"] is None
    assert "Investigating" not in str(seen) and "boss" not in str(seen)  # no staff identity or reason shown to the customer

    assert client.post(f"/api/admin/view-as/{vid}/end", headers=_csrf(client)).json() == {"ended": True}
    assert victim.get("/api/auth/support-access").json()["sessions"][0]["ended_at"].endswith("Z")
    assert len(_audit(db_sessionmaker, "ADMIN_VIEW_AS_ENDED")) == 1


def test_view_as_is_for_customers_only(client, db_sessionmaker):
    _signup(_new_client(), "peer@example.com")
    _promote(db_sessionmaker, "peer@example.com", "ADMIN")
    _staff(client, db_sessionmaker, role="DEVELOPER")
    r = _post(client, "/api/admin/view-as", extra={"user_id": _uid(db_sessionmaker, "peer@example.com")})
    assert r.status_code == 403 and "customer" in r.json()["detail"].lower()


def test_an_ended_view_cannot_be_read_again(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    vid = _start_view(client, db_sessionmaker)
    client.post(f"/api/admin/view-as/{vid}/end", headers=_csrf(client))
    assert client.get(f"/api/admin/view-as/{vid}").status_code == 410
    assert client.post(f"/api/admin/view-as/{vid}/end", headers=_csrf(client)).status_code == 200  # ending twice is harmless


def test_a_view_closes_itself_after_30_idle_minutes(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    vid = _start_view(client, db_sessionmaker)
    assert client.get(f"/api/admin/view-as/{vid}").status_code == 200
    with db_sessionmaker() as db:
        db.get(models.ViewAsSession, vid).last_seen_at = dt.datetime.utcnow() - dt.timedelta(minutes=31)
        db.commit()
    r = client.get(f"/api/admin/view-as/{vid}")
    assert r.status_code == 410 and "30 minutes" in r.json()["detail"]
    assert client.get(f"/api/admin/view-as/{vid}").status_code == 410
    ended = _audit(db_sessionmaker, "ADMIN_VIEW_AS_ENDED")
    assert len(ended) == 1 and "idle" in ended[0].metadata_json


def test_activity_keeps_a_view_alive(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    vid = _start_view(client, db_sessionmaker)
    with db_sessionmaker() as db:
        db.get(models.ViewAsSession, vid).last_seen_at = dt.datetime.utcnow() - dt.timedelta(minutes=20)
        db.commit()
    assert client.get(f"/api/admin/view-as/{vid}").status_code == 200  # touched, so the idle clock restarts
    with db_sessionmaker() as db:
        assert db.get(models.ViewAsSession, vid).last_seen_at > dt.datetime.utcnow() - dt.timedelta(minutes=1)


def test_starting_a_second_view_closes_the_first(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker, "one@example.com")
    _customer(db_sessionmaker, "two@example.com")
    first = _start_view(client, db_sessionmaker, "one@example.com")
    second = _start_view(client, db_sessionmaker, "two@example.com")
    assert client.get(f"/api/admin/view-as/{first}").status_code == 410
    assert client.get(f"/api/admin/view-as/{second}").json()["user"]["email"] == "two@example.com"
    with db_sessionmaker() as db:
        assert db.get(models.ViewAsSession, first).end_reason == "replaced"


def test_another_staff_member_cannot_use_my_view_session(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    _customer(db_sessionmaker)
    vid = _start_view(client, db_sessionmaker)
    other = _new_client()
    _signup(other, "colleague@example.com")
    _promote(db_sessionmaker, "colleague@example.com", "ADMIN")
    assert other.get(f"/api/admin/view-as/{vid}").status_code == 404
    assert other.post(f"/api/admin/view-as/{vid}/end", headers=_csrf(other)).status_code == 404
    assert client.get(f"/api/admin/view-as/{vid}").status_code == 200  # still open for its owner


def test_view_as_cannot_reach_accounts_that_are_not_the_customers(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    victim, _ = _customer(db_sessionmaker)
    _seed_trades(victim)
    stranger, _ = _customer(db_sessionmaker, "stranger@example.com")
    stranger_account = _seed_trades(stranger)
    vid = _start_view(client, db_sessionmaker)
    assert client.get(f"/api/admin/view-as/{vid}/accounts/{stranger_account}/trades").status_code == 404


def test_customers_cannot_read_view_sessions(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    victim, _ = _customer(db_sessionmaker)
    vid = _start_view(client, db_sessionmaker)
    assert victim.get(f"/api/admin/view-as/{vid}").status_code == 403
    assert _new_client().get(f"/api/admin/view-as/{vid}").status_code == 401
