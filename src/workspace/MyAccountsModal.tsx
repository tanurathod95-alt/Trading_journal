import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, workspaceApi, type PortfolioApi, type TradingAccountApi } from './api'
import { useWorkspaceAuth } from './WorkspaceAuthContext'
import { ManageAccessPanel } from './ManageAccessPanel'
import { LinkLocalAccountPanel } from './LinkLocalAccountPanel'
import { PhoneNumberInput, splitContactNumber } from './PhoneNumberInput'
import { COUNTRY_DIAL_CODES } from './countryCodes'

function formatContactNumber(contactNumber: string): string | null {
  if (!contactNumber.trim()) {
    return null
  }
  const { dial, number } = splitContactNumber(contactNumber)
  const flag = COUNTRY_DIAL_CODES.find((c) => c.dial === dial)?.flag ?? ''
  return `${flag} ${dial} ${number}`.trim()
}

export function MyAccountsModal({
  onClose,
  initialType,
  autoOpenAdd,
}: {
  onClose: () => void
  /** Pre-fills the "Type" field — used when opened from Business mode so the add-account form is ready to create a Business account. */
  initialType?: string
  /** Opens straight to the add-account form instead of the account list — used the first time Business mode has no account yet. */
  autoOpenAdd?: boolean
}) {
  const { accounts, accountsLoading, accountsError, currentAccountId, createAccount, currentWorkspace, refreshAccounts } =
    useWorkspaceAuth()
  const [showAdd, setShowAdd] = useState(Boolean(autoOpenAdd))
  const [name, setName] = useState('')
  const [broker, setBroker] = useState('')
  const [accountType] = useState(initialType ?? 'Trading')
  const [contactDial, setContactDial] = useState('+91')
  const [contactNumber, setContactNumber] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [manageAccessFor, setManageAccessFor] = useState<TradingAccountApi | null>(null)
  const [linkDataFor, setLinkDataFor] = useState<TradingAccountApi | null>(null)
  const [portfolios, setPortfolios] = useState<PortfolioApi[]>([])
  const [portfolioBusyId, setPortfolioBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editBroker, setEditBroker] = useState('')
  const [editType, setEditType] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)

  useEffect(() => {
    if (currentWorkspace) {
      void workspaceApi.listPortfolios(currentWorkspace.id).then(setPortfolios).catch(() => {})
    }
  }, [currentWorkspace])

  async function handleAssignPortfolio(account: TradingAccountApi, portfolioId: string): Promise<void> {
    setPortfolioBusyId(account.id)
    try {
      await workspaceApi.assignAccountToPortfolio(account.id, portfolioId || null)
      await refreshAccounts()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the portfolio for this account.')
    } finally {
      setPortfolioBusyId(null)
    }
  }
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null)

  async function handleAdd(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const trimmedNumber = contactNumber.trim()
      await createAccount(name, broker, accountType, trimmedNumber ? `${contactDial}${trimmedNumber}` : '')
      setName('')
      setBroker('')
      setContactDial('+91')
      setContactNumber('')
      setShowAdd(false)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the account.')
    } finally {
      setSubmitting(false)
    }
  }

  function startEdit(account: TradingAccountApi): void {
    setError(null)
    setEditingId(account.id)
    setEditName(account.name)
    setEditBroker(account.broker_name)
    setEditType(account.account_type)
  }

  async function handleSaveEdit(event: FormEvent, account: TradingAccountApi): Promise<void> {
    event.preventDefault()
    setError(null)
    setEditSubmitting(true)
    try {
      await workspaceApi.updateAccount(account.id, {
        name: editName.trim(),
        broker_name: editBroker.trim(),
        account_type: editType.trim(),
      })
      await refreshAccounts()
      setEditingId(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the account.')
    } finally {
      setEditSubmitting(false)
    }
  }

  async function handleDelete(account: TradingAccountApi): Promise<void> {
    if (!window.confirm(`Delete "${account.name}"? This cannot be undone.`)) {
      return
    }
    setBusyAccountId(account.id)
    try {
      await workspaceApi.deleteAccount(account.id)
      await refreshAccounts()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the account.')
    } finally {
      setBusyAccountId(null)
    }
  }

  function renderCard(account: TradingAccountApi) {
    // Backend re-checks every one of these on every request — this is only
    // what decides which buttons are worth showing, never what actually
    // allows the action.
    const canEdit = account.role === 'OWNER' || account.role === 'ADMIN'
    const canDelete = account.role === 'OWNER'
    const busy = busyAccountId === account.id

    if (editingId === account.id) {
      return (
        <form key={account.id} className="ws-account-card" onSubmit={(e) => void handleSaveEdit(e, account)}>
          <label className="ws-field small">
            Account name
            <input value={editName} onChange={(e) => setEditName(e.target.value)} required minLength={1} maxLength={200} />
          </label>
          <label className="ws-field small">
            Broker
            <input value={editBroker} onChange={(e) => setEditBroker(e.target.value)} maxLength={120} />
          </label>
          <label className="ws-field small">
            Type
            <input value={editType} onChange={(e) => setEditType(e.target.value)} maxLength={60} />
          </label>
          <div className="ws-account-card-actions">
            <button type="button" className="ws-link-btn" disabled={editSubmitting} onClick={() => setEditingId(null)}>
              Cancel
            </button>
            <button type="submit" className="ws-primary-btn" disabled={editSubmitting}>
              {editSubmitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )
    }

    return (
      <div key={account.id} className={`ws-account-card ${account.id === currentAccountId ? 'active' : ''}`}>
        <div className="ws-account-card-top">
          <strong>{account.name}</strong>
          <span className="ws-role-pill">{account.role}</span>
        </div>
        <p className="ws-muted">{account.broker_name || 'No broker set'} · {account.account_type}</p>
        {formatContactNumber(account.contact_number) && (
          <p className="ws-muted small">{formatContactNumber(account.contact_number)}</p>
        )}
        <p className="ws-muted small">{account.is_archived ? 'Archived' : 'Active'}</p>

        <div className="ws-account-card-actions">
          {canEdit && (
            <button type="button" className="ws-link-btn" onClick={() => startEdit(account)}>
              Edit
            </button>
          )}
          {canDelete && (
            <button type="button" className="ws-link-btn ws-danger-link" disabled={busy} onClick={() => void handleDelete(account)}>
              Delete
            </button>
          )}
        </div>

        {account.role === 'OWNER' && portfolios.length > 0 && (
          <label className="ws-field small" style={{ marginTop: 8 }}>
            Portfolio
            <select
              value={account.portfolio_id ?? ''}
              disabled={portfolioBusyId === account.id}
              onChange={(e) => void handleAssignPortfolio(account, e.target.value)}
            >
              <option value="">No portfolio (solo account)</option>
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>{p.client_display_name || p.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    )
  }

  const myAccounts = accounts.filter((a) => a.workspace_id === currentWorkspace?.id)
  const sharedAccounts = accounts.filter((a) => a.workspace_id !== currentWorkspace?.id)

  return (
    <>
      <div className="ws-modal-backdrop" onClick={onClose}>
        <div className="ws-modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="ws-modal-header">
            <div>
              <h2>My Trading Accounts</h2>
              {currentWorkspace && <p className="ws-muted">{currentWorkspace.name}</p>}
            </div>
            <button type="button" className="ws-close-btn" onClick={onClose}>×</button>
          </div>

          {accountsError && <p className="ws-error">{accountsError}</p>}
          {error && <p className="ws-error">{error}</p>}
          {accountsLoading && <p className="ws-muted">Loading accounts…</p>}

          {!accountsLoading && accounts.length === 0 && !showAdd && (
            <div className="ws-empty-state">
              <p>No trading accounts yet.</p>
            </div>
          )}

          {myAccounts.length > 0 && (
            <>
              <h3 className="ws-section-title">My Accounts</h3>
              <div className="ws-account-grid">{myAccounts.map(renderCard)}</div>
            </>
          )}

          {sharedAccounts.length > 0 && (
            <>
              <h3 className="ws-section-title">Shared With Me</h3>
              <div className="ws-account-grid">{sharedAccounts.map(renderCard)}</div>
            </>
          )}

          {showAdd ? (
            <form className="ws-add-account-form" onSubmit={(e) => void handleAdd(e)}>
              <label className="ws-field">
                Account name
                <input value={name} onChange={(e) => setName(e.target.value)} required minLength={1} maxLength={200} placeholder="e.g. Gaurav - Angel One" />
              </label>
              <label className="ws-field">
                Broker
                <input value={broker} onChange={(e) => setBroker(e.target.value)} maxLength={120} placeholder="e.g. Angel One" />
              </label>
              <label className="ws-field">
                Contact number
                <PhoneNumberInput
                  dial={contactDial}
                  number={contactNumber}
                  onDialChange={setContactDial}
                  onNumberChange={setContactNumber}
                />
              </label>
              <div className="ws-modal-actions">
                <button type="button" className="ws-secondary-btn" onClick={() => setShowAdd(false)}>Cancel</button>
                <button type="submit" className="ws-primary-btn" disabled={submitting}>
                  {submitting ? 'Adding…' : 'Add Account'}
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="ws-primary-btn" onClick={() => setShowAdd(true)}>
              + Add Trading Account
            </button>
          )}
        </div>
      </div>

      {manageAccessFor && <ManageAccessPanel account={manageAccessFor} onClose={() => setManageAccessFor(null)} />}
      {linkDataFor && <LinkLocalAccountPanel account={linkDataFor} onClose={() => setLinkDataFor(null)} />}
    </>
  )
}
