import { getTradeBook, type AngelOneSession } from '../marketData/adapters/angelOne/angelOneApi'
import type { NormalizedFill } from './matchFills'
import { normalizeAngelOneRow } from './angelOneTradeSync'
import { datedFillId, isUsableFill } from './history/fillIds'
import type { FetchFills } from './history/runHistorySync'

/**
 * SmartAPI's trade book only covers the current day and there is no date-range or historical trade API (Angel One staff
 * point to the back office for older trades). So this fetcher serves today and nothing else — the sync plan never asks
 * it for another day.
 */
export function createAngelOneTodayFetcher(session: AngelOneSession, loadTradeBook: typeof getTradeBook = getTradeBook): FetchFills {
  return async () => {
    const fills: NormalizedFill[] = []
    let rejected = 0
    for (const row of await loadTradeBook(session)) {
      const fill = normalizeAngelOneRow(row)
      if (isUsableFill(fill)) fills.push({ ...fill, fillId: datedFillId(fill.fillId, fill.date) })
      else rejected += 1
    }
    return { fills, rejected }
  }
}
