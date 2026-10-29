from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import threading
import time
from typing import Callable

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from . import models, plans, security
from .authz import require_account_member
from .config import settings
from .database import Base
from .staff import PlatformRole

"""
Known-answer self-tests: pure logic run against fixed inputs with a fixed expected result, so a
regression in a security- or money-critical function is caught even when no real request has hit it
yet. Each test either returns a short detail string (pass) or raises AssertionError (fail — the
message is the diff). Nothing here touches the real database or any external service; the DB-backed
check uses its own throwaway in-memory SQLite.
"""

SelfTest = Callable[[], str]

_last_run: dict | None = None
_run_lock = threading.Lock()


def _password_hashing() -> str:
    hashed = security.hash_password("correct horse battery")
    assert security.verify_password("correct horse battery", hashed), "right password was rejected"
    assert not security.verify_password("wrong password", hashed), "wrong password was accepted"
    assert not security.verify_password("anything", "not-a-real-hash"), "malformed hash must verify False, not raise"
    return "hash/verify round trip, wrong password and malformed hash all behave"


def _razorpay_signature() -> str:
    order, payment = "order_QA1", "pay_QA1"
    good = hmac.new(settings.razorpay_key_secret.encode(), f"{order}|{payment}".encode(), hashlib.sha256).hexdigest()
    assert security.verify_razorpay_payment_signature(order, payment, good), "valid signature rejected"
    assert not security.verify_razorpay_payment_signature(order, payment, good[:-1] + ("0" if good[-1] != "0" else "1")), "tampered signature accepted"
    assert not security.verify_razorpay_payment_signature(order, "pay_OTHER", good), "signature accepted for a different payment id"
    return "valid accepted; tampered and mismatched-payment signatures rejected"


def _reset_token_hash() -> str:
    # SHA-256("abc") — the standard FIPS 180-2 test vector.
    expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    actual = security.hash_reset_token("abc")
    assert actual == expected, f"expected {expected}, got {actual}"
    return "matches the SHA-256 known-answer vector"


def _session_tokens() -> str:
    first, second = security.generate_session_token(), security.generate_session_token()
    assert len(first) >= 40 and first != second, "session tokens too short or repeating"
    return "tokens are long and unique"


def _broker_secret_encryption() -> str:
    ciphertext = security.encrypt_secret("sample-secret-value")
    assert ciphertext != "sample-secret-value", "secret stored as plaintext"
    assert security.decrypt_secret(ciphertext) == "sample-secret-value", "decrypt did not return the original"
    return "encrypt/decrypt round trip OK, ciphertext differs from plaintext"


def _plan_limits() -> str:
    free, pro, business = plans.limits_for("FREE"), plans.limits_for("PRO"), plans.limits_for("BUSINESS")
    assert (free.max_trading_accounts, free.max_members_per_account) == (3, 2), f"FREE limits changed: {free}"
    assert (pro.max_trading_accounts, pro.max_members_per_account) == (15, 10), f"PRO limits changed: {pro}"
    assert business.max_trading_accounts is None and business.max_members_per_account is None, "BUSINESS must be unlimited"
    assert plans.limits_for("NOT_A_PLAN") == free, "unknown plan must fall back to FREE limits"
    return "FREE 3/2, PRO 15/10, BUSINESS unlimited, unknown plan falls back to FREE"


def _platform_roles() -> str:
    assert PlatformRole.at_least("DEVELOPER", "ADMIN") and PlatformRole.at_least("ADMIN", "ADMIN")
    assert not PlatformRole.at_least("ADMIN", "DEVELOPER"), "ADMIN must not reach developer-only routes"
    assert not PlatformRole.at_least("USER", "ADMIN"), "USER must not reach admin routes"
    assert not PlatformRole.at_least("garbage", "ADMIN"), "an unknown role must rank as USER"
    return "DEVELOPER >= ADMIN >= USER; unknown roles get no access"


def _account_access_matrix() -> str:
    """The real require_account_member against a throwaway in-memory database."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    try:
        users = {
            name: models.User(email=f"{name}@selftest.local", password_hash="x", display_name=name)
            for name in ("owner", "viewer", "outsider")
        }
        db.add_all(users.values())
        db.flush()
        workspace = models.Workspace(name="selftest", owner_user_id=users["owner"].id)
        db.add(workspace)
        db.flush()
        account = models.TradingAccount(workspace_id=workspace.id, owner_user_id=users["owner"].id, name="acct")
        db.add(account)
        db.flush()
        db.add_all(
            [
                models.AccountMember(trading_account_id=account.id, user_id=users["owner"].id, role=models.AccountRole.OWNER),
                models.AccountMember(trading_account_id=account.id, user_id=users["viewer"].id, role=models.AccountRole.VIEWER),
            ]
        )
        db.commit()

        require_account_member(db, account.id, users["owner"], models.AccountRole.ADMIN)
        require_account_member(db, account.id, users["viewer"], models.AccountRole.VIEWER)

        def status_of(user: models.User, minimum: models.AccountRole) -> int:
            try:
                require_account_member(db, account.id, user, minimum)
            except HTTPException as exc:
                return exc.status_code
            return 200

        assert status_of(users["viewer"], models.AccountRole.ADMIN) == 403, "a VIEWER reached an ADMIN action"
        assert status_of(users["outsider"], models.AccountRole.VIEWER) == 404, "a non-member could confirm the account exists"
        return "owner ok, viewer blocked from admin (403), outsider gets 404"
    finally:
        db.close()
        engine.dispose()


SELF_TESTS: list[tuple[str, str, SelfTest]] = [
    ("password_hashing", "Password hash & verify", _password_hashing),
    ("razorpay_signature", "Razorpay signature check", _razorpay_signature),
    ("reset_token_hash", "Reset-token hashing", _reset_token_hash),
    ("session_tokens", "Session token generation", _session_tokens),
    ("broker_secret_encryption", "Broker secret encryption", _broker_secret_encryption),
    ("plan_limits", "Plan limit math", _plan_limits),
    ("platform_roles", "Platform role ranking", _platform_roles),
    ("account_access_matrix", "Account access role matrix", _account_access_matrix),
]


def run_all() -> dict:
    global _last_run
    results = []
    with _run_lock:
        for key, label, fn in SELF_TESTS:
            start = time.perf_counter()
            try:
                detail = fn()
                status = "pass"
            except AssertionError as exc:
                status, detail = "fail", f"FAULTY — {exc}"
            except Exception as exc:  # a crashing test is a failing test, never a crashed endpoint
                status, detail = "fail", f"CRASHED — {type(exc).__name__}: {exc}"
            results.append(
                {
                    "key": key,
                    "label": label,
                    "status": status,
                    "detail": detail,
                    "duration_ms": round((time.perf_counter() - start) * 1000, 2),
                }
            )
        _last_run = {
            "ran_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "passed": sum(1 for r in results if r["status"] == "pass"),
            "failed": sum(1 for r in results if r["status"] == "fail"),
            "results": results,
        }
        return _last_run


def last_run() -> dict | None:
    return _last_run
