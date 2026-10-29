// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportAccessSession } from './api'

const api = vi.hoisted(() => ({ supportAccess: vi.fn(), changePassword: vi.fn() }))

vi.mock('./WorkspaceAuthContext', () => ({
  useWorkspaceAuth: () => ({ me: { user: { email: 'a@example.com', display_name: 'Alice' }, workspaces: [] }, updateDisplayName: vi.fn() }),
}))
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  workspaceApi: api,
}))

import { ProfileModal } from './ProfileModal'

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => createRoot(container).render(<ProfileModal onClose={() => {}} />))
  return container
}

beforeEach(() => {
  document.body.innerHTML = ''
  api.supportAccess.mockReset()
})

describe('Support access notice', () => {
  it('tells the customer when support has never looked at their data', async () => {
    api.supportAccess.mockResolvedValue({ sessions: [] })
    const c = await mount()
    expect(c.textContent).toContain('Support access to your data')
    expect(c.textContent).toContain('has not looked at your account data')
  })

  it('lists each time support opened a read-only view, without naming anyone', async () => {
    const sessions: SupportAccessSession[] = [
      { started_at: '2026-10-20T10:00:00Z', ended_at: '2026-10-20T10:12:00Z', by: 'Platform support' },
      { started_at: '2026-10-25T09:00:00Z', ended_at: null, by: 'Platform support' },
    ]
    api.supportAccess.mockResolvedValue({ sessions })
    const c = await mount()
    expect(c.querySelectorAll('li')).toHaveLength(2)
    expect(c.textContent).toContain('closed')
    expect(c.textContent).toContain('open now')
    expect(c.textContent).toContain('cannot change anything')
  })

  it('shows nothing (instead of breaking) if the notice cannot be loaded', async () => {
    api.supportAccess.mockRejectedValue(new Error('offline'))
    const c = await mount()
    expect(c.textContent).not.toContain('Support access to your data')
    expect(c.textContent).toContain('Your Profile')
  })
})
