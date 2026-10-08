from __future__ import annotations

import datetime as dt
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .. import models, schemas
from ..audit import AuditAction, log_event
from ..authz import require_account_member, require_workspace_member
from ..config import settings
from ..deps import get_current_user, get_db
from ..plans import enforce_account_seat_limit, enforce_trading_account_limit

router = APIRouter(prefix="/api/accounts", tags=["trading-accounts"])


def _out(account: models.TradingAccount, role: models.AccountRole) -> schemas.TradingAccountOut:
    return schemas.TradingAccountOut(
        id=account.id,
        workspace_id=account.workspace_id,
        portfolio_id=account.portfolio_id,
        name=account.name,
        broker_name=account.broker_name,
        account_type=account.account_type,
        contact_number=account.contact_number,
        is_archived=account.is_archived,
        role=role.value,
        created_at=account.created_at,
        updated_at=account.updated_at,
    )


@router.post("", response_model=schemas.TradingAccountOut, status_code=201)
def create_account(
    payload: schemas.TradingAccountCreate,
    request: Request,
    db: DBSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
) -> schemas.TradingAccountOut:
    # Adding a new account to a workspace is a workspace-level action —
    # requires ADMIN+ membership in that workspace (not account membership,
    # since the account doesn't exist yet).
    membership = require_workspace_member(db, payload.workspace_id, user, min_role=models.WorkspaceRole.ADMIN)
    enforce_trading_account_limit(db, membership.workspace)

    account = models.TradingAccount(
        workspace_id=payload.workspace_id,
        owner_user_id=user.id,
        name=payload.name,
        broker_name=payload.broker_name,
        account_type=payload.account_type,
        contact_number=payload.contact_number,
    )
    db.add(account)
    db.flush()

    db.add(models.AccountMember(trading_account_id=account.id, user_id=user.id, role=models.AccountRole.OWNER))
    log_event(
        db,
        action=AuditAction.ACCOUNT_CREATED,
        user_id=user.id,
        workspace_id=account.workspace_id,
        trading_account_id=account.id,
        request=request,
        metadata={"name": account.name},
    )
    db.commit()
    db.refresh(account)
    return _out(account, models.AccountRole.OWNER)


