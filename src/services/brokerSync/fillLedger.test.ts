import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../database/db'
import type { Trade } from '../../types'
import { SyncInProgressError, dismissReview, getPendingReviews, hasCompletedApiSync, ledgerKey, runFillSync } from './fillLedger'
import type { NormalizedFill } from './matchFills'
import { toBatch } from './normalizeFill'

const fill = (over: Partial<NormalizedFill>): NormalizedFill => ({
  fillId: 'F1',
  symbol: 'RELIANCE',
  segment: 'CASH',
  side: 'BUY',
  quantity: 10,
  price: 100,
  date: '2024-08-14',
  ...over,
})

const manualTrade: Trade = {
  id: 'MANUAL-1',
  accountId: 'A1',
  tradeDate: '2024-08-01',
  segment: 'CASH',
  scriptName: 'RELIANCE',
  reason: 'my thesis',
  quantity: 10,
  side: 'BUY',
  entryPrice: 90,
  exitDate: '',
  exitPrice: 0,
  status: 'OPEN',
  grossPnl: 0,
  netPnl: 0,
  notes: 'typed by hand',
  createdAt: '2024-08-01T00:00:00.000Z',
  updatedAt: '2024-08-01T00:00:00.000Z',
}

const sync = (fills: NormalizedFill[], extra: Partial<Parameters<typeof runFillSync>[0]> = {}) =>
  runFillSync({ broker: 'dhan', accountId: 'A1', kind: 'api', fills, ...extra })

beforeEach(async () => {
  vi.restoreAllMocks()
  await db.delete()
  await db.open()
})

describe('runFillSync — idempotency', () => {
  it('imports fills once; an identical repeat sync creates zero new trades or fills', async () => {
    const fills = [fill({ fillId: 'B1' }), fill({ fillId: 'S1', side: 'SELL', price: 110 })]
    const first = await sync(fills)
    expect(first).toMatchObject({ status: 'success', fillsImported: 2, newTrades: 1 })
    const tradesAfterFirst = await db.trades.toArray()

    const second = await sync(fills)
    expect(second).toMatchObject({ fillsImported: 0, newTrades: 0, updatedTrades: 0, skippedDuplicates: 2 })
    expect(await db.trades.toArray()).toEqual(tradesAfterFirst)
    expect(await db.brokerFills.count()).toBe(2)
  })

  it('does not re-import a fill after its derived trade was deleted by the user', async () => {
    await sync([fill({ fillId: 'B1' })])
    await db.trades.clear()
    const again = await sync([fill({ fillId: 'B1' })])
    expect(again.fillsImported).toBe(0)
    expect(await db.trades.count()).toBe(0)
  })

  it('keeps several partial fills of one order as separate ledger rows', async () => {
    await sync([fill({ fillId: 'X1', orderId: 'O1', quantity: 3 }), fill({ fillId: 'X2', orderId: 'O1', quantity: 7 })])
    const rows = await db.brokerFills.where('orderId').equals('O1').toArray()
    expect(rows.map((r) => r.quantity).sort()).toEqual([3, 7])
  })

  it('ignores a fill repeated inside one batch', async () => {
    const outcome = await sync([fill({ fillId: 'B1' }), fill({ fillId: 'B1' })])
    expect(outcome.fillsImported).toBe(1)
    expect(outcome.skippedDuplicates).toBe(1)
  })
})

describe('runFillSync — interrupted syncs', () => {
  it('rolls back everything when a write fails midway, then a retry succeeds without duplicates', async () => {
    const fills = [fill({ fillId: 'B1' }), fill({ fillId: 'S1', side: 'SELL', quantity: 4, price: 110 })]
    vi.spyOn(db.trades, 'bulkPut').mockRejectedValueOnce(new Error('disk full'))

    await expect(sync(fills)).rejects.toThrow('disk full')
    expect(await db.trades.count()).toBe(0)
    expect(await db.brokerFills.count()).toBe(0)
    const [failedRun] = await db.syncRuns.toArray()
    expect(failedRun).toMatchObject({ status: 'failed', error: 'disk full', fillsImported: 0 })
    expect(await hasCompletedApiSync('dhan', 'A1')).toBe(false)

    const retry = await sync(fills)
    expect(retry.status).toBe('success')
    const trades = await db.trades.toArray()
    // BUY 10 then SELL 4: one closed qty-4 trade + one open qty-6 remainder, no duplicates.
    expect(trades.map((t) => `${t.status}:${t.quantity}`).sort()).toEqual(['CLOSED:4', 'OPEN:6'])
    expect(await db.brokerFills.count()).toBe(2)
    expect(await hasCompletedApiSync('dhan', 'A1')).toBe(true)
  })

  it('refuses to run two syncs at once for the same broker and account', async () => {
    const first = sync([fill({ fillId: 'B1' })])
    await expect(sync([fill({ fillId: 'B2' })])).rejects.toBeInstanceOf(SyncInProgressError)
    await first
    // Lock released afterwards.
    await expect(sync([fill({ fillId: 'B3' })])).resolves.toMatchObject({ status: 'success' })
  })
})

