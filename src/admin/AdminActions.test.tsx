// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type AdminPage, type AdminUserDetail, type AdminUserRow } from '../workspace/api'

const auth = vi.hoisted(() => ({ role: 'ADMIN' as 'ADMIN' | 'DEVELOPER' }))
const api = vi.hoisted(() => ({
  adminSummary: vi.fn(),
  adminUsers: vi.fn(),
  adminUser: vi.fn(),
  adminDisableUser: vi.fn(),
  adminEnableUser: vi.fn(),
  adminForceLogout: vi.fn(),
  adminIssueReset: vi.fn(),
  adminStartViewAs: vi.fn(),
  adminEndViewAs: vi.fn(),
  adminBillingIssues: vi.fn(),
  adminPlanOverride: vi.fn(),
  adminReconcilePayment: vi.fn(),
}))
// The real dashboard (App) is a huge screen with its own tests; here it is a stand-in that reports back like the real one does.
const dashboardStub = vi.hoisted(() => ({ result: { displayName: 'Alice', truncated: false } as { displayName: string; truncated: boolean; error?: string } }))
vi.mock('../App', async () => {
  const { useEffect } = await import('react')
  return {
    default: ({ supportViewId, onSupportLoaded }: { supportViewId?: string; onSupportLoaded?: (info: typeof dashboardStub.result) => void }) => {
      // Like the real dashboard, report once when the data has loaded — not on every render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      useEffect(() => onSupportLoaded?.(dashboardStub.result), [])
      return <div>REAL DASHBOARD for {supportViewId}</div>
    },
  }
})

vi.mock('../workspace/WorkspaceAuthContext', () => ({
  useWorkspaceAuth: () => ({ me: { user: { id: 'me-id', platform_role: auth.role }, workspaces: [] } }),
}))
vi.mock('../workspace/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/api')>()),
  workspaceApi: api,
}))

import { AdminPanel } from './AdminPanel'

const now = new Date().toISOString()
const page = <T,>(items: T[]): AdminPage<T> => ({ items, total: items.length, page: 1, page_size: 25 })

const row: AdminUserRow = {
  id: 'u1', email: 'alice@example.com', display_name: 'Alice', is_active: true, platform_role: 'USER', created_at: now, last_login_at: now,
  active_sessions: 1, accounts: 1, workspaces: [], plan: 'PRO', subscription_status: 'ACTIVE', subscription_period_end: now,
}

const detail: AdminUserDetail = {
  profile: { id: 'u1', email: 'alice@example.com', display_name: 'Alice', is_active: true, platform_role: 'USER', created_at: now, last_login_at: now, failed_logins_7d: 0 },
  workspaces: [], accounts: [], subscriptions: [], payments: [],
  sessions: [{ started_at: now, expires_at: now, active: true }],
  invitations: [], audit: [],
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

const click = (text: string, root: ParentNode = document) =>
  act(async () => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(text))!.click())

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function openUser(c: HTMLElement) {
  await act(async () => Array.from(c.querySelectorAll<HTMLButtonElement>('[role=tab]')).find((b) => b.textContent === 'Users')!.click())
  await act(async () => c.querySelector<HTMLElement>('tr.adm-clickable')!.click())
  expect(api.adminUser).toHaveBeenCalledWith('u1')
}

async function fillAndConfirm(label: string, reason = 'Customer called support', password = 'my-password') {
  const dialog = document.querySelector('[role=dialog]') as HTMLElement
  await typeInto(dialog.querySelector('textarea')!, reason)
  await typeInto(dialog.querySelector('input[type=password]')!, password)
  await click(label, dialog)
}

const dialogText = () => document.querySelector('[role=dialog]')?.textContent ?? ''

