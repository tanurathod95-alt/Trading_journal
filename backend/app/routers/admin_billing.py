from __future__ import annotations

import datetime as dt
import json
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .. import models
from ..deps import get_db
from ..staff import PlatformRole, require_platform_role
from .admin import _iso
from .billing import _PRICING_PAISE

# Read-only: finds billing records that look wrong. The fixes (change a plan, record a payment) are separate,
# guarded actions in routers/admin_actions.py — spotting a problem needs no password, changing money-related state does.
router = APIRouter(prefix="/api/admin", tags=["admin-billing"], dependencies=[Depends(require_platform_role(PlatformRole.ADMIN))])

_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}
STUCK_CHECKOUT_AFTER = dt.timedelta(hours=1)
DOUBLE_CHARGE_WINDOW = dt.timedelta(hours=24)


def captured_payments_from_webhooks(db: DBSession, limit: int = 500) -> tuple[list[dict[str, Any]], int]:
    """
    Razorpay `payment.captured` events we stored (each was signature-verified when it arrived), parsed into plain
    dicts. Payloads are cut at 4,000 characters when stored, so a very long one can be unreadable — those are counted,
    never guessed at.
    """
    out: list[dict[str, Any]] = []
    unreadable = 0
    events = db.scalars(
        select(models.WebhookEvent).where(models.WebhookEvent.event_type == "payment.captured").order_by(models.WebhookEvent.processed_at.desc()).limit(limit)
    ).all()
    for event in events:
        try:
            entity = json.loads(event.payload_json)["payload"]["payment"]["entity"]
            payment_id = entity["id"]
        except (ValueError, KeyError, TypeError):
            unreadable += 1
            continue
        notes = entity.get("notes") if isinstance(entity.get("notes"), dict) else {}
        out.append(
            {
                "payment_id": payment_id,
                "order_id": entity.get("order_id"),
                "amount_paise": int(entity.get("amount") or 0),
                "workspace_id": notes.get("workspace_id"),
                "plan_name": notes.get("plan_name"),
                "received_at": event.processed_at,
            }
        )
    return out, unreadable


def cycle_for_amount(plan: str, amount_paise: int) -> str | None:
    """Which billing cycle a captured amount corresponds to for a plan — None if it matches no price (never guess)."""
    return next((cycle for cycle, price in _PRICING_PAISE.get(plan, {}).items() if price > 0 and price == amount_paise), None)


def _rupees(paise: int) -> str:
    return f"₹{paise / 100:,.2f}"


