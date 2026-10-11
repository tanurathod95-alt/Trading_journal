# Broker Sync Implementation

Status: implemented locally and tested with mocked data. **Nothing was committed, pushed or deployed. No live broker account was used.** Scope: Angel One, Zerodha, Upstox, Dhan (FYERS excluded). Plan and findings: [BROKER_SYNC_AUDIT.md](./BROKER_SYNC_AUDIT.md).

## Decisions applied (yours)
1. Manual trades are never closed, modified or overwritten by broker/CSV fills. A fill that could be the exit or duplicate of a manual trade raises a **"Possible match — review required"** item; the manual trade stays byte-for-byte unchanged.
2. Orders/positions only for endpoints verified in official docs; others are marked unavailable in the UI.
3. CSV importer with configurable mapping + preview; no broker presets (no sample files yet).
4. Gross P&L, known charges and net P&L are shown separately; missing charges are labelled "Charges unavailable"; old P&L is never rewritten.
5. Local-first Dexie storage only.

## What changed

### Storage (Dexie v5, additive)
`src/database/db.ts` adds five tables; existing tables/rows untouched:
`brokerFills` (execution ledger, primary key `broker:accountId:fillId`), `syncRuns`, `syncReviews`, `brokerOrders`, `brokerPositions`.
`Trade` gained optional `charges`, `chargesStatus`, and `source` now also allows `'csv-import'` (`src/types/index.ts`).

### Sync engine
| File | Role |
|---|---|
| `services/brokerSync/fillLedger.ts` | `runFillSync`: one atomic Dexie transaction writes ledger rows + trades + review items; per broker/account lock (in-tab + Web Locks across tabs); sync-run log; `hasCompletedApiSync`, review helpers |
| `services/brokerSync/matchFills.ts` | Same matching logic; now only trades with `source` `broker-sync`/`csv-import` can be auto-updated; manual trades produce `possibleMatches` |
| `services/brokerSync/dates.ts` | Asia/Kolkata timestamp parsing; unparseable -> `null` (never "today") |
| `services/brokerSync/normalizeFill.ts` | Validates each row (id, symbol, side, qty > 0, price > 0, timestamp); bad rows become reviewable rejections |
| `services/brokerSync/snapshots.ts` | Order-book / position snapshots (view only), status mapping, order-vs-ledger reconciliation |
| `services/brokerSync/csv/csvImport.ts` | Parse CSV/XLSX, header-row detection, mapping suggestion, preview/validation, commit via `runFillSync` |
| `services/brokerSync/syncMessages.ts` | Status line text |
| `components/BrokerSync/BrokerSyncPanel.tsx` (+ css) | Settings → Broker Connection: review queue, sync history, history limits, CSV import with preview, orders/positions snapshots |

Modified: the four broker adapters (`angelOneTradeSync`, `zerodha/*`, `upstox/*`, `dhan/*`) now only fetch + normalize; the four sync handlers in `App.tsx` call `runFillSync`; Trade detail in `App.tsx` shows gross/charges/net; `workspace/api.ts` (+2 Dhan methods); `backend/app/routers/dhan.py` + `schemas.py`; `vite.config.ts` (vitest `setupFiles`); `package.json` (dev dependency `fake-indexeddb`).

