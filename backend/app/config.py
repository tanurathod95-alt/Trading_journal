from __future__ import annotations

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="JOURNAL_", extra="ignore")

    # SQLite for local dev (Phase 1). Swapping to Postgres later is a
    # one-line change here — nothing else in the backend is SQLite-specific
    # except the PRAGMA foreign_keys hook in database.py, which is a no-op
    # for any non-SQLite URL.
    database_url: str = "sqlite:///./journal_dev.db"

    @field_validator("database_url", mode="before")
    @classmethod
    def _strip_database_url(cls, value: object) -> object:
        # Hosting dashboards (Render's env var box included) sometimes carry
        # a trailing newline/space through a copy-paste, which silently
        # corrupts the DB name (e.g. "mydb\n") and the connection fails with
        # a confusing "database does not exist" error. Stripping here means
        # that class of mistake can never break startup.
        return value.strip() if isinstance(value, str) else value

    session_cookie_name: str = "journal_session"
    session_ttl_hours: int = 24 * 7
    invitation_ttl_days: int = 7
    password_reset_ttl_minutes: int = 60

    # No email provider is wired up yet, so /auth/forgot-password returns the
    # reset token directly in its response for local development. This MUST
    # be False in any real deployment — it would otherwise hand a password
    # reset to anyone who knows an email address.
    expose_reset_token_in_response: bool = True

    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # Must stay False on plain http://localhost — browsers silently drop
    # Secure cookies on non-HTTPS origins, which would break local login.
    # Set True only once this is served over real HTTPS.
    cookie_secure: bool = False

    # Symmetric key (Fernet, urlsafe-base64, 32 raw bytes) used to encrypt
    # broker credentials at rest (Phase 7). Deliberately blank by default —
    # no real usable key is ever hardcoded in source control. If left unset,
    # security.py auto-generates one on first run and stores it in a
    # gitignored local file (backend/.broker_encryption_key) so it's stable
    # across restarts without ever being committed. Set this explicitly via
    # JOURNAL_BROKER_ENCRYPTION_KEY for anything beyond local dev.
    broker_encryption_key: str = ""

    # Razorpay — TEST MODE ONLY. Real values are supplied via backend/.env
    # (gitignored, never committed) — these class defaults are safe
    # placeholders that make no real API calls succeed, so a checkout
    # attempted without a configured .env fails loudly instead of silently
    # hitting a real account. Never sent to the frontend except key_id,
    # which Razorpay's own Checkout.js requires to be public.
    razorpay_key_id: str = "rzp_test_placeholder"
    razorpay_key_secret: str = "placeholder_secret"
    razorpay_webhook_secret: str = "placeholder_webhook_secret"

    # Upstox OAuth2 client secret (broker trade-sync, Phase 2). The `client_id`
    # is not secret and is entered client-side by the user in Settings; only
    # the secret needs to live here, since Upstox's authorization-code token
    # exchange requires it and it must never reach frontend JS. Blank default
    # — set via backend/.env as JOURNAL_UPSTOX_CLIENT_SECRET.
    upstox_client_secret: str = ""

    # Zerodha Kite Connect checksum secret (broker trade-sync, Phase 4). Same
    # shape as upstox_client_secret: api_key isn't secret and is entered
    # client-side; only the api_secret used in the SHA-256 checksum needs to
    # live here. Blank default — set via backend/.env as JOURNAL_ZERODHA_API_SECRET.
    zerodha_api_secret: str = ""


settings = Settings()