beforeEach(() => {
  document.body.innerHTML = ''
  auth.role = 'ADMIN'
  Object.values(api).forEach((fn) => fn.mockReset())
  api.adminSummary.mockResolvedValue({
    users: { total: 1, disabled: 0, staff: 0, signed_up_today: 0, signed_up_7d: 0, with_active_session: 0 }, workspaces: { total: 1, by_plan: {} }, accounts: { total: 0 },
    billing: { subscriptions_by_status: {}, expiring_in_7d: 0, paid_last_30d_inr: 0 }, invitations: { pending: 0 }, security: { failed_logins_24h: 0 }, generated_at: now,
  })
  api.adminUsers.mockResolvedValue(page([row]))
  api.adminUser.mockResolvedValue(detail)
  api.adminBillingIssues.mockResolvedValue({ total: 0, by_kind: {}, items: [], unreadable_webhooks: 0, checked_at: now })
})

describe('Billing on the user page', () => {
  const billed = {
    ...detail,
    workspaces: [{ id: 'w1', name: "Alice's Workspace", role: 'OWNER', plan: 'PRO', limits: { max_trading_accounts: 5, max_members_per_account: 3 }, trading_accounts_used: 2, created_at: now }],
    subscriptions: [{ id: 's1', workspace_id: 'w1', plan_name: 'PRO', billing_cycle: 'MONTHLY', status: 'ACTIVE', current_period_end: now, created_at: now }],
    payments: [{ id: 'p1', razorpay_payment_id: 'pay_ABC123', razorpay_order_id: 'o1', amount_inr: 499, status: 'captured', plan_name: 'PRO', billing_cycle: 'MONTHLY', created_at: now }],
  }

  it('shows each workspace’s plan, subscription and payments in one place, scoped to this customer', async () => {
    api.adminUser.mockResolvedValue(billed)
    const c = await mount()
    await openUser(c)
    expect(api.adminBillingIssues).toHaveBeenCalledWith('u1')
    for (const text of ['Billing & plan', "Alice's Workspace", 'Accounts used 2 of 5', 'ACTIVE', 'pay_ABC123', 'No billing problems found for this customer', 'Change plan…']) {
      expect(c.textContent).toContain(text)
    }
  })

  it('changes the plan from here with a reason and password, then re-reads the record', async () => {
    api.adminUser.mockResolvedValue(billed)
    api.adminPlanOverride.mockResolvedValue({ workspace_id: 'w1', plan: 'PREMIUM', subscription_status: 'ACTIVE', current_period_end: now })
    const c = await mount()
    await openUser(c)
    await click('Change plan…')
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="New plan"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'PREMIUM')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await fillAndConfirm('Change plan', 'Customer upgraded by phone')
    expect(api.adminPlanOverride).toHaveBeenCalledWith('w1', expect.objectContaining({ plan: 'PREMIUM' }), 'Customer upgraded by phone', 'my-password')
    expect(c.textContent).toContain("Alice's Workspace is now on PREMIUM.")
    expect(api.adminUser).toHaveBeenCalledTimes(2) // re-read so the new plan shows
  })

  it('lists this customer’s billing problems with the fix next to them', async () => {
    api.adminUser.mockResolvedValue(billed)
    api.adminBillingIssues.mockResolvedValue({
      total: 1, by_kind: { unrecorded_payment: 1 }, unreadable_webhooks: 0, checked_at: now,
      items: [{
        kind: 'unrecorded_payment', severity: 'high', workspace_id: 'w1', workspace_name: "Alice's Workspace", owner_email: 'alice@example.com', title: 'Payment received but not recorded',
        detail: 'Razorpay captured ₹2,699.00 (pay_LOST) but no plan was activated for it.', payment_id: 'pay_LOST', amount_inr: 2699, plan_name: 'PREMIUM', billing_cycle: 'QUARTERLY', can_reconcile: true,
      }],
    })
    const c = await mount()
    await openUser(c)
    expect(c.textContent).toContain('Billing problems (1)')
    expect(c.textContent).toContain('Payment received but not recorded')
    expect(c.textContent).toContain('Record this payment')
  })
})

