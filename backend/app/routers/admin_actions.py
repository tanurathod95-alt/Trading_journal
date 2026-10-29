from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import Field
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session as DBSession

from .. import models, security
from ..audit import AuditAction, log_event
from ..config import settings
from ..deps import get_db
from ..staff import PlatformRole, require_platform_role
from ..staff_guard import StepUp, csrf_token_for, require_csrf, verify_step_up
from .admin import _iso, _page
from .admin_billing import captured_payments_from_webhooks, cycle_for_amount
from .billing import _CYCLE_DAYS

# Staff *write* actions (phase A2, part 2) and the read-only "view as". Kept apart from routers/admin.py on purpose:
# that file stays GET-only, and a test enforces it. Every POST here needs (1) the CSRF header, (2) the staff member's
# own password again, and (3) a written reason — and every one is recorded in the audit log with the actor and target.
router = APIRouter(prefix="/api/admin", tags=["admin-actions"], dependencies=[Depends(require_platform_role(PlatformRole.ADMIN))])

VIEW_AS_IDLE_MINUTES = 30
_staff = require_platform_role(PlatformRole.ADMIN)


@router.get("/csrf")
def get_csrf_token(request: Request, response: Response) -> dict[str, str]:
    """The token the admin UI must send back in X-CSRF-Token on every write. Readable only by an allowed origin (CORS)."""
    response.headers["Cache-Control"] = "no-store"
    return {"token": csrf_token_for(request.cookies.get(settings.session_cookie_name, ""))}


def _target(db: DBSession, staff: models.User, user_id: str) -> models.User:
    target = db.get(models.User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="User not found")
    if target.id == staff.id:
        raise HTTPException(status_code=403, detail="You can't do this to your own account.")
    if target.platform_role != PlatformRole.USER and staff.platform_role != PlatformRole.DEVELOPER:
        raise HTTPException(status_code=403, detail="Only a developer can manage staff accounts.")
    return target


def _end_sessions(db: DBSession, user_id: str) -> int:
    rows = db.scalars(select(models.Session).where(models.Session.user_id == user_id)).all()
    for row in rows:
        db.delete(row)
    return len(rows)


# ---- account lifecycle -----------------------------------------------------------------------------------


@router.post("/users/{user_id}/disable", dependencies=[Depends(require_csrf)])
def disable_user(user_id: str, body: StepUp, request: Request, db: DBSession = Depends(get_db), staff: models.User = Depends(_staff)) -> dict[str, Any]:
    verify_step_up(db, staff, body.password, request)
    target = _target(db, staff, user_id)
    if not target.is_active:
        raise HTTPException(status_code=409, detail="This account is already disabled.")

    target.is_active = False
    ended = _end_sessions(db, target.id)  # takes effect immediately, not at their next login
    log_event(db, action=AuditAction.USER_DISABLED, user_id=staff.id, target_user_id=target.id, request=request, metadata={"reason": body.reason, "sessions_ended": ended, "by_platform_role": staff.platform_role})
    db.commit()
    return {"id": target.id, "is_active": False, "sessions_ended": ended}


@router.post("/users/{user_id}/enable", dependencies=[Depends(require_csrf)])
def enable_user(user_id: str, body: StepUp, request: Request, db: DBSession = Depends(get_db), staff: models.User = Depends(_staff)) -> dict[str, Any]:
    verify_step_up(db, staff, body.password, request)
    target = _target(db, staff, user_id)
    if target.is_active:
        raise HTTPException(status_code=409, detail="This account is already active.")
    target.is_active = True
    log_event(db, action=AuditAction.USER_ENABLED, user_id=staff.id, target_user_id=target.id, request=request, metadata={"reason": body.reason, "by_platform_role": staff.platform_role})
    db.commit()
    return {"id": target.id, "is_active": True}