def _age(then: dt.datetime, now: dt.datetime) -> str:
    hours = int((now - then).total_seconds() // 3600)
    return f"{hours // 24} day(s)" if hours >= 48 else f"{hours} hour(s)"


@router.get("/billing/issues")
def billing_issues(user_id: str | None = Query(default=None, max_length=36), db: DBSession = Depends(get_db)) -> dict[str, Any]:
    """Every billing problem platform-wide, or — with `user_id` — only those on workspaces that user belongs to (for their user page)."""
    now = dt.datetime.utcnow()
    issues: list[dict[str, Any]] = []
    workspaces = {w.id: w for w in db.scalars(select(models.Workspace)).all()}
    owners = {u.id: u.email for u in db.scalars(select(models.User)).all()}
    subs = {s.workspace_id: s for s in db.scalars(select(models.Subscription)).all()}

    def add(kind: str, severity: str, workspace_id: str | None, title: str, detail: str, **extra: Any) -> None:
        ws = workspaces.get(workspace_id) if workspace_id else None
        issues.append(
            {
                "kind": kind, "severity": severity, "workspace_id": ws.id if ws else None, "workspace_name": ws.name if ws else None,
                "owner_email": owners.get(ws.owner_user_id) if ws else None, "title": title, "detail": detail, **extra,
            }
        )

    # 1. Money Razorpay captured that never became a recorded payment (e.g. paid for an order that a newer checkout replaced).
    captured, unreadable = captured_payments_from_webhooks(db)
    known = set(db.scalars(select(models.Payment.razorpay_payment_id)).all())
    for c in captured:
        if c["payment_id"] in known:
            continue
        cycle = cycle_for_amount(c["plan_name"] or "", c["amount_paise"])
        fixable = bool(c["workspace_id"] in workspaces and cycle)
        add(
            "unrecorded_payment", "high", c["workspace_id"], "Payment received but not recorded",
            f"Razorpay captured {_rupees(c['amount_paise'])} ({c['payment_id']}) but no plan was activated for it. "
            + ("Check it in Razorpay, then record it from here." if fixable else "It can't be matched automatically — check it in Razorpay."),
            payment_id=c["payment_id"], order_id=c["order_id"], amount_inr=round(c["amount_paise"] / 100, 2), plan_name=c["plan_name"], billing_cycle=cycle,
            when=_iso(c["received_at"]), can_reconcile=fixable,
        )

    # 2. A paid plan with no active subscription behind it.
    for ws in workspaces.values():
        sub = subs.get(ws.id)
        if ws.plan != "FREE" and not (sub and sub.status == models.SubscriptionStatus.ACTIVE):
            state = f"the subscription is {sub.status.value.lower()}" if sub else "there is no subscription"
            add("plan_without_payment", "medium", ws.id, "Paid plan without an active subscription", f"On {ws.plan}, but {state}. Either it was set by hand, or the subscription ended and was never downgraded.", current_plan=ws.plan)

    # 3. An active subscription for a different plan than the workspace has.
    for sub in subs.values():
        ws = workspaces.get(sub.workspace_id)
        if ws and sub.status == models.SubscriptionStatus.ACTIVE and sub.plan_name != ws.plan:
            add("plan_mismatch", "high", ws.id, "Plan and subscription disagree", f"The workspace is on {ws.plan} but its active subscription is for {sub.plan_name}.", current_plan=ws.plan, subscription_plan=sub.plan_name)

    # 4. The paid period ended but the workspace is still on the paid plan (nothing downgrades it automatically).
    for sub in subs.values():
        ws = workspaces.get(sub.workspace_id)
        if ws and ws.plan != "FREE" and sub.status == models.SubscriptionStatus.ACTIVE and sub.current_period_end and sub.current_period_end < now:
            days = (now - sub.current_period_end).days
            add("period_ended", "medium", ws.id, "Subscription period has ended", f"The paid period ended {days} day(s) ago but the workspace is still on {ws.plan}.", current_plan=ws.plan, days_overdue=days)

    # 5. Two payments on one subscription within a day — possibly charged twice.
    by_sub: dict[str, list[models.Payment]] = {}
    for payment in db.scalars(select(models.Payment).order_by(models.Payment.subscription_id, models.Payment.created_at)).all():
        by_sub.setdefault(payment.subscription_id, []).append(payment)
    workspace_of_sub = {s.id: s.workspace_id for s in subs.values()}
    for sub_id, rows in by_sub.items():
        for earlier, later in zip(rows, rows[1:]):
            if later.created_at - earlier.created_at <= DOUBLE_CHARGE_WINDOW:
                add(
                    "possible_double_charge", "high", workspace_of_sub.get(sub_id), "Possible double charge",
                    f"Two payments within 24 hours: {earlier.razorpay_payment_id} and {later.razorpay_payment_id}. If the customer meant to pay once, refund one in Razorpay.",
                    payment_id=later.razorpay_payment_id, amount_inr=round(later.amount_paise / 100, 2), when=_iso(later.created_at),
                )

    # 6. A checkout that was started and never finished.
    for sub in subs.values():
        if sub.status == models.SubscriptionStatus.PENDING and now - sub.updated_at > STUCK_CHECKOUT_AFTER:
            add(
                "stuck_checkout", "low", sub.workspace_id, "Checkout never finished",
                f"A {sub.plan_name} {sub.billing_cycle.lower()} checkout was started {_age(sub.updated_at, now)} ago and no payment arrived. Usually the customer simply gave up.",
                order_id=sub.razorpay_order_id,
            )

    if user_id:
        mine = set(db.scalars(select(models.WorkspaceMember.workspace_id).where(models.WorkspaceMember.user_id == user_id)).all())
        issues = [i for i in issues if i["workspace_id"] in mine]
    issues.sort(key=lambda i: (_SEVERITY_ORDER[i["severity"]], i["kind"]))
    by_kind: dict[str, int] = {}
    for item in issues:
        by_kind[item["kind"]] = by_kind.get(item["kind"], 0) + 1
    return {"total": len(issues), "by_kind": by_kind, "items": issues, "unreadable_webhooks": unreadable, "checked_at": _iso(now)}
