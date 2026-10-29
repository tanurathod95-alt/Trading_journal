import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import { ApiError, workspaceApi, type AdminUserDetail } from '../workspace/api'
import { SupportActions } from './Actions'
import { UserBilling } from './UserBilling'
import { ViewAs } from './ViewAs'
import { Badge, ListState, Metadata, Pager } from './shared'
import { ago, subscriptionTone, usePaged, useDebounced, when } from './helpers'

export function UsersTab({ initialUserId }: { initialUserId?: string | null }) {
  const [selected, setSelected] = useState<string | null>(initialUserId ?? null)
  const [viewId, setViewId] = useState<string | null>(null)
  if (viewId) return <ViewAs viewId={viewId} onExit={() => setViewId(null)} />
  if (selected) return <UserDetail userId={selected} onBack={() => setSelected(null)} onViewAs={setViewId} />
  return <UserList onSelect={setSelected} />
}

function UserList({ onSelect }: { onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [role, setRole] = useState('all')
  const [plan, setPlan] = useState('all')
  const q = useDebounced(query.trim())
  const { data, error, loading, page, setPage } = usePaged(workspaceApi.adminUsers, { q, status, role, plan })

  return (
    <section>
      <div className="dev-filters">
        <label className="dev-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or email…" aria-label="Search users" />
        </label>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by platform role">
          <option value="all">All roles</option>
          <option value="USER">Customers</option>
          <option value="ADMIN">Admins</option>
          <option value="DEVELOPER">Developers</option>
        </select>
        <select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Filter by plan">
          <option value="all">All plans</option>
          {['FREE', 'PRO', 'PREMIUM', 'BUSINESS'].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <ListState loading={loading} error={error} empty={!data || data.items.length === 0} emptyText="No users match these filters.">
        <div className="dev-table-wrap">
          <table className="dev-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Plan</th>
                <th>Subscription</th>
                <th className="num">Accounts</th>
                <th>Last login</th>
                <th className="num">Sessions</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((u) => (
                <tr key={u.id} className="adm-clickable" onClick={() => onSelect(u.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(u.id)}>
                  <td>
                    <strong>{u.display_name}</strong>
                    <div className="dev-muted">{u.email}</div>
                  </td>
                  <td>{u.platform_role === 'USER' ? <span className="dev-muted">Customer</span> : <Badge tone="warn">{u.platform_role}</Badge>}</td>
                  <td>{u.is_active ? <Badge tone="ok">Active</Badge> : <Badge tone="down">Disabled</Badge>}</td>
                  <td>{u.plan ?? '—'}</td>
                  <td>{u.subscription_status ? <Badge tone={subscriptionTone(u.subscription_status)}>{u.subscription_status}</Badge> : <span className="dev-muted">none</span>}</td>
                  <td className="num">{u.accounts}</td>
                  <td title={when(u.last_login_at)}>{ago(u.last_login_at)}</td>
                  <td className="num">{u.active_sessions}</td>
                  <td title={when(u.created_at)}>{ago(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ListState>
      <Pager data={data} page={page} onPage={setPage} />
    </section>
  )
}

function UserDetail({ userId, onBack, onViewAs }: { userId: string; onBack: () => void; onViewAs: (viewId: string) => void }) {
  const [detail, setDetail] = useState<{ id: string; data: AdminUserDetail | null; error: string | null } | null>(null)
  // Bumped after a billing fix so the plan, subscription and payments shown here are re-read from the server.
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    workspaceApi
      .adminUser(userId)
      .then((data) => !cancelled && setDetail({ id: userId, data, error: null }))
      .catch((err) => !cancelled && setDetail({ id: userId, data: null, error: err instanceof ApiError ? err.message : 'Could not load this user.' }))
    return () => {
      cancelled = true
    }
  }, [userId, reload])

  const current = detail?.id === userId ? detail : null
  return (
    <section>
      <button type="button" className="dev-back adm-back" onClick={onBack}>
        <ArrowLeft size={15} /> All users
      </button>
      {!current && <p className="dev-empty">Loading…</p>}
      {current?.error && <div className="dev-alert">{current.error}</div>}
      {current?.data && (
        <UserDetailBody
          d={current.data}
          onViewAs={onViewAs}
          onBillingChanged={() => setReload((n) => n + 1)}
          onChanged={(patch) =>
            // Reflect an action immediately without re-opening the record (which would add another "viewed" audit entry).
            setDetail((prev) =>
              prev?.data
                ? {
                    ...prev,
                    data: {
                      ...prev.data,
                      profile: { ...prev.data.profile, is_active: patch.is_active ?? prev.data.profile.is_active },
                      sessions: patch.sessionsEnded ? prev.data.sessions.map((s) => ({ ...s, active: false })) : prev.data.sessions,
                    },
                  }
                : prev,
            )
          }
        />
      )}
    </section>
  )
}

function UserDetailBody({
  d,
  onChanged,
  onBillingChanged,
  onViewAs,
}: {
  d: AdminUserDetail
  onChanged: (patch: { is_active?: boolean; sessionsEnded?: boolean }) => void
  onBillingChanged: () => void
  onViewAs: (viewId: string) => void
}) {
  const p = d.profile
  return (
    <div className="adm-detail">
      <header className="adm-detail-head">
        <div>
          <h2>{p.display_name}</h2>
          <p className="dev-muted">{p.email}</p>
        </div>
        <div className="adm-badges">
          {p.is_active ? <Badge tone="ok">Active</Badge> : <Badge tone="down">Disabled</Badge>}
          {p.platform_role !== 'USER' && <Badge tone="warn">{p.platform_role}</Badge>}
        </div>
      </header>
      <p className="adm-note">
        Opening this record was added to the audit log under your name. Passwords, session tokens, broker credentials and trade contents are never shown here.
        To see their trades you must start a read-only view, which asks for your password and a reason.
      </p>

      <div className="adm-facts">
        <Fact label="Joined" value={when(p.created_at)} />
        <Fact label="Last login" value={p.last_login_at ? `${when(p.last_login_at)} (${ago(p.last_login_at)})` : 'Never logged in'} />
        <Fact label="Failed logins (7 days)" value={String(p.failed_logins_7d)} warn={p.failed_logins_7d >= 5} />
        <Fact label="User ID" value={p.id} mono />
      </div>

      <Card title="Support actions">
        <SupportActions d={d} onChanged={onChanged} onViewAs={onViewAs} />
      </Card>

      <Card title="Billing & plan">
        <UserBilling d={d} onChanged={onBillingChanged} />
      </Card>

      <Card title={`Trading accounts (${d.accounts.length})`}>
        <SimpleTable
          head={['Account', 'Broker', 'Type', 'Their role', 'Trades', 'State']}
          rows={d.accounts.map((a) => [a.name, a.broker_name || '—', a.account_type, a.role, String(a.trades), a.is_archived ? 'Archived' : 'Active'])}
          empty="No server-side accounts. Personal-mode journals live in the user's own browser and are not visible here."
        />
      </Card>

      <Card title="Sessions">
        <SimpleTable
          head={['Started', 'Expires', 'State']}
          rows={d.sessions.map((s) => [when(s.started_at), when(s.expires_at), s.active ? <Badge key="a" tone="ok">Active</Badge> : <Badge key="e" tone="idle">Expired</Badge>])}
          empty="No sessions."
        />
      </Card>

      <Card title="Invitations addressed to this email">
        <SimpleTable head={['Type', 'Role', 'Status', 'Sent', 'Expires']} rows={d.invitations.map((i) => [i.kind, i.role, i.status, when(i.created_at), when(i.expires_at)])} empty="None." />
      </Card>

      <Card title="Recent activity (last 30 events)">
        <SimpleTable
          head={['When', 'Event', 'IP', 'Details']}
          rows={d.audit.map((a) => [
            <span key="w" title={when(a.created_at)}>
              {ago(a.created_at)}
            </span>,
            <span key="e">
              {a.action}
              {a.as_target && <span className="dev-muted"> (done to them)</span>}
            </span>,
            a.ip_address ?? '—',
            <Metadata key="m" value={a.metadata} />,
          ])}
          empty="No activity yet."
        />
      </Card>
    </div>
  )
}

function Fact({ label, value, mono, warn }: { label: string; value: string; mono?: boolean; warn?: boolean }) {
  return (
    <div className="adm-fact">
      <span className="dev-muted">{label}</span>
      <strong className={`${mono ? 'adm-code' : ''} ${warn ? 'adm-warn' : ''}`}>{value}</strong>
    </div>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="adm-card">
      <h3>{title}</h3>
      {children}
    </article>
  )
}

export function SimpleTable({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return empty ? <p className="dev-muted">{empty}</p> : null
  return (
    <div className="dev-table-wrap adm-inner-table">
      <table className="dev-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
