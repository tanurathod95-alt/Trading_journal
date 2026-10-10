import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import JSZip from 'jszip'
import { BarChart3, Building2, Calendar, Check, Crown, Download, Eye, FileArchive, Leaf, Receipt, Settings, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiError, workspaceApi, type BillingStatusApi, type PaymentApi, type PlanPricingApi } from './api'
import { useWorkspaceAuth } from './WorkspaceAuthContext'

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void }
  }
}

let razorpayScriptPromise: Promise<void> | null = null

function loadRazorpayScript(): Promise<void> {
  if (window.Razorpay) {
    return Promise.resolve()
  }
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Could not load Razorpay checkout script'))
      document.head.appendChild(script)
    })
  }
  return razorpayScriptPromise
}

const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN')}`

const invoiceNumber = (payment: PaymentApi): string => `INV-${payment.id.slice(0, 8).toUpperCase()}`

const planLabel = (planName: string | null): string => (planName ? planName.charAt(0) + planName.slice(1).toLowerCase() : '—')

const cycleLabel = (cycle: string | null): string => (cycle ? cycle.charAt(0) + cycle.slice(1).toLowerCase() : '—')

/**
 * Builds the invoice PDF entirely client-side from data the backend already
 * verified (real Payment row) — same jsPDF + autoTable pattern already used
 * for the journal export in src/App.tsx. No fabricated tax breakdown: the
 * backend/Razorpay integration doesn't give us one, so the invoice states
 * the total amount only.
 */
function buildInvoicePdf(payment: PaymentApi, workspaceName: string, userName: string, userEmail: string): jsPDF {
  const doc = new jsPDF()
  doc.setFontSize(16)
  doc.text('TRADING JOURNAL', 14, 18)
  doc.setFontSize(10)
  doc.text('Invoice (test mode — no real payment)', 14, 25)

  doc.setFontSize(10)
  doc.text(`Invoice #: ${invoiceNumber(payment)}`, 14, 38)
  doc.text(`Date: ${new Date(payment.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`, 14, 44)
  doc.text(`Billed to: ${userName} (${userEmail})`, 14, 50)
  doc.text(`Workspace: ${workspaceName}`, 14, 56)

  autoTable(doc, {
    startY: 66,
    head: [['Plan', 'Billing Period', 'Transaction Ref', 'Amount (taxes as applicable)']],
    body: [[planLabel(payment.plan_name), cycleLabel(payment.billing_cycle), payment.razorpay_payment_id, rupees(payment.amount_paise)]],
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [37, 99, 235], textColor: 255 },
    theme: 'grid',
  })

  return doc
}

