import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Menu, Moon, Sun, X } from 'lucide-react'
import './console.css'

export interface ConsoleItem {
  key: string
  label: string
  icon: ComponentType<{ size?: number }>
  /** Small red count next to the label (e.g. failing functions). */
  badge?: number
}

export interface ConsoleLink {
  label: string
  to: string
  icon: ComponentType<{ size?: number }>
}

type Theme = 'light' | 'dark'

// Same storage key the journal app itself uses, so the choice carries across the whole product.
function readTheme(): Theme {
  try {
    return localStorage.getItem('journal-theme') === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * Shared frame for the admin and developer consoles: a left sidebar listing every section, a top bar with the
 * signed-in role, the current page name, an optional status chip and the theme switch, and the page itself.
 * On phones the sidebar becomes a slide-in drawer.
 */
export function ConsoleShell({
  title,
  subtitle,
  icon: BrandIcon,
  roleLabel,
  items,
  active,
  onSelect,
  goTo,
  pageTitle,
  pageSubtitle,
  status,
  actions,
  children,
}: {
  title: string
  subtitle: string
  icon: ComponentType<{ size?: number }>
  roleLabel: string
  items: ConsoleItem[]
  active: string
  onSelect: (key: string) => void
  goTo: ConsoleLink[]
  pageTitle: string
  pageSubtitle?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(readTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('journal-theme', theme)
    } catch {
      // storage unavailable — the choice just won't be remembered
    }
  }, [theme])

  function choose(key: string): void {
    onSelect(key)
    setOpen(false)
  }

  return (
    <div className="con-shell">
      {open && <div className="con-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}

      <aside className={open ? 'con-sidebar open' : 'con-sidebar'} aria-label={`${title} navigation`}>
        <div className="con-brand">
          <span className="con-brand-mark">
            <BrandIcon size={20} />
          </span>
          <div>
            <strong>{title}</strong>
            <small>{subtitle}</small>
          </div>
          <button type="button" className="con-close" aria-label="Close menu" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <nav className="con-nav" role="tablist" aria-orientation="vertical">
          {items.map(({ key, label, icon: Icon, badge }) => (
            <button key={key} type="button" role="tab" aria-selected={active === key} className={active === key ? 'con-nav-item active' : 'con-nav-item'} onClick={() => choose(key)}>
              <Icon size={18} />
              <span>{label}</span>
              {badge ? <em className="con-badge">{badge}</em> : null}
            </button>
          ))}
        </nav>

        <div className="con-goto">
          <span className="con-goto-title">Go to</span>
          {goTo.map(({ label, to, icon: Icon }) => (
            <Link key={to} to={to} className="con-nav-item">
              <Icon size={18} />
              <span>{label}</span>
            </Link>
          ))}
        </div>
      </aside>

      <div className="con-main">
        <header className="con-topbar">
          <button type="button" className="con-menu" aria-label="Open menu" onClick={() => setOpen(true)}>
            <Menu size={20} />
          </button>
          <span className="con-role">{roleLabel}</span>
          <span className="con-crumb">{pageTitle}</span>
          <div className="con-topbar-end">
            {status}
            <button type="button" className="con-theme" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </header>

        <main className="con-content">
          <div className="con-page-head">
            <div>
              <h1>{pageTitle}</h1>
              {pageSubtitle && <p className="dev-sub">{pageSubtitle}</p>}
            </div>
            {actions && <div className="con-actions">{actions}</div>}
          </div>
          {children}
        </main>
      </div>
    </div>
  )
}
