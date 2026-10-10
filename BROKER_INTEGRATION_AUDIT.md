# Broker Integration Audit — Trading Journal

Read-only architecture audit for adding broker trade-sync (Zerodha, Angel One, Upstox, Dhan) to
the **Personal Trading Journal**. No application code was changed to produce this document.

---

## 1. Existing Architecture Summary

**Frontend**: React 19 + TypeScript + Vite (`package.json`). Client-side persistence via
**Dexie 4** (IndexedDB wrapper, `src/database/db.ts`). Exports use `xlsx` and
`jspdf`/`jspdf-autotable`. Charts use `lightweight-charts`.

**Backend**: FastAPI (`backend/app/main.py`), SQLAlchemy models (`backend/app/models.py`),
session-cookie auth (`backend/app/deps.py`, `backend/app/security.py` — bcrypt password hashing,
`SameSite=None` cookies for cross-origin HTTPS per recent commit 004fcdf).

**Database**: SQLite in dev (`sqlite:///./journal_dev.db`, `backend/app/config.py:14`), Postgres
in prod via `psycopg` driver. **No Alembic** — schema is created via
`Base.metadata.create_all()` only. The one precedent for a post-deploy schema change is manual,
hand-rolled: `backend/app/main.py`'s `_ensure_payment_plan_columns()` (around line 44), which:
1. Inspects existing columns via `sqlalchemy.inspect(engine).get_columns("payments")`.
2. Runs portable `ALTER TABLE ... ADD COLUMN` (works on both SQLite and Postgres).
3. Backfills new columns on existing rows from a related table.
4. Is called unconditionally at startup (idempotent — checks `missing` columns first) from
   `main.py`'s startup path (~line 41).

Any new broker-sync columns/tables should follow this exact pattern (new tables are automatically
handled by `create_all`; new columns on existing tables need a sibling `_ensure_*_columns()`
function).

**Trading-account model**: Confirmed multi-account-per-user already exists —
`backend/app/models.py`: `TradingAccount` (line 148), `AccountMember` (line 185, unique on
`(trading_account_id, user_id)`), `AccountRole` enum (`OWNER`/`ADMIN`/`VIEWER`, line 22). Every
read/write on an account is gated through `require_account_member` (`backend/app/authz.py`), not
workspace membership.

---

## 2. Relevant Files & Responsibilities

### The two trade stores (see §3 for which one Personal mode uses)

| Store | File | Notes |
|---|---|---|
| Dexie (`trades` table) | `src/database/db.ts` (class `JournalDB`, line 59) | `Trade` type in `src/types/index.ts:18`. CRUD in `src/services/journalService.ts`. |
| Backend `Trade` model | `backend/app/models.py:231` | Explicitly labeled "Phase 10.1" in a docstring; exists only so a shared `TradingAccount` isn't an empty container for Viewers. CRUD in `backend/app/routers/trades.py`. |

### Frontend

- `src/types/index.ts` — `Trade` interface (id, accountId, tradeDate, segment, scriptName,
  reason, quantity, side, entryPrice, exitDate, exitPrice, status, grossPnl, netPnl, notes,
  createdAt, updatedAt, optional `instrument`).
- `src/database/db.ts` — Dexie schema, versions 1–3. V3 (line 86) adds `accountLinks` table
  (`AccountLinkRecord`: `localAccountId`, `backendAccountId`, `linkedAt`) — the opt-in
  Dexie↔backend link.
- `src/services/journalService.ts` — all Dexie CRUD (`getAccounts`, `getTrades`, `saveTrade`,
  `deleteTradeById`, `exportBackupBundle`/`importBackupBundle`). `saveTrade` (line 65) and
  `deleteTradeById` (line 74) each fire-and-forget call into `tradeSync.ts` after the local write.
- `src/workspace/tradeSync.ts` — the entire existing bridge between Dexie and the backend
  `Trade` API. Key functions: `syncTradeUpsert`/`syncTradeDelete` (best-effort, never throw, only
  act if `accountLinks` has an entry for that local account), `linkAccountForSharing` (uploads all
  existing local trades once via bulk-import, idempotent by id), `fetchRemoteOnlyAccountsWithTrades`
  (loads genuinely-remote-only accounts for `mode="view"`, never writes to Dexie),
  `fetchBusinessAccountWithTrades`/`saveBusinessTrade`/`deleteBusinessTrade` (Business mode —
  backend-only, zero Dexie involvement, documented explicitly at line 178-183).
