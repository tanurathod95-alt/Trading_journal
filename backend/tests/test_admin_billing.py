from __future__ import annotations

import datetime as dt
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.app import models
from backend.app.main import app
from backend.app.staff_guard import clear_step_up_failures

PW = "password123"


@pytest.fixture(autouse=True)
def _reset_step_up_lock():
    clear_step_up_failures()
    yield
    clear_step_up_failures()


def _signup(c, email):
    r = c.post("/api/auth/signup", json={"email": email, "password": PW, "display_name": email.split("@")[0]})
    assert r.status_code == 201, r.text
    return r.json()


def _staff(client, db_sessionmaker, role="ADMIN"):
    _signup(client, "boss@example.com")
    with db_sessionmaker() as db:
        db.scalar(select(models.User).where(models.User.email == "boss@example.com")).platform_role = role
        db.commit()


def _customer(email="payer@example.com"):
    c = TestClient(app)
    return c, _signup(c, email)["workspaces"][0]["id"]


def _csrf(client):
    return {"X-CSRF-Token": client.get("/api/admin/csrf").json()["token"]}


def _post(client, path, body=None, password=PW, reason="Fixing a wrong purchase", headers=True):
    payload = {"reason": reason, "password": password, **(body or {})}
    return client.post(path, json=payload, headers=_csrf(client) if headers else {})


def _issues(client):
    return client.get("/api/admin/billing/issues").json()


def _kinds(client, workspace_id=None):
    items = _issues(client)["items"]
    return sorted(i["kind"] for i in items if workspace_id is None or i["workspace_id"] == workspace_id)


def _add_webhook(db_sessionmaker, payment_id, ws_id, plan="PRO", amount=49900, order_id="order_X", truncate=False):
    payload = json.dumps({"event": "payment.captured", "payload": {"payment": {"entity": {"id": payment_id, "order_id": order_id, "amount": amount, "notes": {"workspace_id": ws_id, "plan_name": plan}}}}})
    with db_sessionmaker() as db:
        db.add(models.WebhookEvent(razorpay_event_id=f"evt_{payment_id}", event_type="payment.captured", payload_json=payload[:60] if truncate else payload))
        db.commit()


def _add_subscription(db_sessionmaker, ws_id, plan="PRO", status="ACTIVE", period_end=None, cycle="MONTHLY", updated_at=None):
    with db_sessionmaker() as db:
        sub = models.Subscription(workspace_id=ws_id, plan_name=plan, billing_cycle=cycle, status=models.SubscriptionStatus(status), current_period_end=period_end, razorpay_order_id="order_S")
        if updated_at:
            sub.updated_at = updated_at
        db.add(sub)
        db.commit()
        return sub.id


def _add_payment(db_sessionmaker, sub_id, payment_id, amount=49900, at=None):
    with db_sessionmaker() as db:
        p = models.Payment(subscription_id=sub_id, razorpay_payment_id=payment_id, razorpay_order_id="order_S", amount_paise=amount, plan_name="PRO", billing_cycle="MONTHLY")
        if at:
            p.created_at = at
        db.add(p)
        db.commit()


def _set_plan(db_sessionmaker, ws_id, plan):
    with db_sessionmaker() as db:
        db.get(models.Workspace, ws_id).plan = plan
        db.commit()


def _audit(db_sessionmaker, action):
    with db_sessionmaker() as db:
        return db.scalars(select(models.AuditLog).where(models.AuditLog.action == action)).all()


# ---- who can look ----------------------------------------------------------------------------------------


def test_issues_need_staff(client):
    assert client.get("/api/admin/billing/issues").status_code == 401
    _signup(client, "cust@example.com")
    assert client.get("/api/admin/billing/issues").status_code == 403


def test_a_healthy_database_has_no_issues(client, db_sessionmaker):
    _customer()
    _staff(client, db_sessionmaker)
    body = _issues(client)
    assert body["total"] == 0 and body["items"] == [] and body["unreadable_webhooks"] == 0


# ---- detection ----------------------------------------------------------------------------------------------


def test_a_captured_payment_that_was_never_recorded_is_flagged_and_can_be_fixed(client, db_sessionmaker):
    _, ws = _customer()
    _add_webhook(db_sessionmaker, "pay_LOST", ws)
    _staff(client, db_sessionmaker)
    item = _issues(client)["items"][0]
    assert item["kind"] == "unrecorded_payment" and item["severity"] == "high"
    assert item["payment_id"] == "pay_LOST" and item["amount_inr"] == 499.0 and item["billing_cycle"] == "MONTHLY" and item["can_reconcile"] is True
    assert item["workspace_id"] == ws and item["owner_email"] == "payer@example.com"


