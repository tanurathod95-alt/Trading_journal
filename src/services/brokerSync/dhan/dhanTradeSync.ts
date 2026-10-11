import type { TradingSegment } from '../../../types'
import { toBatch, type FillBatch, type RawFillInput } from '../normalizeFill'
import { getTradeBook, getTradeHistory, type DhanTradeRow } from './dhanApi'

const HISTORICAL_LOOKBACK_DAYS = 90

/** Dhan's own documented segment/option fields, not a symbol-suffix guess: exchangeSegment is e.g.
 * "NSE_EQ"/"BSE_EQ" for cash, "NSE_FNO"/"BSE_FNO"/"MCX_COMM" for derivatives; drvOptionType
 * (CALL/PUT) distinguishes options from futures when present. */
function inferSegment(exchangeSegment: string, drvOptionType: string | null | undefined): TradingSegment {
  if (exchangeSegment.toUpperCase().endsWith('_EQ')) return 'CASH'
  if (drvOptionType === 'CALL' || drvOptionType === 'PUT') return 'OPTIONS'
  return 'FUTURES'
}

const CHARGE_FIELDS = ['brokerageCharges', 'stt', 'sebiTax', 'serviceTax', 'exchangeTransactionCharges', 'stampDuty'] as const

/** Sum of Dhan's documented charge fields, ONLY when every field is present and numeric (the trade-book endpoint has none, so it returns undefined there). */
function totalCharges(row: DhanTradeRow): number | undefined {
  let total = 0
  for (const field of CHARGE_FIELDS) {
    const raw = row[field]
    if (raw === undefined || raw === null || raw === '') return undefined
    const n = Number(raw)
    if (!Number.isFinite(n)) return undefined
    total += n
  }
  return Math.round(total * 100) / 100
}

/**
 * `exchangeTradeId` is the execution id. There is deliberately NO fallback to `orderId`: one order
 * can have many partial fills, and an order id would collapse them into one. A row without an
 * exchangeTradeId is rejected for review by toFill instead of being merged.
 */
export function normalizeDhanRows(rows: DhanTradeRow[]): FillBatch {
  const inputs: RawFillInput[] = rows.map((row) => ({
    fillId: row.exchangeTradeId,
    symbol: row.tradingSymbol,
    segment: inferSegment(row.exchangeSegment ?? '', row.drvOptionType),
    side: row.transactionType,
    quantity: row.tradedQuantity,
    price: row.tradedPrice,
    timestamp: row.exchangeTime ?? row.updateTime ?? row.createTime,
    orderId: row.orderId,
    exchangeOrderId: row.exchangeOrderId,
    exchange: row.exchangeSegment,
    product: row.productType,
    charges: totalCharges(row),
  }))
  return toBatch(inputs)
}

/** Today's trade book, plus (when `includeHistory`) the paginated historical endpoint, de-duplicated by exchangeTradeId. */
export async function fetchDhanFills(accessToken: string, includeHistory: boolean): Promise<FillBatch> {
  const today = await getTradeBook(accessToken)
  let rows: DhanTradeRow[] = today

  if (includeHistory) {
    const end = new Date()
    const start = new Date(end.getTime() - HISTORICAL_LOOKBACK_DAYS * 86_400_000)
    const history = await getTradeHistory(accessToken, start, end)
    // Prefer the historical row (it carries charges) when the same execution appears in both.
    const historyIds = new Set(history.map((r) => r.exchangeTradeId).filter(Boolean))
    rows = [...history, ...today.filter((r) => !r.exchangeTradeId || !historyIds.has(r.exchangeTradeId))]
  }

  return normalizeDhanRows(rows)
}
