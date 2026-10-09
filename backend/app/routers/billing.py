from __future__ import annotations

import datetime as dt
import json

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .. import models, schemas, security
from ..audit import AuditAction, log_event
from ..authz import require_workspace_member
from ..config import settings
from ..deps import get_current_user, get_db
from ..plans import PlanTier, count_trading_accounts, limits_for

router = APIRouter(prefix="/api/billing", tags=["billing"])

# Prices in paise (₹1 = 100 paise), matching the spec's pricing table.
# PREMIUM has no published price in the spec — placeholder, between PRO and
# BUSINESS, until a real number is provided; flagged here rather than
# silently guessed elsewhere.
_PRICING_PAISE: dict[str, dict[str, int]] = {
    PlanTier.FREE: {"MONTHLY": 0, "QUARTERLY": 0, "YEARLY": 0},
    PlanTier.PRO: {"MONTHLY": 49900, "QUARTERLY": 129900, "YEARLY": 449900},
    PlanTier.PREMIUM: {"MONTHLY": 99900, "QUARTERLY": 269900, "YEARLY": 999900},
    PlanTier.BUSINESS: {"MONTHLY": 149900, "QUARTERLY": 399900, "YEARLY": 1399900},
}

_CYCLE_DAYS = {"MONTHLY": 30, "QUARTERLY": 90, "YEARLY": 365}

_RAZORPAY_ORDERS_URL = "https://api.razorpay.com/v1/orders"


@router.get("/plans", response_model=list[schemas.PlanPricingOut])
def list_plan_pricing() -> list[schemas.PlanPricingOut]:
    """Public — the pricing page needs this before login. No secrets here, just numbers."""
    return [
        schemas.PlanPricingOut(
            name=name,
            price_monthly_paise=prices["MONTHLY"],
            price_quarterly_paise=prices["QUARTERLY"],
            price_yearly_paise=prices["YEARLY"],
            max_trading_accounts=limits_for(name).max_trading_accounts,
            max_members_per_account=limits_for(name).max_members_per_account,
        )
        for name, prices in _PRICING_PAISE.items()
    ]