describe('runFillSync — manual trades', () => {
  it('leaves manual trades byte-for-byte unchanged and raises a reviewable possible match', async () => {
    await db.trades.put(manualTrade)
    const outcome = await sync([fill({ fillId: 'S1', side: 'SELL', price: 130 })])

    expect(await db.trades.get('MANUAL-1')).toEqual(manualTrade)
    expect(outcome.possibleMatches).toBe(1)
    const reviews = await getPendingReviews()
    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({ kind: 'possible-match', tradeId: 'MANUAL-1' })

    await dismissReview(reviews[0].id)
    expect(await getPendingReviews()).toHaveLength(0)
    // A later identical sync must not resurrect the dismissed item.
    await sync([fill({ fillId: 'S1', side: 'SELL', price: 130 })])
    expect(await getPendingReviews()).toHaveLength(0)
  })
})

describe('runFillSync — timestamps needing review', () => {
  it('does not import a fill with an unparseable timestamp and flags it instead of using today', async () => {
    const batch = toBatch([
      { fillId: 'G1', symbol: 'TCS', segment: 'CASH', side: 'BUY', quantity: 5, price: 100, timestamp: '2024-08-14 10:00:00' },
      { fillId: 'BAD', symbol: 'TCS', segment: 'CASH', side: 'BUY', quantity: 5, price: 100, timestamp: 'not-a-date' },
    ])
    const outcome = await sync(batch.fills, { rejected: batch.rejected })

    expect(outcome).toMatchObject({ status: 'partial', fillsImported: 1, needsReview: 1 })
    expect(await db.brokerFills.get(ledgerKey('dhan', 'A1', 'BAD'))).toBeUndefined()
    const trades = await db.trades.toArray()
    expect(trades).toHaveLength(1)
    expect(trades[0].tradeDate).toBe('2024-08-14')
    const [review] = await getPendingReviews()
    expect(review).toMatchObject({ kind: 'bad-record', fillId: 'BAD', rawTimestamp: 'not-a-date' })
  })

  it('stores the execution time with its +05:30 offset and notes when the timezone was assumed', async () => {
    const batch = toBatch([{ fillId: 'G1', symbol: 'TCS', segment: 'CASH', side: 'BUY', quantity: 5, price: 100, timestamp: '2024-08-14 10:00:00' }])
    await sync(batch.fills)
    const row = await db.brokerFills.get(ledgerKey('dhan', 'A1', 'G1'))
    expect(row).toMatchObject({ executedAt: '2024-08-14T10:00:00+05:30', timezoneAssumed: true, tradeDate: '2024-08-14' })
  })
})

describe('runFillSync — charges and P&L', () => {
  it('computes net P&L from real charges on both legs and keeps gross separate', async () => {
    await sync([fill({ fillId: 'B1', charges: 5 }), fill({ fillId: 'S1', side: 'SELL', price: 110, charges: 7 })])
    const [trade] = await db.trades.toArray()
    expect(trade).toMatchObject({ grossPnl: 100, charges: 12, netPnl: 88, chargesStatus: 'known' })
  })

  it('marks charges unavailable and does not call gross P&L verified net when charges are missing', async () => {
    await sync([fill({ fillId: 'B1' }), fill({ fillId: 'S1', side: 'SELL', price: 110, charges: 7 })])
    const [trade] = await db.trades.toArray()
    expect(trade).toMatchObject({ grossPnl: 100, chargesStatus: 'unavailable' })
    expect(trade.charges).toBeUndefined()
  })

  it('apportions charges by quantity on a partial close', async () => {
    await sync([fill({ fillId: 'B1', quantity: 10, charges: 10 }), fill({ fillId: 'S1', side: 'SELL', quantity: 4, price: 110, charges: 4 })])
    const closed = (await db.trades.toArray()).find((t) => t.status === 'CLOSED')
    // entry: 10 * 4/10 = 4, exit: 4 * 4/4 = 4
    expect(closed).toMatchObject({ quantity: 4, charges: 8, chargesStatus: 'known' })
  })

  it('does not rewrite existing trades that were never touched by a sync', async () => {
    await db.trades.put({ ...manualTrade, status: 'CLOSED', exitDate: '2024-08-02', exitPrice: 95, grossPnl: 50, netPnl: 50 })
    await sync([fill({ fillId: 'B1', symbol: 'INFY' })])
    expect((await db.trades.get('MANUAL-1'))?.netPnl).toBe(50)
    expect((await db.trades.get('MANUAL-1'))?.chargesStatus).toBeUndefined()
  })
})
