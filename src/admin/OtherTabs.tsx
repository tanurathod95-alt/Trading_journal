import { useEffect, useState } from 'react'
import { Download, Search } from 'lucide-react'
import { ApiError, workspaceApi, type AdminBillingOverview, type AdminSummary, type BillingIssues } from '../workspace/api'
import { NeedsAttention, PlanDialog, RazorpayLink } from './BillingFixes'
import { Badge, ListState, Metadata, Pager } from './shared'
import { ago, inr, limitText, subscriptionTone, usePaged, useDebounced, when, type Tone } from './helpers'
import { SimpleTable } from './UsersTab'

// ---- Overview ---------------------------------------------------------------------------------------------

export function OverviewTab() {
  const [state, setState] = useState<{ data: AdminSummary | null; error: string | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    workspaceApi
      .adminSummary()
      .then((data) => !cancelled && setState({ data, error: null }))
      .catch((err) => !cancelled && setState({ data: null, error: err instanceof ApiError ? err.message : 'Could not load the summary.' }))
    return () => {
      cancelled = true
    }
  }, [])

  if (!state) return <p className="dev-empty">Loading…</p>
  if (state.error || !state.data) return <div className="dev-alert">{state.error}</div>
  const s = state.data
  const stat = (label: string, value: string | number, hint?: string, tone?: Tone) => (
    <article className={`adm-stat ${tone ? `adm-stat-${tone}` : ''}`} key={label}>
      <span className="dev-muted">{label}</span>
      <strong>{value}</strong>
      {hint && <small className="dev-muted">{hint}</small>}
    </article>
  )
  const plans = Object.entries(s.workspaces.by_plan)
    .map(([plan, n]) => `${plan} ${n}`)
    .join(' · ')
  const subs = Object.entries(s.billing.subscriptions_by_status)
    .map(([status, n]) => `${status.toLowerCase()} ${n}`)
    .join(' · ')

  return (
    <section>
      <div className="adm-stats">
        {stat('Users', s.users.total, `${s.users.signed_up_today} today · ${s.users.signed_up_7d} this week`)}
        {stat('Signed in now', s.users.with_active_session, 'users with a live session')}
        {stat('Disabled users', s.users.disabled, undefined, s.users.disabled ? 'warn' : undefined)}
        {stat('Staff accounts', s.users.staff, 'admins + developers')}
        {stat('Workspaces', s.workspaces.total, plans || undefined)}
        {stat('Trading accounts', s.accounts.total, 'server-side only')}
        {stat('Paid, last 30 days', inr(s.billing.paid_last_30d_inr), subs || 'no subscriptions yet')}
        {stat('Expiring in 7 days', s.billing.expiring_in_7d, 'active subscriptions', s.billing.expiring_in_7d ? 'warn' : undefined)}
        {stat('Pending invitations', s.invitations.pending)}
        {stat('Failed logins, 24h', s.security.failed_logins_24h, undefined, s.security.failed_logins_24h >= 10 ? 'down' : undefined)}
      </div>
      <p className="dev-muted">Generated {ago(s.generated_at)}. Personal-mode journals are stored in each user's own browser, so they are not counted here.</p>
    </section>
  )
}

// ---- Workspaces -------------------------------------------------------------------------------------------

