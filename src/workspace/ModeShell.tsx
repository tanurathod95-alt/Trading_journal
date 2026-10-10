import { useState } from 'react'
import App from '../App'
import { BillingPage } from './BillingPage'
import { BusinessMode } from './BusinessMode'
import { ModeHome, type AppMode } from './ModeHome'
import { ModeSidebar, type SidebarPanel } from './ModeSidebar'
import { useWorkspaceAuth } from './WorkspaceAuthContext'
import { WorkspaceBar } from './WorkspaceBar'

/** Renders the post-login mode picker, then the chosen section. */
export function ModeShell() {
  const [mode, setMode] = useState<AppMode | null>(null)
  const [panel, setPanel] = useState<SidebarPanel>(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const { accounts, accountsLoading } = useWorkspaceAuth()

  if (mode === null) {
    return (
      <div className="ws-mode-screen">
        <WorkspaceBar
          mode="home"
          showNotificationBell={false}
          onOpenMenu={() => setMobileNavOpen(true)}
          onBilling={() => setPanel('billing')}
        />
        <div className="ws-mode-layout">
          <ModeSidebar
            panel={panel}
            onSelectPanel={setPanel}
            mobileOpen={mobileNavOpen}
            onCloseMobile={() => setMobileNavOpen(false)}
          />
          <div className="ws-mode-main">
            {panel === 'billing' ? (
              <BillingPage inline onClose={() => setPanel(null)} />
            ) : (
              <ModeHome onSelect={setMode} />
            )}
          </div>
        </div>
      </div>
    )
  }

  const goHome = () => setMode(null)

  if (mode === 'personal') {
    return <App mode="personal" onGoHome={goHome} />
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
    return <App key={viewerAccountIds.join(',')} mode="view" onGoHome={goHome} />
  }

  return (
    <div className="ws-mode-screen">
      <WorkspaceBar mode="business" onChangeMode={goHome} />
      <BusinessMode />
    </div>
  )
}
