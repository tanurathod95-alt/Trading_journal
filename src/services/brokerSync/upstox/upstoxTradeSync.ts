import type { TradingSegment } from '../../../types'
import { toBatch, type FillBatch, type RawFillInput } from '../normalizeFill'
import { getHistoricalTrades, getTodayTrades, type UpstoxTradeRow } from './upstoxApi'

const HISTORICAL_LOOKBACK_DAYS = 90

/** NSE/BSE = cash equity; everything else is a derivative. Historical rows carry `option_type`; today's rows don't, so fall back to the CE/PE symbol suffix. */
function inferSegment(exchange: string, optionType: string | undefined, symbol: string): TradingSegment {
  const ex = exchange.toUpperCase()
  if (ex === 'NSE' || ex === 'BSE') return 'CASH'
  if (optionType === 'CE' || optionType === 'PE') return 'OPTIONS'
  const sym = symbol.toUpperCase()
  if (!optionType && (sym.endsWith('CE') || sym.endsWith('PE'))) return 'OPTIONS'
  return 'FUTURES'
}

/**
 * Maps one Upstox row. Today's and historical rows use different field names (see UpstoxTradeRow):
 * price = `price` (historical) or `average_price` (today); timestamp = `trade_date` (historical,
 * date only) or `exchange_timestamp`/`order_timestamp` (today).
 */
export function normalizeUpstoxRows(rows: UpstoxTradeRow[]): FillBatch {
  const inputs: RawFillInput[] = rows.map((row) => {
    const symbol = row.symbol || row.trading_symbol || row.tradingsymbol || row.scrip_name || ''
    const derivedPrice = row.amount && row.quantity ? row.amount / row.quantity : undefined
    return {
      fillId: row.trade_id,
      symbol,
      segment: inferSegment(row.exchange ?? '', row.option_type, symbol),
      side: row.transaction_type,
      quantity: row.quantity,
      price: row.price ?? row.average_price ?? derivedPrice,
      timestamp: row.exchange_timestamp ?? row.trade_date ?? row.order_timestamp,
      orderId: row.order_id,
      exchange: row.exchange,
      product: row.product,
    }
  })
  return toBatch(inputs)
}

/**
 * Today's trades, plus (when `includeHistory`) a paginated historical backfill. Historical rows
 * overlap today's when the window includes today; ids are de-duplicated before normalizing.
 */
export async function fetchUpstoxFills(accessToken: string, includeHistory: boolean): Promise<FillBatch> {
  const todayRows = await getTodayTrades(accessToken)
  let rows: UpstoxTradeRow[] = todayRows

  if (includeHistory) {
    const end = new Date()
    const start = new Date(end.getTime() - HISTORICAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    const historicalRows = await getHistoricalTrades(accessToken, {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    })
    const seen = new Set(todayRows.map((r) => r.trade_id))
    rows = [...historicalRows.filter((r) => !seen.has(r.trade_id)), ...todayRows]
  }

  return normalizeUpstoxRows(rows)
}