export function WorkspacesTab() {
  const [query, setQuery] = useState('')
  const [plan, setPlan] = useState('all')
  const q = useDebounced(query.trim())
  const { data, error, loading, page, setPage, reload } = usePaged(workspaceApi.adminWorkspaces, { q, plan })
  const [changing, setChanging] = useState<{ id: string; name: string; plan: string } | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  return (
    <section>
      {flash && (
        <div className="adm-flash" role="status">
          {flash}
        </div>
      )}
      <div className="dev-filters">
        <label className="dev-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search workspace name…" aria-label="Search workspaces" />
        </label>
        <select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Filter by plan">
          <option value="all">All plans</option>
          {['FREE', 'PRO', 'PREMIUM', 'BUSINESS'].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>
      <ListState loading={loading} error={error} empty={!data || data.items.length === 0} emptyText="No workspaces match.">
        <SimpleTable
          head={['Workspace', 'Owner', 'Plan', 'Accounts used', 'Seats / account', 'Members', 'Subscription', 'Created', '']}
          rows={(data?.items ?? []).map((w) => {
            const full = w.limits.max_trading_accounts !== null && w.trading_accounts_used >= w.limits.max_trading_accounts
            return [
              <strong key="n">{w.name}</strong>,
              w.owner_email,
              w.plan,
              <span key="u" className={full ? 'adm-warn' : undefined}>
                {w.trading_accounts_used} of {limitText(w.limits.max_trading_accounts)}
                {full ? ' · at limit' : ''}
              </span>,
              limitText(w.limits.max_members_per_account),
              String(w.members),
              w.subscription_status ? <Badge key="s" tone={subscriptionTone(w.subscription_status)}>{w.subscription_status}</Badge> : <span key="s" className="dev-muted">none</span>,
              <span key="c" title={when(w.created_at)}>
                {ago(w.created_at)}
              </span>,
              <button key="p" type="button" className="dev-btn" onClick={() => setChanging({ id: w.id, name: w.name, plan: w.plan })}>
                Change plan…
              </button>,
            ]
          })}
          empty=""
        />
      </ListState>
      <Pager data={data} page={page} onPage={setPage} />
      {changing && (
        <PlanDialog
          workspaceId={changing.id}
          workspaceName={changing.name}
          currentPlan={changing.plan}
          onClose={() => setChanging(null)}
          onDone={(message) => {
            setChanging(null)
            setFlash(message)
            reload()
          }}
        />
      )}
    </section>
  )
}

// ---- Billing ----------------------------------------------------------------------------------------------

type BillingView = 'attention' | 'subscriptions' | 'payments' | 'webhooks'

export function BillingTab() {
  const [view, setView] = useState<BillingView>('attention')
  const [overview, setOverview] = useState<AdminBillingOverview | null>(null)
  const [issues, setIssues] = useState<{ data: BillingIssues | null; error: string | null } | null>(null)
  const [recheck, setRecheck] = useState(0)
  useEffect(() => {
    let cancelled = false
    workspaceApi.adminBillingOverview().then((o) => !cancelled && setOverview(o)).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    workspaceApi
      .adminBillingIssues()
      .then((data) => !cancelled && setIssues({ data, error: null }))
      .catch((err) => !cancelled && setIssues({ data: null, error: err instanceof ApiError ? err.message : 'Could not check billing.' }))
    return () => {
      cancelled = true
    }
  }, [recheck])
  const tabLabels: Record<BillingView, string> = {
    attention: `Needs attention${issues?.data?.total ? ` (${issues.data.total})` : ''}`,
    subscriptions: 'Subscriptions',
    payments: 'Payments',
    webhooks: 'Webhooks',
  }

  return (
    <section>
      {overview && (
        <div className="adm-stats adm-stats-compact">
          <article className="adm-stat">
            <span className="dev-muted">Last webhook received</span>
            <strong>{overview.last_webhook_at ? ago(overview.last_webhook_at) : 'never'}</strong>
            <small className="dev-muted">{overview.webhooks_total} total</small>
          </article>
          <article className={`adm-stat ${overview.verification_failures_24h ? 'adm-stat-down' : ''}`}>
            <span className="dev-muted">Payment verification failures, 24h</span>
            <strong>{overview.verification_failures_24h}</strong>
          </article>
        </div>
      )}
      {overview && overview.recent_verification_failures.length > 0 && (
        <div className="adm-note adm-note-warn">
          Recent verification failures:{' '}
          {overview.recent_verification_failures.slice(0, 5).map((f, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              {ago(f.at)} (workspace {f.workspace_id?.slice(0, 8) ?? '—'}, IP {f.ip_address ?? '—'})
            </span>
          ))}
        </div>
      )}
      <nav className="dev-tabs adm-subtabs" role="tablist">
        {(['attention', 'subscriptions', 'payments', 'webhooks'] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
            {tabLabels[v]}
          </button>
        ))}
      </nav>
      {view === 'attention' && <NeedsAttention state={issues} onFixed={() => setRecheck((n) => n + 1)} />}
      {view === 'subscriptions' && <SubscriptionsList />}
      {view === 'payments' && <PaymentsList />}
      {view === 'webhooks' && <WebhooksList />}
    </section>
  )
}

