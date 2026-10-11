import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceApi } from '../../workspace/api'
import { normalizeAngelOneRows } from './angelOneTradeSync'
import { normalizeDhanRows } from './dhan/dhanTradeSync'
import { getTradeHistory, type DhanTradeRow } from './dhan/dhanApi'
import { getHistoricalTrades, type UpstoxTradeRow } from './upstox/upstoxApi'
import { normalizeUpstoxRows } from './upstox/upstoxTradeSync'
import { normalizeZerodhaRows } from './zerodha/zerodhaTradeSync'
import type { ZerodhaTradeRow } from './zerodha/zerodhaApi'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const dhanRow = (over: Partial<DhanTradeRow>): DhanTradeRow => ({
  orderId: 'O1',
  exchangeTradeId: 'E1',
  transactionType: 'BUY',
  exchangeSegment: 'NSE_EQ',
  tradingSymbol: 'TCS',
  tradedQuantity: 5,
  tradedPrice: 100,
  exchangeTime: '2024-08-14 10:00:00',
  ...over,
})

describe('Dhan normalization', () => {
  it('keeps multiple partial fills of one order separate using exchangeTradeId', () => {
    const { fills, rejected } = normalizeDhanRows([
      dhanRow({ exchangeTradeId: 'E1', tradedQuantity: 3 }),
      dhanRow({ exchangeTradeId: 'E2', tradedQuantity: 7 }),
    ])
    expect(rejected).toHaveLength(0)
    expect(fills.map((f) => f.fillId)).toEqual(['E1', 'E2'])
    expect(fills.every((f) => f.orderId === 'O1')).toBe(true)
  })

  it('never falls back to orderId as the fill id; a row without exchangeTradeId goes to review', () => {
    const { fills, rejected } = normalizeDhanRows([dhanRow({ exchangeTradeId: undefined }), dhanRow({ exchangeTradeId: '' })])
    expect(fills).toHaveLength(0)
    expect(rejected).toHaveLength(2)
    expect(rejected[0].reason).toMatch(/exchange trade/i)
  })

  it('sums charges only when every documented charge field is present', () => {
    const charges = { brokerageCharges: '1', stt: 2, sebiTax: 0.5, serviceTax: 0.5, exchangeTransactionCharges: 1, stampDuty: 1 }
    expect(normalizeDhanRows([dhanRow(charges)]).fills[0].charges).toBe(6)
    expect(normalizeDhanRows([dhanRow({ ...charges, stt: undefined })]).fills[0].charges).toBeUndefined()
    expect(normalizeDhanRows([dhanRow({})]).fills[0].charges).toBeUndefined()
  })

  it('classifies derivatives from documented fields', () => {
    const [opt] = normalizeDhanRows([dhanRow({ exchangeSegment: 'NSE_FNO', drvOptionType: 'CALL' })]).fills
    const [fut] = normalizeDhanRows([dhanRow({ exchangeSegment: 'NSE_FNO', drvOptionType: null })]).fills
    expect([opt.segment, fut.segment]).toEqual(['OPTIONS', 'FUTURES'])
  })

  it('rejects rows with an invalid quantity or price instead of importing zeros', () => {
    const { fills, rejected } = normalizeDhanRows([dhanRow({ tradedQuantity: 0 }), dhanRow({ exchangeTradeId: 'E9', tradedPrice: Number.NaN })])
    expect(fills).toHaveLength(0)
    expect(rejected).toHaveLength(2)
  })
})

describe('Dhan history pagination', () => {
  it('reads pages until an empty one, across 31-day windows', async () => {
    const calls: Array<[string, string, number]> = []
    vi.spyOn(workspaceApi, 'getDhanTradeHistory').mockImplementation(async (_t, from, to, page) => {
      calls.push([from, to, page])
      return page < 2 ? [dhanRow({ exchangeTradeId: `${from}-${page}` })] : []
    })
    const rows = await getTradeHistory('tok', new Date('2024-06-01T00:00:00Z'), new Date('2024-07-15T00:00:00Z'))
    // 45 days -> two windows (31 + 14), each: page 0, page 1, page 2 (empty).
    expect(calls.map((c) => c[2])).toEqual([0, 1, 2, 0, 1, 2])
    expect(rows).toHaveLength(4)
    expect(calls[0][0]).toBe('2024-06-01')
    expect(calls[3][0]).toBe('2024-07-02')
  })
})

