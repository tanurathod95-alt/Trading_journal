// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type AdminPage, type AdminWorkspaceRow, type BillingIssue } from '../workspace/api'

const api = vi.hoisted(() => ({
  adminBillingOverview: vi.fn(),
  adminBillingIssues: vi.fn(),
  adminSubscriptions: vi.fn(),
  adminPayments: vi.fn(),
  adminWebhooks: vi.fn(),
  adminWorkspaces: vi.fn(),
  adminSummary: vi.fn(),
  adminPlanOverride: vi.fn(),
  adminReconcilePayment: vi.fn(),
}))

vi.mock('../workspace/WorkspaceAuthContext', () => ({
  useWorkspaceAuth: () => ({ me: { user: { id: 'me-id', platform_role: 'ADMIN' }, workspaces: [] } }),
}))
vi.mock('../workspace/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/api')>()),
  workspaceApi: api,
}))

import { AdminPanel } from './AdminPanel'

const now = new Date().toISOString()
const page = <T,>(items: T[]): AdminPage<T> => ({ items, total: items.length, page: 1, page_size: 25 })

const lostPayment: BillingIssue = {
  kind: 'unrecorded_payment', severity: 'high', workspace_id: 'w1', workspace_name: "Alice's Workspace", owner_email: 'alice@example.com',
  title: 'Payment received but not recorded', detail: 'Razorpay captured ₹2,699.00 (pay_LOST) but no plan was activated for it.',
  payment_id: 'pay_LOST', order_id: 'order_OLD', amount_inr: 2699, plan_name: 'PREMIUM', billing_cycle: 'QUARTERLY', when: now, can_reconcile: true,
}
const mismatch: BillingIssue = {
  kind: 'plan_mismatch', severity: 'high', workspace_id: 'w2', workspace_name: 'Bob WS', owner_email: 'bob@example.com',
  title: 'Plan and subscription disagree', detail: 'The workspace is on PRO but its active subscription is for BUSINESS.', current_plan: 'PRO', subscription_plan: 'BUSINESS',
}
const noPayment: BillingIssue = {
  kind: 'plan_without_payment', severity: 'medium', workspace_id: 'w3', workspace_name: 'Carol WS', owner_email: 'carol@example.com',
  title: 'Paid plan without an active subscription', detail: 'On PREMIUM, but there is no subscription.', current_plan: 'PREMIUM',
}
const stuck: BillingIssue = {
  kind: 'stuck_checkout', severity: 'low', workspace_id: 'w4', workspace_name: 'Dan WS', owner_email: 'dan@example.com',
  title: 'Checkout never finished', detail: 'A PRO monthly checkout was started 5 hour(s) ago and no payment arrived.',
}
const unfixable: BillingIssue = { ...lostPayment, payment_id: 'pay_ODD', can_reconcile: false, detail: "It can't be matched automatically — check it in Razorpay." }

const issues = (items: BillingIssue[], extra = {}) => ({ total: items.length, by_kind: {}, items, unreadable_webhooks: 0, checked_at: now, ...extra })

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => createRoot(container).render(<MemoryRouter><AdminPanel /></MemoryRouter>))
  return container
}

const openTab = (c: HTMLElement, name: string) =>
  act(async () => Array.from(c.querySelectorAll<HTMLButtonElement>('[role=tab]')).find((b) => b.textContent?.startsWith(name))!.click())
const click = (text: string, root: ParentNode = document) =>
  act(async () => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(text))!.click())

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function fillAndConfirm(label: string, reason = 'Customer paid, checked in Razorpay', password = 'my-password') {
  const dialog = document.querySelector('[role=dialog]') as HTMLElement
  await typeInto(dialog.querySelector('textarea')!, reason)
  await typeInto(dialog.querySelector('input[type=password]')!, password)
  await click(label, dialog)
}

const selectValue = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!