def test_a_payment_that_is_already_recorded_is_not_flagged(client, db_sessionmaker):
    _, ws = _customer()
    sub = _add_subscription(db_sessionmaker, ws, period_end=dt.datetime.utcnow() + dt.timedelta(days=20))
    _set_plan(db_sessionmaker, ws, "PRO")
    _add_payment(db_sessionmaker, sub, "pay_OK")
    _add_webhook(db_sessionmaker, "pay_OK", ws)
    _staff(client, db_sessionmaker)
    assert _kinds(client) == []


def test_a_payment_that_matches_no_price_is_flagged_but_not_auto_fixable(client, db_sessionmaker):
    _, ws = _customer()
    _add_webhook(db_sessionmaker, "pay_ODD", ws, amount=12345)
    _staff(client, db_sessionmaker)
    item = _issues(client)["items"][0]
    assert item["can_reconcile"] is False and "automatically" in item["detail"]


def test_an_unreadable_webhook_is_counted_not_guessed_at(client, db_sessionmaker):
    _, ws = _customer()
    _add_webhook(db_sessionmaker, "pay_CUT", ws, truncate=True)
    _staff(client, db_sessionmaker)
    body = _issues(client)
    assert body["unreadable_webhooks"] == 1 and body["total"] == 0


def test_a_paid_plan_with_no_subscription_is_flagged(client, db_sessionmaker):
    _, ws = _customer()
    _set_plan(db_sessionmaker, ws, "PREMIUM")
    _staff(client, db_sessionmaker)
    assert _kinds(client, ws) == ["plan_without_payment"]


def test_issues_can_be_limited_to_one_customer_for_their_user_page(client, db_sessionmaker):
    _, ws_a = _customer("a@example.com")
    _, ws_b = _customer("b@example.com")
    _set_plan(db_sessionmaker, ws_a, "PREMIUM")
    _set_plan(db_sessionmaker, ws_b, "PRO")
    _staff(client, db_sessionmaker)
    with db_sessionmaker() as db:
        a_id = db.scalar(select(models.User.id).where(models.User.email == "a@example.com"))
        nobody = db.scalar(select(models.User.id).where(models.User.email == "boss@example.com"))
    assert {i["workspace_id"] for i in _issues(client)["items"]} == {ws_a, ws_b}  # platform-wide by default

    mine = client.get(f"/api/admin/billing/issues?user_id={a_id}").json()
    assert mine["total"] == 1 and mine["items"][0]["workspace_id"] == ws_a and mine["by_kind"] == {"plan_without_payment": 1}
    assert client.get(f"/api/admin/billing/issues?user_id={nobody}").json()["items"] == []


def test_a_paid_plan_with_an_active_subscription_is_not_flagged(client, db_sessionmaker):
    _, ws = _customer()
    _set_plan(db_sessionmaker, ws, "PRO")
    _add_subscription(db_sessionmaker, ws, "PRO", period_end=dt.datetime.utcnow() + dt.timedelta(days=5))
    _staff(client, db_sessionmaker)
    assert _kinds(client, ws) == []


def test_plan_and_subscription_disagreeing_is_flagged_as_high(client, db_sessionmaker):
    _, ws = _customer()
    _set_plan(db_sessionmaker, ws, "PRO")
    _add_subscription(db_sessionmaker, ws, "BUSINESS", period_end=dt.datetime.utcnow() + dt.timedelta(days=5))
    _staff(client, db_sessionmaker)
    item = next(i for i in _issues(client)["items"] if i["kind"] == "plan_mismatch")
    assert item["severity"] == "high" and item["subscription_plan"] == "BUSINESS"


def test_a_plan_that_outlived_its_period_is_flagged(client, db_sessionmaker):
    _, ws = _customer()
    _set_plan(db_sessionmaker, ws, "PRO")
    _add_subscription(db_sessionmaker, ws, "PRO", period_end=dt.datetime.utcnow() - dt.timedelta(days=9))
    _staff(client, db_sessionmaker)
    item = next(i for i in _issues(client)["items"] if i["kind"] == "period_ended")
    assert item["days_overdue"] == 9


