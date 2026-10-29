from __future__ import annotations

import datetime as dt

import pytest
from sqlalchemy import select

from backend.app import models

ADMIN_GET_PATHS = [
    "/api/admin/summary",
    "/api/admin/users",
    "/api/admin/workspaces",
    "/api/admin/billing/overview",
    "/api/admin/billing/subscriptions",
    "/api/admin/billing/payments",
    "/api/admin/billing/webhooks",
    "/api/admin/invitations",
    "/api/admin/audit",
    "/api/admin/audit/actions",
    "/api/admin/audit/export",
]


def _signup(client, email, password="password123", name=None):
    r = client.post("/api/auth/signup", json={"email": email, "password": password, "display_name": name or email.split("@")[0]})
    assert r.status_code == 201
    return r.json()


def _set_role(db_sessionmaker, email, role):
    with db_sessionmaker() as db:
        db.scalar(select(models.User).where(models.User.email == email)).platform_role = role
        db.commit()


def _login_as(client, email, password="password123"):
    client.post("/api/auth/logout")
    assert client.post("/api/auth/login", json={"email": email, "password": password}).status_code == 200


@pytest.fixture()
def staff(client, db_sessionmaker):
    """A logged-in platform ADMIN."""
    _signup(client, "boss@example.com")
    _set_role(db_sessionmaker, "boss@example.com", "ADMIN")
    return "boss@example.com"


def _user_id(db_sessionmaker, email):
    with db_sessionmaker() as db:
        return db.scalar(select(models.User).where(models.User.email == email)).id


# ---- access control ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("path", ADMIN_GET_PATHS)
def test_admin_routes_require_authentication(client, path):
    assert client.get(path).status_code == 401


@pytest.mark.parametrize("path", ADMIN_GET_PATHS + ["/api/admin/users/some-id"])
def test_regular_customers_get_403_on_every_admin_route(client, path):
    _signup(client, "customer@example.com")
    assert client.get(path).status_code == 403


@pytest.mark.parametrize("role", ["ADMIN", "DEVELOPER"])
def test_admin_and_developer_can_read_every_admin_route(client, db_sessionmaker, role):
    _signup(client, "s@example.com")
    _set_role(db_sessionmaker, "s@example.com", role)
    for path in ADMIN_GET_PATHS:
        assert client.get(path).status_code == 200, path


def test_admin_api_has_no_write_routes():
    """Read-only by design in this phase: nothing under /api/admin can change data."""
    from backend.app.routers import admin

    methods = {m for route in admin.router.routes for m in getattr(route, "methods", set())}
    assert methods <= {"GET", "HEAD"}


def test_admins_cannot_reach_developer_only_routes(client, staff):
    assert client.get("/api/dev/health").status_code == 403


# ---- users ------------------------------------------------------------------------------------------------


def _seed_customers(client, db_sessionmaker):
    for i, name in enumerate(["alice", "bob", "carol"]):
        _signup(client, f"{name}@example.com", name=name.title())
        client.post("/api/auth/logout")
    with db_sessionmaker() as db:
        db.scalar(select(models.User).where(models.User.email == "bob@example.com")).is_active = False
        db.commit()


def test_users_list_filters_and_paginates(client, db_sessionmaker):
    _seed_customers(client, db_sessionmaker)
    _signup(client, "boss@example.com")
    _set_role(db_sessionmaker, "boss@example.com", "ADMIN")

    everyone = client.get("/api/admin/users").json()
    assert everyone["total"] == 4
    assert {u["email"] for u in everyone["items"]} == {"alice@example.com", "bob@example.com", "carol@example.com", "boss@example.com"}

    assert [u["email"] for u in client.get("/api/admin/users?q=ALI").json()["items"]] == ["alice@example.com"]
    assert [u["email"] for u in client.get("/api/admin/users?status=disabled").json()["items"]] == ["bob@example.com"]
    assert client.get("/api/admin/users?status=active").json()["total"] == 3
    assert [u["email"] for u in client.get("/api/admin/users?role=ADMIN").json()["items"]] == ["boss@example.com"]

    page1 = client.get("/api/admin/users?page=1&page_size=3").json()
    page2 = client.get("/api/admin/users?page=2&page_size=3").json()
    assert len(page1["items"]) == 3 and len(page2["items"]) == 1
    assert {u["id"] for u in page1["items"]}.isdisjoint({u["id"] for u in page2["items"]})
    assert client.get("/api/admin/users?page=0").status_code == 422
    assert client.get("/api/admin/users?page_size=101").status_code == 422


