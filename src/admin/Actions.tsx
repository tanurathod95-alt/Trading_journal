import { useState } from 'react'
import { Eye, KeyRound, LogOut, UserCheck, UserX } from 'lucide-react'
import { workspaceApi, type AdminUserDetail, type StaffResetLink } from '../workspace/api'
import { useWorkspaceAuth } from '../workspace/WorkspaceAuthContext'
import { ActionDialog, ResetLinkDialog } from './Dialogs'

type Pending = 'disable' | 'enable' | 'logout' | 'reset' | 'view' | null

/**
 * What staff can do for one customer. Which buttons show is only a convenience — the server re-checks who may touch whom
 * (nobody on themselves, only developers on other staff) and every action needs a reason and the staff member's password.
 */
export function SupportActions({ d, onChanged, onViewAs }: { d: AdminUserDetail; onChanged: (patch: { is_active?: boolean; sessionsEnded?: boolean }) => void; onViewAs: (viewId: string) => void }) {
  const { me } = useWorkspaceAuth()
  const [pending, setPending] = useState<Pending>(null)
  const [link, setLink] = useState<StaffResetLink | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const p = d.profile

  const myRole = me?.user.platform_role
  const isSelf = me?.user.id === p.id
  const targetIsStaff = p.platform_role !== 'USER'

  if (isSelf) return <p className="adm-note">This is your own account. Staff can&apos;t disable, sign out or reset themselves from here.</p>
  if (targetIsStaff && myRole !== 'DEVELOPER') {
    return <p className="adm-note">This is a staff account. Only a developer can manage it.</p>
  }

  const close = () => setPending(null)
  const done = (message: string) => {
    setFlash(message)
    close()
  }

  return (
    <>
      {flash && (
        <div className="adm-flash" role="status">
          {flash}
        </div>
      )}
      <div className="adm-actions">
        {!targetIsStaff && (
          <button type="button" className="dev-btn" onClick={() => setPending('view')}>
            <Eye size={14} /> View dashboard (read-only)
          </button>
        )}
        <button type="button" className="dev-btn" onClick={() => setPending('reset')} disabled={!p.is_active} title={p.is_active ? undefined : 'Enable the account first'}>
          <KeyRound size={14} /> Issue password-reset link
        </button>
        <button type="button" className="dev-btn" onClick={() => setPending('logout')}>
          <LogOut size={14} /> Sign out everywhere
        </button>
        {p.is_active ? (
          <button type="button" className="dev-btn adm-btn-danger" onClick={() => setPending('disable')}>
            <UserX size={14} /> Disable account
          </button>
        ) : (
          <button type="button" className="dev-btn dev-btn-primary" onClick={() => setPending('enable')}>
            <UserCheck size={14} /> Enable account
          </button>
        )}
      </div>

      {pending === 'disable' && (
        <ActionDialog
          title={`Disable ${p.email}?`}
          intro="They are signed out of every device right now and can't log in until you enable the account again. Their data is kept."
          confirmLabel="Disable account"
          danger
          onClose={close}
          onSubmit={async (reason, password) => {
            await workspaceApi.adminDisableUser(p.id, reason, password)
            onChanged({ is_active: false, sessionsEnded: true })
            done('Account disabled. Their sessions were ended.')
          }}
        />
      )}
      {pending === 'enable' && (
        <ActionDialog
          title={`Enable ${p.email}?`}
          intro="They will be able to log in again with their existing password."
          confirmLabel="Enable account"
          onClose={close}
          onSubmit={async (reason, password) => {
            await workspaceApi.adminEnableUser(p.id, reason, password)
            onChanged({ is_active: true })
            done('Account enabled.')
          }}
        />
      )}
      {pending === 'logout' && (
        <ActionDialog
          title={`Sign ${p.email} out everywhere?`}
          intro="Every session on every device ends immediately. Their account stays active and they can log in again."
          confirmLabel="Sign out everywhere"
          onClose={close}
          onSubmit={async (reason, password) => {
            const r = await workspaceApi.adminForceLogout(p.id, reason, password)
            onChanged({ sessionsEnded: true })
            done(`Signed out. ${r.sessions_ended} session(s) ended.`)
          }}
        />
      )}
      {pending === 'reset' && (
        <ActionDialog
          title={`Password reset link for ${p.email}`}
          intro="Creates a one-time link that expires soon. You'll see it once, and pass it to the customer yourself. They choose their own password — you never see it."
          confirmLabel="Create link"
          onClose={close}
          onSubmit={async (reason, password) => {
            const issued = await workspaceApi.adminIssueReset(p.id, reason, password)
            setPending(null)
            setLink(issued)
          }}
        />
      )}
      {pending === 'view' && (
        <ActionDialog
          title={`View ${p.email}'s dashboard`}
          intro="Opens a read-only view of their server-side accounts and trades. It is recorded in the audit log, and the customer can see that support looked."
          confirmLabel="Open read-only view"
          onClose={close}
          onSubmit={async (reason, password) => {
            const started = await workspaceApi.adminStartViewAs(p.id, reason, password)
            setPending(null)
            onViewAs(started.id)
          }}
        />
      )}
      {link && <ResetLinkDialog link={link} onClose={() => setLink(null)} />}
    </>
  )
}
