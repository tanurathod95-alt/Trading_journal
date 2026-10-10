import { ApiError, workspaceApi } from '../../../workspace/api'

/**
 * Dhan's API rejects cross-origin browser requests outright (confirmed: a CORS preflight from a
 * browser origin gets back a 403 "Invalid CORS request" — not a missing-header oversight, Dhan's
 * API simply doesn't support being called directly from a page). So unlike Angel One/Upstox/
 * Zerodha, this goes through this app's own backend (`workspaceApi.getDhanTrades`,
 * `backend/app/routers/dhan.py`) as a plain pass-through proxy — the access token the user
 * pasted is sent through unchanged, nothing is persisted server-side.
 */

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
  try {
    const rows = await workspaceApi.getDhanTrades(accessToken)
    return (Array.isArray(rows) ? rows : []) as DhanTradeRow[]
  } catch (err) {
    if (err instanceof ApiError) {
      throw new DhanApiError(err.message, err.status === 401 ? 'auth' : 'data')
    }
    throw new DhanApiError('Could not reach Dhan.', 'network')
  }
}
