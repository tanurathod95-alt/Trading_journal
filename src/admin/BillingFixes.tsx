import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { workspaceApi, type BillingIssue, type BillingIssues } from '../workspace/api'
import { ActionDialog } from './Dialogs'
import { Badge, ListState } from './shared'
import { ago, inr, when, type Tone } from './helpers'

const PLANS = ['FREE', 'PRO', 'PREMIUM', 'BUSINESS'] as const
const CYCLES = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const

function razorpayPaymentUrl(paymentId: string): string {
  return `https://dashboard.razorpay.com/app/payments/${encodeURIComponent(paymentId)}`
}

export function RazorpayLink({ paymentId, label = 'Open in Razorpay' }: { paymentId: string; label?: string }) {
  return (
    <a className="dev-btn" href={razorpayPaymentUrl(paymentId)} target="_blank" rel="noopener noreferrer">
      <ExternalLink size={13} /> {label}
    </a>
  )
}

/** Put a workspace on a plan by hand: fix a wrong purchase, a comp/extension, or end a plan. Needs a reason and the staff member's password. */
export function PlanDialog({
  workspaceId,
  workspaceName,
  currentPlan,
  suggestedPlan,
  onClose,
  onDone,
}: {
  workspaceId: string
  workspaceName: string
  currentPlan: string
  suggestedPlan?: string
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [plan, setPlan] = useState<(typeof PLANS)[number]>((PLANS as readonly string[]).includes(suggestedPlan ?? '') ? (suggestedPlan as (typeof PLANS)[number]) : (PLANS as readonly string[]).includes(currentPlan) ? (currentPlan as (typeof PLANS)[number]) : 'PRO')
  const [cycle, setCycle] = useState<(typeof CYCLES)[number]>('MONTHLY')
  const [days, setDays] = useState('')
  const paid = plan !== 'FREE'
  const daysNumber = days.trim() === '' ? undefined : Number(days)
  const daysInvalid = daysNumber !== undefined && (!Number.isInteger(daysNumber) || daysNumber < 1 || daysNumber > 730)

  return (
    <ActionDialog
      title={`Change plan for ${workspaceName}`}
      intro={
        <>
          Currently on <strong>{currentPlan}</strong>. This changes which plan the workspace is on and its subscription record. It does <strong>not</strong> move any money — refunds are done in the Razorpay dashboard.
        </>
      }
      confirmLabel={plan === 'FREE' ? 'End paid plan' : 'Change plan'}
      danger={plan === 'FREE'}
      onClose={onClose}
      fields={
        <>
          <label className="adm-field">
            New plan
            <select value={plan} onChange={(e) => setPlan(e.target.value as (typeof PLANS)[number])} aria-label="New plan">
              {PLANS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          {paid && (
            <div className="adm-fieldrow">
              <label className="adm-field">
                Billing cycle
                <select value={cycle} onChange={(e) => setCycle(e.target.value as (typeof CYCLES)[number])} aria-label="Billing cycle">
                  {CYCLES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="adm-field">
                Lasts for (days, optional)
                <input value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" placeholder="normal length" aria-label="Days the plan lasts" />
              </label>
            </div>
          )}
          {daysInvalid && <div className="dev-alert">Days must be a whole number from 1 to 730.</div>}
        </>
      }
      onSubmit={async (reason, password) => {
        if (daysInvalid) throw new Error('Days must be a whole number from 1 to 730.')
        const result = await workspaceApi.adminPlanOverride(workspaceId, { plan, ...(paid ? { billing_cycle: cycle, period_days: daysNumber } : {}) }, reason, password)
        onDone(`${workspaceName} is now on ${result.plan}.`)
      }}
    />
  )
}

const TONE: Record<BillingIssue['severity'], Tone> = { high: 'down', medium: 'warn', low: 'idle' }

/** Billing records that look wrong, worst first, each with the fix that applies to it. */
export function NeedsAttention({ state, onFixed }: { state: { data: BillingIssues | null; error: string | null } | null; onFixed: () => void }) {
  const [plan, setPlan] = useState<BillingIssue | null>(null)
  const [record, setRecord] = useState<BillingIssue | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  if (!state) return <p className="dev-empty">Checking billing…</p>
  const data = state.data
  const finished = (message: string) => {
    setFlash(message)
    setPlan(null)
    setRecord(null)
    onFixed()
  }

  return (
    <>
      {flash && (
        <div className="adm-flash" role="status">
          {flash}
        </div>
      )}
      <p className="dev-muted adm-hint">
        Nothing here is changed automatically. Refunds and disputes are handled in the Razorpay dashboard; the buttons below only correct our own records.
        {data && data.unreadable_webhooks > 0 && ` ${data.unreadable_webhooks} stored payment notice(s) were too long to read and were skipped.`}
      </p>
      <ListState loading={false} error={state.error} empty={!data || data.items.length === 0} emptyText="All clear — no billing problems found.">
        <ul className="adm-issues">
          {(data?.items ?? []).map((issue, i) => (
            <li key={`${issue.kind}-${issue.payment_id ?? issue.workspace_id}-${i}`} className={`adm-issue adm-issue-${issue.severity}`}>
              <div className="adm-issue-head">
                <Badge tone={TONE[issue.severity]}>{issue.severity.toUpperCase()}</Badge>
                <strong>{issue.title}</strong>
                {issue.workspace_name && (
                  <span className="dev-muted">
                    {issue.workspace_name} · {issue.owner_email}
                  </span>
                )}
              </div>
              <p>{issue.detail}</p>
              {(issue.when || issue.amount_inr !== undefined) && (
                <p className="dev-muted">
                  {issue.amount_inr !== undefined && <>{inr(issue.amount_inr)} </>}
                  {issue.when && <span title={when(issue.when)}>· {ago(issue.when)}</span>}
                </p>
              )}
              <div className="adm-actions">
                {issue.payment_id && <RazorpayLink paymentId={issue.payment_id} />}
                {issue.kind === 'unrecorded_payment' && issue.can_reconcile && (
                  <button type="button" className="dev-btn dev-btn-primary" onClick={() => setRecord(issue)}>
                    Record this payment
                  </button>
                )}
                {issue.workspace_id && ['plan_without_payment', 'plan_mismatch', 'period_ended'].includes(issue.kind) && (
                  <button type="button" className="dev-btn" onClick={() => setPlan(issue)}>
                    Change plan…
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </ListState>

      {plan?.workspace_id && (
        <PlanDialog
          workspaceId={plan.workspace_id}
          workspaceName={plan.workspace_name ?? 'this workspace'}
          currentPlan={plan.current_plan ?? 'FREE'}
          suggestedPlan={plan.kind === 'plan_mismatch' ? plan.subscription_plan : plan.kind === 'plan_without_payment' ? 'FREE' : undefined}
          onClose={() => setPlan(null)}
          onDone={finished}
        />
      )}
      {record?.payment_id && (
        <ActionDialog
          title="Record this payment"
          intro={
            <>
              Razorpay captured <strong>{inr(record.amount_inr ?? 0)}</strong> ({record.payment_id}) for <strong>{record.workspace_name}</strong>. This activates the <strong>{record.plan_name}</strong>{' '}
              {record.billing_cycle?.toLowerCase()} plan and saves the payment, using only what Razorpay told us. Confirm the payment in Razorpay first.
            </>
          }
          confirmLabel="Record payment and activate plan"
          onClose={() => setRecord(null)}
          onSubmit={async (reason, password) => {
            const result = await workspaceApi.adminReconcilePayment(record.payment_id as string, reason, password)
            finished(`Recorded. ${record.workspace_name} is now on ${result.plan} (${result.billing_cycle.toLowerCase()}).`)
          }}
        />
      )}
    </>
  )
}
