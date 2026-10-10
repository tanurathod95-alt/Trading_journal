/**
 * Thin client for the new Phase 1-2 FastAPI backend (local dev only —
 * see backend/ARCHITECTURE_PLAN.md). Completely separate from
 * services/journalService.ts and the Dexie-backed Trade/Account data —
 * this only talks to the new users/workspaces/trading_accounts tables.
 * `credentials: 'include'` on every call so the HTTP-only session cookie
 * is sent; the backend's own authorization (never this client) is what
 * actually enforces access.
 */

// Defaults to the same host the page was opened from, so the app also works when opened by LAN IP (e.g. from a phone).
const API_BASE_URL: string =
  import.meta.env.VITE_API_BASE_URL ?? `${window.location.protocol}//${window.location.hostname}:8000`

export interface WorkspaceUser {
  id: string
  email: string
  display_name: string
  created_at: string
}

export interface Workspace {
  id: string
  name: string
  plan: string
  role: 'OWNER' | 'ADMIN'
  created_at: string
}

export interface Me {
  user: WorkspaceUser
  workspaces: Workspace[]
}

export interface PortfolioApi {
  id: string
  workspace_id: string
  name: string
  client_display_name: string | null
  role: 'OWNER' | 'ADMIN' | 'VIEWER'
  account_count: number
  created_at: string
}

export interface PortfolioMemberApi {
  id: string
  user_id: string
  email: string
  display_name: string
  role: 'OWNER' | 'ADMIN' | 'VIEWER'
  granted_at: string
}

export interface PortfolioInvitationApi {
  id: string
  portfolio_id: string
  email: string
  role: 'ADMIN' | 'VIEWER'
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'DECLINED'
  invited_by_email: string
  created_at: string
  expires_at: string
  is_expired: boolean
}

export interface PlanPricingApi {
  name: 'FREE' | 'PRO' | 'PREMIUM' | 'BUSINESS'
  price_monthly_paise: number
  price_quarterly_paise: number
  price_yearly_paise: number
  max_trading_accounts: number | null
  max_members_per_account: number | null
}

export interface BillingStatusApi {
  plan: string
  subscription_status: string | null
  billing_cycle: string | null
  current_period_end: string | null
  trading_accounts_used: number
  max_trading_accounts: number | null
}

export interface PaymentApi {
  id: string
  created_at: string
  plan_name: string | null
  billing_cycle: string | null
  amount_paise: number
  status: string
  razorpay_payment_id: string
}

export interface CheckoutOutApi {
  order_id: string
  key_id: string
  amount_paise: number
  currency: string
  subscription_id: string
}

export interface MyPortfolioInvitationApi {
  id: string
  portfolio_id: string
  portfolio_name: string
  client_display_name: string | null
  role: 'ADMIN' | 'VIEWER'
  invited_by_email: string
  created_at: string
  expires_at: string
}

export interface TradingAccountApi {
  id: string
  workspace_id: string
  portfolio_id: string | null
  name: string
  broker_name: string
  account_type: string
  contact_number: string
  is_archived: boolean
  role: 'OWNER' | 'ADMIN' | 'VIEWER'
  created_at: string
  updated_at: string
}

export interface AccountMemberApi {
  id: string
  user_id: string
  email: string
  display_name: string
  role: 'OWNER' | 'ADMIN' | 'VIEWER'
  granted_at: string
}

export interface InvitationApi {
  id: string
  trading_account_id: string
  email: string
  role: 'ADMIN' | 'VIEWER'
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'DECLINED'
  invited_by_email: string
  created_at: string
  expires_at: string
  is_expired: boolean
}

export interface TradeApi {
  id: string
  trading_account_id: string
  trade_date: string
  segment: string
  script_name: string
  reason: string
  quantity: number
  side: 'BUY' | 'SELL'
  entry_price: number
  exit_date: string | null
  exit_price: number
  status: string
  gross_pnl: number
  net_pnl: number
  notes: string
  instrument_json: string | null
  created_at: string
  updated_at: string
}

export interface TradeUpsertPayload {
  id?: string
  trade_date: string
  segment: string
  script_name: string
  reason: string
  quantity: number
  side: 'BUY' | 'SELL'
  entry_price: number
  exit_date: string | null
  exit_price: number
  status: string
  gross_pnl: number
  net_pnl: number
  notes: string
  instrument_json?: string | null
}

