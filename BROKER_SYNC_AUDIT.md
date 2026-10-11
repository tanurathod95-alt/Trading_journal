# Broker Sync Audit (read-only)

Status: **Audit and plan only. No application code has been changed.** Scope: Angel One, Zerodha, Upstox, Dhan. FYERS is explicitly out of scope for now.

Verification legend: **[V]** = checked against the broker's official docs during this audit; **[U]** = not verified here (do not rely on it without a real account/docs check).

---

## 1. Current architecture (what exists today)

| Area | Finding |
|---|---|
| Frontend | React 19 + TS + Vite PWA. Product lives under `/app/*`; `src/App.tsx` (~4,000 lines) holds the journal, all broker UI and all sync handlers. |
| Personal-mode data | **Dexie/IndexedDB is the source of truth** (`src/database/db.ts`, v4). Tables: `accounts`, `trades`, `settings`, `attachments`, `brokerCredentials`, `cryptoKeys`, `instrumentCache`, `accountLinks`. |
| Backend | FastAPI + SQLAlchemy (SQLite dev). Has a server-side `Trade` table, but it is used only for sharing (opt-in push from Dexie via `workspace/tradeSync.ts`) and Business mode. |
| Broker sync | Frontend-only, one adapter per broker under `src/services/brokerSync/`, all feeding one shared `matchFills()`. Backend is involved only for Upstox/Zerodha token exchange (needs a secret) and the Dhan CORS proxy. |
| Trade model | `Trade` (`src/types/index.ts`): one row = one *round trip* (entry + exit), not one fill. Optional `brokerTradeId`, `brokerExitTradeId`, `source: 'manual' \| 'broker-sync'`. Existing manual trades have `source` undefined. |
| Manual trades | Created/edited through `journalService.saveTrade` -> Dexie, then best-effort mirrored to backend if the account is linked. |
| P&L | `utils/tradeMath.ts` (`computePnl`, `calculateTradeStatus`). Broker sync sets `netPnl = grossPnl` (no charges). |
| Import / export | Export: CSV, XLSX, PDF (App.tsx ~1428). Import: **JSON backup restore only** (`handleImport`, App.tsx:1328). **No CSV/Excel tradebook import exists.** `xlsx` is already a dependency. |
| Credentials | Angel One: AES-GCM in Dexie (key also in Dexie; client-side only, not an XSS defence) and an optional server-side Fernet `BrokerConnection`. Dhan: same client-side store. Upstox/Zerodha: only public id/api_key stored; access tokens held in React state (memory). Client/api secrets live in backend env (`JOURNAL_UPSTOX_CLIENT_SECRET`, `JOURNAL_ZERODHA_API_SECRET`). |
| Dedup today | `matchFills` builds a set of `brokerTradeId`/`brokerExitTradeId` from existing trades and skips fills already seen. Backend `bulk-import` dedups by trade `id` only. |
| Sync jobs | None. Sync is a manual button per broker. |
| Tests | Backend: 120 pytest pass. Frontend: 38 vitest pass, `tsc -b` clean. **Zero tests cover brokerSync, matchFills, or any broker router.** |

## 2. Broker API capabilities (official docs)