def test_two_payments_within_a_day_look_like_a_double_charge_but_weeks_apart_do_not(client, db_sessionmaker):
    _, ws = _customer()
    _set_plan(db_sessionmaker, ws, "PRO")
    sub = _add_subscription(db_sessionmaker, ws, "PRO", period_end=dt.datetime.utcnow() + dt.timedelta(days=20))
    now = dt.datetime.utcnow()
    _add_payment(db_sessionmaker, sub, "pay_A", at=now - dt.timedelta(hours=3))
    _add_payment(db_sessionmaker, sub, "pay_B", at=now)
    _add_payment(db_sessionmaker, sub, "pay_OLD", at=now - dt.timedelta(days=40))
    _staff(client, db_sessionmaker)
    doubles = [i for i in _issues(client)["items"] if i["kind"] == "possible_double_charge"]
    assert len(doubles) == 1 and doubles[0]["payment_id"] == "pay_B" and doubles[0]["severity"] == "high"


def test_only_old_unfinished_checkouts_are_flagged(client, db_sessionmaker):
    _, old_ws = _customer("old@example.com")
    _, new_ws = _customer("new@example.com")
    _add_subscription(db_sessionmaker, old_ws, status="PENDING", updated_at=dt.datetime.utcnow() - dt.timedelta(hours=5))
    _add_subscription(db_sessionmaker, new_ws, status="PENDING")
    _staff(client, db_sessionmaker)
    assert _kinds(client, old_ws) == ["stuck_checkout"] and _kinds(client, new_ws) == []


def test_the_worst_problems_are_listed_first(client, db_sessionmaker):
    _, ws = _customer()
    _, other = _customer("other@example.com")
    _add_subscription(db_sessionmaker, other, status="PENDING", updated_at=dt.datetime.utcnow() - dt.timedelta(hours=5))  # low
    _set_plan(db_sessionmaker, ws, "PRO")  # medium (no subscription)
    _add_webhook(db_sessionmaker, "pay_LOST", ws)  # high
    _staff(client, db_sessionmaker)
    assert [i["severity"] for i in _issues(client)["items"]] == ["high", "medium", "low"]


# ---- plan override ------------------------------------------------------------------------------------------


def test_override_needs_csrf_password_and_reason(client, db_sessionmaker):
    _, ws = _customer()
    _staff(client, db_sessionmaker)
    path = f"/api/admin/workspaces/{ws}/plan-override"
    assert _post(client, path, {"plan": "PRO"}, headers=False).status_code == 403
    assert _post(client, path, {"plan": "PRO"}, password="wrong").status_code == 403
    assert _post(client, path, {"plan": "PRO"}, reason="no").status_code == 422
    assert _post(client, path, {"plan": "ULTRA"}).status_code == 422
    assert _post(client, path, {"plan": "PRO", "billing_cycle": "WEEKLY"}).status_code == 422
    assert _post(client, path, {"plan": "PRO", "period_days": 0}).status_code == 422
    assert _post(client, path, {"plan": "PRO", "period_days": 731}).status_code == 422
    with db_sessionmaker() as db:
        assert db.get(models.Workspace, ws).plan == "FREE"  # nothing above changed anything


def test_customers_and_anonymous_cannot_override(client):
    _, ws = _customer()
    c = TestClient(app)
    assert c.post(f"/api/admin/workspaces/{ws}/plan-override", json={"plan": "PRO", "reason": "long enough", "password": PW}).status_code == 401
    _signup(client, "someone@example.com")
    assert client.post(f"/api/admin/workspaces/{ws}/plan-override", json={"plan": "PRO", "reason": "long enough", "password": PW}).status_code == 403


