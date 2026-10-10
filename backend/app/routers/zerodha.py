from __future__ import annotations

import hashlib

import httpx
from fastapi import APIRouter, Depends, HTTPException

from .. import models, schemas
from ..config import settings
from ..deps import get_current_user

router = APIRouter(prefix="/api/zerodha", tags=["zerodha"])

_TOKEN_URL = "https://api.kite.trade/session/token"


@router.post("/exchange-token", response_model=schemas.ZerodhaTokenOut)
def exchange_token(
    payload: schemas.ZerodhaExchangeTokenRequest, user: models.User = Depends(get_current_user)
) -> schemas.ZerodhaTokenOut:
    """
    The only reason this endpoint exists: Kite Connect's token exchange needs
    a checksum computed with `api_secret`, which must never sit in frontend
    JS. Same shape as routers/upstox.py — a pure pass-through, touches no
    database table, persists nothing.
    """
    checksum = hashlib.sha256(
        (payload.api_key + payload.request_token + settings.zerodha_api_secret).encode("utf-8")
    ).hexdigest()

    try:
        response = httpx.post(
            _TOKEN_URL,
            data={"api_key": payload.api_key, "request_token": payload.request_token, "checksum": checksum},
            headers={"X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded"},
            timeout=15.0,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach Zerodha to exchange the request token") from exc

    body = response.json() if response.content else {}
    access_token = (body.get("data") or {}).get("access_token")
    if not response.is_success or not access_token:
        raise HTTPException(status_code=400, detail=body.get("message") or "Zerodha token exchange failed")

    return schemas.ZerodhaTokenOut(access_token=access_token)