describe('Support actions', () => {
  it('shows the four actions for a customer', async () => {
    const c = await mount()
    await openUser(c)
    for (const label of ['View dashboard (read-only)', 'Issue password-reset link', 'Sign out everywhere', 'Disable account']) {
      expect(c.textContent).toContain(label)
    }
  })

  it('keeps the confirm button off until there is a real reason and a password', async () => {
    const c = await mount()
    await openUser(c)
    await click('Disable account')
    const dialog = document.querySelector('[role=dialog]') as HTMLElement
    const confirm = () => Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('Disable account'))!
    expect(confirm().disabled).toBe(true)
    await typeInto(dialog.querySelector('textarea')!, 'no')
    await typeInto(dialog.querySelector('input[type=password]')!, 'pw')
    expect(confirm().disabled).toBe(true) // reason too short
    await typeInto(dialog.querySelector('textarea')!, 'Suspected takeover')
    expect(confirm().disabled).toBe(false)
  })

  it('disables an account with the reason and password, then shows it as disabled', async () => {
    api.adminDisableUser.mockResolvedValue({ id: 'u1', is_active: false, sessions_ended: 1 })
    const c = await mount()
    await openUser(c)
    await click('Disable account')
    await fillAndConfirm('Disable account', 'Suspected takeover', 'secret-pw')
    expect(api.adminDisableUser).toHaveBeenCalledWith('u1', 'Suspected takeover', 'secret-pw')
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(c.textContent).toContain('Account disabled')
    expect(c.textContent).toContain('Enable account') // the button flipped
  })

  it('shows the server error, clears the password and keeps the dialog open when the password is wrong', async () => {
    api.adminDisableUser.mockRejectedValue(new ApiError(403, 'Your password is incorrect.'))
    const c = await mount()
    await openUser(c)
    await click('Disable account')
    await fillAndConfirm('Disable account')
    expect(dialogText()).toContain('Your password is incorrect.')
    expect((document.querySelector('[role=dialog] input[type=password]') as HTMLInputElement).value).toBe('')
    expect(c.textContent).not.toContain('Account disabled')
  })

  it('enables a disabled account', async () => {
    api.adminUser.mockResolvedValue({ ...detail, profile: { ...detail.profile, is_active: false } })
    api.adminEnableUser.mockResolvedValue({ id: 'u1', is_active: true })
    const c = await mount()
    await openUser(c)
    await click('Enable account')
    await fillAndConfirm('Enable account', 'Identity verified by phone')
    expect(api.adminEnableUser).toHaveBeenCalledWith('u1', 'Identity verified by phone', 'my-password')
    expect(c.textContent).toContain('Account enabled')
    expect(c.textContent).toContain('Disable account')
  })

  it('signs a customer out everywhere and marks their sessions ended', async () => {
    api.adminForceLogout.mockResolvedValue({ id: 'u1', sessions_ended: 2 })
    const c = await mount()
    await openUser(c)
    await click('Sign out everywhere')
    await fillAndConfirm('Sign out everywhere')
    expect(c.textContent).toContain('2 session(s) ended')
    expect(c.textContent).toContain('Expired')
  })

  it('cannot issue a reset link for a disabled account (the button is off)', async () => {
    api.adminUser.mockResolvedValue({ ...detail, profile: { ...detail.profile, is_active: false } })
    const c = await mount()
    await openUser(c)
    const reset = Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('Issue password-reset link'))!
    expect(reset.disabled).toBe(true)
  })

  it('shows a password-reset link once, with the safety instructions', async () => {
    api.adminIssueReset.mockResolvedValue({ reset_url: 'http://localhost:5173/app?reset_token=abc123', expires_at: now, valid_minutes: 60, email: 'alice@example.com' })
    const c = await mount()
    await openUser(c)
    await click('Issue password-reset link')
    await fillAndConfirm('Create link', 'Locked out, verified by callback')
    expect(api.adminIssueReset).toHaveBeenCalledWith('u1', 'Locked out, verified by callback', 'my-password')
    expect(document.querySelector('[data-testid=reset-url]')!.textContent).toBe('http://localhost:5173/app?reset_token=abc123')
    expect(dialogText()).toContain("only time you'll see it")
    expect(dialogText()).toContain('You never see or set it')
    await click("I've passed it on")
    expect(document.querySelector('[data-testid=reset-url]')).toBeNull() // gone for good
  })

  it("won't offer actions on your own account", async () => {
    api.adminUser.mockResolvedValue({ ...detail, profile: { ...detail.profile, id: 'me-id' } })
    const c = await mount()
    await openUser(c)
    expect(c.textContent).toContain('This is your own account')
    expect(c.textContent).not.toContain('Disable account')
  })

  it('an admin cannot manage another staff account, a developer can (but not view-as)', async () => {
    api.adminUser.mockResolvedValue({ ...detail, profile: { ...detail.profile, platform_role: 'ADMIN' } })
    let c = await mount()
    await openUser(c)
    expect(c.textContent).toContain('Only a developer can manage it')
    expect(c.textContent).not.toContain('Disable account')

    document.body.innerHTML = ''
    auth.role = 'DEVELOPER'
    c = await mount()
    await openUser(c)
    expect(c.textContent).toContain('Disable account')
    expect(c.textContent).not.toContain('View dashboard') // "view as" is for customers only
  })
})