function SubscriptionsList() {
  const [status, setStatus] = useState('all')
  const { data, error, loading, page, setPage } = usePaged(workspaceApi.adminSubscriptions, { status })
  return (
    <>
      <div className="dev-filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by subscription status">
          <option value="all">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="expiring">Expiring within 7 days</option>
          <option value="PENDING">Pending payment</option>
          <option value="EXPIRED">Expired</option>
          <option value="CANCELED">Canceled</option>
        </select>
      </div>
      <ListState loading={loading} error={error} empty={!data || data.items.length === 0} emptyText="No subscriptions match.">
        <SimpleTable
          head={['Workspace', 'Owner', 'Plan', 'Cycle', 'Status', 'Renews / ends', 'Razorpay order']}
          rows={(data?.items ?? []).map((s) => [
            <strong key="w">{s.workspace_name}</strong>,
            s.owner_email,
            s.plan_name,
            s.billing_cycle,
            <Badge key="s" tone={subscriptionTone(s.status)}>
              {s.status}
            </Badge>,
            <span key="e" className={s.expiring_soon ? 'adm-warn' : undefined}>
              {when(s.current_period_end)}
              {s.expiring_soon ? ' · expiring soon' : ''}
            </span>,
            <code key="o" className="adm-code">
              {s.razorpay_order_id ?? '—'}
            </code>,
          ])}
          empty=""
        />
      </ListState>
      <Pager data={data} page={page} onPage={setPage} />
    </>
  )
}

function PaymentsList() {
  const { data, error, loading, page, setPage } = usePaged(workspaceApi.adminPayments, {})
  return (
    <>
      <ListState loading={loading} error={error} empty={!data || data.items.length === 0} emptyText="No payments recorded yet.">
        <SimpleTable
          head={['Paid', 'Amount', 'Workspace', 'Owner', 'Plan', 'Status', 'Razorpay payment id', 'Refunds / disputes']}
          rows={(data?.items ?? []).map((p) => [
            when(p.created_at),
            <strong key="a">{inr(p.amount_inr)}</strong>,
            p.workspace_name,
            p.owner_email,
            `${p.plan_name ?? '—'} · ${p.billing_cycle ?? '—'}`,
            p.status,
            <code key="r" className="adm-code">
              {p.razorpay_payment_id}
            </code>,
            <RazorpayLink key="l" paymentId={p.razorpay_payment_id} label="Open in Razorpay" />,
          ])}
          empty=""
        />
      </ListState>
      <Pager data={data} page={page} onPage={setPage} />
    </>
  )
}

function WebhooksList() {
  const { data, error, loading, page, setPage } = usePaged(workspaceApi.adminWebhooks, {})
  return (
    <>
      <p className="dev-muted adm-hint">Event payloads are deliberately not shown — they can contain customer contact and payment details. Use the Razorpay dashboard for those.</p>
      <ListState loading={loading} error={error} empty={!data || data.items.length === 0} emptyText="No webhooks received yet.">
        <SimpleTable
          head={['Received', 'Event type', 'Razorpay event id']}
          rows={(data?.items ?? []).map((w) => [
            <span key="t" title={when(w.processed_at)}>
              {ago(w.processed_at)}
            </span>,
            w.event_type,
            <code key="i" className="adm-code">
              {w.razorpay_event_id}
            </code>,
          ])}
          empty=""
        />
      </ListState>
      <Pager data={data} page={page} onPage={setPage} />
    </>
  )
}