### Fixes to existing behaviour
- **Manual-trade overwrite** (audit #1): fixed, see above.
- **Non-atomic saves / unsafe retries** (#2, #3): one transaction; ledger key is a database primary key, so retries and deleted-then-resynced trades cannot duplicate.
- **Dhan dedup** (#5): `exchangeTradeId` is the only execution id. No `orderId` fallback; rows without it are not imported and go to review. Several partial fills of one order stay separate.
- **Dhan history**: now supported (paginated, 31-day windows, charges captured). The old "current day only" statement in `BROKER_INTEGRATION_AUDIT.md` and code comments was wrong for Dhan.
- **Upstox pagination** (#6): follows `meta_data.page.total_pages` with `page_size` 1000; throws instead of importing a truncated set.
- **Upstox today-trades mapping**: today's rows use `average_price` and `exchange_timestamp`, not `price`/`trade_date` (the old mapper would have produced price 0 and today's date). Fixed.
- **Dates** (#7): IST handling, timezone-assumed flag, unparseable timestamps flagged and not imported.
- **Sensitive debug logging** (#12): the first-raw-row `console.debug` was removed from all four broker clients.

### Official endpoints used (all GET, read-only; no orders placed/modified/cancelled)
- Zerodha: `/trades`, `/orders`, `/portfolio/positions` (net) — fields verified from Kite docs (`quantity` vs `filled` inconsistency handled).
- Upstox: `/v2/order/trades/get-trades-for-day`, `/v2/charges/historical-trades` (`page_number` from 1, `page_size` 1–5000, last 3 financial years).
- Dhan (via existing backend proxy): `/v2/trades`, `/v2/trades/{from}/{to}/{page}`, `/v2/orders`.
- Angel One: existing `getTradeBook` (current day).

### Auth / secrets
Unchanged. No secrets moved to the frontend; Dhan token is relayed server-side in a header only (not in URL, not stored, not logged). Sync error text is truncated and never includes headers or tokens.

### Backend change (please note)
Dhan blocks browser CORS, so historical trades and orders need a proxy route. I added two **stateless, read-only GET pass-through routes** to the *existing* Dhan proxy (`/api/dhan/trade-history`, `/api/dhan/orders`). No new service, no database, no cloud storage. If you consider even this out of scope, Dhan history/orders can be removed without affecting anything else.

## Tests (actual results)
- Frontend `npx vitest run`: **13 files, 90 tests passed** (38 pre-existing + 52 new).
- Backend `pytest`: **125 passed** (120 pre-existing + 5 new in `tests/test_dhan_proxy.py`).
- `npx tsc -b`: no errors. `npx vite build`: succeeded. `npx oxlint`: warnings only; the new panel adds one `set-state-in-effect` warning of the same kind already present elsewhere in the repo.
- New tests cover: manual-trade protection, partial fills, duplicate/repeat syncs, interrupted sync rollback + safe retry, concurrent-run lock, deleted-trade re-sync, date parsing (IST, UTC crossing midnight, day-first, serials, invalid), charges known/unavailable/apportioned, unparseable timestamp flagged not imported, Dhan partial fills + no `orderId` fallback, Upstox pagination + mapping, CSV mapping/preview/invalid/duplicate/re-import, pending/rejected orders and positions never becoming trades, order reconciliation.

## Historical data per broker
| Broker | Via API | Otherwise |
|---|---|---|
| Angel One | current day only | CSV import |
| Zerodha | current day only | CSV import (Console tradebook) |
| Upstox | today + history (first sync backfills 90 days) | CSV |
| Dhan | today + history with charges (first sync backfills 90 days) | CSV |

## CSV
Generic header aliases for any file, plus **one validated preset: Angel One "Trades and Charges"** (Accounts -> Trades and Charges -> Download Trade History). It was checked against one real export (FY2025-26): columns `Scrip/Contract, Buy/Sell, Buy Price, Sell Price, Quantity, Brokerage, GST, STT, Sebi Tax, Exchange Turnover Charges, Stamp Duty, Other Charges, IPFT Charges, Order Type, Segment, Exchange, Order ID, Trade ID, Date`. Handling specific to it:
- Buy and Sell prices are separate columns; the price is taken from the column matching the side.
- Zero-quantity rows are charge-only (brokerage/GST for an order); they are not trades. Their charges are rolled up per Order ID and split over that order's trade rows by quantity, so charges are real and not estimated.
- The `Date` column has no time; fills are stored date-only (no fake 00:00 execution time).
- Segment `CAPITAL` = cash. Symbols are Angel One's company names (e.g. "VISA STEEL LIMITED"), not exchange trading symbols.

Result on that real file: 98 data rows -> 51 fills + 47 charge-only rows, 0 invalid; 35 trades (19 closed with known charges, 16 open); attributed charges 66.24 vs the report's own "Total Trade Charges" 66.35 (difference 0.11, not explained — likely rounding; not verified).

Not matched (will show mapping errors): the Angel One **P&L statement** (`Equity P&L` / `F&O P&L` sheets) — it has per-scrip totals, no per-trade dates or ids. Zerodha, Upstox and Dhan CSV layouts still have **no validated presets** (no sample files); use manual column mapping.

Dedup key = broker + account + trade id; without a trade-id column it is a content hash plus occurrence index, so an identical re-upload adds nothing, but two *different* exports containing the same executions with different row order could theoretically be mis-paired.

## Known limitations / unresolved
- **Not run against any real broker or in a browser.** Real field names/formats are unverified for Angel One (`exchtime`/`filltime` format, trade-book fields) and Zerodha browser CORS. Unparseable rows are flagged, not guessed, so a format surprise shows up as "needs review" rather than wrong data.
- **Orders/positions unavailable** (docs not verified): Angel One and Upstox orders/positions, Dhan positions.
- **Sells with no buy in the same file** (e.g. delivery shares bought before the file's range) import as open SELL lots, i.e. they look like open short positions. Import the earlier buys too, or delete those lots. In the real Angel One file this affected part of the 16 open lots.
- Angel One trade names from CSV (company names) differ from API symbols (`XYZ-EQ`), so CSV and API-synced trades for the same stock will not match each other for entry/exit pairing (their trade ids do dedup if the broker is the same).
- **Charges** are known only when the source supplies them for both legs (Dhan history, or a mapped CSV column). Everything else imports as "Charges unavailable". Aggregate analytics, tables and exports still read the existing `netPnl` (= gross for those trades); only the Trade detail view shows the gross/charges/net split and the "unverified" label. Older synced trades are unchanged and carry no charges status.
- A possible match is flagged, but the broker fill still becomes its own trade. If it was really the same execution as a manual trade, delete one manually.
- The Dexie v5 upgrade was exercised on fresh databases in tests, not on a real v4 browser database. It only adds stores, but verify once on a copy of real data.
- Cross-tab locking uses the Web Locks API where available; it was not exercised in tests (node).
- Dhan history range/page-size limits are undocumented; the 31-day window and 200-page cap are conservative guesses. Large histories may be slow.
- Legacy `*-last-sync-*` localStorage keys are no longer written ("first sync" now comes from the sync-run log).
- UI was typechecked and built but not visually checked.

## Suggested next steps
1. Run one real sync per broker and share a redacted first row to confirm field names and time formats.
2. Provide one tradebook export per broker to add validated CSV presets.
3. Verify and add Angel One / Upstox orders & positions, and Dhan positions.
4. Decide whether aggregate analytics should switch to a charges-aware net figure.
