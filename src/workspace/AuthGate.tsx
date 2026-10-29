import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { ArrowRight, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, Lock, Mail } from 'lucide-react'
import { ApiError, workspaceApi, type Me } from './api'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

type Screen = 'login' | 'signup' | 'forgot' | 'forgot-sent' | 'reset' | 'reset-done'

function getTokenFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('reset_token')
  } catch {
    return null
  }
}

/**
 * Gate for the authenticated app (`/app/*`). Signed-out visitors are sent to
 * the marketing home page instead of a standalone full-page login screen —
 * MarketingLayout reads `location.state.openAuth` and opens `AuthModal` on
 * top of the real homepage, so the login/signup form appears as a popup over
 * the site rather than replacing it.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useWorkspaceAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div className="ws-auth-screen">
        <div className="ws-auth-loading">
          <Loader2 className="ws-spin" size={28} />
          <p className="ws-muted">Loading your workspace…</p>
        </div>
      </div>
    )
  }

  if (status === 'signed-out') {
    const resetToken = getTokenFromUrl()
    return (
      <Navigate
        to="/"
        replace
        state={{ openAuth: resetToken ? 'reset' : 'login', resetToken: resetToken ?? undefined, from: location.pathname }}
      />
    )
  }

  return <>{children}</>
}

/** The login/signup/forgot-password popup — rendered by MarketingLayout on top of whichever
 * marketing page is behind it, matching the "modal over the homepage" pattern instead of a
 * dedicated full-page auth screen. */
export function AuthModal({
  initialScreen = 'login',
  initialResetToken = '',
  onClose,
  onAuthenticated,
}: {
  initialScreen?: Screen
  initialResetToken?: string
  onClose: () => void
  /** `me` is the freshly logged-in user (null after signup — a brand-new account is never staff). */
  onAuthenticated: (me: Me | null) => void
}) {
  const [screen, setScreen] = useState<Screen>(initialScreen)
  const [resetToken, setResetToken] = useState<string>(initialResetToken)

  return (
    <div className="ws-modal-backdrop" onClick={onClose}>
      <div className="ws-auth-modal-card" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="ws-auth-modal-close" aria-label="Close" onClick={onClose}>×</button>

        <div className="ws-auth-modal-brand">
          <span className="ws-auth-brand-mark">TJ</span>
          Trading Journal
        </div>

        {screen === 'login' && (
          <LoginForm onForgot={() => setScreen('forgot')} onSignup={() => setScreen('signup')} onSuccess={onAuthenticated} />
        )}
        {screen === 'signup' && <SignupForm onLogin={() => setScreen('login')} onSuccess={() => onAuthenticated(null)} />}
        {screen === 'forgot' && (
          <ForgotPasswordForm
            onBack={() => setScreen('login')}
            onSent={(token) => {
              setResetToken(token ?? '')
              setScreen(token ? 'reset' : 'forgot-sent')
            }}
          />
        )}
        {screen === 'forgot-sent' && <ForgotSentNotice onBack={() => setScreen('login')} />}
        {screen === 'reset' && (
          <ResetPasswordForm token={resetToken} onDone={() => setScreen('reset-done')} onBack={() => setScreen('login')} />
        )}
        {screen === 'reset-done' && <ResetDoneNotice onLogin={() => setScreen('login')} />}
      </div>
    </div>
  )
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  minLength?: number
  placeholder?: string
}) {
  const [visible, setVisible] = useState(false)
  return (
    <label className="ws-field">
      {label}
      <div className="ws-input-icon-wrap ws-password-wrap">
        <Lock size={15} />
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          minLength={minLength}
          autoComplete={autoComplete}
          placeholder={placeholder}
        />
        <button
          type="button"
          className="ws-password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </label>
  )
}

function LoginForm({ onForgot, onSignup, onSuccess }: { onForgot: () => void; onSignup: () => void; onSuccess: (me: Me) => void }) {
  const { login } = useWorkspaceAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const me = await login(email, password)
      onSuccess(me)
    } catch (err) {
      // Password is never cleared on error, only re-typing the email is
      // avoided too — this is the single biggest login-conversion killer
      // per UX guidance, so both fields stay exactly as the user left them.
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="ws-auth-card" onSubmit={(e) => void handleSubmit(e)}>
      <div>
        <h2>Welcome back</h2>
        <p className="ws-muted">Log in to your workspace.</p>
      </div>

      {error && <p className="ws-error">{error}</p>}

      <label className="ws-field">
        Email
        <div className="ws-input-icon-wrap">
          <Mail size={15} />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            autoFocus
            placeholder="you@example.com"
          />
        </div>
      </label>

      <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="current-password" placeholder="Enter your password" />

      <button type="button" className="ws-link-btn ws-forgot-link" onClick={onForgot}>
        Forgot password?
      </button>

      <button type="submit" className="ws-primary-btn ws-auth-submit" disabled={submitting}>
        {submitting ? 'Logging in…' : (
          <>
            Log in <ArrowRight size={16} />
          </>
        )}
      </button>

      <div className="ws-auth-divider">
        <span>OR</span>
      </div>

      <p className="ws-auth-switch">
        Don&apos;t have an account? <button type="button" className="ws-link-btn" onClick={onSignup}>Sign up</button>
      </p>
    </form>
  )
}

