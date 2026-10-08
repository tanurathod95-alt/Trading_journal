import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'

const navLinks = [
  { to: '/features', label: 'Features' },
  { to: '/for-traders', label: 'For Traders' },
  { to: '/for-portfolio-managers', label: 'For Portfolio Managers' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/security', label: 'Security' },
]

export function MarketingLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    setMenuOpen(false)
  }, [location.pathname])

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
              <NavLink key={link.to} to={link.to} className={({ isActive }) => (isActive ? 'active' : '')}>
                {link.label}
              </NavLink>
            ))}
          </nav>
          <div className="mk-nav-cta">
            <Link to="/app" className="mk-btn-secondary">Login</Link>
            <Link to="/app" className="mk-btn-primary">Get Started</Link>
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
    </div>
  )
}
