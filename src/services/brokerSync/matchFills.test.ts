import { describe, expect, it } from 'vitest'
import type { Trade } from '../../types'
import { matchFills, type NormalizedFill } from './matchFills'

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

const trade = (over: Partial<Trade>): Trade => ({
  id: 'T1',
  accountId: 'A1',
  tradeDate: '2024-08-01',
  segment: 'CASH',
  scriptName: 'RELIANCE',
  reason: '',
  quantity: 10,
  side: 'BUY',
  entryPrice: 90,
  exitDate: '',
  exitPrice: 0,
  status: 'OPEN',
  grossPnl: 0,
  netPnl: 0,
  notes: 'my own note',
  createdAt: '2024-08-01T00:00:00.000Z',
  updatedAt: '2024-08-01T00:00:00.000Z',
  ...over,
})

describe('matchFills — manual trade protection', () => {
  it('never closes a manual open trade with a broker SELL; flags a possible match instead', () => {
    const manual = trade({ source: 'manual' })
    const legacyManual = trade({ id: 'T2', source: undefined })
    const result = matchFills([fill({ fillId: 'S1', side: 'SELL', price: 120 })], 'A1', [manual, legacyManual])

    expect(result.updatedTrades).toHaveLength(0)
    expect(result.newTrades).toHaveLength(1)
    expect(result.newTrades[0]).toMatchObject({ side: 'SELL', status: 'OPEN', source: 'broker-sync', brokerTradeId: 'S1' })
    expect(result.possibleMatches.map((m) => m.tradeId).sort()).toEqual(['T1', 'T2'])
  })

  it('flags a same-day same-quantity same-side fill as a possible duplicate of a manual trade, without touching it', () => {
    const manual = trade({ tradeDate: '2024-08-14', source: 'manual' })
    const result = matchFills([fill({ fillId: 'B1' })], 'A1', [manual])
    expect(result.possibleMatches).toHaveLength(1)
    expect(result.possibleMatches[0].message).toMatch(/same execution/)
    expect(result.updatedTrades).toHaveLength(0)
  })

  it('still closes trades that earlier broker syncs created', () => {
    const synced = trade({ source: 'broker-sync', brokerTradeId: 'B0' })
    const result = matchFills([fill({ fillId: 'S1', side: 'SELL', price: 120 })], 'A1', [synced])
    expect(result.updatedTrades).toHaveLength(1)
    expect(result.updatedTrades[0]).toMatchObject({ id: 'T1', status: 'CLOSED', exitPrice: 120, brokerExitTradeId: 'S1', grossPnl: 300 })
    expect(result.possibleMatches).toHaveLength(0)
  })
})

describe('matchFills — partial fills and duplicates', () => {
  it('splits a broker-synced trade on a partial exit and keeps the remainder open', () => {
    const synced = trade({ source: 'broker-sync', brokerTradeId: 'B0' })
    const result = matchFills([fill({ fillId: 'S1', side: 'SELL', quantity: 4, price: 110 })], 'A1', [synced])
    expect(result.updatedTrades[0]).toMatchObject({ quantity: 4, status: 'CLOSED' })
    expect(result.newTrades[0]).toMatchObject({ quantity: 6, status: 'OPEN' })
  })

  it('treats several partial fills of one order as separate fills', () => {
    const result = matchFills(
      [
        fill({ fillId: 'X1', orderId: 'O1', quantity: 3 }),
        fill({ fillId: 'X2', orderId: 'O1', quantity: 7 }),
      ],
      'A1',
      [],
    )
    expect(result.newTrades.map((t) => t.quantity).sort()).toEqual([3, 7])
    expect(result.newTrades.map((t) => t.brokerTradeId).sort()).toEqual(['X1', 'X2'])
  })

  it('skips fills already recorded on existing trades (legacy dedup)', () => {
    const synced = trade({ source: 'broker-sync', brokerTradeId: 'B0', status: 'OPEN' })
    const result = matchFills([fill({ fillId: 'B0' })], 'A1', [synced])
    expect(result.skipped).toBe(1)
    expect(result.newTrades).toHaveLength(0)
  })

  it('stamps csv-import provenance when asked', () => {
    const result = matchFills([fill({})], 'A1', [], { source: 'csv-import' })
    expect(result.newTrades[0].source).toBe('csv-import')
  })
})
