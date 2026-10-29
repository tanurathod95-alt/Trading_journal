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
  platform_role?: 'USER' | 'ADMIN' | 'DEVELOPER'
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

export type HealthStatus = 'ok' | 'warn' | 'down' | 'idle'

export interface HealthTile {
  key: string
  label: string
  status: HealthStatus
  summary: string
  metrics: Record<string, string | number | boolean | null>
  checked_at: string
}

export interface ConfigCheck {
  key: string
  label: string
  ok: boolean
  detail: string
}

export interface DevHealth {
  overall: 'ok' | 'warn' | 'down'
  started_at: string
  generated_at: string
  tiles: HealthTile[]
  config_checks: ConfigCheck[]
}

export interface FunctionStat {
  name: string
  kind: 'function' | 'route' | 'upstream'
  calls: number
  errors: number
  recent_calls: number
  recent_errors: number
  recent_error_rate: number
  p50_ms: number | null
  p95_ms: number | null
  p99_ms: number | null
  last_success: string | null
  last_error: string | null
  last_error_message: string | null
  status: HealthStatus
}

export interface SelfTestResult {
  key: string
  label: string
  status: 'pass' | 'fail'
  detail: string
  duration_ms: number
}

export interface SelfTestRun {
  ran_at: string
  passed: number
  failed: number
  results: SelfTestResult[]
}

export interface DevError {
  ts: string
  component: string
  message: string
  request_id: string | null
  path: string | null
  status: number | null
}

export interface AdminPage<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}

export interface AdminSummary {
  users: { total: number; disabled: number; staff: number; signed_up_today: number; signed_up_7d: number; with_active_session: number }
  workspaces: { total: number; by_plan: Record<string, number> }
  accounts: { total: number }
  billing: { subscriptions_by_status: Record<string, number>; expiring_in_7d: number; paid_last_30d_inr: number }
  invitations: { pending: number }
  security: { failed_logins_24h: number }
  generated_at: string
}

export interface AdminUserWorkspace {
  id: string
  name: string
  plan: string
  role: string
}

export interface AdminUserRow {
  id: string
  email: string
  display_name: string
  is_active: boolean
  platform_role: 'USER' | 'ADMIN' | 'DEVELOPER'
  created_at: string
  last_login_at: string | null
  active_sessions: number
  accounts: number
  workspaces: AdminUserWorkspace[]
  plan: string | null
  subscription_status: string | null
  subscription_period_end: string | null
}

export interface AdminUserDetail {
  profile: {
    id: string
    email: string
    display_name: string
    is_active: boolean
    platform_role: string
    created_at: string
    last_login_at: string | null
    failed_logins_7d: number
  }
  workspaces: Array<{
    id: string
    name: string
    role: string
    plan: string
    limits: { max_trading_accounts: number | null; max_members_per_account: number | null }
    trading_accounts_used: number
    created_at: string
  }>
  accounts: Array<{ id: string; name: string; broker_name: string; account_type: string; is_archived: boolean; role: string; workspace_id: string; trades: number }>
  subscriptions: Array<{ id: string; workspace_id: string; plan_name: string; billing_cycle: string; status: string; current_period_end: string | null; created_at: string }>
  payments: Array<AdminPaymentRowBase>
  sessions: Array<{ started_at: string; expires_at: string; active: boolean }>
  invitations: Array<{ kind: string; email: string; role: string; status: string; created_at: string; expires_at: string }>
  audit: Array<{ id: string; action: string; created_at: string; ip_address: string | null; metadata: unknown; as_target: boolean }>
}

export interface AdminPaymentRowBase {
  id: string
  razorpay_payment_id: string
  razorpay_order_id: string
  amount_inr: number
  status: string
  plan_name: string | null
  billing_cycle: string | null
  created_at: string
}

export interface AdminPaymentRow extends AdminPaymentRowBase {
  workspace_name: string
  owner_email: string
}

export interface AdminWorkspaceRow {
  id: string
  name: string
  owner_email: string
  plan: string
  members: number
  limits: { max_trading_accounts: number | null; max_members_per_account: number | null }
  trading_accounts_used: number
  subscription_status: string | null
  subscription_period_end: string | null
  created_at: string
}

export interface AdminSubscriptionRow {
  id: string
  workspace_id: string
  workspace_name: string
  owner_email: string
  plan_name: string
  billing_cycle: string
  status: string
  current_period_end: string | null
  expiring_soon: boolean
  razorpay_order_id: string | null
  razorpay_payment_id: string | null
  updated_at: string
}

export interface AdminBillingOverview {
  last_webhook_at: string | null
  webhooks_total: number
  verification_failures_24h: number
  recent_verification_failures: Array<{ at: string; user_id: string | null; workspace_id: string | null; ip_address: string | null; metadata: unknown }>
}

