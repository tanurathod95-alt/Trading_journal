// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminAuditRow, AdminPage, AdminUserDetail, AdminUserRow } from '../workspace/api'

const auth = vi.hoisted(() => ({ role: 'ADMIN' as 'USER' | 'ADMIN' | 'DEVELOPER' }))
const api = vi.hoisted(() => ({
  adminSummary: vi.fn(),
  adminUsers: vi.fn(),
  adminUser: vi.fn(),
  adminWorkspaces: vi.fn(),
  adminBillingOverview: vi.fn(),
  adminSubscriptions: vi.fn(),
  adminBillingIssues: vi.fn(),
  adminPayments: vi.fn(),
  adminWebhooks: vi.fn(),
  adminInvitations: vi.fn(),
  adminAudit: vi.fn(),
  adminAuditActions: vi.fn(),
  adminAuditExport: vi.fn(),
}))

vi.mock('../workspace/WorkspaceAuthContext', () => ({
  useWorkspaceAuth: () => ({ me: { user: { platform_role: auth.role }, workspaces: [] } }),
}))
vi.mock('../workspace/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/api')>()),
  workspaceApi: api,
}))

import { AdminPanel } from './AdminPanel'

const now = new Date().toISOString()
const page = <T,>(items: T[]): AdminPage<T> => ({ items, total: items.length, page: 1, page_size: 25 })

const user = (over: Partial<AdminUserRow>): AdminUserRow => ({
  id: 'u1', email: 'alice@example.com', display_name: 'Alice', is_active: true, platform_role: 'USER', created_at: now, last_login_at: now,
  active_sessions: 1, accounts: 2, workspaces: [], plan: 'PRO', subscription_status: 'ACTIVE', subscription_period_end: now, ...over,
})

const detail: AdminUserDetail = {
  profile: { id: 'u1', email: 'alice@example.com', display_name: 'Alice', is_active: true, platform_role: 'USER', created_at: now, last_login_at: now, failed_logins_7d: 7 },
  workspaces: [{ id: 'w1', name: "Alice's Workspace", role: 'OWNER', plan: 'PRO', limits: { max_trading_accounts: 15, max_members_per_account: 10 }, trading_accounts_used: 2, created_at: now }],
  accounts: [{ id: 'a1', name: 'Main', broker_name: 'Angel One', account_type: 'Trading', is_archived: false, role: 'OWNER', workspace_id: 'w1', trades: 12 }],
  subscriptions: [{ id: 's1', workspace_id: 'w1', plan_name: 'PRO', billing_cycle: 'MONTHLY', status: 'ACTIVE', current_period_end: now, created_at: now }],
  payments: [{ id: 'p1', razorpay_payment_id: 'pay_ABC123', razorpay_order_id: 'order_1', amount_inr: 499, status: 'captured', plan_name: 'PRO', billing_cycle: 'MONTHLY', created_at: now }],
  sessions: [{ started_at: now, expires_at: now, active: true }],
  invitations: [],
  audit: [{ id: 'e1', action: 'LOGIN_SUCCESS', created_at: now, ip_address: '1.2.3.4', metadata: null, as_target: false }],
}

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(
      <MemoryRouter>
        <AdminPanel />
      </MemoryRouter>,
    )
  })
  return container
}

const tab = (c: HTMLElement, label: string) =>
  act(async () => Array.from(c.querySelectorAll<HTMLButtonElement>('[role=tab]')).find((b) => b.textContent === label)!.click())

beforeEach(() => {
  document.body.innerHTML = ''
  auth.role = 'ADMIN'
  Object.values(api).forEach((fn) => fn.mockReset())
  api.adminSummary.mockResolvedValue({
    users: { total: 42, disabled: 3, staff: 2, signed_up_today: 1, signed_up_7d: 5, with_active_session: 4 },
    workspaces: { total: 40, by_plan: { FREE: 30, PRO: 10 } }, accounts: { total: 77 },
    billing: { subscriptions_by_status: { ACTIVE: 10 }, expiring_in_7d: 2, paid_last_30d_inr: 4990 },
    invitations: { pending: 6 }, security: { failed_logins_24h: 0 }, generated_at: now,
  })
  api.adminUsers.mockResolvedValue(page([user({}), user({ id: 'u2', email: 'bob@example.com', display_name: 'Bob', is_active: false })]))
  api.adminUser.mockResolvedValue(detail)
  api.adminBillingIssues.mockResolvedValue({ total: 0, by_kind: {}, items: [], unreadable_webhooks: 0, checked_at: now })
  api.adminAuditActions.mockResolvedValue({ actions: ['LOGIN_SUCCESS', 'SIGNUP'] })
  api.adminAudit.mockResolvedValue(page<AdminAuditRow>([]))
})

describe('AdminPanel access', () => {
  it('shows an access-denied screen and calls no admin API for a regular user', async () => {
    auth.role = 'USER'
    const c = await mount()
    expect(c.textContent).toContain('Admin access only')
    expect(api.adminSummary).not.toHaveBeenCalled()
  })

  it.each(['ADMIN', 'DEVELOPER'] as const)('lets a %s in', async (role) => {
    auth.role = role
    const c = await mount()
    expect(c.textContent).toContain('Admin console')
    expect(api.adminSummary).toHaveBeenCalled()
  })

  it('only developers get a link across to the developer console', async () => {
    auth.role = 'ADMIN'
    expect((await mount()).textContent).not.toContain('Developer console')
    document.body.innerHTML = ''
    auth.role = 'DEVELOPER'
    expect((await mount()).textContent).toContain('Developer console')
  })
})