| | Angel One | Zerodha Kite | Upstox | Dhan |
|---|---|---|---|---|
| Tradebook (today) | `GET .../order/v1/getTradeBook` [U field list] | `GET /trades` [V] | `GET /v2/order/trades/get-trades-for-day` [V] (repo comment calling this "unconfirmed" is outdated) | `GET /v2/trades` [V] |
| Trades of one order | - | `GET /orders/:id/trades` [V] | `GET /v2/order/trades` (by order_id) [V] | `GET /v2/trades/{order-id}` [V] |
| Order book | `getOrderBook` [U fields]; rate limit 1/s reported on SmartAPI forum | `GET /orders` [V] | order-retrieve endpoint [U] | `GET /orders` [V], statuses TRANSIT/PENDING/REJECTED/CANCELLED/PART_TRADED/TRADED/EXPIRED, has `filledQty`, `averageTradedPrice`, `omsErrorDescription` |
| Positions | `getPosition` [U fields] | `GET /portfolio/positions` -> `net` + `day` arrays [V] | positions endpoint [U] | positions endpoint [U] |
| Holdings | `getHolding` [U] | `GET /portfolio/holdings` [V] | [U] | [U] |
| **Historical executed trades** | **No** (current day only; prior audit cites Angel staff, not re-verified here) | **No** (day-scoped; use Console tradebook CSV) | **Yes** `GET /v2/charges/historical-trades`, params `start_date`,`end_date`,`segment`(EQ/FO/COM/CD/MF),`page_number`(from 1),`page_size`(1-5000); last 3 financial years [V] | **Yes** `GET /v2/trades/{from-date}/{to-date}/{page}` (page starts 0), paginated, **includes charges** [V] |
| Charges in trade rows | [U] | not in trade object [V] | not in either trades endpoint [V] | Historical endpoint only: `brokerageCharges`, `stt`, `sebiTax`, `serviceTax`, `exchangeTransactionCharges`, `stampDuty` [V] |
| Trade id | `tradeid` [U] | `trade_id` [V] | `trade_id` [V] | `exchangeTradeId` [V] |
| Quantity field | `fillsize` [U] | `quantity` in samples, `filled` in attribute table - docs inconsistent [V] | `quantity` [V] | `tradedQuantity` [V] |
| Auth / token life | API key + client code + PIN + TOTP -> JWT; re-login needed daily [U exact hours] | request_token -> checksum -> access_token; expires daily ~6 AM [V from earlier audit] | OAuth2; expires ~3:30 AM daily [U] | JWT from web console; lifetime [U] |
| Cost | [U] | Personal plan free (orders/trades/positions, **no market data**); Connect ₹500/mo | free API [U] | no API fee found [U] |

**Correction to the existing repo documentation:** `BROKER_INTEGRATION_AUDIT.md` and the Dhan code comments say Dhan is "current trading day only". The official Dhan Statements page documents a paginated, date-range **Trade History** endpoint with charges. Dhan therefore supports historical import, and the current implementation does not use it.

## 3. Risks and defects found in the existing sync code

Ordered by severity. Each is a concrete finding in current code, not a guess.

1. **Broker sync can modify manual trades (violates the "never overwrite manual trades" rule).** `matchFills` Step 1 closes *any* OPEN trade for the same account+symbol+segment, including manually entered ones, and returns it in `updatedTrades`, which the handlers then `saveTrade()` over the original. A broker SELL can silently set exit price/date/P&L on a manual BUY.
2. **Non-atomic persistence breaks idempotency.** Handlers loop `for (trade of [...newTrades, ...updatedTrades]) await saveTrade(trade)` (App.tsx ~970, 1020, 1073, 1119): no transaction. If it stops midway (tab closed, quota, error), some rows are saved and others not. On the next run a fill whose id was never recorded on a saved trade is re-processed against the already-saved remainder, which can double-close or mis-split positions.
3. **Dedup lives only on derived trades, not on a fill ledger.** There is no record of "fill X was imported" independent of the Trade rows; `brokerTradeId`/`brokerExitTradeId` are plain (non-unique) Dexie indexes. Deleting or editing a synced trade makes its fills importable again (re-creating deleted trades). Two tabs syncing at once can both pass the check (no lock).
4. **Partial-close remainder inherits the original `brokerTradeId`** (`...openTrade` spread), so two trades carry the same entry fill id; fills are therefore not individually traceable.
5. **Dhan fill id falls back to `orderId`** (`exchangeTradeId || orderId`). Several partial fills of one order would share an id, and all but the first would be skipped as "already synced" (silent loss of fills).
6. **Upstox historical backfill fetches only page 1 of size 500** (`upstoxApi.ts`). Active accounts over 90 days will silently lose rows. The API supports `page_size` up to 5000 and returns `total_pages`.
7. **Dates are converted with `toISOString()` (UTC).** An IST timestamp without an offset, or one parsed as local time, can land on the wrong calendar day. No timezone is stored. Angel One's `exchtime`/`filltime` format is [U]; `new Date()` may not parse it at all and falls back to *today's date*, silently mis-dating a fill.
8. **Charges are never captured**; `netPnl = grossPnl` for every synced trade, so synced P&L disagrees with broker P&L.
9. **No order book, positions or holdings** are fetched anywhere. Nothing prevents (by design) rejected/pending orders from entering, because orders are not read at all.
10. **No sync-run record** (start/end, imported/skipped/failed). "Last sync" is a localStorage timestamp that is written even when some saves failed.
11. **Backend mirror drops provenance.** `toUpsertPayload` omits `brokerTradeId`, `brokerExitTradeId`, `source`; backend `Trade` has no such columns. Linked accounts lose broker provenance on the server copy.
12. **First-row `console.debug` of raw broker rows** (all four brokers) can include client ids (e.g. `dhanClientId`) and order ids in the browser console. Low severity but contradicts the no-sensitive-logs rule.
13. **Segment inference is a heuristic** for Angel One/Zerodha (symbol ends with CE/PE). Upstox/Dhan use real API fields.
14. **Zerodha `api.kite.trade` called directly from the browser**: whether it allows CORS is [U]. If not, Zerodha sync fails in the browser and needs the backend proxy pattern already used for Dhan.
15. **Zero automated tests** for any of the above.

