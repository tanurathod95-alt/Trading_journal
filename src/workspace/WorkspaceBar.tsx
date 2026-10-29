import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Bell, Menu } from 'lucide-react'
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
  onOpenMenu,
  onBilling,
}: {
  mode?: BarMode
  onChangeMode?: () => void
  showNotificationBell?: boolean
  /** Mobile-only hamburger trigger (left side) — when provided, a compact menu button is shown on small screens. */
  onOpenMenu?: () => void
  /** When provided, adds a "Billing" item to the user dropdown (only wired where a billing panel exists, e.g. the home mode screen). */
  onBilling?: () => void
} = {}) {
  const { me, currentWorkspace, logout, myInvitations, myPortfolioInvitations } = useWorkspaceAuth()
  const [showInvitations, setShowInvitations] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const navigate = useNavigate()

  const handleLogout = async (): Promise<void> => {
    // Navigate away from /app first, then clear auth state — otherwise
    // AuthGate (still mounted at /app for a tick) sees signed-out and
    // redirects to "/" with openAuth:'login' itself, so the user would land
    // on the homepage with the login popup already open instead of a clean
    // homepage.
    navigate('/')
    try {
      sessionStorage.removeItem('journal-mode')
    } catch {
      // storage unavailable — nothing to clear
    }
    await logout()
  }

  if (!me || !currentWorkspace) {
    return null
  }

  const pendingCount = myInvitations.length + myPortfolioInvitations.length

  return (
    <div className={mode === 'home' || mode === 'business' ? 'ws-bar ws-bar-light' : 'ws-bar'}>
      <div className="ws-bar-left">
        {onOpenMenu && (
          <button type="button" className="ws-mobile-menu-btn" aria-label="Open menu" onClick={onOpenMenu}>
            <Menu size={19} />
          </button>
        )}
        {/* Neutral, non-identifying label — never the workspace's own name, which could be a person's name (e.g. "nandani's Workspace"). */}
        <span className="ws-bar-workspace">Trading Journal</span>
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
          onMyWorkspace={onChangeMode}
          onBilling={onBilling}
          onAdmin={me.user.platform_role === 'ADMIN' || me.user.platform_role === 'DEVELOPER' ? () => navigate('/app/admin') : undefined}
          onDeveloper={me.user.platform_role === 'DEVELOPER' ? () => navigate('/app/dev') : undefined}
          onLogout={() => void handleLogout()}
        />
      </div>

      {showInvitations && createPortal(<InvitationsInbox onClose={() => setShowInvitations(false)} />, document.body)}
      {showProfile && createPortal(<ProfileModal onClose={() => setShowProfile(false)} />, document.body)}
    </div>
  )
}
