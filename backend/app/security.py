from __future__ import annotations

import hashlib
import hmac
import secrets
from pathlib import Path

import bcrypt
from cryptography.fernet import Fernet, InvalidToken

from .config import settings
from .observability import tracked

# Local-dev fallback key file — gitignored, generated once on first run,
# never committed. This exists so no real encryption key ever has to be
# hardcoded in source (config.py's own default is intentionally NOT a
# usable key) while still giving local dev a stable key across restarts.
_LOCAL_KEY_FILE = Path(__file__).resolve().parent.parent / ".broker_encryption_key"


def _resolve_broker_key() -> bytes:
    configured = settings.broker_encryption_key.strip()
    if configured:
        return configured.encode("utf-8")

    if _LOCAL_KEY_FILE.exists():
        return _LOCAL_KEY_FILE.read_text(encoding="utf-8").strip().encode("utf-8")

    generated = Fernet.generate_key()
    _LOCAL_KEY_FILE.write_text(generated.decode("utf-8"), encoding="utf-8")
    return generated


@tracked("security.hash_password")
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


@tracked("security.verify_password")
def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        # Malformed/foreign hash — treat as a failed verification, never raise.
        return False


def generate_session_token() -> str:
    return secrets.token_urlsafe(32)


def generate_reset_token() -> str:
    return secrets.token_urlsafe(32)


def hash_reset_token(token: str) -> str:
    """
    SHA-256 (not bcrypt) on purpose: reset tokens are already 256 bits of
    server-generated entropy, so there's nothing to brute-force and the
    lookup needs to be a fast indexed equality match, not a per-row compare.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _fernet() -> Fernet:
    return Fernet(_resolve_broker_key())


@tracked("security.encrypt_secret")
def encrypt_secret(plaintext: str) -> str:
    """Encrypts a broker credential field for storage. Never call this with anything that will be logged."""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


@tracked("security.decrypt_secret")
def decrypt_secret(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        # Wrong/rotated key, or corrupted data — never surface ciphertext or key material in the error.
        raise ValueError("Could not decrypt stored broker credentials") from exc


@tracked("security.verify_razorpay_signature")
def verify_razorpay_payment_signature(order_id: str, payment_id: str, signature: str) -> bool:
    """
    Recomputes the HMAC-SHA256 Razorpay documents for order+payment
    verification, using the server-only key_secret. The frontend can hand
    us any three strings it likes after a checkout — this is what actually
    decides whether a payment is real, never the frontend's say-so.
    """
    expected = hmac.new(
        settings.razorpay_key_secret.encode("utf-8"), f"{order_id}|{payment_id}".encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def verify_razorpay_webhook_signature(raw_body: bytes, signature: str) -> bool:
    expected = hmac.new(settings.razorpay_webhook_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def mask_identifier(value: str) -> str:
    """e.g. 'A123456' -> '***3456' — enough for a human to recognize which account, never enough to use."""
    if len(value) <= 4:
        return "*" * len(value)
    return "*" * (len(value) - 4) + value[-4:]