## 4. Proposed minimal implementation plan (needs your approval)

Principle: keep Dexie as the personal-mode source of truth, keep `matchFills` as the trade-derivation logic, make additive Dexie changes only (v5), and leave the backend untouched unless a decision below requires it.

### P1. Executed-fill ledger + atomic persistence (fixes risks 2, 3, 4, 5)
- New Dexie table `brokerFills`, primary key `"{broker}:{accountId}:{fillId}"`. A unique primary key makes "already imported" an atomic database guarantee, and survives deleting/editing a derived trade.
- Fields only from real API data: broker, accountId, fillId, orderId, exchangeOrderId, exchange, symbol, instrument id, segment, side, qty, price, executedAt (ISO with offset when the API gives one, else date + flagged "no tz"), product, charges (when provided), `importedAt`, `source` (`api` or `csv`).
- Persist `brokerFills` + `trades` writes in **one Dexie transaction**. A failed sync leaves nothing half-written; re-running is safe.
- Fill id: use the broker trade/exec id; if absent, composite `orderId + qty + price + timestamp`, documented, and never `orderId` alone.
- Add an in-flight lock per broker+account so concurrent syncs cannot overlap.

### P2. Manual-trade protection (fixes risk 1)
- Only trades with `source === 'broker-sync'` may be auto-updated by `matchFills`.
- If a broker fill *could* close a manual open trade (same account/symbol/side opposite, qty fits), do **not** modify it; record a "possible match" for the user to review (Dexie `syncReviews` table, shown in the sync panel). Extend `Trade.source` with `'csv-import'`.

### P3. Sync run log (fixes risk 10)
- Dexie table `syncRuns`: broker, accountId, kind (api/csv), start, end, status (success/partial/failed), imported, skipped duplicates, failed, error message (sanitized). UI shows last *successful* sync from here, not from localStorage.

### P4. Orders and positions as separate, read-only data (fixes risk 9)
- Tables `brokerOrders` and `brokerPositions` (snapshots replaced per sync, never converted into trades, never touching `trades`). Orders that are pending/rejected/cancelled/unfilled are stored as orders only. Order-book `filledQty` is used only to *cross-check* tradebook totals and warn on mismatch.
- Initial coverage = endpoints marked [V] above (Zerodha orders/positions/holdings, Dhan orders). Angel One and Upstox orders/positions are implemented only after their official docs are checked (items [U]).

