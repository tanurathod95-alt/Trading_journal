import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, workspaceApi, type AccountMemberApi, type InvitationApi, type TradingAccountApi } from './api'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

/**
 * Account Settings → Users & Permissions, per the spec. Only ever reachable
 * from an OWNER's account card (see MyAccountsModal) — the backend also
 * independently enforces OWNER-only on every call here (list/add/remove),
 * so this panel is UX convenience, not the actual security boundary.
 */
export function ManageAccessPanel({ account, onClose }: { account: TradingAccountApi; onClose: () => void }) {
  const { me } = useWorkspaceAuth()
  const [members, setMembers] = useState<AccountMemberApi[] | null>(null)
  const [invitations, setInvitations] = useState<InvitationApi[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'ADMIN' | 'VIEWER'>('VIEWER')
  const [submitting, setSubmitting] = useState(false)

  async function load(): Promise<void> {
    setError(null)
    try {
      const [memberList, invitationList] = await Promise.all([
        workspaceApi.listMembers(account.id),
        workspaceApi.listInvitations(account.id),
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
  }, [account.id])

  async function handleInvite(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await workspaceApi.createInvitation(account.id, email, role)
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
      await workspaceApi.removeMember(account.id, memberId)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove access.')
    }
  }

  async function handleRevokeInvitation(invitationId: string): Promise<void> {
    setError(null)
    try {
      await workspaceApi.revokeInvitation(account.id, invitationId)
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
            <h2>Users &amp; Permissions</h2>
            <p className="ws-muted">{account.name}</p>
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
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="person@email.com" />
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
            Works even if they haven't signed up yet — they'll see this invitation waiting for them once they create an account
            with this email (invitations expire after 7 days).
          </p>
          <button type="submit" className="ws-primary-btn" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send Invitation'}
          </button>
        </form>
      </div>
    </div>
  )
}
