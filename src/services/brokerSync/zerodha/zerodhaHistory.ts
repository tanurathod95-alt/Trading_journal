import type { NormalizedFill } from '../matchFills'
import { datedFillId, isUsableFill } from '../history/fillIds'
import type { FetchFills } from '../history/runHistorySync'
import { getTrades } from './zerodhaApi'
import { normalizeZerodhaRow } from './zerodhaTradeSync'

/**
 * Kite Connect has no historical trade API: `GET /trades` only returns trades executed today (the day's order book is
 * cleared overnight). So this fetcher serves today and nothing else — the sync plan never asks it for another day.
 */
export function createZerodhaTodayFetcher(apiKey: string, accessToken: string, loadTrades: typeof getTrades = getTrades): FetchFills {
  return async () => {
    const fills: NormalizedFill[] = []
    let rejected = 0
    for (const row of await loadTrades(apiKey, accessToken)) {
      const fill = normalizeZerodhaRow(row)
      if (isUsableFill(fill)) fills.push({ ...fill, fillId: datedFillId(fill.fillId, fill.date) })
      else rejected += 1
    }
    return { fills, rejected }
  }
}
