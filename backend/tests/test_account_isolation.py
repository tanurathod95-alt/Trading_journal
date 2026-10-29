from __future__ import annotations

from backend.app import models


def _signup(client, email, name):
    r = client.post("/api/auth/signup", json={"email": email, "password": "password123", "display_name": name})
    assert r.status_code == 201
    return r.json()


def _create_account(client, workspace_id, name="A1", broker="Angel One"):
    return client.post("/api/accounts", json={"workspace_id": workspace_id, "name": name, "broker_name": broker})


def test_owner_can_create_account_in_own_workspace(client):
    user = _signup(client, "owner@example.com", "Owner")
    ws_id = user["workspaces"][0]["id"]

    r = _create_account(client, ws_id, name="Owner - Angel One")
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Owner - Angel One"
    assert body["role"] == "OWNER"
    assert body["is_archived"] is False


def test_cannot_create_account_in_a_workspace_you_do_not_belong_to(client):
    user_a = _signup(client, "a@example.com", "A")
    ws_a_id = user_a["workspaces"][0]["id"]
    client.post("/api/auth/logout")

    _signup(client, "b@example.com", "B")
    r = _create_account(client, ws_a_id, name="Sneaky Account")
    assert r.status_code == 404


def test_non_member_cannot_view_another_users_account(client):
    user_a = _signup(client, "a2@example.com", "A2")
    ws_a_id = user_a["workspaces"][0]["id"]
    account = _create_account(client, ws_a_id).json()
    client.post("/api/auth/logout")

    _signup(client, "b2@example.com", "B2")
    r = client.get(f"/api/accounts/{account['id']}")
    assert r.status_code == 404


def test_owner_can_view_their_own_account(client):
    user = _signup(client, "a3@example.com", "A3")
    ws_id = user["workspaces"][0]["id"]
    account = _create_account(client, ws_id).json()

    r = client.get(f"/api/accounts/{account['id']}")
    assert r.status_code == 200
    assert r.json()["id"] == account["id"]


def test_list_accounts_never_leaks_between_users(client):
    user_a = _signup(client, "a4@example.com", "A4")
    ws_a_id = user_a["workspaces"][0]["id"]
    _create_account(client, ws_a_id, name="A4 Account 1")
    _create_account(client, ws_a_id, name="A4 Account 2")
    client.post("/api/auth/logout")

    user_b = _signup(client, "b4@example.com", "B4")
    ws_b_id = user_b["workspaces"][0]["id"]
    _create_account(client, ws_b_id, name="B4 Account 1")

    r = client.get("/api/accounts")
    assert r.status_code == 200
    names = {a["name"] for a in r.json()}
    assert names == {"B4 Account 1"}


def test_trading_account_creation_is_capped_by_plan_and_lifted_by_upgrading(client, set_plan):
    user = _signup(client, "a5@example.com", "A5")
    ws_id = user["workspaces"][0]["id"]

    for i in range(1, 4):  # FREE plan allows 3
        r = _create_account(client, ws_id, name=f"A5 Account {i}")
        assert r.status_code == 201

    r_blocked = _create_account(client, ws_id, name="A5 Account 4")
    assert r_blocked.status_code == 402

    set_plan(ws_id, "BUSINESS")  # what a verified payment does; customers can't PATCH their own plan

    for i in range(4, 11):  # BUSINESS is unlimited
        r = _create_account(client, ws_id, name=f"A5 Account {i}")
        assert r.status_code == 201

    r = client.get("/api/accounts")
    assert len(r.json()) == 10


def test_idor_manually_supplied_account_id_cannot_bypass_authorization(client):
    user_a = _signup(client, "a6@example.com", "A6")
    ws_a_id = user_a["workspaces"][0]["id"]
    account = _create_account(client, ws_a_id).json()
    client.post("/api/auth/logout")

    _signup(client, "b6@example.com", "B6")
    # B directly requests A's real account ID — must still be denied.
    r_get = client.get(f"/api/accounts/{account['id']}")
    assert r_get.status_code == 404
    r_patch = client.patch(f"/api/accounts/{account['id']}", json={"name": "Hijacked"})
    assert r_patch.status_code == 404
    r_delete = client.delete(f"/api/accounts/{account['id']}")
    assert r_delete.status_code == 404


def test_viewer_role_cannot_update_account(client, db_sessionmaker):
    # No invite flow exists yet (Phase 5) — insert a VIEWER membership
    # directly to prove the role-rank check itself works ahead of that.
    user_a = _signup(client, "a7@example.com", "A7")
    ws_a_id = user_a["workspaces"][0]["id"]
    account = _create_account(client, ws_a_id).json()
    client.post("/api/auth/logout")

    user_b = _signup(client, "b7@example.com", "B7")
    db = db_sessionmaker()
    try:
        db.add(models.AccountMember(trading_account_id=account["id"], user_id=user_b["user"]["id"], role=models.AccountRole.VIEWER))
        db.commit()
    finally:
        db.close()

    r_get = client.get(f"/api/accounts/{account['id']}")
    assert r_get.status_code == 200  # Viewer can read

    r_patch = client.patch(f"/api/accounts/{account['id']}", json={"name": "Should not work"})
    assert r_patch.status_code == 403

    r_delete = client.delete(f"/api/accounts/{account['id']}")
    assert r_delete.status_code == 403


def test_admin_role_can_update_but_not_delete_account(client, db_sessionmaker):
    user_a = _signup(client, "a8@example.com", "A8")
    ws_a_id = user_a["workspaces"][0]["id"]
    account = _create_account(client, ws_a_id).json()
    client.post("/api/auth/logout")

    user_b = _signup(client, "b8@example.com", "B8")
    db = db_sessionmaker()
    try:
        db.add(models.AccountMember(trading_account_id=account["id"], user_id=user_b["user"]["id"], role=models.AccountRole.ADMIN))
        db.commit()
    finally:
        db.close()

    r_patch = client.patch(f"/api/accounts/{account['id']}", json={"name": "Renamed by admin"})
    assert r_patch.status_code == 200
    assert r_patch.json()["name"] == "Renamed by admin"

    r_delete = client.delete(f"/api/accounts/{account['id']}")
    assert r_delete.status_code == 403  # only OWNER may delete


def test_updating_one_account_does_not_affect_a_sibling_account(client):
    user = _signup(client, "a9@example.com", "A9")
    ws_id = user["workspaces"][0]["id"]
    account_1 = _create_account(client, ws_id, name="Sibling 1").json()
    account_2 = _create_account(client, ws_id, name="Sibling 2").json()

    client.patch(f"/api/accounts/{account_1['id']}", json={"is_archived": True})

    r1 = client.get(f"/api/accounts/{account_1['id']}").json()
    r2 = client.get(f"/api/accounts/{account_2['id']}").json()
    assert r1["is_archived"] is True
    assert r2["is_archived"] is False
    assert r2["name"] == "Sibling 2"


def test_owner_delete_removes_the_account(client):
    user = _signup(client, "a10@example.com", "A10")
    ws_id = user["workspaces"][0]["id"]
    account = _create_account(client, ws_id).json()

    r = client.delete(f"/api/accounts/{account['id']}")
    assert r.status_code == 204

    r_get = client.get(f"/api/accounts/{account['id']}")
    assert r_get.status_code == 404
