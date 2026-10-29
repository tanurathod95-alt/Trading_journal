import { useEffect, useState } from 'react'
import type { Trade } from '../types'
import { fetchRemoteOnlyAccountsWithTrades } from './tradeSync'

/**
 * A dedicated, read-only "client portal" view — separate from the main
 * Dashboard/Journal/Accounts tabs (which are still 100% Dexie-driven and
 * merge shared data in only for filtering purposes). This view exists so
 * a Viewer/Client's shared data has its own clean home instead of being
 * mixed into the owner-facing app UI.
 */
interface SharedAccountSummary {
  id: string
  name: string
  broker: string
  trades: Trade[]
}

function netPnl(trades: Trade[]): number {
  return trades.reduce((sum, t) => sum + (t.netPnl || 0), 0)
}

export function SharedWithMeView({ onClose }: { onClose: () => void }) {
  const [summaries, setSummaries] = useState<SharedAccountSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openAccountId, setOpenAccountId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchRemoteOnlyAccountsWithTrades()
      .then(({ accounts, trades }) => {
        if (cancelled) return
        setSummaries(
          accounts.map((account) => ({
            id: account.id,
            name: account.accountName,
            broker: account.brokerName,
            trades: trades.filter((t) => t.accountId === account.id),
          })),
        )
      })
      .catch(() => {
        if (!cancelled) setError('Could not load shared data — is the backend running?')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const openAccount = summaries?.find((s) => s.id === openAccountId) ?? null

  return (
    <div className="ws-modal-backdrop" onClick={onClose}>
      <div className="ws-modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 780 }}>
        <div className="ws-modal-header">
          <div>
            <h2>Shared With Me</h2>
            <p className="ws-muted">Read-only accounts and portfolios shared to you</p>
          </div>
          <button type="button" className="ws-close-btn" onClick={onClose}>×</button>
        </div>

        {error && <p className="ws-error">{error}</p>}
        {summaries === null && !error && <p className="ws-muted">Loading…</p>}

        {summaries?.length === 0 && (
          <div className="ws-empty-state">
            <p>Nothing has been shared with you yet.</p>
          </div>
        )}

        {!openAccount && summaries && summaries.length > 0 && (
          <div className="ws-account-grid">
            {summaries.map((s) => (
              <div key={s.id} className="ws-account-card">
                <div className="ws-account-card-top">
                  <strong>{s.name}</strong>
                  <span className="ws-role-pill">VIEWER</span>
                </div>
                <p className="ws-muted">{s.broker || 'No broker set'}</p>
                <p className="ws-muted small">
                  {s.trades.length} trade{s.trades.length === 1 ? '' : 's'} · Net P/L{' '}
                  <strong style={{ color: netPnl(s.trades) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    ₹{netPnl(s.trades).toLocaleString('en-IN')}
                  </strong>
                </p>
                <div className="ws-account-card-actions">
                  <button type="button" className="ws-primary-btn" onClick={() => setOpenAccountId(s.id)}>
                    View Trades
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {openAccount && (
          <div>
            <button type="button" className="ws-link-btn" onClick={() => setOpenAccountId(null)}>
              ← Back to shared accounts
            </button>
            <h3 style={{ marginTop: 12 }}>{openAccount.name}</h3>
            {openAccount.trades.length === 0 ? (
              <div className="ws-empty-state">
                <p>No trades in this account yet.</p>
              </div>
            ) : (
              <div className="ws-table-wrap">
              <table className="ws-members-table" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Script</th>
                    <th>Side</th>
                    <th>Qty</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Status</th>
                    <th>Net P/L</th>
                  </tr>
                </thead>
                <tbody>
                  {openAccount.trades.map((t) => (
                    <tr key={t.id}>
                      <td>{t.tradeDate}</td>
                      <td>{t.scriptName}</td>
                      <td>{t.side}</td>
                      <td>{t.quantity}</td>
                      <td>{t.entryPrice}</td>
                      <td>{t.exitPrice || '—'}</td>
                      <td>{t.status}</td>
                      <td style={{ color: t.netPnl >= 0 ? 'var(--success)' : 'var(--danger)' }}>{t.netPnl}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        )}

        <p className="ws-muted small" style={{ marginTop: 12 }}>
          Read-only — you cannot add, edit or delete trades here. Ask the owner to make changes.
        </p>
      </div>
    </div>
  )
}
