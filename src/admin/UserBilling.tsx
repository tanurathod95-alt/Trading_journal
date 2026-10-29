import { useEffect, useState } from 'react'
import { ApiError, workspaceApi, type AdminUserDetail, type BillingIssues } from '../workspace/api'
import { NeedsAttention, PlanDialog } from './BillingFixes'
import { Badge } from './shared'
import { inr, limitText, subscriptionTone, when } from './helpers'
import { SimpleTable } from './UsersTab'

type Workspace = AdminUserDetail['workspaces'][number]

/**
 * Everything about one customer's billing in one place: each workspace's plan and subscription, the plan change,
 * their payments, and any billing problems found for them with the fix that applies. The same actions exist in the
 * Billing tab for platform-wide work; here they're scoped to this customer so support never has to switch screens.
 */
export function UserBilling({ d, onChanged }: { d: AdminUserDetail; onChanged: () => void }) {
  const [issues, setIssues] = useState<{ data: BillingIssues | null; error: string | null } | null>(null)
  const [recheck, setRecheck] = useState(0)
  const [plan, setPlan] = useState<Workspace | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const userId = d.profile.id

  useEffect(() => {
    let cancelled = false
    workspaceApi
      .adminBillingIssues(userId)
      .then((data) => !cancelled && setIssues({ data, error: null }))
      .catch((err) => !cancelled && setIssues({ data: null, error: err instanceof ApiError ? err.message : 'Could not check this customer’s billing.' }))
    return () => {
      cancelled = true
    }
  }, [userId, recheck])

  const changed = (): void => {
    setRecheck((n) => n + 1)
    onChanged()
  }
  const problems = issues?.data?.items.length ?? 0

  return (
    <div className="adm-billing">
      {flash && (
        <div className="adm-flash" role="status">
          {flash}
        </div>
      )}

      {d.workspaces.length === 0 && <p className="dev-empty">No workspaces.</p>}
      {d.workspaces.map((w) => {
        const subs = d.subscriptions.filter((s) => s.workspace_id === w.id)
        return (
          <article key={w.id} className="adm-ws">
            <div className="adm-ws-head">
              <div>
                <strong>{w.name}</strong>
                <span className="dev-muted"> · their role: {w.role}</span>
              </div>
              <div className="adm-ws-actions">
                <Badge tone={w.plan === 'FREE' ? 'idle' : 'ok'}>{w.plan}</Badge>
                <button type="button" className="dev-btn" onClick={() => setPlan(w)}>
                  Change plan…
                </button>
              </div>
            </div>
            <p className="dev-muted adm-ws-meta">
              Accounts used {w.trading_accounts_used} of {limitText(w.limits.max_trading_accounts)} · seats per account {limitText(w.limits.max_members_per_account)}
            </p>
            <SimpleTable
              head={['Subscription', 'Cycle', 'Status', 'Renews / ends']}
              rows={subs.map((s) => [s.plan_name, s.billing_cycle, <Badge key="s" tone={subscriptionTone(s.status)}>{s.status}</Badge>, when(s.current_period_end)])}
              empty="No subscription — on the free plan."
            />
          </article>
        )
      })}

      <h4 className="adm-subhead">Billing problems{problems > 0 ? ` (${problems})` : ''}</h4>
      {issues?.error && <div className="dev-alert">{issues.error}</div>}
      {issues && !issues.error && problems === 0 ? <p className="dev-muted">No billing problems found for this customer.</p> : null}
      {problems > 0 && <NeedsAttention state={issues} onFixed={changed} />}

      <h4 className="adm-subhead">Payments</h4>
      <SimpleTable
        head={['Paid', 'Amount', 'Plan', 'Status', 'Razorpay payment id']}
        rows={d.payments.map((x) => [
          when(x.created_at),
          inr(x.amount_inr),
          `${x.plan_name ?? '—'} · ${x.billing_cycle ?? '—'}`,
          x.status,
          <code key="c" className="adm-code">
            {x.razorpay_payment_id}
          </code>,
        ])}
        empty="No payments yet."
      />

      {plan && (
        <PlanDialog
          workspaceId={plan.id}
          workspaceName={plan.name}
          currentPlan={plan.plan}
          onClose={() => setPlan(null)}
          onDone={(message) => {
            setFlash(message)
            setPlan(null)
            changed()
          }}
        />
      )}
    </div>
  )
}
