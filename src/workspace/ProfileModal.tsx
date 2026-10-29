import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, workspaceApi, type SupportAccessSession } from './api'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

export function ProfileModal({ onClose }: { onClose: () => void }) {
  const { me, updateDisplayName } = useWorkspaceAuth()
  const [displayName, setDisplayName] = useState(me?.user.display_name ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameSaved, setNameSaved] = useState(false)
  const [savingName, setSavingName] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSaved, setPasswordSaved] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)

  // Every time platform support opened a read-only view of this account — shown so support never looks in secret.
  const [supportViews, setSupportViews] = useState<SupportAccessSession[] | null>(null)
  useEffect(() => {
    let cancelled = false
    workspaceApi.supportAccess().then((r) => !cancelled && setSupportViews(r.sessions)).catch(() => !cancelled && setSupportViews(null))
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSaveName(event: FormEvent): Promise<void> {
    event.preventDefault()
    setNameError(null)
    setNameSaved(false)
    setSavingName(true)
    try {
      await updateDisplayName(displayName)
      setNameSaved(true)
    } catch (err) {
      setNameError(err instanceof ApiError ? err.message : 'Could not update your name.')
    } finally {
      setSavingName(false)
    }
  }

  async function handleChangePassword(event: FormEvent): Promise<void> {
    event.preventDefault()
    setPasswordError(null)
    setPasswordSaved(false)
    setSavingPassword(true)
    try {
      await workspaceApi.changePassword(currentPassword, newPassword)
      setPasswordSaved(true)
      setCurrentPassword('')
      setNewPassword('')
    } catch (err) {
      setPasswordError(err instanceof ApiError ? err.message : 'Could not change your password.')
    } finally {
      setSavingPassword(false)
    }
  }

  if (!me) return null

  return (
    <div className="ws-modal-backdrop" onClick={onClose}>
      <div className="ws-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="ws-modal-header">
          <div>
            <h2>Your Profile</h2>
            <p className="ws-muted">{me.user.email}</p>
          </div>
          <button type="button" className="ws-close-btn" onClick={onClose}>×</button>
        </div>

        <form className="ws-add-account-form" onSubmit={(e) => void handleSaveName(e)}>
          <p className="ws-section-title">Display Name</p>
          {nameError && <p className="ws-error">{nameError}</p>}
          {nameSaved && <p className="ws-muted small" style={{ color: 'var(--success)' }}>Saved.</p>}
          <label className="ws-field">
            Full name
            <input value={displayName} onChange={(e) => { setDisplayName(e.target.value); setNameSaved(false) }} required minLength={1} maxLength={120} />
          </label>
          <button type="submit" className="ws-secondary-btn" disabled={savingName} style={{ alignSelf: 'flex-start' }}>
            {savingName ? 'Saving…' : 'Save name'}
          </button>
        </form>

        <form className="ws-add-account-form" onSubmit={(e) => void handleChangePassword(e)}>
          <p className="ws-section-title">Change Password</p>
          {passwordError && <p className="ws-error">{passwordError}</p>}
          {passwordSaved && (
            <p className="ws-muted small" style={{ color: 'var(--success)' }}>
              Password updated. Your other sessions have been logged out.
            </p>
          )}
          <label className="ws-field">
            Current password
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          <label className="ws-field">
            New password
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
          </label>
          <button type="submit" className="ws-secondary-btn" disabled={savingPassword} style={{ alignSelf: 'flex-start' }}>
            {savingPassword ? 'Updating…' : 'Change password'}
          </button>
        </form>

        {supportViews !== null && (
          <section className="ws-add-account-form" aria-label="Support access to your data">
            <p className="ws-section-title">Support access to your data</p>
            {supportViews.length === 0 ? (
              <p className="ws-muted small">Our support team has not looked at your account data.</p>
            ) : (
              <>
                <p className="ws-muted small">
                  Support can open a read-only view of your server-side accounts to help with a problem. Each time is listed here. They cannot change anything, and your personal-mode journal on this device is never visible to them.
                </p>
                <ul className="ws-muted small" style={{ margin: 0, paddingLeft: 18 }}>
                  {supportViews.map((v) => (
                    <li key={v.started_at}>
                      {new Date(v.started_at).toLocaleString()} — {v.ended_at ? 'closed' : 'open now'}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
