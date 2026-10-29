"""
Promote an existing account to platform staff. Needs server access on purpose — there is no public way
to become staff.

    python -m backend.app.make_developer you@example.com            # DEVELOPER
    python -m backend.app.make_developer you@example.com ADMIN
"""
from __future__ import annotations

import sys

from sqlalchemy import select

from . import models
from .database import SessionLocal
from .staff import PlatformRole


def main(argv: list[str]) -> int:
    if not argv or argv[0].startswith("-"):
        print(__doc__)
        return 2
    email = argv[0].strip().lower()
    role = (argv[1] if len(argv) > 1 else PlatformRole.DEVELOPER).upper()
    if role not in PlatformRole.ALL:
        print(f"Role must be one of {PlatformRole.ALL}")
        return 2
    with SessionLocal() as db:
        user = db.scalar(select(models.User).where(models.User.email == email))
        if user is None:
            print(f"No account with email {email}. Sign up in the app first.")
            return 1
        user.platform_role = role
        db.commit()
    print(f"{email} is now {role}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
