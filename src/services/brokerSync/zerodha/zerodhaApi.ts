/**
 * Thin REST client over Zerodha's Kite Connect API (direct browser->Kite, no app backend
 * involved — the access_token already in hand is all that's needed, same shape as
 * angelOneApi.ts/upstoxApi.ts/dhanApi.ts).
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
 * says `filled`). `getTrades` logs the first raw row once via console.debug so the mapper
 * (zerodhaTradeSync.ts) can be checked against a real response before trusting either name.
 */
export interface ZerodhaTradeRow {
  trade_id: string
  order_id: string
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

let hasLoggedShape = false

export async function getTrades(apiKey: string, accessToken: string): Promise<ZerodhaTradeRow[]> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}/trades`, {
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
    throw new ZerodhaApiError(body?.message ?? 'Unable to load trades', response.status === 403 ? 'auth' : 'data')
  }

  const rows = (body.data ?? []) as ZerodhaTradeRow[]
  if (!hasLoggedShape && rows.length > 0) {
    console.debug('[Zerodha] trades row shape (first row):', rows[0])
    hasLoggedShape = true
  }
  return rows
}