export interface AdminWebhookRow {
  id: string
  razorpay_event_id: string
  event_type: string
  processed_at: string
}

export interface AdminInvitationRow {
  kind: 'account' | 'portfolio'
  id: string
  email: string
  role: string
  status: string
  target_name: string
  invited_by_email: string
  created_at: string
  expires_at: string
}

export interface AdminAuditRow {
  id: string
  created_at: string
  action: string
  actor_user_id: string | null
  actor_email: string | null
  target_user_id: string | null
  workspace_id: string | null
  trading_account_id: string | null
  ip_address: string | null
  metadata: unknown
}

export type AdminQuery = Record<string, string | number | undefined | null>

function adminQuery(params: AdminQuery): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '' && value !== 'all') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export interface StaffResetLink {
  reset_url: string
  expires_at: string
  valid_minutes: number
  email: string
}

export interface ViewAsStarted {
  id: string
  started_at: string
  idle_timeout_minutes: number
  user: { id: string; email: string; display_name: string }
}

export interface ViewAsAccount {
  id: string
  name: string
  broker_name: string
  account_type: string
  is_archived: boolean
  role: string
  trades: number
  open_trades: number
  wins: number
  closed_trades: number
  net_pnl: number
  win_rate: number
}

export interface ViewAsTrade {
  id: string
  trading_account_id: string
  trade_date: string
  segment: string
  script_name: string
  side: string
  quantity: number
  entry_price: number
  exit_date: string | null
  exit_price: number
  status: string
  gross_pnl: number
  net_pnl: number
}

export interface ViewAsDashboard {
  session: { id: string; started_at: string; last_seen_at: string; idle_timeout_minutes: number }
  user: { id: string; email: string; display_name: string; is_active: boolean }
  totals: { accounts: number; trades: number; open_trades: number; net_pnl: number; win_rate: number }
  accounts: ViewAsAccount[]
  recent_trades: ViewAsTrade[]
  note: string
}

/** A customer's accounts and trades in the same shape their own dashboard receives them. */
export interface ViewAsData {
  user: { id: string; email: string; display_name: string }
  accounts: TradingAccountApi[]
  trades: TradeApi[]
  total_trades: number
  truncated: boolean
}

export interface SupportAccessSession {
  started_at: string
  ended_at: string | null
  by: string
}

export interface BillingIssue {
  kind: 'unrecorded_payment' | 'plan_without_payment' | 'plan_mismatch' | 'period_ended' | 'possible_double_charge' | 'stuck_checkout'
  severity: 'high' | 'medium' | 'low'
  workspace_id: string | null
  workspace_name: string | null
  owner_email: string | null
  title: string
  detail: string
  payment_id?: string
  order_id?: string | null
  amount_inr?: number
  plan_name?: string | null
  billing_cycle?: string | null
  current_plan?: string
  subscription_plan?: string
  days_overdue?: number
  when?: string
  can_reconcile?: boolean
}

export interface BillingIssues {
  total: number
  by_kind: Record<string, number>
  items: BillingIssue[]
  unreadable_webhooks: number
  checked_at: string
}

export interface PlanOverrideInput {
  plan: 'FREE' | 'PRO' | 'PREMIUM' | 'BUSINESS'
  billing_cycle?: 'MONTHLY' | 'QUARTERLY' | 'YEARLY'
  period_days?: number
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

// Staff writes carry a CSRF token tied to the current session. It is fetched lazily and, if the server says it went
// stale (e.g. after logging out and back in), fetched once more and the write is retried.
let csrfToken: string | null = null

async function getCsrfToken(): Promise<string> {
  if (!csrfToken) csrfToken = (await request<{ token: string }>('/api/admin/csrf')).token
  return csrfToken
}

async function adminWrite<T>(path: string, body: unknown): Promise<T> {
  const send = async () =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() } })
  try {
    return await send()
  } catch (err) {
    if (err instanceof ApiError && err.status === 403 && /CSRF/i.test(err.message)) {
      csrfToken = null
      return send()
    }
    throw err
  }
}