### P5. Historical import per broker (fixes risks 6, plus the Dhan doc error)
- Upstox: paginate historical-trades using `total_pages`, `page_size` 5000, respect the 3-financial-year limit.
- Dhan: add backend proxy route for `/v2/trades/{from}/{to}/{page}` (Dhan rejects browser CORS), paginate, capture charges.
- Angel One, Zerodha: no API history -> CSV fallback (P6). UI states this limitation plainly.

### P6. CSV/Excel tradebook importer (extends the existing import area, does not replace JSON restore)
- Parse with the already-installed `xlsx` lib (CSV and XLSX), client-side.
- Column mapping UI with saved mappings; built-in presets **only** for formats you give me a real sample file of (I will not invent official Zerodha/Angel One column names).
- Mandatory preview: valid / invalid / duplicate / warning rows with row-level reasons; nothing written until the user confirms; cancel anywhere.
- Rows go through the same `brokerFills` ledger (dedup key = fill id if the file has one, else the documented composite), so re-uploading the same file creates zero new rows.

### P7. Hardening
- Fix date handling (store executed-at with timezone; derive trade date in IST).
- Capture charges where the API provides them; leave `netPnl = grossPnl` and mark "charges not available" otherwise (no fabricated charges).
- Remove raw-row `console.debug`.
- Keep existing token/secret handling; no secrets move to the frontend.

### P8. Tests (mocked broker responses only, no live accounts, no orders)
Frontend (vitest): the 14 scenarios in your spec, concretely: import, repeated sync = 0 new, partial fills, pending order excluded, positions not imported as trades, malformed fields, expired auth message, API/rate-limit error leaves data intact, CSV preview valid/invalid, CSV re-import = 0 new, manual trades unchanged, account mapping, historical limits per broker, plus regression on `tradeMath`/`filterTrades`. Backend (pytest) only for the new Dhan history proxy route.

### Files expected to change (if approved)
- New: `src/services/brokerSync/fillLedger.ts`, `.../syncRun.ts`, `.../csv/` (parser, mapping, preview), `.../orders` + `.../positions` adapters per broker, a small `src/workspace/BrokerSyncPanel.tsx`, test files, `BROKER_SYNC_IMPLEMENTATION.md`.
- Modified (small, additive): `src/database/db.ts` (v5 tables), `src/types/index.ts` (`source` union), `matchFills.ts`, the four `*TradeSync.ts`, `upstoxApi.ts`, `dhanApi.ts`, `backend/app/routers/dhan.py` (+ schema), and the four sync handlers in `App.tsx` (call the shared atomic persist function; no other App.tsx changes).
- Not touched: UI design system, routes, backend schema, trade math, analytics, auth, billing, sharing.

## 5. Security implications
- No new secrets in the frontend. Dhan history goes through the existing backend proxy (token passed through, not stored or logged).
- Fill ledger and order/position snapshots hold trading data only, never credentials.
- Sync error messages are sanitized (no headers, tokens, or full auth responses).
- Read-only: only GET endpoints are called; no order placement/modify/cancel anywhere.
- Zerodha CORS [U]: if a real test shows the browser call is blocked, the fix is a proxy route like Dhan's, which is a small backend addition.

## 6. Decisions I need from you before implementing
1. **Manual trades (P2):** OK to never auto-close manual trades and instead show "possible match - review"? (Recommended; the alternative is today's behaviour, which breaks your rule.)
2. **Scope of P4:** implement orders/positions UI for the [V] endpoints first and the rest after docs check, or defer orders/positions entirely?
3. **CSV (P6):** can you share one real tradebook export each from Angel One and Zerodha (redact personal info)? Without them I ship the mapper only, with no broker presets.
4. **Charges:** show broker charges where an API gives them (Dhan history) and otherwise leave net = gross, clearly labelled. OK?
5. **Storage:** keep all of this in Dexie (frontend-only, per-device) as proposed, or also persist fills/sync runs on the backend? (Backend persistence is a larger change and not required for the goals above.)
6. **Live verification:** I can only test with mocked responses. Real-account checks (field names, Angel One `exchtime` format, Zerodha CORS) need you to run a sync with your credentials and share a redacted first row.

Nothing has been implemented, deployed, committed, or pushed.
