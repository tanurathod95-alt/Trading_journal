from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)
    display_name: str = Field(min_length=1, max_length=120)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ForgotPasswordOut(BaseModel):
    """
    Deliberately identical whether or not the email exists — never confirm
    which addresses have accounts. `dev_reset_token` is populated ONLY in
    local development (no email provider configured yet) so the flow is
    testable end-to-end; it is null once an email sender is wired up.
    """

    message: str
    dev_reset_token: str | None = None


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=200)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


class UpdateProfileRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str
    created_at: dt.datetime

    model_config = {"from_attributes": True}


class WorkspaceOut(BaseModel):
    id: str
    name: str
    plan: str
    role: str
    created_at: dt.datetime


class MeOut(BaseModel):
    user: UserOut
    workspaces: list[WorkspaceOut]


class PlanLimitsOut(BaseModel):
    max_trading_accounts: int | None
    max_members_per_account: int | None


class WorkspacePlanOut(BaseModel):
    plan: str
    limits: PlanLimitsOut
    trading_accounts_used: int


class WorkspacePlanUpdate(BaseModel):
    plan: str = Field(pattern="^(FREE|PRO|PREMIUM|BUSINESS)$")


class TradingAccountCreate(BaseModel):
    workspace_id: str
    name: str = Field(min_length=1, max_length=200)
    broker_name: str = Field(default="", max_length=120)
    account_type: str = Field(default="Trading", max_length=60)


class TradingAccountUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    broker_name: str | None = Field(default=None, max_length=120)
    account_type: str | None = Field(default=None, max_length=60)
    is_archived: bool | None = None
    portfolio_id: str | None = None


class TradingAccountOut(BaseModel):
    id: str
    workspace_id: str
    portfolio_id: str | None
    name: str
    broker_name: str
    account_type: str
    is_archived: bool
    role: str
    created_at: dt.datetime
    updated_at: dt.datetime


class PortfolioCreate(BaseModel):
    workspace_id: str
    name: str = Field(min_length=1, max_length=200)
    client_display_name: str | None = Field(default=None, max_length=200)


class PortfolioUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    client_display_name: str | None = Field(default=None, max_length=200)


class PortfolioOut(BaseModel):
    id: str
    workspace_id: str
    name: str
    client_display_name: str | None
    role: str
    account_count: int
    created_at: dt.datetime


class AddPortfolioMemberRequest(BaseModel):
    email: EmailStr
    role: str = Field(pattern="^(ADMIN|VIEWER)$")


class PortfolioMemberOut(BaseModel):
    id: str
    user_id: str
    email: str
    display_name: str
    role: str
    granted_at: dt.datetime


class PortfolioInvitationCreate(BaseModel):
    email: EmailStr
    role: str = Field(pattern="^(ADMIN|VIEWER)$")


class PortfolioInvitationOut(BaseModel):
    id: str
    portfolio_id: str
    email: str
    role: str
    status: str
    invited_by_email: str
    created_at: dt.datetime
    expires_at: dt.datetime
    is_expired: bool


class MyPortfolioInvitationOut(BaseModel):
    id: str
    portfolio_id: str
    portfolio_name: str
    client_display_name: str | None
    role: str
    invited_by_email: str
    created_at: dt.datetime
    expires_at: dt.datetime


class AddAccountMemberRequest(BaseModel):
    email: EmailStr
    role: str = Field(pattern="^(ADMIN|VIEWER)$")


class AccountMemberOut(BaseModel):
    id: str
    user_id: str
    email: str
    display_name: str
    role: str
    granted_at: dt.datetime


class InvitationCreate(BaseModel):
    email: EmailStr
    role: str = Field(pattern="^(ADMIN|VIEWER)$")


class InvitationOut(BaseModel):
    id: str
    trading_account_id: str
    email: str
    role: str
    status: str
    invited_by_email: str
    created_at: dt.datetime
    expires_at: dt.datetime
    is_expired: bool


class TradeCreate(BaseModel):
    id: str | None = None  # allowed so bulk-import can preserve the client-generated Dexie id
    trade_date: str
    segment: str = Field(max_length=40)
    script_name: str = Field(min_length=1, max_length=120)
    reason: str = Field(default="", max_length=500)
    quantity: float = 0
    side: str = Field(pattern="^(BUY|SELL)$")
    entry_price: float = 0
    exit_date: str | None = None
    exit_price: float = 0
    status: str = Field(default="OPEN", max_length=20)
    gross_pnl: float = 0
    net_pnl: float = 0
    notes: str = Field(default="", max_length=5000)
    instrument_json: str | None = Field(default=None, max_length=2000)


