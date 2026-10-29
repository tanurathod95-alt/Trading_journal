import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import App from '../App'
import type { TradingAccountApi } from './api'
import { MyAccountsModal } from './MyAccountsModal'
import { UserPermissionsPage } from './UserPermissionsPage'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

const BUSINESS_ACCOUNT_TYPE = 'Business'

/**
 * Business dashboard: the same journal UI as Personal Trading (App), pointed
 * at every backend account in this workspace this user has access to at once
 * — every account type (Trading, Business, Commodity, Options, …), not just
 * ones typed "Business" — so Account Performance (an existing App panel that
 * already iterates over `accounts`) lists every one of them. Which accounts
 * appear — and whether each is writable — is decided by the backend per
 * account (owner/admin vs accepted VIEWER); pending or declined invitations
 * never produce an account. "User and Permissions" manages the primary
 * (first) account, same as before — this change is scoped to Account
 * Performance / dashboard data, not to member/invitation management.
 *
 * Account creation deliberately reuses the existing Accounts panel
 * (MyAccountsModal) instead of a second, parallel "create business account"
 * form — opened only when the user asks for it (the "+ Create Business
 * Account" button below), never automatically on landing here.
 */
export function BusinessMode() {
  const { accounts, accountsLoading } = useWorkspaceAuth()
  const [panel, setPanel] = useState<'accounts' | null>(null)
  const [page, setPage] = useState<'dashboard' | 'users'>('dashboard')

  const businessAccounts = accounts.filter((account: TradingAccountApi) => !account.is_archived)
  const primary = businessAccounts[0] ?? null

  let main: React.ReactNode
  if (accountsLoading && !primary) {
    main = (
      <div className="ws-mode-placeholder">
        <p className="ws-muted">Loading…</p>
      </div>
    )
  } else if (!primary) {
    main = (
      <div className="ws-mode-placeholder">
        <h2>Business Dashboard</h2>
        <p className="ws-muted">No business account available.</p>
        <button type="button" className="ws-primary-btn" onClick={() => setPanel('accounts')}>
          + Create Business Account
        </button>
      </div>
    )
  } else {
    main = (
      <App
        key={businessAccounts.map((a) => a.id).join(',')}
        mode="business"
        businessAccounts={businessAccounts}
        extraNav={[
          { key: 'users', label: 'User and Permissions', icon: ShieldCheck, onClick: () => setPage('users'), active: page === 'users' },
        ]}
        extraPage={page === 'users' ? <UserPermissionsPage account={primary} /> : undefined}
        onTabSelect={() => setPage('dashboard')}
      />
    )
  }

  return (
    <>
      {main}
      {panel === 'accounts' && (
        <MyAccountsModal
          onClose={() => setPanel(null)}
          initialType={!primary ? BUSINESS_ACCOUNT_TYPE : undefined}
          autoOpenAdd={!primary}
        />
      )}
    </>
  )
}
