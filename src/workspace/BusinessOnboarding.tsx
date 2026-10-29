import { useState } from 'react'
import { BarChart3, Building2, CreditCard, Folder, LayoutDashboard, Settings as SettingsIcon, UsersRound } from 'lucide-react'
import heroIllustration from '../assets/business-onboarding-illustration.png'

type SidebarKey = 'dashboard' | 'accounts' | 'portfolios' | 'clients' | 'reports' | 'billing' | 'settings'

const sidebarItems: Array<{ key: SidebarKey; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'accounts', label: 'Business Accounts', icon: Building2 },
  { key: 'portfolios', label: 'Portfolios', icon: Folder },
  { key: 'clients', label: 'Clients', icon: UsersRound },
  { key: 'reports', label: 'Reports', icon: BarChart3 },
  { key: 'billing', label: 'Billing', icon: CreditCard },
  { key: 'settings', label: 'Settings', icon: SettingsIcon },
]

const bottomNavItems: Array<{ key: SidebarKey; label: string }> = [
  { key: 'dashboard', label: 'Home' },
  { key: 'portfolios', label: 'Portfolios' },
  { key: 'clients', label: 'Clients' },
]

/**
 * First-run Business mode screen, shown only before the workspace has any
 * business account yet. Matches the rest of the app's sidebar (desktop) /
 * bottom-nav (mobile, reusing App.css's existing `.bottom-nav` classes —
 * already global via the App.tsx import chain, so no new CSS needed there)
 * navigation conventions instead of inventing a third pattern.
 *
 * Clients and Reports are real sections of the app, but both need a
 * business account to exist first (invitations and performance reporting
 * are per-account) — so, same as the "Add Trading Account" step below,
 * picking either of them here routes to account creation rather than
 * showing an empty page with no account to act on.
 */
export function BusinessOnboarding({
  onCreateAccount,
  onOpenAccounts,
  onOpenPortfolios,
  onOpenBilling,
  onOpenSettings,
}: {
  onCreateAccount: () => void
  onOpenAccounts: () => void
  onOpenPortfolios: () => void
  onOpenBilling: () => void
  onOpenSettings: () => void
}) {
  const [howItWorksOpen, setHowItWorksOpen] = useState(false)

  const sidebarActions: Record<SidebarKey, () => void> = {
    dashboard: () => {},
    accounts: onOpenAccounts,
    portfolios: onOpenPortfolios,
    clients: onCreateAccount,
    reports: onCreateAccount,
    billing: onOpenBilling,
    settings: onOpenSettings,
  }

  return (
    <div className="ws-biz-layout">
      <aside className="ws-biz-sidebar">
        {sidebarItems.map((item) => (
          <button
            key={item.key}
            type="button"
            className={item.key === 'dashboard' ? 'ws-biz-sidebar-item active' : 'ws-biz-sidebar-item'}
            onClick={sidebarActions[item.key]}
          >
            <item.icon size={18} />
            <span>{item.label}</span>
          </button>
        ))}
      </aside>

      <main className="ws-biz-main">
        <h1 className="ws-biz-title">Business Dashboard</h1>
        <p className="ws-muted">Manage your business accounts and client portfolios in one place.</p>

        <div className="ws-biz-hero">
          <div className="ws-biz-hero-content">
            <span className="ws-biz-badge">Get Started</span>
            <h2>Your business workspace starts here</h2>
            <p className="ws-muted">
              Create a business account to organize portfolios, invite clients, and track performance.
            </p>
            <div className="ws-biz-hero-actions">
              <button type="button" className="ws-primary-btn" onClick={onCreateAccount}>
                + Create Business Account
              </button>
              <button type="button" className="ws-link-btn" onClick={() => setHowItWorksOpen((open) => !open)}>
                {howItWorksOpen ? 'Hide details' : 'Learn how it works'}
              </button>
            </div>
            {howItWorksOpen && (
              <p className="ws-muted small ws-biz-how-it-works">
                A business account groups portfolios and lets you invite clients with Viewer or Admin access —
                Viewers see a read-only view of the trades you share, Admins can manage the account itself.
              </p>
            )}
          </div>
          <img className="ws-biz-hero-art" src={heroIllustration} alt="" aria-hidden="true" />
        </div>

        <h3 className="ws-biz-steps-title">Get started in 3 simple steps</h3>
        <div className="ws-biz-steps">
          <div className="ws-biz-step-card">
            <span className="ws-biz-step-icon-wrap">
              <span className="ws-biz-step-num">1</span>
              <span className="ws-biz-step-icon">
                <Building2 size={18} />
              </span>
            </span>
            <h4>Create workspace</h4>
            <p className="ws-muted small">Set up your business account and configure basic details.</p>
          </div>
          <button type="button" className="ws-biz-step-card" onClick={onOpenPortfolios}>
            <span className="ws-biz-step-icon-wrap">
              <span className="ws-biz-step-num">2</span>
              <span className="ws-biz-step-icon">
                <Folder size={18} />
              </span>
            </span>
            <h4>Add portfolios</h4>
            <p className="ws-muted small">Create and manage trading accounts for your clients.</p>
          </button>
          <button type="button" className="ws-biz-step-card" onClick={onCreateAccount}>
            <span className="ws-biz-step-icon-wrap">
              <span className="ws-biz-step-num">3</span>
              <span className="ws-biz-step-icon">
                <UsersRound size={18} />
              </span>
            </span>
            <h4>Invite clients</h4>
            <p className="ws-muted small">Share access and give clients view-only or full access.</p>
          </button>
        </div>
      </main>

      <nav className="bottom-nav">
        {bottomNavItems.map(({ key, label }) => {
          const icon = sidebarItems.find((i) => i.key === key)!.icon
          const Icon = icon
          return (
            <button
              key={key}
              type="button"
              className={key === 'dashboard' ? 'bottom-nav-item active' : 'bottom-nav-item'}
              onClick={sidebarActions[key]}
            >
              <Icon size={20} />
              <span>{label}</span>
            </button>
          )
        })}
        <button type="button" className="bottom-nav-item" onClick={onOpenSettings}>
          <SettingsIcon size={20} />
          <span>More</span>
        </button>
      </nav>
    </div>
  )
}
