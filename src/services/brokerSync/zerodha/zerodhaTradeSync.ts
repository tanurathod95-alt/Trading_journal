import type { Trade, TradingSegment } from '../../../types'
import { matchFills, type FillMatchResult, type NormalizedFill } from '../matchFills'
import { getTrades, type ZerodhaTradeRow } from './zerodhaApi'

export type ZerodhaSyncResult = FillMatchResult

/** Same inference Angel One needed — Kite's trade object doesn't carry a dedicated
 * instrument-type field either, only exchange + tradingsymbol. */
function inferSegment(exchange: string, tradingSymbol: string): TradingSegment {
  const ex = exchange.toUpperCase()
  if (ex === 'NSE' || ex === 'BSE') return 'CASH'
  const sym = tradingSymbol.toUpperCase()
  if (sym.endsWith('CE') || sym.endsWith('PE')) return 'OPTIONS'
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

function normalizeZerodhaRow(row: ZerodhaTradeRow): NormalizedFill {
  // Docs disagree on the field name (quantity vs filled) — accept either, whichever is present.
  const quantity = row.quantity ?? row.filled ?? 0
  return {
    fillId: row.trade_id,
    symbol: row.tradingsymbol,
    segment: inferSegment(row.exchange, row.tradingsymbol),
    side: row.transaction_type,
    quantity: Number(quantity) || 0,
    price: Number(row.average_price) || 0,
    date: toDateString(row.exchange_timestamp ?? row.fill_timestamp ?? row.order_timestamp),
  }
}

export async function syncZerodhaTrades(apiKey: string, accessToken: string, accountId: string, existingTrades: Trade[]): Promise<ZerodhaSyncResult> {
  const rows = await getTrades(apiKey, accessToken)
  return matchFills(rows.map(normalizeZerodhaRow), accountId, existingTrades)
}
