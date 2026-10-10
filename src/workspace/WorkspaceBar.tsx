import { useState } from 'react'
import { Bell } from 'lucide-react'
import { AccountSwitcher } from './AccountSwitcher'
import { InvitationsInbox } from './InvitationsInbox'
import { ProfileModal } from './ProfileModal'
import { UserMenu } from './UserMenu'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

/**
 * A thin persistent strip above the existing (untouched) Journal app,
 * surfacing the new backend-driven Workspace/TradingAccount model:
 * current workspace, the account switcher, and every SaaS-layer feature
 * (accounts, portfolios, billing, sharing). Deliberately does not touch
 * App.tsx or the Dexie-backed trade data.
 */
type BarMode = 'home' | 'personal' | 'view' | 'business'

const modeLabels: Record<BarMode, string> = { home: '', personal: 'Personal Trading', view: 'View Section', business: 'Business' }

export function WorkspaceBar({
  mode = 'personal',
  onChangeMode,
  showNotificationBell = true,
}: { mode?: BarMode; onChangeMode?: () => void; showNotificationBell?: boolean } = {}) {
  const { me, currentWorkspace, logout, myInvitations, myPortfolioInvitations } = useWorkspaceAuth()
  const [showInvitations, setShowInvitations] = useState(false)
  const [showProfile, setShowProfile] = useState(false)

  if (!me || !currentWorkspace) {
    return null
  }

  const pendingCount = myInvitations.length + myPortfolioInvitations.length

  return (
    <div
      className={
        mode === 'business'
          ? 'ws-bar ws-bar-light ws-bar-business'
          : mode === 'home'
            ? 'ws-bar ws-bar-light'
            : 'ws-bar'
      }
    >
      <div className="ws-bar-left">
        <span className="ws-bar-workspace">{currentWorkspace.name}</span>
        {onChangeMode && (
          <button type="button" className="ws-nav-btn" onClick={onChangeMode}>
            ← Modes · {modeLabels[mode]}
          </button>
        )}
        {mode === 'personal' && <AccountSwitcher />}
      </div>
      <div className="ws-bar-right">
        {showNotificationBell && (mode === 'home' || mode === 'business') && (
          <button
            type="button"
            className="ws-bell-btn"
            aria-label={pendingCount > 0 ? `Invitations (${pendingCount} pending)` : 'Invitations'}
            onClick={() => setShowInvitations(true)}
          >
            <Bell size={18} />
            {pendingCount > 0 && <span className="ws-bell-badge">{pendingCount}</span>}
          </button>
        )}
        <UserMenu
          displayName={me.user.display_name}
          email={me.user.email}
          onProfile={() => setShowProfile(true)}
          onLogout={() => void logout()}
        />
      </div>

      {showInvitations && <InvitationsInbox onClose={() => setShowInvitations(false)} />}
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
    </div>
  )
}
