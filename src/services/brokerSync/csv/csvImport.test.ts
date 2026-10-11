import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../../database/db'
import { buildPreview, commitCsvImport, detectPreset, loadExistingLedgerKeys, parseTradebookSheet, suggestMapping } from './csvImport'

const CSV = [
  'Some broker preamble line,,,,,',
  'Trade Date,Symbol,Buy/Sell,Qty,Price,Trade ID',
  '14/08/2024,RELIANCE,BUY,10,2500.50,T100',
  '14/08/2024,RELIANCE,SELL,10,2510,T101',
  '15-08-2024,TCS,B,5,3900,T102',
  '32/13/2024,INFY,BUY,5,1500,T103',
  '14/08/2024,INFY,HOLD,5,1500,T104',
  '14/08/2024,INFY,BUY,0,1500,T105',
  '14/08/2024,INFY,BUY,5,abc,T106',
  '14/08/2024,RELIANCE,BUY,10,2500.50,T100',
].join('\n')

const sheet = parseTradebookSheet(CSV, 'tradebook.csv')

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('CSV parsing and mapping', () => {
  it('finds the real header row below preamble lines and suggests generic mappings', () => {
    expect(sheet.headers).toEqual(['Trade Date', 'Symbol', 'Buy/Sell', 'Qty', 'Price', 'Trade ID'])
    expect(sheet.rows).toHaveLength(8)
    expect(suggestMapping(sheet.headers)).toMatchObject({ date: 'Trade Date', symbol: 'Symbol', side: 'Buy/Sell', quantity: 'Qty', price: 'Price', tradeId: 'Trade ID' })
  })

  it('reports missing required mappings instead of guessing', () => {
    const preview = buildPreview(sheet, { ...suggestMapping(sheet.headers), price: '' }, 'other', 'A1', new Set())
    expect(preview.mappingErrors).toHaveLength(1)
    expect(preview.mappingErrors[0]).toMatch(/^Map a column for "Price/)
    expect(preview.rows).toHaveLength(0)
  })
})

describe('CSV preview validation', () => {
  const mapping = suggestMapping(sheet.headers)

  it('classifies valid, invalid and duplicate rows with row-level reasons', () => {
    const preview = buildPreview(sheet, mapping, 'other', 'A1', new Set())
    expect(preview.counts).toEqual({ valid: 3, warning: 0, invalid: 4, duplicate: 1, 'charge-only': 0 })
    const byRow = (n: number) => preview.rows.find((r) => r.rowNumber === n)!
    expect(byRow(1)).toMatchObject({ status: 'valid' })
    expect(byRow(1).fill).toMatchObject({ date: '2024-08-14', price: 2500.5, side: 'BUY', timezoneAssumed: true })
    expect(byRow(3).fill?.side).toBe('BUY')
    expect(byRow(4).messages.join(' ')).toMatch(/date/i)
    expect(byRow(5).messages.join(' ')).toMatch(/side/i)
    expect(byRow(6).messages.join(' ')).toMatch(/quantity/i)
    expect(byRow(7).messages.join(' ')).toMatch(/price/i)
    expect(byRow(8)).toMatchObject({ status: 'duplicate' })
  })

  it('warns when the segment had to be inferred from the symbol', () => {
    const csv = 'Date,Symbol,Side,Qty,Price\n14/08/2024,NIFTY24AUG24000CE,BUY,50,100'
    const s = parseTradebookSheet(csv, 'x.csv')
    const preview = buildPreview(s, suggestMapping(s.headers), 'other', 'A1', new Set())
    expect(preview.rows[0].status).toBe('warning')
    expect(preview.rows[0].fill?.segment).toBe('OPTIONS')
  })

  it('without a trade id column, identical rows are kept apart by occurrence but a re-upload is still recognised', async () => {
    const csv = 'Date,Symbol,Side,Qty,Price\n14/08/2024,TCS,BUY,5,100\n14/08/2024,TCS,BUY,5,100'
    const s = parseTradebookSheet(csv, 'x.csv')
    const m = suggestMapping(s.headers)
    const first = buildPreview(s, m, 'other', 'A1', new Set())
    expect(first.counts.duplicate).toBe(0)
    await commitCsvImport(first, 'other', 'A1', 'x.csv')
    expect(await db.brokerFills.count()).toBe(2)

    const second = buildPreview(s, m, 'other', 'A1', await loadExistingLedgerKeys('A1'))
    expect(second.counts).toMatchObject({ duplicate: 2, valid: 0, warning: 0 })
  })
})

describe('CSV commit', () => {
  it('imports only valid rows, keeps invalid rows as review items, and re-importing adds nothing', async () => {
    const mapping = suggestMapping(sheet.headers)
    const preview = buildPreview(sheet, mapping, 'other', 'A1', new Set())
    const outcome = await commitCsvImport(preview, 'other', 'A1', 'tradebook.csv')

    expect(outcome).toMatchObject({ status: 'partial', fillsImported: 3, needsReview: 4 })
    const trades = await db.trades.toArray()
    expect(trades.every((t) => t.source === 'csv-import')).toBe(true)
    const tradeCount = trades.length

    const again = buildPreview(sheet, mapping, 'other', 'A1', await loadExistingLedgerKeys('A1'))
    expect(again.counts.valid + again.counts.warning).toBe(0)
    const secondOutcome = await commitCsvImport(again, 'other', 'A1', 'tradebook.csv')
    expect(secondOutcome.fillsImported).toBe(0)
    expect(await db.trades.count()).toBe(tradeCount)
  })

  it('does not touch existing manual trades', async () => {
    const manual = {
      id: 'M1', accountId: 'A1', tradeDate: '2024-08-01', segment: 'CASH' as const, scriptName: 'RELIANCE', reason: '', quantity: 10, side: 'BUY' as const,
      entryPrice: 2400, exitDate: '', exitPrice: 0, status: 'OPEN' as const, grossPnl: 0, netPnl: 0, notes: 'mine', createdAt: 'x', updatedAt: 'x',
    }
    await db.trades.put(manual)
    const preview = buildPreview(sheet, suggestMapping(sheet.headers), 'other', 'A1', new Set())
    await commitCsvImport(preview, 'other', 'A1', 'tradebook.csv')
    expect(await db.trades.get('M1')).toEqual(manual)
  })
})

describe('Angel One "Trades and Charges" format (synthetic rows, same layout as a real export)', () => {
  const header = 'Scrip/Contract,Buy/Sell,Buy Price,Sell Price,Quantity,Brokerage,GST,STT,Sebi Tax,Exchange Turnover Charges,Stamp Duty,Other Charges,IPFT Charges,Order Type,Segment,Exchange,Order ID,Trade ID,Date'
  const csv = [
    'ClientCode,TEST0001',
    'Date Range',
    header,
    'ACME LIMITED,Buy,100,,10,0,0,0,0,0,0,0,0,Delivery,CAPITAL,NSE,O1,T1,2025-11-03 00:00:00',
    'ACME LIMITED,Buy,0,,0,2,0.36,0,0,0,0,0,0,Intraday,CAPITAL,NSE,O1,,2025-11-03 00:00:00',
    'ACME LIMITED,Sell,,110,6,0,0,0.5,0,0.1,0,0,0,Delivery,CAPITAL,NSE,O2,T2,2025-11-04 00:00:00',
    'ACME LIMITED,Sell,,110,4,0,0,0.3,0,0.06,0,0,0,Delivery,CAPITAL,NSE,O2,T3,2025-11-04 00:00:00',
    'ORPHAN LTD,Sell,0,,0,0.01,0,0,0,0,0,0,0,Intraday,CAPITAL,NSE,O9,,2025-11-04 00:00:00',
  ].join('\n')
  const s = parseTradebookSheet(csv, 'tradesandcharges.csv')

  it('is recognised automatically and maps buy/sell price columns', () => {
    const preset = detectPreset(s.headers)
    expect(preset?.broker).toBe('angelone')
    expect(preset?.mapping).toMatchObject({ price: 'Buy Price', sellPrice: 'Sell Price', tradeId: 'Trade ID', orderId: 'Order ID' })
    expect(preset?.chargeColumns).toHaveLength(8)
  })

  it('treats zero-quantity rows as charge-only, uses the right price per side, and rolls charges up per order', () => {
    const preset = detectPreset(s.headers)!
    const preview = buildPreview(s, preset.mapping, 'angelone', 'A1', new Set(), preset.chargeColumns)
    expect(preview.counts).toMatchObject({ valid: 3, invalid: 0, 'charge-only': 2 })
    const fills = preview.rows.filter((r) => r.fill).map((r) => r.fill!)
    expect(fills.map((f) => [f.fillId, f.side, f.price, f.charges])).toEqual([
      ['T1', 'BUY', 100, 2.36],
      ['T2', 'SELL', 110, 0.58], // order O2 charges 0.96 split 6/10
      ['T3', 'SELL', 110, 0.38], // ... and 4/10
    ])
    expect(fills.every((f) => f.segment === 'CASH' && f.date >= '2025-11-03' && f.executedAt === undefined)).toBe(true)
    expect(preview.notes.join(' ')).toMatch(/no trade row in this file/)
  })

  it('imports with real charges on both legs, and a re-import adds nothing', async () => {
    const preset = detectPreset(s.headers)!
    const preview = buildPreview(s, preset.mapping, 'angelone', 'A1', new Set(), preset.chargeColumns)
    await commitCsvImport(preview, 'angelone', 'A1', 'tradesandcharges.csv')
    const closed = (await db.trades.toArray()).filter((t) => t.status === 'CLOSED')
    expect(closed).toHaveLength(2)
    expect(closed.every((t) => t.chargesStatus === 'known' && t.source === 'csv-import')).toBe(true)

    const again = buildPreview(s, preset.mapping, 'angelone', 'A1', await loadExistingLedgerKeys('A1'), preset.chargeColumns)
    expect(again.counts).toMatchObject({ valid: 0, duplicate: 3 })
  })

  it('does not match the Angel One P&L statement layout', () => {
    expect(detectPreset(['Scrip Symbol', 'Company Name', 'Quantity', 'Avg Buy Price', 'Buy Value', 'Avg Sell Price', 'Sell Value', 'Gross PnL', 'Net PnL'])).toBeNull()
  })
})