- `src/workspace/LinkLocalAccountPanel.tsx` — OWNER-only UI to link/unlink a local Dexie account
  to a backend `TradingAccount` for sharing, calling `linkAccountForSharing`/
  `unlinkAccountFromSharing`.
- `src/workspace/ModeShell.tsx` — mode router: `mode === 'personal'` (line 36-38) renders
  `<App mode="personal" />` with no account filtering at all; `mode === 'view'` renders `<App
  mode="view" />` restricted to VIEWER-role shared accounts; otherwise renders `BusinessMode`.
- `src/App.tsx` — `isPersonal = mode === 'personal'` (line 242). `loadState()` (line 322-326):
  for personal mode, accounts/trades come **only** from `getAccounts()`/`getTrades()` (Dexie, via
  journalService) — never from the backend. `mode === 'view'`/`'business'` instead call into
  `tradeSync.ts`'s remote fetchers. Delete handler (line 833-842) branches: `mode === 'business'`
  → `deleteBusinessTrade` (backend only); else → `deleteTradeById` (Dexie, which itself
  best-effort syncs if linked).
- `src/workspace/api.ts` — `workspaceApi` HTTP client used by `tradeSync.ts`
  (`listTrades`/`createTrade`/`updateTrade`/`deleteTrade`/`bulkImportTrades`/`listAccounts`).

### Backend

- `backend/app/models.py` — `Trade` (line 231, fields mirror Dexie `Trade` 1:1 by design,
  `trade_date`/`exit_date` are `String(10)` — **plain `YYYY-MM-DD` strings, no time component**),
  `BrokerConnection` (line 268: `id`, `trading_account_id` [unique], `broker_name` default
  `"Angel One"`, `client_code_masked` plaintext-derived display mask only, `encrypted_api_key`,
  `encrypted_client_code`, `encrypted_pin`, `encrypted_totp_secret` — all `String(500)` Fernet
  ciphertext, plus `updated_by_user_id`/timestamps).
- `backend/app/routers/trades.py` — full CRUD + `POST .../trades/bulk-import`
  (`bulk_import_trades`, line 162): ADMIN+, idempotent by client-supplied `id` (skips rather than
  overwrites existing ids — "a real edit should go through PATCH, not a re-import", line 175).
  This is the **only** existing dedup/idempotency mechanism in the whole trade pipeline, and it's
  scoped to the one-time "enable sharing" import, not a recurring broker sync.
- `backend/app/routers/broker.py` — Angel One credential storage only. `GET
  .../broker-status` (VIEWER-readable, connection existence + masked code only), `PUT
  .../broker-credentials` (ADMIN+, full upsert/replace, never patches individual fields), `GET
  .../broker-credentials/reveal` (ADMIN+, the **only** place plaintext secrets ever leave the DB —
  docstring at line 94-100 explicitly states "the SmartAPI login itself still happens from the
  browser, matching the existing Angel One integration" — i.e. this is purely a credential vault,
  **no trade-import/sync logic of any kind exists here today**), `DELETE
  .../broker-credentials`. Every mutation is audited via `log_event`.
- `backend/app/security.py` — `encrypt_secret`/`decrypt_secret` (Fernet, symmetric),
  `mask_identifier` (keeps last 4 chars). Key resolution (`_resolve_broker_key`, line 20):
  `settings.broker_encryption_key` if set, else a gitignored local file
  `backend/.broker_encryption_key` (auto-generated once), else generate-and-persist. This is the
  exact pattern any new broker secret (Zerodha/Upstox/Dhan API keys, tokens) should reuse —
  one Fernet key, one `encrypt_secret`/`decrypt_secret` pair, never log plaintext.
- `backend/app/schemas.py` — `BrokerCredentialsUpsert`/`BrokerStatusOut`/
  `BrokerCredentialsRevealOut` (lines 320-351); `TradeCreate`/`TradeUpdate`/`TradeOut`/
  `TradeBulkImportRequest`/`TradeBulkImportOut` (lines 208-271).
