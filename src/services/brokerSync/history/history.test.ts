// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Trade } from '../../../types'
import { createDhanHistoryFetcher, normalizeDhanHistoryRow } from '../dhan/dhanHistory'
import type { DhanTradeRow } from '../dhan/dhanApi'
import { createUpstoxHistoryFetcher, normalizeUpstoxHistoryRow } from '../upstox/upstoxHistory'
import { createZerodhaTodayFetcher } from '../zerodha/zerodhaHistory'
import type { ZerodhaTradeRow } from '../zerodha/zerodhaApi'
import { createAngelOneTodayFetcher } from '../angelOneHistory'
import type { AngelOneSession, AngelOneTradeBookRow } from '../../marketData/adapters/angelOne/angelOneApi'
import type { UpstoxTradeRow } from '../upstox/upstoxApi'
import { HISTORY_CAPABILITIES, planIntervals, upstoxEarliestDate } from './capabilities'
import { addDays, exactDatePart, inclusiveDays, presetRange, splitIntoIntervals, validateRange } from './dateRange'
import { runHistorySync, type FetchFills, type HistoryReport } from './runHistorySync'
import { matchFills, type NormalizedFill } from '../matchFills'

const TODAY = '2026-10-29'

describe('date ranges', () => {
  it('validates the range', () => {
    expect(validateRange('2021-01-01', '2026-10-29', TODAY)).toBeNull()
    expect(validateRange('', '2026-10-29', TODAY)).toMatch(/both/)
    expect(validateRange('2026-02-30', '2026-03-01', TODAY)).toMatch(/real calendar/)
    expect(validateRange('2026-05-02', '2026-05-01', TODAY)).toMatch(/on or before/)
    expect(validateRange('2026-05-01', '2026-10-30', TODAY)).toMatch(/future/)
  })

  it('builds the quick filters from today', () => {
    expect(presetRange('last7', TODAY, '2020-01-01')).toEqual({ from: '2026-10-23', to: TODAY })
    expect(presetRange('last30', TODAY, '2020-01-01')).toEqual({ from: '2026-09-30', to: TODAY })
    expect(presetRange('thisYear', TODAY, '2020-01-01')).toEqual({ from: '2026-01-01', to: TODAY })
    expect(presetRange('all', TODAY, '2023-04-01')).toEqual({ from: '2023-04-01', to: TODAY })
  })

  it('does date arithmetic without time-zone drift, across leap days and year ends', () => {
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01')
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01')
    expect(inclusiveDays('2026-01-01', '2026-01-01')).toBe(1)
    expect(inclusiveDays('2024-01-01', '2024-12-31')).toBe(366)
  })

  it('cuts a multi-year range into consecutive pieces with no gap and no overlap', () => {
    const pieces = splitIntoIntervals('2021-01-01', '2026-10-29', 90)
    expect(pieces[0].from).toBe('2021-01-01')
    expect(pieces[pieces.length - 1].to).toBe('2026-10-29')
    for (let i = 1; i < pieces.length; i += 1) expect(pieces[i].from).toBe(addDays(pieces[i - 1].to, 1))
    expect(pieces.every((p) => inclusiveDays(p.from, p.to) <= 90)).toBe(true)
    expect(pieces.reduce((n, p) => n + inclusiveDays(p.from, p.to), 0)).toBe(inclusiveDays('2021-01-01', '2026-10-29'))
    expect(splitIntoIntervals('2026-10-29', '2026-10-29', 90)).toEqual([{ from: '2026-10-29', to: '2026-10-29' }])
  })

  it('reads a broker timestamp’s date exactly, and never invents one', () => {
    expect(exactDatePart('2022-12-30 10:00:46')).toBe('2022-12-30')
    expect(exactDatePart('2022-12-30T23:59:59+05:30')).toBe('2022-12-30')
    expect(exactDatePart('NA')).toBeNull()
    expect(exactDatePart(null)).toBeNull()
    expect(exactDatePart('2022-13-40 10:00')).toBeNull()
  })
})

