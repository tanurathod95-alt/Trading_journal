import { useState, type FormEvent, type ReactNode } from 'react'
import { Check, Copy, Loader2, X } from 'lucide-react'
import { ApiError, type StaffResetLink } from '../workspace/api'
import { when } from './helpers'

export const MIN_REASON_LENGTH = 5

/**
 * Every staff write goes through this: why you're doing it, and your own password again. The server enforces both
 * (and a lockout after 5 wrong passwords) — this just collects them and shows the server's answer plainly.
 */
export function ActionDialog({
  title,
  intro,
  confirmLabel,
  danger,
  fields,
  onClose,
  onSubmit,
}: {
  title: string
  intro: ReactNode
  confirmLabel: string
  danger?: boolean
  /** Extra inputs shown above the reason (e.g. which plan). The caller owns their state. */
  fields?: ReactNode
  onClose: () => void
  onSubmit: (reason: string, password: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ready = reason.trim().length >= MIN_REASON_LENGTH && password.length > 0

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(reason.trim(), password)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Nothing was changed.')
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <div className="ws-modal-backdrop" onClick={busy ? undefined : onClose}>
      <form className="ws-modal-card adm-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <header className="adm-dialog-head">
          <h2>{title}</h2>
          <button type="button" className="dev-btn" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={14} />
          </button>
        </header>
        <div className="adm-dialog-intro">{intro}</div>
        {fields}

        <label className="adm-field">
          Reason <span className="dev-muted">(kept in the audit log)</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder="e.g. Customer called, identity verified on the number we have on file" autoFocus />
        </label>
        <label className="adm-field">
          Your password <span className="dev-muted">(confirms it&apos;s really you)</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>

        {error && <div className="dev-alert">{error}</div>}

        <footer className="adm-dialog-actions">
          <button type="button" className="dev-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={danger ? 'dev-btn adm-btn-danger' : 'dev-btn dev-btn-primary'} disabled={!ready || busy}>
            {busy && <Loader2 size={14} className="ws-spin" />} {confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  )
}

/** Shown once, straight after a reset link is issued. The server keeps only a hash, so closing this loses the link. */
export function ResetLinkDialog({ link, onClose }: { link: StaffResetLink; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link.reset_url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="ws-modal-backdrop">
      <div className="ws-modal-card adm-dialog" role="dialog" aria-modal="true" aria-label="Password reset link">
        <header className="adm-dialog-head">
          <h2>Password reset link ready</h2>
        </header>
        <p className="adm-dialog-intro">
          For <strong>{link.email}</strong>. It works once and expires in {link.valid_minutes} minutes ({when(link.expires_at)}).
        </p>
        <div className="adm-linkbox">
          <code className="adm-code" data-testid="reset-url">
            {link.reset_url}
          </code>
          <button type="button" className="dev-btn" onClick={() => void copy()}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <ul className="adm-steps">
          <li>
            <strong>This is the only time you&apos;ll see it.</strong> Closing this window loses it — you would have to issue a new one.
          </li>
          <li>Send it only through a channel you trust, for example by calling back the number on file. Never post it in a shared chat.</li>
          <li>The customer opens it and chooses their own password. You never see or set it.</li>
          <li>When they finish, they are signed out of every device.</li>
        </ul>
        <footer className="adm-dialog-actions">
          <button type="button" className="dev-btn dev-btn-primary" onClick={onClose}>
            I&apos;ve passed it on — close
          </button>
        </footer>
      </div>
    </div>
  )
}
