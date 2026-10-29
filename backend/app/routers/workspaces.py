from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from .. import models, schemas
from ..authz import require_workspace_member
from ..deps import get_current_user, get_db
from ..plans import count_trading_accounts, limits_for

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


def _out(membership: models.WorkspaceMember) -> schemas.WorkspaceOut:
    return schemas.WorkspaceOut(
        id=membership.workspace.id,
        name=membership.workspace.name,
        plan=membership.workspace.plan,
        role=membership.role.value,
        created_at=membership.workspace.created_at,
    )


@router.get("", response_model=list[schemas.WorkspaceOut])
def list_my_workspaces(db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)) -> list[schemas.WorkspaceOut]:
    memberships = db.scalars(select(models.WorkspaceMember).where(models.WorkspaceMember.user_id == user.id)).all()
    return [_out(m) for m in memberships]


@router.get("/{workspace_id}", response_model=schemas.WorkspaceOut)
def get_workspace(
    workspace_id: str, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> schemas.WorkspaceOut:
    # ADMIN is the lowest workspace role that exists (OWNER/ADMIN only, no
    # workspace-level Viewer) — using it as min_role here just means "any
    # member," matching the original behavior before this moved to the
    # shared authz helper.
    membership = require_workspace_member(db, workspace_id, user, min_role=models.WorkspaceRole.ADMIN)
    return _out(membership)


@router.get("/{workspace_id}/plan", response_model=schemas.WorkspacePlanOut)
def get_plan(
    workspace_id: str, db: DBSession = Depends(get_db), user: models.User = Depends(get_current_user)
) -> schemas.WorkspacePlanOut:
    membership = require_workspace_member(db, workspace_id, user, min_role=models.WorkspaceRole.ADMIN)
    workspace = membership.workspace
    limits = limits_for(workspace.plan)
    return schemas.WorkspacePlanOut(
        plan=workspace.plan,
        limits=schemas.PlanLimitsOut(
            max_trading_accounts=limits.max_trading_accounts, max_members_per_account=limits.max_members_per_account
        ),
        trading_accounts_used=count_trading_accounts(db, workspace_id),
    )