describe('Overview', () => {
  it('shows live counts from the API', async () => {
    const c = await mount()
    expect(c.textContent).toContain('42')
    expect(c.textContent).toContain('77')
    expect(c.textContent).toContain('₹4,990')
    expect(c.textContent).toContain('FREE 30')
  })

  it('shows an error instead of crashing when the summary fails', async () => {
    api.adminSummary.mockRejectedValue(new Error('x'))
    const c = await mount()
    expect(c.textContent).toContain('Could not load the summary')
  })
})

describe('Users', () => {
  it('lists users with role, status and plan', async () => {
    const c = await mount()
    await tab(c, 'Users')
    expect(c.textContent).toContain('alice@example.com')
    expect(c.textContent).toContain('bob@example.com')
    expect(c.textContent).toContain('Disabled')
    expect(api.adminUsers).toHaveBeenCalledWith(expect.objectContaining({ page: 1, page_size: 25 }))
  })

  it('sends filters to the server and returns to page 1', async () => {
    const c = await mount()
    await tab(c, 'Users')
    const status = c.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')!
    await act(async () => {
      status.value = 'disabled'
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(api.adminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'disabled', page: 1 }))
  })

  it('opens a user and shows workspaces, accounts, payments and activity — and flags repeated failed logins', async () => {
    const c = await mount()
    await tab(c, 'Users')
    await act(async () => c.querySelector<HTMLElement>('tr.adm-clickable')!.click())
    expect(api.adminUser).toHaveBeenCalledWith('u1')
    for (const text of ["Alice's Workspace", '2 of 15', 'Angel One', 'pay_ABC123', '₹499.00', 'LOGIN_SUCCESS', 'never shown here']) {
      expect(c.textContent).toContain(text)
    }
    expect(c.querySelector('.adm-warn')?.textContent).toBe('7')
  })

  it('goes back from a user to the list', async () => {
    const c = await mount()
    await tab(c, 'Users')
    await act(async () => c.querySelector<HTMLElement>('tr.adm-clickable')!.click())
    await act(async () => Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('All users'))!.click())
    expect(c.textContent).toContain('bob@example.com')
  })

  it('shows a readable message when a user cannot be loaded', async () => {
    api.adminUser.mockRejectedValue(new Error('x'))
    const c = await mount()
    await tab(c, 'Users')
    await act(async () => c.querySelector<HTMLElement>('tr.adm-clickable')!.click())
    expect(c.textContent).toContain('Could not load this user')
  })

  it('paginates', async () => {
    api.adminUsers.mockResolvedValue({ items: [user({})], total: 60, page: 1, page_size: 25 })
    const c = await mount()
    await tab(c, 'Users')
    expect(c.textContent).toContain('1–25 of 60')
    await act(async () => c.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.click())
    expect(api.adminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))
  })
})

describe('Billing', () => {
  it('shows webhook health and never asks for payloads', async () => {
    api.adminBillingOverview.mockResolvedValue({ last_webhook_at: now, webhooks_total: 9, verification_failures_24h: 2, recent_verification_failures: [{ at: now, user_id: null, workspace_id: 'abcdef123456', ip_address: '9.9.9.9', metadata: null }] })
    api.adminSubscriptions.mockResolvedValue(page([]))
    api.adminWebhooks.mockResolvedValue(page([{ id: 'w', razorpay_event_id: 'evt_1', event_type: 'payment.captured', processed_at: now }]))
    const c = await mount()
    await tab(c, 'Billing')
    expect(c.textContent).toContain('Payment verification failures, 24h')
    expect(c.textContent).toContain('9.9.9.9')
    await act(async () => Array.from(c.querySelectorAll<HTMLButtonElement>('[role=tab]')).find((b) => b.textContent === 'Webhooks')!.click())
    expect(c.textContent).toContain('payment.captured')
    expect(c.textContent).toContain('payloads are deliberately not shown')
  })
})

describe('Audit log', () => {
  it('filters by action and exports a CSV using the same filters', async () => {
    api.adminAudit.mockResolvedValue(page<AdminAuditRow>([{ id: 'e', created_at: now, action: 'SIGNUP', actor_user_id: 'u1', actor_email: 'alice@example.com', target_user_id: null, workspace_id: null, trading_account_id: null, ip_address: '1.1.1.1', metadata: null }]))
    api.adminAuditExport.mockResolvedValue(new Blob(['x'], { type: 'text/csv' }))
    URL.createObjectURL = vi.fn(() => 'blob:fake')
    URL.revokeObjectURL = vi.fn()
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const c = await mount()
    await tab(c, 'Audit log')
    expect(c.textContent).toContain('alice@example.com')
    const action = c.querySelector<HTMLSelectElement>('select[aria-label="Filter by action"]')!
    await act(async () => {
      action.value = 'SIGNUP'
      action.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('Export CSV'))!.click())
    expect(api.adminAuditExport).toHaveBeenCalledWith(expect.objectContaining({ action: 'SIGNUP' }))
    expect(clicked).toHaveBeenCalled()
  })

  it('shows an error if the export fails', async () => {
    api.adminAuditExport.mockRejectedValue(new Error('nope'))
    const c = await mount()
    await tab(c, 'Audit log')
    await act(async () => Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('Export CSV'))!.click())
    expect(c.textContent).toContain('Export failed')
  })
})
