import { createPortal } from 'react-dom'
import { ArrowLeft, Bell, ChartNoAxesCombined, Receipt, Sparkles, X } from 'lucide-react'
import { InvitationsInbox } from './InvitationsInbox'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

export type SidebarPanel = 'invitations' | 'billing' | null

/**
 * Left navigation on the mode-select page: Invitations and Billing.
 * Billing is shown by the parent (ModeShell) inline in the main content area
 * — next to this sidebar, full screen — rather than as a popup, so `panel`
 * is controlled from above. Invitations still opens as a popup here.
 *
 * On mobile (<=768px) this renders as a hidden-by-default slide-out drawer
 * instead of an always-visible bar, toggled by the hamburger button in
 * WorkspaceBar — `mobileOpen`/`onCloseMobile` are only meaningful there;
 * on desktop the sidebar is always shown and these are unused.
 */
export function ModeSidebar({
  panel,
  onSelectPanel,
  mobileOpen = false,
  onCloseMobile,
}: {
  panel: SidebarPanel
  onSelectPanel: (panel: SidebarPanel) => void
  mobileOpen?: boolean
  onCloseMobile?: () => void
}) {
  const { myInvitations, myPortfolioInvitations, currentWorkspace } = useWorkspaceAuth()
  const pendingCount = myInvitations.length + myPortfolioInvitations.length
  const showUpgradeCard = currentWorkspace && currentWorkspace.plan !== 'BUSINESS'

  function selectAndClose(next: SidebarPanel): void {
    onSelectPanel(next)
    onCloseMobile?.()
  }

  return (
    <>
      {mobileOpen && <div className="ws-sidebar-mobile-backdrop" onClick={onCloseMobile} />}
      <aside className={mobileOpen ? 'ws-sidebar mobile-open' : 'ws-sidebar'}>
        <div className="ws-sidebar-brand">
          <span className="ws-sidebar-brand-icon">
            <ChartNoAxesCombined size={16} strokeWidth={2.5} />
          </span>
          <span>Trading Journal</span>
          {onCloseMobile && (
            <button type="button" className="ws-sidebar-mobile-close" aria-label="Close menu" onClick={onCloseMobile}>
              <X size={18} />
            </button>
          )}
        </div>
        <nav className="ws-sidebar-nav">
          {panel === 'billing' && (
            <button type="button" className="ws-sidebar-item" onClick={() => selectAndClose(null)}>
              <ArrowLeft size={17} />
              <span>Modes</span>
            </button>
          )}
          <button type="button" className={panel === 'invitations' ? 'ws-sidebar-item active' : 'ws-sidebar-item'} onClick={() => selectAndClose('invitations')}>
            <Bell size={17} />
            <span>Invitations</span>
            {pendingCount > 0 && <span className="ws-badge-count">{pendingCount}</span>}
          </button>
          <button type="button" className={panel === 'billing' ? 'ws-sidebar-item active' : 'ws-sidebar-item'} onClick={() => selectAndClose('billing')}>
            <Receipt size={17} />
            <span>Billing</span>
          </button>
        </nav>

      {showUpgradeCard && (
        <div className="ws-sidebar-upgrade-card">
          <span className="ws-sidebar-upgrade-icon">
            <Sparkles size={16} />
          </span>
          <p className="ws-sidebar-upgrade-title">Upgrade your plan</p>
          <p className="ws-sidebar-upgrade-sub">Unlock more trading accounts and team seats.</p>
          <button type="button" className="ws-primary-btn ws-sidebar-upgrade-btn" onClick={() => onSelectPanel('billing')}>
            Upgrade Plan
          </button>
        </div>
      )}

      {/*
        Rendered through a portal into document.body instead of staying
        nested under <aside> (position: sticky). A sticky ancestor creates
        its own stacking context, which would trap this modal's z-index
        inside it — letting sibling content elsewhere on the page (e.g. the
        mode cards) paint on top of the "open" modal. Portalling escapes
        that trap so the modal always renders above everything, regardless
        of where it's triggered from.
      */}
        {panel === 'invitations' && createPortal(<InvitationsInbox onClose={() => onSelectPanel(null)} />, document.body)}
      </aside>
    </>
  )
}
