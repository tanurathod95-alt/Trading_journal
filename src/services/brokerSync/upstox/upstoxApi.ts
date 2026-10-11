/**
 * Thin REST client over Upstox's own API (direct browser->Upstox, no app backend involved —
 * the access_token already in hand is all that's needed, same shape as angelOneApi.ts).
 * Read-only: only GET endpoints are used.
 */

const BASE_URL = 'https://api.upstox.com/v2'

export class UpstoxApiError extends Error {
  readonly kind: 'auth' | 'network' | 'data'

  constructor(message: string, kind: 'auth' | 'network' | 'data') {
    super(message)
    this.kind = kind
  }
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  }
}

/**
 * Raw shape of one trade row. Two different endpoints, two different shapes (official docs):
 *  - today (`/order/trades/get-trades-for-day`): `average_price`, `exchange_timestamp`/`order_timestamp`,
 *    `trading_symbol`/`tradingsymbol`, `exchange`, `product` — no `trade_date`, no `price`.
 *  - historical (`/charges/historical-trades`): `price`, `trade_date`, `symbol`/`scrip_name`,
 *    `segment`, `option_type`, `quantity`, `amount`.
 */
export interface UpstoxTradeRow {
  trade_id: string
  order_id?: string
  exchange: string
  segment?: string
  symbol?: string
  trading_symbol?: string
  tradingsymbol?: string
  scrip_name?: string
  transaction_type: 'BUY' | 'SELL'
  quantity: number
  price?: number
  average_price?: number
  amount?: number
  trade_date?: string
  exchange_timestamp?: string
  order_timestamp?: string
  option_type?: 'CE' | 'PE' | string
  product?: string
}

export async function getTodayTrades(accessToken: string): Promise<UpstoxTradeRow[]> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}/order/trades/get-trades-for-day`, {
      method: 'GET',
      headers: authHeaders(accessToken),
    })
  } catch {
    throw new UpstoxApiError('Could not reach Upstox (network error or blocked by CORS).', 'network')
  }

  const body = await response.json().catch(() => null)
  if (!response.ok || body?.status !== 'success') {
    throw new UpstoxApiError(body?.errors?.[0]?.message ?? "Unable to load today's trades", response.status === 401 ? 'auth' : 'data')
  }
  return (body.data ?? []) as UpstoxTradeRow[]
}

/** Documented contract: page_number starts at 1, page_size 1..5000, response meta_data.page.total_pages. */
const HISTORICAL_PAGE_SIZE = 1000
const HISTORICAL_MAX_PAGES = 500

export async function getHistoricalTrades(
  accessToken: string,
  params: { startDate: string; endDate: string; segment?: string },
): Promise<UpstoxTradeRow[]> {
  const all: UpstoxTradeRow[] = []
  let page = 1
  let totalPages = 1

  while (page <= totalPages && page <= HISTORICAL_MAX_PAGES) {
    const url = new URL(`${BASE_URL}/charges/historical-trades`)
    url.searchParams.set('start_date', params.startDate)
    url.searchParams.set('end_date', params.endDate)
    if (params.segment) {
      url.searchParams.set('segment', params.segment)
    }
    url.searchParams.set('page_number', String(page))
    url.searchParams.set('page_size', String(HISTORICAL_PAGE_SIZE))

    let response: Response
    try {
      response = await fetch(url.toString(), { method: 'GET', headers: authHeaders(accessToken) })
    } catch {
      throw new UpstoxApiError('Could not reach Upstox (network error or blocked by CORS).', 'network')
    }

    const body = await response.json().catch(() => null)
    if (!response.ok || body?.status !== 'success') {
      throw new UpstoxApiError(body?.errors?.[0]?.message ?? 'Unable to load historical trades', response.status === 401 ? 'auth' : 'data')
    }

    all.push(...((body.data ?? []) as UpstoxTradeRow[]))
    const reportedPages = Number(body?.meta_data?.page?.total_pages)
    totalPages = Number.isFinite(reportedPages) && reportedPages > 0 ? reportedPages : page
    page += 1
  }

  if (totalPages > HISTORICAL_MAX_PAGES) {
    // Never import a silently truncated set.
    throw new UpstoxApiError(`Upstox reported ${totalPages} pages; refusing to import a partial set. Try a shorter range.`, 'data')
  }
  return all
}
