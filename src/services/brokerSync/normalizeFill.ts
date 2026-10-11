import type { TradeSide, TradingSegment } from '../../types'
import { parseBrokerTimestamp } from './dates'
import type { NormalizedFill, RejectedFill } from './matchFills'

export interface FillBatch {
  fills: NormalizedFill[]
  rejected: RejectedFill[]
}

export interface RawFillInput {
  fillId: string | undefined | null
  symbol: string | undefined | null
  segment: TradingSegment
  side: unknown
  quantity: unknown
  price: unknown
  /** Raw timestamp value exactly as the source gave it (string, Excel serial, ...). */
  timestamp: unknown
  orderId?: string
  exchangeOrderId?: string
  exchange?: string
  product?: string
  charges?: number
}

/** Positive finite number from a string/number, else null. Zero and negatives are invalid for quantity and price. */
export function positiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

export function parseSide(value: unknown): TradeSide | null {
  const text = String(value ?? '').trim().toUpperCase()
  if (text === 'BUY' || text === 'B') return 'BUY'
  if (text === 'SELL' || text === 'S') return 'SELL'
  return null
}

/**
 * Turns one raw source row into a reliable fill, or a RejectedFill saying exactly why not.
 * Never substitutes defaults: a missing id, bad timestamp, non-positive quantity/price or unknown
 * side means the row is NOT imported and is surfaced for review instead.
 */
export function toFill(raw: RawFillInput): { fill: NormalizedFill } | { rejected: RejectedFill } {
  const symbol = (raw.symbol ?? '').toString().trim()
  const fillId = (raw.fillId ?? '').toString().trim()
  const rawTimestamp = raw.timestamp === undefined || raw.timestamp === null ? undefined : String(raw.timestamp)
  const reject = (reason: string): { rejected: RejectedFill } => ({
    rejected: { fillId: fillId || '(missing id)', symbol: symbol || '(missing symbol)', rawTimestamp, reason },
  })

  if (!fillId) return reject('Missing exchange trade/execution id — not imported, because without it partial fills cannot be told apart.')
  if (!symbol) return reject('Missing trading symbol.')
  const side = parseSide(raw.side)
  if (!side) return reject(`Unrecognised buy/sell side "${String(raw.side)}".`)
  const quantity = positiveNumber(raw.quantity)
  if (quantity === null) return reject(`Invalid executed quantity "${String(raw.quantity)}".`)
  const price = positiveNumber(raw.price)
  if (price === null) return reject(`Invalid execution price "${String(raw.price)}".`)
  const ts = parseBrokerTimestamp(raw.timestamp)
  if (!ts) return reject(`Could not reliably parse the execution timestamp "${rawTimestamp ?? ''}" — not imported, needs review.`)

  return {
    fill: {
      fillId,
      symbol,
      segment: raw.segment,
      side,
      quantity,
      price,
      date: ts.date,
      executedAt: ts.iso,
      timezoneAssumed: ts.timezoneAssumed,
      orderId: raw.orderId || undefined,
      exchangeOrderId: raw.exchangeOrderId || undefined,
      exchange: raw.exchange || undefined,
      product: raw.product || undefined,
      charges: raw.charges,
    },
  }
}

export function toBatch(rows: RawFillInput[]): FillBatch {
  const batch: FillBatch = { fills: [], rejected: [] }
  for (const row of rows) {
    const result = toFill(row)
    if ('fill' in result) batch.fills.push(result.fill)
    else batch.rejected.push(result.rejected)
  }
  return batch
}
