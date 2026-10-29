import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, ArrowLeft, CreditCard, FileClock, LayoutDashboard, Layers, Mail, ShieldAlert, ShieldCheck, Users } from 'lucide-react'
import { ConsoleShell, type ConsoleItem, type ConsoleLink } from '../console/ConsoleShell'
import { useWorkspaceAuth } from '../workspace/WorkspaceAuthContext'
import { AuditTab, BillingTab, InvitationsTab, OverviewTab, WorkspacesTab } from './OtherTabs'
import { UsersTab } from './UsersTab'
import '../developer/developer.css'
import './admin.css'

type Tab = 'overview' | 'users' | 'workspaces' | 'billing' | 'invitations' | 'audit'

const ITEMS: Array<ConsoleItem & { key: Tab; about: string }> = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard, about: 'Live counts across users, plans, billing and security.' },
  { key: 'users', label: 'Users', icon: Users, about: 'Find a customer and see their workspaces, accounts, payments and activity.' },
  { key: 'workspaces', label: 'Workspaces & plans', icon: Layers, about: 'Every workspace with its plan and how much of the plan limit it uses.' },
  { key: 'billing', label: 'Billing', icon: CreditCard, about: 'Subscriptions, payments and Razorpay webhook health.' },
  { key: 'invitations', label: 'Invitations', icon: Mail, about: 'Account and portfolio invitations across the whole platform.' },
  { key: 'audit', label: 'Audit log', icon: FileClock, about: 'Who did what and when. Filter it, or export it as CSV.' },
]

/** Admin console. The role check here only decides what to show — every /api/admin call is checked again on the server. */
export function AdminPanel() {
  const { me } = useWorkspaceAuth()
  const role = me?.user.platform_role
  if (role !== 'ADMIN' && role !== 'DEVELOPER') {
    return (
      <div className="dev-denied">
        <ShieldAlert size={28} />
        <h2>Admin access only</h2>
        <p>This area is limited to platform staff. Your account doesn&apos;t have that role.</p>
        <Link to="/app" className="dev-btn">
          <ArrowLeft size={15} /> Back to the app
        </Link>
      </div>
    )
  }
  return <AdminConsole role={role} />
}

function AdminConsole({ role }: { role: 'ADMIN' | 'DEVELOPER' }) {
  const [tab, setTab] = useState<Tab>('overview')
  const current = ITEMS.find((i) => i.key === tab) ?? ITEMS[0]
  const goTo: ConsoleLink[] = [
    ...(role === 'DEVELOPER' ? [{ label: 'Developer console', to: '/app/dev', icon: Activity }] : []),
    { label: 'Back to app', to: '/app', icon: ArrowLeft },
  ]

  return (
    <ConsoleShell
      title="Admin console"
      subtitle="Customers, plans and billing"
      icon={ShieldCheck}
      roleLabel={role}
      items={ITEMS}
      active={tab}
      onSelect={(key) => setTab(key as Tab)}
      goTo={goTo}
      pageTitle={current.label}
      pageSubtitle={current.about}
      status={<span className="dev-badge dev-badge-idle">Actions ask for your password</span>}
    >
      {tab === 'overview' && <OverviewTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'workspaces' && <WorkspacesTab />}
      {tab === 'billing' && <BillingTab />}
      {tab === 'invitations' && <InvitationsTab />}
      {tab === 'audit' && <AuditTab />}
    </ConsoleShell>
  )
}
