import { workspaceApi } from '../../../workspace/api'

const AUTHORIZATION_URL = 'https://api.upstox.com/v2/login/authorization/dialog'

/**
 * Builds the URL to send the user to for Upstox's hosted login. After login, Upstox redirects
 * back to `redirectUri` with `?code=...` (and `state` echoed back unchanged, if sent) — this app
 * has no client-side router for the authenticated app (react-router-dom is only used by the
 * separate marketing site), so `redirectUri` is just this page's own URL; the redirect is read
 * back via a plain `window.location.search` check, not a dedicated route.
 */
export function buildUpstoxAuthorizationUrl(params: { clientId: string; redirectUri: string; state?: string }): string {
  const url = new URL(AUTHORIZATION_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  if (params.state) {
    url.searchParams.set('state', params.state)
  }
  return url.toString()
}

/**
 * Exchanges the authorization code for an access token via this app's own backend (the only
 * broker-sync call that isn't a direct browser->broker request) — see
 * backend/app/routers/upstox.py for why: Upstox's token endpoint requires a client_secret that
 * must never reach frontend JS.
 */
export async function exchangeUpstoxCode(code: string, clientId: string, redirectUri: string): Promise<string> {
  const { access_token } = await workspaceApi.exchangeUpstoxToken(code, clientId, redirectUri)
  return access_token
}
