import { ApiError, workspaceApi } from '../../../workspace/api'

/**
 * Dhan's API rejects cross-origin browser requests outright (confirmed: a CORS preflight from a
 * browser origin gets back a 403 "Invalid CORS request" — not a missing-header oversight, Dhan's
 * API simply doesn't support being called directly from a page). So unlike Angel One/Upstox/
 * Zerodha, every call goes through this app's own backend as a stateless, read-only GET
 * pass-through (`backend/app/routers/dhan.py`) — nothing is persisted server-side.
 */

export class DhanApiError extends Error {
  readonly kind: 'auth' | 'network' | 'data'

  constructor(message: string, kind: 'auth' | 'network' | 'data') {
    super(message)
    this.kind = kind
  }
}

/** Fields per Dhan's official Orders + Statements docs. The charge fields exist only on the historical (Statements) endpoint. */
export interface DhanTradeRow {
  dhanClientId?: string
  orderId: string
  exchangeOrderId?: string
  exchangeTradeId?: string
  transactionType: 'BUY' | 'SELL'
  exchangeSegment: string
  productType?: string
  orderType?: string
  tradingSymbol: string
  securityId?: string
  tradedQuantity: number
  tradedPrice: number
  createTime?: string
  updateTime?: string
  exchangeTime?: string
  drvExpiryDate?: string | null
  drvOptionType?: 'CALL' | 'PUT' | null
  drvStrikePrice?: number | null
  brokerageCharges?: number | string
  stt?: number | string
  sebiTax?: number | string
  serviceTax?: number | string
  exchangeTransactionCharges?: number | string
  stampDuty?: number | string
}

export interface DhanOrderRow {
  orderId: string
  orderStatus: string
  transactionType: 'BUY' | 'SELL'
  tradingSymbol: string
  exchangeSegment?: string
  productType?: string
  quantity: number
  filledQty?: number
  averageTradedPrice?: number
  createTime?: string
  omsErrorDescription?: string | null
}

function wrap(err: unknown): never {
  if (err instanceof ApiError) {
    throw new DhanApiError(err.message, err.status === 401 ? 'auth' : 'data')
  }
  throw new DhanApiError('Could not reach Dhan.', 'network')
}

const asRows = <T>(rows: unknown): T[] => (Array.isArray(rows) ? (rows as T[]) : [])

export async function getTradeBook(accessToken: string): Promise<DhanTradeRow[]> {
  try {
    return asRows<DhanTradeRow>(await workspaceApi.getDhanTrades(accessToken))
  } catch (err) {
    return wrap(err)
  }
}

const HISTORY_WINDOW_DAYS = 31
const HISTORY_MAX_PAGES = 200

const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10)

/**
 * Historical trades with charges. Dhan documents the date-range endpoint as paginated (page 0,1,2…)
 * without stating a maximum range or page size, so the range is walked in 31-day windows and each
 * window's pages are read until one comes back empty. A page cap prevents an endless loop; hitting
 * it throws rather than returning a silently truncated set.
 */
export async function getTradeHistory(accessToken: string, fromDate: Date, toDate: Date): Promise<DhanTradeRow[]> {
  const all: DhanTradeRow[] = []
  try {
    let windowStart = new Date(fromDate)
    while (windowStart <= toDate) {
      const windowEnd = new Date(Math.min(windowStart.getTime() + (HISTORY_WINDOW_DAYS - 1) * 86_400_000, toDate.getTime()))
      let page = 0
      for (;;) {
        if (page >= HISTORY_MAX_PAGES) {
          throw new DhanApiError('Dhan trade history returned too many pages; refusing to import a partial set.', 'data')
        }
        const rows = asRows<DhanTradeRow>(await workspaceApi.getDhanTradeHistory(accessToken, toIsoDate(windowStart), toIsoDate(windowEnd), page))
        if (rows.length === 0) break
        all.push(...rows)
        page += 1
      }
      windowStart = new Date(windowEnd.getTime() + 86_400_000)
    }
    return all
  } catch (err) {
    if (err instanceof DhanApiError) throw err
    return wrap(err)
  }
}

export async function getOrders(accessToken: string): Promise<DhanOrderRow[]> {
  try {
    return asRows<DhanOrderRow>(await workspaceApi.getDhanOrders(accessToken))
  } catch (err) {
    return wrap(err)
  }
}