describe('what each broker can supply', () => {
  it('limits Upstox to the current and previous two financial years', () => {
    expect(upstoxEarliestDate('2026-10-29')).toBe('2024-04-01')
    expect(upstoxEarliestDate('2026-03-31')).toBe('2023-04-01') // still FY 2025-26
    expect(upstoxEarliestDate('2026-04-01')).toBe('2024-04-01')
  })

  it('marks the part of an Upstox range older than that as unavailable, and requests only the rest', () => {
    const plan = planIntervals(HISTORY_CAPABILITIES.upstox, '2021-01-01', '2026-10-29', TODAY)
    expect(plan.unavailable).toHaveLength(1)
    expect(plan.unavailable[0]).toMatchObject({ from: '2021-01-01', to: '2024-03-31' })
    expect(plan.runnable[0].from).toBe('2024-04-01')
    expect(plan.runnable[plan.runnable.length - 1].to).toBe('2026-10-29')
  })

  it('asks Upstox for nothing when the whole range is too old', () => {
    const plan = planIntervals(HISTORY_CAPABILITIES.upstox, '2020-01-01', '2021-12-31', TODAY)
    expect(plan.runnable).toEqual([])
    expect(plan.unavailable).toHaveLength(1)
  })

  it('splits a Dhan range of several years into 90-day requests with nothing marked unavailable', () => {
    const plan = planIntervals(HISTORY_CAPABILITIES.dhan, '2021-01-01', '2026-10-29', TODAY)
    expect(plan.unavailable).toEqual([])
    expect(plan.runnable.length).toBeGreaterThan(20)
  })
})

const dhanRow = (over: Partial<DhanTradeRow> = {}): DhanTradeRow => ({
  dhanClientId: '1', orderId: 'O1', exchangeOrderId: 'E1', exchangeTradeId: '407958', transactionType: 'BUY', exchangeSegment: 'NSE_EQ', productType: 'CNC', orderType: 'MARKET',
  tradingSymbol: null, customSymbol: 'Tata Motors', securityId: '3456', tradedQuantity: 10, tradedPrice: 390.9, createTime: 'NA', updateTime: 'NA', exchangeTime: '2022-12-30 10:00:46', ...over,
})

describe('Dhan history', () => {
  it('maps a row using Dhan’s own fields, including a missing trading symbol', () => {
    expect(normalizeDhanHistoryRow(dhanRow())).toEqual({
      fillId: '407958@2022-12-30', symbol: 'Tata Motors', segment: 'CASH', side: 'BUY', quantity: 10, price: 390.9, date: '2022-12-30',
    })
  })

  it('rejects rows without a real date, quantity or price instead of guessing', () => {
    expect(normalizeDhanHistoryRow(dhanRow({ exchangeTime: 'NA' }))).toBeNull()
    expect(normalizeDhanHistoryRow(dhanRow({ tradedQuantity: 0 }))).toBeNull()
    expect(normalizeDhanHistoryRow(dhanRow({ tradedPrice: 0 }))).toBeNull()
  })

  it('gives the same trade number on different days different identities', () => {
    const a = normalizeDhanHistoryRow(dhanRow({ exchangeTime: '2023-01-02 10:00:00' }))
    const b = normalizeDhanHistoryRow(dhanRow({ exchangeTime: '2023-01-03 10:00:00' }))
    expect(a?.fillId).not.toBe(b?.fillId)
  })

  it('reads page after page until an empty one, counting unusable rows', async () => {
    const pages = [[dhanRow({ exchangeTradeId: '1' }), dhanRow({ exchangeTradeId: '2', exchangeTime: 'NA' })], [dhanRow({ exchangeTradeId: '3' })], []]
    const loadPage = vi.fn(async (_t: string, _f: string, _to: string, page: number) => pages[page] ?? [])
    const result = await createDhanHistoryFetcher('tok', loadPage)({ from: '2022-12-01', to: '2022-12-31' })
    expect(loadPage.mock.calls.map((c) => c[3])).toEqual([0, 1, 2])
    expect(result.fills.map((f) => f.fillId)).toEqual(['1@2022-12-30', '3@2022-12-30'])
    expect(result.rejected).toBe(1)
  })

  it('stops if Dhan ignores the page number and repeats a page', async () => {
    const loadPage = vi.fn(async () => [dhanRow()])
    const result = await createDhanHistoryFetcher('tok', loadPage)({ from: '2022-12-01', to: '2022-12-31' })
    expect(loadPage).toHaveBeenCalledTimes(2)
    expect(result.fills).toHaveLength(1) // the repeated page is recognised and dropped, never looped on
  })
})