// ---- Invitations ------------------------------------------------------------------------------------------

export function InvitationsTab() {
  const [status, setStatus] = useState('all')
  const { data, error, loading, page, setPage } = usePaged(workspaceApi.adminInvitations, { status })
  const tone = (s: string): Tone => (s === 'ACCEPTED' ? 'ok' : s === 'PENDING' ? 'warn' : s === 'EXPIRED' || s === 'REVOKED' || s === 'DECLINED' ? 'idle' : 'idle')
  return (
    <section>
      <div className="dev-filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by invitation status">
          <option value="all">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="EXPIRED">Expired (never answered)</option>
          <option value="ACCEPTED">Accepted</option>
          <option value="DECLINED">Declined</option>
          <option value="REVOKED">Revoked</option>
        </select>
      </div>
      <ListState loading={loading} error={error} empty={!data || data.items.length === 0} emptyText="No invitations match.">
        <SimpleTable
          head={['Invited', 'Role', 'To', 'Account / portfolio', 'Invited by', 'Status', 'Sent', 'Expires']}
          rows={(data?.items ?? []).map((i) => [
            <strong key="e">{i.email}</strong>,
            i.role,
            i.kind,
            i.target_name,
            i.invited_by_email,
            <Badge key="s" tone={tone(i.status)}>
              {i.status}
            </Badge>,
            <span key="c" title={when(i.created_at)}>
              {ago(i.created_at)}
            </span>,
            when(i.expires_at),
          ])}
          empty=""
        />
      </ListState>
      <Pager data={data} page={page} onPage={setPage} />
    </section>
  )
}

// ---- Audit log --------------------------------------------------------------------------------------------

export function AuditTab() {
  const [action, setAction] = useState('all')
  const [userText, setUserText] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [actions, setActions] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const user = useDebounced(userText.trim())

  // Date inputs give local calendar days; the server compares UTC. `until` is the start of the day after `to`, so the whole day is included.
  const since = from ? new Date(`${from}T00:00:00`).toISOString() : ''
  const until = to ? new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString() : ''
  const filters = { action, user, since, until }
  const { data, error, loading, page, setPage } = usePaged(workspaceApi.adminAudit, filters, 50)

  useEffect(() => {
    let cancelled = false
    workspaceApi.adminAuditActions().then((r) => !cancelled && setActions(r.actions)).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  async function exportCsv(): Promise<void> {
    setExporting(true)
    setExportError(null)
    try {
      const blob = await workspaceApi.adminAuditExport(filters)
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <section>
      <div className="dev-filters">
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action">
          <option value="all">All actions</option>
          {actions.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <label className="dev-search">
          <Search size={14} />
          <input value={userText} onChange={(e) => setUserText(e.target.value)} placeholder="Actor email or user id…" aria-label="Filter by user" />
        </label>
        <label className="adm-date">
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="adm-date">
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" className="dev-btn" onClick={() => void exportCsv()} disabled={exporting}>
          <Download size={14} /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>
      {exportError && <div className="dev-alert">{exportError}</div>}
      <ListState loading={loading} error={error} empty={!data || data.items.length === 0} emptyText="No audit events match these filters.">
        <SimpleTable
          head={['When', 'Event', 'Actor', 'IP', 'Details']}
          rows={(data?.items ?? []).map((a) => [
            <span key="w" title={when(a.created_at)}>
              {ago(a.created_at)}
            </span>,
            <strong key="e">{a.action}</strong>,
            a.actor_email ?? <span key="x" className="dev-muted">{a.actor_user_id ? a.actor_user_id.slice(0, 8) : 'unknown / signed out'}</span>,
            a.ip_address ?? '—',
            <Metadata key="m" value={a.metadata} />,
          ])}
          empty=""
        />
      </ListState>
      <Pager data={data} page={page} onPage={setPage} />
      <p className="dev-muted adm-hint">Exports include at most 5,000 rows and are themselves recorded in this log.</p>
    </section>
  )
}