def test_search_treats_percent_and_underscore_literally(client, db_sessionmaker):
    _seed_customers(client, db_sessionmaker)
    _signup(client, "boss@example.com")
    _set_role(db_sessionmaker, "boss@example.com", "ADMIN")
    assert client.get("/api/admin/users?q=%25").json()["total"] == 0  # "%" would match everything if it were a wildcard
    assert client.get("/api/admin/users?q=_lice").json()["total"] == 0


def test_users_list_filters_by_plan_and_shows_plan_and_last_login(client, db_sessionmaker, set_plan):
    biz = _signup(client, "biz@example.com")
    set_plan(biz["workspaces"][0]["id"], "BUSINESS")
    client.post("/api/auth/logout")
    _signup(client, "free@example.com")
    client.post("/api/auth/logout")
    _signup(client, "boss@example.com")
    _set_role(db_sessionmaker, "boss@example.com", "ADMIN")

    only_biz = client.get("/api/admin/users?plan=BUSINESS").json()
    assert [u["email"] for u in only_biz["items"]] == ["biz@example.com"]
    row = only_biz["items"][0]
    assert row["plan"] == "BUSINESS" and row["is_active"] is True and row["platform_role"] == "USER"
    assert row["last_login_at"] is None  # signed up, never logged in via /login
    _login_as(client, "biz@example.com")
    _login_as(client, "boss@example.com")
    assert client.get("/api/admin/users?plan=BUSINESS").json()["items"][0]["last_login_at"].endswith("Z")


def test_timestamps_are_sent_as_utc_with_a_z_suffix(client, staff):
    created = client.get("/api/admin/users").json()["items"][0]["created_at"]
    assert created.endswith("Z")


def test_user_detail_returns_full_picture_without_secrets(client, db_sessionmaker):
    data = _signup(client, "owner@example.com", password="Sup3rSecretPw!")
    ws_id = data["workspaces"][0]["id"]
    account = client.post("/api/accounts", json={"workspace_id": ws_id, "name": "Main", "broker_name": "Angel One"}).json()
    client.post(f"/api/accounts/{account['id']}/trades", json={
        "trade_date": "2026-01-01", "segment": "CASH", "script_name": "RELIANCE", "reason": "", "quantity": 1, "side": "BUY",
        "entry_price": 10, "exit_price": 0, "status": "OPEN", "gross_pnl": 0, "net_pnl": 0, "notes": "PRIVATE NOTE SHOULD NOT LEAK",
    })
    client.post("/api/auth/logout")  # logging out deletes the session row, so plant a live one with a known token
    token = "KNOWN-SESSION-TOKEN-abc123XYZ"
    with db_sessionmaker() as db:
        user = db.scalar(select(models.User).where(models.User.email == "owner@example.com"))
        password_hash = user.password_hash
        db.add(models.Session(token=token, user_id=user.id, expires_at=dt.datetime.utcnow() + dt.timedelta(hours=1)))
        db.commit()
    _signup(client, "boss@example.com")
    _set_role(db_sessionmaker, "boss@example.com", "ADMIN")

    r = client.get(f"/api/admin/users/{_user_id(db_sessionmaker, 'owner@example.com')}")
    assert r.status_code == 200
    body = r.json()
    assert body["profile"]["email"] == "owner@example.com"
    assert body["workspaces"][0]["plan"] == "FREE" and body["workspaces"][0]["limits"]["max_trading_accounts"] == 3
    assert body["workspaces"][0]["trading_accounts_used"] == 1
    assert body["accounts"][0]["name"] == "Main" and body["accounts"][0]["role"] == "OWNER"
    assert body["accounts"][0]["trades"] == 1
    assert len(body["sessions"]) == 1 and body["sessions"][0]["active"] is True
    assert all(set(s) == {"started_at", "expires_at", "active"} for s in body["sessions"])
    assert any(a["action"] == "SIGNUP" for a in body["audit"])

    text = r.text
    for secret in (token, password_hash, "Sup3rSecretPw!", "PRIVATE NOTE SHOULD NOT LEAK", "RELIANCE"):
        assert secret not in text


def test_user_detail_404_and_viewing_a_user_is_audited(client, db_sessionmaker, staff):
    assert client.get("/api/admin/users/not-a-real-id").status_code == 404
    _signup(client, "target@example.com")
    _login_as(client, staff)
    target_id = _user_id(db_sessionmaker, "target@example.com")
    assert client.get(f"/api/admin/users/{target_id}").status_code == 200
    with db_sessionmaker() as db:
        rows = db.scalars(select(models.AuditLog).where(models.AuditLog.action == "ADMIN_USER_VIEWED")).all()
    assert len(rows) == 1
    assert rows[0].target_user_id == target_id and rows[0].user_id == _user_id(db_sessionmaker, staff)


