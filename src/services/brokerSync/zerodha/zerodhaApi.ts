/**
 * Thin REST client over Zerodha's Kite Connect API (direct browser->Kite, no app backend
 * involved — the access_token already in hand is all that's needed, same shape as
 * angelOneApi.ts/upstoxApi.ts/dhanApi.ts). Read-only: only GET endpoints are used.
 *
 * Whether api.kite.trade answers browser (CORS) requests is NOT verified; a blocked call surfaces
 * as a 'network' error, never as a fake success.
 */

const BASE_URL = 'https://api.kite.trade'

export class ZerodhaApiError extends Error {
  readonly kind: 'auth' | 'network' | 'data'

  constructor(message: string, kind: 'auth' | 'network' | 'data') {
    super(message)
    this.kind = kind
  }
}

/**
 * Raw shape of one trade row, from Zerodha's own official docs — except `quantity`, which the
 * docs themselves name inconsistently (sample response says `quantity`, the attribute table
 * says `filled`). The mapper (zerodhaTradeSync.ts) accepts either name.
 */
export interface ZerodhaTradeRow {
  trade_id: string
  order_id: string
  exchange_order_id?: string
  exchange: string
  tradingsymbol: string
  instrument_token: string
  product: string
  average_price: number
  quantity?: number
  filled?: number
  transaction_type: 'BUY' | 'SELL'
  fill_timestamp?: string
  order_timestamp?: string
  exchange_timestamp?: string
}

/** Raw order row, field names from Kite's official GET /orders docs. */
export interface ZerodhaOrderRow {
  order_id: string
  exchange_order_id?: string | null
  tradingsymbol: string
  exchange: string
  transaction_type: 'BUY' | 'SELL'
  quantity: number
  filled_quantity: number
  pending_quantity?: number
  status: string
  status_message?: string | null
  average_price?: number
  order_timestamp?: string
}

/** Raw position row (the documented fields we use). */
export interface ZerodhaPositionRow {
  tradingsymbol: string
  exchange: string
  product: string
  quantity: number
  average_price: number
  last_price?: number
  realised?: number
  unrealised?: number
}

async function kiteGet<T>(path: string, apiKey: string, accessToken: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${apiKey}:${accessToken}`,
      },
    })
  } catch {
    throw new ZerodhaApiError('Could not reach Zerodha (network error or blocked by CORS).', 'network')
  }

  const body = await response.json().catch(() => null)
  if (!response.ok || body?.status !== 'success') {
    throw new ZerodhaApiError(body?.message ?? 'Zerodha request failed', response.status === 403 ? 'auth' : 'data')
  }
  return body.data as T
}

export async function getTrades(apiKey: string, accessToken: string): Promise<ZerodhaTradeRow[]> {
  return (await kiteGet<ZerodhaTradeRow[] | null>('/trades', apiKey, accessToken)) ?? []
}

export async function getOrders(apiKey: string, accessToken: string): Promise<ZerodhaOrderRow[]> {
  return (await kiteGet<ZerodhaOrderRow[] | null>('/orders', apiKey, accessToken)) ?? []
}

/** `net` = current net positions. The day-scoped `day` array is intentionally ignored. */
export async function getNetPositions(apiKey: string, accessToken: string): Promise<ZerodhaPositionRow[]> {
  const data = await kiteGet<{ net?: ZerodhaPositionRow[] } | null>('/portfolio/positions', apiKey, accessToken)
  return data?.net ?? []
}
