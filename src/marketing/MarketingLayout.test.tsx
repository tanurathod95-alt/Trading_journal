// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real login form needs the auth provider + backend; what's under test here is only where
// MarketingLayout sends the user once the modal reports a successful login.
vi.mock('../workspace/AuthGate', () => ({
  AuthModal: ({ onAuthenticated }: { onAuthenticated: (me: unknown) => void }) => (
    <div>
      <button data-testid="login-as-developer" onClick={() => onAuthenticated({ user: { platform_role: 'DEVELOPER' } })} />
      <button data-testid="login-as-admin" onClick={() => onAuthenticated({ user: { platform_role: 'ADMIN' } })} />
      <button data-testid="login-as-user" onClick={() => onAuthenticated({ user: { platform_role: 'USER' } })} />
      <button data-testid="signup" onClick={() => onAuthenticated(null)} />
    </div>
  ),
}))

import { MarketingLayout } from './MarketingLayout'

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

async function open(initial: string | { pathname: string; state: unknown }): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    createRoot(container).render(
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route element={<MarketingLayout />}>
            <Route index element={<Where />} />
          </Route>
          <Route path="/app/dev" element={<Where />} />
          <Route path="/app/admin" element={<Where />} />
          <Route path="/app" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  return container
}

const click = (container: HTMLElement, id: string) => act(async () => container.querySelector<HTMLElement>(`[data-testid=${id}]`)!.click())
const openLoginModal = (container: HTMLElement) =>
  act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Login')!.click())
const where = (container: HTMLElement) => container.querySelector('[data-testid=where]')!.textContent

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('where a successful login sends the user', () => {
  it('developer -> straight to the developer panel', async () => {
    const c = await open('/')
    await openLoginModal(c)
    await click(c, 'login-as-developer')
    expect(where(c)).toBe('/app/dev')
  })

  it('admin -> straight to the admin panel', async () => {
    const c = await open('/')
    await openLoginModal(c)
    await click(c, 'login-as-admin')
    expect(where(c)).toBe('/app/admin')
  })

  it('regular user -> the normal app', async () => {
    const c = await open('/')
    await openLoginModal(c)
    await click(c, 'login-as-user')
    expect(where(c)).toBe('/app')
  })

  it('new signup -> the normal app', async () => {
    const c = await open('/')
    await openLoginModal(c)
    await click(c, 'signup')
    expect(where(c)).toBe('/app')
  })

  it('a page the visitor was heading to wins over the default', async () => {
    const c = await open({ pathname: '/', state: { openAuth: 'login', from: '/app/dev' } })
    await click(c, 'login-as-user')
    expect(where(c)).toBe('/app/dev')
  })

  it('opening the bare /app while signed out still sends a developer to their panel', async () => {
    const c = await open({ pathname: '/', state: { openAuth: 'login', from: '/app' } })
    await click(c, 'login-as-developer')
    expect(where(c)).toBe('/app/dev')
  })

  it('opening the bare /app while signed out still sends a regular user to the app', async () => {
    const c = await open({ pathname: '/', state: { openAuth: 'login', from: '/app' } })
    await click(c, 'login-as-user')
    expect(where(c)).toBe('/app')
  })

  it('ignores a "from" that is not inside /app', async () => {
    const c = await open({ pathname: '/', state: { openAuth: 'login', from: 'https://evil.example/x' } })
    await click(c, 'login-as-user')
    expect(where(c)).toBe('/app')
  })
})