function SignupForm({ onLogin, onSuccess }: { onLogin: () => void; onSuccess: () => void }) {
  const { signup } = useWorkspaceAuth()
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const passwordTooShort = password.length > 0 && password.length < 8

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await signup(email, password, displayName)
      onSuccess()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="ws-auth-card" onSubmit={(e) => void handleSubmit(e)}>
      <div>
        <h2>Create your workspace</h2>
        <p className="ws-muted">Free to start — no card required.</p>
      </div>

      {error && <p className="ws-error">{error}</p>}

      <label className="ws-field">
        Full name
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required minLength={1} maxLength={120} autoComplete="name" autoFocus />
      </label>

      <label className="ws-field">
        Email
        <div className="ws-input-icon-wrap">
          <Mail size={15} />
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
      </label>

      <PasswordField label="Password" value={password} onChange={setPassword} autoComplete="new-password" minLength={8} />
      {passwordTooShort ? (
        <p className="ws-muted small ws-password-hint warn">At least 8 characters</p>
      ) : (
        <p className="ws-muted small ws-password-hint">At least 8 characters</p>
      )}

      <button type="submit" className="ws-primary-btn ws-auth-submit" disabled={submitting}>
        {submitting ? 'Creating your workspace…' : 'Create free account'}
      </button>

      <p className="ws-auth-switch">
        Already have an account? <button type="button" className="ws-link-btn" onClick={onLogin}>Log in</button>
      </p>
    </form>
  )
}

function ForgotPasswordForm({ onBack, onSent }: { onBack: () => void; onSent: (devToken: string | null) => void }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result = await workspaceApi.forgotPassword(email)
      onSent(result.dev_reset_token)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="ws-auth-card" onSubmit={(e) => void handleSubmit(e)}>
      <div>
        <h2>Reset your password</h2>
        <p className="ws-muted">Enter the email on your account and we&apos;ll send a reset link.</p>
      </div>

      {error && <p className="ws-error">{error}</p>}

      <label className="ws-field">
        Email
        <div className="ws-input-icon-wrap">
          <Mail size={15} />
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus />
        </div>
      </label>

      <button type="submit" className="ws-primary-btn ws-auth-submit" disabled={submitting}>
        {submitting ? 'Sending…' : 'Send reset link'}
      </button>

      <button type="button" className="ws-link-btn ws-auth-switch-link" onClick={onBack}>
        ← Back to login
      </button>
    </form>
  )
}

function ForgotSentNotice({ onBack }: { onBack: () => void }) {
  return (
    <div className="ws-auth-card ws-auth-notice">
      <div className="ws-auth-notice-icon">
        <Mail size={26} />
      </div>
      <h2>Check your email</h2>
      <p className="ws-muted">
        If an account exists for that email, we&apos;ve sent a link to reset your password. It expires in 60 minutes.
      </p>
      <button type="button" className="ws-secondary-btn ws-auth-submit" onClick={onBack}>
        Back to login
      </button>
    </div>
  )
}

function ResetPasswordForm({ token: initialToken, onDone, onBack }: { token: string; onDone: () => void; onBack: () => void }) {
  const [token, setToken] = useState(initialToken)
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setToken(initialToken)
  }, [initialToken])

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await workspaceApi.resetPassword(token, newPassword)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'This reset link is invalid or has expired.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="ws-auth-card" onSubmit={(e) => void handleSubmit(e)}>
      <div>
        <h2>Choose a new password</h2>
        <p className="ws-muted">
          {initialToken
            ? 'Your reset link is ready below — set a new password to continue.'
            : 'No email is configured yet in this local environment, so paste your reset token below (returned by "Send reset link").'}
        </p>
      </div>

      {error && <p className="ws-error">{error}</p>}

      {!initialToken && (
        <label className="ws-field">
          Reset token
          <div className="ws-input-icon-wrap">
            <KeyRound size={15} />
            <input value={token} onChange={(e) => setToken(e.target.value)} required autoFocus />
          </div>
        </label>
      )}

      <PasswordField label="New password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" minLength={8} />

      <button type="submit" className="ws-primary-btn ws-auth-submit" disabled={submitting || !token}>
        {submitting ? 'Resetting…' : 'Reset password'}
      </button>

      <button type="button" className="ws-link-btn ws-auth-switch-link" onClick={onBack}>
        ← Back to login
      </button>
    </form>
  )
}

function ResetDoneNotice({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="ws-auth-card ws-auth-notice">
      <div className="ws-auth-notice-icon success">
        <CheckCircle2 size={26} />
      </div>
      <h2>Password updated</h2>
      <p className="ws-muted">You&apos;ve been logged out everywhere for security. Log back in with your new password.</p>
      <button type="button" className="ws-primary-btn ws-auth-submit" onClick={onLogin}>
        Log in
      </button>
    </div>
  )
}
