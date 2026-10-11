/**
 * Tradebook CSV/XLSX import: parse -> map columns -> preview/validate -> (only on user confirm) commit.
 *
 * There are NO broker-specific presets. Real export formats from Angel One / Zerodha / Upstox /
 * Dhan have not been validated against sample files, so nothing here assumes a documented
 * layout. `suggestMapping` only matches generic header names; the user can always override every
 * column in the UI, and the preview shows exactly what would be imported before anything is written.
 */
import * as XLSX from 'xlsx'
import { db, type SyncBroker } from '../../../database/db'
import type { TradingSegment } from '../../../types'
import { parseBrokerTimestamp } from '../dates'
import { ledgerKey, runFillSync, type SyncOutcome } from '../fillLedger'
import type { NormalizedFill, RejectedFill } from '../matchFills'
import { parseSide, toFill } from '../normalizeFill'

export type MappingField = 'date' | 'time' | 'symbol' | 'side' | 'quantity' | 'price' | 'sellPrice' | 'tradeId' | 'orderId' | 'exchange' | 'segment' | 'charges'
export type ColumnMapping = Record<MappingField, string>

export const REQUIRED_FIELDS: MappingField[] = ['date', 'symbol', 'side', 'quantity', 'price']

export const FIELD_LABELS: Record<MappingField, string> = {
  date: 'Trade date',
  time: 'Trade time (optional)',
  symbol: 'Symbol',
  side: 'Buy/Sell',
  quantity: 'Quantity',
  price: 'Price (or Buy price when sell price is a separate column)',
  sellPrice: 'Sell price (optional, only if separate from buy price)',
  tradeId: 'Trade ID (optional, recommended)',
  orderId: 'Order ID (optional)',
  exchange: 'Exchange (optional)',
  segment: 'Segment (optional)',
  charges: 'Total charges (optional)',
}

/** Generic header spellings only — not a claim about any broker's official export format. */
const ALIASES: Record<MappingField, string[]> = {
  date: ['date', 'tradedate', 'tradingdate', 'executiondate', 'orderexecutiontime', 'exchangetimestamp', 'filltimestamp', 'datetime'],
  time: ['time', 'tradetime', 'executiontime', 'executedtime'],
  symbol: ['symbol', 'tradingsymbol', 'scripcontract', 'scrip', 'scripname', 'instrument', 'stock', 'securityname', 'stockname'],
  side: ['side', 'buysell', 'bs', 'tradetype', 'transactiontype', 'type', 'buyorsell'],
  quantity: ['quantity', 'qty', 'tradedqty', 'tradedquantity', 'filledquantity', 'quantitytraded'],
  sellPrice: ['sellprice', 'sellrate'],
  price: ['price', 'tradeprice', 'tradedprice', 'averageprice', 'avgprice', 'rate', 'marketrate'],
  tradeId: ['tradeid', 'tradeno', 'tradenumber', 'exchangetradeid', 'executionid', 'fillid'],
  orderId: ['orderid', 'orderno', 'ordernumber'],
  exchange: ['exchange'],
  segment: ['segment', 'instrumenttype'],
  charges: ['charges', 'totalcharges'],
}

const normalizeHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, '')

export interface ParsedSheet {
  headers: string[]
  rows: Array<Record<string, unknown>>
}

export function emptyMapping(): ColumnMapping {
  return { date: '', time: '', symbol: '', side: '', quantity: '', price: '', sellPrice: '', tradeId: '', orderId: '', exchange: '', segment: '', charges: '' }
}

export interface ImportPreset {
  name: string
  broker: SyncBroker
  mapping: ColumnMapping
  /** Per-row charge columns that are summed (and rolled up per order id) into a fill's charges. */
  chargeColumns: string[]
}

const CHARGE_HEADER_PREFIXES = ['brokerage', 'gst', 'stt', 'sebitax', 'exchangeturnover', 'stampduty', 'othercharges', 'ipftcharges']

/**
 * Angel One "Trades and Charges" export (Accounts -> Trades and Charges -> Download Trade History).
 * Validated against ONE real file (FY2025-26 export: columns Scrip/Contract, Buy/Sell, Buy Price,
 * Sell Price, Quantity, per-charge columns, Order Type, Segment, Exchange, Order ID, Trade ID, Date).
 * Other Angel One report layouts (e.g. the P&L statement) are NOT matched and will not import.
 */
