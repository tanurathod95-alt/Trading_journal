import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { AuthModal } from '../workspace/AuthGate'

const navLinks = [
  { to: '/', label: 'Home', end: true },
  { to: '/features', label: 'Features' },
  { to: '/for-traders', label: 'For Traders' },
  { to: '/for-portfolio-managers', label: 'For Portfolio Managers' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/security', label: 'Security' },
]

type AuthScreen = 'login' | 'signup' | 'reset'

// Where each platform role lands right after logging in (unless they were heading to a specific page).
const STAFF_LANDING = { USER: '/app', ADMIN: '/app/admin', DEVELOPER: '/app/dev' } as const

export function MarketingLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [authScreen, setAuthScreen] = useState<AuthScreen | null>(null)
  const [authResetToken, setAuthResetToken] = useState('')
  // Where to go after a successful login — the /app/... page the visitor was originally trying to open.
  const [authReturnTo, setAuthReturnTo] = useState<string | null>(null)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    // Set by AuthGate when a signed-out visitor hits /app/* — it redirects here
    // instead of showing a standalone full-page login screen, so the popup
    // opens on top of the real homepage. Consumed once, then cleared from
    // history so a refresh/back doesn't reopen it.
    const state = location.state as { openAuth?: AuthScreen; resetToken?: string; from?: string } | null
    if (state?.openAuth) {
      setAuthScreen(state.openAuth)
      setAuthResetToken(state.resetToken ?? '')
      // Only a specific page deep inside /app counts as "where I was going" — a bare /app is just the front door,
      // so the role-based default (developers -> their panel) still applies.
      const from = state.from?.replace(/\/+$/, '')
      setAuthReturnTo(from && from !== '/app' && from.startsWith('/app/') ? from : null)
      navigate(location.pathname, { replace: true, state: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  function openAuth(screen: AuthScreen): void {
    setAuthResetToken('')
    setAuthReturnTo(null)
    setAuthScreen(screen)
  }

  return (
    <div className="mk-page">
      <header className="mk-nav">
        <div className="mk-nav-row">
          <Link to="/" className="mk-nav-brand">
            <span className="mk-nav-mark">TJ</span>
            Trading Journal
          </Link>
          <button
            type="button"
            className="mk-nav-toggle"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>
        </div>
        <div className={`mk-nav-collapsible ${menuOpen ? 'open' : ''}`}>
          <nav className="mk-nav-links">
            {navLinks.map((link) => (
              <NavLink key={link.to} to={link.to} end={'end' in link} className={({ isActive }) => (isActive ? 'active' : '')}>
                {link.label}
              </NavLink>
            ))}
          </nav>
          <div className="mk-nav-cta">
            <button type="button" className="mk-btn-secondary" onClick={() => openAuth('login')}>Login</button>
            <button type="button" className="mk-btn-primary" onClick={() => openAuth('signup')}>Get Started</button>
          </div>
        </div>
      </header>

      <main className="mk-main">
        <Outlet />
      </main>

      <footer className="mk-footer">
        <p>
          © {new Date().getFullYear()} Trading Journal · <Link to="/about">About</Link> · <Link to="/contact">Contact</Link> ·{' '}
          <Link to="/security">Security</Link>
        </p>
      </footer>

      {authScreen && (
        <ErrorBoundary label="Login">
          <AuthModal
            initialScreen={authScreen}
            initialResetToken={authResetToken}
            onClose={() => setAuthScreen(null)}
            onAuthenticated={(me) => {
              setAuthScreen(null)
              // A page the visitor was heading to wins; otherwise developers land straight on their panel
              // (they can still reach the normal app from its "Back to app" link), everyone else on the mode picker.
              navigate(authReturnTo ?? STAFF_LANDING[me?.user.platform_role ?? 'USER'])
            }}
          />
        </ErrorBoundary>
      )}
    </div>
  )
}
