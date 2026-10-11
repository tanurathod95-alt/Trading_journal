import type { TradingSegment } from '../../../types'
import { toBatch, type FillBatch } from '../normalizeFill'
import { getTrades, type ZerodhaTradeRow } from './zerodhaApi'

/** Same inference Angel One needed — Kite's trade object doesn't carry a dedicated
 * instrument-type field either, only exchange + tradingsymbol. */
function inferSegment(exchange: string, tradingSymbol: string): TradingSegment {
  const ex = exchange.toUpperCase()
  if (ex === 'NSE' || ex === 'BSE') return 'CASH'
  const sym = tradingSymbol.toUpperCase()
  if (sym.endsWith('CE') || sym.endsWith('PE')) return 'OPTIONS'
  return 'FUTURES'
}

export function normalizeZerodhaRows(rows: ZerodhaTradeRow[]): FillBatch {
  return toBatch(
    rows.map((row) => ({
      fillId: row.trade_id,
      symbol: row.tradingsymbol,
      segment: inferSegment(row.exchange ?? '', row.tradingsymbol ?? ''),
      side: row.transaction_type,
      // Kite's docs name this field both `quantity` (samples) and `filled` (attribute table).
      quantity: row.quantity ?? row.filled,
      price: row.average_price,
      timestamp: row.exchange_timestamp ?? row.fill_timestamp ?? row.order_timestamp,
      orderId: row.order_id,
      exchangeOrderId: row.exchange_order_id,
      exchange: row.exchange,
      product: row.product,
    })),
  )
}

/** Current trading day only — Kite's /trades is day-scoped. Older days need the Console tradebook CSV. */
export async function fetchZerodhaFills(apiKey: string, accessToken: string): Promise<FillBatch> {
  return normalizeZerodhaRows(await getTrades(apiKey, accessToken))
}
