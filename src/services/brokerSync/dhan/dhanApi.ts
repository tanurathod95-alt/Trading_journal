/**
 * Thin REST client over DhanHQ's v2 API (direct browser->Dhan, no app
 * backend involved — the access token the user pasted is all that's
 * needed, same shape as angelOneApi.ts/upstoxApi.ts). Confirmed directly
 * against Dhan's official v2 docs — no "unverified field names" caveat
 * needed here, unlike Angel One/Upstox.
 */

const BASE_URL = 'https://api.dhan.co/v2'

export class DhanApiError extends Error {
  readonly kind: 'auth' | 'network' | 'data'

  constructor(message: string, kind: 'auth' | 'network' | 'data') {
    super(message)
    this.kind = kind
  }
}

export interface DhanTradeRow {
  dhanClientId: string
  orderId: string
  exchangeOrderId: string
  exchangeTradeId: string
  transactionType: 'BUY' | 'SELL'
  exchangeSegment: string
  productType: string
  orderType: string
  tradingSymbol: string
  securityId: string
  tradedQuantity: number
  tradedPrice: number
  createTime: string
  updateTime: string
  exchangeTime: string
  drvExpiryDate?: string | null
  drvOptionType?: 'CALL' | 'PUT' | null
  drvStrikePrice?: number | null
}

export async function getTradeBook(accessToken: string): Promise<DhanTradeRow[]> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}/trades`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'access-token': accessToken },
    })
  } catch {
    throw new DhanApiError('Could not reach Dhan (network error or blocked by CORS).', 'network')
  }

  if (response.status === 401) {
    throw new DhanApiError('Dhan access token is invalid or expired — regenerate it from web.dhan.co and reconnect.', 'auth')
  }

  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new DhanApiError((body && (body.remarks?.message ?? body.errorMessage)) ?? 'Unable to load trade book', 'data')
  }

  return (Array.isArray(body) ? body : []) as DhanTradeRow[]
}
