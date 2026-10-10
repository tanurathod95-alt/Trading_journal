import { Link } from 'react-router-dom'
import { PromoBanner } from '../PromoBanner'

export function Home() {
  return (
    <>
      <section className="mk-hero">
        <p className="mk-demo-label">Illustrative demo data shown below — not real account figures</p>
        <h1>One workspace for your trading, portfolios and performance.</h1>
        <p className="mk-sub">
          Track multiple trading accounts, manage client portfolios, analyze performance and share secure read-only
          reports — all from one platform.
        </p>
        <div className="mk-hero-cta">
          <Link to="/app" className="mk-btn-primary">Start Free</Link>
          <Link to="/features" className="mk-btn-secondary">Explore Features</Link>
        </div>
      </section>

      <section className="mk-section tight">
        <p className="mk-eyebrow" style={{ textAlign: 'center' }}>See it in action</p>
        <h2 style={{ textAlign: 'center' }}>What it actually looks like inside</h2>
        <p className="mk-lead" style={{ textAlign: 'center', margin: '0 auto 32px' }}>
          Real screens from the app — Dashboard, Journal and Analytics. Sample data shown for illustration.
        </p>

        <div className="mk-showcase-scroll">
          {[
            { src: '/screenshots/dashboard.png', label: 'Dashboard' },
            { src: '/screenshots/journal.png', label: 'Journal' },
            { src: '/screenshots/analytics.png', label: 'Analytics' },
          ].map((shot) => (
            <div key={shot.label} className="mk-browser-frame">
              <div className="mk-browser-chrome">
                <span className="mk-browser-dot red" />
                <span className="mk-browser-dot yellow" />
                <span className="mk-browser-dot green" />
                <span className="mk-browser-title">{shot.label}</span>
              </div>
              <img src={shot.src} alt={`Trading Journal — ${shot.label} screen`} loading="lazy" />
            </div>
          ))}
        </div>
      </section>

      <section className="mk-section">
        <p className="mk-eyebrow">The problem</p>
        <h2>Trading data scattered across brokers, spreadsheets and screenshots</h2>
        <p className="mk-lead">
          Most traders juggle multiple broker accounts and a journal that lives nowhere in particular. Portfolio
          managers handling several clients have it worse — there&apos;s no safe way to let a client see just their own
          numbers without handing over everything.
        </p>
        <p className="mk-eyebrow">The solution</p>
        <h2>A single workspace, properly separated by account and access</h2>
        <p className="mk-lead">
          Every trading account is isolated. Every share is explicit and revocable. Every client sees only what
          you&apos;ve given them — read-only, always.
        </p>
      </section>

      <section className="mk-section">
        <p className="mk-eyebrow">What&apos;s inside</p>
        <h2>Everything a serious trading practice needs</h2>
        <div className="mk-grid" style={{ marginTop: 24 }}>
          <div className="mk-card">
            <h3>Trading Journal</h3>
            <p>Entries, exits, strategy notes, screenshots and full trade review — for every account.</p>
          </div>
          <div className="mk-card">
            <h3>Multi-Account Management</h3>
            <p>Unlimited trading accounts across different brokers, cleanly isolated from one another.</p>
          </div>
          <div className="mk-card">
            <h3>Portfolio Management</h3>
            <p>Group accounts under a portfolio for one client — holdings, P&amp;L and performance in one place.</p>
          </div>
          <div className="mk-card">
            <h3>Client Portal</h3>
            <p>A dedicated, read-only view for anyone you share a portfolio with.</p>
          </div>
          <div className="mk-card">
            <h3>Analytics</h3>
            <p>Win rate, profit factor, average win/loss and drawdown, computed from your real trades.</p>
          </div>
          <div className="mk-card">
            <h3>Broker Integrations</h3>
            <p>Angel One today, with more brokers planned — credentials encrypted at rest, never shown to a Viewer.</p>
          </div>
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
