/**
 * Thin REST client over Angel One's SmartAPI. Endpoints and payload shapes
 * below are taken directly from Angel One's own maintained SDKs
 * (github.com/angel-one/smartapi-javascript and smartapi-python), not
 * guessed — see config/api.js / SmartApi/smartConnect.py in those repos.
 */

const BASE_URL = 'https://apiconnect.angelone.in'

const ROUTES = {
  login: '/rest/auth/angelbroking/user/v1/loginByPassword',
  candleData: '/rest/secure/angelbroking/historical/v1/getCandleData',
  marketData: '/rest/secure/angelbroking/market/v1/quote',
  ltpData: '/rest/secure/angelbroking/order/v1/getLtpData',
  logout: '/rest/secure/angelbroking/user/v1/logout',
  // Confirmed against Angel One's own smartapi-javascript config/api.js
  // ("get_tradebook") and smartapi-python's SmartConnect.tradeBook() — a
  // plain GET, no params, current trading day's executed fills only.
  tradeBook: '/rest/secure/angelbroking/order/v1/getTradeBook',
} as const

export interface AngelOneSession {
  apiKey: string
  jwtToken: string
  feedToken: string
  refreshToken: string
  clientCode: string
}

export class AngelOneApiError extends Error {
  readonly kind: 'auth' | 'network' | 'data'

  constructor(message: string, kind: 'auth' | 'network' | 'data') {
    super(message)
    this.kind = kind
  }
}

function baseHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-PrivateKey': apiKey,
    // Angel's API expects these to be present; a browser cannot read the
    // machine's real local IP/MAC, so we send harmless placeholders as
    // every community browser-based integration does.
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
  }
}

async function parseJsonOrThrow(response: Response, kind: 'auth' | 'network' | 'data'): Promise<any> {
  let body: any
  try {
    body = await response.json()
  } catch {
    throw new AngelOneApiError(`Angel One returned a non-JSON response (HTTP ${response.status}).`, kind)
  }
  return body
}

export async function login(params: { apiKey: string; clientCode: string; pin: string; totp: string }): Promise<AngelOneSession> {
  let response: Response
  try {
    response = await fetch(BASE_URL + ROUTES.login, {
      method: 'POST',
      headers: baseHeaders(params.apiKey),
      body: JSON.stringify({ clientcode: params.clientCode, password: params.pin, totp: params.totp }),
    })
  } catch {
    throw new AngelOneApiError('Could not reach Angel One (network error or blocked by CORS).', 'network')
  }

  const body = await parseJsonOrThrow(response, 'auth')

  if (!response.ok || body?.status !== true || !body?.data?.jwtToken) {
    throw new AngelOneApiError(body?.message ?? 'Angel One authentication failed', 'auth')
  }

  return {
    apiKey: params.apiKey,
    jwtToken: body.data.jwtToken as string,
    feedToken: body.data.feedToken as string,
    refreshToken: body.data.refreshToken as string,
    clientCode: params.clientCode,
  }
}

export async function logout(session: AngelOneSession): Promise<void> {
  try {
    await fetch(BASE_URL + ROUTES.logout, {
      method: 'POST',
      headers: { ...baseHeaders(session.apiKey), Authorization: `Bearer ${session.jwtToken}` },
      body: JSON.stringify({ clientcode: session.clientCode }),
    })
  } catch {
    // Best-effort — a failed logout call shouldn't block the local disconnect.
  }
}

export type AngelOneInterval =
  | 'ONE_MINUTE'
  | 'THREE_MINUTE'
  | 'FIVE_MINUTE'
  | 'TEN_MINUTE'
  | 'FIFTEEN_MINUTE'
  | 'THIRTY_MINUTE'
  | 'ONE_HOUR'
  | 'ONE_DAY'

export interface AngelOneCandleRow {
  // [timestamp ISO string, open, high, low, close, volume]
  0: string
  1: number
  2: number
  3: number
  4: number
  5: number
}