const upstoxRow = (over: Partial<UpstoxTradeRow> = {}): UpstoxTradeRow => ({
  trade_id: 'U1', exchange: 'NSE', segment: 'EQ', symbol: 'INFY', transaction_type: 'SELL', quantity: 5, price: 1500, trade_date: '2025-06-10', ...over,
})

describe('Upstox history', () => {
  it('maps a row and rejects an unusable one', () => {
    expect(normalizeUpstoxHistoryRow(upstoxRow())).toMatchObject({ fillId: 'U1@2025-06-10', symbol: 'INFY', segment: 'CASH', side: 'SELL', quantity: 5, price: 1500, date: '2025-06-10' })
    expect(normalizeUpstoxHistoryRow(upstoxRow({ trade_date: '' }))).toBeNull()
  })

  it('pages from 1 and stops at the first page shorter than the page size', async () => {
    const full = [upstoxRow({ trade_id: 'a' }), upstoxRow({ trade_id: 'b' })]
    const loadPage = vi.fn(async (_t: string, p: { page: number }) => (p.page === 1 ? full : p.page === 2 ? full : [upstoxRow({ trade_id: 'c' })]))
    const result = await createUpstoxHistoryFetcher('tok', loadPage, 2)({ from: '2025-06-01', to: '2025-06-30' })
    expect(loadPage.mock.calls.map((c) => c[1].page)).toEqual([1, 2, 3])
    expect(loadPage.mock.calls[0][1]).toMatchObject({ startDate: '2025-06-01', endDate: '2025-06-30', pageSize: 2 })
    expect(result.fills).toHaveLength(5)
  })
})

// ---- the sync itself -------------------------------------------------------------------------------------------------

const fill = (id: string, date: string, side: 'BUY' | 'SELL', quantity = 10, price = 100, symbol = 'INFY'): NormalizedFill => ({
  fillId: `${id}@${date}`, symbol, segment: 'CASH', side, quantity, price, date,
})

function harness(existing: Trade[] = []) {
  const saved = new Map<string, Trade>(existing.map((t) => [t.id, t]))
  return {
    saved,
    persistTrade: async (trade: Trade) => {
      saved.set(trade.id, trade)
      return true
    },
    existing: () => [...saved.values()],
  }
}

const plan = (from: string, to: string) => planIntervals(HISTORY_CAPABILITIES.dhan, from, to, TODAY)

