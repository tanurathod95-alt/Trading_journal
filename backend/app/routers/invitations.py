from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .. import models, schemas
from ..audit import AuditAction, log_event
from ..deps import get_current_user, get_db

router = APIRouter(prefix="/api/invitations", tags=["invitations"])


def _pending_for_email(db: DBSession, email: str) -> list[models.Invitation]:
    return list(
        db.scalars(
            select(models.Invitation).where(
                models.Invitation.email == email.lower(),
                models.Invitation.status == models.InvitationStatus.PENDING,
                models.Invitation.expires_at >= dt.datetime.utcnow(),
            )
        ).all()
    )


@router.get("/me", response_model=list[schemas.MyInvitationOut])
def my_invitations(db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)) -> list[schemas.MyInvitationOut]:
    """
    Invitations pending for the CURRENT user's email — matched purely by
    email, which is exactly how a not-yet-registered invitee later becomes
    able to see it: they sign up with that email, log in, and this query
    finds the row waiting for them. Never a user_id match, since the
    invitation may predate the account.
    """
    invitations = _pending_for_email(db, user.email)
    return [
        schemas.MyInvitationOut(
            id=i.id,
            account_id=i.trading_account_id,
            account_name=i.account.name,
            broker_name=i.account.broker_name,
            role=i.role.value,
            invited_by_email=i.invited_by.email,
            created_at=i.created_at,
            expires_at=i.expires_at,
        )
        for i in invitations
    ]


def _get_pending_invitation_for_user(db: DBSession, invitation_id: str, user: models.User) -> models.Invitation:
    invitation = db.get(models.Invitation, invitation_id)
    if invitation is None or invitation.email != user.email.lower():
        # 404 either way — a stranger probing invitation IDs learns nothing,
        # same "don't confirm existence" posture as account/workspace 404s.
        raise HTTPException(status_code=404, detail="Invitation not found")
    if invitation.status != models.InvitationStatus.PENDING:
        raise HTTPException(status_code=410, detail="This invitation is no longer pending")
    if invitation.expires_at < dt.datetime.utcnow():
        raise HTTPException(status_code=410, detail="This invitation has expired")
    return invitation


@router.post("/{invitation_id}/accept", response_model=schemas.TradingAccountOut)
def accept_invitation(
    invitation_id: str, request: Request, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> schemas.TradingAccountOut:
    invitation = _get_pending_invitation_for_user(db, invitation_id, user)

    existing = db.scalar(
        select(models.AccountMember).where(
            models.AccountMember.trading_account_id == invitation.trading_account_id,
            models.AccountMember.user_id == user.id,
        )
    )
    if existing is None:
        db.add(
            models.AccountMember(
                trading_account_id=invitation.trading_account_id,
                user_id=user.id,
                role=invitation.role,
                granted_by_user_id=invitation.invited_by_user_id,
            )
        )

    invitation.status = models.InvitationStatus.ACCEPTED
    db.add(invitation)
    log_event(
        db,
        action=AuditAction.INVITATION_ACCEPTED,
        user_id=user.id,
        trading_account_id=invitation.trading_account_id,
        request=request,
        metadata={"role": invitation.role.value},
    )
    db.commit()

    account = db.get(models.TradingAccount, invitation.trading_account_id)
    assert account is not None
    return schemas.TradingAccountOut(
        id=account.id,
        workspace_id=account.workspace_id,
        portfolio_id=account.portfolio_id,
        name=account.name,
        broker_name=account.broker_name,
        account_type=account.account_type,
        contact_number=account.contact_number,
        is_archived=account.is_archived,
        role=invitation.role.value,
        created_at=account.created_at,
        updated_at=account.updated_at,
    )


@router.post("/{invitation_id}/decline", status_code=204)
def decline_invitation(
    invitation_id: str, request: Request, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> None:
    invitation = _get_pending_invitation_for_user(db, invitation_id, user)
    invitation.status = models.InvitationStatus.DECLINED
    db.add(invitation)
    log_event(
        db,
        action=AuditAction.INVITATION_DECLINED,
        user_id=user.id,
        trading_account_id=invitation.trading_account_id,
        request=request,
    )
    db.commit()
