import type { NormalizedFill } from '../matchFills'
import { exactDatePart } from '../history/dateRange'
import { datedFillId, isUsableFill } from '../history/fillIds'
import type { FetchFills } from '../history/runHistorySync'
import { UPSTOX_MAX_PAGE_SIZE, UpstoxApiError, getHistoricalTradesPage, type UpstoxTradeRow } from './upstoxApi'
import { inferSegment } from './upstoxTradeSync'

/** Only stops a runaway loop; with 5,000 rows a page this is far beyond any real trading history. */
const MAX_PAGES = 200

type LoadPage = typeof getHistoricalTradesPage

/** Maps one Upstox historical-trade row to a fill, or null when it lacks a real date, side, quantity or price. */
export function normalizeUpstoxHistoryRow(row: UpstoxTradeRow): NormalizedFill | null {
  const date = exactDatePart(row.trade_date)
  const quantity = Number(row.quantity) || 0
  const price = Number(row.price ?? (row.amount && quantity ? row.amount / quantity : 0)) || 0
  const symbol = row.symbol || row.scrip_name || ''
  if (!date || !row.trade_id || !symbol) return null
  const fill: NormalizedFill = {
    fillId: datedFillId(String(row.trade_id), date),
    symbol,
    segment: inferSegment(row.exchange ?? '', row.option_type),
    side: row.transaction_type,
    quantity,
    price,
    date,
  }
  return isUsableFill(fill) ? fill : null
}

/**
 * Upstox `GET /v2/charges/historical-trades`: executed trades between two dates, paginated from page 1 with up to
 * 5,000 rows a page, limited by Upstox to the last three financial years. A page shorter than the page size is the last.
 */
export function createUpstoxHistoryFetcher(accessToken: string, loadPage: LoadPage = getHistoricalTradesPage, pageSize: number = UPSTOX_MAX_PAGE_SIZE): FetchFills {
  return async (interval, signal) => {
    const fills: NormalizedFill[] = []
    let rejected = 0

    for (let page = 1; ; page += 1) {
      if (signal?.aborted) throw new UpstoxApiError('Cancelled.', 'network')
      if (page > MAX_PAGES) throw new UpstoxApiError(`Upstox returned more than ${MAX_PAGES} pages for ${interval.from} to ${interval.to}; try a shorter range.`, 'data')

      const rows = await loadPage(accessToken, { startDate: interval.from, endDate: interval.to, page, pageSize })
      for (const row of rows) {
        const fill = normalizeUpstoxHistoryRow(row)
        if (fill) fills.push(fill)
        else rejected += 1
      }
      if (rows.length < pageSize) break
    }
    return { fills, rejected }
  }
}
