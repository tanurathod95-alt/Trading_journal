from __future__ import annotations

import datetime as dt

import httpx
from fastapi import APIRouter, Depends, HTTPException

from .. import models, schemas
from ..deps import get_current_user
from ..observability import track

router = APIRouter(prefix="/api/dhan", tags=["dhan"])

_TRADES_URL = "https://api.dhan.co/v2/trades"


def _relay(url: str, access_token: str, what: str) -> list[dict]:
    """GET one Dhan URL on the user's behalf and return its JSON list, turning Dhan's failures into clear errors."""
    try:
        response = httpx.get(url, headers={"Content-Type": "application/json", "access-token": access_token}, timeout=20.0)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach Dhan to load {what}") from exc

    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="Dhan access token is invalid or expired — regenerate it from web.dhan.co and reconnect.")
    if response.status_code == 429:
        raise HTTPException(status_code=429, detail="Dhan is rate-limiting requests. Wait a minute and retry.")

    try:
        body = response.json() if response.content else None
    except ValueError:
        body = None
    if not response.is_success:
        message = (body or {}).get("remarks", {}).get("message") if isinstance(body, dict) else None
        raise HTTPException(status_code=response.status_code, detail=message or f"Unable to load {what} from Dhan")

    return body if isinstance(body, list) else []


@router.post("/trades", response_model=list[dict])
def get_trades(payload: schemas.DhanTradesRequest, user: models.User = Depends(get_current_user)) -> list[dict]:
    """
    Dhan's API rejects cross-origin browser requests outright (confirmed:
    an OPTIONS preflight from a browser origin gets back a 403 "Invalid CORS
    request" — this isn't a missing-header oversight, Dhan's API simply
    doesn't support being called directly from a page in the browser). This
    is a pure pass-through proxy for that one reason: the frontend sends the
    access token the user already pasted into Settings (encrypted client-side,
    unchanged), this just relays the same GET server-to-server. No database
    access, nothing persisted or logged here.
    """
    with track("dhan.get_trades", "upstream"):
        return _relay(_TRADES_URL, payload.access_token, "trades")


@router.post("/trade-history", response_model=list[dict])
def get_trade_history(payload: schemas.DhanTradeHistoryRequest, user: models.User = Depends(get_current_user)) -> list[dict]:
    """
    One page of Dhan's v2 trade history for a date range: GET /v2/trades/{from-date}/{to-date}/{page}
    (documented at https://dhanhq.co/docs/v2/statements/ — dates are in the path, pages count from 0, and Dhan does
    not state a maximum range or page size, so the caller asks page by page until one comes back empty).
    Same pass-through as /trades, for the same CORS reason: the token is relayed, never stored or logged.
    """
    try:
        start = dt.date.fromisoformat(payload.from_date)
        end = dt.date.fromisoformat(payload.to_date)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Dates must be real calendar dates (YYYY-MM-DD).") from exc
    if start > end:
        raise HTTPException(status_code=422, detail="from_date must be on or before to_date.")

    with track("dhan.get_trade_history", "upstream"):
        return _relay(f"{_TRADES_URL}/{payload.from_date}/{payload.to_date}/{payload.page}", payload.access_token, "trade history")
