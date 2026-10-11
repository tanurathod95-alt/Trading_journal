/**
 * Order-book and position snapshots. These are READ-ONLY views of what the broker reports right
 * now. They are stored in their own tables and are never converted into trades: only executed
 * fills (tradebook / CSV) enter the trade ledger. Pending, rejected, cancelled and unfilled
 * orders therefore can never appear as completed trades.
 *
 * Verified-endpoint coverage (official docs): Zerodha orders + positions, Dhan orders.
 * NOT implemented (docs not verified in this pass): Angel One / Upstox orders & positions, Dhan positions.
 */
import { db, type BrokerFillRecord, type BrokerOrderRecord, type BrokerPositionRecord, type NormalizedOrderStatus, type SyncBroker } from '../../database/db'
import { parseBrokerTimestamp } from './dates'
import type { DhanOrderRow } from './dhan/dhanApi'
import type { ZerodhaOrderRow, ZerodhaPositionRow } from './zerodha/zerodhaApi'

export const SNAPSHOT_SUPPORT: Record<SyncBroker, { orders: boolean; positions: boolean; note: string }> = {
  zerodha: { orders: true, positions: true, note: 'Kite GET /orders and /portfolio/positions (net).' },
  dhan: { orders: true, positions: false, note: 'Dhan GET /orders. Positions endpoint not verified yet.' },
  upstox: { orders: false, positions: false, note: 'Unavailable: order/position endpoints not verified against official docs yet.' },
  angelone: { orders: false, positions: false, note: 'Unavailable: order/position endpoints not verified against official docs yet.' },
  other: { orders: false, positions: false, note: 'CSV imports have no live order book or positions.' },
}

function mapZerodhaStatus(status: string, filled: number): NormalizedOrderStatus {
  const s = status.toUpperCase()
  if (s === 'COMPLETE') return 'COMPLETE'
  if (s === 'REJECTED') return 'REJECTED'
  if (s === 'CANCELLED') return 'CANCELLED'
  if (s === 'OPEN' || s === 'MODIFIED') return filled > 0 ? 'PARTIAL' : 'OPEN'
  if (s.includes('PENDING') || s.includes('RECEIVED')) return 'PENDING'
  return 'UNKNOWN'
}

function mapDhanStatus(status: string): NormalizedOrderStatus {
  switch (status.toUpperCase()) {
    case 'TRADED':
      return 'COMPLETE'
    case 'PART_TRADED':
      return 'PARTIAL'
    case 'PENDING':
      return 'OPEN'
    case 'TRANSIT':
      return 'PENDING'
    case 'REJECTED':
      return 'REJECTED'
    case 'CANCELLED':
      return 'CANCELLED'
    case 'EXPIRED':
      return 'EXPIRED'
    default:
      return 'UNKNOWN'
  }
}

const orderKey = (broker: SyncBroker, accountId: string, orderId: string): string => `${broker}:${accountId}:${orderId}`

export function normalizeZerodhaOrders(rows: ZerodhaOrderRow[], accountId: string, fetchedAt = new Date().toISOString()): BrokerOrderRecord[] {
  return rows.map((r) => ({
    key: orderKey('zerodha', accountId, r.order_id),
    broker: 'zerodha',
    accountId,
    orderId: r.order_id,
    symbol: r.tradingsymbol,
    side: r.transaction_type,
    quantity: Number(r.quantity) || 0,
    filledQuantity: Number(r.filled_quantity) || 0,
    status: mapZerodhaStatus(r.status ?? '', Number(r.filled_quantity) || 0),
    rawStatus: r.status ?? '',
    averagePrice: r.average_price ? Number(r.average_price) : undefined,
    orderedAt: parseBrokerTimestamp(r.order_timestamp)?.iso,
    message: r.status_message ?? undefined,
    fetchedAt,
  }))
}

export function normalizeDhanOrders(rows: DhanOrderRow[], accountId: string, fetchedAt = new Date().toISOString()): BrokerOrderRecord[] {
  return rows.map((r) => ({
    key: orderKey('dhan', accountId, r.orderId),
    broker: 'dhan',
    accountId,
    orderId: r.orderId,
    symbol: r.tradingSymbol,
    side: r.transactionType,
    quantity: Number(r.quantity) || 0,
    filledQuantity: Number(r.filledQty) || 0,
    status: mapDhanStatus(r.orderStatus ?? ''),
    rawStatus: r.orderStatus ?? '',
    averagePrice: r.averageTradedPrice ? Number(r.averageTradedPrice) : undefined,
    orderedAt: parseBrokerTimestamp(r.createTime)?.iso,
    message: r.omsErrorDescription ?? undefined,
    fetchedAt,
  }))
}

export function normalizeZerodhaPositions(rows: ZerodhaPositionRow[], accountId: string, fetchedAt = new Date().toISOString()): BrokerPositionRecord[] {
  return rows.map((r) => ({
    key: `zerodha:${accountId}:${r.exchange}:${r.tradingsymbol}:${r.product}`,
    broker: 'zerodha',
    accountId,
    symbol: r.tradingsymbol,
    exchange: r.exchange,
    product: r.product,
    netQuantity: Number(r.quantity) || 0,
    averagePrice: Number(r.average_price) || 0,
    lastPrice: r.last_price !== undefined ? Number(r.last_price) : undefined,
    realisedPnl: r.realised !== undefined ? Number(r.realised) : undefined,
    unrealisedPnl: r.unrealised !== undefined ? Number(r.unrealised) : undefined,
    fetchedAt,
  }))
}

/** Replaces this broker+account's order snapshot atomically. Touches no other table. */
export async function saveOrderSnapshot(broker: SyncBroker, accountId: string, orders: BrokerOrderRecord[]): Promise<void> {
  await db.transaction('rw', db.brokerOrders, async () => {
    await db.brokerOrders.where('[broker+accountId]').equals([broker, accountId]).delete()
    await db.brokerOrders.bulkPut(orders)
  })
}

export async function savePositionSnapshot(broker: SyncBroker, accountId: string, positions: BrokerPositionRecord[]): Promise<void> {
  await db.transaction('rw', db.brokerPositions, async () => {
    await db.brokerPositions.where('[broker+accountId]').equals([broker, accountId]).delete()
    await db.brokerPositions.bulkPut(positions)
  })
}

export interface OrderReconciliationIssue {
  orderId: string
  symbol: string
  orderFilled: number
  ledgerFilled: number
}

/**
 * Cross-checks order-book filled quantities against imported fills for the same order id. Purely
 * informational: it never imports anything. A mismatch usually means a tradebook sync hasn't run
 * yet (ledger < order) or the order id formats differ.
 */
export function reconcileOrders(orders: BrokerOrderRecord[], fills: Array<Pick<BrokerFillRecord, 'orderId' | 'quantity'>>): OrderReconciliationIssue[] {
  const ledgerByOrder = new Map<string, number>()
  for (const f of fills) {
    if (!f.orderId) continue
    ledgerByOrder.set(f.orderId, (ledgerByOrder.get(f.orderId) ?? 0) + f.quantity)
  }
  const issues: OrderReconciliationIssue[] = []
  for (const o of orders) {
    if (o.filledQuantity <= 0) continue
    const ledgerFilled = ledgerByOrder.get(o.orderId) ?? 0
    if (ledgerFilled !== o.filledQuantity) {
      issues.push({ orderId: o.orderId, symbol: o.symbol, orderFilled: o.filledQuantity, ledgerFilled })
    }
  }
  return issues
}