@router.get("/workspaces/{workspace_id}/status", response_model=schemas.BillingStatusOut)
def billing_status(
    workspace_id: str, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> schemas.BillingStatusOut:
    membership = require_workspace_member(db, workspace_id, user, min_role=models.WorkspaceRole.ADMIN)
    workspace = membership.workspace
    subscription = db.scalar(select(models.Subscription).where(models.Subscription.workspace_id == workspace_id))
    limits = limits_for(workspace.plan)

    return schemas.BillingStatusOut(
        plan=workspace.plan,
        subscription_status=subscription.status.value if subscription else None,
        billing_cycle=subscription.billing_cycle if subscription else None,
        current_period_end=subscription.current_period_end if subscription else None,
        trading_accounts_used=count_trading_accounts(db, workspace_id),
        max_trading_accounts=limits.max_trading_accounts,
    )


@router.get("/workspaces/{workspace_id}/payments", response_model=list[schemas.PaymentOut])
def list_payments(
    workspace_id: str, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> list[schemas.PaymentOut]:
    """
    Real billing history — every row here is a payment that was actually
    verified (routers/billing.py's verify_payment or the payment.captured
    webhook), so there's no path that puts an unpaid/failed attempt in this
    table. Same ADMIN+ gate as /status: this is read-only workspace info.
    """
    require_workspace_member(db, workspace_id, user, min_role=models.WorkspaceRole.ADMIN)
    subscription = db.scalar(select(models.Subscription).where(models.Subscription.workspace_id == workspace_id))
    if subscription is None:
        return []
    payments = db.scalars(
        select(models.Payment)
        .where(models.Payment.subscription_id == subscription.id)
        .order_by(models.Payment.created_at.desc())
    ).all()
    return [
        schemas.PaymentOut(
            id=p.id,
            created_at=p.created_at,
            plan_name=p.plan_name,
            billing_cycle=p.billing_cycle,
            amount_paise=p.amount_paise,
            status=p.status,
            razorpay_payment_id=p.razorpay_payment_id,
        )
        for p in payments
    ]


@router.post("/workspaces/{workspace_id}/checkout", response_model=schemas.CheckoutOut, status_code=201)
def create_checkout(
    workspace_id: str,
    payload: schemas.CheckoutRequest,
    request: Request,
    db: DBSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
) -> schemas.CheckoutOut:
    """
    OWNER only. Creates a Razorpay Order (test mode) and a PENDING
    Subscription row referencing it. The frontend takes the returned
    order_id + publishable key_id straight into Razorpay Checkout.js — the
    backend never tells the frontend a payment succeeded here, only that
    an order exists to pay.
    """
    membership = require_workspace_member(db, workspace_id, user, min_role=models.WorkspaceRole.OWNER)
    workspace = membership.workspace

    amount_paise = _PRICING_PAISE.get(payload.plan_name, {}).get(payload.billing_cycle)
    if amount_paise is None:
        raise HTTPException(status_code=400, detail="Unknown plan or billing cycle")

    if amount_paise == 0:
        raise HTTPException(status_code=400, detail="The FREE plan does not require checkout")

    try:
        response = httpx.post(
            _RAZORPAY_ORDERS_URL,
            auth=(settings.razorpay_key_id, settings.razorpay_key_secret),
            json={
                "amount": amount_paise,
                "currency": "INR",
                "receipt": f"ws_{workspace_id}_{payload.plan_name}_{payload.billing_cycle}",
                "notes": {"workspace_id": workspace_id, "plan_name": payload.plan_name},
            },
            timeout=15.0,
        )
        response.raise_for_status()
        order = response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach Razorpay to create the order") from exc

    subscription = db.scalar(select(models.Subscription).where(models.Subscription.workspace_id == workspace_id))
    if subscription is None:
        subscription = models.Subscription(workspace_id=workspace_id, plan_name=payload.plan_name)
    subscription.plan_name = payload.plan_name
    subscription.billing_cycle = payload.billing_cycle
    subscription.status = models.SubscriptionStatus.PENDING
    subscription.razorpay_order_id = order["id"]
    subscription.razorpay_payment_id = None

    db.add(subscription)
    log_event(
        db,
        action=AuditAction.CHECKOUT_STARTED,
        user_id=user.id,
        workspace_id=workspace_id,
        request=request,
        metadata={"plan_name": payload.plan_name, "billing_cycle": payload.billing_cycle, "order_id": order["id"]},
    )
    db.commit()
    db.refresh(subscription)

    return schemas.CheckoutOut(
        order_id=order["id"],
        key_id=settings.razorpay_key_id,
        amount_paise=amount_paise,
        currency="INR",
        subscription_id=subscription.id,
    )


@router.post("/workspaces/{workspace_id}/verify", response_model=schemas.BillingStatusOut)
def verify_payment(
    workspace_id: str,
    payload: schemas.VerifyPaymentRequest,
    request: Request,
    db: DBSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
) -> schemas.BillingStatusOut:
    """
    OWNER only. Recomputes the HMAC signature server-side — the frontend's
    claim that Razorpay Checkout succeeded is never trusted on its own.
    Activating the subscription also writes the same Workspace.plan field
    an OWNER could already set manually (Phase 8), so every existing
    entitlement check picks up the new plan with no changes elsewhere.
    """
    membership = require_workspace_member(db, workspace_id, user, min_role=models.WorkspaceRole.OWNER)
    workspace = membership.workspace

    subscription = db.scalar(select(models.Subscription).where(models.Subscription.workspace_id == workspace_id))
    if subscription is None or subscription.razorpay_order_id != payload.razorpay_order_id:
        raise HTTPException(status_code=404, detail="No matching pending checkout for this workspace")

    if not security.verify_razorpay_payment_signature(
        payload.razorpay_order_id, payload.razorpay_payment_id, payload.razorpay_signature
    ):
        log_event(
            db,
            action=AuditAction.PAYMENT_VERIFICATION_FAILED,
            user_id=user.id,
            workspace_id=workspace_id,
            request=request,
            metadata={"order_id": payload.razorpay_order_id},
        )
        db.commit()
        raise HTTPException(status_code=400, detail="Payment signature verification failed")

    existing_payment = db.scalar(
        select(models.Payment).where(models.Payment.razorpay_payment_id == payload.razorpay_payment_id)
    )
    if existing_payment is None:
        amount_paise = _PRICING_PAISE[subscription.plan_name][subscription.billing_cycle]
        db.add(
            models.Payment(
                subscription_id=subscription.id,
                razorpay_payment_id=payload.razorpay_payment_id,
                razorpay_order_id=payload.razorpay_order_id,
                amount_paise=amount_paise,
                # Captured now, not read off `subscription` later — a future
                # upgrade overwrites subscription.plan_name/billing_cycle in
                # place, which would otherwise make every past payment look
                # like it was for whatever the workspace's plan is today.
                plan_name=subscription.plan_name,
                billing_cycle=subscription.billing_cycle,
            )
        )

    subscription.status = models.SubscriptionStatus.ACTIVE
    subscription.razorpay_payment_id = payload.razorpay_payment_id
    subscription.current_period_end = dt.datetime.utcnow() + dt.timedelta(days=_CYCLE_DAYS[subscription.billing_cycle])
    workspace.plan = subscription.plan_name  # drives the existing Phase 8 entitlement engine directly

    db.add(subscription)
    db.add(workspace)
    log_event(
        db,
        action=AuditAction.PAYMENT_VERIFIED,
        user_id=user.id,
        workspace_id=workspace_id,
        request=request,
        metadata={"payment_id": payload.razorpay_payment_id},
    )
    log_event(
        db,
        action=AuditAction.SUBSCRIPTION_ACTIVATED,
        user_id=user.id,
        workspace_id=workspace_id,
        request=request,
        metadata={"plan_name": subscription.plan_name, "billing_cycle": subscription.billing_cycle},
    )
    db.commit()

    limits = limits_for(workspace.plan)
    return schemas.BillingStatusOut(
        plan=workspace.plan,
        subscription_status=subscription.status.value,
        billing_cycle=subscription.billing_cycle,
        current_period_end=subscription.current_period_end,
        trading_accounts_used=count_trading_accounts(db, workspace_id),
        max_trading_accounts=limits.max_trading_accounts,
    )


@router.post("/webhook", status_code=200)
async def razorpay_webhook(request: Request, db: DBSession = Depends(get_db)) -> dict[str, str]:
    """
    Public (Razorpay calls this server-to-server, no user session) but
    signature-verified over the exact raw request body. A safety net
    alongside /verify — e.g. the user closed the browser tab right after
    paying, before /verify ran. Idempotent: WebhookEvent.razorpay_event_id
    is UNIQUE, so a replayed delivery of the same event is a no-op at the
    database level, never double-applied.
    """
    raw_body = await request.body()
    signature = request.headers.get("X-Razorpay-Signature", "")

    if not security.verify_razorpay_webhook_signature(raw_body, signature):
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Malformed webhook payload") from exc

    event_id = request.headers.get("X-Razorpay-Event-Id") or payload.get("id") or payload.get("event_id")
    event_type = payload.get("event", "unknown")

    if not event_id:
        raise HTTPException(status_code=400, detail="Webhook payload is missing an event id")

    existing = db.scalar(select(models.WebhookEvent).where(models.WebhookEvent.razorpay_event_id == event_id))
    if existing is not None:
        return {"status": "already_processed"}

    db.add(
        models.WebhookEvent(
            razorpay_event_id=event_id,
            event_type=event_type,
            payload_json=json.dumps(payload)[:4000],
        )
    )

    if event_type == "payment.captured":
        entity = payload.get("payload", {}).get("payment", {}).get("entity", {})
        order_id = entity.get("order_id")
        payment_id = entity.get("id")
        if order_id and payment_id:
            subscription = db.scalar(select(models.Subscription).where(models.Subscription.razorpay_order_id == order_id))
            if subscription is not None and subscription.status != models.SubscriptionStatus.ACTIVE:
                workspace = db.get(models.Workspace, subscription.workspace_id)
                if workspace is not None:
                    already_paid = db.scalar(select(models.Payment).where(models.Payment.razorpay_payment_id == payment_id))
                    if already_paid is None:
                        db.add(
                            models.Payment(
                                subscription_id=subscription.id,
                                razorpay_payment_id=payment_id,
                                razorpay_order_id=order_id,
                                amount_paise=entity.get("amount", 0),
                                plan_name=subscription.plan_name,
                                billing_cycle=subscription.billing_cycle,
                            )
                        )
                    subscription.status = models.SubscriptionStatus.ACTIVE
                    subscription.razorpay_payment_id = payment_id
                    subscription.current_period_end = dt.datetime.utcnow() + dt.timedelta(
                        days=_CYCLE_DAYS.get(subscription.billing_cycle, 30)
                    )
                    workspace.plan = subscription.plan_name
                    db.add(subscription)
                    db.add(workspace)

    log_event(db, action=AuditAction.WEBHOOK_RECEIVED, metadata={"event_type": event_type, "event_id": event_id})
    db.commit()
    return {"status": "ok"}
