import { useEffect, useState } from 'react'
import App from '../App'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { BillingPage } from './BillingPage'
import { BusinessMode } from './BusinessMode'
import { ModeHome, type AppMode } from './ModeHome'
import { ModeSidebar, type SidebarPanel } from './ModeSidebar'
import { useWorkspaceAuth } from './WorkspaceAuthContext'
import { WorkspaceBar } from './WorkspaceBar'

/** Renders the post-login mode picker, then the chosen section. */
export function ModeShell() {
  // Survives the full-page reload of a broker OAuth redirect (Upstox/Zerodha), so the user
  // returns to the same mode and App can consume ?code= instead of landing on the mode picker.
  const [mode, setMode] = useState<AppMode | null>(() => {
    try {
      return (sessionStorage.getItem('journal-mode') as AppMode | null) ?? null
    } catch {
      return null
    }
  })
  useEffect(() => {
    try {
      if (mode) sessionStorage.setItem('journal-mode', mode)
      else sessionStorage.removeItem('journal-mode')
    } catch {
      // storage unavailable — mode just won't survive a reload
    }
  }, [mode])
  const [panel, setPanel] = useState<SidebarPanel>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const { accounts, accountsLoading } = useWorkspaceAuth()

  if (mode === null) {
    return (
      <div className="ws-mode-screen">
        <ErrorBoundary label="Top bar">
          <WorkspaceBar
            mode="home"
            showNotificationBell={false}
            onOpenMenu={() => setMobileNavOpen(true)}
            onBilling={() => setPanel('billing')}
          />
        </ErrorBoundary>
        <div className="ws-mode-layout">
          <ErrorBoundary label="Sidebar">
            <ModeSidebar
              panel={panel}
              onSelectPanel={setPanel}
              mobileOpen={mobileNavOpen}
              onCloseMobile={() => setMobileNavOpen(false)}
            />
          </ErrorBoundary>
          <div className="ws-mode-main">
            <ErrorBoundary label={panel === 'billing' ? 'Billing' : 'Mode picker'}>
              {panel === 'billing' ? (
                <BillingPage inline onClose={() => setPanel(null)} />
              ) : (
                <ModeHome onSelect={setMode} />
              )}
            </ErrorBoundary>
          </div>
        </div>
      </div>
    )
  }

  const goHome = () => setMode(null)

  if (mode === 'personal') {
    return (
      <ErrorBoundary label="Personal mode">
        <App mode="personal" onGoHome={goHome} />
      </ErrorBoundary>
    )
  }

  if (mode === 'view') {
    const viewerAccountIds = accounts.filter((a) => a.role === 'VIEWER').map((a) => a.id)
    if (viewerAccountIds.length === 0) {
      return (
        <div className="ws-mode-placeholder">
          <button type="button" className="ws-link-btn" onClick={goHome} style={{ marginBottom: 12 }}>
            ← Modes
          </button>
          <h2>{accountsLoading ? 'Loading…' : 'No shared accounts available.'}</h2>
          {!accountsLoading && <p className="ws-muted">Accounts shared with you as a viewer will appear here.</p>}
        </div>
      )
    }
    // Re-mount when the set of shared accounts changes (e.g. right after accepting an invitation) so the journal reloads.
    return (
      <ErrorBoundary label="View mode">
        <App key={viewerAccountIds.join(',')} mode="view" onGoHome={goHome} />
      </ErrorBoundary>
    )
  }

  return (
    <div className="ws-mode-screen">
      <ErrorBoundary label="Top bar">
        <WorkspaceBar mode="business" onChangeMode={goHome} />
      </ErrorBoundary>
      <ErrorBoundary label="Business mode">
        <BusinessMode />
      </ErrorBoundary>
    </div>
  )
}