beforeEach(() => {
  document.body.innerHTML = ''
  Object.values(api).forEach((fn) => fn.mockReset())
  api.adminSummary.mockResolvedValue({
    users: { total: 1, disabled: 0, staff: 0, signed_up_today: 0, signed_up_7d: 0, with_active_session: 0 }, workspaces: { total: 1, by_plan: {} }, accounts: { total: 0 },
    billing: { subscriptions_by_status: {}, expiring_in_7d: 0, paid_last_30d_inr: 0 }, invitations: { pending: 0 }, security: { failed_logins_24h: 0 }, generated_at: now,
  })
  api.adminBillingOverview.mockResolvedValue({ last_webhook_at: null, webhooks_total: 0, verification_failures_24h: 0, recent_verification_failures: [] })
  api.adminBillingIssues.mockResolvedValue(issues([lostPayment, mismatch, noPayment, stuck]))
  api.adminSubscriptions.mockResolvedValue(page([]))
  api.adminPayments.mockResolvedValue(page([]))
  api.adminWebhooks.mockResolvedValue(page([]))
})

describe('Billing: Needs attention', () => {
  it('opens on the problems, worst first, with a count on the tab', async () => {
    const c = await mount()
    await openTab(c, 'Billing')
    const tab = Array.from(c.querySelectorAll('[role=tab]')).find((t) => t.textContent?.startsWith('Needs attention'))!
    expect(tab.textContent).toBe('Needs attention (4)')
    expect(tab.getAttribute('aria-selected')).toBe('true')
    const titles = Array.from(c.querySelectorAll('.adm-issue-head strong')).map((e) => e.textContent)
    expect(titles).toEqual(['Payment received but not recorded', 'Plan and subscription disagree', 'Paid plan without an active subscription', 'Checkout never finished'])
    expect(c.textContent).toContain('HIGH')
    expect(c.textContent).toContain("Alice's Workspace · alice@example.com")
    expect(c.textContent).toContain('refunds and disputes are handled in the Razorpay dashboard'.replace('refunds', 'Refunds'))
  })

  it('says all clear when nothing is wrong', async () => {
    api.adminBillingIssues.mockResolvedValue(issues([]))
    const c = await mount()
    await openTab(c, 'Billing')
    expect(c.textContent).toContain('All clear')
  })

  it('shows an error instead of crashing if the check fails', async () => {
    api.adminBillingIssues.mockRejectedValue(new ApiError(500, 'boom'))
    const c = await mount()
    await openTab(c, 'Billing')
    expect(c.textContent).toContain('boom')
  })

  it('mentions payment notices it could not read', async () => {
    api.adminBillingIssues.mockResolvedValue(issues([], { unreadable_webhooks: 2 }))
    const c = await mount()
    await openTab(c, 'Billing')
    expect(c.textContent).toContain('2 stored payment notice(s) were too long to read')
  })

  it('links every payment issue to Razorpay in a new tab, safely', async () => {
    const c = await mount()
    await openTab(c, 'Billing')
    const link = c.querySelector<HTMLAnchorElement>('a[href*="dashboard.razorpay.com"]')!
    expect(link.href).toBe('https://dashboard.razorpay.com/app/payments/pay_LOST')
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noopener')
  })

  it('records a lost payment with a reason and password, then re-checks', async () => {
    api.adminReconcilePayment.mockResolvedValue({ workspace_id: 'w1', plan: 'PREMIUM', billing_cycle: 'QUARTERLY', current_period_end: now })
    const c = await mount()
    await openTab(c, 'Billing')
    await click('Record this payment')
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('Confirm the payment in Razorpay first')
    await fillAndConfirm('Record payment and activate plan')
    expect(api.adminReconcilePayment).toHaveBeenCalledWith('pay_LOST', 'Customer paid, checked in Razorpay', 'my-password')
    expect(c.textContent).toContain("Alice's Workspace is now on PREMIUM (quarterly)")
    expect(api.adminBillingIssues).toHaveBeenCalledTimes(2) // refreshed after the fix
  })

  it("offers no 'record' button for a payment that can't be matched automatically", async () => {
    api.adminBillingIssues.mockResolvedValue(issues([unfixable]))
    const c = await mount()
    await openTab(c, 'Billing')
    expect(c.textContent).not.toContain('Record this payment')
    expect(c.textContent).toContain('Open in Razorpay')
  })

  it('keeps the dialog open and shows the server message when recording is refused', async () => {
    api.adminReconcilePayment.mockRejectedValue(new ApiError(409, 'That payment is already recorded.'))
    const c = await mount()
    await openTab(c, 'Billing')
    await click('Record this payment')
    await fillAndConfirm('Record payment and activate plan')
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('That payment is already recorded.')
  })

  it('suggests the subscription’s plan for a mismatch and FREE for a plan nobody paid for', async () => {
    const c = await mount()
    await openTab(c, 'Billing')
    const changeButtons = Array.from(c.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b.textContent?.includes('Change plan…'))
    expect(changeButtons).toHaveLength(2) // mismatch + no-payment; none for the lost payment or the stuck checkout
    await act(async () => changeButtons[0].click())
    expect(selectValue('New plan').value).toBe('BUSINESS')
    await click('Cancel')
    await act(async () => changeButtons[1].click())
    expect(selectValue('New plan').value).toBe('FREE')
  })
})