def test_user_detail_shows_invitations_addressed_to_the_user(client, db_sessionmaker):
    owner = _signup(client, "inviter@example.com")
    account = client.post("/api/accounts", json={"workspace_id": owner["workspaces"][0]["id"], "name": "Shared", "broker_name": ""}).json()
    assert client.post(f"/api/accounts/{account['id']}/invitations", json={"email": "guest@example.com", "role": "VIEWER"}).status_code == 201
    client.post("/api/auth/logout")
    _signup(client, "guest@example.com")
    client.post("/api/auth/logout")
    _signup(client, "boss@example.com")
    _set_role(db_sessionmaker, "boss@example.com", "ADMIN")
    body = client.get(f"/api/admin/users/{_user_id(db_sessionmaker, 'guest@example.com')}").json()
    assert body["invitations"][0]["status"] == "PENDING" and body["invitations"][0]["role"] == "VIEWER"


# ---- workspaces -------------------------------------------------------------------------------------------


def test_workspaces_list_shows_plan_usage_and_owner(client, db_sessionmaker, set_plan):
    a = _signup(client, "wa@example.com")
    set_plan(a["workspaces"][0]["id"], "PRO")
    client.post("/api/accounts", json={"workspace_id": a["workspaces"][0]["id"], "name": "x", "broker_name": ""})
    client.post("/api/auth/logout")
    _signup(client, "wb@example.com")
    client.post("/api/auth/logout")
    _signup(client, "boss@example.com")
    _set_role(db_sessionmaker, "boss@example.com", "ADMIN")

    body = client.get("/api/admin/workspaces?plan=PRO").json()
    assert body["total"] == 1
    row = body["items"][0]
    assert row["owner_email"] == "wa@example.com" and row["trading_accounts_used"] == 1 and row["limits"]["max_trading_accounts"] == 15
    assert client.get("/api/admin/workspaces").json()["total"] == 3  # wa, wb and the admin's own workspace


# ---- billing ----------------------------------------------------------------------------------------------


def _seed_billing(client, db_sessionmaker):
    data = _signup(client, "payer@example.com")
    ws_id = data["workspaces"][0]["id"]
    client.post("/api/auth/logout")
    now = dt.datetime.utcnow()
    with db_sessionmaker() as db:
        sub = models.Subscription(workspace_id=ws_id, plan_name="PRO", billing_cycle="MONTHLY", status=models.SubscriptionStatus.ACTIVE, current_period_end=now + dt.timedelta(days=3), razorpay_order_id="order_1", razorpay_payment_id="pay_1")
        db.add(sub)
        db.flush()
        db.add(models.Payment(subscription_id=sub.id, razorpay_payment_id="pay_1", razorpay_order_id="order_1", amount_paise=49900, status="captured", plan_name="PRO", billing_cycle="MONTHLY"))
        db.add(models.WebhookEvent(razorpay_event_id="evt_1", event_type="payment.captured", payload_json='{"contact":"+919999999999","card":"4111"}'))
        db.add(models.AuditLog(action="PAYMENT_VERIFICATION_FAILED", workspace_id=ws_id, ip_address="1.2.3.4"))
        db.commit()
    _signup(client, "boss@example.com")
    _set_role(db_sessionmaker, "boss@example.com", "ADMIN")
    return ws_id


def test_billing_endpoints_show_real_subscription_and_payment_data(client, db_sessionmaker):
    _seed_billing(client, db_sessionmaker)

    subs = client.get("/api/admin/billing/subscriptions").json()
    assert subs["total"] == 1 and subs["items"][0]["owner_email"] == "payer@example.com"
    assert subs["items"][0]["status"] == "ACTIVE" and subs["items"][0]["expiring_soon"] is True
    assert client.get("/api/admin/billing/subscriptions?status=expiring").json()["total"] == 1
    assert client.get("/api/admin/billing/subscriptions?status=EXPIRED").json()["total"] == 0
    assert client.get("/api/admin/billing/subscriptions?status=bogus").status_code == 422

    pays = client.get("/api/admin/billing/payments").json()
    assert pays["items"][0]["amount_inr"] == 499.0 and pays["items"][0]["plan_name"] == "PRO"
    assert client.get("/api/admin/billing/payments?status=failed").json()["total"] == 0

    overview = client.get("/api/admin/billing/overview").json()
    assert overview["verification_failures_24h"] == 1 and overview["webhooks_total"] == 1
    assert overview["last_webhook_at"].endswith("Z")