export interface MyInvitationApi {
  id: string
  account_id: string
  account_name: string
  broker_name: string
  role: 'ADMIN' | 'VIEWER'
  invited_by_email: string
  created_at: string
  expires_at: string
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    throw new ApiError(0, 'Cannot reach the local backend. Is it running (uvicorn) on ' + API_BASE_URL + '?')
  }

  if (response.status === 204) {
    return undefined as T
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // no body
  }

  if (!response.ok) {
    const detail = (body as { detail?: string } | null)?.detail
    throw new ApiError(response.status, detail ?? `Request failed (${response.status})`)
  }

  return body as T
}

export const workspaceApi = {
  signup: (email: string, password: string, displayName: string) =>
    request<Me>('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, display_name: displayName }) }),

  login: (email: string, password: string) =>
    request<Me>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  me: () => request<Me>('/api/auth/me'),

  forgotPassword: (email: string) =>
    request<{ message: string; dev_reset_token: string | null }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, newPassword: string) =>
    request<void>('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, new_password: newPassword }) }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    }),

  updateProfile: (displayName: string) =>
    request<Me>('/api/auth/profile', { method: 'PATCH', body: JSON.stringify({ display_name: displayName }) }),

  listAccounts: (workspaceId?: string) =>
    request<TradingAccountApi[]>(`/api/accounts${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ''}`),

  createAccount: (workspaceId: string, name: string, brokerName: string, accountType: string, contactNumber = '') =>
    request<TradingAccountApi>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        workspace_id: workspaceId,
        name,
        broker_name: brokerName,
        account_type: accountType,
        contact_number: contactNumber,
      }),
    }),

  updateAccount: (
    accountId: string,
    patch: Partial<Pick<TradingAccountApi, 'name' | 'broker_name' | 'account_type' | 'contact_number' | 'is_archived'>>,
  ) =>
    request<TradingAccountApi>(`/api/accounts/${accountId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteAccount: (accountId: string) => request<void>(`/api/accounts/${accountId}`, { method: 'DELETE' }),

  listMembers: (accountId: string) => request<AccountMemberApi[]>(`/api/accounts/${accountId}/members`),

  addMember: (accountId: string, email: string, role: 'ADMIN' | 'VIEWER') =>
    request<AccountMemberApi>(`/api/accounts/${accountId}/members`, { method: 'POST', body: JSON.stringify({ email, role }) }),

  removeMember: (accountId: string, memberId: string) =>
    request<void>(`/api/accounts/${accountId}/members/${memberId}`, { method: 'DELETE' }),

  listInvitations: (accountId: string) => request<InvitationApi[]>(`/api/accounts/${accountId}/invitations`),

  createInvitation: (accountId: string, email: string, role: 'ADMIN' | 'VIEWER') =>
    request<InvitationApi>(`/api/accounts/${accountId}/invitations`, { method: 'POST', body: JSON.stringify({ email, role }) }),

  revokeInvitation: (accountId: string, invitationId: string) =>
    request<void>(`/api/accounts/${accountId}/invitations/${invitationId}`, { method: 'DELETE' }),

  listTrades: (accountId: string) => request<TradeApi[]>(`/api/accounts/${accountId}/trades`),

  createTrade: (accountId: string, payload: TradeUpsertPayload) =>
    request<TradeApi>(`/api/accounts/${accountId}/trades`, { method: 'POST', body: JSON.stringify(payload) }),

  updateTrade: (accountId: string, tradeId: string, payload: Partial<TradeUpsertPayload>) =>
    request<TradeApi>(`/api/accounts/${accountId}/trades/${tradeId}`, { method: 'PATCH', body: JSON.stringify(payload) }),

  deleteTrade: (accountId: string, tradeId: string) =>
    request<void>(`/api/accounts/${accountId}/trades/${tradeId}`, { method: 'DELETE' }),

  bulkImportTrades: (accountId: string, tradesPayload: TradeUpsertPayload[]) =>
    request<{ imported: number; skipped_existing: number }>(`/api/accounts/${accountId}/trades/bulk-import`, {
      method: 'POST',
      body: JSON.stringify({ trades: tradesPayload }),
    }),

  listPortfolios: (workspaceId?: string) =>
    request<PortfolioApi[]>(`/api/portfolios${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ''}`),

  createPortfolio: (workspaceId: string, name: string, clientDisplayName: string) =>
    request<PortfolioApi>('/api/portfolios', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, name, client_display_name: clientDisplayName || null }),
    }),

  deletePortfolio: (portfolioId: string) => request<void>(`/api/portfolios/${portfolioId}`, { method: 'DELETE' }),

  assignAccountToPortfolio: (accountId: string, portfolioId: string | null) =>
    request<TradingAccountApi>(`/api/accounts/${accountId}`, { method: 'PATCH', body: JSON.stringify({ portfolio_id: portfolioId }) }),

  listPortfolioMembers: (portfolioId: string) => request<PortfolioMemberApi[]>(`/api/portfolios/${portfolioId}/members`),

  removePortfolioMember: (portfolioId: string, memberId: string) =>
    request<void>(`/api/portfolios/${portfolioId}/members/${memberId}`, { method: 'DELETE' }),

  listPortfolioInvitations: (portfolioId: string) => request<PortfolioInvitationApi[]>(`/api/portfolios/${portfolioId}/invitations`),

  createPortfolioInvitation: (portfolioId: string, email: string, role: 'ADMIN' | 'VIEWER') =>
    request<PortfolioInvitationApi>(`/api/portfolios/${portfolioId}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),

  revokePortfolioInvitation: (portfolioId: string, invitationId: string) =>
    request<void>(`/api/portfolios/${portfolioId}/invitations/${invitationId}`, { method: 'DELETE' }),

  myPortfolioInvitations: () => request<MyPortfolioInvitationApi[]>('/api/portfolio-invitations/me'),

  acceptPortfolioInvitation: (invitationId: string) =>
    request<PortfolioApi>(`/api/portfolio-invitations/${invitationId}/accept`, { method: 'POST' }),

  declinePortfolioInvitation: (invitationId: string) =>
    request<void>(`/api/portfolio-invitations/${invitationId}/decline`, { method: 'POST' }),

  listPlanPricing: () => request<PlanPricingApi[]>('/api/billing/plans'),

  getBillingStatus: (workspaceId: string) => request<BillingStatusApi>(`/api/billing/workspaces/${workspaceId}/status`),

  listBillingHistory: (workspaceId: string) => request<PaymentApi[]>(`/api/billing/workspaces/${workspaceId}/payments`),

  /**
   * Upstox OAuth's authorization-code exchange needs a client_secret, which must never sit in
   * frontend JS — this is the one broker-sync call that goes through this app's own backend
   * (as a thin, stateless proxy) rather than straight to the broker's API.
   */
  exchangeUpstoxToken: (code: string, clientId: string, redirectUri: string) =>
    request<{ access_token: string }>('/api/upstox/exchange-token', {
      method: 'POST',
      body: JSON.stringify({ code, client_id: clientId, redirect_uri: redirectUri }),
    }),

  /** Mirrors exchangeUpstoxToken — Kite Connect's checksum needs api_secret, which must stay backend-only. */
  exchangeZerodhaToken: (requestToken: string, apiKey: string) =>
    request<{ access_token: string }>('/api/zerodha/exchange-token', {
      method: 'POST',
      body: JSON.stringify({ request_token: requestToken, api_key: apiKey }),
    }),

  /** Dhan's API rejects cross-origin browser requests outright (confirmed via a CORS preflight
   * test — not a missing-header oversight), so unlike the other three brokers this trades fetch
   * has to be proxied through the backend, not called directly from the browser. */
  getDhanTrades: (accessToken: string) =>
    request<unknown[]>('/api/dhan/trades', {
      method: 'POST',
      body: JSON.stringify({ access_token: accessToken }),
    }),

  createCheckout: (workspaceId: string, planName: string, billingCycle: 'MONTHLY' | 'QUARTERLY' | 'YEARLY') =>
    request<CheckoutOutApi>(`/api/billing/workspaces/${workspaceId}/checkout`, {
      method: 'POST',
      body: JSON.stringify({ plan_name: planName, billing_cycle: billingCycle }),
    }),

  verifyPayment: (workspaceId: string, razorpayOrderId: string, razorpayPaymentId: string, razorpaySignature: string) =>
    request<BillingStatusApi>(`/api/billing/workspaces/${workspaceId}/verify`, {
      method: 'POST',
      body: JSON.stringify({
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature,
      }),
    }),

  myInvitations: () => request<MyInvitationApi[]>('/api/invitations/me'),

  acceptInvitation: (invitationId: string) => request<TradingAccountApi>(`/api/invitations/${invitationId}/accept`, { method: 'POST' }),

  declineInvitation: (invitationId: string) => request<void>(`/api/invitations/${invitationId}/decline`, { method: 'POST' }),
}