export function detectPreset(headers: string[]): ImportPreset | null {
  const byNorm = new Map(headers.map((h) => [normalizeHeader(h), h]))
  const needed = ['scripcontract', 'buysell', 'buyprice', 'sellprice', 'quantity', 'orderid', 'tradeid', 'date']
  if (!needed.every((n) => byNorm.has(n))) return null
  const mapping = emptyMapping()
  mapping.date = byNorm.get('date') as string
  mapping.symbol = byNorm.get('scripcontract') as string
  mapping.side = byNorm.get('buysell') as string
  mapping.quantity = byNorm.get('quantity') as string
  mapping.price = byNorm.get('buyprice') as string
  mapping.sellPrice = byNorm.get('sellprice') as string
  mapping.tradeId = byNorm.get('tradeid') as string
  mapping.orderId = byNorm.get('orderid') as string
  mapping.exchange = byNorm.get('exchange') ?? ''
  mapping.segment = byNorm.get('segment') ?? ''
  const chargeColumns = headers.filter((h) => CHARGE_HEADER_PREFIXES.some((p) => normalizeHeader(h).startsWith(p)))
  return { name: 'Angel One "Trades and Charges"', broker: 'angelone', mapping, chargeColumns }
}

export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping = emptyMapping()
  const used = new Set<string>()
  for (const field of Object.keys(ALIASES) as MappingField[]) {
    const hit = headers.find((h) => !used.has(h) && ALIASES[field].includes(normalizeHeader(h)))
    if (hit) {
      mapping[field] = hit
      used.add(hit)
    }
  }
  return mapping
}

/** Header row = the first row (within the first 40) with the most generic-alias hits; broker files often carry preamble lines above it. */
function findHeaderRow(matrix: unknown[][]): number {
  const allAliases = new Set(Object.values(ALIASES).flat())
  let best = 0
  let bestScore = -1
  for (let i = 0; i < Math.min(matrix.length, 40); i += 1) {
    const score = matrix[i].filter((c) => typeof c === 'string' && allAliases.has(normalizeHeader(c))).length
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  }
  return best
}

export function parseTradebookSheet(data: ArrayBuffer | string, fileName: string): ParsedSheet {
  const isCsv = /\.csv$/i.test(fileName) || typeof data === 'string'
  // raw:true keeps CSV cells as the original text, so dates like 05/06/2024 are never silently re-interpreted by the spreadsheet parser.
  const workbook = isCsv
    ? XLSX.read(typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data), { type: 'string', raw: true })
    : XLSX.read(data, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error('The file has no readable sheet.')

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' })
  if (matrix.length === 0) throw new Error('The file is empty.')

  const headerIndex = findHeaderRow(matrix)
  const seen = new Map<string, number>()
  const headers = matrix[headerIndex].map((cell, i) => {
    const base = String(cell ?? '').trim() || `Column ${i + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base} (${count + 1})`
  })

  const rows = matrix
    .slice(headerIndex + 1)
    .filter((r) => r.some((c) => String(c ?? '').trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])))
  return { headers, rows }
}

export type PreviewStatus = 'valid' | 'warning' | 'invalid' | 'duplicate' | 'charge-only'

export interface PreviewRow {
  /** 1-based data row number (excluding the header row), for error messages. */
  rowNumber: number
  status: PreviewStatus
  messages: string[]
  fill?: NormalizedFill
}

export interface ImportPreview {
  mappingErrors: string[]
  /** File-level notes that apply to every row (not per-row warnings). */
  notes: string[]
  rows: PreviewRow[]
  counts: Record<PreviewStatus, number>
}

function inferSegmentFromText(segmentText: string, symbol: string): { segment: TradingSegment; inferred: boolean } {
  const seg = segmentText.toUpperCase()
  if (seg) {
    if (/OPT|OPTION/.test(seg)) return { segment: 'OPTIONS', inferred: false }
    if (/FUT|FNO|F&O/.test(seg)) return { segment: 'FUTURES', inferred: false }
    if (/^(EQ|EQUITY|CASH|CAPITAL|NSE|BSE)$/.test(seg)) return { segment: 'CASH', inferred: false }
  }
  const sym = symbol.toUpperCase()
  if (/\d(CE|PE)$/.test(sym)) return { segment: 'OPTIONS', inferred: true }
  if (sym.includes('FUT')) return { segment: 'FUTURES', inferred: true }
  return { segment: 'CASH', inferred: true }
}

function parseNumber(value: unknown): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,₹\s]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

