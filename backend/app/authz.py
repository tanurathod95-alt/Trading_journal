from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from . import models
from .observability import tracked

_ACCOUNT_ROLE_RANK: dict[models.AccountRole, int] = {
    models.AccountRole.VIEWER: 1,
    models.AccountRole.ADMIN: 2,
    models.AccountRole.OWNER: 3,
}

_WORKSPACE_ROLE_RANK: dict[models.WorkspaceRole, int] = {
    models.WorkspaceRole.ADMIN: 1,
    models.WorkspaceRole.OWNER: 2,
}


@tracked("authz.require_workspace_member")
def require_workspace_member(
    db: DBSession, workspace_id: str, user: models.User, min_role: models.WorkspaceRole = models.WorkspaceRole.ADMIN
) -> models.WorkspaceMember:
    """Used only where a workspace-level action is being taken (e.g. creating a new trading account inside it) — never for reading/writing an account's own data, which is gated by account membership instead."""
    membership = db.scalar(
        select(models.WorkspaceMember).where(
            models.WorkspaceMember.workspace_id == workspace_id,
            models.WorkspaceMember.user_id == user.id,
        )
    )
    if membership is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if _WORKSPACE_ROLE_RANK[membership.role] < _WORKSPACE_ROLE_RANK[min_role]:
        raise HTTPException(status_code=403, detail="You do not have permission to do this in this workspace")
    return membership


@tracked("authz.require_portfolio_member")
def require_portfolio_member(
    db: DBSession, portfolio_id: str, user: models.User, min_role: models.AccountRole = models.AccountRole.VIEWER
) -> models.PortfolioMember:
    """Identical shape to require_account_member, one level up — the single authorization gate for every portfolio-scoped operation."""
    membership = db.scalar(
        select(models.PortfolioMember).where(
            models.PortfolioMember.portfolio_id == portfolio_id,
            models.PortfolioMember.user_id == user.id,
        )
    )
    if membership is None:
        raise HTTPException(status_code=404, detail="Portfolio not found")
    if _ACCOUNT_ROLE_RANK[membership.role] < _ACCOUNT_ROLE_RANK[min_role]:
        raise HTTPException(status_code=403, detail="You do not have permission to do this on this portfolio")
    return membership


@tracked("authz.require_account_member")
def require_account_member(
    db: DBSession, trading_account_id: str, user: models.User, min_role: models.AccountRole = models.AccountRole.VIEWER
) -> models.AccountMember:
    """
    The single authorization gate for every trading-account-scoped
    operation — reused as-is by Phase 3's dashboard, Phase 4's trade/journal
    endpoints, etc., rather than re-implemented per route. Never trust a
    trading_account_id from the request alone: this always re-derives
    access from the authenticated user's own AccountMember row.

    404 (not 403) when there's no membership at all, so a non-member can't
    even confirm the account exists. Once membership is confirmed, an
    insufficient role (e.g. a Viewer hitting an edit endpoint) is a 403.

    Phase 10.2 fallback: if there's no direct AccountMember row but the
    account belongs to a Portfolio the user is a PortfolioMember of, access
    is granted as an always-VIEWER-equivalent role (a Client is never
    Admin/Owner on the accounts under their portfolio) — this is the ONE
    place portfolio-based access is resolved, so every existing
    account-scoped endpoint (trades, broker-status, etc.) picks it up for
    free without being touched.
    """
    membership = db.scalar(
        select(models.AccountMember).where(
            models.AccountMember.trading_account_id == trading_account_id,
            models.AccountMember.user_id == user.id,
        )
    )
    if membership is not None:
        if _ACCOUNT_ROLE_RANK[membership.role] < _ACCOUNT_ROLE_RANK[min_role]:
            raise HTTPException(status_code=403, detail="You do not have permission to do this on this account")
        return membership

    account = db.get(models.TradingAccount, trading_account_id)
    if account is not None and account.portfolio_id is not None:
        portfolio_membership = db.scalar(
            select(models.PortfolioMember).where(
                models.PortfolioMember.portfolio_id == account.portfolio_id,
                models.PortfolioMember.user_id == user.id,
            )
        )
        if portfolio_membership is not None:
            if _ACCOUNT_ROLE_RANK[models.AccountRole.VIEWER] < _ACCOUNT_ROLE_RANK[min_role]:
                raise HTTPException(status_code=403, detail="You do not have permission to do this on this account")
            synthetic = models.AccountMember(
                trading_account_id=account.id, user_id=user.id, role=models.AccountRole.VIEWER
            )
            synthetic.account = account
            return synthetic

    raise HTTPException(status_code=404, detail="Trading account not found")
