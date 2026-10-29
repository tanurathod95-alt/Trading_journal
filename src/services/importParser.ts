import * as XLSX from 'xlsx'
import type { TradeSide, TradingSegment } from '../types'
import type { NormalizedFill } from './brokerSync/matchFills'

export interface ParsedSpreadsheet {
  headers: string[]
  rows: Record<string, string>[]
}

/**
 * Reads a .csv or .xlsx file into headers + row objects. Uses the `xlsx` library already a
 * project dependency (same one `App.tsx`'s export feature writes with) — `XLSX.read` handles
 * both formats from an ArrayBuffer, no new dependency needed.
 */
export async function parseSpreadsheet(file: File): Promise<ParsedSpreadsheet> {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array' })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) {
    return { headers: [], rows: [] }
  }
  const sheet = workbook.Sheets[firstSheetName]
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '', raw: false })
  const headers = rows.length > 0 ? Object.keys(rows[0]) : (XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] ?? [])
  return { headers, rows }
}

export type ImportField = 'date' | 'symbol' | 'side' | 'quantity' | 'price' | 'segment' | 'fillId'

export type ColumnMapping = Partial<Record<ImportField, string>>

const FIELD_HINTS: Record<ImportField, string[]> = {
  date: ['date', 'trade date', 'execution date', 'order date'],
  symbol: ['symbol', 'scrip', 'tradingsymbol', 'trading symbol', 'instrument', 'script'],
  side: ['side', 'transaction type', 'trade type', 'buy/sell', 'type'],
  quantity: ['quantity', 'qty', 'filled qty'],
  price: ['price', 'avg price', 'average price', 'trade price', 'rate'],
  segment: ['segment', 'exchange', 'series'],
  fillId: ['trade id', 'order id', 'trade_id', 'order_id', 'id'],
}

/**
 * Best-effort fuzzy suggestion only — the user always sees and can override this in the mapping
 * step. Never applied blindly, since no broker's exact column names are confirmed (see the plan's
 * research note: none of the four brokers publish their file's literal headers officially).
 */
export function suggestColumnMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {}
  const normalizedHeaders = headers.map((h) => ({ raw: h, normalized: h.trim().toLowerCase() }))

  for (const field of Object.keys(FIELD_HINTS) as ImportField[]) {
    const hints = FIELD_HINTS[field]
    const match = normalizedHeaders.find((h) => hints.some((hint) => h.normalized === hint || h.normalized.includes(hint)))
    if (match) {
      mapping[field] = match.raw
    }
  }
  return mapping
}

function parseDate(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  // Try native parsing first (handles ISO and many common formats).
  const native = new Date(trimmed)
  if (!Number.isNaN(native.getTime())) {
    return native.toISOString().slice(0, 10)
  }
  // Fall back to DD-MM-YYYY / DD/MM/YYYY (common in Indian broker exports).
  const match = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/)
  if (match) {
    const [, d, m, y] = match
    const year = y.length === 2 ? `20${y}` : y
    const date = new Date(`${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10)
    }
  }
  return null
}

function parseSide(value: string): TradeSide | null {
  const v = value.trim().toUpperCase()
  if (v === 'BUY' || v === 'B' || v === 'LONG') return 'BUY'
  if (v === 'SELL' || v === 'S' || v === 'SHORT') return 'SELL'
  return null
}

function parseSegment(value: string | undefined, symbol: string): TradingSegment {
  const v = (value ?? '').trim().toUpperCase()
  if (v.includes('OPT') || v.endsWith('CE') || v.endsWith('PE') || symbol.toUpperCase().endsWith('CE') || symbol.toUpperCase().endsWith('PE')) {
    return 'OPTIONS'
  }
  if (v.includes('FUT') || v.includes('FNO') || v.includes('NFO') || v.includes('DERIV')) {
    return 'FUTURES'
  }
  return 'CASH'
}

/** Deterministic string hash (djb2) — used only as a dedup fallback when the uploaded file has no
 * id column mapped. Weaker than a broker's real trade id (two genuinely different fills with the
 * same date+symbol+side+qty+price would collide) — documented as best-effort in the UI. */
function hashFallbackId(parts: string[]): string {
  let hash = 5381
  const str = parts.join('|')
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 33) ^ str.charCodeAt(i)
  }
  return `csv-${(hash >>> 0).toString(16)}`
}

export interface InvalidRow {
  row: number
  reason: string
}

export function mapRowsToFills(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  defaultSegment: TradingSegment,
): { fills: NormalizedFill[]; invalidRows: InvalidRow[] } {
  const fills: NormalizedFill[] = []
  const invalidRows: InvalidRow[] = []

  rows.forEach((row, index) => {
    const rowNumber = index + 2 // +1 for 0-index, +1 for the header row
    const rawDate = mapping.date ? row[mapping.date] : ''
    const symbol = mapping.symbol ? row[mapping.symbol]?.trim() : ''
    const rawSide = mapping.side ? row[mapping.side] : ''
    const rawQuantity = mapping.quantity ? row[mapping.quantity] : ''
    const rawPrice = mapping.price ? row[mapping.price] : ''
    const rawSegment = mapping.segment ? row[mapping.segment] : undefined

    const date = parseDate(rawDate ?? '')
    if (!date) {
      invalidRows.push({ row: rowNumber, reason: 'Date is missing or not recognizable' })
      return
    }
    if (!symbol) {
      invalidRows.push({ row: rowNumber, reason: 'Symbol is missing' })
      return
    }
    const side = parseSide(rawSide ?? '')
    if (!side) {
      invalidRows.push({ row: rowNumber, reason: `Side "${rawSide}" is not BUY or SELL` })
      return
    }
    const quantity = Number(rawQuantity)
    if (!quantity || quantity <= 0) {
      invalidRows.push({ row: rowNumber, reason: `Quantity "${rawQuantity}" is not a positive number` })
      return
    }
    const price = Number(rawPrice)
    if (!price || price <= 0) {
      invalidRows.push({ row: rowNumber, reason: `Price "${rawPrice}" is not a positive number` })
      return
    }

    const segment = rawSegment ? parseSegment(rawSegment, symbol) : defaultSegment
    const fillId = mapping.fillId && row[mapping.fillId]?.trim()
      ? row[mapping.fillId].trim()
      : hashFallbackId([date, symbol, side, String(quantity), String(price)])

    fills.push({ fillId, symbol, segment, side, quantity, price, date })
  })

  return { fills, invalidRows }
}

export function buildSampleTemplate(): Blob {
  const sample = [
    { Date: '2026-01-15', Symbol: 'RELIANCE', Side: 'BUY', Quantity: 10, Price: 2450.5, Segment: 'CASH', 'Trade ID': '' },
    { Date: '2026-01-20', Symbol: 'RELIANCE', Side: 'SELL', Quantity: 10, Price: 2510.75, Segment: 'CASH', 'Trade ID': '' },
  ]
  const worksheet = XLSX.utils.json_to_sheet(sample)
  const csv = XLSX.utils.sheet_to_csv(worksheet)
  return new Blob([csv], { type: 'text/csv;charset=utf-8;' })
}

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  date: 'Date',
  symbol: 'Symbol',
  side: 'Side (Buy/Sell)',
  quantity: 'Quantity',
  price: 'Price',
  segment: 'Segment',
  fillId: 'Trade/Order ID',
}

export const REQUIRED_IMPORT_FIELDS: ImportField[] = ['date', 'symbol', 'side', 'quantity', 'price']
