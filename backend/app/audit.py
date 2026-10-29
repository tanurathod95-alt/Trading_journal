from __future__ import annotations

import json
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session as DBSession

from . import models


class AuditAction:
    """String constants so callers/tests never hand-type action names."""

    SIGNUP = "SIGNUP"
    LOGIN_SUCCESS = "LOGIN_SUCCESS"
    LOGIN_FAILED = "LOGIN_FAILED"
    LOGOUT = "LOGOUT"

    ACCOUNT_CREATED = "ACCOUNT_CREATED"
    ACCOUNT_UPDATED = "ACCOUNT_UPDATED"
    ACCOUNT_DELETED = "ACCOUNT_DELETED"

    ACCOUNT_MEMBER_ADDED = "ACCOUNT_MEMBER_ADDED"
    ACCOUNT_MEMBER_REMOVED = "ACCOUNT_MEMBER_REMOVED"

    INVITATION_CREATED = "INVITATION_CREATED"
    INVITATION_REVOKED = "INVITATION_REVOKED"
    INVITATION_ACCEPTED = "INVITATION_ACCEPTED"
    INVITATION_DECLINED = "INVITATION_DECLINED"

    BROKER_CREDENTIALS_SAVED = "BROKER_CREDENTIALS_SAVED"
    BROKER_CREDENTIALS_REVEALED = "BROKER_CREDENTIALS_REVEALED"
    BROKER_CREDENTIALS_DELETED = "BROKER_CREDENTIALS_DELETED"

    WORKSPACE_PLAN_CHANGED = "WORKSPACE_PLAN_CHANGED"

    TRADE_CREATED = "TRADE_CREATED"
    TRADE_UPDATED = "TRADE_UPDATED"
    TRADE_DELETED = "TRADE_DELETED"
    TRADE_BULK_IMPORTED = "TRADE_BULK_IMPORTED"

    PORTFOLIO_CREATED = "PORTFOLIO_CREATED"
    PORTFOLIO_UPDATED = "PORTFOLIO_UPDATED"
    PORTFOLIO_DELETED = "PORTFOLIO_DELETED"
    PORTFOLIO_MEMBER_ADDED = "PORTFOLIO_MEMBER_ADDED"
    PORTFOLIO_MEMBER_REMOVED = "PORTFOLIO_MEMBER_REMOVED"
    PORTFOLIO_INVITATION_CREATED = "PORTFOLIO_INVITATION_CREATED"
    PORTFOLIO_INVITATION_REVOKED = "PORTFOLIO_INVITATION_REVOKED"
    PORTFOLIO_INVITATION_ACCEPTED = "PORTFOLIO_INVITATION_ACCEPTED"
    PORTFOLIO_INVITATION_DECLINED = "PORTFOLIO_INVITATION_DECLINED"

    CHECKOUT_STARTED = "CHECKOUT_STARTED"
    PAYMENT_VERIFIED = "PAYMENT_VERIFIED"
    PAYMENT_VERIFICATION_FAILED = "PAYMENT_VERIFICATION_FAILED"
    SUBSCRIPTION_ACTIVATED = "SUBSCRIPTION_ACTIVATED"
    WEBHOOK_RECEIVED = "WEBHOOK_RECEIVED"

    PASSWORD_RESET_REQUESTED = "PASSWORD_RESET_REQUESTED"
    PASSWORD_RESET_COMPLETED = "PASSWORD_RESET_COMPLETED"
    PASSWORD_CHANGED = "PASSWORD_CHANGED"
    PASSWORD_CHANGE_FAILED = "PASSWORD_CHANGE_FAILED"
    PROFILE_UPDATED = "PROFILE_UPDATED"

    # Platform staff actions — recorded so customers' data access by staff is itself auditable.
    ADMIN_USER_VIEWED = "ADMIN_USER_VIEWED"
    ADMIN_AUDIT_EXPORTED = "ADMIN_AUDIT_EXPORTED"
    USER_DISABLED = "USER_DISABLED"
    USER_ENABLED = "USER_ENABLED"
    USER_FORCE_LOGOUT = "USER_FORCE_LOGOUT"
    PASSWORD_RESET_ISSUED_BY_STAFF = "PASSWORD_RESET_ISSUED_BY_STAFF"
    STEP_UP_FAILED = "STEP_UP_FAILED"
    PLAN_OVERRIDDEN = "PLAN_OVERRIDDEN"
    PAYMENT_RECONCILED_BY_STAFF = "PAYMENT_RECONCILED_BY_STAFF"
    ADMIN_VIEW_AS_STARTED = "ADMIN_VIEW_AS_STARTED"
    ADMIN_VIEW_AS_ENDED = "ADMIN_VIEW_AS_ENDED"


def _client_ip(request: Request | None) -> str | None:
    if request is None or request.client is None:
        return None
    return request.client.host


def log_event(
    db: DBSession,
    *,
    action: str,
    user_id: str | None = None,
    workspace_id: str | None = None,
    trading_account_id: str | None = None,
    target_user_id: str | None = None,
    request: Request | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """
    Adds (but does not commit) an AuditLog row. Callers add this to the
    same session as the action it describes and let the action's own
    `db.commit()` persist both together, so a log entry can never exist
    for an action that didn't actually happen.
    """
    db.add(
        models.AuditLog(
            user_id=user_id,
            workspace_id=workspace_id,
            trading_account_id=trading_account_id,
            target_user_id=target_user_id,
            action=action,
            metadata_json=json.dumps(metadata) if metadata else None,
            ip_address=_client_ip(request),
        )
    )
