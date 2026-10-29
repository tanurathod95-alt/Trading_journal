from __future__ import annotations

import csv
import datetime as dt
import io
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import Session as DBSession

from .. import models
from ..audit import AuditAction, log_event
from ..deps import get_db
from ..plans import count_trading_accounts, limits_for
from ..staff import PlatformRole, require_platform_role

# Read-only admin API (phase A2, part 1). Every route needs platform role ADMIN or above, re-read from the DB on
# each request. Deliberately GET-only: nothing here can change customer data, so there is no write path to
# protect with CSRF/step-up yet. It also never returns password hashes, session tokens, broker credentials or
# webhook payloads — only the metadata staff need to support customers.
router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_platform_role(PlatformRole.ADMIN))])

_UTC = dt.timezone.utc
_MAX_EXPORT_ROWS = 5000


def _iso(value: dt.datetime | None) -> str | None:
    """Database datetimes are naive UTC; send them with an explicit Z so browsers don't read them as local time."""
    return value.replace(tzinfo=_UTC).isoformat().replace("+00:00", "Z") if value else None


def _like(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _page(total: int, items: list[Any], page: int, page_size: int) -> dict[str, Any]:
    return {"items": items, "total": total, "page": page, "page_size": page_size}


# Audit metadata is written for customers' own audit trail and can carry what they traded. Staff lists show
# who did what and when, not trade contents (those belong only in an audited "view as"), so these keys are dropped.
_HIDDEN_METADATA_KEYS = {"script_name"}


def _parse_metadata(raw: str | None) -> Any:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return raw
    if isinstance(parsed, dict):
        return {k: v for k, v in parsed.items() if k not in _HIDDEN_METADATA_KEYS}
    return parsed


def _day_start(days_ago: int = 0) -> dt.datetime:
    now = dt.datetime.utcnow()
    return now.replace(hour=0, minute=0, second=0, microsecond=0) - dt.timedelta(days=days_ago)


# ---- summary ----------------------------------------------------------------------------------------------


@router.get("/summary")
def summary(db: DBSession = Depends(get_db)) -> dict[str, Any]:
    now = dt.datetime.utcnow()

    def count(stmt) -> int:  # noqa: ANN001
        return db.scalar(stmt) or 0

    plans = dict(db.execute(select(models.Workspace.plan, func.count()).group_by(models.Workspace.plan)).all())
    sub_status = {str(k.value if hasattr(k, "value") else k): v for k, v in db.execute(select(models.Subscription.status, func.count()).group_by(models.Subscription.status)).all()}
    paid_30d = count(select(func.coalesce(func.sum(models.Payment.amount_paise), 0)).where(models.Payment.created_at >= now - dt.timedelta(days=30)))
    return {
        "users": {
            "total": count(select(func.count()).select_from(models.User)),
            "disabled": count(select(func.count()).select_from(models.User).where(models.User.is_active.is_(False))),
            "staff": count(select(func.count()).select_from(models.User).where(models.User.platform_role != PlatformRole.USER)),
            "signed_up_today": count(select(func.count()).select_from(models.User).where(models.User.created_at >= _day_start())),
            "signed_up_7d": count(select(func.count()).select_from(models.User).where(models.User.created_at >= _day_start(6))),
            "with_active_session": count(select(func.count(func.distinct(models.Session.user_id))).where(models.Session.expires_at > now)),
        },
        "workspaces": {"total": count(select(func.count()).select_from(models.Workspace)), "by_plan": plans},
        "accounts": {"total": count(select(func.count()).select_from(models.TradingAccount))},
        "billing": {
            "subscriptions_by_status": sub_status,
            "expiring_in_7d": count(
                select(func.count()).select_from(models.Subscription).where(
                    models.Subscription.status == models.SubscriptionStatus.ACTIVE,
                    models.Subscription.current_period_end.is_not(None),
                    models.Subscription.current_period_end <= now + dt.timedelta(days=7),
                )
            ),
            "paid_last_30d_inr": round(paid_30d / 100, 2),
        },
        "invitations": {
            "pending": count(select(func.count()).select_from(models.Invitation).where(models.Invitation.status == models.InvitationStatus.PENDING))
            + count(select(func.count()).select_from(models.PortfolioInvitation).where(models.PortfolioInvitation.status == models.InvitationStatus.PENDING)),
        },
        "security": {
            "failed_logins_24h": count(
                select(func.count()).select_from(models.AuditLog).where(
                    models.AuditLog.action == AuditAction.LOGIN_FAILED, models.AuditLog.created_at >= now - dt.timedelta(hours=24)
                )
            ),
        },
        "generated_at": _iso(now),
    }


# ---- users ------------------------------------------------------------------------------------------------


@router.get("/users")
def list_users(
    db: DBSession = Depends(get_db),
    q: str | None = Query(default=None, max_length=100),
    status: str = Query(default="all", pattern="^(all|active|disabled)$"),
    role: str = Query(default="all", pattern="^(all|USER|ADMIN|DEVELOPER)$"),
    plan: str = Query(default="all", pattern="^(all|FREE|PRO|PREMIUM|BUSINESS)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict[str, Any]:
    conditions = []
    if q and q.strip():
        needle = _like(q.strip())
        conditions.append(or_(models.User.email.ilike(needle, escape="\\"), models.User.display_name.ilike(needle, escape="\\")))
    if status != "all":
        conditions.append(models.User.is_active.is_(status == "active"))
    if role != "all":
        conditions.append(models.User.platform_role == role)
    if plan != "all":
        conditions.append(
            exists().where(
                and_(
                    models.WorkspaceMember.user_id == models.User.id,
                    models.WorkspaceMember.role == models.WorkspaceRole.OWNER,
                    models.WorkspaceMember.workspace_id == models.Workspace.id,
                    models.Workspace.plan == plan,
                )
            )
        )

    total = db.scalar(select(func.count()).select_from(models.User).where(*conditions)) or 0
    users = db.scalars(
        select(models.User).where(*conditions).order_by(models.User.created_at.desc(), models.User.id).offset((page - 1) * page_size).limit(page_size)
    ).all()
    ids = [u.id for u in users]
    if not ids:
        return _page(total, [], page, page_size)

    now = dt.datetime.utcnow()
    workspaces: dict[str, list[dict[str, Any]]] = {i: [] for i in ids}
    workspace_ids: set[str] = set()
    for user_id, ws_id, ws_name, ws_plan, ws_role in db.execute(
        select(models.WorkspaceMember.user_id, models.Workspace.id, models.Workspace.name, models.Workspace.plan, models.WorkspaceMember.role)
        .join(models.Workspace, models.Workspace.id == models.WorkspaceMember.workspace_id)
        .where(models.WorkspaceMember.user_id.in_(ids))
    ).all():
        workspaces[user_id].append({"id": ws_id, "name": ws_name, "plan": ws_plan, "role": ws_role.value})
        workspace_ids.add(ws_id)

    sub_status = {
        ws_id: (status_.value, period_end)
        for ws_id, status_, period_end in db.execute(
            select(models.Subscription.workspace_id, models.Subscription.status, models.Subscription.current_period_end).where(
                models.Subscription.workspace_id.in_(workspace_ids)
            )
        ).all()
    } if workspace_ids else {}
    account_counts = dict(
        db.execute(select(models.AccountMember.user_id, func.count()).where(models.AccountMember.user_id.in_(ids)).group_by(models.AccountMember.user_id)).all()
    )
    last_login = dict(
        db.execute(
            select(models.AuditLog.user_id, func.max(models.AuditLog.created_at))
            .where(models.AuditLog.action == AuditAction.LOGIN_SUCCESS, models.AuditLog.user_id.in_(ids))
            .group_by(models.AuditLog.user_id)
        ).all()
    )
    sessions = dict(
        db.execute(
            select(models.Session.user_id, func.count()).where(models.Session.user_id.in_(ids), models.Session.expires_at > now).group_by(models.Session.user_id)
        ).all()
    )

    items = []
    for u in users:
        owned = next((w for w in workspaces[u.id] if w["role"] == "OWNER"), None) or (workspaces[u.id][0] if workspaces[u.id] else None)
        subscription = sub_status.get(owned["id"]) if owned else None
        items.append(
            {
                "id": u.id,
                "email": u.email,
                "display_name": u.display_name,
                "is_active": u.is_active,
                "platform_role": u.platform_role,
                "created_at": _iso(u.created_at),
                "last_login_at": _iso(last_login.get(u.id)),
                "active_sessions": sessions.get(u.id, 0),
                "accounts": account_counts.get(u.id, 0),
                "workspaces": workspaces[u.id],
                "plan": owned["plan"] if owned else None,
                "subscription_status": subscription[0] if subscription else None,
                "subscription_period_end": _iso(subscription[1]) if subscription else None,
            }
        )
    return _page(total, items, page, page_size)


@router.get("/users/{user_id}")
def user_detail(user_id: str, request: Request, db: DBSession = Depends(get_db), staff: models.User = Depends(require_platform_role(PlatformRole.ADMIN))) -> dict[str, Any]:
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    now = dt.datetime.utcnow()

    memberships = db.execute(
        select(models.WorkspaceMember, models.Workspace)
        .join(models.Workspace, models.Workspace.id == models.WorkspaceMember.workspace_id)
        .where(models.WorkspaceMember.user_id == user.id)
        .order_by(models.Workspace.created_at)
    ).all()
    workspaces, workspace_ids = [], []
    for member, workspace in memberships:
        limits = limits_for(workspace.plan)
        workspace_ids.append(workspace.id)
        workspaces.append(
            {
                "id": workspace.id,
                "name": workspace.name,
                "role": member.role.value,
                "plan": workspace.plan,
                "limits": {"max_trading_accounts": limits.max_trading_accounts, "max_members_per_account": limits.max_members_per_account},
                "trading_accounts_used": count_trading_accounts(db, workspace.id),
                "created_at": _iso(workspace.created_at),
            }
        )

    trade_counts = dict(db.execute(select(models.Trade.trading_account_id, func.count()).group_by(models.Trade.trading_account_id)).all())
    accounts = [
        {
            "id": account.id,
            "name": account.name,
            "broker_name": account.broker_name,
            "account_type": account.account_type,
            "is_archived": account.is_archived,
            "role": member.role.value,
            "workspace_id": account.workspace_id,
            "trades": trade_counts.get(account.id, 0),  # a count only — no trade contents here
        }
        for member, account in db.execute(
            select(models.AccountMember, models.TradingAccount)
            .join(models.TradingAccount, models.TradingAccount.id == models.AccountMember.trading_account_id)
            .where(models.AccountMember.user_id == user.id)
            .order_by(models.TradingAccount.created_at)
        ).all()
    ]

    subscriptions, payments = [], []
    if workspace_ids:
        subs = db.scalars(select(models.Subscription).where(models.Subscription.workspace_id.in_(workspace_ids))).all()
        subscriptions = [
            {
                "id": s.id, "workspace_id": s.workspace_id, "plan_name": s.plan_name, "billing_cycle": s.billing_cycle,
                "status": s.status.value, "current_period_end": _iso(s.current_period_end), "created_at": _iso(s.created_at),
            }
            for s in subs
        ]
        payments = [
            {
                "id": p.id, "razorpay_payment_id": p.razorpay_payment_id, "razorpay_order_id": p.razorpay_order_id,
                "amount_inr": round(p.amount_paise / 100, 2), "status": p.status, "plan_name": p.plan_name,
                "billing_cycle": p.billing_cycle, "created_at": _iso(p.created_at),
            }
            for p in db.scalars(
                select(models.Payment).where(models.Payment.subscription_id.in_([s.id for s in subs])).order_by(models.Payment.created_at.desc()).limit(20)
            ).all()
        ] if subs else []

    # Session *tokens* are credentials — only when each session started and when it ends is exposed.
    sessions = [
        {"started_at": _iso(s.created_at), "expires_at": _iso(s.expires_at), "active": s.expires_at > now}
        for s in db.scalars(select(models.Session).where(models.Session.user_id == user.id).order_by(models.Session.created_at.desc()).limit(10)).all()
    ]

    audit = [
        {"id": a.id, "action": a.action, "created_at": _iso(a.created_at), "ip_address": a.ip_address, "metadata": _parse_metadata(a.metadata_json), "as_target": a.user_id != user.id}
        for a in db.scalars(
            select(models.AuditLog).where(or_(models.AuditLog.user_id == user.id, models.AuditLog.target_user_id == user.id)).order_by(models.AuditLog.created_at.desc()).limit(30)
        ).all()
    ]

    invites = [
        {"kind": "account", "email": i.email, "role": i.role.value, "status": i.status.value, "created_at": _iso(i.created_at), "expires_at": _iso(i.expires_at)}
        for i in db.scalars(select(models.Invitation).where(func.lower(models.Invitation.email) == user.email.lower()).order_by(models.Invitation.created_at.desc()).limit(20)).all()
    ] + [
        {"kind": "portfolio", "email": i.email, "role": i.role.value, "status": i.status.value, "created_at": _iso(i.created_at), "expires_at": _iso(i.expires_at)}
        for i in db.scalars(select(models.PortfolioInvitation).where(func.lower(models.PortfolioInvitation.email) == user.email.lower()).order_by(models.PortfolioInvitation.created_at.desc()).limit(20)).all()
    ]

    last_login = db.scalar(select(func.max(models.AuditLog.created_at)).where(models.AuditLog.user_id == user.id, models.AuditLog.action == AuditAction.LOGIN_SUCCESS))
    failed_logins_7d = db.scalar(
        select(func.count()).select_from(models.AuditLog).where(
            models.AuditLog.user_id == user.id, models.AuditLog.action == AuditAction.LOGIN_FAILED, models.AuditLog.created_at >= now - dt.timedelta(days=7)
        )
    ) or 0

    # Reading a customer's record is itself an auditable staff action.
    log_event(db, action=AuditAction.ADMIN_USER_VIEWED, user_id=staff.id, target_user_id=user.id, request=request, metadata={"by_platform_role": staff.platform_role})
    db.commit()

    return {
        "profile": {
            "id": user.id, "email": user.email, "display_name": user.display_name, "is_active": user.is_active,
            "platform_role": user.platform_role, "created_at": _iso(user.created_at), "last_login_at": _iso(last_login), "failed_logins_7d": failed_logins_7d,
        },
        "workspaces": workspaces,
        "accounts": accounts,
        "subscriptions": subscriptions,
        "payments": payments,
        "sessions": sessions,
        "invitations": invites,
        "audit": audit,
    }


# ---- workspaces -------------------------------------------------------------------------------------------


@router.get("/workspaces")
def list_workspaces(
    db: DBSession = Depends(get_db),
    q: str | None = Query(default=None, max_length=100),
    plan: str = Query(default="all", pattern="^(all|FREE|PRO|PREMIUM|BUSINESS)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict[str, Any]:
    conditions = []
    if q and q.strip():
        conditions.append(models.Workspace.name.ilike(_like(q.strip()), escape="\\"))
    if plan != "all":
        conditions.append(models.Workspace.plan == plan)

    total = db.scalar(select(func.count()).select_from(models.Workspace).where(*conditions)) or 0
    rows = db.execute(
        select(models.Workspace, models.User.email)
        .join(models.User, models.User.id == models.Workspace.owner_user_id)
        .where(*conditions)
        .order_by(models.Workspace.created_at.desc(), models.Workspace.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    ids = [w.id for w, _ in rows]
    members = dict(db.execute(select(models.WorkspaceMember.workspace_id, func.count()).where(models.WorkspaceMember.workspace_id.in_(ids)).group_by(models.WorkspaceMember.workspace_id)).all()) if ids else {}
    subs = {s.workspace_id: s for s in db.scalars(select(models.Subscription).where(models.Subscription.workspace_id.in_(ids))).all()} if ids else {}

    items = []
    for workspace, owner_email in rows:
        limits = limits_for(workspace.plan)
        sub = subs.get(workspace.id)
        items.append(
            {
                "id": workspace.id, "name": workspace.name, "owner_email": owner_email, "plan": workspace.plan, "members": members.get(workspace.id, 0),
                "limits": {"max_trading_accounts": limits.max_trading_accounts, "max_members_per_account": limits.max_members_per_account},
                "trading_accounts_used": count_trading_accounts(db, workspace.id),
                "subscription_status": sub.status.value if sub else None,
                "subscription_period_end": _iso(sub.current_period_end) if sub else None,
                "created_at": _iso(workspace.created_at),
            }
        )
    return _page(total, items, page, page_size)


# ---- billing ----------------------------------------------------------------------------------------------


@router.get("/billing/overview")
def billing_overview(db: DBSession = Depends(get_db)) -> dict[str, Any]:
    now = dt.datetime.utcnow()
    last_webhook = db.scalar(select(func.max(models.WebhookEvent.processed_at)))
    failures = db.scalars(
        select(models.AuditLog).where(models.AuditLog.action == AuditAction.PAYMENT_VERIFICATION_FAILED).order_by(models.AuditLog.created_at.desc()).limit(20)
    ).all()
    return {
        "last_webhook_at": _iso(last_webhook),
        "webhooks_total": db.scalar(select(func.count()).select_from(models.WebhookEvent)) or 0,
        "verification_failures_24h": db.scalar(
            select(func.count()).select_from(models.AuditLog).where(models.AuditLog.action == AuditAction.PAYMENT_VERIFICATION_FAILED, models.AuditLog.created_at >= now - dt.timedelta(hours=24))
        ) or 0,
        "recent_verification_failures": [
            {"at": _iso(a.created_at), "user_id": a.user_id, "workspace_id": a.workspace_id, "ip_address": a.ip_address, "metadata": _parse_metadata(a.metadata_json)} for a in failures
        ],
    }


@router.get("/billing/subscriptions")
def list_subscriptions(
    db: DBSession = Depends(get_db),
    status: str = Query(default="all", pattern="^(all|PENDING|ACTIVE|EXPIRED|CANCELED|expiring)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict[str, Any]:
    now = dt.datetime.utcnow()
    conditions = []
    if status == "expiring":
        conditions += [models.Subscription.status == models.SubscriptionStatus.ACTIVE, models.Subscription.current_period_end.is_not(None), models.Subscription.current_period_end <= now + dt.timedelta(days=7)]
    elif status != "all":
        conditions.append(models.Subscription.status == models.SubscriptionStatus(status))

    total = db.scalar(select(func.count()).select_from(models.Subscription).where(*conditions)) or 0
    rows = db.execute(
        select(models.Subscription, models.Workspace.name, models.User.email)
        .join(models.Workspace, models.Workspace.id == models.Subscription.workspace_id)
        .join(models.User, models.User.id == models.Workspace.owner_user_id)
        .where(*conditions)
        .order_by(models.Subscription.updated_at.desc(), models.Subscription.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    items = [
        {
            "id": s.id, "workspace_id": s.workspace_id, "workspace_name": ws_name, "owner_email": owner, "plan_name": s.plan_name, "billing_cycle": s.billing_cycle,
            "status": s.status.value, "current_period_end": _iso(s.current_period_end),
            "expiring_soon": bool(s.status == models.SubscriptionStatus.ACTIVE and s.current_period_end and s.current_period_end <= now + dt.timedelta(days=7)),
            "razorpay_order_id": s.razorpay_order_id, "razorpay_payment_id": s.razorpay_payment_id, "updated_at": _iso(s.updated_at),
        }
        for s, ws_name, owner in rows
    ]
    return _page(total, items, page, page_size)


@router.get("/billing/payments")
def list_payments(
    db: DBSession = Depends(get_db),
    status: str | None = Query(default=None, max_length=20),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict[str, Any]:
    conditions = [models.Payment.status == status] if status else []
    total = db.scalar(select(func.count()).select_from(models.Payment).where(*conditions)) or 0
    rows = db.execute(
        select(models.Payment, models.Workspace.name, models.User.email)
        .join(models.Subscription, models.Subscription.id == models.Payment.subscription_id)
        .join(models.Workspace, models.Workspace.id == models.Subscription.workspace_id)
        .join(models.User, models.User.id == models.Workspace.owner_user_id)
        .where(*conditions)
        .order_by(models.Payment.created_at.desc(), models.Payment.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    items = [
        {
            "id": p.id, "razorpay_payment_id": p.razorpay_payment_id, "razorpay_order_id": p.razorpay_order_id, "amount_inr": round(p.amount_paise / 100, 2),
            "status": p.status, "plan_name": p.plan_name, "billing_cycle": p.billing_cycle, "workspace_name": ws_name, "owner_email": owner, "created_at": _iso(p.created_at),
        }
        for p, ws_name, owner in rows
    ]
    return _page(total, items, page, page_size)


@router.get("/billing/webhooks")
def list_webhooks(db: DBSession = Depends(get_db), page: int = Query(default=1, ge=1), page_size: int = Query(default=25, ge=1, le=100)) -> dict[str, Any]:
    total = db.scalar(select(func.count()).select_from(models.WebhookEvent)) or 0
    rows = db.scalars(select(models.WebhookEvent).order_by(models.WebhookEvent.processed_at.desc(), models.WebhookEvent.id).offset((page - 1) * page_size).limit(page_size)).all()
    # payload_json is intentionally not returned: it can carry customer contact/payment details.
    return _page(total, [{"id": w.id, "razorpay_event_id": w.razorpay_event_id, "event_type": w.event_type, "processed_at": _iso(w.processed_at)} for w in rows], page, page_size)


# ---- invitations ------------------------------------------------------------------------------------------


@router.get("/invitations")
def list_invitations(
    db: DBSession = Depends(get_db),
    status: str = Query(default="all", pattern="^(all|PENDING|ACCEPTED|DECLINED|REVOKED|EXPIRED)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict[str, Any]:
    now = dt.datetime.utcnow()
    inviter = models.User

    def rows_for(model, target_model, target_fk):  # noqa: ANN001
        stmt = (
            select(model, target_model.name, inviter.email)
            .join(target_model, target_model.id == getattr(model, target_fk))
            .join(inviter, inviter.id == model.invited_by_user_id)
        )
        if status == "EXPIRED":
            stmt = stmt.where(model.status == models.InvitationStatus.PENDING, model.expires_at < now)
        elif status == "PENDING":
            stmt = stmt.where(model.status == models.InvitationStatus.PENDING, model.expires_at >= now)
        elif status != "all":
            stmt = stmt.where(model.status == models.InvitationStatus(status))
        return stmt

    merged = []
    for kind, model, target, fk in (("account", models.Invitation, models.TradingAccount, "trading_account_id"), ("portfolio", models.PortfolioInvitation, models.Portfolio, "portfolio_id")):
        for invitation, target_name, invited_by in db.execute(rows_for(model, target, fk)).all():
            effective = "EXPIRED" if invitation.status == models.InvitationStatus.PENDING and invitation.expires_at < now else invitation.status.value
            merged.append(
                {
                    "kind": kind, "id": invitation.id, "email": invitation.email, "role": invitation.role.value, "status": effective, "target_name": target_name,
                    "invited_by_email": invited_by, "created_at": _iso(invitation.created_at), "expires_at": _iso(invitation.expires_at), "_sort": invitation.created_at,
                }
            )
    merged.sort(key=lambda row: row["_sort"], reverse=True)
    for row in merged:
        del row["_sort"]
    start = (page - 1) * page_size
    return _page(len(merged), merged[start : start + page_size], page, page_size)


# ---- audit log --------------------------------------------------------------------------------------------


def _audit_query(action: str | None, user: str | None, workspace_id: str | None, since: dt.datetime | None, until: dt.datetime | None):  # noqa: ANN202
    stmt = select(models.AuditLog, models.User.email).outerjoin(models.User, models.User.id == models.AuditLog.user_id)
    if action:
        stmt = stmt.where(models.AuditLog.action == action)
    if user and user.strip():
        stmt = stmt.where(or_(models.User.email.ilike(_like(user.strip()), escape="\\"), models.AuditLog.user_id == user.strip(), models.AuditLog.target_user_id == user.strip()))
    if workspace_id:
        stmt = stmt.where(models.AuditLog.workspace_id == workspace_id)
    if since:
        stmt = stmt.where(models.AuditLog.created_at >= since)
    if until:
        stmt = stmt.where(models.AuditLog.created_at < until)
    return stmt


def _audit_row(entry: models.AuditLog, actor_email: str | None) -> dict[str, Any]:
    return {
        "id": entry.id, "created_at": _iso(entry.created_at), "action": entry.action, "actor_user_id": entry.user_id, "actor_email": actor_email,
        "target_user_id": entry.target_user_id, "workspace_id": entry.workspace_id, "trading_account_id": entry.trading_account_id,
        "ip_address": entry.ip_address, "metadata": _parse_metadata(entry.metadata_json),
    }


@router.get("/audit/actions")
def audit_actions(db: DBSession = Depends(get_db)) -> dict[str, list[str]]:
    return {"actions": sorted(a for a in db.scalars(select(func.distinct(models.AuditLog.action))).all())}


@router.get("/audit")
def list_audit(
    db: DBSession = Depends(get_db),
    action: str | None = Query(default=None, max_length=60),
    user: str | None = Query(default=None, max_length=255),
    workspace_id: str | None = Query(default=None, max_length=36),
    since: dt.datetime | None = None,
    until: dt.datetime | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    base = _audit_query(action, user, workspace_id, since, until)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.execute(base.order_by(models.AuditLog.created_at.desc(), models.AuditLog.id).offset((page - 1) * page_size).limit(page_size)).all()
    return _page(total, [_audit_row(entry, email) for entry, email in rows], page, page_size)


def _csv_cell(value: Any) -> str:
    text = "" if value is None else (json.dumps(value) if isinstance(value, (dict, list)) else str(value))
    # Spreadsheet formula injection: a cell starting with = + - @ would run as a formula when opened in Excel.
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


@router.get("/audit/export")
def export_audit(
    request: Request,
    db: DBSession = Depends(get_db),
    staff: models.User = Depends(require_platform_role(PlatformRole.ADMIN)),
    action: str | None = Query(default=None, max_length=60),
    user: str | None = Query(default=None, max_length=255),
    workspace_id: str | None = Query(default=None, max_length=36),
    since: dt.datetime | None = None,
    until: dt.datetime | None = None,
) -> Response:
    rows = db.execute(_audit_query(action, user, workspace_id, since, until).order_by(models.AuditLog.created_at.desc(), models.AuditLog.id).limit(_MAX_EXPORT_ROWS)).all()
    columns = ["created_at", "action", "actor_email", "actor_user_id", "target_user_id", "workspace_id", "trading_account_id", "ip_address", "metadata"]
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)
    for entry, email in rows:
        row = _audit_row(entry, email)
        writer.writerow([_csv_cell(row[c]) for c in columns])

    log_event(db, action=AuditAction.ADMIN_AUDIT_EXPORTED, user_id=staff.id, request=request, metadata={"rows": len(rows), "action_filter": action, "truncated": len(rows) >= _MAX_EXPORT_ROWS})
    db.commit()
    stamp = dt.datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return Response(content=buffer.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="audit-{stamp}.csv"'})