describe('View as user', () => {
  beforeEach(() => {
    dashboardStub.result = { displayName: 'Alice', truncated: false }
    api.adminStartViewAs.mockResolvedValue({ id: 'v1', started_at: now, idle_timeout_minutes: 30, user: { id: 'u1', email: 'alice@example.com', display_name: 'Alice' } })
    api.adminEndViewAs.mockResolvedValue({ ended: true })
  })

  async function startView(c: HTMLElement) {
    await openUser(c)
    await click('View dashboard (read-only)')
    await fillAndConfirm('Open read-only view', 'Investigating missing trades')
  }

  it('starts a read-only view with a reason and password and opens the customer’s real dashboard', async () => {
    const c = await mount()
    await startView(c)
    expect(api.adminStartViewAs).toHaveBeenCalledWith('u1', 'Investigating missing trades', 'my-password')
    for (const text of ['REAL DASHBOARD for v1', 'Viewing Alice\'s dashboard — read-only', 'you can’t change anything', 'Journal notes and trade reasons are private']) {
      expect(c.textContent).toContain(text)
    }
  })

  it('says so when only their most recent trades are shown', async () => {
    dashboardStub.result = { displayName: 'Alice', truncated: true }
    const c = await mount()
    await startView(c)
    expect(c.textContent).toContain('5,000 most recent trades')
  })

  it('ends the view and returns to the user record', async () => {
    const c = await mount()
    await startView(c)
    await click('End view')
    expect(api.adminEndViewAs).toHaveBeenCalledWith('v1')
    expect(c.textContent).toContain('Support actions')
    expect(c.textContent).not.toContain('REAL DASHBOARD')
  })

  it('explains it when the view has already ended or timed out', async () => {
    dashboardStub.result = { displayName: '', truncated: false, error: 'This view closed after 30 minutes without activity.' }
    const c = await mount()
    await startView(c)
    expect(c.textContent).toContain('closed after 30 minutes without activity')
    await click('Back to users')
    expect(c.textContent).toContain('alice@example.com')
    expect(c.textContent).not.toContain('REAL DASHBOARD')
  })

  it('does not open the view when the password was wrong', async () => {
    api.adminStartViewAs.mockRejectedValue(new ApiError(403, 'Your password is incorrect.'))
    const c = await mount()
    await startView(c)
    expect(dialogText()).toContain('Your password is incorrect.')
    expect(c.textContent).not.toContain('REAL DASHBOARD')
  })
})
