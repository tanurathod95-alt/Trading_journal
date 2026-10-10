from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException

from .. import models, schemas
from ..deps import get_current_user

router = APIRouter(prefix="/api/dhan", tags=["dhan"])

_TRADES_URL = "https://api.dhan.co/v2/trades"


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
    try:
        response = httpx.get(
            _TRADES_URL,
            headers={"Content-Type": "application/json", "access-token": payload.access_token},
            timeout=15.0,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach Dhan to load trades") from exc

    if response.status_code == 401:
        raise HTTPException(status_code=401, detail="Dhan access token is invalid or expired — regenerate it from web.dhan.co and reconnect.")

    body = response.json() if response.content else None
    if not response.is_success:
        message = (body or {}).get("remarks", {}).get("message") if isinstance(body, dict) else None
        raise HTTPException(status_code=response.status_code, detail=message or "Unable to load trades from Dhan")

    return body if isinstance(body, list) else []
