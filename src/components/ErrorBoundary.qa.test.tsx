// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

function Boom(): never {
  throw new Error('Simulated crash for QA')
}

function Safe() {
  return <div data-testid="safe">I rendered fine</div>
}

function mount(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(node)
  })
  return container
}

describe('ErrorBoundary fault isolation (real client render, jsdom)', () => {
  it('catches a crash and renders the fallback instead of propagating', () => {
    const container = mount(
      <ErrorBoundary label="Test Section">
        <Boom />
      </ErrorBoundary>,
    )
    expect(container.innerHTML).toContain("Test Section couldn't load")
    expect(container.innerHTML).toContain('Retry')
  })

  it('a crash in one boundary does not affect a sibling boundary', () => {
    const container = mount(
      <div>
        <ErrorBoundary label="Broken Section">
          <Boom />
        </ErrorBoundary>
        <ErrorBoundary label="Healthy Section">
          <Safe />
        </ErrorBoundary>
      </div>,
    )
    expect(container.innerHTML).toContain("Broken Section couldn't load")
    expect(container.innerHTML).toContain('I rendered fine')
  })

  it('renders children normally when nothing throws', () => {
    const container = mount(
      <ErrorBoundary label="Fine Section">
        <Safe />
      </ErrorBoundary>,
    )
    expect(container.innerHTML).toContain('I rendered fine')
    expect(container.innerHTML).not.toContain("couldn't load")
  })

  it('fullPage mode renders the full-page fallback with a reload action', () => {
    const container = mount(
      <ErrorBoundary label="App" fullPage>
        <Boom />
      </ErrorBoundary>,
    )
    expect(container.innerHTML).toContain('Something went wrong')
    expect(container.innerHTML).toContain('Reload')
  })
})
