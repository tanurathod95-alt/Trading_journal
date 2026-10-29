import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Activity, AlertTriangle, ArrowLeft, Bug, CheckCircle2, Code2, FlaskConical, Loader2, Play, RefreshCw, Search, Settings2, ShieldAlert, ShieldCheck, Users, XCircle } from 'lucide-react'
import {
  ApiError,
  workspaceApi,
  type ConfigCheck,
  type DevError,
  type DevHealth,
  type FunctionStat,
  type HealthStatus,
  type HealthTile,
  type SelfTestRun,
} from '../workspace/api'
import { ConsoleShell, type ConsoleItem } from '../console/ConsoleShell'
import { useWorkspaceAuth } from '../workspace/WorkspaceAuthContext'
import './developer.css'

type Tab = 'health' | 'functions' | 'selftests' | 'errors' | 'config'

const STATUS_LABEL: Record<HealthStatus, string> = { ok: 'Healthy', warn: 'Degraded', down: 'Failing', idle: 'No data yet' }
const POLL_MS = 5000

function ago(iso: string | null): string {
  if (!iso) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${seconds % 60}s`
}

function formatMetric(value: string | number | boolean | null): string {
  if (value === null) return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  return String(value)
}

function StatusBadge({ status }: { status: HealthStatus }) {
  return (
    <span className={`dev-badge dev-badge-${status}`}>
      <span className="dev-dot" />
      {STATUS_LABEL[status]}
    </span>
  )
}

export function DeveloperPanel() {
  const { me } = useWorkspaceAuth()
  if (me?.user.platform_role !== 'DEVELOPER') {
    return (
      <div className="dev-denied">
        <ShieldAlert size={28} />
        <h2>Developer access only</h2>
        <p>This area is limited to platform developers. Your account doesn&apos;t have that role.</p>
        <Link to="/app" className="dev-btn">
          <ArrowLeft size={15} /> Back to the app
        </Link>
      </div>
    )
  }
  return <DeveloperConsole />
}

function DeveloperConsole() {
  const [tab, setTab] = useState<Tab>('health')
  const [health, setHealth] = useState<DevHealth | null>(null)
  const [functions, setFunctions] = useState<FunctionStat[]>([])
  const [errors, setErrors] = useState<DevError[]>([])
  const [selfTests, setSelfTests] = useState<SelfTestRun | null>(null)
  const [running, setRunning] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const [loading, setLoading] = useState(true)
  const [, setTick] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const [h, f, e] = await Promise.all([workspaceApi.devHealth(), workspaceApi.devFunctions(), workspaceApi.devErrors()])
      setHealth(h)
      setFunctions(f.functions)
      setErrors(e.errors)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load health data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void workspaceApi.devLastSelfTests().then((r) => setSelfTests(r.last_run)).catch(() => {})
  }, [refresh])

  useEffect(() => {
    if (!auto) return
    const id = window.setInterval(() => {
      void refresh()
      setTick((t) => t + 1)
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [auto, refresh])

  async function runSelfTests(): Promise<void> {
    setRunning(true)
    try {
      setSelfTests(await workspaceApi.devRunSelfTests())
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Self-tests could not run.')
    } finally {
      setRunning(false)
    }
  }

  const uptimeValue = health?.tiles.find((t) => t.key === 'api')?.metrics.uptime_seconds
  const uptime = typeof uptimeValue === 'number' ? uptimeValue : null
  const faulty = functions.filter((f) => f.status === 'down' || f.status === 'warn')
  const items: Array<ConsoleItem & { key: Tab; about: ReactNode }> = [
    { key: 'health', label: 'System health', icon: Activity, about: <>Live health of the backend and its connections.{uptime !== null && <> Server up for {duration(uptime)} — stats reset on restart.</>}</> },
    { key: 'functions', label: 'Functions', icon: Code2, badge: faulty.length || undefined, about: 'Every tracked function, API route and broker call, with timings and errors.' },
    { key: 'selftests', label: 'Self-tests', icon: FlaskConical, badge: selfTests?.failed || undefined, about: 'Known-answer checks on the security- and money-critical logic.' },
    { key: 'errors', label: 'Errors', icon: Bug, badge: errors.length || undefined, about: 'Recent server errors, with secrets removed.' },
    { key: 'config', label: 'Config checks', icon: Settings2, about: 'What is and is not ready for production.' },
  ]
  const current = items.find((i) => i.key === tab) ?? items[0]
  const overall = health?.overall

  return (
    <ConsoleShell
      title="Developer console"
      subtitle="Health and fault tracking"
      icon={ShieldCheck}
      roleLabel="DEVELOPER"
      items={items}
      active={tab}
      onSelect={(key) => setTab(key as Tab)}
      goTo={[
        { label: 'Admin console', to: '/app/admin', icon: Users },
        { label: 'Back to app', to: '/app', icon: ArrowLeft },
      ]}
      pageTitle={current.label}
      pageSubtitle={current.about}
      status={
        overall ? (
          <span className={`dev-overall dev-overall-${overall}`}>
            <span className="dev-dot" />
            {overall === 'ok' ? 'All systems normal' : overall === 'warn' ? 'Some systems degraded' : 'Systems failing'}
          </span>
        ) : undefined
      }
      actions={
        <>
          <label className="dev-toggle">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Auto-refresh (5s)
          </label>
          <button type="button" className="dev-btn" onClick={() => void refresh()}>
            <RefreshCw size={14} /> Refresh
          </button>
        </>
      }
    >
      {loadError && (
        <div className="dev-alert">
          <AlertTriangle size={16} /> {loadError}
        </div>
      )}

      {loading && !health ? (
        <div className="dev-loading">
          <Loader2 size={22} className="ws-spin" /> Loading health data…
        </div>
      ) : (
        <>
          {tab === 'health' && health && <HealthTab health={health} />}
          {tab === 'functions' && <FunctionsTab functions={functions} />}
          {tab === 'selftests' && <SelfTestsTab run={selfTests} running={running} onRun={() => void runSelfTests()} />}
          {tab === 'errors' && <ErrorsTab errors={errors} />}
          {tab === 'config' && health && <ConfigTab checks={health.config_checks} />}
        </>
      )}
    </ConsoleShell>
  )
}

function HealthTab({ health }: { health: DevHealth }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="dev-tiles">
      {health.tiles.map((tile: HealthTile) => (
        <article key={tile.key} className={`dev-tile dev-tile-${tile.status}`}>
          <div className="dev-tile-head">
            <h3>{tile.label}</h3>
            <StatusBadge status={tile.status} />
          </div>
          <p className="dev-tile-summary">{tile.summary}</p>
          <button type="button" className="dev-link" onClick={() => setOpen(open === tile.key ? null : tile.key)}>
            {open === tile.key ? 'Hide details' : 'Details'}
          </button>
          {open === tile.key && (
            <dl className="dev-metrics">
              {Object.entries(tile.metrics).map(([k, v]) => (
                <div key={k}>
                  <dt>{k.replace(/_/g, ' ')}</dt>
                  <dd>{k.endsWith('_at') || k === 'last_success' || k === 'last_error' ? ago(v as string | null) : formatMetric(v)}</dd>
                </div>
              ))}
              {Object.keys(tile.metrics).length === 0 && <p className="dev-muted">No metrics for this check.</p>}
            </dl>
          )}
          <small className="dev-checked">checked {ago(tile.checked_at)}</small>
        </article>
      ))}
    </div>
  )
}

function FunctionsTab({ functions }: { functions: FunctionStat[] }) {
  const [kind, setKind] = useState<'all' | FunctionStat['kind']>('all')
  const [status, setStatus] = useState<'all' | HealthStatus>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const rows = useMemo(
    () =>
      functions.filter(
        (f) => (kind === 'all' || f.kind === kind) && (status === 'all' || f.status === status) && f.name.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [functions, kind, status, query],
  )
  const counts = useMemo(() => {
    const c = { ok: 0, warn: 0, down: 0, idle: 0 }
    functions.forEach((f) => (c[f.status] += 1))
    return c
  }, [functions])

  return (
    <section>
      <div className="dev-summary-row">
        <span className="dev-chip dev-chip-ok">{counts.ok} healthy</span>
        <span className="dev-chip dev-chip-warn">{counts.warn} degraded</span>
        <span className="dev-chip dev-chip-down">{counts.down} failing</span>
        <span className="dev-chip dev-chip-idle">{counts.idle} idle</span>
        <span className="dev-muted">{functions.length} tracked</span>
      </div>
      <div className="dev-filters">
        <label className="dev-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search function or route…" aria-label="Search functions" />
        </label>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Filter by kind">
          <option value="all">All kinds</option>
          <option value="function">Functions</option>
          <option value="route">API routes</option>
          <option value="upstream">Upstream calls</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          <option value="down">Failing</option>
          <option value="warn">Degraded</option>
          <option value="ok">Healthy</option>
          <option value="idle">Idle</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="dev-empty">{functions.length === 0 ? 'Nothing tracked yet — functions appear here as the app is used.' : 'No functions match these filters.'}</p>
      ) : (
        <div className="dev-table-wrap">
          <table className="dev-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Name</th>
                <th>Kind</th>
                <th className="num">Calls</th>
                <th className="num">Errors</th>
                <th className="num">Recent err %</th>
                <th className="num">p50</th>
                <th className="num">p95</th>
                <th className="num">p99</th>
                <th>Last OK</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <FunctionRow key={f.name} stat={f} open={expanded === f.name} onToggle={() => setExpanded(expanded === f.name ? null : f.name)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function FunctionRow({ stat, open, onToggle }: { stat: FunctionStat; open: boolean; onToggle: () => void }) {
  const ms = (v: number | null) => (v === null ? '—' : `${v} ms`)
  return (
    <>
      <tr className={`dev-row dev-row-${stat.status}`} onClick={stat.last_error_message ? onToggle : undefined} style={{ cursor: stat.last_error_message ? 'pointer' : 'default' }}>
        <td>
          <StatusBadge status={stat.status} />
        </td>
        <td className="dev-name">{stat.name}</td>
        <td>{stat.kind}</td>
        <td className="num">{stat.calls}</td>
        <td className="num">{stat.errors}</td>
        <td className="num">{(stat.recent_error_rate * 100).toFixed(0)}%</td>
        <td className="num">{ms(stat.p50_ms)}</td>
        <td className="num">{ms(stat.p95_ms)}</td>
        <td className="num">{ms(stat.p99_ms)}</td>
        <td>{ago(stat.last_success)}</td>
        <td>{ago(stat.last_error)}</td>
      </tr>
      {open && stat.last_error_message && (
        <tr className="dev-row-detail">
          <td colSpan={11}>
            <strong>Last error:</strong> {stat.last_error_message}
          </td>
        </tr>
      )}
    </>
  )
}

function SelfTestsTab({ run, running, onRun }: { run: SelfTestRun | null; running: boolean; onRun: () => void }) {
  return (
    <section>
      <div className="dev-selftest-head">
        <p className="dev-muted">
          Known-answer checks: each runs real logic with fixed inputs and compares against the expected answer. A changed answer marks that function FAULTY.
        </p>
        <button type="button" className="dev-btn dev-btn-primary" onClick={onRun} disabled={running}>
          {running ? <Loader2 size={14} className="ws-spin" /> : <Play size={14} />} Run all self-tests
        </button>
      </div>
      {!run ? (
        <p className="dev-empty">Not run yet this session. Click “Run all self-tests”.</p>
      ) : (
        <>
          <div className="dev-summary-row">
            <span className="dev-chip dev-chip-ok">{run.passed} passed</span>
            <span className={`dev-chip ${run.failed ? 'dev-chip-down' : 'dev-chip-idle'}`}>{run.failed} failed</span>
            <span className="dev-muted">ran {ago(run.ran_at)}</span>
          </div>
          <ul className="dev-selftests">
            {run.results.map((r) => (
              <li key={r.key} className={`dev-selftest dev-selftest-${r.status}`}>
                {r.status === 'pass' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                <div>
                  <strong>{r.label}</strong>
                  <p>{r.detail}</p>
                </div>
                <small>{r.duration_ms} ms</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function ErrorsTab({ errors }: { errors: DevError[] }) {
  if (errors.length === 0) return <p className="dev-empty">No errors recorded since the server started.</p>
  return (
    <ul className="dev-errors">
      {errors.map((e, i) => (
        <li key={`${e.ts}-${i}`}>
          <div className="dev-error-top">
            <strong>{e.component}</strong>
            {e.status ? <span className="dev-chip dev-chip-down">HTTP {e.status}</span> : null}
            <span className="dev-muted">{ago(e.ts)}</span>
          </div>
          <p>{e.message}</p>
          <small className="dev-muted">
            {e.path ? `${e.path} · ` : ''}
            {e.request_id ? `request ${e.request_id}` : ''}
          </small>
        </li>
      ))}
    </ul>
  )
}

function ConfigTab({ checks }: { checks: ConfigCheck[] }) {
  const failing = checks.filter((c) => !c.ok).length
  return (
    <section>
      <p className="dev-muted">
        Production-readiness gates. Red items are expected on a local setup and do not affect the overall health status. {failing} of {checks.length} not yet
        ready for production. Secret values are never shown.
      </p>
      <ul className="dev-selftests">
        {checks.map((c) => (
          <li key={c.key} className={`dev-selftest ${c.ok ? 'dev-selftest-pass' : 'dev-selftest-warn'}`}>
            {c.ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <div>
              <strong>{c.label}</strong>
              <p>{c.ok ? 'Ready' : c.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
