import type { Trade, TradeSide, TradingSegment } from '../../../types'
import { matchFills, type FillMatchResult, type NormalizedFill } from '../matchFills'
import { getHistoricalTrades, getTodayTrades, type UpstoxTradeRow } from './upstoxApi'

const HISTORICAL_LOOKBACK_DAYS = 90

/** NSE/BSE = cash equity; everything else (NFO/BFO/MCX/CDS) is a derivative — Upstox's
 * historical-trades endpoint does carry an `option_type` field for F&O rows, which (when
 * present) tells us OPTIONS directly instead of guessing from the symbol suffix like Angel One. */
function inferSegment(exchange: string, optionType: string | undefined): TradingSegment {
  const ex = exchange.toUpperCase()
  if (ex === 'NSE' || ex === 'BSE') return 'CASH'
  if (optionType === 'CE' || optionType === 'PE') return 'OPTIONS'
  return 'FUTURES'
}

function toDateString(value: string | undefined): string {
  if (value) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10)
    }
  }
  return new Date().toISOString().slice(0, 10)
}

function normalizeUpstoxRow(row: UpstoxTradeRow): NormalizedFill {
  const price = row.price ?? (row.amount && row.quantity ? row.amount / row.quantity : 0)
  return {
    fillId: row.trade_id,
    symbol: row.symbol || row.scrip_name || 'UNKNOWN',
    segment: inferSegment(row.exchange, row.option_type),
    side: row.transaction_type as TradeSide,
    quantity: Number(row.quantity) || 0,
    price: Number(price) || 0,
    date: toDateString(row.trade_date),
  }
}

export interface UpstoxSyncResult extends FillMatchResult {
  /** True when this run also pulled a historical backfill (first-ever connect for this account). */
  backfilled: boolean
}

/**
 * Fetches and matches Upstox trades for an account. On the very first sync for an account (no
 * prior sync timestamp recorded — see the `upstox-last-sync-{accountId}` localStorage key the
 * caller manages), also pulls a historical-trades backfill: unlike Angel One, Upstox has a real,
 * documented historical endpoint, so there's no reason to start blind with only "today."
 */
export async function syncUpstoxTrades(
  accessToken: string,
  accountId: string,
  existingTrades: Trade[],
  isFirstSync: boolean,
): Promise<UpstoxSyncResult> {
  const todayRows = await getTodayTrades(accessToken)
  let rows: UpstoxTradeRow[] = todayRows

  if (isFirstSync) {
    const end = new Date()
    const start = new Date(end.getTime() - HISTORICAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    const historicalRows = await getHistoricalTrades(accessToken, {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    })
    // Historical rows may overlap with "today" if the lookback window includes today —
    // de-dup by trade_id before matching (matchFills also dedups against Dexie, but not
    // within this one fetched batch).
    const seen = new Set(todayRows.map((r) => r.trade_id))
    rows = [...historicalRows.filter((r) => !seen.has(r.trade_id)), ...todayRows]
  }

  const result = matchFills(rows.map(normalizeUpstoxRow), accountId, existingTrades)
  return { ...result, backfilled: isFirstSync }
}
