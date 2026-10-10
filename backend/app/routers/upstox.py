from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException

from .. import models, schemas
from ..config import settings
from ..deps import get_current_user

router = APIRouter(prefix="/api/upstox", tags=["upstox"])

_TOKEN_URL = "https://api.upstox.com/v2/login/authorization/token"


@router.post("/exchange-token", response_model=schemas.UpstoxTokenOut)
def exchange_token(
    payload: schemas.UpstoxExchangeTokenRequest, user: models.User = Depends(get_current_user)
) -> schemas.UpstoxTokenOut:
    """
    The only reason this endpoint exists: Upstox's OAuth2 authorization-code
    exchange requires a `client_secret`, which must never sit in frontend JS.
    Everything else about Upstox trade sync (trade-book fetch, FIFO matching,
    Dexie writes) is client-side, same as Angel One — this is a pure
    pass-through proxy, touches no database table, persists nothing.
    """
    try:
        response = httpx.post(
            _TOKEN_URL,
            data={
                "code": payload.code,
                "client_id": payload.client_id,
                "client_secret": settings.upstox_client_secret,
                "redirect_uri": payload.redirect_uri,
                "grant_type": "authorization_code",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
            timeout=15.0,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Could not reach Upstox to exchange the authorization code") from exc

    body = response.json() if response.content else {}
    access_token = body.get("access_token")
    if not response.is_success or not access_token:
        raise HTTPException(status_code=400, detail=body.get("error_description") or body.get("message") or "Upstox token exchange failed")

    return schemas.UpstoxTokenOut(access_token=access_token)
