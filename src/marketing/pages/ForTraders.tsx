import { PromoBanner } from '../PromoBanner'

export function ForTraders() {
  return (
    <section className="mk-section">
      <p className="mk-eyebrow">For Traders</p>
      <h2>Start with one account. Add more when you need to.</h2>
      <p className="mk-lead">
        Sign up and you get one trading account on the Free plan — enough to see if this fits how you actually trade,
        with zero commitment.
      </p>

      <div className="mk-grid" style={{ marginTop: 24 }}>
        <div className="mk-card">
          <h3>Manage every broker account</h3>
          <p>Angel One today, more brokers on the roadmap — each account&apos;s data stays completely separate from the rest.</p>
        </div>
        <div className="mk-card">
          <h3>Track what actually matters</h3>
          <p>Trades, P&amp;L, journal notes and performance — computed from your real entries, not estimates.</p>
        </div>
        <div className="mk-card">
          <h3>Upgrade only when you need to</h3>
          <p>Add more trading accounts and invite more people to a shared account as your needs grow, on a plan that fits.</p>
        </div>
      </div>

      <div style={{ marginTop: 48 }}>
        <PromoBanner heading="Bring your first account in today" subtext="Free to start, no card required." />
      </div>
    </section>
  )
}