@router.post("/users/{user_id}/force-logout", dependencies=[Depends(require_csrf)])
def force_logout(user_id: str, body: StepUp, request: Request, db: DBSession = Depends(get_db), staff: models.User = Depends(_staff)) -> dict[str, Any]:
    verify_step_up(db, staff, body.password, request)
    target = _target(db, staff, user_id)
    ended = _end_sessions(db, target.id)
    log_event(db, action=AuditAction.USER_FORCE_LOGOUT, user_id=staff.id, target_user_id=target.id, request=request, metadata={"reason": body.reason, "sessions_ended": ended})
    db.commit()
    return {"id": target.id, "sessions_ended": ended}


@router.post("/users/{user_id}/password-reset", dependencies=[Depends(require_csrf)])
def issue_password_reset(user_id: str, body: StepUp, request: Request, response: Response, db: DBSession = Depends(get_db), staff: models.User = Depends(_staff)) -> dict[str, Any]:
    """
    Staff-assisted recovery for someone locked out (no email provider yet). Staff never see or choose the customer's
    password: this only mints the same single-use, time-limited link the normal "forgot password" flow uses, and hands it
    to the staff member ONCE — only its hash is stored, so it can't be shown again. The staff member passes it to the
    customer over a channel they trust (e.g. a call back on the number on file); the customer sets their own password.
    Completing the reset signs the customer out everywhere.
    """
    verify_step_up(db, staff, body.password, request)
    target = _target(db, staff, user_id)
    if not target.is_active:
        raise HTTPException(status_code=409, detail="This account is disabled. Enable it first, then issue the link.")

    now = dt.datetime.utcnow()
    for old in db.scalars(select(models.PasswordResetToken).where(models.PasswordResetToken.user_id == target.id, models.PasswordResetToken.used_at.is_(None))).all():
        old.used_at = now  # only the newest link works
    token = security.generate_reset_token()
    expires_at = now + dt.timedelta(minutes=settings.password_reset_ttl_minutes)
    db.add(models.PasswordResetToken(user_id=target.id, token_hash=security.hash_reset_token(token), expires_at=expires_at))
    # The token itself is deliberately not written to the audit log.
    log_event(db, action=AuditAction.PASSWORD_RESET_ISSUED_BY_STAFF, user_id=staff.id, target_user_id=target.id, request=request, metadata={"reason": body.reason, "expires_at": _iso(expires_at)})
    db.commit()

    response.headers["Cache-Control"] = "no-store"
    return {
        "reset_url": f"{settings.frontend_base_url.rstrip('/')}/app?reset_token={token}",
        "expires_at": _iso(expires_at),
        "valid_minutes": settings.password_reset_ttl_minutes,
        "email": target.email,
    }


# ---- view as user (read-only) ----------------------------------------------------------------------------


class ViewAsStart(StepUp):
    user_id: str = Field(min_length=1, max_length=36)


def _close(db: DBSession, view: models.ViewAsSession, why: str, request: Request | None, staff_id: str) -> None:
    view.ended_at = dt.datetime.utcnow()
    view.end_reason = why
    log_event(db, action=AuditAction.ADMIN_VIEW_AS_ENDED, user_id=staff_id, target_user_id=view.user_id, request=request, metadata={"view_as_id": view.id, "end_reason": why})


def _open_view(db: DBSession, view_id: str, staff: models.User, request: Request) -> models.ViewAsSession:
    view = db.get(models.ViewAsSession, view_id)
    if view is None or view.admin_id != staff.id:  # someone else's session id looks exactly like a missing one
        raise HTTPException(status_code=404, detail="View session not found")
    if view.ended_at is not None:
        raise HTTPException(status_code=410, detail="This view has ended.")
    now = dt.datetime.utcnow()
    if now - view.last_seen_at > dt.timedelta(minutes=VIEW_AS_IDLE_MINUTES):
        _close(db, view, "idle", request, staff.id)
        db.commit()
        raise HTTPException(status_code=410, detail=f"This view closed after {VIEW_AS_IDLE_MINUTES} minutes without activity.")
    view.last_seen_at = now
    return view