- `backend/app/audit.py` — `AuditAction` string-constant class and `log_event()` helper. Already
  has `TRADE_CREATED`/`TRADE_UPDATED`/`TRADE_DELETED`/`TRADE_BULK_IMPORTED` and
  `BROKER_CREDENTIALS_SAVED`/`_REVEALED`/`_DELETED`. New broker-sync actions (e.g.
  `BROKER_TRADES_SYNCED`) should be added here following the same pattern — `log_event` just adds
  to the current session, committed together with the action it describes.

---

## 3. Current Account & Trade Data Flow — THE KEY FINDING

**There are two independent trade stores, and Personal mode uses only one of them.**

- **Dexie (IndexedDB, client-side)** is the sole read/write path for `mode === 'personal'`.
  `ModeShell.tsx` renders `<App mode="personal" />` with no backend account scoping at all, and
  inside `App.tsx`, `loadState()` only calls `getAccounts()`/`getTrades()` — both pure Dexie reads
  via `journalService.ts` — whenever `isPersonal` is true. All personal trade creates/edits/
  deletes go through `journalService.saveTrade`/`deleteTradeById`, which write to `db.trades`
  (Dexie) directly and unconditionally.

- **The backend `Trade` model/`/api/accounts/{id}/trades` endpoints are NOT used by Personal
  mode's primary read/write path.** They exist purely for the Business/multi-user sharing
  feature: `AccountMember`/`Invitation` let an OWNER share a `TradingAccount` with a VIEWER, and
  the backend `Trade` table is what that VIEWER actually reads (`mode === 'view'` and
  `mode === 'business'` in `App.tsx` both route through `tradeSync.ts`'s remote
  fetchers/`saveBusinessTrade`/`deleteBusinessTrade`, bypassing Dexie entirely).

- **The one bridge between them** is opt-in, additive, and best-effort, entirely inside
  `src/workspace/tradeSync.ts` + the Dexie `accountLinks` table (`db.ts` v3): an OWNER can "Enable
  sharing for this account" (`LinkLocalAccountPanel.tsx`) which (a) bulk-uploads existing Dexie
  trades to the backend once via `bulkImportTrades`, and (b) from then on, every
  `journalService.saveTrade`/`deleteTradeById` call (personal-mode writes!) *also* fires
  `syncTradeUpsert`/`syncTradeDelete` as a non-blocking, swallow-all-errors side effect, purely so
  a Viewer sharing that account sees real data. Dexie remains authoritative; if the backend is
  unreachable, nothing about the local save fails or waits.

**Implication for broker sync**: a broker-sync feature for the Personal Trading Journal must
write new trades into **Dexie** (via `journalService`/`db.trades`, so personal-mode's UI, exports,
and charts — all of which only ever read Dexie — see them), not into the backend `Trade` table.
If an account happens to be link-shared, the existing `syncTradeUpsert` fire-and-forget will also
(incidentally, best-effort) push broker-synced trades to the backend — a free side benefit, not a
requirement.

---

## 4. Existing Reusable Components

- **Encryption**: `backend/app/security.py` `encrypt_secret`/`decrypt_secret` (Fernet) +
  `_resolve_broker_key`'s key-resolution chain (configured → gitignored local file → auto-generate).
  Directly reusable for Zerodha/Upstox/Dhan secrets.
- **Credential-reveal pattern**: `routers/broker.py`'s `/broker-credentials/reveal` — ADMIN+-gated,
  single-purpose, audited, never cached — the template for any new broker's equivalent endpoint,
  if a given broker's auth also needs a browser-side step.
- **Audit logging**: `backend/app/audit.py` — `AuditAction` constants + `log_event()`, already has
  trade and broker-credential actions; trivially extensible.
- **Masking**: `security.mask_identifier` for displaying account/client codes safely.
- **Idempotent bulk-insert pattern**: `routers/trades.py::bulk_import_trades` — "skip if id already
  exists" — the closest existing precedent for broker-trade dedup logic, though it currently keys
  off client-generated UUIDs, not a broker execution/order id (see Risks).
- **Multi-account authorization**: `AccountMember`/`require_account_member` — not directly
  relevant to Personal mode (which has no backend-side authorization notion at all today) but
  relevant if broker-linked accounts are ever modeled server-side.

