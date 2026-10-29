import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, workspaceApi, type PortfolioApi, type PortfolioInvitationApi, type PortfolioMemberApi } from './api'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

/**
 * Portfolio → Access Management → Invite Client, per the spec. Same
 * pattern as ManageAccessPanel (account-level, Phase 5) one level up —
 * the backend independently enforces OWNER-only on every call here.
 */
export function ManagePortfolioAccessPanel({ portfolio, onClose }: { portfolio: PortfolioApi; onClose: () => void }) {
  const { me } = useWorkspaceAuth()
  const [members, setMembers] = useState<PortfolioMemberApi[] | null>(null)
  const [invitations, setInvitations] = useState<PortfolioInvitationApi[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'ADMIN' | 'VIEWER'>('VIEWER')
  const [submitting, setSubmitting] = useState(false)

  async function load(): Promise<void> {
    setError(null)
    try {
      const [memberList, invitationList] = await Promise.all([
        workspaceApi.listPortfolioMembers(portfolio.id),
        workspaceApi.listPortfolioInvitations(portfolio.id),
      ])
      setMembers(memberList)
      setInvitations(invitationList)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load members.')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio.id])

  async function handleInvite(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await workspaceApi.createPortfolioInvitation(portfolio.id, email, role)
      setEmail('')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the invitation.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRemoveMember(memberId: string): Promise<void> {
    setError(null)
    try {
      await workspaceApi.removePortfolioMember(portfolio.id, memberId)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove access.')
    }
  }

  async function handleRevokeInvitation(invitationId: string): Promise<void> {
    setError(null)
    try {
      await workspaceApi.revokePortfolioInvitation(portfolio.id, invitationId)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke the invitation.')
    }
  }

  return (
    <div className="ws-modal-backdrop" onClick={onClose}>
      <div className="ws-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="ws-modal-header">
          <div>
            <h2>Portfolio Access</h2>
            <p className="ws-muted">{portfolio.name} · every account in this portfolio</p>
          </div>
          <button type="button" className="ws-close-btn" onClick={onClose}>×</button>
        </div>

        {error && <p className="ws-error">{error}</p>}

        <div className="ws-table-wrap">
        <table className="ws-members-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Access</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members?.map((member) => (
              <tr key={member.id}>
                <td>
                  <div>{member.display_name}</div>
                  <div className="ws-muted small">{member.email}</div>
                </td>
                <td>{member.role}</td>
                <td>{member.role === 'VIEWER' ? 'Read only' : 'Full'}</td>
                <td>
                  {member.email !== me?.user.email && (
                    <button type="button" className="ws-link-btn" onClick={() => void handleRemoveMember(member.id)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {invitations?.map((invitation) => (
              <tr key={invitation.id} className="ws-pending-row">
                <td>
                  <div>{invitation.email}</div>
                  <div className="ws-muted small">Invitation pending — not yet accepted</div>
                </td>
                <td>{invitation.role}</td>
                <td>
                  <span className="ws-badge-muted">Pending</span>
                </td>
                <td>
                  <button type="button" className="ws-link-btn" onClick={() => void handleRevokeInvitation(invitation.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>

        <form className="ws-add-account-form" onSubmit={(e) => void handleInvite(e)}>
          <div className="ws-invite-row">
            <label className="ws-field">
              Client email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="client@email.com" />
            </label>
            <label className="ws-field">
              Access
              <select value={role} onChange={(e) => setRole(e.target.value as 'ADMIN' | 'VIEWER')}>
                <option value="VIEWER">Viewer</option>
                <option value="ADMIN">Admin</option>
              </select>
            </label>
          </div>
          <p className="ws-muted small">
            Grants read access to every trading account in this portfolio at once — works even if the client hasn&apos;t
            signed up yet (invitations expire after 7 days).
          </p>
          <button type="submit" className="ws-primary-btn" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send Invitation'}
          </button>
        </form>
      </div>
    </div>
  )
}
