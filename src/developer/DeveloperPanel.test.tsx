// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevHealth, FunctionStat } from '../workspace/api'

const auth = vi.hoisted(() => ({ role: 'DEVELOPER' as 'USER' | 'ADMIN' | 'DEVELOPER' }))
const api = vi.hoisted(() => ({
  devHealth: vi.fn(),
  devFunctions: vi.fn(),
  devErrors: vi.fn(),
  devRunSelfTests: vi.fn(),
  devLastSelfTests: vi.fn(),
}))

vi.mock('../workspace/WorkspaceAuthContext', () => ({
  useWorkspaceAuth: () => ({ me: { user: { platform_role: auth.role }, workspaces: [] } }),
}))
vi.mock('../workspace/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/api')>()),
  workspaceApi: api,
}))

import { DeveloperPanel } from './DeveloperPanel'

const now = new Date().toISOString()
const health: DevHealth = {
  overall: 'warn',
  started_at: now,
  generated_at: now,
  tiles: [
    { key: 'api', label: 'API', status: 'ok', summary: '12 requests in the last 5 min', metrics: { requests: 12 }, checked_at: now },
    { key: 'dhan', label: 'Dhan proxy', status: 'down', summary: 'Failing: 4 of 4 recent calls failed', metrics: {}, checked_at: now },
  ],
  config_checks: [{ key: 'cookie_secure', label: 'Session cookie is Secure', ok: false, detail: 'Set JOURNAL_COOKIE_SECURE=true' }],
}
const stat = (over: Partial<FunctionStat>): FunctionStat => ({
  name: 'x', kind: 'function', calls: 1, errors: 0, recent_calls: 1, recent_errors: 0, recent_error_rate: 0,
  p50_ms: 1, p95_ms: 2, p99_ms: 3, last_success: now, last_error: null, last_error_message: null, status: 'ok', ...over,
})

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(
      <MemoryRouter>
        <DeveloperPanel />
      </MemoryRouter>,
    )
  })
  return container
}

beforeEach(() => {
  document.body.innerHTML = ''
  auth.role = 'DEVELOPER'
  api.devHealth.mockResolvedValue(health)
  api.devFunctions.mockResolvedValue({
    functions: [
      stat({ name: 'security.verify_password' }),
      stat({ name: 'dhan.get_trades', kind: 'upstream', status: 'down', errors: 4, last_error_message: 'HTTP 502 Bad Gateway' }),
    ],
  })
  api.devErrors.mockResolvedValue({ errors: [] })
  api.devLastSelfTests.mockResolvedValue({ last_run: null })
})

describe('DeveloperPanel', () => {
  it.each(['USER', 'ADMIN'] as const)('shows an access-denied screen and calls no dev API for a %s', async (role) => {
    auth.role = role
    const container = await mount()
    expect(container.textContent).toContain('Developer access only')
    expect(api.devHealth).not.toHaveBeenCalled()
  })

  it('renders every health tile with its status for a developer', async () => {
    const container = await mount()
    expect(container.textContent).toContain('Some systems degraded')
    expect(container.textContent).toContain('Dhan proxy')
    expect(container.textContent).toContain('Failing: 4 of 4 recent calls failed')
    expect(container.querySelectorAll('.dev-tile-down')).toHaveLength(1)
    expect(container.querySelectorAll('.dev-tile-ok')).toHaveLength(1)
  })

  it('lists tracked functions, flags the failing one, and filters by status', async () => {
    const container = await mount()
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role=tab]')).find((b) => b.textContent?.startsWith('Functions'))!.click()
    })
    expect(container.textContent).toContain('security.verify_password')
    expect(container.textContent).toContain('dhan.get_trades')
    expect(container.querySelectorAll('.dev-row-down')).toHaveLength(1)

    const statusFilter = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')!
    await act(async () => {
      statusFilter.value = 'down'
      statusFilter.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('dhan.get_trades')
    expect(container.textContent).not.toContain('security.verify_password')
  })

  it('shows a readable error instead of crashing when the API fails', async () => {
    api.devHealth.mockRejectedValue(new Error('boom'))
    const container = await mount()
    expect(container.textContent).toContain('Could not load health data')
  })

  it('runs the self-tests on demand and shows pass/fail results', async () => {
    api.devRunSelfTests.mockResolvedValue({
      ran_at: now, passed: 1, failed: 1,
      results: [
        { key: 'a', label: 'Plan limit math', status: 'pass', detail: 'ok', duration_ms: 1 },
        { key: 'b', label: 'Razorpay signature check', status: 'fail', detail: 'FAULTY — tampered signature accepted', duration_ms: 2 },
      ],
    })
    const container = await mount()
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role=tab]')).find((b) => b.textContent?.startsWith('Self-tests'))!.click()
    })
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('Run all self-tests'))!.click()
    })
    expect(api.devRunSelfTests).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('FAULTY — tampered signature accepted')
    expect(container.querySelectorAll('.dev-selftest-fail')).toHaveLength(1)
  })
})
