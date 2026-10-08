from __future__ import annotations

import datetime as dt
import enum
import uuid

from sqlalchemy import Boolean, DateTime, Enum as SAEnum, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class WorkspaceRole(str, enum.Enum):
    OWNER = "OWNER"
    ADMIN = "ADMIN"


class AccountRole(str, enum.Enum):
    OWNER = "OWNER"
    ADMIN = "ADMIN"
    VIEWER = "VIEWER"


class InvitationStatus(str, enum.Enum):
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    REVOKED = "REVOKED"
    DECLINED = "DECLINED"
    # "EXPIRED" is never stored — it's derived from (status == PENDING and
    # expires_at < now) wherever it matters, so nothing has to sweep the
    # table on a timer just to keep this field truthful.


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)

    memberships: Mapped[list["WorkspaceMember"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    sessions: Mapped[list["Session"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    owner_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    plan: Mapped[str] = mapped_column(String(20), default="FREE", nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)

    members: Mapped[list["WorkspaceMember"]] = relationship(back_populates="workspace", cascade="all, delete-orphan")


class WorkspaceMember(Base):
    """
    Membership + role, scoped to one workspace. Phase 1 only ever creates an
    OWNER row (at signup, for the workspace signup itself creates) — ADMIN
    and additional members arrive with invitations in a later phase — but
    the table is shaped for that from the start so it isn't reworked then.
    """

    __tablename__ = "workspace_members"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id", name="uq_workspace_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(String(36), ForeignKey("workspaces.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    role: Mapped[WorkspaceRole] = mapped_column(SAEnum(WorkspaceRole), default=WorkspaceRole.OWNER, nullable=False)
    joined_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)

    workspace: Mapped["Workspace"] = relationship(back_populates="members")
    user: Mapped["User"] = relationship(back_populates="memberships")


class Portfolio(Base):
    """
    Phase 10.2 — an optional logical grouping of TradingAccounts inside a
    workspace, used by a portfolio manager to bundle "everything belonging
    to Client X" behind one invite instead of sharing each account
    separately. A solo trader never creates one; their TradingAccounts
    simply have portfolio_id = NULL, unchanged from every earlier phase.
    """

    __tablename__ = "portfolios"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(String(36), ForeignKey("workspaces.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    owner_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    client_display_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)

    members: Mapped[list["PortfolioMember"]] = relationship(back_populates="portfolio", cascade="all, delete-orphan")
    invitations: Mapped[list["PortfolioInvitation"]] = relationship(cascade="all, delete-orphan")
    accounts: Mapped[list["TradingAccount"]] = relationship(back_populates="portfolio")


class PortfolioMember(Base):
    """
    Same shape as AccountMember, one level up: a Client invited to a
    Portfolio gets read access to every TradingAccount under it (resolved
    in authz.require_account_member's portfolio fallback) without needing
    a separate AccountMember row per account.
    """

    __tablename__ = "portfolio_members"
    __table_args__ = (UniqueConstraint("portfolio_id", "user_id", name="uq_portfolio_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    portfolio_id: Mapped[str] = mapped_column(String(36), ForeignKey("portfolios.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    role: Mapped[AccountRole] = mapped_column(SAEnum(AccountRole), default=AccountRole.OWNER, nullable=False)
    granted_by_user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    granted_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)

    portfolio: Mapped["Portfolio"] = relationship(back_populates="members")
    user: Mapped["User"] = relationship(foreign_keys=[user_id])


class PortfolioInvitation(Base):
    """Portfolio-level counterpart of Invitation (Phase 5) — a separate table so the already-tested account Invitation model/flow is never touched."""

    __tablename__ = "portfolio_invitations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    portfolio_id: Mapped[str] = mapped_column(String(36), ForeignKey("portfolios.id"), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    role: Mapped[AccountRole] = mapped_column(SAEnum(AccountRole), default=AccountRole.VIEWER, nullable=False)
    status: Mapped[InvitationStatus] = mapped_column(SAEnum(InvitationStatus), default=InvitationStatus.PENDING, nullable=False)
    invited_by_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime, nullable=False)

    portfolio: Mapped["Portfolio"] = relationship(back_populates="invitations")
    invited_by: Mapped["User"] = relationship(foreign_keys=[invited_by_user_id])


class TradingAccount(Base):
    """
    A trading account is NOT a user — it's a labeled bucket of trades that
    lives inside a workspace. One user can own several of these (the
    original Dexie `Account` model, made server-side and now with real
    ownership). All trade/journal/report data in later phases hangs off
    `trading_account_id`, never off a user or workspace directly, so
    sharing a single account (Phase 5) never has to touch anything else.
    """

    __tablename__ = "trading_accounts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(String(36), ForeignKey("workspaces.id"), nullable=False, index=True)
    owner_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    # Nullable: a solo trader's account is never part of a portfolio. SET
    # NULL (not cascade) on portfolio delete — per the "never auto-delete
    # financial data" rule, removing a Portfolio only ungroups its accounts.
    portfolio_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("portfolios.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    broker_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    account_type: Mapped[str] = mapped_column(String(60), nullable=False, default="Trading")
    # E.164-ish "+<dial code><number>", e.g. "+919876543210". Validated for
    # shape (not deliverability) at the schema layer — never required, since
    # older accounts created before this field existed have none.
    contact_number: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime, default=dt.datetime.utcnow, onupdate=dt.datetime.utcnow, nullable=False
    )

    members: Mapped[list["AccountMember"]] = relationship(back_populates="account", cascade="all, delete-orphan")
    invitations: Mapped[list["Invitation"]] = relationship(cascade="all, delete-orphan")
    broker_connection: Mapped["BrokerConnection | None"] = relationship(cascade="all, delete-orphan")
    trades: Mapped[list["Trade"]] = relationship(cascade="all, delete-orphan")
    portfolio: Mapped["Portfolio | None"] = relationship(back_populates="accounts")


class AccountMember(Base):
    """
    The actual authorization record for a trading account — every read/write
    on an account (and, later, on its trades/journal entries) is gated by
    a row here, never by workspace membership. This is also what a Phase 5
    invitation ultimately creates: a Viewer accepting an invite gets exactly
    one row here, scoped to exactly one trading_account_id.
    """

    __tablename__ = "account_members"
    __table_args__ = (UniqueConstraint("trading_account_id", "user_id", name="uq_account_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    trading_account_id: Mapped[str] = mapped_column(String(36), ForeignKey("trading_accounts.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    role: Mapped[AccountRole] = mapped_column(SAEnum(AccountRole), default=AccountRole.OWNER, nullable=False)
    granted_by_user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    granted_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)

    account: Mapped["TradingAccount"] = relationship(back_populates="members")
    user: Mapped["User"] = relationship(foreign_keys=[user_id])


class Invitation(Base):
    """
    The real async sharing primitive (Phase 5) — unlike an AccountMember
    row, this can exist for an email address that has never signed up yet.
    Accepting it (see routers/invitations.py) is what actually creates the
    AccountMember row; nothing here grants access by itself.
    """

    __tablename__ = "invitations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    trading_account_id: Mapped[str] = mapped_column(String(36), ForeignKey("trading_accounts.id"), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    role: Mapped[AccountRole] = mapped_column(SAEnum(AccountRole), default=AccountRole.VIEWER, nullable=False)
    status: Mapped[InvitationStatus] = mapped_column(SAEnum(InvitationStatus), default=InvitationStatus.PENDING, nullable=False)
    invited_by_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime, nullable=False)

    account: Mapped["TradingAccount"] = relationship(back_populates="invitations")
    invited_by: Mapped["User"] = relationship(foreign_keys=[invited_by_user_id])


class Trade(Base):
    """
    Phase 10.1 — the piece that was missing when sharing a TradingAccount
    only shared an empty container. Field names deliberately mirror the
    existing frontend Dexie `Trade` interface (src/types/index.ts) so the
    opt-in import step is a near-literal copy, not a transform. Journal
    notes are the `notes` field here too, matching today's Dexie shape —
    there is no separate JournalEntry table by design.
    """

    __tablename__ = "trades"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    trading_account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("trading_accounts.id"), nullable=False, index=True
    )
    trade_date: Mapped[str] = mapped_column(String(10), nullable=False)
    segment: Mapped[str] = mapped_column(String(40), nullable=False)
    script_name: Mapped[str] = mapped_column(String(120), nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    quantity: Mapped[float] = mapped_column(nullable=False, default=0)
    side: Mapped[str] = mapped_column(String(10), nullable=False)
    entry_price: Mapped[float] = mapped_column(nullable=False, default=0)
    exit_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    exit_price: Mapped[float] = mapped_column(nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="OPEN")
    gross_pnl: Mapped[float] = mapped_column(nullable=False, default=0)
    net_pnl: Mapped[float] = mapped_column(nullable=False, default=0)
    notes: Mapped[str] = mapped_column(String(5000), nullable=False, default="")
    instrument_json: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_by_user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime, default=dt.datetime.utcnow, onupdate=dt.datetime.utcnow, nullable=False
    )


class BrokerConnection(Base):
    """
    Server-side, encrypted-at-rest storage for one trading account's broker
    login (Phase 7). Replaces the earlier client-only Dexie/Web-Crypto
    approach (key and ciphertext both living in the same browser, which the
    architecture plan flagged as not a real security boundary) with secrets
    that never touch the browser except at the one deliberate moment an
    OWNER/ADMIN explicitly reveals them to drive a live broker connect —
    see routers/broker.py. Every field that can identify or authenticate to
    the broker is stored only as ciphertext; nothing here is ever readable
    directly from the database dump.
    """

    __tablename__ = "broker_connections"
    __table_args__ = (UniqueConstraint("trading_account_id", name="uq_broker_connection_account"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    trading_account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("trading_accounts.id"), nullable=False, index=True
    )
    broker_name: Mapped[str] = mapped_column(String(60), nullable=False, default="Angel One")
    # Ciphertext fields (Fernet). client_code_masked is the ONLY plaintext-derived
    # value stored — a display mask like "***3456", never enough to authenticate.
    client_code_masked: Mapped[str] = mapped_column(String(40), nullable=False)
    encrypted_api_key: Mapped[str] = mapped_column(String(500), nullable=False)
    encrypted_client_code: Mapped[str] = mapped_column(String(500), nullable=False)
    encrypted_pin: Mapped[str] = mapped_column(String(500), nullable=False)
    encrypted_totp_secret: Mapped[str] = mapped_column(String(500), nullable=False)
    updated_by_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime, default=dt.datetime.utcnow, onupdate=dt.datetime.utcnow, nullable=False
    )


class SubscriptionStatus(str, enum.Enum):
    PENDING = "PENDING"  # Razorpay order created, payment not yet verified
    ACTIVE = "ACTIVE"
    EXPIRED = "EXPIRED"
    CANCELED = "CANCELED"


class Subscription(Base):
    """
    Phase 10.3 — one row per workspace's current billing state. Verifying a
    payment (routers/billing.py) both activates this AND sets
    Workspace.plan directly, so the existing Phase 8 entitlement engine
    (plans.py's PLAN_LIMITS/enforce_* functions, unchanged) picks up the
    new plan for free — billing drives the same `plan` field an OWNER
    could already set manually via PATCH /api/workspaces/{id}/plan.
    """

    __tablename__ = "subscriptions"
    __table_args__ = (UniqueConstraint("workspace_id", name="uq_subscription_workspace"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    workspace_id: Mapped[str] = mapped_column(String(36), ForeignKey("workspaces.id"), nullable=False, index=True)
    plan_name: Mapped[str] = mapped_column(String(20), nullable=False)
    billing_cycle: Mapped[str] = mapped_column(String(20), nullable=False, default="MONTHLY")
    status: Mapped[SubscriptionStatus] = mapped_column(
        SAEnum(SubscriptionStatus), default=SubscriptionStatus.PENDING, nullable=False
    )
    razorpay_order_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    razorpay_payment_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    current_period_end: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime, default=dt.datetime.utcnow, onupdate=dt.datetime.utcnow, nullable=False
    )


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    subscription_id: Mapped[str] = mapped_column(String(36), ForeignKey("subscriptions.id"), nullable=False, index=True)
    razorpay_payment_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    razorpay_order_id: Mapped[str] = mapped_column(String(64), nullable=False)
    amount_paise: Mapped[int] = mapped_column(nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="captured")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)


class WebhookEvent(Base):
    """
    The idempotency ledger for Razorpay webhooks: `razorpay_event_id` is
    UNIQUE, so a replayed/duplicate delivery of the same event is caught
    at the database level before any Subscription/Payment row is touched
    a second time — never relying on application logic alone to dedupe.
    """

    __tablename__ = "webhook_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    razorpay_event_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    event_type: Mapped[str] = mapped_column(String(60), nullable=False)
    payload_json: Mapped[str] = mapped_column(String(4000), nullable=False)
    processed_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)


class AuditLog(Base):
    """
    Append-only record of security-relevant events. Never updated or
    deleted by application code — rows are written once, at the moment of
    the action, in the same DB transaction as the action itself (so a
    rolled-back action never leaves behind a log entry claiming it
    happened). `workspace_id`/`trading_account_id`/`target_user_id` are
    nullable because not every action is scoped to all three (e.g. login
    has neither; creating an account has a workspace but no account yet).
    `metadata_json` is a small free-form string (JSON-encoded) for details
    that don't deserve their own column, e.g. which role was granted.
    """

    __tablename__ = "audit_logs"

    # Every FK here is ON DELETE SET NULL: an audit row must outlive the
    # thing it describes (deleting a trading account must not delete, or be
    # blocked by, the log entry that recorded its deletion). The id is also
    # captured in `metadata_json` so the row stays meaningful once the FK
    # value is nulled out.
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    workspace_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="SET NULL"), nullable=True, index=True
    )
    trading_account_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("trading_accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    target_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    metadata_json: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False, index=True)


class PasswordResetToken(Base):
    """
    Single-use, short-lived password reset token. Stored hashed the same way
    a password is — a leaked database dump must not hand out working reset
    links. `used_at` makes the token single-use even before it expires.
    """

    __tablename__ = "password_reset_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)


class Session(Base):
    """Server-side session record — logout/expiry deletes or ages out this row, which is what actually revokes access (not just clearing a client cookie)."""

    __tablename__ = "sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow, nullable=False)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime, nullable=False)

    user: Mapped["User"] = relationship(back_populates="sessions")
