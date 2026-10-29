import { Mail, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ApiError, workspaceApi, type AccountMemberApi, type InvitationApi, type TradingAccountApi } from './api'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

function formatDate(iso: string): string {
  const date = new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}

type Tab = 'users' | 'invitations'

/**
 * Business → User and Permissions. Uses the existing per-account member and
 * invitation endpoints; the backend is the real gate (listing needs ADMIN+,
 * inviting/removing/cancelling needs OWNER), this page only decides what is
 * worth showing. No passwords are ever involved — an invitee signs up or
 * logs in with their own credentials and accepts from their Invitations.
 */
export function UserPermissionsPage({ accounts }: { accounts: TradingAccountApi[] }) {
  const { me } = useWorkspaceAuth()
  // The page itself still shows one business account's users/invitations at
  // a time (the primary/first one, same as before) — only the "Send
  // Invitation" modal gained the ability to target any business account,
  // via its own Account Holder dropdown below.
  const account = accounts[0]
  const canView = account.role === 'OWNER' || account.role === 'ADMIN'
  const canManage = account.role === 'OWNER'

  const [tab, setTab] = useState<Tab>('users')
  const [members, setMembers] = useState<AccountMemberApi[] | null>(null)
  const [invitations, setInvitations] = useState<InvitationApi[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [inviteAccountId, setInviteAccountId] = useState(account.id)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'ADMIN' | 'VIEWER'>('VIEWER')
  const [submitting, setSubmitting] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!canView) return
    setError(null)
    try {
      const [memberList, invitationList] = await Promise.all([
        workspaceApi.listMembers(account.id),
        workspaceApi.listInvitations(account.id),
      ])
      setMembers(memberList)
      setInvitations(invitationList)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load users.')
    }
  }, [account.id, canView])

  useEffect(() => {
    void load()
  }, [load])

  async function handleSend(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setModalError(null)
    try {
      await workspaceApi.createInvitation(inviteAccountId, email.trim(), role)
      setModalOpen(false)
      setEmail('')
      setRole('VIEWER')
      setInviteAccountId(account.id)
      setNotice('Invitation created. No email is sent: the person will see it under Invitations after logging in with that email.')
      if (inviteAccountId === account.id) {
        await load()
      }
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : 'Could not send the invitation.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancel(invitation: InvitationApi): Promise<void> {
    setBusyId(invitation.id)
    setError(null)
    try {
      await workspaceApi.revokeInvitation(account.id, invitation.id)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the invitation.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleRemove(member: AccountMemberApi): Promise<void> {
    if (!window.confirm(`Remove ${member.email} from this business account?`)) return
    setBusyId(member.id)
    setError(null)
    try {
      await workspaceApi.removeMember(account.id, member.id)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove the user.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="ws-users-page">
      <div className="ws-users-card">
        <div className="ws-users-page-header">
          <div>
            <h2>User and Permissions</h2>
            <p className="ws-muted">Manage users, access and invitations for your business account.</p>
          </div>
          {canManage && (
            <button type="button" className="ws-invite-btn" onClick={() => { setModalError(null); setInviteAccountId(account.id); setModalOpen(true) }}>
              <UserPlus size={16} />
              Send Invitation
            </button>
          )}
        </div>

        {!canView && <p className="ws-muted">You do not have permission to manage users for this business account.</p>}
        {error && <p className="ws-error">{error}</p>}
        {notice && <p className="ws-muted">{notice}</p>}

        {canView && (
          <>
            <div className="ws-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'users'}
                className={tab === 'users' ? 'ws-tab active' : 'ws-tab'}
                onClick={() => setTab('users')}
              >
                <Users size={15} />
                Users
                {members && <span className="ws-tab-count">{members.length}</span>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'invitations'}
                className={tab === 'invitations' ? 'ws-tab active' : 'ws-tab'}
                onClick={() => setTab('invitations')}
              >
                <Mail size={15} />
                Pending Invitations
                {invitations && <span className="ws-tab-count">{invitations.length}</span>}
              </button>
            </div>

            {tab === 'users' && (
              <div className="ws-users-rows" role="tabpanel">
                <div className="ws-users-row ws-users-row-head">
                  <span>User</span>
                  <span>Email</span>
                  <span>Role</span>
                  <span>Status</span>
                  <span>Actions</span>
                </div>
                {members === null && !error && <div className="ws-users-empty">Loading…</div>}
                {members?.map((member) => (
                  <div className="ws-users-row" key={member.id}>
                    <span data-label="User" className="ws-users-cell-primary">{member.display_name}</span>
                    <span data-label="Email" className="ws-users-cell-muted">{member.email}</span>
                    <span data-label="Role">
                      <span className={`ws-role-chip ws-role-chip-${member.role.toLowerCase()}`}>{member.role}</span>
                    </span>
                    <span data-label="Status">
                      <span className="ws-status-chip ws-status-chip-active">Active</span>
                    </span>
                    <span data-label="Actions" className="ws-users-cell-actions">
                      {canManage && member.role !== 'OWNER' && member.email !== me?.user.email && (
                        <button type="button" className="ws-row-action ws-row-action-danger" disabled={busyId === member.id} onClick={() => void handleRemove(member)}>
                          Remove
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {tab === 'invitations' && (
              <div className="ws-users-rows" role="tabpanel">
                <div className="ws-users-row ws-users-row-head">
                  <span>Email</span>
                  <span>Role</span>
                  <span>Status</span>
                  <span>Sent</span>
                  <span>Actions</span>
                </div>
                {invitations?.length === 0 && <div className="ws-users-empty">No pending invitations.</div>}
                {invitations?.map((invitation) => (
                  <div className="ws-users-row" key={invitation.id}>
                    <span data-label="Email" className="ws-users-cell-primary">{invitation.email}</span>
                    <span data-label="Role">
                      <span className={`ws-role-chip ws-role-chip-${invitation.role.toLowerCase()}`}>{invitation.role}</span>
                    </span>
                    <span data-label="Status">
                      <span className={invitation.is_expired ? 'ws-status-chip ws-status-chip-expired' : 'ws-status-chip ws-status-chip-pending'}>
                        {invitation.is_expired ? 'Expired' : 'Pending'}
                      </span>
                    </span>
                    <span data-label="Sent" className="ws-users-cell-muted">{formatDate(invitation.created_at)}</span>
                    <span data-label="Actions" className="ws-users-cell-actions">
                      {canManage && (
                        <button type="button" className="ws-row-action ws-row-action-danger" disabled={busyId === invitation.id} onClick={() => void handleCancel(invitation)}>
                          Cancel
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {modalOpen && (
        <div className="ws-modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="ws-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="ws-modal-header">
              <h2>Send Invitation</h2>
              <button type="button" className="ws-close-btn" onClick={() => setModalOpen(false)}>×</button>
            </div>
            <form className="ws-add-account-form" onSubmit={(e) => void handleSend(e)}>
              <label className="ws-field">
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="Enter user's email address" />
              </label>
              <label className="ws-field">
                Account Holder
                <select value={inviteAccountId} onChange={(e) => setInviteAccountId(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </label>
              <label className="ws-field">
                Role
                <select value={role} onChange={(e) => setRole(e.target.value as 'ADMIN' | 'VIEWER')}>
                  <option value="VIEWER">VIEWER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </label>
              {modalError && <p className="ws-error">{modalError}</p>}
              <div className="ws-business-form-actions">
                <button type="submit" className="ws-primary-btn" disabled={submitting}>
                  {submitting ? 'Sending…' : 'Send Invitation'}
                </button>
                <button type="button" className="ws-secondary-btn" onClick={() => setModalOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
