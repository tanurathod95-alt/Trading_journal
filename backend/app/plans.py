from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DBSession

from . import models
from .observability import tracked


class PlanTier:
    """
    The four tiers from the spec. Stored as a plain string on `Workspace.plan`
    (not a DB enum) so adding a fifth tier later is a one-line change here,
    not a migration. `ALL` is the source of truth for validating a PATCH.
    """

    FREE = "FREE"
    PRO = "PRO"
    PREMIUM = "PREMIUM"
    BUSINESS = "BUSINESS"

    ALL = [FREE, PRO, PREMIUM, BUSINESS]


@dataclass(frozen=True)
class PlanLimits:
    max_trading_accounts: int | None  # None = unlimited
    max_members_per_account: int | None  # applies per trading account, counts AccountMember rows + pending Invitations


PLAN_LIMITS: dict[str, PlanLimits] = {
    PlanTier.FREE: PlanLimits(max_trading_accounts=3, max_members_per_account=2),
    PlanTier.PRO: PlanLimits(max_trading_accounts=15, max_members_per_account=10),
    PlanTier.PREMIUM: PlanLimits(max_trading_accounts=50, max_members_per_account=25),
    PlanTier.BUSINESS: PlanLimits(max_trading_accounts=None, max_members_per_account=None),
}


@tracked("plans.limits_for")
def limits_for(plan: str) -> PlanLimits:
    return PLAN_LIMITS.get(plan, PLAN_LIMITS[PlanTier.FREE])


def count_trading_accounts(db: DBSession, workspace_id: str) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(models.TradingAccount)
            .where(models.TradingAccount.workspace_id == workspace_id, models.TradingAccount.is_archived.is_(False))
        )
        or 0
    )


def count_account_seats(db: DBSession, trading_account_id: str) -> int:
    """
    "Seats" = active members + still-pending, non-expired invitations —
    an OWNER shouldn't be able to dodge the plan cap by sending ten
    invitations at once and having them all land after the count was last
    checked.
    """
    members = (
        db.scalar(
            select(func.count())
            .select_from(models.AccountMember)
            .where(models.AccountMember.trading_account_id == trading_account_id)
        )
        or 0
    )
    pending_invites = (
        db.scalar(
            select(func.count())
            .select_from(models.Invitation)
            .where(
                models.Invitation.trading_account_id == trading_account_id,
                models.Invitation.status == models.InvitationStatus.PENDING,
                models.Invitation.expires_at >= dt.datetime.utcnow(),
            )
        )
        or 0
    )
    return members + pending_invites


@tracked("plans.enforce_trading_account_limit")
def enforce_trading_account_limit(db: DBSession, workspace: models.Workspace) -> None:
    limits = limits_for(workspace.plan)
    if limits.max_trading_accounts is None:
        return
    if count_trading_accounts(db, workspace.id) >= limits.max_trading_accounts:
        raise HTTPException(
            status_code=402,
            detail=(
                f"The {workspace.plan} plan allows up to {limits.max_trading_accounts} trading accounts. "
                "Upgrade your workspace plan to add more."
            ),
        )


@tracked("plans.enforce_account_seat_limit")
def enforce_account_seat_limit(db: DBSession, workspace: models.Workspace, trading_account_id: str) -> None:
    limits = limits_for(workspace.plan)
    if limits.max_members_per_account is None:
        return
    if count_account_seats(db, trading_account_id) >= limits.max_members_per_account:
        raise HTTPException(
            status_code=402,
            detail=(
                f"The {workspace.plan} plan allows up to {limits.max_members_per_account} people per trading "
                "account (including pending invitations). Upgrade your workspace plan to add more."
            ),
        )