export const workspaceApi = {
  adminDisableUser: (id: string, reason: string, password: string) => adminWrite<{ id: string; is_active: boolean; sessions_ended: number }>(`/api/admin/users/${encodeURIComponent(id)}/disable`, { reason, password }),
  adminEnableUser: (id: string, reason: string, password: string) => adminWrite<{ id: string; is_active: boolean }>(`/api/admin/users/${encodeURIComponent(id)}/enable`, { reason, password }),
  adminForceLogout: (id: string, reason: string, password: string) => adminWrite<{ id: string; sessions_ended: number }>(`/api/admin/users/${encodeURIComponent(id)}/force-logout`, { reason, password }),
  adminIssueReset: (id: string, reason: string, password: string) => adminWrite<StaffResetLink>(`/api/admin/users/${encodeURIComponent(id)}/password-reset`, { reason, password }),
  adminStartViewAs: (userId: string, reason: string, password: string) => adminWrite<ViewAsStarted>('/api/admin/view-as', { user_id: userId, reason, password }),
  adminViewAs: (viewId: string) => request<ViewAsDashboard>(`/api/admin/view-as/${encodeURIComponent(viewId)}`),
  adminViewAsData: (viewId: string) => request<ViewAsData>(`/api/admin/view-as/${encodeURIComponent(viewId)}/data`),
  adminViewAsTrades: (viewId: string, accountId: string, q: AdminQuery) =>
    request<AdminPage<ViewAsTrade>>(`/api/admin/view-as/${encodeURIComponent(viewId)}/accounts/${encodeURIComponent(accountId)}/trades${adminQuery(q)}`),
  adminEndViewAs: (viewId: string) => adminWrite<{ ended: boolean }>(`/api/admin/view-as/${encodeURIComponent(viewId)}/end`, {}),
  adminBillingIssues: (userId?: string) => request<BillingIssues>(`/api/admin/billing/issues${userId ? `?user_id=${encodeURIComponent(userId)}` : ''}`),
  adminPlanOverride: (workspaceId: string, input: PlanOverrideInput, reason: string, password: string) =>
    adminWrite<{ workspace_id: string; plan: string; subscription_status: string | null; current_period_end: string | null }>(
      `/api/admin/workspaces/${encodeURIComponent(workspaceId)}/plan-override`,
      { ...input, reason, password },
    ),
  adminReconcilePayment: (razorpayPaymentId: string, reason: string, password: string) =>
    adminWrite<{ workspace_id: string; plan: string; billing_cycle: string; current_period_end: string }>('/api/admin/billing/reconcile-payment', {
      razorpay_payment_id: razorpayPaymentId,
      reason,
      password,
    }),
  supportAccess: () => request<{ sessions: SupportAccessSession[] }>('/api/auth/support-access'),

  adminSummary: () => request<AdminSummary>('/api/admin/summary'),
  adminUsers: (q: AdminQuery) => request<AdminPage<AdminUserRow>>(`/api/admin/users${adminQuery(q)}`),
  adminUser: (id: string) => request<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`),
  adminWorkspaces: (q: AdminQuery) => request<AdminPage<AdminWorkspaceRow>>(`/api/admin/workspaces${adminQuery(q)}`),
  adminBillingOverview: () => request<AdminBillingOverview>('/api/admin/billing/overview'),
  adminSubscriptions: (q: AdminQuery) => request<AdminPage<AdminSubscriptionRow>>(`/api/admin/billing/subscriptions${adminQuery(q)}`),
  adminPayments: (q: AdminQuery) => request<AdminPage<AdminPaymentRow>>(`/api/admin/billing/payments${adminQuery(q)}`),
  adminWebhooks: (q: AdminQuery) => request<AdminPage<AdminWebhookRow>>(`/api/admin/billing/webhooks${adminQuery(q)}`),
  adminInvitations: (q: AdminQuery) => request<AdminPage<AdminInvitationRow>>(`/api/admin/invitations${adminQuery(q)}`),
  adminAudit: (q: AdminQuery) => request<AdminPage<AdminAuditRow>>(`/api/admin/audit${adminQuery(q)}`),
  adminAuditActions: () => request<{ actions: string[] }>('/api/admin/audit/actions'),
  adminAuditExport: async (q: AdminQuery): Promise<Blob> => {
    const response = await fetch(`${API_BASE_URL}/api/admin/audit/export${adminQuery(q)}`, { credentials: 'include' })
    if (!response.ok) throw new ApiError(response.status, 'Could not export the audit log.')
    return response.blob()
  },

  devHealth: () => request<DevHealth>('/api/dev/health'),
  devFunctions: () => request<{ functions: FunctionStat[] }>('/api/dev/functions'),
  devErrors: () => request<{ errors: DevError[] }>('/api/dev/errors?limit=100'),
  devRunSelfTests: () => request<SelfTestRun>('/api/dev/selftest/run', { method: 'POST' }),
  devLastSelfTests: () => request<{ last_run: SelfTestRun | null }>('/api/dev/selftest/last'),

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

  /** One page of Dhan's trade history for a date range (Dhan pages from 0); relayed through our backend because Dhan blocks browser calls. */
  getDhanTradeHistory: (accessToken: string, fromDate: string, toDate: string, page: number) =>
    request<unknown[]>('/api/dhan/trade-history', {
      method: 'POST',
      body: JSON.stringify({ access_token: accessToken, from_date: fromDate, to_date: toDate, page }),
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