@router.get("", response_model=list[schemas.TradingAccountOut])
def list_my_accounts(
    workspace_id: str | None = None, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> list[schemas.TradingAccountOut]:
    """
    Lists accounts the authenticated user can reach either directly (an
    AccountMember row — "My Accounts" / directly-shared "Shared With Me")
    or via a Portfolio they're a PortfolioMember of (Phase 10.2 — a Client
    sees every account under their shared portfolio without a per-account
    invite). Never "every account in the workspace."
    """
    direct_memberships = db.scalars(select(models.AccountMember).where(models.AccountMember.user_id == user.id)).all()
    results = {
        m.trading_account_id: _out(m.account, m.role)
        for m in direct_memberships
        if workspace_id is None or m.account.workspace_id == workspace_id
    }

    portfolio_ids = db.scalars(
        select(models.PortfolioMember.portfolio_id).where(models.PortfolioMember.user_id == user.id)
    ).all()
    if portfolio_ids:
        portfolio_accounts = db.scalars(
            select(models.TradingAccount).where(models.TradingAccount.portfolio_id.in_(portfolio_ids))
        ).all()
        for account in portfolio_accounts:
            if account.id in results:
                continue  # a direct AccountMember row (if any) always wins over the portfolio-derived view
            if workspace_id is not None and account.workspace_id != workspace_id:
                continue
            results[account.id] = _out(account, models.AccountRole.VIEWER)

    return list(results.values())


@router.get("/{trading_account_id}", response_model=schemas.TradingAccountOut)
def get_account(
    trading_account_id: str, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> schemas.TradingAccountOut:
    membership = require_account_member(db, trading_account_id, user, min_role=models.AccountRole.VIEWER)
    return _out(membership.account, membership.role)


@router.patch("/{trading_account_id}", response_model=schemas.TradingAccountOut)
def update_account(
    trading_account_id: str,
    payload: schemas.TradingAccountUpdate,
    request: Request,
    db: DBSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
) -> schemas.TradingAccountOut:
    membership = require_account_member(db, trading_account_id, user, min_role=models.AccountRole.ADMIN)
    account = membership.account

    if payload.name is not None:
        account.name = payload.name
    if payload.broker_name is not None:
        account.broker_name = payload.broker_name
    if payload.account_type is not None:
        account.account_type = payload.account_type
    if payload.contact_number is not None:
        account.contact_number = payload.contact_number
    if payload.is_archived is not None:
        account.is_archived = payload.is_archived
    if "portfolio_id" in payload.model_fields_set:
        if payload.portfolio_id is None:
            account.portfolio_id = None
        else:
            portfolio = db.get(models.Portfolio, payload.portfolio_id)
            if portfolio is None or portfolio.workspace_id != account.workspace_id:
                raise HTTPException(status_code=404, detail="Portfolio not found")
            account.portfolio_id = portfolio.id

    db.add(account)
    log_event(
        db,
        action=AuditAction.ACCOUNT_UPDATED,
        user_id=user.id,
        workspace_id=account.workspace_id,
        trading_account_id=account.id,
        request=request,
        metadata={k: v for k, v in payload.model_dump(exclude_unset=True).items()},
    )
    db.commit()
    db.refresh(account)
    return _out(account, membership.role)


@router.delete("/{trading_account_id}", status_code=204)
def delete_account(
    trading_account_id: str, request: Request, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> None:
    # OWNER only — an ADMIN can rename/archive but not permanently delete.
    membership = require_account_member(db, trading_account_id, user, min_role=models.AccountRole.OWNER)
    account = membership.account
    log_event(
        db,
        action=AuditAction.ACCOUNT_DELETED,
        user_id=user.id,
        workspace_id=account.workspace_id,
        trading_account_id=account.id,
        request=request,
        metadata={"name": account.name, "trading_account_id": account.id},
    )
    db.delete(account)
    db.commit()


def _member_out(member: models.AccountMember) -> schemas.AccountMemberOut:
    return schemas.AccountMemberOut(
        id=member.id,
        user_id=member.user_id,
        email=member.user.email,
        display_name=member.user.display_name,
        role=member.role.value,
        granted_at=member.granted_at,
    )


@router.get("/{trading_account_id}/members", response_model=list[schemas.AccountMemberOut])
def list_account_members(
    trading_account_id: str, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> list[schemas.AccountMemberOut]:
    # Who has access is management information — ADMIN+ only, not exposed
    # to a Viewer (matches "Viewer cannot ... change permissions", and
    # keeping the member list itself out of a Viewer's reach is the more
    # conservative reading of that).
    require_account_member(db, trading_account_id, user, min_role=models.AccountRole.ADMIN)
    members = db.scalars(
        select(models.AccountMember).where(models.AccountMember.trading_account_id == trading_account_id)
    ).all()
    return [_member_out(m) for m in members]


@router.post("/{trading_account_id}/members", response_model=schemas.AccountMemberOut, status_code=201)
def add_account_member(
    trading_account_id: str,
    payload: schemas.AddAccountMemberRequest,
    request: Request,
    db: DBSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
) -> schemas.AccountMemberOut:
    """
    OWNER only. This is deliberately NOT the full invitation system (Phase
    5): it only grants access to a person who has *already* signed up for
    the platform, immediately, with no pending/expiry state. Inviting
    someone by email who hasn't registered yet needs a real invitation
    record + accept flow, which is Phase 5's job. This exists now so
    Viewer/Admin role enforcement can be exercised for real through the API
    (and the UI) ahead of that.
    """
    membership = require_account_member(db, trading_account_id, user, min_role=models.AccountRole.OWNER)

    target_user = db.scalar(select(models.User).where(models.User.email == payload.email.lower()))
    if target_user is None:
        raise HTTPException(
            status_code=404,
            detail="No account found for that email. They need to sign up first — inviting someone who hasn't "
            "registered yet will be supported by the invitation system in a later phase.",
        )

    existing = db.scalar(
        select(models.AccountMember).where(
            models.AccountMember.trading_account_id == trading_account_id,
            models.AccountMember.user_id == target_user.id,
        )
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="That person already has access to this account")

    workspace = db.get(models.Workspace, membership.account.workspace_id)
    enforce_account_seat_limit(db, workspace, trading_account_id)

    member = models.AccountMember(
        trading_account_id=trading_account_id,
        user_id=target_user.id,
        role=models.AccountRole(payload.role),
        granted_by_user_id=user.id,
    )
    db.add(member)
    log_event(
        db,
        action=AuditAction.ACCOUNT_MEMBER_ADDED,
        user_id=user.id,
        trading_account_id=trading_account_id,
        target_user_id=target_user.id,
        request=request,
        metadata={"role": member.role.value},
    )
    db.commit()
    db.refresh(member)
    return _member_out(member)


@router.delete("/{trading_account_id}/members/{member_id}", status_code=204)
def remove_account_member(
    trading_account_id: str,
    member_id: str,
    request: Request,
    db: DBSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
) -> None:
    require_account_member(db, trading_account_id, user, min_role=models.AccountRole.OWNER)

    member = db.scalar(
        select(models.AccountMember).where(
            models.AccountMember.id == member_id, models.AccountMember.trading_account_id == trading_account_id
        )
    )
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")

    if member.role == models.AccountRole.OWNER:
        owners = db.scalars(
            select(models.AccountMember).where(
                models.AccountMember.trading_account_id == trading_account_id,
                models.AccountMember.role == models.AccountRole.OWNER,
            )
        ).all()
        if len(owners) <= 1:
            raise HTTPException(status_code=400, detail="Cannot remove the last owner of an account")

    log_event(
        db,
        action=AuditAction.ACCOUNT_MEMBER_REMOVED,
        user_id=user.id,
        trading_account_id=trading_account_id,
        target_user_id=member.user_id,
        request=request,
        metadata={"role": member.role.value},
    )
    db.delete(member)
    db.commit()


def _invitation_out(invitation: models.Invitation) -> schemas.InvitationOut:
    return schemas.InvitationOut(
        id=invitation.id,
        trading_account_id=invitation.trading_account_id,
        email=invitation.email,
        role=invitation.role.value,
        status=invitation.status.value,
        invited_by_email=invitation.invited_by.email,
        created_at=invitation.created_at,
        expires_at=invitation.expires_at,
        is_expired=invitation.status == models.InvitationStatus.PENDING and invitation.expires_at < dt.datetime.utcnow(),
    )


@router.get("/{trading_account_id}/invitations", response_model=list[schemas.InvitationOut])
def list_account_invitations(
    trading_account_id: str, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> list[schemas.InvitationOut]:
    require_account_member(db, trading_account_id, user, min_role=models.AccountRole.ADMIN)
    invitations = db.scalars(
        select(models.Invitation).where(
            models.Invitation.trading_account_id == trading_account_id,
            models.Invitation.status == models.InvitationStatus.PENDING,
        )
    ).all()
    return [_invitation_out(i) for i in invitations]


@router.post("/{trading_account_id}/invitations", response_model=schemas.InvitationOut, status_code=201)
def create_invitation(
    trading_account_id: str,
    payload: schemas.InvitationCreate,
    request: Request,
    db: DBSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
) -> schemas.InvitationOut:
    """
    OWNER only. Unlike Phase 4's `POST .../members`, this works whether or
    not `payload.email` has an account yet — nothing is granted until the
    invitation is accepted (see routers/invitations.py), so there's no
    "user not found" failure mode here the way there is for the direct-add
    endpoint.
    """
    membership = require_account_member(db, trading_account_id, user, min_role=models.AccountRole.OWNER)
    email = payload.email.lower()

    existing_member = db.scalar(
        select(models.AccountMember)
        .join(models.User, models.AccountMember.user_id == models.User.id)
        .where(models.AccountMember.trading_account_id == trading_account_id, models.User.email == email)
    )
    if existing_member is not None:
        raise HTTPException(status_code=409, detail="That person already has access to this account")

    existing_invite = db.scalar(
        select(models.Invitation).where(
            models.Invitation.trading_account_id == trading_account_id,
            models.Invitation.email == email,
            models.Invitation.status == models.InvitationStatus.PENDING,
        )
    )
    if existing_invite is not None and existing_invite.expires_at >= dt.datetime.utcnow():
        raise HTTPException(status_code=409, detail="An invitation is already pending for that email")

    # Checked last, after every "this specific request doesn't even make
    # sense" case above — an over-the-cap owner should see the plan-limit
    # message only for a request that would otherwise have succeeded.
    workspace = db.get(models.Workspace, membership.account.workspace_id)
    enforce_account_seat_limit(db, workspace, trading_account_id)

    invitation = models.Invitation(
        trading_account_id=trading_account_id,
        email=email,
        role=models.AccountRole(payload.role),
        invited_by_user_id=user.id,
        expires_at=dt.datetime.utcnow() + dt.timedelta(days=settings.invitation_ttl_days),
    )
    db.add(invitation)
    log_event(
        db,
        action=AuditAction.INVITATION_CREATED,
        user_id=user.id,
        trading_account_id=trading_account_id,
        request=request,
        metadata={"email": email, "role": invitation.role.value},
    )
    db.commit()
    db.refresh(invitation)
    return _invitation_out(invitation)


@router.delete("/{trading_account_id}/invitations/{invitation_id}", status_code=204)
def revoke_invitation(
    trading_account_id: str,
    invitation_id: str,
    request: Request,
    db: DBSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
) -> None:
    require_account_member(db, trading_account_id, user, min_role=models.AccountRole.OWNER)
    invitation = db.scalar(
        select(models.Invitation).where(
            models.Invitation.id == invitation_id, models.Invitation.trading_account_id == trading_account_id
        )
    )
    if invitation is None:
        raise HTTPException(status_code=404, detail="Invitation not found")
    invitation.status = models.InvitationStatus.REVOKED
    db.add(invitation)
    log_event(
        db,
        action=AuditAction.INVITATION_REVOKED,
        user_id=user.id,
        trading_account_id=trading_account_id,
        request=request,
        metadata={"email": invitation.email},
    )
    db.commit()


@router.get("/{trading_account_id}/audit-log", response_model=list[schemas.AuditLogOut])
def list_account_audit_log(
    trading_account_id: str, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> list[schemas.AuditLogOut]:
    """
    OWNER only — the audit trail itself is management/security information,
    same posture as the members list: never exposed to a Viewer or an
    ADMIN, only the account's OWNER(s).
    """
    require_account_member(db, trading_account_id, user, min_role=models.AccountRole.OWNER)
    rows = db.scalars(
        select(models.AuditLog)
        .where(models.AuditLog.trading_account_id == trading_account_id)
        .order_by(models.AuditLog.created_at.desc())
        .limit(200)
    ).all()

    user_ids = {r.user_id for r in rows if r.user_id} | {r.target_user_id for r in rows if r.target_user_id}
    users_by_id = {
        u.id: u for u in db.scalars(select(models.User).where(models.User.id.in_(user_ids))).all()
    } if user_ids else {}

    return [
        schemas.AuditLogOut(
            id=r.id,
            action=r.action,
            user_email=users_by_id[r.user_id].email if r.user_id in users_by_id else None,
            target_user_email=users_by_id[r.target_user_id].email if r.target_user_id in users_by_id else None,
            trading_account_id=r.trading_account_id,
            metadata=json.loads(r.metadata_json) if r.metadata_json else None,
            ip_address=r.ip_address,
            created_at=r.created_at,
        )
        for r in rows
    ]