def test_webhook_payloads_are_never_exposed(client, db_sessionmaker):
    _seed_billing(client, db_sessionmaker)
    r = client.get("/api/admin/billing/webhooks")
    assert r.json()["items"][0]["event_type"] == "payment.captured"
    assert "919999999999" not in r.text and "4111" not in r.text and "payload" not in r.text


def test_summary_counts_match_the_database(client, db_sessionmaker):
    _seed_billing(client, db_sessionmaker)
    s = client.get("/api/admin/summary").json()
    assert s["users"]["total"] == 2 and s["users"]["staff"] == 1 and s["users"]["disabled"] == 0
    assert s["workspaces"]["total"] == 2 and s["billing"]["subscriptions_by_status"] == {"ACTIVE": 1}
    assert s["billing"]["expiring_in_7d"] == 1 and s["billing"]["paid_last_30d_inr"] == 499.0


# ---- invitations ------------------------------------------------------------------------------------------


def test_invitations_list_marks_expired_pending_invites(client, db_sessionmaker):
    owner = _signup(client, "host@example.com")
    account = client.post("/api/accounts", json={"workspace_id": owner["workspaces"][0]["id"], "name": "Acc", "broker_name": ""}).json()
    client.post(f"/api/accounts/{account['id']}/invitations", json={"email": "fresh@example.com", "role": "VIEWER"})
    with db_sessionmaker() as db:
        host = db.scalar(select(models.User).where(models.User.email == "host@example.com"))
        db.add(models.Invitation(trading_account_id=account["id"], email="old@example.com", role=models.AccountRole.VIEWER, invited_by_user_id=host.id, expires_at=dt.datetime.utcnow() - dt.timedelta(days=1)))
        db.commit()
    client.post("/api/auth/logout")
    _signup(client, "boss@example.com")
    _set_role(db_sessionmaker, "boss@example.com", "ADMIN")

    assert client.get("/api/admin/invitations").json()["total"] == 2
    assert [i["email"] for i in client.get("/api/admin/invitations?status=PENDING").json()["items"]] == ["fresh@example.com"]
    expired = client.get("/api/admin/invitations?status=EXPIRED").json()["items"]
    assert [i["email"] for i in expired] == ["old@example.com"] and expired[0]["target_name"] == "Acc" and expired[0]["invited_by_email"] == "host@example.com"


# ---- audit log --------------------------------------------------------------------------------------------


def test_audit_log_filters_by_action_user_and_date(client, db_sessionmaker, staff):
    _signup(client, "someone@example.com")
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json={"email": "someone@example.com", "password": "wrong"})
    _login_as(client, staff)

    all_rows = client.get("/api/admin/audit").json()
    assert all_rows["total"] >= 4
    assert all(row["created_at"].endswith("Z") for row in all_rows["items"])

    failed = client.get("/api/admin/audit?action=LOGIN_FAILED").json()
    assert failed["total"] == 1 and failed["items"][0]["actor_email"] == "someone@example.com"
    assert [r["action"] for r in client.get("/api/admin/audit?user=SOMEONE@").json()["items"]].count("SIGNUP") == 1
    assert client.get("/api/admin/audit?since=2999-01-01T00:00:00").json()["total"] == 0
    assert "LOGIN_FAILED" in client.get("/api/admin/audit/actions").json()["actions"]
    assert len(client.get("/api/admin/audit?page_size=2").json()["items"]) == 2


def test_audit_csv_export_escapes_formulas_and_is_itself_audited(client, db_sessionmaker, staff):
    with db_sessionmaker() as db:
        db.add(models.AuditLog(action="TEST_ACTION", ip_address="=cmd|' /C calc'!A0"))
        db.commit()

    r = client.get("/api/admin/audit/export?action=TEST_ACTION")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv") and "attachment" in r.headers["content-disposition"]
    lines = r.text.strip().splitlines()
    assert lines[0].startswith("created_at,action,actor_email")
    assert "'=cmd" in lines[1] and ",=cmd" not in lines[1]

    with db_sessionmaker() as db:
        exported = db.scalars(select(models.AuditLog).where(models.AuditLog.action == "ADMIN_AUDIT_EXPORTED")).all()
    assert len(exported) == 1 and '"rows": 1' in exported[0].metadata_json