describe('Plan dialog', () => {
  const workspaceRow: AdminWorkspaceRow = {
    id: 'w9', name: 'Zed WS', owner_email: 'zed@example.com', plan: 'FREE', members: 1, limits: { max_trading_accounts: 3, max_members_per_account: 2 },
    trading_accounts_used: 1, subscription_status: null, subscription_period_end: null, created_at: now,
  }

  async function openPlanDialog() {
    api.adminWorkspaces.mockResolvedValue(page([workspaceRow]))
    const c = await mount()
    await openTab(c, 'Workspaces & plans')
    await click('Change plan…')
    return c
  }

  it('changes a plan with cycle and a custom number of days', async () => {
    api.adminPlanOverride.mockResolvedValue({ workspace_id: 'w9', plan: 'PRO', subscription_status: 'ACTIVE', current_period_end: now })
    const c = await openPlanDialog()
    await act(async () => {
      selectValue('New plan').value = 'PRO'
      selectValue('New plan').dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      selectValue('Billing cycle').value = 'YEARLY'
      selectValue('Billing cycle').dispatchEvent(new Event('change', { bubbles: true }))
    })
    await typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Days the plan lasts"]')!, '10')
    await fillAndConfirm('Change plan', 'Goodwill: 10 days free')
    expect(api.adminPlanOverride).toHaveBeenCalledWith('w9', { plan: 'PRO', billing_cycle: 'YEARLY', period_days: 10 }, 'Goodwill: 10 days free', 'my-password')
    expect(c.textContent).toContain('Zed WS is now on PRO')
    expect(api.adminWorkspaces).toHaveBeenCalledTimes(2) // list reloaded
  })

  it('hides cycle and days for FREE and labels the button as ending the plan', async () => {
    await openPlanDialog()
    await act(async () => {
      selectValue('New plan').value = 'FREE'
      selectValue('New plan').dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(document.querySelector('select[aria-label="Billing cycle"]')).toBeNull()
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('End paid plan')
  })

  it('refuses a nonsense number of days before calling the server', async () => {
    await openPlanDialog()
    await act(async () => {
      selectValue('New plan').value = 'PRO'
      selectValue('New plan').dispatchEvent(new Event('change', { bubbles: true }))
    })
    await typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Days the plan lasts"]')!, '9999')
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('whole number from 1 to 730')
    await fillAndConfirm('Change plan')
    expect(api.adminPlanOverride).not.toHaveBeenCalled()
  })

  it('says plainly that no money moves', async () => {
    await openPlanDialog()
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('does not move any money')
  })
})

describe('Payments list', () => {
  it('has a Razorpay link for refunds and disputes on every payment', async () => {
    api.adminPayments.mockResolvedValue(page([{ id: 'p', razorpay_payment_id: 'pay_123', razorpay_order_id: 'o', amount_inr: 499, status: 'captured', plan_name: 'PRO', billing_cycle: 'MONTHLY', created_at: now, workspace_name: 'W', owner_email: 'o@example.com' }]))
    const c = await mount()
    await openTab(c, 'Billing')
    await openTab(c, 'Payments')
    expect(c.textContent).toContain('Refunds / disputes')
    expect(c.querySelector<HTMLAnchorElement>('a[href$="/pay_123"]')).not.toBeNull()
  })
})
