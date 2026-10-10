import { ArrowRight, Briefcase, Eye, Link2, Notebook, Share2, UserRound, UsersRound, Wallet } from 'lucide-react'
import type { ComponentType } from 'react'

export type AppMode = 'personal' | 'view' | 'business'

const cards: Array<{
  mode: AppMode
  title: string
  description: string
  icon: ComponentType<{ size?: number }>
  accent: 'personal' | 'view' | 'business'
  features: Array<{ label: string; icon: ComponentType<{ size?: number }> }>
}> = [
  {
    mode: 'personal',
    title: 'Personal Trading',
    description: 'Manage and trade with your personal accounts.',
    icon: UserRound,
    accent: 'personal',
    features: [
      { label: 'Your Accounts', icon: Wallet },
      { label: 'Trades & Performance', icon: Notebook },
      { label: 'Trading Journal', icon: Notebook },
    ],
  },
  {
    mode: 'view',
    title: 'View Section',
    description: 'View accounts that have been shared with you.',
    icon: Eye,
    accent: 'view',
    features: [
      { label: 'Shared Accounts', icon: UsersRound },
      { label: 'Shared Journals', icon: Notebook },
      { label: 'Collaborate & View', icon: Link2 },
    ],
  },
  {
    mode: 'business',
    title: 'Business',
    description: 'Manage business accounts, portfolios and shared accounts.',
    icon: Briefcase,
    accent: 'business',
    features: [
      { label: 'Business Accounts', icon: Briefcase },
      { label: 'Team Members', icon: UsersRound },
      { label: 'Shared Portfolios', icon: Share2 },
    ],
  },
]

/** Landing page shown after login: the user picks which section to enter. */
export function ModeHome({ onSelect }: { onSelect: (mode: AppMode) => void }) {
  return (
    <div className="ws-mode-home">
      <div className="ws-mode-home-bg" aria-hidden="true">
        <svg viewBox="0 0 400 120" className="ws-mode-home-bg-chart" preserveAspectRatio="none">
          <polyline points="0,90 40,70 80,85 120,50 160,65 200,30 240,45 280,20 320,35 360,10 400,25" />
        </svg>
      </div>
      <div className="ws-mode-home-heading">
        <span className="ws-mode-home-eyebrow">Trading Journal</span>
        <h1>Choose Your Workspace</h1>
        <p className="ws-mode-home-subtitle">Select a workspace to manage your trading accounts, journals and collaborate with your team.</p>
      </div>
      <div className="ws-mode-grid">
        {cards.map(({ mode, title, description, icon: Icon, accent, features }) => (
          <button
            key={mode}
            type="button"
            className={`ws-mode-card ws-mode-card-${accent}`}
            onClick={() => onSelect(mode)}
          >
            <div className="ws-mode-card-top">
              <span className="ws-mode-card-icon">
                <Icon size={24} />
              </span>
              <span className="ws-mode-card-arrow">
                <ArrowRight size={18} />
              </span>
            </div>
            <div className="ws-mode-card-body">
              <strong>{title}</strong>
              <span className="ws-mode-card-desc">{description}</span>
            </div>
            <ul className="ws-mode-card-features">
              {features.map(({ label, icon: FeatureIcon }) => (
                <li key={label}>
                  <FeatureIcon size={14} />
                  <span>{label}</span>
                </li>
              ))}
            </ul>
          </button>
        ))}
      </div>
    </div>
  )
}
