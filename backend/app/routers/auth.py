from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .. import models, schemas, security
from ..audit import AuditAction, log_event
from ..config import settings
from ..deps import get_current_user, get_db

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        httponly=True,
        secure=settings.cookie_secure,
        # "lax" works for local dev (frontend/backend share the "localhost"
        # site across ports). In production the frontend and backend are
        # deployed on different hostnames/subdomains — e.g. two separate
        # onrender.com services, which browsers treat as different sites —
        # so the cookie must be "none" (requires Secure, which cookie_secure
        # already guarantees here) or it's silently dropped on every
        # cross-origin fetch after login.
        samesite="none" if settings.cookie_secure else "lax",
        max_age=settings.session_ttl_hours * 3600,
        path="/",
    )


def _create_session(db: DBSession, user: models.User) -> str:
    token = security.generate_session_token()
    db.add(
        models.Session(
            token=token,
            user_id=user.id,
            expires_at=dt.datetime.utcnow() + dt.timedelta(hours=settings.session_ttl_hours),
        )
    )
    db.commit()
    return token


def _me_payload(db: DBSession, user: models.User) -> schemas.MeOut:
    memberships = db.scalars(select(models.WorkspaceMember).where(models.WorkspaceMember.user_id == user.id)).all()
    workspaces = [
        schemas.WorkspaceOut(
            id=m.workspace.id,
            name=m.workspace.name,
            plan=m.workspace.plan,
            role=m.role.value,
            created_at=m.workspace.created_at,
        )
        for m in memberships
    ]
    return schemas.MeOut(user=schemas.UserOut.model_validate(user), workspaces=workspaces)


@router.post("/signup", response_model=schemas.MeOut, status_code=201)
def signup(
    payload: schemas.SignupRequest, request: Request, response: Response, db: DBSession = Depends(get_db)
) -> schemas.MeOut:
    email = payload.email.lower()
    if db.scalar(select(models.User).where(models.User.email == email)) is not None:
        raise HTTPException(status_code=409, detail="An account with this email already exists")

    user = models.User(email=email, password_hash=security.hash_password(payload.password), display_name=payload.display_name)
    db.add(user)
    db.flush()  # assigns user.id before the workspace/membership rows reference it

    workspace = models.Workspace(name=f"{payload.display_name}'s Workspace", owner_user_id=user.id)
    db.add(workspace)
    db.flush()

    db.add(models.WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=models.WorkspaceRole.OWNER))
    log_event(db, action=AuditAction.SIGNUP, user_id=user.id, workspace_id=workspace.id, request=request)
    db.commit()
    db.refresh(user)

    token = _create_session(db, user)
    _set_session_cookie(response, token)
    return _me_payload(db, user)


@router.post("/login", response_model=schemas.MeOut)
def login(payload: schemas.LoginRequest, request: Request, response: Response, db: DBSession = Depends(get_db)) -> schemas.MeOut:
    user = db.scalar(select(models.User).where(models.User.email == payload.email.lower()))
    if user is None or not security.verify_password(payload.password, user.password_hash):
        # Same message for "no such user" and "wrong password" — never reveal which one it was.
        # The failed attempt is still logged (user_id is None when the email itself didn't match
        # any account, so a failed-login row never confirms an email's existence to a reader either).
        log_event(
            db,
            action=AuditAction.LOGIN_FAILED,
            user_id=user.id if user else None,
            request=request,
            metadata={"email": payload.email.lower()},
        )
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not user.is_active:
        # Only reached with the correct password, so this never reveals that an email is registered.
        log_event(
            db,
            action=AuditAction.LOGIN_FAILED,
            user_id=user.id,
            request=request,
            metadata={"email": user.email, "reason": "account_disabled"},
        )
        db.commit()
        raise HTTPException(status_code=403, detail="This account has been disabled. Please contact support.")

    token = _create_session(db, user)
    log_event(db, action=AuditAction.LOGIN_SUCCESS, user_id=user.id, request=request)
    db.commit()
    _set_session_cookie(response, token)
    return _me_payload(db, user)


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, db: DBSession = Depends(get_db)) -> None:
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        session = db.get(models.Session, token)
        if session is not None:
            log_event(db, action=AuditAction.LOGOUT, user_id=session.user_id, request=request)
            db.delete(session)
            db.commit()
    response.delete_cookie(settings.session_cookie_name, path="/")


@router.get("/me", response_model=schemas.MeOut)
def me(db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)) -> schemas.MeOut:
    return _me_payload(db, user)