describe('Upstox normalization and pagination', () => {
  const todayRow: UpstoxTradeRow = {
    trade_id: 'U1',
    exchange: 'NSE',
    trading_symbol: 'INFY',
    transaction_type: 'BUY',
    quantity: 10,
    average_price: 1500,
    exchange_timestamp: '2024-08-14 11:00:00',
  }
  const historicalRow: UpstoxTradeRow = {
    trade_id: 'U2',
    exchange: 'NFO',
    segment: 'FO',
    symbol: 'NIFTY24AUG24000CE',
    option_type: 'CE',
    transaction_type: 'SELL',
    quantity: 50,
    price: 120,
    trade_date: '2024-08-01',
  }

  it("maps today's rows (average_price, exchange_timestamp) and historical rows (price, trade_date) correctly", () => {
    const { fills, rejected } = normalizeUpstoxRows([todayRow, historicalRow])
    expect(rejected).toHaveLength(0)
    expect(fills[0]).toMatchObject({ symbol: 'INFY', price: 1500, date: '2024-08-14', segment: 'CASH' })
    expect(fills[1]).toMatchObject({ symbol: 'NIFTY24AUG24000CE', price: 120, date: '2024-08-01', segment: 'OPTIONS' })
  })

  it('walks every page using meta_data.page.total_pages instead of stopping after the first', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        const page = Number(new URL(url).searchParams.get('page_number'))
        return new Response(
          JSON.stringify({ status: 'success', data: [{ ...historicalRow, trade_id: `P${page}` }], meta_data: { page: { page_number: page, total_pages: 3, total_records: 3 } } }),
          { status: 200 },
        )
      }),
    )
    const rows = await getHistoricalTrades('tok', { startDate: '2024-06-01', endDate: '2024-08-30' })
    expect(rows.map((r) => r.trade_id)).toEqual(['P1', 'P2', 'P3'])
    expect(urls.map((u) => new URL(u).searchParams.get('page_number'))).toEqual(['1', '2', '3'])
    expect(new URL(urls[0]).searchParams.get('page_size')).toBe('1000')
  })

  it('fails loudly instead of returning a partial set when an API page errors', async () => {
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1
        return n === 1
          ? new Response(JSON.stringify({ status: 'success', data: [historicalRow], meta_data: { page: { total_pages: 2 } } }), { status: 200 })
          : new Response(JSON.stringify({ status: 'error', errors: [{ message: 'rate limited' }] }), { status: 429 })
      }),
    )
    await expect(getHistoricalTrades('tok', { startDate: '2024-06-01', endDate: '2024-08-30' })).rejects.toThrow('rate limited')
  })
})

describe('Zerodha / Angel One normalization', () => {
  const zRow: ZerodhaTradeRow = {
    trade_id: 'Z1',
    order_id: 'ZO1',
    exchange: 'NSE',
    tradingsymbol: 'SBIN',
    instrument_token: '1',
    product: 'CNC',
    average_price: 600,
    transaction_type: 'BUY',
    exchange_timestamp: '2024-08-14 09:20:00',
  }

  it('accepts either quantity or filled for the executed quantity', () => {
    expect(normalizeZerodhaRows([{ ...zRow, quantity: 5 }]).fills[0].quantity).toBe(5)
    expect(normalizeZerodhaRows([{ ...zRow, filled: 8 }]).fills[0].quantity).toBe(8)
    expect(normalizeZerodhaRows([zRow]).rejected).toHaveLength(1)
  })

  it('flags an Angel One row with an unparseable time instead of dating it today', () => {
    const batch = normalizeAngelOneRows([
      { tradingsymbol: 'SBIN-EQ', symboltoken: '1', exchange: 'NSE', producttype: 'DELIVERY', transactiontype: 'BUY', fillprice: 600, fillsize: 5, orderid: 'O', tradeid: 'T1', filltime: '??:??' },
    ])
    expect(batch.fills).toHaveLength(0)
    expect(batch.rejected[0].rawTimestamp).toBe('??:??')
  })
})