def test_override_moves_the_workspace_to_the_plan_with_an_active_dated_subscription_and_audits_it(client, db_sessionmaker):
    customer, ws = _customer()
    for i in range(3):
        assert customer.post("/api/accounts", json={"workspace_id": ws, "name": f"A{i}", "broker_name": ""}).status_code == 201
    assert customer.post("/api/accounts", json={"workspace_id": ws, "name": "A4", "broker_name": ""}).status_code == 402  # FREE caps at 3
    _staff(client, db_sessionmaker)

    r = _post(client, f"/api/admin/workspaces/{ws}/plan-override", {"plan": "BUSINESS", "billing_cycle": "YEARLY"}, reason="Paid by bank transfer, ref 123")
    assert r.status_code == 200
    body = r.json()
    assert body["plan"] == "BUSINESS" and body["subscription_status"] == "ACTIVE" and body["current_period_end"].endswith("Z")

    assert customer.post("/api/accounts", json={"workspace_id": ws, "name": "A4", "broker_name": ""}).status_code == 201  # the new limits apply for real
    with db_sessionmaker() as db:
        sub = db.scalar(select(models.Subscription).where(models.Subscription.workspace_id == ws))
        assert sub.plan_name == "BUSINESS" and sub.billing_cycle == "YEARLY" and sub.status == models.SubscriptionStatus.ACTIVE
        assert 360 <= (sub.current_period_end - dt.datetime.utcnow()).days <= 365
    rows = _audit(db_sessionmaker, "PLAN_OVERRIDDEN")
    assert len(rows) == 1 and rows[0].workspace_id == ws
    meta = json.loads(rows[0].metadata_json)
    assert meta["old_plan"] == "FREE" and meta["new_plan"] == "BUSINESS" and meta["reason"] == "Paid by bank transfer, ref 123"


def test_override_can_grant_an_exact_number_of_days(client, db_sessionmaker):
    _, ws = _customer()
    _staff(client, db_sessionmaker)
    _post(client, f"/api/admin/workspaces/{ws}/plan-override", {"plan": "PRO", "period_days": 10}, reason="Goodwill: 10 days free")
    with db_sessionmaker() as db:
        sub = db.scalar(select(models.Subscription).where(models.Subscription.workspace_id == ws))
        assert 9 <= (sub.current_period_end - dt.datetime.utcnow()).days <= 10


def test_override_to_free_cancels_the_subscription(client, db_sessionmaker):
    _, ws = _customer()
    _set_plan(db_sessionmaker, ws, "PRO")
    _add_subscription(db_sessionmaker, ws, "PRO", period_end=dt.datetime.utcnow() + dt.timedelta(days=20))
    _staff(client, db_sessionmaker)
    r = _post(client, f"/api/admin/workspaces/{ws}/plan-override", {"plan": "FREE"}, reason="Refunded, ending the plan")
    assert r.json()["plan"] == "FREE" and r.json()["subscription_status"] == "CANCELED" and r.json()["current_period_end"] is None
    with db_sessionmaker() as db:
        assert db.get(models.Workspace, ws).plan == "FREE"
    assert _kinds(client, ws) == []  # nothing left to flag


def test_override_for_an_unknown_workspace_is_404(client, db_sessionmaker):
    _staff(client, db_sessionmaker)
    assert _post(client, "/api/admin/workspaces/nope/plan-override", {"plan": "PRO"}).status_code == 404


def test_overriding_fixes_the_problem_the_detector_reported(client, db_sessionmaker):
    _, ws = _customer()
    _set_plan(db_sessionmaker, ws, "PRO")  # paid plan, no subscription
    _staff(client, db_sessionmaker)
    assert _kinds(client, ws) == ["plan_without_payment"]
    assert _post(client, f"/api/admin/workspaces/{ws}/plan-override", {"plan": "PRO"}, reason="Confirmed payment off-platform").status_code == 200
    assert _kinds(client, ws) == []


# ---- reconcile a payment ------------------------------------------------------------------------------------


def test_reconcile_records_the_payment_from_the_verified_notice_and_activates_the_plan(client, db_sessionmaker):
    customer, ws = _customer()
    _add_webhook(db_sessionmaker, "pay_LOST", ws, plan="PREMIUM", amount=269900, order_id="order_OLD")  # PREMIUM quarterly
    _staff(client, db_sessionmaker)
    assert _kinds(client, ws) == ["unrecorded_payment"]

    r = _post(client, "/api/admin/billing/reconcile-payment", {"razorpay_payment_id": "pay_LOST"}, reason="Paid an order a newer checkout replaced")
    assert r.status_code == 200 and r.json()["plan"] == "PREMIUM" and r.json()["billing_cycle"] == "QUARTERLY"

    with db_sessionmaker() as db:
        assert db.get(models.Workspace, ws).plan == "PREMIUM"
        sub = db.scalar(select(models.Subscription).where(models.Subscription.workspace_id == ws))
        pay = db.scalar(select(models.Payment).where(models.Payment.razorpay_payment_id == "pay_LOST"))
        assert sub.status == models.SubscriptionStatus.ACTIVE and sub.billing_cycle == "QUARTERLY" and 88 <= (sub.current_period_end - dt.datetime.utcnow()).days <= 90
        assert pay.amount_paise == 269900 and pay.subscription_id == sub.id and pay.plan_name == "PREMIUM"
    assert customer.get(f"/api/workspaces/{ws}/plan").json()["plan"] == "PREMIUM"
    assert _kinds(client, ws) == []  # the issue is gone
    rows = _audit(db_sessionmaker, "PAYMENT_RECONCILED_BY_STAFF")
    assert len(rows) == 1 and "pay_LOST" in rows[0].metadata_json and "newer checkout" in rows[0].metadata_json


