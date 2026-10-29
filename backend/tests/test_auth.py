from __future__ import annotations

from sqlalchemy import select

from backend.app import models


def _signup(client, email="a@example.com", password="password123", name="User A"):
    return client.post("/api/auth/signup", json={"email": email, "password": password, "display_name": name})


def test_signup_creates_user_and_owner_workspace(client):
    r = _signup(client)
    assert r.status_code == 201
    body = r.json()
    assert body["user"]["email"] == "a@example.com"
    assert len(body["workspaces"]) == 1
    assert body["workspaces"][0]["role"] == "OWNER"
    assert body["workspaces"][0]["name"] == "User A's Workspace"


def test_duplicate_signup_email_rejected(client):
    _signup(client, email="dup@example.com")
    r = _signup(client, email="dup@example.com")
    assert r.status_code == 409


def test_me_requires_authentication(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 401


def test_unauthenticated_request_to_protected_workspace_route_fails(client):
    r = client.get("/api/workspaces")
    assert r.status_code == 401


def test_login_then_me_works(client):
    _signup(client, email="b@example.com")
    client.post("/api/auth/logout")

    r = client.post("/api/auth/login", json={"email": "b@example.com", "password": "password123"})
    assert r.status_code == 200

    r2 = client.get("/api/auth/me")
    assert r2.status_code == 200
    assert r2.json()["user"]["email"] == "b@example.com"


def test_wrong_password_fails(client):
    _signup(client, email="c@example.com")
    client.post("/api/auth/logout")

    r = client.post("/api/auth/login", json={"email": "c@example.com", "password": "WRONG-PASSWORD"})
    assert r.status_code == 401


def test_login_with_unknown_email_fails(client):
    r = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "password123"})
    assert r.status_code == 401


def test_logout_invalidates_session(client):
    _signup(client, email="d@example.com")
    assert client.get("/api/auth/me").status_code == 200

    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401


def test_password_never_stored_as_plaintext(client, db_sessionmaker):
    plaintext = "SuperSecret1"
    r = _signup(client, email="e@example.com", password=plaintext)
    assert r.status_code == 201
    assert plaintext not in r.text  # never echoed back in the API response

    db = db_sessionmaker()
    try:
        user = db.scalar(select(models.User).where(models.User.email == "e@example.com"))
        assert user is not None
        assert user.password_hash != plaintext
        assert plaintext not in user.password_hash
        assert user.password_hash.startswith("$2b$")  # bcrypt hash prefix
    finally:
        db.close()


def test_disabled_account_cannot_log_in_and_gets_a_clear_message(client, db_sessionmaker):
    _signup(client, "off@example.com", password="password123")
    client.post("/api/auth/logout")
    with db_sessionmaker() as db:
        db.scalar(select(models.User).where(models.User.email == "off@example.com")).is_active = False
        db.commit()

    r = client.post("/api/auth/login", json={"email": "off@example.com", "password": "password123"})
    assert r.status_code == 403
    assert "disabled" in r.json()["detail"].lower()
    assert client.get("/api/auth/me").status_code == 401  # no session was created

    with db_sessionmaker() as db:
        failed = db.query(models.AuditLog).filter(models.AuditLog.action == "LOGIN_FAILED").all()
        succeeded = db.query(models.AuditLog).filter(models.AuditLog.action == "LOGIN_SUCCESS").count()
    assert any("account_disabled" in (row.metadata_json or "") for row in failed)
    assert succeeded == 0


def test_wrong_password_on_a_disabled_account_does_not_reveal_it_is_disabled(client, db_sessionmaker):
    _signup(client, "off2@example.com", password="password123")
    client.post("/api/auth/logout")
    with db_sessionmaker() as db:
        db.scalar(select(models.User).where(models.User.email == "off2@example.com")).is_active = False
        db.commit()

    r = client.post("/api/auth/login", json={"email": "off2@example.com", "password": "not-the-password"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid email or password"
