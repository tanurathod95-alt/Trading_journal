import { useState } from 'react'
import { LayoutGrid, ShieldCheck, UsersRound } from 'lucide-react'
import App from '../App'
import type { TradingAccountApi } from './api'
import { BillingPage } from './BillingPage'
import { BusinessOnboarding } from './BusinessOnboarding'
import { MyAccountsModal } from './MyAccountsModal'
import { PortfoliosModal } from './PortfoliosModal'
import { ProfileModal } from './ProfileModal'
import { UserPermissionsPage } from './UserPermissionsPage'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

const BUSINESS_ACCOUNT_TYPE = 'Business'

function isBusinessAccount(account: TradingAccountApi): boolean {
  return account.account_type.trim().toLowerCase() === BUSINESS_ACCOUNT_TYPE.toLowerCase() && !account.is_archived
}

/**
 * Business dashboard: the same journal UI as Personal Trading (App), pointed
 * at every backend business account this user has access to at once — so
 * Account Performance (an existing App panel that already iterates over
 * `accounts`) lists every one of them, not just one. Which accounts appear —
 * and whether each is writable — is decided by the backend per account
 * (owner/admin vs accepted VIEWER); pending or declined invitations never
 * produce an account. "User and Permissions" manages the primary (first)
 * business account, same as before — this change is scoped to Account
 * Performance / dashboard data, not to member/invitation management.
 *
 * Account creation deliberately reuses the existing Accounts panel
 * (MyAccountsModal) instead of a second, parallel "create business account"
 * form — opened only when the user asks for it (the "+ Create Business
 * Account" button below), never automatically on landing here.
 */
export function BusinessMode() {
  const { accounts, accountsLoading } = useWorkspaceAuth()
  const [panel, setPanel] = useState<'accounts' | 'portfolios' | 'billing' | 'settings' | null>(null)
  const [page, setPage] = useState<'dashboard' | 'users'>('dashboard')

  const businessAccounts = accounts.filter(isBusinessAccount)
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
      <BusinessOnboarding
        onCreateAccount={() => setPanel('accounts')}
        onOpenAccounts={() => setPanel('accounts')}
        onOpenPortfolios={() => setPanel('portfolios')}
        onOpenBilling={() => setPanel('billing')}
        onOpenSettings={() => setPanel('settings')}
      />
    )
  } else {
    main = (
      <App
        key={businessAccounts.map((a) => a.id).join(',')}
        mode="business"
        businessAccounts={businessAccounts}
        extraNav={[
          { key: 'accounts', label: 'Accounts', icon: LayoutGrid, onClick: () => setPanel('accounts') },
          { key: 'portfolios', label: 'Portfolios', icon: UsersRound, onClick: () => setPanel('portfolios') },
          { key: 'users', label: 'User and Permissions', icon: ShieldCheck, onClick: () => setPage('users'), active: page === 'users' },
        ]}
        extraPage={page === 'users' ? <UserPermissionsPage accounts={businessAccounts} /> : undefined}
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
          // Every account added from here is a Business account, not just
          // the first one — this modal is only ever opened from Business
          // mode (see the import comment above).
          initialType={BUSINESS_ACCOUNT_TYPE}
          autoOpenAdd={!primary}
        />
      )}
      {panel === 'portfolios' && <PortfoliosModal onClose={() => setPanel(null)} />}
      {panel === 'billing' && <BillingPage onClose={() => setPanel(null)} />}
      {panel === 'settings' && <ProfileModal onClose={() => setPanel(null)} />}
    </>
  )
}
