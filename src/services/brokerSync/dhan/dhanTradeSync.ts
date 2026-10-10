import type { Trade, TradeSide, TradingSegment } from '../../../types'
import { matchFills, type FillMatchResult, type NormalizedFill } from '../matchFills'
import { getTradeBook, type DhanTradeRow } from './dhanApi'

export type DhanSyncResult = FillMatchResult

/** Dhan's own documented segment/option fields, not a symbol-suffix guess like Angel One had to
 * use — exchangeSegment is e.g. "NSE_EQ"/"BSE_EQ" for cash, "NSE_FNO"/"BSE_FNO"/"MCX_COMM" etc.
 * for derivatives; drvOptionType (CALL/PUT) distinguishes options from futures when present. */
function inferSegment(exchangeSegment: string, drvOptionType: string | null | undefined): TradingSegment {
  if (exchangeSegment.toUpperCase().endsWith('_EQ')) return 'CASH'
  if (drvOptionType === 'CALL' || drvOptionType === 'PUT') return 'OPTIONS'
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

function normalizeDhanRow(row: DhanTradeRow): NormalizedFill {
  return {
    fillId: row.exchangeTradeId || row.orderId,
    symbol: row.tradingSymbol,
    segment: inferSegment(row.exchangeSegment, row.drvOptionType),
    side: row.transactionType as TradeSide,
    quantity: Number(row.tradedQuantity) || 0,
    price: Number(row.tradedPrice) || 0,
    date: toDateString(row.exchangeTime ?? row.updateTime ?? row.createTime),
  }
}

export async function syncDhanTrades(accessToken: string, accountId: string, existingTrades: Trade[]): Promise<DhanSyncResult> {
  const rows = await getTradeBook(accessToken)
  return matchFills(rows.map(normalizeDhanRow), accountId, existingTrades)
}