@router.post("/view-as", dependencies=[Depends(require_csrf)])
def start_view_as(body: ViewAsStart, request: Request, db: DBSession = Depends(get_db), staff: models.User = Depends(_staff)) -> dict[str, Any]:
    verify_step_up(db, staff, body.password, request)
    target = _target(db, staff, body.user_id)
    if target.platform_role != PlatformRole.USER:
        raise HTTPException(status_code=403, detail="'View as' is only for customer accounts.")

    for open_view in db.scalars(select(models.ViewAsSession).where(models.ViewAsSession.admin_id == staff.id, models.ViewAsSession.ended_at.is_(None))).all():
        _close(db, open_view, "replaced", request, staff.id)  # one customer at a time

    view = models.ViewAsSession(admin_id=staff.id, user_id=target.id, reason=body.reason)
    db.add(view)
    db.flush()
    log_event(db, action=AuditAction.ADMIN_VIEW_AS_STARTED, user_id=staff.id, target_user_id=target.id, request=request, metadata={"view_as_id": view.id, "reason": body.reason, "by_platform_role": staff.platform_role})
    db.commit()
    return {"id": view.id, "started_at": _iso(view.started_at), "idle_timeout_minutes": VIEW_AS_IDLE_MINUTES, "user": {"id": target.id, "email": target.email, "display_name": target.display_name}}


