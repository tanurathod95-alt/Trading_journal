"""
Dev helper: plants a few clearly-named, deliberately broken billing situations so the admin panel's
"Billing -> Needs attention" tab has something to show, and removes them again. Only ever touches rows it created
(users whose email starts with `billing.demo.`, and webhook events whose id starts with `evt_demo_`).

    python -m backend.app.demo_billing seed     # add the demo problems
    python -m backend.app.demo_billing clean    # remove everything seed created
"""
from __future__ import annotations

import datetime as dt
import json
import sys

from sqlalchemy import delete, select

from . import models, security
from .database import SessionLocal, engine

EMAIL_PREFIX = "billing.demo."
EVENT_PREFIX = "evt_demo_"


def _payload(payment_id: str, workspace_id: str) -> str:
    entity = {"id": payment_id, "order_id": "order_DEMO_OLD", "amount": 49900, "notes": {"workspace_id": workspace_id, "plan_name": "PRO"}}
    return json.dumps({"event": "payment.captured", "payload": {"payment": {"entity": entity}}})


def seed() -> None:
    now = dt.datetime.utcnow()
    with SessionLocal() as db:
        if db.scalar(select(models.User).where(models.User.email.like(f"{EMAIL_PREFIX}%"))) is not None:
            print("Demo data is already there. Run `clean` first if you want to start over.")
            return

        def customer(slug: str, title: str, plan: str) -> models.Workspace:
            user = models.User(email=f"{EMAIL_PREFIX}{slug}@example.com", password_hash=security.hash_password("demo-not-for-login"), display_name=title)
            db.add(user)
            db.flush()
            workspace = models.Workspace(name=f"{title} (DEMO)", owner_user_id=user.id, plan=plan)
            db.add(workspace)
            db.flush()
            db.add(models.WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=models.WorkspaceRole.OWNER))
            return workspace

        def subscription(ws: models.Workspace, plan: str, status: models.SubscriptionStatus, period_end: dt.datetime | None, updated_at: dt.datetime | None = None) -> models.Subscription:
            sub = models.Subscription(workspace_id=ws.id, plan_name=plan, billing_cycle="MONTHLY", status=status, current_period_end=period_end, razorpay_order_id="order_DEMO")
            if updated_at:
                sub.updated_at = updated_at
            db.add(sub)
            db.flush()
            return sub

        # 1. Customer paid, our checkout never activated anything.
        lost = customer("lost-payment", "Demo Lost Payment", "FREE")
        db.add(models.WebhookEvent(razorpay_event_id=f"{EVENT_PREFIX}lost", event_type="payment.captured", payload_json=_payload("pay_DEMO_LOST", lost.id)))

        # 2. On a paid plan with nothing paid behind it.
        customer("no-payment", "Demo No Payment", "PREMIUM")

        # 3. Charged twice within hours.
        double = customer("double-charge", "Demo Double Charge", "PRO")
        sub = subscription(double, "PRO", models.SubscriptionStatus.ACTIVE, now + dt.timedelta(days=25))
        for i, hours_ago in enumerate((3, 0)):
            payment = models.Payment(subscription_id=sub.id, razorpay_payment_id=f"pay_DEMO_DOUBLE_{i}", razorpay_order_id="order_DEMO", amount_paise=49900, plan_name="PRO", billing_cycle="MONTHLY")
            payment.created_at = now - dt.timedelta(hours=hours_ago)
            db.add(payment)

        # 4. The paid month ended, still on the paid plan.
        ended = customer("period-ended", "Demo Period Ended", "PRO")
        subscription(ended, "PRO", models.SubscriptionStatus.ACTIVE, now - dt.timedelta(days=9))

        # 5. Wrong plan: workspace says PRO, the subscription they bought is BUSINESS.
        wrong = customer("wrong-plan", "Demo Wrong Plan", "PRO")
        subscription(wrong, "BUSINESS", models.SubscriptionStatus.ACTIVE, now + dt.timedelta(days=20))

        # 6. Opened checkout and walked away.
        stuck = customer("stuck-checkout", "Demo Stuck Checkout", "FREE")
        subscription(stuck, "PRO", models.SubscriptionStatus.PENDING, None, updated_at=now - dt.timedelta(hours=5))

        db.commit()
    print(f"Seeded 6 demo billing problems into {engine.url.render_as_string(hide_password=True)}")
    print("Open Admin console -> Billing -> Needs attention. Remove them with: python -m backend.app.demo_billing clean")


def clean() -> None:
    with SessionLocal() as db:
        users = db.scalars(select(models.User).where(models.User.email.like(f"{EMAIL_PREFIX}%"))).all()
        user_ids = [u.id for u in users]
        workspace_ids = list(db.scalars(select(models.Workspace.id).where(models.Workspace.owner_user_id.in_(user_ids))).all()) if user_ids else []
        sub_ids = list(db.scalars(select(models.Subscription.id).where(models.Subscription.workspace_id.in_(workspace_ids))).all()) if workspace_ids else []

        if sub_ids:
            db.execute(delete(models.Payment).where(models.Payment.subscription_id.in_(sub_ids)))
            db.execute(delete(models.Subscription).where(models.Subscription.id.in_(sub_ids)))
        db.execute(delete(models.WebhookEvent).where(models.WebhookEvent.razorpay_event_id.like(f"{EVENT_PREFIX}%")))
        if user_ids:
            db.execute(delete(models.ViewAsSession).where(models.ViewAsSession.user_id.in_(user_ids)))
            db.execute(delete(models.PasswordResetToken).where(models.PasswordResetToken.user_id.in_(user_ids)))
            db.execute(delete(models.Session).where(models.Session.user_id.in_(user_ids)))
        if workspace_ids:
            db.execute(delete(models.WorkspaceMember).where(models.WorkspaceMember.workspace_id.in_(workspace_ids)))
            db.execute(delete(models.Workspace).where(models.Workspace.id.in_(workspace_ids)))
        if user_ids:
            # Audit rows are append-only and are never deleted; their user/workspace links simply become empty (ON DELETE SET NULL).
            db.execute(delete(models.User).where(models.User.id.in_(user_ids)))
        db.commit()
    print(f"Removed {len(user_ids)} demo user(s) and their billing data. Audit entries are kept.")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "seed":
        seed()
    elif command == "clean":
        clean()
    else:
        print(__doc__)
        sys.exit(2)
