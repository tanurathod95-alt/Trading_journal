import type { NormalizedFill } from '../matchFills'
import { exactDatePart } from '../history/dateRange'
import { datedFillId, isUsableFill } from '../history/fillIds'
import type { FetchFills } from '../history/runHistorySync'
import { DhanApiError, getTradeHistoryPage, type DhanTradeRow } from './dhanApi'
import { inferSegment } from './dhanTradeSync'

/** Dhan doesn't state a page size or page limit; this only stops a runaway loop, and hitting it is reported as an error. */
const MAX_PAGES = 400

type LoadPage = (accessToken: string, fromDate: string, toDate: string, page: number) => Promise<DhanTradeRow[]>

/** Maps one Dhan trade-history row to a fill, or null when it lacks a real date, side, quantity or price. */
export function normalizeDhanHistoryRow(row: DhanTradeRow): NormalizedFill | null {
  // Dhan writes "NA" for unknown timestamps; only a real date is accepted — never "today" as a stand-in.
  const date = exactDatePart(row.exchangeTime) ?? exactDatePart(row.updateTime) ?? exactDatePart(row.createTime)
  const brokerId = row.exchangeTradeId || row.orderId
  const symbol = row.tradingSymbol || row.customSymbol || row.securityId
  if (!date || !brokerId || !symbol) return null
  const fill: NormalizedFill = {
    fillId: datedFillId(String(brokerId), date),
    symbol,
    segment: inferSegment(row.exchangeSegment ?? '', row.drvOptionType),
    side: row.transactionType,
    quantity: Number(row.tradedQuantity) || 0,
    price: Number(row.tradedPrice) || 0,
    date,
  }
  return isUsableFill(fill) ? fill : null
}

/**
 * Dhan v2 `GET /trades/{from}/{to}/{page}`: any date range, a page at a time (pages count from 0, size not
 * documented). Keeps asking until a page comes back empty.
 */
export function createDhanHistoryFetcher(accessToken: string, loadPage: LoadPage = getTradeHistoryPage): FetchFills {
  return async (interval, signal) => {
    const fills: NormalizedFill[] = []
    let rejected = 0
    let previousPageKey = ''

    for (let page = 0; ; page += 1) {
      if (signal?.aborted) throw new DhanApiError('Cancelled.', 'network')
      if (page >= MAX_PAGES) throw new DhanApiError(`Dhan returned more than ${MAX_PAGES} pages for ${interval.from} to ${interval.to}; try a shorter range.`, 'data')

      const rows = await loadPage(accessToken, interval.from, interval.to, page)
      if (rows.length === 0) break

      // If Dhan ignored the page number we'd see the same page again forever.
      const pageKey = `${rows[0]?.exchangeTradeId}|${rows[0]?.orderId}|${rows.length}|${rows[rows.length - 1]?.exchangeTradeId}`
      if (pageKey === previousPageKey) break
      previousPageKey = pageKey

      for (const row of rows) {
        const fill = normalizeDhanHistoryRow(row)
        if (fill) fills.push(fill)
        else rejected += 1
      }
    }
    return { fills, rejected }
  }
}
