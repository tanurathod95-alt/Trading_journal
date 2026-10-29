import { Link } from 'react-router-dom'
import { BarChart3, BookOpen, Briefcase, Layers, Link2, MonitorSmartphone, ShieldCheck, Users, type LucideIcon } from 'lucide-react'
import { PromoBanner } from '../PromoBanner'

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: BookOpen, title: 'Trading Journal', text: 'Entries, exits, strategy notes, screenshots and full trade review — for every account.' },
  { icon: Users, title: 'Multi-Account Management', text: 'Unlimited trading accounts across different brokers, cleanly isolated from one another.' },
  { icon: Briefcase, title: 'Portfolio Management', text: 'Group accounts under a portfolio for one client — holdings, P&L and performance in one place.' },
  { icon: MonitorSmartphone, title: 'Client Portal', text: 'A dedicated, read-only view for anyone you share a portfolio with.' },
  { icon: BarChart3, title: 'Analytics', text: 'Win rate, profit factor, average win/loss and drawdown, computed from your real trades.' },
  { icon: Link2, title: 'Broker Integrations', text: 'Angel One today, with more brokers planned — credentials encrypted at rest, never shown to a Viewer.' },
]

function ShotFrame({ src, label, eager = false }: { src: string; label: string; eager?: boolean }) {
  return (
    <div className="mkh-frame">
      <div className="mk-browser-chrome">
        <span className="mk-browser-dot red" />
        <span className="mk-browser-dot yellow" />
        <span className="mk-browser-dot green" />
        <span className="mk-browser-title">{label}</span>
      </div>
      <img src={src} alt={`Trading Journal — ${label} screen`} width={1600} height={1000} loading={eager ? 'eager' : 'lazy'} decoding="async" />
    </div>
  )
}

export function Home() {
  return (
    <>
      <section className="mk-hero mkh-hero">
        <p className="mk-demo-label">Illustrative demo data shown below — not real account figures</p>
        <h1>
          One workspace for your trading, portfolios and <span className="mkh-accent">performance.</span>
        </h1>
        <p className="mk-sub">
          Track multiple trading accounts, manage client portfolios, analyze performance and share secure read-only
          reports — all from one platform.
        </p>
        <div className="mk-hero-cta">
          <Link to="/app" className="mk-btn-primary">Start Free</Link>
          <Link to="/features" className="mk-btn-secondary">Explore Features</Link>
        </div>

        <div className="mkh-hero-preview">
          <ShotFrame src="/screenshots/dashboard.png" label="Dashboard" eager />
        </div>
      </section>

      <section className="mkh-section">
        <p className="mk-eyebrow" style={{ textAlign: 'center' }}>See it in action</p>
        <h2 className="mkh-h2" style={{ textAlign: 'center' }}>What it actually looks like inside</h2>
        <p className="mkh-lead" style={{ textAlign: 'center', margin: '0 auto 32px' }}>
          Real screens from the app — Dashboard, Journal and Analytics. Sample data shown for illustration.
        </p>
        <div className="mkh-shots">
          <ShotFrame src="/screenshots/journal.png" label="Journal" />
          <ShotFrame src="/screenshots/analytics.png" label="Analytics" />
        </div>
      </section>

      <section className="mkh-section">
        <div className="mkh-ps">
          <article className="mkh-ps-col">
            <span className="mkh-icon" aria-hidden="true"><Layers size={22} /></span>
            <p className="mk-eyebrow">The problem</p>
            <h2 className="mkh-h2">Trading data scattered across brokers, spreadsheets and screenshots</h2>
            <p className="mkh-lead">
              Most traders juggle multiple broker accounts and a journal that lives nowhere in particular. Portfolio
              managers handling several clients have it worse — there&apos;s no safe way to let a client see just their
              own numbers without handing over everything.
            </p>
          </article>
          <article className="mkh-ps-col solution">
            <span className="mkh-icon" aria-hidden="true"><ShieldCheck size={22} /></span>
            <p className="mk-eyebrow">The solution</p>
            <h2 className="mkh-h2">A single workspace, properly separated by account and access</h2>
            <p className="mkh-lead">
              Every trading account is isolated. Every share is explicit and revocable. Every client sees only what
              you&apos;ve given them — read-only, always.
            </p>
          </article>
        </div>
      </section>

      <section className="mkh-section">
        <p className="mk-eyebrow">What&apos;s inside</p>
        <h2 className="mkh-h2">Everything a serious trading practice needs</h2>
        <div className="mkh-features">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="mkh-feature">
              <span className="mkh-icon" aria-hidden="true"><Icon size={22} /></span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mk-section">
        <p className="mk-eyebrow">How it works</p>
        <h2>From signup to a shared client report in minutes</h2>
        <div className="mk-steps" style={{ marginTop: 24 }}>
          <div className="mk-step">
            <h4>Create your workspace</h4>
            <p>Sign up and get your own isolated workspace — no one else can ever see your data.</p>
          </div>
          <div className="mk-step">
            <h4>Add trading accounts</h4>
            <p>As many as you need, each cleanly separated with its own trades, P&amp;L and journal.</p>
          </div>
          <div className="mk-step">
            <h4>Group into portfolios</h4>
            <p>Managing clients? Bundle their accounts into a portfolio.</p>
          </div>
          <div className="mk-step">
            <h4>Share, read-only</h4>
            <p>Invite by email — they see exactly what you shared, nothing more, revocable anytime.</p>
          </div>
        </div>
      </section>

      <section className="mk-section tight">
        <p className="mk-eyebrow">Pricing preview</p>
        <h2>Start free. Upgrade only when you need more.</h2>
        <p className="mk-lead">
          <Link to="/pricing" className="mk-inline-link">See full plan details and pricing →</Link>
        </p>
      </section>

      <PromoBanner
        heading="Ready to bring your trading into one place?"
        subtext="Free to start. No card required for the Free plan."
      />
    </>
  )
}
