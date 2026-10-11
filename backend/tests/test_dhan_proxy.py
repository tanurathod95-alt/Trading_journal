from __future__ import annotations

import httpx

from backend.app.routers import dhan as dhan_router


class _FakeResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload
        self.content = b"x"

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self):
        return self._payload


def _signup(client):
    r = client.post("/api/auth/signup", json={"email": "dhan@example.com", "password": "password123", "display_name": "Dhan User"})
    assert r.status_code == 201


def test_dhan_routes_require_login(client):
    assert client.post("/api/dhan/trade-history", json={"access_token": "t", "from_date": "2024-08-01", "to_date": "2024-08-02", "page": 0}).status_code == 401
    assert client.post("/api/dhan/orders", json={"access_token": "t"}).status_code == 401


def test_trade_history_builds_documented_path_and_relays_token_only_as_header(client, monkeypatch):
    _signup(client)
    seen = {}

    def fake_get(url, headers=None, timeout=None):
        seen["url"] = url
        seen["headers"] = headers
        return _FakeResponse(200, [{"exchangeTradeId": "E1", "brokerageCharges": 1.5}])

    monkeypatch.setattr(dhan_router.httpx, "get", fake_get)
    r = client.post("/api/dhan/trade-history", json={"access_token": "secret-token", "from_date": "2024-08-01", "to_date": "2024-08-30", "page": 2})

    assert r.status_code == 200
    assert r.json() == [{"exchangeTradeId": "E1", "brokerageCharges": 1.5}]
    assert seen["url"] == "https://api.dhan.co/v2/trades/2024-08-01/2024-08-30/2"
    assert seen["headers"]["access-token"] == "secret-token"
    assert "secret-token" not in seen["url"]


def test_trade_history_rejects_inverted_range_and_bad_dates(client, monkeypatch):
    _signup(client)
    monkeypatch.setattr(dhan_router.httpx, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not call Dhan")))
    assert client.post("/api/dhan/trade-history", json={"access_token": "t", "from_date": "2024-08-30", "to_date": "2024-08-01", "page": 0}).status_code == 422
    assert client.post("/api/dhan/trade-history", json={"access_token": "t", "from_date": "../../x", "to_date": "2024-08-01", "page": 0}).status_code == 422


def test_expired_token_and_network_errors_are_reported_not_hidden(client, monkeypatch):
    _signup(client)
    monkeypatch.setattr(dhan_router.httpx, "get", lambda *a, **k: _FakeResponse(401, {}))
    r = client.post("/api/dhan/orders", json={"access_token": "t"})
    assert r.status_code == 401 and "expired" in r.json()["detail"]

    def boom(*a, **k):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(dhan_router.httpx, "get", boom)
    assert client.post("/api/dhan/orders", json={"access_token": "t"}).status_code == 502


def test_orders_and_trades_still_work(client, monkeypatch):
    _signup(client)
    monkeypatch.setattr(dhan_router.httpx, "get", lambda url, **k: _FakeResponse(200, [{"u": url}]))
    assert client.post("/api/dhan/orders", json={"access_token": "t"}).json() == [{"u": "https://api.dhan.co/v2/orders"}]
    assert client.post("/api/dhan/trades", json={"access_token": "t"}).json() == [{"u": "https://api.dhan.co/v2/trades"}]
