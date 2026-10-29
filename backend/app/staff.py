from __future__ import annotations

from fastapi import Depends, HTTPException

from . import models
from .deps import get_current_user


class PlatformRole:
    """Platform staff roles, cumulative: DEVELOPER >= ADMIN >= USER. Not a customer workspace/account role."""

    USER = "USER"
    ADMIN = "ADMIN"
    DEVELOPER = "DEVELOPER"

    ALL = [USER, ADMIN, DEVELOPER]
    _RANK = {USER: 0, ADMIN: 1, DEVELOPER: 2}

    @classmethod
    def rank(cls, role: str) -> int:
        # An unknown/garbled value ranks as USER, never higher.
        return cls._RANK.get(role, 0)

    @classmethod
    def at_least(cls, role: str, minimum: str) -> bool:
        return cls.rank(role) >= cls.rank(minimum)


def require_platform_role(minimum: str):
    """
    Dependency factory. The role is read from the DB row get_current_user
    just loaded, so demoting someone takes effect on their very next request.
    Hidden buttons are not security — every staff route depends on this.
    """

    def dependency(user: models.User = Depends(get_current_user)) -> models.User:
        if not PlatformRole.at_least(user.platform_role, minimum):
            raise HTTPException(status_code=403, detail="Not allowed")
        return user

    return dependency


require_developer = require_platform_role(PlatformRole.DEVELOPER)