@router.get("/support-access")
def support_access(db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)) -> dict:
    """
    Every time platform staff opened a read-only "view as" on this account — shown to the customer in their profile so
    support never looks at their data in secret. Deliberately says only "Platform support", not which person or why.
    """
    rows = db.scalars(
        select(models.ViewAsSession).where(models.ViewAsSession.user_id == user.id).order_by(models.ViewAsSession.started_at.desc()).limit(20)
    ).all()

    def iso(value: dt.datetime | None) -> str | None:
        return value.replace(tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z") if value else None

    return {"sessions": [{"started_at": iso(r.started_at), "ended_at": iso(r.ended_at), "by": "Platform support"} for r in rows]}


@router.post("/forgot-password", response_model=schemas.ForgotPasswordOut)
def forgot_password(
    payload: schemas.ForgotPasswordRequest, request: Request, db: DBSession = Depends(get_db)
) -> schemas.ForgotPasswordOut:
    """
    Always returns the same message whether or not the email has an account —
    this endpoint must never be usable to discover which addresses are
    registered. Any previously-issued unused tokens for the user are
    invalidated so only the newest reset link works.
    """
    generic_message = "If an account exists for that email, a password reset link has been sent."
    user = db.scalar(select(models.User).where(models.User.email == payload.email.lower()))

    if user is None:
        log_event(db, action=AuditAction.PASSWORD_RESET_REQUESTED, request=request, metadata={"found": False})
        db.commit()
        return schemas.ForgotPasswordOut(message=generic_message)

    previous = db.scalars(
        select(models.PasswordResetToken).where(
            models.PasswordResetToken.user_id == user.id, models.PasswordResetToken.used_at.is_(None)
        )
    ).all()
    for row in previous:
        row.used_at = dt.datetime.utcnow()
        db.add(row)

    token = security.generate_reset_token()
    db.add(
        models.PasswordResetToken(
            user_id=user.id,
            token_hash=security.hash_reset_token(token),
            expires_at=dt.datetime.utcnow() + dt.timedelta(minutes=settings.password_reset_ttl_minutes),
        )
    )
    log_event(
        db, action=AuditAction.PASSWORD_RESET_REQUESTED, user_id=user.id, request=request, metadata={"found": True}
    )
    db.commit()

    return schemas.ForgotPasswordOut(
        message=generic_message,
        dev_reset_token=token if settings.expose_reset_token_in_response else None,
    )


@router.post("/reset-password", status_code=204)
def reset_password(payload: schemas.ResetPasswordRequest, request: Request, db: DBSession = Depends(get_db)) -> None:
    """
    Consumes the token, sets the new password, and deletes every existing
    session for that user — a password reset must log out anyone already
    holding a session, which is the whole point of resetting it.
    """
    row = db.scalar(
        select(models.PasswordResetToken).where(
            models.PasswordResetToken.token_hash == security.hash_reset_token(payload.token)
        )
    )
    if row is None or row.used_at is not None or row.expires_at < dt.datetime.utcnow():
        raise HTTPException(status_code=400, detail="This reset link is invalid or has expired")

    user = db.get(models.User, row.user_id)
    if user is None:
        raise HTTPException(status_code=400, detail="This reset link is invalid or has expired")

    user.password_hash = security.hash_password(payload.new_password)
    row.used_at = dt.datetime.utcnow()
    db.add(user)
    db.add(row)

    for session in db.scalars(select(models.Session).where(models.Session.user_id == user.id)).all():
        db.delete(session)

    log_event(db, action=AuditAction.PASSWORD_RESET_COMPLETED, user_id=user.id, request=request)
    db.commit()


@router.post("/change-password", status_code=204)
def change_password(
    payload: schemas.ChangePasswordRequest,
    request: Request,
    response: Response,
    db: DBSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
) -> None:
    """Requires the current password — a hijacked session alone must not be enough to lock the real owner out."""
    if not security.verify_password(payload.current_password, user.password_hash):
        log_event(db, action=AuditAction.PASSWORD_CHANGE_FAILED, user_id=user.id, request=request)
        db.commit()
        raise HTTPException(status_code=400, detail="Your current password is incorrect")

    user.password_hash = security.hash_password(payload.new_password)
    db.add(user)

    # Every other session is revoked; the one making this change stays valid
    # so the user isn't bounced out of the app they're actively using.
    current_token = request.cookies.get(settings.session_cookie_name)
    for session in db.scalars(select(models.Session).where(models.Session.user_id == user.id)).all():
        if session.token != current_token:
            db.delete(session)

    log_event(db, action=AuditAction.PASSWORD_CHANGED, user_id=user.id, request=request)
    db.commit()


@router.patch("/profile", response_model=schemas.MeOut)
def update_profile(
    payload: schemas.UpdateProfileRequest,
    request: Request,
    db: DBSession = Depends(get_db),
    user: models.User = Depends(get_current_user),
) -> schemas.MeOut:
    user.display_name = payload.display_name
    db.add(user)
    log_event(db, action=AuditAction.PROFILE_UPDATED, user_id=user.id, request=request)
    db.commit()
    db.refresh(user)
    return _me_payload(db, user)
