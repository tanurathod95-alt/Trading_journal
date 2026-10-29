// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { Activity, Users } from 'lucide-react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConsoleShell } from './ConsoleShell'

const ITEMS = [
  { key: 'a', label: 'First page', icon: Activity },
  { key: 'b', label: 'Second page', icon: Users, badge: 3 },
]

function Harness() {
  const [active, setActive] = useState('a')
  return (
    <MemoryRouter>
      <ConsoleShell
        title="Test console"
        subtitle="sub"
        icon={Activity}
        roleLabel="ADMIN"
        items={ITEMS}
        active={active}
        onSelect={setActive}
        goTo={[{ label: 'Back to app', to: '/app', icon: Activity }]}
        pageTitle={ITEMS.find((i) => i.key === active)!.label}
        status={<span>chip</span>}
      >
        <p data-testid="body">showing {active}</p>
      </ConsoleShell>
    </MemoryRouter>
  )
}

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => createRoot(container).render(<Harness />))
  return container
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
  localStorage.clear()
})

describe('ConsoleShell', () => {
  it('lists every section in the sidebar, with counts, and a Go to group', async () => {
    const c = await mount()
    const tabs = Array.from(c.querySelectorAll('[role=tab]')).map((t) => t.textContent)
    expect(tabs).toEqual(['First page', 'Second page3'])
    expect(c.querySelector('.con-goto')!.textContent).toContain('Back to app')
    expect(c.querySelector('.con-role')!.textContent).toBe('ADMIN')
    expect(c.textContent).toContain('chip')
  })

  it('switches page when a sidebar item is chosen and marks it selected', async () => {
    const c = await mount()
    await act(async () => c.querySelectorAll<HTMLElement>('[role=tab]')[1].click())
    expect(c.querySelector('[data-testid=body]')!.textContent).toBe('showing b')
    expect(c.querySelector('h1')!.textContent).toBe('Second page')
    expect(c.querySelectorAll('[role=tab]')[1].getAttribute('aria-selected')).toBe('true')
    expect(c.querySelectorAll('[role=tab]')[0].getAttribute('aria-selected')).toBe('false')
  })

  it('opens the sidebar as a drawer on small screens and closes it after picking a page', async () => {
    const c = await mount()
    const sidebar = c.querySelector('.con-sidebar')!
    expect(sidebar.classList.contains('open')).toBe(false)
    await act(async () => c.querySelector<HTMLElement>('.con-menu')!.click())
    expect(sidebar.classList.contains('open')).toBe(true)
    expect(c.querySelector('.con-backdrop')).not.toBeNull()
    await act(async () => c.querySelectorAll<HTMLElement>('[role=tab]')[1].click())
    expect(sidebar.classList.contains('open')).toBe(false)
  })

  it('toggles the theme, applies it to the page and remembers it', async () => {
    const c = await mount()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    await act(async () => c.querySelector<HTMLElement>('.con-theme')!.click())
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('journal-theme')).toBe('dark')
  })

  it('starts in the theme the rest of the app saved', async () => {
    localStorage.setItem('journal-theme', 'dark')
    await mount()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