---

## 5. Missing Capabilities

- **No trade-import/sync logic exists anywhere today** beyond the Dexie↔backend sharing bridge
  described in §3, which is unrelated to any real broker. Zero code touches a broker's trade/order
  history API.
- **No broker credential storage for Zerodha, Upstox, or Dhan** — `BrokerConnection` only models
  Angel One (`broker_name` even defaults to `"Angel One"`), with Angel-specific fields (`pin`,
  `totp_secret`) that don't generalize cleanly to OAuth-token-based brokers like Zerodha Kite
  Connect or Upstox.
- **No broker-trade dedup/idempotency fields.** The only existing dedup is "same client-generated
  UUID" (bulk-import), which is meaningless for broker-fetched trades — a real sync needs to key
  off the broker's own order id / trade id / execution id, which no `Trade` row (Dexie or backend)
  currently has a column for.
- **No per-execution timestamp.** Both the Dexie `Trade.tradeDate`/`exitDate` and the backend
  `Trade.trade_date`/`exit_date` (`String(10)`) store **date only**, no time-of-day. Broker
  executions have exact timestamps (and timezone, typically IST) — representing them with
  date-only strings loses intraday ordering and makes same-day duplicate executions
  indistinguishable without a separate dedup key.
- **No sync-state/job tracking** (last-synced-at, in-progress flag, error history) for any broker
  connection.
- **Dexie-only broker credential experiment already exists and was deliberately abandoned**:
  `db.ts` has `brokerCredentials`/`cryptoKeys` tables (v2, lines 79-83) for a client-only
  Web-Crypto encrypted store, explicitly superseded by `BrokerConnection`
  (`models.py:268-278` docstring: "Replaces the earlier client-only Dexie/Web-Crypto approach...
  which the architecture plan flagged as not a real security boundary"). Any new broker credential
  storage should go server-side (`BrokerConnection`-style), not back into Dexie.

---

## 6. Risks

- **Duplicate imports**: with no broker-native dedup key, a re-sync (e.g. retried after
  failure, or re-running for an overlapping date range) will almost certainly create duplicate
  Dexie trades unless a new unique broker-order-id field + dedup check is added before any insert.
- **No existing idempotency key for recurring sync** — the bulk-import idempotency (by row UUID)
  only helps the one existing "upload once" flow; it does not help a scheduled/repeated broker
  sync, which needs its own idempotency semantics (broker order id, not Dexie-generated UUID).
- **Timezone/time-of-day gap**: `trade_date`/`exit_date` as bare 10-char date strings (both
  stores) cannot hold execution time. Any broker-sync design needs to decide whether to (a) extend
  the schema with a true timestamp column, (b) store time-of-day only in `notes`/a new
  JSON-ish field, or (c) accept date-only granularity and rely on the new dedup key alone to avoid
  double-counting same-day fills. This affects Dexie's schema (needs a new `version(4)` bump,
  additive per existing convention) and the backend's (needs a new `_ensure_*_columns()` migration
  following the `payments` precedent) if touched.