describe('runHistorySync', () => {
  it('imports a multi-interval range, pairing a buy and a later sell across intervals', async () => {
    const h = harness()
    const fetchFills: FetchFills = async (iv) => ({
      fills: iv.from === '2026-01-01' ? [fill('1', '2026-01-10', 'BUY', 10, 100)] : [fill('2', '2026-04-20', 'SELL', 10, 130)],
      rejected: 0,
    })
    const p = { runnable: [{ from: '2026-01-01', to: '2026-03-31' }, { from: '2026-04-01', to: '2026-06-29' }], unavailable: [] }
    const report = await runHistorySync({ accountId: 'A', range: { from: '2026-01-01', to: '2026-06-29' }, plan: p, fetchFills, existingTrades: [], persistTrade: h.persistTrade })

    expect(report.outcome).toBe('completed')
    expect(report.complete).toBe(true)
    const closed = h.existing().filter((t) => t.status === 'CLOSED')
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ tradeDate: '2026-01-10', exitDate: '2026-04-20', entryPrice: 100, exitPrice: 130, grossPnl: 300, accountId: 'A', source: 'broker-sync' })
  })

  it('syncing the same period again adds nothing and keeps what was imported', async () => {
    const h = harness()
    const fetchFills: FetchFills = async () => ({ fills: [fill('1', '2026-01-10', 'BUY'), fill('2', '2026-01-12', 'SELL', 10, 110)], rejected: 0 })
    const args = { accountId: 'A', range: { from: '2026-01-01', to: '2026-01-31' }, plan: plan('2026-01-01', '2026-01-31'), fetchFills, persistTrade: h.persistTrade }

    const first = await runHistorySync({ ...args, existingTrades: [] })
    const before = h.existing()
    const second = await runHistorySync({ ...args, existingTrades: h.existing() })

    expect(first.imported).toBe(1)
    expect(second.imported).toBe(0)
    expect(second.skippedDuplicates).toBe(2)
    expect(second.complete).toBe(true)
    expect(h.existing()).toEqual(before)
  })

  it('applies a fill once even when two intervals both return it', async () => {
    const h = harness()
    const repeated = fill('1', '2026-01-31', 'BUY')
    const fetchFills: FetchFills = async () => ({ fills: [repeated], rejected: 0 })
    const p = { runnable: [{ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-01-31', to: '2026-02-28' }], unavailable: [] }
    const report = await runHistorySync({ accountId: 'A', range: { from: '2026-01-01', to: '2026-02-28' }, plan: p, fetchFills, existingTrades: [], persistTrade: h.persistTrade })
    expect(h.existing()).toHaveLength(1)
    expect(report.skippedDuplicates).toBe(1)
  })

  it('recognises trades imported by the older bare-id sync, but not the same number on another day', () => {
    const legacy = { id: 'old', accountId: 'A', tradeDate: '2026-01-10', brokerTradeId: '777', status: 'OPEN', segment: 'CASH', scriptName: 'INFY', side: 'BUY', quantity: 10, entryPrice: 100 } as Trade
    const same = matchFills([fill('777', '2026-01-10', 'BUY')], 'A', [legacy])
    expect(same.skipped).toBe(1)
    expect(same.newTrades).toHaveLength(0)
    const otherDay = matchFills([fill('777', '2026-03-02', 'BUY')], 'A', [legacy])
    expect(otherDay.skipped).toBe(0)
    expect(otherDay.newTrades).toHaveLength(1)
    // and the other direction: an old-style sync of today's fill after a history sync stored the dated id
    const dated = { ...legacy, brokerTradeId: '777@2026-01-10' } as Trade
    expect(matchFills([{ ...fill('777', '2026-01-10', 'BUY'), fillId: '777' }], 'A', [dated]).skipped).toBe(1)
  })

  it('stops at the first failed interval, keeps earlier ones, and resumes there on retry', async () => {
    const h = harness()
    let failSecond = true
    const fetchFills: FetchFills = async (iv) => {
      if (iv.from === '2026-02-01' && failSecond) throw Object.assign(new Error('Dhan access token is invalid or expired'), { kind: 'auth' })
      return { fills: [fill(iv.from, iv.from, 'BUY', 1, 100, `S${iv.from}`)], rejected: 0 }
    }
    const p = { runnable: [{ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-02-01', to: '2026-02-28' }, { from: '2026-03-01', to: '2026-03-31' }], unavailable: [] }
    const base = { accountId: 'A', range: { from: '2026-01-01', to: '2026-03-31' }, plan: p, fetchFills, persistTrade: h.persistTrade }

    const first = await runHistorySync({ ...base, existingTrades: [] })
    expect(first.intervals.map((i) => i.status)).toEqual(['done', 'failed', 'pending'])
    expect(first.intervals[1]).toMatchObject({ errorKind: 'auth', error: expect.stringContaining('expired') })
    expect(first.outcome).toBe('partial')
    expect(first.complete).toBe(false)
    expect(h.existing()).toHaveLength(1) // January was kept

    failSecond = false
    const retried = await runHistorySync({ ...base, existingTrades: h.existing(), resumeFrom: first })
    expect(retried.intervals.map((i) => i.status)).toEqual(['done', 'done', 'done'])
    expect(retried.complete).toBe(true)
    expect(retried.imported).toBe(3)
    expect(h.existing()).toHaveLength(3)
  })

  it('reports a total failure as failed, not partial or completed', async () => {
    const h = harness()
    const fetchFills: FetchFills = async () => {
      throw new Error('Could not reach Dhan.')
    }
    const report = await runHistorySync({ accountId: 'A', range: { from: '2026-01-01', to: '2026-01-31' }, plan: plan('2026-01-01', '2026-01-31'), fetchFills, existingTrades: [], persistTrade: h.persistTrade })
    expect(report.outcome).toBe('failed')
    expect(report.complete).toBe(false)
  })

  it('never calls a sync complete while part of the range is unavailable', async () => {
    const h = harness()
    const fetchFills: FetchFills = async () => ({ fills: [fill('1', '2024-05-01', 'BUY')], rejected: 0 })
    const report = await runHistorySync({
      accountId: 'A', range: { from: '2021-01-01', to: '2024-06-30' }, plan: planIntervals(HISTORY_CAPABILITIES.upstox, '2021-01-01', '2024-06-30', TODAY), fetchFills,
      existingTrades: [], persistTrade: h.persistTrade,
    })
    expect(report.unavailable).toHaveLength(1)
    expect(report.outcome).toBe('partial')
    expect(report.complete).toBe(false)
  })

  it('never calls a sync complete when broker rows had to be rejected', async () => {
    const h = harness()
    const fetchFills: FetchFills = async () => ({ fills: [fill('1', '2026-01-05', 'BUY')], rejected: 2 })
    const report = await runHistorySync({ accountId: 'A', range: { from: '2026-01-01', to: '2026-01-31' }, plan: plan('2026-01-01', '2026-01-31'), fetchFills, existingTrades: [], persistTrade: h.persistTrade })
    expect(report.rejectedRows).toBe(2)
    expect(report.complete).toBe(false)
    expect(report.outcome).toBe('partial')
  })

  it('marks the interval failed when a trade can’t be saved, and finishes it on retry without duplicates', async () => {
    const h = harness()
    let allowSave = false
    const persist = async (t: Trade) => (allowSave ? h.persistTrade(t) : false)
    const fetchFills: FetchFills = async () => ({ fills: [fill('1', '2026-01-05', 'BUY')], rejected: 0 })
    const base = { accountId: 'A', range: { from: '2026-01-01', to: '2026-01-31' }, plan: plan('2026-01-01', '2026-01-31'), fetchFills, persistTrade: persist }
    const first = await runHistorySync({ ...base, existingTrades: [] })
    expect(first.intervals[0]).toMatchObject({ status: 'failed', errorKind: 'save' })
    allowSave = true
    const second = await runHistorySync({ ...base, existingTrades: h.existing(), resumeFrom: first })
    expect(second.complete).toBe(true)
    expect(h.existing()).toHaveLength(1)
  })

  it('only touches the chosen account’s trades', async () => {
    const other = { id: 'x', accountId: 'OTHER', tradeDate: '2026-01-02', segment: 'CASH', scriptName: 'INFY', side: 'BUY', quantity: 10, entryPrice: 90, status: 'OPEN', exitDate: '', exitPrice: 0, grossPnl: 0, netPnl: 0, reason: '', notes: '', createdAt: '', updatedAt: '' } as Trade
    const h = harness([other])
    const fetchFills: FetchFills = async () => ({ fills: [fill('2', '2026-01-10', 'SELL', 10, 120)], rejected: 0 })
    await runHistorySync({ accountId: 'A', range: { from: '2026-01-01', to: '2026-01-31' }, plan: plan('2026-01-01', '2026-01-31'), fetchFills, existingTrades: [other], persistTrade: h.persistTrade })
    expect(h.saved.get('x')).toEqual(other) // the other account's open trade was not closed by this account's fill
    expect(h.existing().filter((t) => t.accountId === 'A')).toHaveLength(1)
  })

  it('stops cleanly when cancelled and reports it as cancelled', async () => {
    const h = harness()
    const controller = new AbortController()
    const fetchFills: FetchFills = async (iv) => {
      controller.abort()
      return { fills: [fill(iv.from, iv.from, 'BUY', 1, 100, `S${iv.from}`)], rejected: 0 }
    }
    const p = { runnable: [{ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-02-01', to: '2026-02-28' }], unavailable: [] }
    const report = await runHistorySync({ accountId: 'A', range: { from: '2026-01-01', to: '2026-02-28' }, plan: p, fetchFills, existingTrades: [], persistTrade: h.persistTrade, signal: controller.signal })
    expect(report.outcome).toBe('cancelled')
    expect(report.intervals[1].status).toBe('pending')
  })

  it('reports progress as it goes', async () => {
    const h = harness()
    const seen: HistoryReport[] = []
    const fetchFills: FetchFills = async () => ({ fills: [], rejected: 0 })
    await runHistorySync({ accountId: 'A', range: { from: '2026-01-01', to: '2026-01-31' }, plan: plan('2026-01-01', '2026-01-31'), fetchFills, existingTrades: [], persistTrade: h.persistTrade, onProgress: (r) => seen.push(r) })
    expect(seen.some((r) => r.intervals.some((i) => i.status === 'running'))).toBe(true)
    expect(seen[seen.length - 1].outcome).toBe('completed')
  })
})

describe('Zerodha and Angel One only serve today', () => {
  it('plans today as the only request and marks every earlier day unavailable', () => {
    for (const id of ['zerodha', 'angelone'] as const) {
      const plan = planIntervals(HISTORY_CAPABILITIES[id], '2026-10-01', TODAY, TODAY)
      expect(plan.runnable).toEqual([{ from: TODAY, to: TODAY }])
      expect(plan.unavailable).toHaveLength(1)
      expect(plan.unavailable[0]).toMatchObject({ from: '2026-10-01', to: '2026-10-28' })
      expect(plan.unavailable[0].reason).toMatch(/today/i)
    }
  })

  it('requests nothing when the range ends before today, and still never fakes the data', () => {
    const plan = planIntervals(HISTORY_CAPABILITIES.zerodha, '2025-01-01', '2025-12-31', TODAY)
    expect(plan.runnable).toEqual([])
    expect(plan.unavailable).toEqual([expect.objectContaining({ from: '2025-01-01', to: '2025-12-31' })])
  })

  it('a today-only sync that works is still reported as partial for a longer range, never complete', async () => {
    const h = harness()
    const fetchFills: FetchFills = async () => ({ fills: [fill('1', TODAY, 'BUY')], rejected: 0 })
    const report = await runHistorySync({
      accountId: 'A', range: { from: '2026-10-01', to: TODAY }, plan: planIntervals(HISTORY_CAPABILITIES.zerodha, '2026-10-01', TODAY, TODAY), fetchFills, existingTrades: [], persistTrade: h.persistTrade,
    })
    expect(report.imported).toBe(1)
    expect(report.outcome).toBe('partial')
    expect(report.complete).toBe(false)
  })

  it('a range that is only today can be completed', async () => {
    const h = harness()
    const fetchFills: FetchFills = async () => ({ fills: [fill('1', TODAY, 'BUY')], rejected: 0 })
    const report = await runHistorySync({
      accountId: 'A', range: { from: TODAY, to: TODAY }, plan: planIntervals(HISTORY_CAPABILITIES.angelone, TODAY, TODAY, TODAY), fetchFills, existingTrades: [], persistTrade: h.persistTrade,
    })
    expect(report.outcome).toBe('completed')
  })

  it('Zerodha: identifies fills by id and date, and rejects rows with no usable quantity or price', async () => {
    const row = (over: Partial<ZerodhaTradeRow> = {}): ZerodhaTradeRow => ({
      trade_id: '55', order_id: 'o', exchange: 'NSE', tradingsymbol: 'INFY', instrument_token: '1', product: 'CNC', average_price: 1500, quantity: 3, transaction_type: 'BUY',
      exchange_timestamp: '2026-10-29 10:15:00', ...over,
    })
    const loadTrades = vi.fn(async () => [row(), row({ trade_id: '56', quantity: 0 })])
    const result = await createZerodhaTodayFetcher('key', 'tok', loadTrades)({ from: TODAY, to: TODAY })
    expect(loadTrades).toHaveBeenCalledWith('key', 'tok')
    expect(result.fills).toEqual([expect.objectContaining({ fillId: '55@2026-10-29', symbol: 'INFY', side: 'BUY', quantity: 3, price: 1500 })])
    expect(result.rejected).toBe(1)
  })

  it('Angel One: identifies fills by id and date, and rejects unusable rows', async () => {
    const row = (over: Partial<AngelOneTradeBookRow> = {}): AngelOneTradeBookRow => ({
      tradingsymbol: 'SBIN-EQ', symboltoken: '3045', exchange: 'NSE', producttype: 'DELIVERY', transactiontype: 'SELL', fillprice: 800, fillsize: 4, orderid: 'o', tradeid: '77',
      filltime: '10:15:00', exchtime: '2026-10-29T10:15:00', ...over,
    })
    const loadTradeBook = vi.fn(async () => [row(), row({ tradeid: '78', fillprice: 0 })])
    const session = { jwtToken: 'x' } as unknown as AngelOneSession
    const result = await createAngelOneTodayFetcher(session, loadTradeBook)({ from: TODAY, to: TODAY })
    expect(loadTradeBook).toHaveBeenCalledWith(session)
    expect(result.fills).toEqual([expect.objectContaining({ fillId: '77@2026-10-29', symbol: 'SBIN-EQ', side: 'SELL', quantity: 4, price: 800 })])
    expect(result.rejected).toBe(1)
  })
})
