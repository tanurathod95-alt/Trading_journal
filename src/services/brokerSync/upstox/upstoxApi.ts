/**
 * Thin REST client over Upstox's own API (direct browser->Upstox, no app backend involved —
 * the access_token already in hand is all that's needed, same shape as angelOneApi.ts).
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
 * Raw shape of one trade row. Field names for the confirmed historical-trades endpoint are from
 * Upstox's official docs; the current-day trades endpoint's exact field names are not fully
 * confirmed in this pass — `getTodayTrades` logs the first raw row once via console.debug so the
 * mapper (upstoxTradeSync.ts) can be checked against a real response before being trusted, same
 * honest-about-uncertainty approach as Angel One's getTradeBook.
 */
export interface UpstoxTradeRow {
  trade_id: string
  order_id?: string
  exchange: string
  segment: string
  symbol: string
  scrip_name?: string
  transaction_type: 'BUY' | 'SELL'
  quantity: number
  price?: number
  amount?: number
  trade_date: string
  option_type?: 'CE' | 'PE' | string
}

let hasLoggedTodayShape = false
let hasLoggedHistoricalShape = false

export async function getTodayTrades(accessToken: string): Promise<UpstoxTradeRow[]> {
  // NOTE: this exact path is not independently confirmed from Upstox's official docs in this
  // pass (unlike historical-trades, below, which is) — if this 404s on a real account, check
  // Upstox's current "order trades" endpoint name in their docs and update this one line.
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
    throw new UpstoxApiError(body?.errors?.[0]?.message ?? 'Unable to load today\'s trades', response.status === 401 ? 'auth' : 'data')
  }

  const rows = (body.data ?? []) as UpstoxTradeRow[]
  if (!hasLoggedTodayShape && rows.length > 0) {
    console.debug('[Upstox] today-trades row shape (first row):', rows[0])
    hasLoggedTodayShape = true
  }
  return rows
}

export async function getHistoricalTrades(
  accessToken: string,
  params: { startDate: string; endDate: string; segment?: string },
): Promise<UpstoxTradeRow[]> {
  const url = new URL(`${BASE_URL}/charges/historical-trades`)
  url.searchParams.set('start_date', params.startDate)
  url.searchParams.set('end_date', params.endDate)
  if (params.segment) {
    url.searchParams.set('segment', params.segment)
  }
  url.searchParams.set('page_number', '1')
  url.searchParams.set('page_size', '500')

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

  const rows = (body.data ?? []) as UpstoxTradeRow[]
  if (!hasLoggedHistoricalShape && rows.length > 0) {
    console.debug('[Upstox] historical-trades row shape (first row):', rows[0])
    hasLoggedHistoricalShape = true
  }
  return rows
}
