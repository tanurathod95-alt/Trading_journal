import { useState } from 'react'
import App from '../App'
import { BusinessMode } from './BusinessMode'
import { ModeHome, type AppMode } from './ModeHome'
import { ModeSidebar } from './ModeSidebar'
import { useWorkspaceAuth } from './WorkspaceAuthContext'
import { WorkspaceBar } from './WorkspaceBar'

/** Renders the post-login mode picker, then the chosen section. */
export function ModeShell() {
  const [mode, setMode] = useState<AppMode | null>(null)
  const { accounts, accountsLoading } = useWorkspaceAuth()

  if (mode === null) {
    return (
      <div className="ws-mode-screen">
        <WorkspaceBar mode="home" showNotificationBell={false} />
        <div className="ws-mode-layout">
          <ModeSidebar />
          <div className="ws-mode-main">
            <ModeHome onSelect={setMode} />
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
      <BusinessMode onGoHome={goHome} />
    </div>
  )
}