class TradeUpdate(BaseModel):
    trade_date: str | None = None
    segment: str | None = Field(default=None, max_length=40)
    script_name: str | None = Field(default=None, min_length=1, max_length=120)
    reason: str | None = Field(default=None, max_length=500)
    quantity: float | None = None
    side: str | None = Field(default=None, pattern="^(BUY|SELL)$")
    entry_price: float | None = None
    exit_date: str | None = None
    exit_price: float | None = None
    status: str | None = Field(default=None, max_length=20)
    gross_pnl: float | None = None
    net_pnl: float | None = None
    notes: str | None = Field(default=None, max_length=5000)
    instrument_json: str | None = Field(default=None, max_length=2000)


class TradeOut(BaseModel):
    id: str
    trading_account_id: str
    trade_date: str
    segment: str
    script_name: str
    reason: str
    quantity: float
    side: str
    entry_price: float
    exit_date: str | None
    exit_price: float
    status: str
    gross_pnl: float
    net_pnl: float
    notes: str
    instrument_json: str | None
    created_at: dt.datetime
    updated_at: dt.datetime


class TradeBulkImportRequest(BaseModel):
    trades: list[TradeCreate] = Field(max_length=5000)


class TradeBulkImportOut(BaseModel):
    imported: int
    skipped_existing: int


class PlanPricingOut(BaseModel):
    name: str
    price_monthly_paise: int
    price_quarterly_paise: int
    price_yearly_paise: int
    max_trading_accounts: int | None
    max_members_per_account: int | None


class BillingStatusOut(BaseModel):
    plan: str
    subscription_status: str | None
    billing_cycle: str | None
    current_period_end: dt.datetime | None
    trading_accounts_used: int
    max_trading_accounts: int | None


class CheckoutRequest(BaseModel):
    plan_name: str = Field(pattern="^(FREE|PRO|PREMIUM|BUSINESS)$")
    billing_cycle: str = Field(pattern="^(MONTHLY|QUARTERLY|YEARLY)$")


class CheckoutOut(BaseModel):
    order_id: str
    key_id: str
    amount_paise: int
    currency: str
    subscription_id: str


class VerifyPaymentRequest(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


class PaymentOut(BaseModel):
    id: str
    created_at: dt.datetime
    plan_name: str | None
    billing_cycle: str | None
    amount_paise: int
    status: str
    razorpay_payment_id: str


class BrokerCredentialsUpsert(BaseModel):
    broker_name: str = Field(default="Angel One", max_length=60)
    api_key: str = Field(min_length=1, max_length=200)
    client_code: str = Field(min_length=1, max_length=60)
    pin: str = Field(min_length=1, max_length=60)
    totp_secret: str = Field(min_length=1, max_length=200)


class BrokerStatusOut(BaseModel):
    """
    Safe for any account member (VIEWER included) — no secret material, no
    raw client code, just enough to render a dashboard card.
    """

    is_connected: bool
    broker_name: str | None
    masked_client_code: str | None
    updated_at: dt.datetime | None


class BrokerCredentialsRevealOut(BaseModel):
    """
    OWNER/ADMIN only, and only via the explicit /reveal endpoint — never
    returned by the status/list endpoints. Fetching this is itself an
    audited action (see AuditAction.BROKER_CREDENTIALS_REVEALED).
    """

    broker_name: str
    api_key: str
    client_code: str
    pin: str
    totp_secret: str


class AuditLogOut(BaseModel):
    id: str
    action: str
    user_email: str | None
    target_user_email: str | None
    trading_account_id: str | None
    metadata: dict | None
    ip_address: str | None
    created_at: dt.datetime


class MyInvitationOut(BaseModel):
    id: str
    account_id: str
    account_name: str
    broker_name: str
    role: str
    invited_by_email: str
    created_at: dt.datetime
    expires_at: dt.datetime


class UpstoxExchangeTokenRequest(BaseModel):
    code: str
    client_id: str
    redirect_uri: str


class UpstoxTokenOut(BaseModel):
    access_token: str


class ZerodhaExchangeTokenRequest(BaseModel):
    request_token: str
    api_key: str


class ZerodhaTokenOut(BaseModel):
    access_token: str


class DhanTradesRequest(BaseModel):
    access_token: str
