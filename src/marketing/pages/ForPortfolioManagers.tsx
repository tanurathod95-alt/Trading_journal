import { PromoBanner } from '../PromoBanner'

export function ForPortfolioManagers() {
  return (
    <section className="mk-section">
      <p className="mk-eyebrow">For Portfolio Managers</p>
      <h2>Manage multiple client portfolios from one workspace</h2>
      <p className="mk-lead">
        Group each client&apos;s trading accounts into a portfolio, track performance across all of them, and invite the
        client to a read-only view of exactly that portfolio — nothing else in your workspace.
      </p>

      <div className="mk-tree" style={{ margin: '24px 0' }}>
{`Portfolio Manager
     │
     ├── Client A
     │     ├── Account
     │     └── Performance
     │
     ├── Client B
     │     ├── Account
     │     └── Performance
     │
     └── Client C
           ├── Accounts
           └── Performance`}
      </div>

      <div className="mk-grid" style={{ marginTop: 24 }}>
        <div className="mk-card">
          <h3>Create client portfolios</h3>
          <p>Group one or more trading accounts under a client&apos;s portfolio.</p>
        </div>
        <div className="mk-card">
          <h3>Track P&amp;L and performance</h3>
          <p>Portfolio-level rollups across every account you&apos;ve assigned to it.</p>
        </div>
        <div className="mk-card">
          <h3>Generate reports</h3>
          <p>Account and portfolio reports, exportable to Excel and PDF.</p>
        </div>
        <div className="mk-card">
          <h3>Invite clients, read-only</h3>
          <p>One invitation grants access to every account in that portfolio — never to anything else in your workspace.</p>
        </div>
        <div className="mk-card">
          <h3>Revoke instantly</h3>
          <p>Remove a client&apos;s access and it takes effect on their very next request.</p>
        </div>
      </div>

      <div style={{ marginTop: 48 }}>
        <PromoBanner heading="Bring your clients into one workspace" subtext="Start free, upgrade as your client list grows." />
      </div>
    </section>
  )
}