function downloadBlob(blob: Blob, filename: string): void {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

const PLAN_META: Record<string, { icon: typeof Leaf; iconClass: string; tagline: string; extraFeatures: string[] }> = {
  FREE: { icon: Leaf, iconClass: 'ws-plan-icon-free', tagline: 'Perfect for getting started.', extraFeatures: ['Basic analytics'] },
  PRO: { icon: Crown, iconClass: 'ws-plan-icon-pro', tagline: 'For active traders & growing teams.', extraFeatures: ['Advanced analytics', 'Priority support'] },
  PREMIUM: { icon: Crown, iconClass: 'ws-plan-icon-premium', tagline: 'For serious traders & professionals.', extraFeatures: ['Full analytics & reports', 'Priority support', 'Team collaboration'] },
  BUSINESS: { icon: Building2, iconClass: 'ws-plan-icon-business', tagline: 'For firms and large trading desks.', extraFeatures: ['Full analytics & reports', 'Dedicated support', 'Team collaboration'] },
}

/**
 * Billing page (Phase 10.3) — TEST MODE Razorpay only. The backend never
 * trusts anything this page reports about payment success: /checkout
 * creates a real Razorpay test-mode order, and /verify recomputes the
 * signature server-side before ever touching the workspace's plan.
 */
export function BillingPage({ onClose, inline = false }: { onClose: () => void; inline?: boolean }) {
  const { currentWorkspace, me } = useWorkspaceAuth()
  const [plans, setPlans] = useState<PlanPricingApi[] | null>(null)
  const [status, setStatus] = useState<BillingStatusApi | null>(null)
  const [payments, setPayments] = useState<PaymentApi[] | null>(null)
  const [cycle, setCycle] = useState<'MONTHLY' | 'QUARTERLY' | 'YEARLY'>('MONTHLY')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busyPlan, setBusyPlan] = useState<string | null>(null)
  const [zipBusy, setZipBusy] = useState(false)

  const isOwner = currentWorkspace?.role === 'OWNER'

  async function load(): Promise<void> {
    if (!currentWorkspace) return
    setError(null)
    try {
      const [planList, billingStatus, paymentList] = await Promise.all([
        workspaceApi.listPlanPricing(),
        workspaceApi.getBillingStatus(currentWorkspace.id),
        workspaceApi.listBillingHistory(currentWorkspace.id),
      ])
      setPlans(planList)
      setStatus(billingStatus)
      setPayments(paymentList)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load billing information.')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id])

  async function handleUpgrade(planName: string): Promise<void> {
    if (!currentWorkspace || !me) return
    setError(null)
    setMessage(null)
    setBusyPlan(planName)
    try {
      await loadRazorpayScript()
      const checkout = await workspaceApi.createCheckout(currentWorkspace.id, planName, cycle)

      if (!window.Razorpay) {
        throw new Error('Razorpay checkout is unavailable right now.')
      }

      const razorpay = new window.Razorpay({
        key: checkout.key_id,
        order_id: checkout.order_id,
        amount: checkout.amount_paise,
        currency: checkout.currency,
        name: 'Trading Journal',
        description: `${planName} — ${cycle.toLowerCase()}`,
        prefill: { email: me.user.email, name: me.user.display_name },
        theme: { color: '#2563eb' },
        handler: (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          void (async () => {
            try {
              const updated = await workspaceApi.verifyPayment(
                currentWorkspace.id,
                response.razorpay_order_id,
                response.razorpay_payment_id,
                response.razorpay_signature,
              )
              setStatus(updated)
              setMessage(`Upgraded to ${updated.plan}.`)
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'Payment verification failed.')
            } finally {
              setBusyPlan(null)
            }
          })()
        },
        modal: { ondismiss: () => setBusyPlan(null) },
      })
      razorpay.open()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not start checkout.')
      setBusyPlan(null)
    }
  }

  function handleViewInvoice(payment: PaymentApi): void {
    if (!currentWorkspace || !me) return
    const doc = buildInvoicePdf(payment, currentWorkspace.name, me.user.display_name, me.user.email)
    window.open(doc.output('bloburl'), '_blank')
  }

  function handleDownloadInvoice(payment: PaymentApi): void {
    if (!currentWorkspace || !me) return
    const doc = buildInvoicePdf(payment, currentWorkspace.name, me.user.display_name, me.user.email)
    doc.save(`${invoiceNumber(payment)}.pdf`)
  }

  async function handleDownloadAllInvoices(): Promise<void> {
    if (!currentWorkspace || !me || !payments || payments.length === 0) return
    setZipBusy(true)
    try {
      const zip = new JSZip()
      for (const payment of payments) {
        const doc = buildInvoicePdf(payment, currentWorkspace.name, me.user.display_name, me.user.email)
        zip.file(`${invoiceNumber(payment)}.pdf`, doc.output('blob'))
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, `${currentWorkspace.name.replace(/\s+/g, '_')}_invoices.zip`)
    } finally {
      setZipBusy(false)
    }
  }

  const maxAccounts = plans?.find((p) => p.name === status?.plan)?.max_trading_accounts ?? status?.max_trading_accounts ?? null
  const maxMembers = plans?.find((p) => p.name === status?.plan)?.max_members_per_account ?? null

  const body = (
    <div className={inline ? 'ws-billing-page' : 'ws-modal-card'} onClick={(e) => e.stopPropagation()}>
        <div className="ws-modal-header ws-billing-header">
          <span className="ws-billing-header-icon">
            <Receipt size={18} />
          </span>
          <div className="ws-billing-header-text">
            <h2>Billing</h2>
            <p className="ws-muted small">Manage your subscription, view usage and billing history.</p>
          </div>
          {!inline && <button type="button" className="ws-close-btn" onClick={onClose}>×</button>}
        </div>

        {error && <p className="ws-error">{error}</p>}
        {message && <p className="ws-muted small">{message}</p>}

        {status && (
          <div className="ws-billing-summary">
            <div className="ws-billing-summary-plan">
              <span className="ws-billing-crown"><Crown size={20} /></span>
              <div>
                <p className="ws-billing-summary-label">Current Plan</p>
                <div className="ws-billing-summary-plan-row">
                  <strong className="ws-billing-plan-name">{status.plan.charAt(0) + status.plan.slice(1).toLowerCase()}</strong>
                  {status.subscription_status && (
                    <span className={`ws-billing-status-pill ${status.subscription_status === 'ACTIVE' ? 'active' : ''}`}>
                      {status.subscription_status.charAt(0) + status.subscription_status.slice(1).toLowerCase()}
                    </span>
                  )}
                </div>
                {status.current_period_end && (
                  <p className="ws-billing-summary-sub">
                    <Calendar size={13} /> Renews on {new Date(status.current_period_end).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </p>
                )}
              </div>
            </div>

            <div className="ws-billing-divider" />

            <div className="ws-billing-summary-stat">
              <span className="ws-billing-stat-icon"><BarChart3 size={16} /></span>
              <div>
                <p className="ws-billing-summary-label">Trading Accounts Used</p>
                <strong>{status.trading_accounts_used} / {maxAccounts ?? '∞'}</strong>
              </div>
            </div>

            <div className="ws-billing-divider" />

            <div className="ws-billing-summary-stat">
              <span className="ws-billing-stat-icon"><Users size={16} /></span>
              <div>
                <p className="ws-billing-summary-label">People per Account</p>
                <strong>Up to {maxMembers ?? '∞'}</strong>
              </div>
            </div>

            <button type="button" className="ws-secondary-btn ws-billing-manage-btn" onClick={() => document.getElementById('ws-billing-plans')?.scrollIntoView({ behavior: 'smooth' })}>
              <Settings size={15} /> Manage Plan
            </button>
          </div>
        )}

        <div id="ws-billing-plans" className="ws-billing-plans-header">
          <div>
            <h3 className="ws-billing-plans-title">Choose your plan</h3>
            <p className="ws-muted small">Upgrade or downgrade your plan anytime — changes apply instantly.</p>
          </div>
          <div className="ws-invite-row">
            {(['MONTHLY', 'QUARTERLY', 'YEARLY'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={c === cycle ? 'ws-primary-btn' : 'ws-secondary-btn'}
                onClick={() => setCycle(c)}
              >
                {c.charAt(0) + c.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        {plans && (
          <div className="ws-plan-grid" style={{ marginTop: 12 }}>
            {plans.map((plan) => {
              const price = cycle === 'MONTHLY' ? plan.price_monthly_paise : cycle === 'QUARTERLY' ? plan.price_quarterly_paise : plan.price_yearly_paise
              const isCurrent = status?.plan === plan.name
              const meta = PLAN_META[plan.name] ?? PLAN_META.FREE
              const Icon = meta.icon
              const displayName = plan.name.charAt(0) + plan.name.slice(1).toLowerCase()
              const features = [
                plan.max_trading_accounts !== null ? `${plan.max_trading_accounts} trading accounts` : 'Unlimited trading accounts',
                plan.max_members_per_account !== null ? `${plan.max_members_per_account} people per account` : 'Unlimited people per account',
                ...meta.extraFeatures,
              ]
              return (
                <div key={plan.name} className={`ws-plan-card ${isCurrent ? 'current' : ''}`}>
                  {isCurrent && <span className="ws-plan-current-badge">Current Plan</span>}
                  <div className="ws-plan-card-head">
                    <span className={`ws-plan-icon ${meta.iconClass}`}>
                      <Icon size={18} />
                    </span>
                    <div>
                      <strong className="ws-plan-name">{displayName}</strong>
                      <p className="ws-muted small">{meta.tagline}</p>
                    </div>
                  </div>

                  <p className="ws-plan-price">
                    {plan.price_monthly_paise === 0 ? '₹0' : rupees(price)}
                    <span className="ws-muted small"> / {cycle.toLowerCase()}</span>
                  </p>

                  <ul className="ws-plan-features">
                    {features.map((f) => (
                      <li key={f}>
                        <Check size={15} /> {f}
                      </li>
                    ))}
                  </ul>

                  {isCurrent ? (
                    <p className="ws-muted small ws-plan-note">This is your current plan.</p>
                  ) : plan.name === 'FREE' ? (
                    <p className="ws-muted small ws-plan-note">Default plan — included automatically.</p>
                  ) : isOwner ? (
                    <button
                      type="button"
                      className="ws-primary-btn ws-plan-btn"
                      disabled={busyPlan === plan.name}
                      onClick={() => void handleUpgrade(plan.name)}
                    >
                      {busyPlan === plan.name ? 'Opening…' : `Upgrade to ${displayName}`}
                    </button>
                  ) : (
                    <p className="ws-muted small" style={{ textAlign: 'center' }}>Only the workspace owner can upgrade</p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <p className="ws-muted small" style={{ marginTop: 12 }}>
          Test mode only — no real money is charged. Downgrading never deletes any trading accounts or data.
        </p>

        <div className="ws-billing-history-header">
          <div>
            <h3 className="ws-billing-plans-title">Billing History</h3>
            <p className="ws-muted small">Your past invoices and payments.</p>
          </div>
          {payments && payments.length > 0 && (
            <button type="button" className="ws-secondary-btn" disabled={zipBusy} onClick={() => void handleDownloadAllInvoices()}>
              <FileArchive size={15} /> {zipBusy ? 'Preparing…' : 'Download Invoices'}
            </button>
          )}
        </div>

        {payments === null ? null : payments.length === 0 ? (
          <div className="ws-billing-history-empty">
            <Receipt size={28} />
            <p><strong>No billing history yet.</strong></p>
            <p className="ws-muted small">Your invoices will appear here when you make your first purchase.</p>
          </div>
        ) : (
          <>
            <div className="ws-billing-history-table-wrap">
              <table className="ws-billing-history-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Plan</th>
                    <th>Billing Period</th>
                    <th>Amount</th>
                    <th>Payment Status</th>
                    <th>Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td>{new Date(p.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                      <td>{planLabel(p.plan_name)}</td>
                      <td>{cycleLabel(p.billing_cycle)}</td>
                      <td>{rupees(p.amount_paise)}</td>
                      <td><span className="ws-billing-status-pill active">Paid</span></td>
                      <td>
                        <div className="ws-billing-invoice-actions">
                          <button type="button" className="ws-secondary-btn" onClick={() => handleViewInvoice(p)}>
                            <Eye size={14} /> View
                          </button>
                          <button type="button" className="ws-icon-btn" aria-label="Download invoice" onClick={() => handleDownloadInvoice(p)}>
                            <Download size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="ws-billing-history-cards">
              {payments.map((p) => (
                <div key={p.id} className="ws-billing-history-card">
                  <div className="ws-billing-history-card-top">
                    <strong>{planLabel(p.plan_name)}</strong>
                    <span className="ws-billing-status-pill active">Paid</span>
                  </div>
                  <p className="ws-muted small">{new Date(p.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · {cycleLabel(p.billing_cycle)}</p>
                  <p className="ws-plan-price" style={{ fontSize: '1.1rem' }}>{rupees(p.amount_paise)}</p>
                  <div className="ws-billing-invoice-actions">
                    <button type="button" className="ws-secondary-btn" onClick={() => handleViewInvoice(p)}>
                      <Eye size={14} /> View Invoice
                    </button>
                    <button type="button" className="ws-icon-btn" aria-label="Download invoice" onClick={() => handleDownloadInvoice(p)}>
                      <Download size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
    </div>
  )

  if (inline) {
    return body
  }

  return (
    <div className="ws-modal-backdrop" onClick={onClose}>
      {body}
    </div>
  )
}