- **Multiple accounts per user already supported** → broker-sync needs an explicit
  account-mapping step (which local Dexie `Account` does a given broker login's trades belong to),
  analogous to `LinkLocalAccountPanel`'s manual link, not an assumption of "the one account."
- **P&L recompute correctness**: `journalService.toTradeFromDraft`/`src/utils/tradeMath.ts`
  (`calculateTradeStatus`, `computePnl`) compute `grossPnl`/`netPnl` client-side at save time from
  side/qty/entry/exit price. Broker-synced trades must run through the same calculation (or import
  broker-reported P&L and trust it) — inconsistency here would silently corrupt analytics/exports
  that assume `grossPnl`/`netPnl` are always self-consistent with the other fields.
- **Best-effort sync swallowing errors**: the existing `syncTradeUpsert`/`syncTradeDelete` pattern
  deliberately never surfaces failures to the user (by design, to protect local-first UX). A new
  broker-sync feature needs its *own* visible success/failure/partial-import reporting — it cannot
  silently fail the way the existing Dexie→backend bridge does, since here the import *is* the
  primary user-facing action.

---

## 7. Recommended Minimal-Change Architecture (for review, not final)

1. **New Dexie table** (`db.ts` version(4), additive only): e.g. `brokerConnections` (per local
   Account: broker name, encrypted tokens/credentials — client-only brokers like Zerodha/Upstox
   that use OAuth redirect flows may be fine stored client-side if the token is short-lived; for
   anything resembling Angel One's long-lived secrets, prefer the server-side `BrokerConnection`
   pattern instead, keyed to a `trading_account_id` the way `LinkLocalAccountPanel` already links
   local accounts to backend ones).
2. **New Dexie field on `Trade`** (or a lightweight linked table) for `brokerOrderId`/
   `brokerExecutionId` (string, optional) + `source: 'manual' | 'broker-sync'` — the dedup key the
   bulk-import pattern lacks today. Add a Dexie index on it for fast "does this execution already
   exist" lookups before insert.
2b. Consider adding real timestamp capture (even if only on the new broker-sync fields, leaving
   legacy `tradeDate`/`exitDate` untouched) to avoid the date-string time-of-day gap.
3. **New sync module** mirroring `tradeSync.ts`'s shape but for broker→Dexie (not Dexie→backend):
   fetch broker executions → map to `Trade` shape (reusing `toTradeFromDraft`/`computePnl` logic
   for consistency) → dedup by `brokerOrderId` against existing Dexie trades for that account →
   `journalService.saveTrade` for new ones only. Keep it visible/awaited (not fire-and-forget like
   the existing sync bridge), since here it's the primary action, with explicit
   imported/skipped/failed counts shown to the user (same shape as `linkAccountForSharing`'s
   return value).
4. **Credential storage**: for Angel One, extend/reuse `BrokerConnection`; for Zerodha/Upstox/Dhan,
   either generalize `BrokerConnection` (make Angel-specific fields nullable, add a `credentials_json`
   encrypted blob for broker-specific shapes) or add parallel per-broker tables — a call best made
   once the specific auth flow of each broker is known (explicitly out of scope here).
5. **Migration**: any new backend columns/tables follow the `_ensure_payment_plan_columns`
   pattern (new `_ensure_broker_sync_columns()` in `main.py`, called at startup, portable
   `ALTER TABLE`, idempotent column-existence check).
6. **Audit**: add `BROKER_TRADES_SYNCED`/`BROKER_SYNC_FAILED` to `AuditAction`, log via existing
   `log_event()` only if any backend-side broker-sync component is introduced (not needed for a
   purely client-side Dexie-only sync).

---

## 8. Proposed Test Strategy

- **Frontend (vitest)**: unit tests for the new dedup logic (given existing Dexie trades with
  `brokerOrderId`s, a fetched execution list with overlaps → correct imported/skipped counts),
  and for the broker-execution→`Trade` mapping function, following existing patterns in
  `src/utils/tradeMath.ts`'s test coverage (if present) or `journalService.ts` test patterns.
- **Backend (pytest, `backend/tests/`)**: if any server-side component is added (new
  `BrokerConnection`-style credential table, or a backend-side sync endpoint), follow
  `backend/tests/conftest.py`'s existing fixtures — a fresh in-memory SQLite engine per test
  (`db_engine`), `TestClient` with `get_db` overridden (`client` fixture) — same shape as
  `test_broker_credentials.py` and `test_trades.py`, which already cover ADMIN/VIEWER role
  gating and encrypted-field round-tripping; new broker-type tests should mirror those directly
  (role gating, audit log assertions, idempotent-import assertions analogous to the existing
  bulk-import idempotency test in `test_trades.py`).
- **Manual/integration**: dev run via `backend/.venv/Scripts/python.exe -m uvicorn app.main:app
  --reload --port 8000` from `backend/` (requires `backend/.env`), `npm run dev` for the frontend,
  then exercise Personal mode's new sync action end-to-end against a sandbox/test broker account
  before any real-money account.

---

## 9. Exact Files Likely to Be Touched (proposal only — not yet changed)

- `src/database/db.ts` — new Dexie version bump (broker connections table, optional `Trade` dedup
  fields/index).
- `src/types/index.ts` — optional `brokerOrderId`/`source` fields on `Trade`.
- `src/services/journalService.ts` — no change needed if sync writes go through existing
  `saveTrade`; may want a `saveTradesBulk` helper for sync-time batch inserts.
- New file, e.g. `src/services/brokerSync/<broker>Sync.ts` (or `src/workspace/brokerSync.ts`) —
  the fetch → map → dedup → save pipeline per §7.
- `src/workspace/` — new UI component for "Connect broker" / "Sync now" in Personal mode (separate
  from the existing Business-mode `LinkLocalAccountPanel.tsx`, which is a different feature).
- `backend/app/models.py` — only if server-side credential storage for new brokers is added
  (extend/parallel to `BrokerConnection`).
- `backend/app/routers/broker.py` or a new `backend/app/routers/broker_sync.py` — only if a
  server-side component (e.g. OAuth token exchange that can't happen purely client-side) is
  needed per broker.
- `backend/app/main.py` — new `_ensure_*_columns()` if any existing table gains columns.
- `backend/app/audit.py` — new `AuditAction` constants if any backend component is added.
- `backend/tests/test_broker_credentials.py` / new `test_broker_sync.py` — if backend components
  are added.

---

## 11. Broker-by-Broker API Findings (external research, official docs)

Researched against each broker's official developer documentation. Cells marked **UNVERIFIED**
could not be confirmed from an official source in this pass and must be checked by a developer
with API access before being relied on.

| | **Zerodha – Kite Connect** | **Angel One – SmartAPI** | **Upstox – API v2** | **Dhan – DhanHQ v2** |
|---|---|---|---|---|
| Docs | kite.trade/docs/connect/v3 | smartapi.angelone.in (JS-rendered, mostly unverifiable here) | upstox.com/developer/api-documentation | dhanhq.co/docs/v2 |
| Auth flow | OAuth-like: browser login → `request_token` → checksum exchange → `access_token` | API key + client code + PIN + TOTP → JWT + refresh token | OAuth2: browser login (TOTP) → code → token exchange | JWT via web console; exact flow UNVERIFIED |
| Token lifetime | Expires daily ~6 AM; general-purpose refresh token NOT available to typical third-party apps | UNVERIFIED exact hours; official forum says re-login required daily | ~3:30 AM daily expiry (community-corroborated); a longer-lived "extended" read-only token is referenced but not independently confirmed | UNVERIFIED |
| Trades endpoint | `GET /trades` — current day only | `tradeBook` (current day only, confirmed via official forum) | current-day trades endpoint **+** `GET /v2/charges/historical-trades` | `GET /v2/trades` — current day only |
| **Historical (past-day) trades** | **No** — current trading day only | **No** — current trading day only (Angel One staff confirmed) | **Yes** — `historical-trades` endpoint, date range, up to 3 financial years back | **No** — current trading day only |
| Rate limits | ~10 req/s general, 3 req/s historical, 1 req/s quotes | UNVERIFIED | ~10 req/s / 250/min / 7,000/day (approx, community) | Order 10/s, Data 5/s, Quote 1/s, 7,000 orders/day |
| Cost | Paid ₹500/month (free "Personal" tier covers orders/trades, no market data) | UNVERIFIED (widely reported free, not confirmed here) | Free API access; brokerage is separate | No API fee found; unrelated one-time ₹100 DDPI fee |
| Unattended daily sync feasible? | **No** — daily manual re-auth required | **No** — daily manual re-auth required | **Partially** — only if the long-lived extended token (unverified) applies to trade data | UNVERIFIED |

**The one fact that should drive the design**: of the four, only **Upstox** has a confirmed,
documented endpoint for retrieving trades from past days. Zerodha, Angel One, and Dhan only expose
the **current trading day's** executed trades — there is no "catch-up" API for any of them if a
sync is missed. This means for those three brokers, "Sync Trades" must run (or be clicked) on or
before each trading day ends, or that day's fills are permanently unavailable via the API — a CSV
fallback import is the only way to backfill missed days for Zerodha/Angel/Dhan.

Also: none of the four brokers supports indefinite unattended cron sync without either a
broker-approved long-lived token (Zerodha's restricted `refresh_token`, Upstox's unconfirmed
extended token) or a daily manual re-login step. Scheduled sync should be scoped accordingly —
see §8 Recommended minimal-change architecture.
