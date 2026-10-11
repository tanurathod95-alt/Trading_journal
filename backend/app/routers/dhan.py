from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException

from .. import models, schemas
from ..deps import get_current_user

router = APIRouter(prefix="/api/dhan", tags=["dhan"])

_BASE_URL = "https://api.dhan.co/v2"


def _dhan_get(path: str, access_token: str, what: str) -> list[dict]:
    """
    Dhan's API rejects cross-origin browser requests outright (confirmed:
    an OPTIONS preflight from a browser origin gets back a 403 "Invalid CORS
    request" — this isn't a missing-header oversight, Dhan's API simply
    doesn't support being called directly from a page in the browser). Every
    route here is a stateless, read-only pass-through (GET only) for that one
    reason: the access token the user already holds is relayed unchanged
    server-to-server. No database access; the token is never stored or logged.
    """
    try:
        response = httpx.get(
            f"{_BASE_URL}{path}",
            headers={"Content-Type": "application/json", "access-token": access_token},
            timeout=15.0,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach Dhan to load {what}") from exc

    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="Dhan access token is invalid or expired — regenerate it from web.dhan.co and reconnect.")

    body = response.json() if response.content else None
    if not response.is_success:
        message = (body or {}).get("remarks", {}).get("message") if isinstance(body, dict) else None
        raise HTTPException(status_code=response.status_code, detail=message or f"Unable to load {what} from Dhan")

    return body if isinstance(body, list) else []


@router.post("/trades", response_model=list[dict])
def get_trades(payload: schemas.DhanTradesRequest, user: models.User = Depends(get_current_user)) -> list[dict]:
    """Current trading day's executed trades (GET /v2/trades)."""
    return _dhan_get("/trades", payload.access_token, "trades")


@router.post("/trade-history", response_model=list[dict])
def get_trade_history(payload: schemas.DhanTradeHistoryRequest, user: models.User = Depends(get_current_user)) -> list[dict]:
    """
    Historical executed trades with charges (GET /v2/trades/{from-date}/{to-date}/{page}, per Dhan's
    Statements docs). Paginated by Dhan; page starts at 0. The frontend walks pages until one is empty.
    """
    if payload.to_date < payload.from_date:
        raise HTTPException(status_code=422, detail="to_date must be on or after from_date")
    return _dhan_get(
        f"/trades/{payload.from_date.isoformat()}/{payload.to_date.isoformat()}/{payload.page}",
        payload.access_token,
        "trade history",
    )


@router.post("/orders", response_model=list[dict])
def get_orders(payload: schemas.DhanTradesRequest, user: models.User = Depends(get_current_user)) -> list[dict]:
    """The day's order book (GET /v2/orders)."""
    return _dhan_get("/orders", payload.access_token, "orders")