def test_reconcile_takes_every_fact_from_the_notice_not_from_the_request(client, db_sessionmaker):
    _, ws = _customer()
    _add_webhook(db_sessionmaker, "pay_LOST", ws, plan="PRO", amount=49900)
    _staff(client, db_sessionmaker)
    r = _post(client, "/api/admin/billing/reconcile-payment", {"razorpay_payment_id": "pay_LOST", "plan_name": "BUSINESS", "plan": "BUSINESS", "amount_paise": 1, "workspace_id": "other"})
    assert r.status_code == 200 and r.json()["plan"] == "PRO"
    with db_sessionmaker() as db:
        assert db.get(models.Workspace, ws).plan == "PRO"


def test_reconcile_refuses_what_it_cannot_prove(client, db_sessionmaker):
    _, ws = _customer()
    _add_webhook(db_sessionmaker, "pay_ODD", ws, amount=12345)  # matches no price
    _add_webhook(db_sessionmaker, "pay_NOWS", "", amount=49900)  # does not say which workspace
    _add_webhook(db_sessionmaker, "pay_GHOST", "no-such-workspace", amount=49900)
    _staff(client, db_sessionmaker)
    assert _post(client, "/api/admin/billing/reconcile-payment", {"razorpay_payment_id": "pay_ODD"}).status_code == 422
    assert _post(client, "/api/admin/billing/reconcile-payment", {"razorpay_payment_id": "pay_NOWS"}).status_code == 422
    assert _post(client, "/api/admin/billing/reconcile-payment", {"razorpay_payment_id": "pay_GHOST"}).status_code == 422
    assert _post(client, "/api/admin/billing/reconcile-payment", {"razorpay_payment_id": "pay_NEVER_SEEN"}).status_code == 404
    with db_sessionmaker() as db:
        assert db.get(models.Workspace, ws).plan == "FREE"
        assert db.scalar(select(models.Payment)) is None


def test_the_same_payment_cannot_be_recorded_twice(client, db_sessionmaker):
    _, ws = _customer()
    _add_webhook(db_sessionmaker, "pay_LOST", ws)
    _staff(client, db_sessionmaker)
    assert _post(client, "/api/admin/billing/reconcile-payment", {"razorpay_payment_id": "pay_LOST"}).status_code == 200
    again = _post(client, "/api/admin/billing/reconcile-payment", {"razorpay_payment_id": "pay_LOST"})
    assert again.status_code == 409
    with db_sessionmaker() as db:
        assert len(db.scalars(select(models.Payment)).all()) == 1


def test_reconcile_needs_csrf_password_and_reason(client, db_sessionmaker):
    _, ws = _customer()
    _add_webhook(db_sessionmaker, "pay_LOST", ws)
    _staff(client, db_sessionmaker)
    path = "/api/admin/billing/reconcile-payment"
    assert _post(client, path, {"razorpay_payment_id": "pay_LOST"}, headers=False).status_code == 403
    assert _post(client, path, {"razorpay_payment_id": "pay_LOST"}, password="wrong").status_code == 403
    assert _post(client, path, {"razorpay_payment_id": "pay_LOST"}, reason="x").status_code == 422
    with db_sessionmaker() as db:
        assert db.scalar(select(models.Payment)) is None and db.get(models.Workspace, ws).plan == "FREE"


def test_every_billing_post_route_requires_csrf():
    from backend.app.routers import admin_actions

    wanted = {"/api/admin/workspaces/{workspace_id}/plan-override", "/api/admin/billing/reconcile-payment"}
    found = {r.path: r for r in admin_actions.router.routes if getattr(r, "path", "") in wanted}
    assert set(found) == wanted
    for route in found.values():
        assert "require_csrf" in {getattr(d.call, "__name__", "") for d in route.dependant.dependencies}