def _trade_stats(db: DBSession, account_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not account_ids:
        return {}
    closed = models.Trade.status != "OPEN"
    rows = db.execute(
        select(
            models.Trade.trading_account_id,
            func.count(),
            func.coalesce(func.sum(case((models.Trade.status == "OPEN", 1), else_=0)), 0),
            func.coalesce(func.sum(case((closed & (models.Trade.net_pnl > 0), 1), else_=0)), 0),
            func.coalesce(func.sum(case((closed, 1), else_=0)), 0),
            func.coalesce(func.sum(models.Trade.net_pnl), 0.0),
        )
        .where(models.Trade.trading_account_id.in_(account_ids))
        .group_by(models.Trade.trading_account_id)
    ).all()
    return {
        account_id: {"trades": total, "open_trades": open_, "wins": wins, "closed_trades": closed_, "net_pnl": round(float(pnl), 2), "win_rate": round(wins / closed_ * 100, 1) if closed_ else 0.0}
        for account_id, total, open_, wins, closed_, pnl in rows
    }


def _trade_row(t: models.Trade) -> dict[str, Any]:
    # Journal notes, the "reason" text and instrument details are the customer's private writing — deliberately not included.
    return {
        "id": t.id, "trading_account_id": t.trading_account_id, "trade_date": t.trade_date, "segment": t.segment, "script_name": t.script_name, "side": t.side, "quantity": t.quantity,
        "entry_price": t.entry_price, "exit_date": t.exit_date, "exit_price": t.exit_price, "status": t.status, "gross_pnl": t.gross_pnl, "net_pnl": t.net_pnl,
    }


@router.get("/view-as/{view_id}")
def view_as_dashboard(view_id: str, request: Request, db: DBSession = Depends(get_db), staff: models.User = Depends(_staff)) -> dict[str, Any]:
    view = _open_view(db, view_id, staff, request)
    target = db.get(models.User, view.user_id)
    memberships = db.execute(
        select(models.AccountMember.role, models.TradingAccount)
        .join(models.TradingAccount, models.TradingAccount.id == models.AccountMember.trading_account_id)
        .where(models.AccountMember.user_id == view.user_id)
        .order_by(models.TradingAccount.created_at)
    ).all()
    account_ids = [a.id for _, a in memberships]
    stats = _trade_stats(db, account_ids)
    empty = {"trades": 0, "open_trades": 0, "wins": 0, "closed_trades": 0, "net_pnl": 0.0, "win_rate": 0.0}

    accounts = [{"id": a.id, "name": a.name, "broker_name": a.broker_name, "account_type": a.account_type, "is_archived": a.is_archived, "role": role.value, **stats.get(a.id, empty)} for role, a in memberships]
    wins = sum(s["wins"] for s in stats.values())
    closed = sum(s["closed_trades"] for s in stats.values())
    recent = db.scalars(select(models.Trade).where(models.Trade.trading_account_id.in_(account_ids)).order_by(models.Trade.trade_date.desc(), models.Trade.created_at.desc()).limit(10)).all() if account_ids else []
    db.commit()  # persists last_seen_at

    return {
        "session": {"id": view.id, "started_at": _iso(view.started_at), "last_seen_at": _iso(view.last_seen_at), "idle_timeout_minutes": VIEW_AS_IDLE_MINUTES},
        "user": {"id": target.id, "email": target.email, "display_name": target.display_name, "is_active": target.is_active},
        "totals": {
            "accounts": len(accounts), "trades": sum(s["trades"] for s in stats.values()), "open_trades": sum(s["open_trades"] for s in stats.values()),
            "net_pnl": round(sum(s["net_pnl"] for s in stats.values()), 2), "win_rate": round(wins / closed * 100, 1) if closed else 0.0,
        },
        "accounts": accounts,
        "recent_trades": [_trade_row(t) for t in recent],
        "note": "Only server-side data is shown. A customer's personal-mode journal lives in their own browser and cannot be viewed.",
    }


@router.get("/view-as/{view_id}/accounts/{account_id}/trades")
def view_as_trades(
    view_id: str,
    account_id: str,
    request: Request,
    db: DBSession = Depends(get_db),
    staff: models.User = Depends(_staff),
    status: str = Query(default="all", pattern="^(all|open|closed)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict[str, Any]:
    view = _open_view(db, view_id, staff, request)
    belongs = db.scalar(select(func.count()).select_from(models.AccountMember).where(models.AccountMember.user_id == view.user_id, models.AccountMember.trading_account_id == account_id))
    if not belongs:  # only accounts this customer is actually a member of
        raise HTTPException(status_code=404, detail="Account not found for this customer")

    conditions = [models.Trade.trading_account_id == account_id]
    if status == "open":
        conditions.append(models.Trade.status == "OPEN")
    elif status == "closed":
        conditions.append(models.Trade.status != "OPEN")
    total = db.scalar(select(func.count()).select_from(models.Trade).where(*conditions)) or 0
    rows = db.scalars(select(models.Trade).where(*conditions).order_by(models.Trade.trade_date.desc(), models.Trade.created_at.desc(), models.Trade.id).offset((page - 1) * page_size).limit(page_size)).all()
    db.commit()
    return _page(total, [_trade_row(t) for t in rows], page, page_size)


VIEW_AS_MAX_TRADES = 5000


@router.get("/view-as/{view_id}/data")
def view_as_data(view_id: str, request: Request, db: DBSession = Depends(get_db), staff: models.User = Depends(_staff)) -> dict[str, Any]:
    """
    Everything the customer's own dashboard needs, in the same shape their app receives it, so support can open the real
    dashboard screen read-only. The customer's private writing (journal notes, trade reasons) is deliberately left blank.
    """
    view = _open_view(db, view_id, staff, request)
    target = db.get(models.User, view.user_id)
    accounts = db.scalars(
        select(models.TradingAccount)
        .join(models.AccountMember, models.AccountMember.trading_account_id == models.TradingAccount.id)
        .where(models.AccountMember.user_id == view.user_id)
        .order_by(models.TradingAccount.created_at)
    ).all()
    account_ids = [a.id for a in accounts]
    total = db.scalar(select(func.count()).select_from(models.Trade).where(models.Trade.trading_account_id.in_(account_ids))) if account_ids else 0
    trades = (
        db.scalars(select(models.Trade).where(models.Trade.trading_account_id.in_(account_ids)).order_by(models.Trade.trade_date.desc(), models.Trade.created_at.desc()).limit(VIEW_AS_MAX_TRADES)).all()
        if account_ids
        else []
    )
    db.commit()  # persists last_seen_at
    return {
        "user": {"id": target.id, "email": target.email, "display_name": target.display_name},
        "accounts": [
            {
                "id": a.id, "workspace_id": a.workspace_id, "portfolio_id": a.portfolio_id, "name": a.name, "broker_name": a.broker_name, "account_type": a.account_type,
                "contact_number": "", "is_archived": a.is_archived, "role": "VIEWER", "created_at": _iso(a.created_at), "updated_at": _iso(a.updated_at),
            }
            for a in accounts
        ],
        "trades": [
            {
                "id": t.id, "trading_account_id": t.trading_account_id, "trade_date": t.trade_date, "segment": t.segment, "script_name": t.script_name, "reason": "",
                "quantity": t.quantity, "side": t.side, "entry_price": t.entry_price, "exit_date": t.exit_date, "exit_price": t.exit_price, "status": t.status,
                "gross_pnl": t.gross_pnl, "net_pnl": t.net_pnl, "notes": "", "instrument_json": None, "created_at": _iso(t.created_at), "updated_at": _iso(t.updated_at),
            }
            for t in trades
        ],
        "total_trades": total,
        "truncated": bool(total and total > len(trades)),
    }


@router.post("/view-as/{view_id}/end", dependencies=[Depends(require_csrf)])
def end_view_as(view_id: str, request: Request, db: DBSession = Depends(get_db), staff: models.User = Depends(_staff)) -> dict[str, bool]:
    view = db.get(models.ViewAsSession, view_id)
    if view is None or view.admin_id != staff.id:
        raise HTTPException(status_code=404, detail="View session not found")
    if view.ended_at is None:
        _close(db, view, "manual", request, staff.id)
        db.commit()
    return {"ended": True}


# ---- billing fixes ---------------------------------------------------------------------------------------
# Money itself never moves from here: refunds are done in the Razorpay dashboard. These only correct *our* records of
# who is on which plan — and every one needs the CSRF header, the staff member's password, and a reason.


class PlanOverride(StepUp):
    plan: str = Field(pattern="^(FREE|PRO|PREMIUM|BUSINESS)$")
    billing_cycle: str = Field(default="MONTHLY", pattern="^(MONTHLY|QUARTERLY|YEARLY)$")
    # How long the paid plan lasts from now. Default is the cycle's normal length; a comp/extension can be anything up to 2 years.
    period_days: int | None = Field(default=None, ge=1, le=730)


@router.post("/workspaces/{workspace_id}/plan-override", dependencies=[Depends(require_csrf)])
def plan_override(workspace_id: str, body: PlanOverride, request: Request, db: DBSession = Depends(get_db), staff: models.User = Depends(_staff)) -> dict[str, Any]:
    """
    Puts a workspace on a plan by hand — fixing a wrong purchase, a comp/extension, or ending a plan. A paid plan gets
    an ACTIVE subscription with an end date (so it shows up properly in billing); FREE cancels any live subscription.
    """
    verify_step_up(db, staff, body.password, request)
    workspace = db.get(models.Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="Workspace not found")

    now = dt.datetime.utcnow()
    old_plan = workspace.plan
    subscription = db.scalar(select(models.Subscription).where(models.Subscription.workspace_id == workspace.id))
    period_end: dt.datetime | None = None

    if body.plan == "FREE":
        if subscription is not None and subscription.status in (models.SubscriptionStatus.ACTIVE, models.SubscriptionStatus.PENDING):
            subscription.status = models.SubscriptionStatus.CANCELED
            subscription.current_period_end = now
    else:
        period_end = now + dt.timedelta(days=body.period_days or _CYCLE_DAYS[body.billing_cycle])
        if subscription is None:
            subscription = models.Subscription(workspace_id=workspace.id, plan_name=body.plan)
        subscription.plan_name = body.plan
        subscription.billing_cycle = body.billing_cycle
        subscription.status = models.SubscriptionStatus.ACTIVE
        subscription.current_period_end = period_end
    if subscription is not None:
        db.add(subscription)

    workspace.plan = body.plan
    db.add(workspace)
    log_event(
        db, action=AuditAction.PLAN_OVERRIDDEN, user_id=staff.id, workspace_id=workspace.id, request=request,
        metadata={"old_plan": old_plan, "new_plan": body.plan, "billing_cycle": body.billing_cycle if body.plan != "FREE" else None, "period_end": _iso(period_end), "reason": body.reason, "by_platform_role": staff.platform_role},
    )
    db.commit()
    return {"workspace_id": workspace.id, "plan": workspace.plan, "subscription_status": subscription.status.value if subscription else None, "current_period_end": _iso(period_end)}


class ReconcilePayment(StepUp):
    razorpay_payment_id: str = Field(min_length=1, max_length=64)


@router.post("/billing/reconcile-payment", dependencies=[Depends(require_csrf)])
def reconcile_payment(body: ReconcilePayment, request: Request, db: DBSession = Depends(get_db), staff: models.User = Depends(_staff)) -> dict[str, Any]:
    """
    Records a payment Razorpay captured but our checkout never activated (for example the customer paid an order that a
    newer checkout had replaced). The facts come only from the signature-verified `payment.captured` notice we stored —
    which workspace and plan it was for, and the amount — never from what the staff member types.
    """
    verify_step_up(db, staff, body.password, request)
    if db.scalar(select(models.Payment).where(models.Payment.razorpay_payment_id == body.razorpay_payment_id)) is not None:
        raise HTTPException(status_code=409, detail="That payment is already recorded.")

    captured, _ = captured_payments_from_webhooks(db)
    notice = next((c for c in captured if c["payment_id"] == body.razorpay_payment_id), None)
    if notice is None:
        raise HTTPException(status_code=404, detail="No verified Razorpay 'payment captured' notice for that payment id.")

    workspace = db.get(models.Workspace, notice["workspace_id"]) if notice["workspace_id"] else None
    if workspace is None:
        raise HTTPException(status_code=422, detail="The payment doesn't say which workspace it was for. Match it by hand in Razorpay.")
    plan = notice["plan_name"] or ""
    cycle = cycle_for_amount(plan, notice["amount_paise"])
    if cycle is None:
        raise HTTPException(status_code=422, detail="The amount paid doesn't match any price for that plan, so it can't be recorded automatically.")

    now = dt.datetime.utcnow()
    subscription = db.scalar(select(models.Subscription).where(models.Subscription.workspace_id == workspace.id))
    if subscription is None:
        subscription = models.Subscription(workspace_id=workspace.id, plan_name=plan)
    subscription.plan_name = plan
    subscription.billing_cycle = cycle
    subscription.status = models.SubscriptionStatus.ACTIVE
    subscription.razorpay_order_id = notice["order_id"]
    subscription.razorpay_payment_id = notice["payment_id"]
    subscription.current_period_end = now + dt.timedelta(days=_CYCLE_DAYS[cycle])  # from now, so the customer doesn't lose time to our delay
    db.add(subscription)
    db.flush()
    db.add(
        models.Payment(
            subscription_id=subscription.id, razorpay_payment_id=notice["payment_id"], razorpay_order_id=notice["order_id"] or "",
            amount_paise=notice["amount_paise"], plan_name=plan, billing_cycle=cycle,
        )
    )
    workspace.plan = plan
    db.add(workspace)
    log_event(
        db, action=AuditAction.PAYMENT_RECONCILED_BY_STAFF, user_id=staff.id, workspace_id=workspace.id, request=request,
        metadata={"payment_id": notice["payment_id"], "plan": plan, "billing_cycle": cycle, "amount_paise": notice["amount_paise"], "reason": body.reason},
    )
    db.commit()
    return {"workspace_id": workspace.id, "plan": plan, "billing_cycle": cycle, "current_period_end": _iso(subscription.current_period_end)}