export function buildPreview(
  sheet: ParsedSheet,
  mapping: ColumnMapping,
  broker: SyncBroker,
  accountId: string,
  existingKeys: Set<string>,
  chargeColumns: string[] = [],
): ImportPreview {
  const counts: Record<PreviewStatus, number> = { valid: 0, warning: 0, invalid: 0, duplicate: 0, 'charge-only': 0 }
  const mappingErrors: string[] = []
  for (const field of REQUIRED_FIELDS) {
    if (!mapping[field]) mappingErrors.push(`Map a column for "${FIELD_LABELS[field]}".`)
    else if (!sheet.headers.includes(mapping[field])) mappingErrors.push(`Column "${mapping[field]}" (${FIELD_LABELS[field]}) is not in this file.`)
  }
  if (mappingErrors.length > 0) return { mappingErrors, notes: [], rows: [], counts }

  const cell = (row: Record<string, unknown>, field: MappingField): unknown => (mapping[field] ? row[mapping[field]] : undefined)
  const rows: PreviewRow[] = []
  const seenKeys = new Set<string>()
  const occurrences = new Map<string, number>()
  const hasTradeId = Boolean(mapping.tradeId)

  const sideOf = (row: Record<string, unknown>): ReturnType<typeof parseSide> => parseSide(cell(row, 'side'))
  const priceOf = (row: Record<string, unknown>): number | undefined =>
    parseNumber(mapping.sellPrice && sideOf(row) === 'SELL' ? cell(row, 'sellPrice') : cell(row, 'price'))
  const rowCharges = (row: Record<string, unknown>): number | undefined => {
    if (chargeColumns.length > 0) {
      let total = 0
      for (const col of chargeColumns) {
        const v = parseNumber(row[col])
        if (v !== undefined && v > 0) total += v
      }
      return total
    }
    const single = parseNumber(cell(row, 'charges'))
    return single !== undefined && single >= 0 ? single : undefined
  }
  const isTradeRow = (row: Record<string, unknown>): boolean => (parseNumber(cell(row, 'quantity')) ?? 0) > 0 && (priceOf(row) ?? 0) > 0
  const orderIdOf = (row: Record<string, unknown>): string => String(cell(row, 'orderId') ?? '').trim()

  // Some brokers put an order's brokerage/taxes on separate zero-quantity rows. Roll every row's
  // charges up per order id, then split them over that order's trade rows by quantity.
  const orderCharges = new Map<string, number>()
  const orderQty = new Map<string, number>()
  let orphanChargeRows = 0
  for (const row of sheet.rows) {
    const oid = orderIdOf(row)
    if (!oid) continue
    const c = rowCharges(row)
    if (c !== undefined) orderCharges.set(oid, (orderCharges.get(oid) ?? 0) + c)
    if (isTradeRow(row)) orderQty.set(oid, (orderQty.get(oid) ?? 0) + (parseNumber(cell(row, 'quantity')) ?? 0))
  }

  sheet.rows.forEach((row, index) => {
    const rowNumber = index + 1
    const messages: string[] = []
    const push = (status: PreviewStatus, fill?: NormalizedFill): void => {
      counts[status] += 1
      rows.push({ rowNumber, status, messages, fill })
    }

    const symbol = String(cell(row, 'symbol') ?? '').trim()

    // Charge-only row (no quantity, no price, no trade id): its charges were rolled into the order above.
    const rawQty = parseNumber(cell(row, 'quantity')) ?? 0
    if (rawQty === 0 && (priceOf(row) ?? 0) === 0 && !String(cell(row, 'tradeId') ?? '').trim() && rowCharges(row) !== undefined) {
      const oid = orderIdOf(row)
      if (oid && orderQty.has(oid)) {
        messages.push(`Charge-only row: its charges were added to the trade(s) of order ${oid}.`)
      } else {
        orphanChargeRows += 1
        messages.push('Charge-only row with no matching trade row in this file; its charges are not attributed to any trade.')
      }
      return push('charge-only')
    }

    const dateValue = cell(row, 'date')
    const parsedDate = parseBrokerTimestamp(dateValue)
    if (!parsedDate) {
      messages.push(`Could not reliably parse the date "${String(dateValue ?? '')}".`)
      return push('invalid')
    }

    let iso = parsedDate.iso
    const timeValue = String(cell(row, 'time') ?? '').trim()
    if (!iso && timeValue) {
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeValue)
      if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] ?? 0) > 59) {
        messages.push(`Could not parse the time "${timeValue}".`)
        return push('invalid')
      }
      iso = `${parsedDate.date}T${m[1].padStart(2, '0')}:${m[2]}:${(m[3] ?? '00').padStart(2, '0')}+05:30`
    }
    // A bare 00:00:00 on a date-only column is not a real execution time; keep it date-only.
    if (iso?.includes('T00:00:00+') && !timeValue) iso = undefined

    const { segment, inferred } = inferSegmentFromText(String(cell(row, 'segment') ?? ''), symbol)
    if (inferred && segment !== 'CASH') messages.push(`Segment guessed as ${segment} from the symbol; check it.`)

    const quantity = parseNumber(cell(row, 'quantity'))
    const price = priceOf(row)
    let charges: number | undefined
    const oid = orderIdOf(row)
    if (chargeColumns.length > 0 || mapping.charges) {
      if (oid && orderQty.has(oid) && orderCharges.has(oid)) {
        charges = Math.round(((orderCharges.get(oid) as number) * (quantity ?? 0)) / (orderQty.get(oid) as number) * 100) / 100
      } else {
        charges = rowCharges(row)
      }
      if (chargeColumns.length === 0 && cell(row, 'charges') !== '' && cell(row, 'charges') !== undefined && charges === undefined) {
        messages.push(`Ignored unusable charges value "${String(cell(row, 'charges'))}".`)
      }
    }

    const tradeIdText = String(cell(row, 'tradeId') ?? '').trim()
    let fillId = tradeIdText
    if (!fillId) {
      const composite = `csv|${iso ?? parsedDate.date}|${symbol}|${String(cell(row, 'side') ?? '').trim().toUpperCase()}|${quantity}|${price}`
      const n = (occurrences.get(composite) ?? 0) + 1
      occurrences.set(composite, n)
      fillId = `${composite}#${n}`
      if (!hasTradeId) messages.push('No trade id column: duplicates are detected by row content.')
    }

    const result = toFill({
      fillId,
      symbol,
      segment,
      side: cell(row, 'side'),
      quantity,
      price,
      timestamp: iso ?? parsedDate.date,
      orderId: String(cell(row, 'orderId') ?? '').trim() || undefined,
      exchange: String(cell(row, 'exchange') ?? '').trim() || undefined,
      charges,
    })
    if ('rejected' in result) {
      messages.push(result.rejected.reason)
      return push('invalid')
    }
    // toFill re-parsed the (already validated) timestamp; carry over the date-only/time-assumed flags.
    const fill = { ...result.fill, timezoneAssumed: parsedDate.timezoneAssumed || result.fill.timezoneAssumed }

    const key = ledgerKey(broker, accountId, fill.fillId)
    if (existingKeys.has(key)) {
      messages.push('Already imported earlier.')
      return push('duplicate')
    }
    if (seenKeys.has(key)) {
      messages.push('Repeats an earlier row in this file (same trade id).')
      return push('duplicate')
    }
    seenKeys.add(key)

    push(messages.length > 0 ? 'warning' : 'valid', fill)
  })

  const notes: string[] = []
  if (!mapping.segment) notes.push('No segment column mapped: rows are treated as CASH unless the symbol looks like a CE/PE option or contains FUT.')
  if (chargeColumns.length > 0) {
    notes.push(`Charges are summed from ${chargeColumns.length} columns (${chargeColumns.join(', ')}) and rolled up per Order ID, so charge-only rows are attributed to their trades.`)
    if (orphanChargeRows > 0) notes.push(`${orphanChargeRows} charge-only row(s) belong to orders with no trade row in this file (their trades may be in another date range); those charges are not attributed.`)
  } else if (!mapping.charges) {
    notes.push('No charges column mapped: imported trades will show "Charges unavailable" (net P&L is not verified).')
  }
  if (counts['charge-only'] > 0) notes.push(`${counts['charge-only']} charge-only row(s) are not trades and are not imported as trades.`)
  return { mappingErrors, notes, rows, counts }
}

export async function loadExistingLedgerKeys(accountId: string): Promise<Set<string>> {
  const keys = await db.brokerFills.where('accountId').equals(accountId).primaryKeys()
  return new Set(keys as string[])
}

const MAX_REVIEW_ROWS = 200

/** Commits only what the user previewed: valid + warning rows. Invalid rows are kept as review items (never silently dropped). */
export async function commitCsvImport(preview: ImportPreview, broker: SyncBroker, accountId: string, fileName: string): Promise<SyncOutcome> {
  const fills = preview.rows.filter((r) => (r.status === 'valid' || r.status === 'warning') && r.fill).map((r) => r.fill as NormalizedFill)
  const rejected: RejectedFill[] = preview.rows
    .filter((r) => r.status === 'invalid')
    .slice(0, MAX_REVIEW_ROWS)
    .map((r) => ({ fillId: `${fileName}#row${r.rowNumber}`, symbol: '(csv row)', reason: `Row ${r.rowNumber}: ${r.messages.join(' ')}` }))
  return runFillSync({ broker, accountId, kind: 'csv', source: 'csv-import', fills, rejected, label: fileName })
}
