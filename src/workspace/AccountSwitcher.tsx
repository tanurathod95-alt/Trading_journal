import { useState } from 'react'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

export function AccountSwitcher() {
  const { accounts: allAccounts, currentAccountId, setCurrentAccountId } = useWorkspaceAuth()
  const [open, setOpen] = useState(false)

  // Only shown in Personal mode (see WorkspaceBar) — must never offer a
  // Business account here, same rule as App.tsx's own Personal-mode account
  // list.
  const accounts = allAccounts.filter((a) => a.account_type.trim().toLowerCase() !== 'business')
  const current = accounts.find((a) => a.id === currentAccountId) ?? null

  if (accounts.length === 0) {
    return null
  }

  return (
    <div className="ws-switcher">
      <button type="button" className="ws-switcher-btn" onClick={() => setOpen((v) => !v)}>
        <span className="ws-switcher-label">Current Account</span>
        <strong>{current ? current.name : 'Select account'}</strong>
      </button>
      {open && (
        <>
          <div className="ws-dropdown-backdrop" onClick={() => setOpen(false)} />
          <div className="ws-dropdown">
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                className={`ws-dropdown-item ${account.id === currentAccountId ? 'active' : ''}`}
                onClick={() => {
                  setCurrentAccountId(account.id)
                  setOpen(false)
                }}
              >
                {account.id === currentAccountId ? '✓ ' : ''}
                {account.name}
                {account.is_archived && <span className="ws-badge-muted">Archived</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
