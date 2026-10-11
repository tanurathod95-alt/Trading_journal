import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../database/db'
import { normalizeDhanOrders, normalizeZerodhaOrders, normalizeZerodhaPositions, reconcileOrders, saveOrderSnapshot, savePositionSnapshot } from './snapshots'

beforeEach(async () => {
  await db.delete()
  await db.open()
})

const zOrder = (over: Record<string, unknown>) => ({
  order_id: 'Z1',
  tradingsymbol: 'SBIN',
  exchange: 'NSE',
  transaction_type: 'BUY' as const,
  quantity: 10,
  filled_quantity: 0,
  status: 'OPEN',
  ...over,
})

describe('order and position snapshots', () => {
  it('maps broker statuses; pending, rejected and cancelled orders stay orders', () => {
    const orders = normalizeZerodhaOrders(
      [
        zOrder({ order_id: 'a', status: 'COMPLETE', filled_quantity: 10 }),
        zOrder({ order_id: 'b', status: 'REJECTED', status_message: 'RMS: margin' }),
        zOrder({ order_id: 'c', status: 'CANCELLED' }),
        zOrder({ order_id: 'd', status: 'OPEN', filled_quantity: 4 }),
        zOrder({ order_id: 'e', status: 'TRIGGER PENDING' }),
      ],
      'A1',
    )
    expect(orders.map((o) => o.status)).toEqual(['COMPLETE', 'REJECTED', 'CANCELLED', 'PARTIAL', 'PENDING'])
    expect(orders[1].message).toBe('RMS: margin')

    const dhan = normalizeDhanOrders(
      [
        { orderId: '1', orderStatus: 'TRADED', transactionType: 'BUY', tradingSymbol: 'TCS', quantity: 5, filledQty: 5 },
        { orderId: '2', orderStatus: 'PART_TRADED', transactionType: 'BUY', tradingSymbol: 'TCS', quantity: 5, filledQty: 2 },
        { orderId: '3', orderStatus: 'EXPIRED', transactionType: 'BUY', tradingSymbol: 'TCS', quantity: 5 },
        { orderId: '4', orderStatus: 'SOMETHING_NEW', transactionType: 'BUY', tradingSymbol: 'TCS', quantity: 5 },
      ],
      'A1',
    )
    expect(dhan.map((o) => o.status)).toEqual(['COMPLETE', 'PARTIAL', 'EXPIRED', 'UNKNOWN'])
  })

  it('saving order and position snapshots never creates or changes trades or fills', async () => {
    await saveOrderSnapshot('zerodha', 'A1', normalizeZerodhaOrders([zOrder({ order_id: 'a', status: 'REJECTED' })], 'A1'))
    await savePositionSnapshot(
      'zerodha',
      'A1',
      normalizeZerodhaPositions([{ tradingsymbol: 'SBIN', exchange: 'NSE', product: 'MIS', quantity: 10, average_price: 600, realised: 0, unrealised: 50 }], 'A1'),
    )
    expect(await db.brokerOrders.count()).toBe(1)
    expect(await db.brokerPositions.count()).toBe(1)
    expect(await db.trades.count()).toBe(0)
    expect(await db.brokerFills.count()).toBe(0)
  })

  it('replaces the previous snapshot for the same broker+account only', async () => {
    await saveOrderSnapshot('zerodha', 'A1', normalizeZerodhaOrders([zOrder({ order_id: 'old' })], 'A1'))
    await saveOrderSnapshot('dhan', 'A1', normalizeDhanOrders([{ orderId: 'd1', orderStatus: 'TRADED', transactionType: 'BUY', tradingSymbol: 'X', quantity: 1, filledQty: 1 }], 'A1'))
    await saveOrderSnapshot('zerodha', 'A1', normalizeZerodhaOrders([zOrder({ order_id: 'new' })], 'A1'))
    expect((await db.brokerOrders.toArray()).map((o) => o.orderId).sort()).toEqual(['d1', 'new'])
  })

  it('reconciles order-book filled quantities against imported fills', () => {
    const orders = normalizeZerodhaOrders(
      [zOrder({ order_id: 'ok', status: 'COMPLETE', filled_quantity: 10 }), zOrder({ order_id: 'short', status: 'COMPLETE', filled_quantity: 10 }), zOrder({ order_id: 'none', status: 'REJECTED' })],
      'A1',
    )
    const issues = reconcileOrders(orders, [
      { orderId: 'ok', quantity: 6 },
      { orderId: 'ok', quantity: 4 },
      { orderId: 'short', quantity: 6 },
    ])
    expect(issues).toEqual([{ orderId: 'short', symbol: 'SBIN', orderFilled: 10, ledgerFilled: 6 }])
  })
})
