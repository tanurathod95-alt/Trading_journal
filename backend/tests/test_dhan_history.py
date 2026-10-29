from __future__ import annotations

import httpx
import pytest

from backend.app.routers import dhan as dhan_router


def _signup(client, email="dhan@example.com"):
    r = client.post("/api/auth/signup", json={"email": email, "password": "password123", "display_name": "Dhan User"})
    assert r.status_code == 201, r.text


class _Resp:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body
        self.content = b"x" if body is not None else b""
        self.is_success = 200 <= status < 300

    def json(self):
        return self._body


@pytest.fixture
def dhan_get(monkeypatch):
    calls: list[dict] = []
    responses: list[object] = []

    def fake_get(url, headers=None, timeout=None):
        calls.append({"url": url, "headers": headers})
        item = responses.pop(0) if responses else _Resp(200, [])
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(dhan_router.httpx, "get", fake_get)
    return calls, responses


BODY = {"access_token": "tok-123", "from_date": "2024-01-01", "to_date": "2024-03-31", "page": 0}


def test_trade_history_needs_a_signed_in_user(client):
    assert client.post("/api/dhan/trade-history", json=BODY).status_code == 401


def test_trade_history_puts_the_dates_and_page_in_dhans_path_and_relays_the_rows(client, dhan_get):
    calls, responses = dhan_get
    rows = [{"exchangeTradeId": "T1", "transactionType": "BUY", "tradedQuantity": 1, "tradedPrice": 390.9}]
    responses.append(_Resp(200, rows))
    _signup(client)

    r = client.post("/api/dhan/trade-history", json={**BODY, "page": 2})
    assert r.status_code == 200 and r.json() == rows
    assert calls[0]["url"] == "https://api.dhan.co/v2/trades/2024-01-01/2024-03-31/2"
    assert calls[0]["headers"]["access-token"] == "tok-123"


def test_trade_history_rejects_anything_that_is_not_a_plain_date(client, dhan_get):
    calls, _ = dhan_get
    _signup(client)
    for bad in ("2024-1-1", "../../orders", "2024-01-01/../x", "20240101", ""):
        assert client.post("/api/dhan/trade-history", json={**BODY, "from_date": bad}).status_code == 422, bad
    assert client.post("/api/dhan/trade-history", json={**BODY, "from_date": "2024-02-30"}).status_code == 422  # not a real day
    assert client.post("/api/dhan/trade-history", json={**BODY, "from_date": "2024-04-01"}).status_code == 422  # after to_date
    assert client.post("/api/dhan/trade-history", json={**BODY, "page": -1}).status_code == 422
    assert calls == []  # nothing invalid ever reached Dhan


def test_trade_history_turns_dhans_failures_into_clear_errors(client, dhan_get):
    _, responses = dhan_get
    _signup(client)

    responses.append(_Resp(401, {}))
    r = client.post("/api/dhan/trade-history", json=BODY)
    assert r.status_code == 401 and "expired" in r.json()["detail"]

    responses.append(_Resp(429, {}))
    assert client.post("/api/dhan/trade-history", json=BODY).status_code == 429

    responses.append(_Resp(400, {"remarks": {"message": "Invalid date range"}}))
    r = client.post("/api/dhan/trade-history", json=BODY)
    assert r.status_code == 400 and r.json()["detail"] == "Invalid date range"

    responses.append(httpx.ConnectError("down"))
    assert client.post("/api/dhan/trade-history", json=BODY).status_code == 502

    responses.append(_Resp(200, {"unexpected": "object"}))  # not a list -> no rows, never a crash
    assert client.post("/api/dhan/trade-history", json=BODY).json() == []


def test_the_access_token_is_never_echoed_back(client, dhan_get):
    _, responses = dhan_get
    responses.append(_Resp(400, {"remarks": {"message": "bad"}}))
    _signup(client)
    r = client.post("/api/dhan/trade-history", json=BODY)
    assert "tok-123" not in r.text