export async function getCandleData(
  session: AngelOneSession,
  params: { exchange: string; symbolToken: string; interval: AngelOneInterval; fromDate: string; toDate: string },
): Promise<AngelOneCandleRow[]> {
  let response: Response
  try {
    response = await fetch(BASE_URL + ROUTES.candleData, {
      method: 'POST',
      headers: { ...baseHeaders(session.apiKey), Authorization: `Bearer ${session.jwtToken}` },
      body: JSON.stringify({
        exchange: params.exchange,
        symboltoken: params.symbolToken,
        interval: params.interval,
        fromdate: params.fromDate,
        todate: params.toDate,
      }),
    })
  } catch {
    throw new AngelOneApiError('Could not reach Angel One (network error or blocked by CORS).', 'network')
  }

  const body = await parseJsonOrThrow(response, 'data')

  if (!response.ok || body?.status !== true) {
    throw new AngelOneApiError(body?.message ?? 'Unable to load market data', 'data')
  }

  return (body.data ?? []) as AngelOneCandleRow[]
}

export interface AngelOneLtp {
  ltp: number
  open: number
  high: number
  low: number
  close: number
}

export async function getLtpData(
  session: AngelOneSession,
  params: { exchange: string; tradingSymbol: string; symbolToken: string },
): Promise<AngelOneLtp> {
  let response: Response
  try {
    response = await fetch(BASE_URL + ROUTES.ltpData, {
      method: 'POST',
      headers: { ...baseHeaders(session.apiKey), Authorization: `Bearer ${session.jwtToken}` },
      body: JSON.stringify({ exchange: params.exchange, tradingsymbol: params.tradingSymbol, symboltoken: params.symbolToken }),
    })
  } catch {
    throw new AngelOneApiError('Could not reach Angel One (network error or blocked by CORS).', 'network')
  }

  const body = await parseJsonOrThrow(response, 'data')

  if (!response.ok || body?.status !== true) {
    throw new AngelOneApiError(body?.message ?? 'Unable to load market data', 'data')
  }

  return {
    ltp: Number(body.data?.ltp ?? 0),
    open: Number(body.data?.open ?? 0),
    high: Number(body.data?.high ?? 0),
    low: Number(body.data?.low ?? 0),
    close: Number(body.data?.close ?? 0),
  }
}

/**
 * Raw shape of one trade-book row. Field names are Angel One's documented
 * lowercase convention (matching `clientcode`/`totp` etc. used elsewhere in
 * this file) but are NOT confirmed against a live response in this repo —
 * `getTradeBook` logs the first raw row once via console.debug so the
 * caller/mapper can be checked against a real account before being trusted.
 */
export interface AngelOneTradeBookRow {
  tradingsymbol: string
  symboltoken: string
  exchange: string
  producttype: string
  transactiontype: 'BUY' | 'SELL'
  fillprice: number
  fillsize: number
  orderid: string
  tradeid: string
  filltime: string
  exchtime?: string
}

let hasLoggedTradeBookShape = false

export async function getTradeBook(session: AngelOneSession): Promise<AngelOneTradeBookRow[]> {
  let response: Response
  try {
    response = await fetch(BASE_URL + ROUTES.tradeBook, {
      method: 'GET',
      headers: { ...baseHeaders(session.apiKey), Authorization: `Bearer ${session.jwtToken}` },
    })
  } catch {
    throw new AngelOneApiError('Could not reach Angel One (network error or blocked by CORS).', 'network')
  }

  const body = await parseJsonOrThrow(response, 'data')

  if (!response.ok || body?.status !== true) {
    throw new AngelOneApiError(body?.message ?? 'Unable to load trade book', 'data')
  }

  const rows = (body.data ?? []) as AngelOneTradeBookRow[]
  if (!hasLoggedTradeBookShape && rows.length > 0) {
    // One-time diagnostic: confirm real field names before trusting the mapper in angelOneTradeSync.ts.
    console.debug('[AngelOne] trade-book row shape (first row):', rows[0])
    hasLoggedTradeBookShape = true
  }
  return rows
}
