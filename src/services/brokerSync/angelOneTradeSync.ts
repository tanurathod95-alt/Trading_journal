import type { AngelOneSession, AngelOneTradeBookRow } from '../marketData/adapters/angelOne/angelOneApi'
import { getTradeBook } from '../marketData/adapters/angelOne/angelOneApi'
import type { Trade, TradingSegment } from '../../types'
import { matchFills, type FillMatchResult, type NormalizedFill } from './matchFills'

export type AngelOneSyncResult = FillMatchResult

/** NSE/BSE = cash equity. Everything else is a derivative; Angel One's trade book doesn't carry a
 * dedicated instrument-type field, so options vs futures is inferred from the standard CE/PE
 * trading-symbol suffix (e.g. "NIFTY24AUGFUT" vs "NIFTY24AUG24000CE"). Best-effort — flagged in
 * the plan as something to confirm against a real account's symbols. */
function inferSegment(exchange: string, tradingSymbol: string): TradingSegment {
  const ex = exchange.toUpperCase()
  if (ex === 'NSE' || ex === 'BSE') return 'CASH'
  const sym = tradingSymbol.toUpperCase()
  if (sym.endsWith('CE') || sym.endsWith('PE')) return 'OPTIONS'
  return 'FUTURES'
}

function toDateString(value: string | undefined): string {
  if (value) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10)
    }
  }
  return new Date().toISOString().slice(0, 10)
}

function normalizeAngelOneRow(row: AngelOneTradeBookRow): NormalizedFill {
  return {
    fillId: row.tradeid,
    symbol: row.tradingsymbol,
    segment: inferSegment(row.exchange, row.tradingsymbol),
    side: row.transactiontype,
    quantity: Number(row.fillsize) || 0,
    price: Number(row.fillprice) || 0,
    date: toDateString(row.exchtime ?? row.filltime),
  }
}

export function matchAngelOneFills(rows: AngelOneTradeBookRow[], accountId: string, existingTrades: Trade[]): AngelOneSyncResult {
  return matchFills(rows.map(normalizeAngelOneRow), accountId, existingTrades)
}

export async function syncAngelOneTrades(session: AngelOneSession, accountId: string, existingTrades: Trade[]): Promise<AngelOneSyncResult> {
  const rows = await getTradeBook(session)
  return matchAngelOneFills(rows, accountId, existingTrades)
}
