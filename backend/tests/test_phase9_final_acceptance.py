from __future__ import annotations

import time

from backend.app import models


def _signup(client, email, name):
    r = client.post("/api/auth/signup", json={"email": email, "password": "password123", "display_name": name})
    assert r.status_code == 201
    return r.json()


def _login(client, email):
    r = client.post("/api/auth/login", json={"email": email, "password": "password123"})
    assert r.status_code == 200


def _create_account(client, workspace_id, name):
    r = client.post("/api/accounts", json={"workspace_id": workspace_id, "name": name, "broker_name": "Angel One"})
    assert r.status_code == 201
    return r.json()


def test_full_acceptance_scenario_from_the_original_spec(client, db_sessionmaker, set_plan):
    """
    The exact end-to-end scenario given in the original spec: User A creates
    10 accounts, shares exactly one (A5) with Person B as VIEWER, and every
    constraint on what Person B can and cannot do is checked in one place —
    plus the revoke-is-immediate check at the end.
    """
    user_a = _signup(client, "usera@example.com", "User A")
    ws_a = user_a["workspaces"][0]["id"]
    set_plan(ws_a, "BUSINESS")  # FREE caps accounts at 3; this scenario needs 10

    accounts = [_create_account(client, ws_a, f"A{i}") for i in range(1, 11)]
    a5 = accounts[4]

    client.put(
        f"/api/accounts/{a5['id']}/broker-credentials",
        json={"broker_name": "Angel One", "api_key": "k", "client_code": "C1", "pin": "1234", "totp_secret": "S"},
    )

    r_invite = client.post(f"/api/accounts/{a5['id']}/invitations", json={"email": "personb@example.com", "role": "VIEWER"})
    invitation_id = r_invite.json()["id"]
    client.post("/api/auth/logout")

    person_b = _signup(client, "personb@example.com", "Person B")
    r_accept = client.post(f"/api/invitations/{invitation_id}/accept")
    assert r_accept.status_code == 200

    # Person B sees exactly A5 under "their" accounts — never the other nine.
    r_list = client.get("/api/accounts")
    listed_ids = {a["id"] for a in r_list.json()}
    assert listed_ids == {a5["id"]}

    # Person B cannot edit A5.
    assert client.patch(f"/api/accounts/{a5['id']}", json={"name": "Hacked"}).status_code == 403
    # Person B cannot delete A5.
    assert client.delete(f"/api/accounts/{a5['id']}").status_code == 403
    # Person B cannot see any of the other nine accounts, even by real ID (IDOR).
    for other in accounts:
        if other["id"] == a5["id"]:
            continue
        assert client.get(f"/api/accounts/{other['id']}").status_code == 404
    # Person B cannot see broker secrets for A5.
    assert client.get(f"/api/accounts/{a5['id']}/broker-credentials/reveal").status_code == 403
    # Person B can see A5's masked broker status (dashboard-safe).
    r_status = client.get(f"/api/accounts/{a5['id']}/broker-status")
    assert r_status.status_code == 200
    status_body = r_status.json()
    assert set(status_body.keys()) == {"is_connected", "broker_name", "masked_client_code", "updated_at"}
    assert status_body["masked_client_code"] != "C1"  # masked, not the real client code
    # Person B cannot invite anyone to A5.
    assert client.post(f"/api/accounts/{a5['id']}/invitations", json={"email": "x@example.com", "role": "VIEWER"}).status_code == 403
    # Person B cannot change permissions (view or alter the members/invitations lists) on A5.
    assert client.get(f"/api/accounts/{a5['id']}/members").status_code == 403
    assert client.get(f"/api/accounts/{a5['id']}/invitations").status_code == 403
    # Person B cannot change a plan at all (only platform staff can).
    assert client.patch(f"/api/workspaces/{ws_a}/plan", json={"plan": "BUSINESS"}).status_code == 405
    # Person B cannot read the audit log.
    assert client.get(f"/api/accounts/{a5['id']}/audit-log").status_code == 403

    # --- User A revokes Person B's access ---
    client.post("/api/auth/logout")
    _login(client, "usera@example.com")
    members = client.get(f"/api/accounts/{a5['id']}/members").json()
    person_b_membership = next(m for m in members if m["email"] == "personb@example.com")
    r_revoke = client.delete(f"/api/accounts/{a5['id']}/members/{person_b_membership['id']}")
    assert r_revoke.status_code == 204

    # --- Person B immediately loses access, no caching/delay ---
    client.post("/api/auth/logout")
    _login(client, "personb@example.com")
    assert client.get(f"/api/accounts/{a5['id']}").status_code == 404
    assert client.get("/api/accounts").json() == []


def test_data_isolation_and_scoped_listing_holds_up_at_moderate_scale(client, set_plan):
    """
    A lightweight performance/isolation sanity check (not a load test):
    two users each create a batch of accounts, and each user's own list
    stays exactly scoped to their own accounts regardless of how much data
    exists overall, in bounded time.
    """
    user_a = _signup(client, "scalea@example.com", "Scale A")
    ws_a = user_a["workspaces"][0]["id"]
    set_plan(ws_a, "BUSINESS")  # FREE caps accounts at 3
    for i in range(15):
        _create_account(client, ws_a, f"A-{i}")
    client.post("/api/auth/logout")

    user_b = _signup(client, "scaleb@example.com", "Scale B")
    ws_b = user_b["workspaces"][0]["id"]
    set_plan(ws_b, "BUSINESS")
    for i in range(15):
        _create_account(client, ws_b, f"B-{i}")

    start = time.monotonic()
    r = client.get("/api/accounts")
    elapsed = time.monotonic() - start

    assert r.status_code == 200
    names = {a["name"] for a in r.json()}
    assert len(names) == 15
    assert all(n.startswith("B-") for n in names)
    assert elapsed < 2.0  # generous bound — this is isolation correctness, not a real benchmark
