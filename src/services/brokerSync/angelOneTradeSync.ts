import type { AngelOneSession, AngelOneTradeBookRow } from '../marketData/adapters/angelOne/angelOneApi'
import { getTradeBook } from '../marketData/adapters/angelOne/angelOneApi'
import type { TradingSegment } from '../../types'
import { toBatch, type FillBatch } from './normalizeFill'

/** NSE/BSE = cash equity. Everything else is a derivative; Angel One's trade book doesn't carry a
 * dedicated instrument-type field, so options vs futures is inferred from the standard CE/PE
 * trading-symbol suffix (e.g. "NIFTY24AUGFUT" vs "NIFTY24AUG24000CE"). Best-effort — flagged in
 * the audit as something to confirm against a real account's symbols. */
function inferSegment(exchange: string, tradingSymbol: string): TradingSegment {
  const ex = exchange.toUpperCase()
  if (ex === 'NSE' || ex === 'BSE') return 'CASH'
  const sym = tradingSymbol.toUpperCase()
  if (sym.endsWith('CE') || sym.endsWith('PE')) return 'OPTIONS'
  return 'FUTURES'
}

export function normalizeAngelOneRows(rows: AngelOneTradeBookRow[]): FillBatch {
  return toBatch(
    rows.map((row) => ({
      fillId: row.tradeid,
      symbol: row.tradingsymbol,
      segment: inferSegment(row.exchange ?? '', row.tradingsymbol ?? ''),
      side: row.transactiontype,
      quantity: row.fillsize,
      price: row.fillprice,
      // Field format is unverified against a live account; an unparseable value is flagged for review, never replaced with today.
      timestamp: row.exchtime ?? row.filltime,
      orderId: row.orderid,
      exchange: row.exchange,
      product: row.producttype,
    })),
  )
}

/** Current trading day only — Angel One's tradebook endpoint has no date range. */
export async function fetchAngelOneFills(session: AngelOneSession): Promise<FillBatch> {
  return normalizeAngelOneRows(await getTradeBook(session))
}
