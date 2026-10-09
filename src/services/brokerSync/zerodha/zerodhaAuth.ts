import { workspaceApi } from '../../../workspace/api'

const LOGIN_URL = 'https://kite.zerodha.com/connect/login'

/**
 * Builds the URL to send the user to for Zerodha's hosted login. After login, Kite redirects
 * back to the redirect URL registered for this api_key, with `?request_token=...` as a query
 * param — read back off `window.location.search`, same pattern as Upstox's `?code=`.
 */
export function buildZerodhaLoginUrl(apiKey: string): string {
  const url = new URL(LOGIN_URL)
  url.searchParams.set('v', '3')
  url.searchParams.set('api_key', apiKey)
  return url.toString()
}

/**
 * Exchanges the request token for an access token via this app's own backend — the one
 * broker-sync call that isn't a direct browser->broker request, since Kite Connect's checksum
 * needs api_secret (see backend/app/routers/zerodha.py).
 */
export async function exchangeZerodhaRequestToken(requestToken: string, apiKey: string): Promise<string> {
  const { access_token } = await workspaceApi.exchangeZerodhaToken(requestToken, apiKey)
  return access_token
}
