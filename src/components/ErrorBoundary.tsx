import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  /** Shown in the fallback UI so it's clear which part of the app failed, e.g. "Dashboard" or "Journal". */
  label: string
  children: ReactNode
  /** When true, renders a full-page fallback instead of an inline card — used only at the very top of the tree. */
  fullPage?: boolean
}

interface State {
  error: Error | null
}

/**
 * Fault isolation boundary: a crash inside `children` is caught here instead of unmounting the
 * entire app (React's default when an error escapes a render/effect — the nearest ancestor
 * boundary is the first one that stops the unmount). Placed around each independent section
 * (sidebar, each tab's content, each marketing page, etc.) so one broken feature shows a small
 * "this part crashed" card while everything else — navigation, other tabs, the rest of the page —
 * keeps working. Only class components can implement getDerivedStateFromError/componentDidCatch;
 * there is no hooks equivalent.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack)
  }

  private reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children
    }

    if (this.props.fullPage) {
      return (
        <div className="error-boundary-fullpage">
          <div className="error-boundary-card">
            <AlertTriangle size={28} />
            <h2>Something went wrong</h2>
            <p>The app hit an unexpected error. Your data is safe — try reloading the page.</p>
            <button type="button" className="primary-btn" onClick={() => window.location.reload()}>
              <RefreshCw size={16} />
              Reload
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="error-boundary-inline">
        <AlertTriangle size={18} />
        <div>
          <strong>{this.props.label} couldn&apos;t load</strong>
          <p>Something broke in this section. The rest of the app is unaffected.</p>
        </div>
        <button type="button" className="secondary-btn" onClick={this.reset}>
          <RefreshCw size={14} />
          Retry
        </button>
      </div>
    )
  }
}
