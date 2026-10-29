from __future__ import annotations

import hashlib
import hmac
import threading
import time

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession

from . import models, security
from .audit import AuditAction, log_event
from .config import settings

"""
Extra protection that applies only to platform-staff *write* actions (disable a user, issue a reset link, start a
"view as"). A staff session can do far more than a customer's, so a stolen cookie or an unattended laptop must not be
enough on its own:

  1. CSRF token  — a value derived from the session, which a page on another site cannot read (CORS) and so cannot
                   put in the required header. Needed because production cookies are SameSite=None.
  2. Step-up     — the staff member types their own password again for every dangerous action.
  3. A reason    — free text, kept in the audit log next to the actor and the target.
"""

CSRF_HEADER = "X-CSRF-Token"
STEP_UP_MAX_FAILURES = 5
STEP_UP_WINDOW_SECONDS = 15 * 60

_failures: dict[str, list[float]] = {}  # staff user id -> times of recent wrong passwords (memory only: a restart clears it)
_failures_lock = threading.Lock()


def csrf_token_for(session_token: str) -> str:
    """HMAC of the session token under a server-only key, so it can't be guessed or computed from the cookie alone."""
    key = hashlib.sha256(b"journal-csrf-v1|" + security._resolve_broker_key()).digest()
    return hmac.new(key, session_token.encode("utf-8"), hashlib.sha256).hexdigest()


def require_csrf(request: Request) -> None:
    session_token = request.cookies.get(settings.session_cookie_name, "")
    supplied = request.headers.get(CSRF_HEADER, "")
    if not session_token or not supplied or not hmac.compare_digest(csrf_token_for(session_token), supplied):
        raise HTTPException(status_code=403, detail="Missing or invalid CSRF token — reload the page and try again.")


class StepUp(BaseModel):
    """Body of every staff write: why, and the staff member's own password."""

    reason: str = Field(min_length=5, max_length=500)
    password: str = Field(min_length=1, max_length=200)


def clear_step_up_failures() -> None:
    with _failures_lock:
        _failures.clear()


def verify_step_up(db: DBSession, staff: models.User, password: str, request: Request) -> None:
    now = time.time()
    with _failures_lock:
        recent = [t for t in _failures.get(staff.id, []) if now - t < STEP_UP_WINDOW_SECONDS]
        _failures[staff.id] = recent
        locked = len(recent) >= STEP_UP_MAX_FAILURES
    if locked:
        raise HTTPException(status_code=429, detail="Too many wrong passwords. Try again in 15 minutes.")

    if security.verify_password(password, staff.password_hash):
        with _failures_lock:
            _failures.pop(staff.id, None)
        return

    with _failures_lock:
        _failures.setdefault(staff.id, []).append(now)
    log_event(db, action=AuditAction.STEP_UP_FAILED, user_id=staff.id, request=request)
    db.commit()
    raise HTTPException(status_code=403, detail="Your password is incorrect.")

