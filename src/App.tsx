import {
  ArrowLeft,
  BarChart3,
  Bell,
  CalendarDays,
  CandlestickChart,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Filter,
  Info,
  Landmark,
  LayoutDashboard,
  Link2,
  ListChecks,
  Loader2,
  Lock,
  Menu,
  Moon,
  MoreVertical,
  NotebookPen,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Target,
  TrendingUp,
  Unlink,
  User,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'
import './App.css'
import { db } from './database/db'
import {
  deleteAttachmentsByTradeId,
  deleteTradeById,
  exportBackupBundle,
  getAccounts,
  getAttachmentByTradeId,
  getProfileName,
  getTrades,
  importBackupBundle,
  saveAccount,
  saveProfileName,
  saveTrade,
  toTradeFromDraft,
} from './services/journalService'
import type { Account, BackupBundle, Trade, TradeDraft, TradingSegment } from './types'
import { ApiError, type TradingAccountApi } from './workspace/api'
import {
  deleteBusinessTrade,
  fetchBusinessAccountWithTrades,
  fetchRemoteOnlyAccountsWithTrades,
  saveBusinessTrade,
} from './workspace/tradeSync'
import {
  calculateTradeStatus,
  computePnl,
  filterTradesByAccount,
  getNetPnl,
  getPnlLabel,
} from './utils/tradeMath'
import {
  defaultJournalFilters,
  getFilteredTrades,
  summarizeByScript,
  summarizeTrades,
  type JournalFilters,
} from './utils/filterTrades'
import { TradingChart } from './components/TradingChart/TradingChart'
import type { MarketInstrument } from './components/TradingChart/chartTypes'
import { fallbackInstrument, resolveInstrument, type AmbiguousResolution } from './services/marketData/instrumentResolver'
import { marketDataService } from './services/marketData/MarketDataService'
import { AngelOneProvider, angelOneProvider } from './services/marketData/adapters/angelOne/AngelOneProvider'
import {
  clearAngelOneCredentials,
  hasAngelOneCredentials,
  loadAngelOneCredentials,
  saveAngelOneCredentials,
  type AngelOneCredentials,
} from './services/marketData/adapters/angelOne/secureCredentialStore'
import type { AngelOneStatusSnapshot } from './services/marketData/adapters/angelOne/types'
import angelOneLogo from './assets/angelone-logo.png'

type TabKey = 'dashboard' | 'journal' | 'open-trades' | 'calendar' | 'analytics' | 'accounts' | 'settings'

const navItems: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'journal', label: 'Journal', icon: NotebookPen },
  { key: 'open-trades', label: 'Open Trades', icon: NotebookPen },
  { key: 'calendar', label: 'Calendar', icon: CalendarDays },
  { key: 'analytics', label: 'Analytics', icon: BarChart3 },
  { key: 'accounts', label: 'Broker', icon: Landmark },
  { key: 'settings', label: 'Settings', icon: Settings },
]

const bottomNavKeys: TabKey[] = ['dashboard', 'journal', 'open-trades', 'analytics', 'accounts']
const bottomNavItems = bottomNavKeys.map((key) => navItems.find((item) => item.key === key)!)

// Tabs that only exist to modify data (account management, backup restore).
const mutationTabKeys: TabKey[] = ['accounts', 'settings']

const brokerPalette = ['#2563EB', '#F59E0B', '#7C3AED', '#0D9488', '#DB2777', '#0EA5E9']

const brokerColor = (name: string): string => {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = name.charCodeAt(index) + ((hash << 5) - hash)
  }
  return brokerPalette[Math.abs(hash) % brokerPalette.length]
}

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return ''
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase()
  }
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

const getAccountAlias = (account: Account): string => account.alias?.trim() || getInitials(account.accountName)

const getGreeting = (): string => {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good Morning'
  if (hour < 17) return 'Good Afternoon'
  return 'Good Evening'
}

const segmentBadgeClass: Record<TradingSegment, string> = {
  CASH: 'badge badge-cash',
  FUTURES: 'badge badge-fut',
  OPTIONS: 'badge badge-opt',
}

const segmentShortLabel: Record<TradingSegment, string> = {
  CASH: 'CASH',
  FUTURES: 'FUT',
  OPTIONS: 'OPT',
}

const buildChartGeometry = (series: Array<{ date: string; value: number }>, width: number, height: number) => {
  if (series.length === 0) {
    return null
  }

  const values = series.map((point) => point.value)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const span = max - min || 1
  const padX = 8
  const padY = 16
  const usableWidth = width - padX * 2
  const usableHeight = height - padY * 2

  const points = series.map((point, index) => {
    const x = series.length === 1 ? padX : padX + (index / (series.length - 1)) * usableWidth
    const y = padY + usableHeight - ((point.value - min) / span) * usableHeight
    return { x, y }
  })

  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
  const zeroY = padY + usableHeight - ((0 - min) / span) * usableHeight
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(2)},${zeroY.toFixed(2)} L${points[0].x.toFixed(2)},${zeroY.toFixed(2)} Z`
  const isPositive = values[values.length - 1] >= 0

  return { linePath, areaPath, isPositive, zeroY }
}

const segmentOptions: TradingSegment[] = ['CASH', 'FUTURES', 'OPTIONS']
const reasonOptions = [
  'GFS',
  'System 1',
  'System 2',
  'Value Buy',
  'PRD',
  'NRD',
  'Double Top',
  'Double Bottom',
  'Top Bottom',
  'ADV GFS',
]

const CUSTOM_REASON_SENTINEL = '__custom__'

const toDraft = (accountId: string): TradeDraft => ({
  accountId,
  tradeDate: new Date().toISOString().slice(0, 10),
  segment: 'CASH',
  scriptName: '',
  reason: '',
  quantity: '1',
  side: 'BUY',
  entryPrice: '',
  exitDate: '',
  exitPrice: '',
  notes: '',
})

const defaultAccountDraft = () => ({
  id: '',
  accountName: '',
  alias: '',
  brokerName: '',
  accountType: 'Trading',
})

interface AppProps {
  /**
   * 'personal' = the user's own local accounts, full edit.
   * 'view' = accounts shared with the user as VIEWER, strictly read-only.
   * 'business' = every backend business account this user has access to
   * (`businessAccounts`), read from and written to the backend only; a
   * given account is read-only only for the accounts where this user's
   * role on it is VIEWER (mirrors 'view' mode's per-account gating).
   */
  mode?: 'personal' | 'view' | 'business'
  businessAccounts?: TradingAccountApi[]
  /** Extra sidebar entries that run an action instead of switching tabs (used by Business for Accounts / Portfolios). */
  extraNav?: Array<{ key: string; label: string; icon: React.ComponentType<{ size?: number }>; onClick: () => void; active?: boolean }>
  /** When set, replaces the tab content in the main area (Business "User and Permissions"). */
  extraPage?: React.ReactNode
  /** Called when a regular sidebar tab is picked, so the host can leave `extraPage`. */
  onTabSelect?: () => void
  /** When set, shows a "← Modes" button at the top of the sidebar (Personal / View, which have no WorkspaceBar of their own to host it). */
  onGoHome?: () => void
}

function App({ mode = 'personal', businessAccounts = [], extraNav = [], extraPage, onTabSelect, onGoHome }: AppProps) {
  const isPersonal = mode === 'personal'
  // Business mode is read-only as a whole only when every account in it is VIEWER-only; a mixed owner+viewer
  // list stays writable overall, with each VIEWER-role account individually write-protected via remoteOnlyAccountIds below.
  const readOnly = mode === 'view' || (mode === 'business' && businessAccounts.length > 0 && businessAccounts.every((a) => a.role === 'VIEWER'))
  const visibleNavItems = isPersonal ? navItems : navItems.filter((item) => !mutationTabKeys.includes(item.key))
  const visibleBottomNavItems = isPersonal ? bottomNavItems : bottomNavItems.filter((item) => !mutationTabKeys.includes(item.key))
  const [accounts, setAccounts] = useState<Account[]>([])
  const [trades, setTrades] = useState<Trade[]>([])
  // Accounts shared to this user via the backend workspace layer (Phase
  // 10.1) — held only in memory, never written to Dexie. Their trades are
  // merged into `trades` below for read-only display through all the same
  // existing rendering/filtering/export code; see workspace/tradeSync.ts.
  const [remoteOnlyAccountIds, setRemoteOnlyAccountIds] = useState<Set<string>>(new Set())
  const [selectedAccount, setSelectedAccount] = useState<string>('all')
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard')
  const shownTab = extraPage ? null : activeTab
  const [tradeFormOpen, setTradeFormOpen] = useState(false)
  const [quickMode, setQuickMode] = useState(false)
  const [reasonCustomMode, setReasonCustomMode] = useState(false)
  const [accountFormOpen, setAccountFormOpen] = useState(false)
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [formError, setFormError] = useState('')
  const [accountFormError, setAccountFormError] = useState('')
  const [tradeDraft, setTradeDraft] = useState<TradeDraft>(() => toDraft(''))
  const [accountDraft, setAccountDraft] = useState(defaultAccountDraft())
  const [tradeAttachment, setTradeAttachment] = useState<string>('')
  const [selectedTradeAttachment, setSelectedTradeAttachment] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [chartRange, setChartRange] = useState<'7D' | '30D' | '3M' | '1Y'>('30D')
  const [calendarViewMode, setCalendarViewMode] = useState<'Month' | 'Week' | 'Day'>('Month')
  const [calendarCursor, setCalendarCursor] = useState<Date>(() => new Date())
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [exportScope, setExportScope] = useState<'all' | 'account' | 'view'>('view')
  const [exportFormat, setExportFormat] = useState<'excel' | 'pdf' | 'csv'>('excel')
  const [includeFullNamesInExport, setIncludeFullNamesInExport] = useState(false)
  const [chartState, setChartState] = useState<{
    isOpen: boolean
    instrument: MarketInstrument | null
    scriptName: string
    accountId: string
    tradeId?: string
    isMaximized: boolean
  }>({ isOpen: false, instrument: null, scriptName: '', accountId: 'all', isMaximized: false })
  const [ambiguousInstrument, setAmbiguousInstrument] = useState<{ scriptName: string; accountId: string; tradeId?: string; resolution: AmbiguousResolution } | null>(null)
  const [angelOneStatus, setAngelOneStatus] = useState<AngelOneStatusSnapshot>({ status: 'disconnected', message: 'Not connected' })
  const [angelOneDraft, setAngelOneDraft] = useState<AngelOneCredentials>({ apiKey: '', clientCode: '', pin: '', totpSecret: '' })
  const [angelOneHasSaved, setAngelOneHasSaved] = useState(false)
  const [angelOneTesting, setAngelOneTesting] = useState(false)
  const [angelOneTestResult, setAngelOneTestResult] = useState<string | null>(null)
  const [settingsTab, setSettingsTab] = useState<'profile' | 'broker' | 'data'>('profile')
  const [angelOneRevealed, setAngelOneRevealed] = useState({ apiKey: false, pin: false, totpSecret: false })
  const [profileName, setProfileName] = useState('')
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [profileNameDraft, setProfileNameDraft] = useState('')
  const [settingsNameDraft, setSettingsNameDraft] = useState('')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const stored = localStorage.getItem('journal-theme')
      if (stored === 'dark' || stored === 'light') {
        return stored
      }
    } catch {
      // ignore storage access errors
    }
    return 'light'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('journal-theme', theme)
    } catch {
      // ignore storage access errors
    }
  }, [theme])
  const [filters, setFilters] = useState<JournalFilters>(defaultJournalFilters)

  const loadState = async (): Promise<void> => {
    // Personal mode: only the user's own (local) accounts, excluding any
    // Business-type account — creating a Business account server-side also
    // mirrors it into this same local Dexie table (see
    // WorkspaceAuthContext.createAccount) so it can log trades, but it must
    // only ever appear in Business mode, never bleed into Personal. View
    // mode: only accounts shared with the user as VIEWER, never their own.
    const allLocalAccounts = isPersonal ? await getAccounts() : []
    const nextAccounts = allLocalAccounts.filter((a) => a.accountType.trim().toLowerCase() !== 'business')
    const personalAccountIds = new Set(nextAccounts.map((a) => a.id))
    const allLocalTrades = isPersonal ? await getTrades() : []
    const nextTrades = allLocalTrades.filter((t) => personalAccountIds.has(t.accountId))
    const storedName = await getProfileName()
    let remote: { accounts: Account[]; trades: Trade[] } = { accounts: [], trades: [] }
    if (mode === 'view') {
      remote = await fetchRemoteOnlyAccountsWithTrades(['VIEWER'])
    } else if (mode === 'business' && businessAccounts.length > 0) {
      try {
        remote = await fetchBusinessAccountWithTrades(businessAccounts)
      } catch (err) {
        setMessage(err instanceof ApiError ? err.message : 'Could not load your business accounts.')
      }
    }
    setAccounts([...nextAccounts, ...remote.accounts])
    setTrades([...nextTrades, ...remote.trades])
    // Remote accounts are write-protected per-account: every View-mode account (all VIEWER by
    // definition) plus any individually VIEWER-role account within a Business account list —
    // an owner/admin account in that same list stays writable.
    const viewerOnlyBusinessIds = new Set(businessAccounts.filter((a) => a.role === 'VIEWER').map((a) => a.id))
    setRemoteOnlyAccountIds(new Set(mode === 'view' ? remote.accounts.map((a) => a.id) : viewerOnlyBusinessIds))
    setProfileName(storedName)
    setSettingsNameDraft(storedName)
    if (!storedName) {
      setProfileModalOpen(true)
    }
    setIsLoading(false)
    setSelectedAccount((current) => {
      if (current !== 'all' && ![...nextAccounts, ...remote.accounts].some((account) => account.id === current)) {
        return 'all'
      }

      return current
    })
  }

  useEffect(() => {
    void loadState()
  }, [])

  useEffect(() => {
    // Fired by the workspace layer (a separate component tree) when it
    // creates a new locally-linked account — see WorkspaceAuthContext.tsx.
    const handler = () => void loadState()
    window.addEventListener('journal:local-accounts-changed', handler)
    return () => window.removeEventListener('journal:local-accounts-changed', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const unsubscribe = angelOneProvider.onStatusChange(setAngelOneStatus)
    void hasAngelOneCredentials().then(setAngelOneHasSaved)
    void loadAngelOneCredentials().then((saved) => {
      if (saved) {
        setAngelOneDraft(saved)
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (selectedAccount !== 'all' && !tradeDraft.accountId) {
      setTradeDraft((current) => ({ ...current, accountId: selectedAccount }))
    }
  }, [selectedAccount, tradeDraft.accountId])

  useEffect(() => {
    if (!selectedTradeId) {
      setSelectedTradeAttachment(null)
      return
    }

    let cancelled = false
    void getAttachmentByTradeId(selectedTradeId).then((record) => {
      if (!cancelled) {
        setSelectedTradeAttachment(record?.dataUrl ?? null)
      }
    })

    return () => {
      cancelled = true
    }
  }, [selectedTradeId])

  const visibleTrades = useMemo(
    () => getFilteredTrades(trades, selectedAccount, filters),
    [trades, selectedAccount, filters],
  )

  const accountScopedTrades = useMemo(
    () => filterTradesByAccount(trades, selectedAccount),
    [trades, selectedAccount],
  )

  const stockSummaries = useMemo(() => summarizeByScript(accountScopedTrades), [accountScopedTrades])

  const selectedStockSummary = useMemo(() => {
    if (!filters.script) {
      return null
    }
    return summarizeTrades(filters.script, accountScopedTrades.filter((trade) => trade.scriptName === filters.script))
  }, [accountScopedTrades, filters.script])

  const summary = useMemo(() => {
    const total = visibleTrades.length
    const open = visibleTrades.filter((trade) => trade.status === 'OPEN').length
    const closed = visibleTrades.filter((trade) => trade.status === 'CLOSED').length
    const winningTrades = visibleTrades.filter((trade) => trade.netPnl > 0).length
    const losingTrades = visibleTrades.filter((trade) => trade.netPnl < 0).length
    const net = getNetPnl(visibleTrades)
    const winRate = total ? (winningTrades / total) * 100 : 0
    const invested = visibleTrades
      .filter((trade) => trade.status === 'CLOSED')
      .reduce((sum, trade) => sum + trade.entryPrice * trade.quantity, 0)
    const netPercent = invested > 0 ? (net / invested) * 100 : 0

    return {
      total,
      open,
      closed,
      winningTrades,
      losingTrades,
      net,
      winRate,
      netPercent,
    }
  }, [visibleTrades])

  const selectedTrade = useMemo(
    () => visibleTrades.find((trade) => trade.id === selectedTradeId) ?? trades.find((trade) => trade.id === selectedTradeId) ?? null,
    [selectedTradeId, visibleTrades, trades],
  )

  const selectedAccountName = useMemo(() => {
    if (selectedAccount === 'all') {
      return 'All Accounts'
    }
    const account = accounts.find((item) => item.id === selectedAccount)
    return account ? getAccountAlias(account) : 'All Accounts'
  }, [accounts, selectedAccount])

  const openTrades = useMemo(() => visibleTrades.filter((trade) => trade.status === 'OPEN'), [visibleTrades])

  const accountOptions = accounts.filter((account) => !account.isArchived)
  const archivedAccounts = accounts.filter((account) => account.isArchived)
  // Accounts a new/edited trade can actually be saved into — excludes
  // read-only shared accounts (Phase 10.1). Used only for the trade-entry
  // form's own account picker and its validation; the main account
  // filter/selector elsewhere still shows every account, including shared
  // ones, so their (existing) trades remain viewable.
  const writableAccountOptions = accountOptions.filter((account) => !remoteOnlyAccountIds.has(account.id))

  const accountAliasById = (accountId: string): string => {
    const account = accounts.find((item) => item.id === accountId)
    return account ? getAccountAlias(account) : 'Unknown'
  }

  const renderMobileTradeCard = (trade: Trade, onCardClick?: () => void) => (
    <div
      key={trade.id}
      role="button"
      tabIndex={0}
      className="trade-card"
      onClick={onCardClick ?? (() => setSelectedTradeId(trade.id))}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          (onCardClick ?? (() => setSelectedTradeId(trade.id)))()
        }
      }}
    >
      <div className="trade-card-top">
        <strong>{trade.scriptName}</strong>
        <span className="trade-card-alias">{accountAliasById(trade.accountId)}</span>
      </div>
      <div className="trade-card-meta">
        <span className={trade.side === 'BUY' ? 'badge badge-buy' : 'badge badge-sell'}>{trade.side}</span>
        <span>{trade.quantity} Qty</span>
        <span className={segmentBadgeClass[trade.segment]}>{segmentShortLabel[trade.segment]}</span>
      </div>
      <div className="trade-card-rows">
        <div><span>Entry</span><strong>₹{trade.entryPrice}</strong></div>
        <div><span>Exit</span><strong>{trade.exitPrice > 0 ? `₹${trade.exitPrice}` : '—'}</strong></div>
        <div><span>Date</span><strong>{trade.tradeDate}</strong></div>
      </div>
      <div className="trade-card-footer">
        <span className={trade.netPnl >= 0 ? 'profit' : 'loss'}>{trade.status === 'CLOSED' ? getPnlLabel(trade.netPnl) : '—'}</span>
        <span className={trade.status === 'OPEN' ? 'badge badge-open' : 'badge badge-closed'}>{trade.status}</span>
      </div>
      <button
        type="button"
        className="secondary-btn chart-open-btn"
        onClick={(event) => { event.stopPropagation(); openChart(trade.scriptName, trade.accountId, trade.id) }}
      >
        <CandlestickChart size={14} />
        Chart
      </button>
    </div>
  )

  const openTradesAll = useMemo(() => trades.filter((trade) => trade.status === 'OPEN'), [trades])

  useEffect(() => {
    if (!notificationsOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement
      if (!target.closest('.notifications-wrap')) {
        setNotificationsOpen(false)
      }
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setNotificationsOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [notificationsOpen])

  // Personal trades go to Dexie (and sync best-effort); Business trades go straight to the backend, which enforces roles.
  const persistTrade = async (trade: Trade): Promise<boolean> => {
    if (mode !== 'business') {
      await saveTrade(trade)
      return true
    }
    try {
      await saveBusinessTrade(trade)
      return true
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Could not save the trade.')
      return false
    }
  }

  const refreshAfterTradeAction = async (): Promise<void> => {
    await loadState()
  }

  const openTradeForm = (record?: Trade, quick = false): void => {
    if (readOnly) return
    const defaultAccount =
      selectedAccount !== 'all' && !remoteOnlyAccountIds.has(selectedAccount) ? selectedAccount : writableAccountOptions[0]?.id ?? ''
    const nextAccountId = record?.accountId ?? defaultAccount
    setTradeDraft(
      record
        ? {
            id: record.id,
            accountId: nextAccountId,
            tradeDate: record.tradeDate,
            segment: record.segment,
            scriptName: record.scriptName,
            reason: record.reason,
            quantity: String(record.quantity),
            side: record.side,
            entryPrice: String(record.entryPrice),
            exitDate: record.exitDate,
            exitPrice: String(record.exitPrice || ''),
            notes: record.notes,
          }
        : toDraft(nextAccountId),
    )
    setFormError('')
    setQuickMode(quick)
    setReasonCustomMode(Boolean(record?.reason) && !reasonOptions.includes(record?.reason ?? ''))
    setTradeAttachment('')
    if (record) {
      void getAttachmentByTradeId(record.id).then((attachment) => {
        if (attachment?.dataUrl) {
          setTradeAttachment(attachment.dataUrl)
        }
      })
    }
    setTradeFormOpen(true)
  }

  const closeTradeForm = (): void => {
    setTradeFormOpen(false)
    setQuickMode(false)
    setFormError('')
    setReasonCustomMode(false)
    setTradeAttachment('')
  }

  const handleTradeSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setFormError('')

    if (writableAccountOptions.length === 0) {
      const noAccountMessage = 'Add a trading account before logging a trade.'
      setFormError(noAccountMessage)
      setMessage(noAccountMessage)
      return
    }

    if (!tradeDraft.accountId) {
      const errorMessage = 'Select a trading account to save this trade.'
      setFormError(errorMessage)
      setMessage(errorMessage)
      return
    }

    if (remoteOnlyAccountIds.has(tradeDraft.accountId)) {
      const errorMessage = 'This is a shared, read-only account — trades can only be added by its owner.'
      setFormError(errorMessage)
      setMessage(errorMessage)
      return
    }

    if (!tradeDraft.scriptName.trim() || !tradeDraft.tradeDate) {
      const errorMessage = 'Script name and trade date are required.'
      setFormError(errorMessage)
      setMessage(errorMessage)
      return
    }

    const quantity = Number(tradeDraft.quantity) || 0
    const entryPrice = Number(tradeDraft.entryPrice) || 0
    const exitPrice = Number(tradeDraft.exitPrice) || 0

    if (quantity <= 0 || entryPrice <= 0) {
      const errorMessage = 'Quantity and entry price must be greater than zero.'
      setFormError(errorMessage)
      setMessage(errorMessage)
      return
    }

    if (tradeDraft.exitDate && tradeDraft.exitDate < tradeDraft.tradeDate) {
      const errorMessage = 'Exit date cannot be before the entry date.'
      setFormError(errorMessage)
      setMessage(errorMessage)
      return
    }

    if (tradeDraft.exitDate && exitPrice <= 0) {
      const errorMessage = 'Exit price must be greater than zero when an exit date is entered.'
      setFormError(errorMessage)
      setMessage(errorMessage)
      return
    }

    // Instrument resolution only ever runs for brand-new trades. Editing an
    // existing trade carries its stored `instrument` (if any) forward
    // completely untouched — existing journal data is never migrated or
    // re-resolved.
    const isNewTrade = !tradeDraft.id
    const existingTrade = tradeDraft.id ? trades.find((item) => item.id === tradeDraft.id) : undefined

    const trade = toTradeFromDraft({ ...tradeDraft, accountId: tradeDraft.accountId, id: tradeDraft.id ?? crypto.randomUUID() })
    const finalTrade: Trade = {
      ...trade,
      grossPnl: trade.exitDate && trade.exitPrice > 0 ? computePnl({ side: trade.side, quantity: trade.quantity, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice }) : 0,
      netPnl: trade.exitDate && trade.exitPrice > 0 ? computePnl({ side: trade.side, quantity: trade.quantity, entryPrice: trade.entryPrice, exitPrice: trade.exitPrice }) : 0,
      status: calculateTradeStatus({ exitDate: trade.exitDate, exitPrice: trade.exitPrice }),
      updatedAt: new Date().toISOString(),
      instrument: isNewTrade
        ? (() => {
            const result = resolveInstrument(trade.scriptName)
            return result && !('ambiguous' in result) ? result : fallbackInstrument(trade.scriptName)
          })()
        : existingTrade?.instrument,
    }

    if (!(await persistTrade(finalTrade))) {
      return
    }
    await deleteAttachmentsByTradeId(finalTrade.id)

    if (tradeAttachment) {
      await db.attachments.put({
        id: crypto.randomUUID(),
        tradeId: finalTrade.id,
        name: `${finalTrade.scriptName}.png`,
        type: 'image/png',
        dataUrl: tradeAttachment,
        createdAt: new Date().toISOString(),
      })
    }

    if (selectedTradeId === finalTrade.id) {
      setSelectedTradeAttachment(tradeAttachment || null)
    }

    setTradeAttachment('')
    setTradeFormOpen(false)
    setQuickMode(false)
    const fallbackAccountId = tradeDraft.accountId || writableAccountOptions[0]?.id || ''
    setTradeDraft(toDraft(fallbackAccountId))
    setMessage(mode === 'business' ? 'Trade saved.' : 'Trade saved to local database.')
    await refreshAfterTradeAction()
  }

  const angelOneDraftComplete = Boolean(
    angelOneDraft.apiKey.trim() && angelOneDraft.clientCode.trim() && angelOneDraft.pin.trim() && angelOneDraft.totpSecret.trim(),
  )

  const handleAngelOneConnect = async (): Promise<void> => {
    if (!angelOneDraftComplete) {
      setMessage('Fill in all Angel One fields before connecting.')
      return
    }
    await saveAngelOneCredentials(angelOneDraft)
    setAngelOneHasSaved(true)
    try {
      await angelOneProvider.connect(angelOneDraft)
      marketDataService.setProvider(angelOneProvider)
      setMessage('Angel One connected.')
    } catch {
      // Status banner already reflects the error via onStatusChange.
    }
  }

  const handleAngelOneDisconnect = async (): Promise<void> => {
    await angelOneProvider.disconnect()
    marketDataService.setProvider(null)
    setMessage('Angel One disconnected.')
  }

  const handleAngelOneForget = async (): Promise<void> => {
    await angelOneProvider.disconnect()
    marketDataService.setProvider(null)
    await clearAngelOneCredentials()
    setAngelOneHasSaved(false)
    setAngelOneDraft({ apiKey: '', clientCode: '', pin: '', totpSecret: '' })
    setMessage('Saved Angel One credentials removed from this device.')
  }

  const handleAngelOneTest = async (): Promise<void> => {
    if (!angelOneDraftComplete) {
      setMessage('Fill in all Angel One fields before testing.')
      return
    }
    setAngelOneTesting(true)
    setAngelOneTestResult(null)
    const testProvider = new AngelOneProvider()
    try {
      await testProvider.connect(angelOneDraft)
      setAngelOneTestResult('Connection successful.')
      await testProvider.disconnect()
    } catch (error) {
      setAngelOneTestResult(error instanceof Error ? error.message : 'Connection failed.')
    } finally {
      setAngelOneTesting(false)
    }
  }

  const openChart = (scriptName: string, accountId: string, tradeId?: string): void => {
    const result = resolveInstrument(scriptName)

    if (result && 'ambiguous' in result) {
      setAmbiguousInstrument({ scriptName, accountId, tradeId, resolution: result })
      return
    }

    setChartState({
      isOpen: true,
      instrument: result ?? fallbackInstrument(scriptName),
      scriptName,
      accountId,
      tradeId,
      isMaximized: false,
    })
  }

  const chooseAmbiguousInstrument = (instrument: MarketInstrument): void => {
    if (!ambiguousInstrument) {
      return
    }
    setChartState({
      isOpen: true,
      instrument,
      scriptName: ambiguousInstrument.scriptName,
      accountId: ambiguousInstrument.accountId,
      tradeId: ambiguousInstrument.tradeId,
      isMaximized: false,
    })
    setAmbiguousInstrument(null)
  }

  const closeChart = (): void => {
    setChartState((current) => ({ ...current, isOpen: false, isMaximized: false }))
  }

  const chartTrades = useMemo(() => {
    if (!chartState.isOpen || !chartState.instrument) {
      return []
    }
    return trades.filter((trade) => trade.accountId === chartState.accountId && trade.scriptName === chartState.scriptName)
  }, [trades, chartState])

  const handleTradeDelete = async (tradeId: string): Promise<void> => {
    if (readOnly) return
    const target = trades.find((item) => item.id === tradeId)
    if (target && remoteOnlyAccountIds.has(target.accountId)) {
      setMessage('This is a shared, read-only account — only its owner can delete trades.')
      return
    }

    if (!window.confirm('Delete this trade?')) {
      return
    }

    if (mode === 'business' && target) {
      try {
        await deleteBusinessTrade(target.accountId, tradeId)
      } catch (err) {
        setMessage(err instanceof ApiError ? err.message : 'Could not delete the trade.')
        return
      }
    } else {
      await deleteTradeById(tradeId)
    }
    setMessage('Trade deleted.')
    await refreshAfterTradeAction()
  }

  const handleCloseTrade = async (trade: Trade): Promise<void> => {
    if (readOnly) return
    if (remoteOnlyAccountIds.has(trade.accountId)) {
      setMessage('This is a shared, read-only account — only its owner can edit trades.')
      return
    }

    const exitDate = new Date().toISOString().slice(0, 10)
    const exitPrice = trade.exitPrice || trade.entryPrice
    const updatedTrade: Trade = {
      ...trade,
      exitDate,
      exitPrice,
      status: 'CLOSED',
      grossPnl: computePnl({ side: trade.side, quantity: trade.quantity, entryPrice: trade.entryPrice, exitPrice }),
      netPnl: computePnl({ side: trade.side, quantity: trade.quantity, entryPrice: trade.entryPrice, exitPrice }),
      updatedAt: new Date().toISOString(),
    }

    if (!(await persistTrade(updatedTrade))) {
      return
    }
    setMessage('Trade closed and P/L updated.')
    await refreshAfterTradeAction()
  }

  const commitOnboardingName = async (): Promise<void> => {
    const finalName = profileNameDraft.trim() || 'Trader'
    await saveProfileName(finalName)
    setProfileName(finalName)
    setSettingsNameDraft(finalName)
    setProfileModalOpen(false)
    setProfileNameDraft('')
  }

  const handleSaveOnboardingName = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    await commitOnboardingName()
  }

  const handleUpdateSettingsName = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const finalName = settingsNameDraft.trim()
    if (!finalName) {
      setMessage('Name cannot be empty.')
      return
    }
    await saveProfileName(finalName)
    setProfileName(finalName)
    setMessage('Name updated.')
  }

  const openAccountForm = (record?: Account): void => {
    if (!isPersonal) return
    setAccountFormError('')
    setAccountDraft(
      record
        ? { id: record.id, accountName: record.accountName, alias: record.alias ?? '', brokerName: record.brokerName, accountType: record.accountType }
        : defaultAccountDraft(),
    )
    setAccountFormOpen(true)
  }

  const handleAccountSave = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setAccountFormError('')

    if (!accountDraft.accountName.trim() || !accountDraft.brokerName.trim()) {
      const errorMessage = 'Account name and broker are required.'
      setAccountFormError(errorMessage)
      setMessage(errorMessage)
      return
    }

    const existing = accounts.find((account) => account.id === accountDraft.id)

    const nextAccount: Account = {
      id: accountDraft.id || crypto.randomUUID(),
      accountName: accountDraft.accountName.trim(),
      alias: accountDraft.alias.trim(),
      brokerName: accountDraft.brokerName.trim(),
      accountType: accountDraft.accountType,
      isArchived: existing?.isArchived ?? false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    await saveAccount(nextAccount)
    setAccountFormOpen(false)
    setAccountDraft(defaultAccountDraft())
    setMessage('Account saved.')
    await refreshAfterTradeAction()
  }

  const handleArchiveAccount = async (accountId: string): Promise<void> => {
    const account = accounts.find((item) => item.id === accountId)
    if (!account) {
      return
    }

    if (!window.confirm(`Archive ${account.accountName}?`)) {
      return
    }

    const updated: Account = { ...account, isArchived: true, updatedAt: new Date().toISOString() }
    await saveAccount(updated)
    setMessage('Account archived.')
    await refreshAfterTradeAction()
  }

  const handleUnarchiveAccount = async (accountId: string): Promise<void> => {
    const account = accounts.find((item) => item.id === accountId)
    if (!account) {
      return
    }

    const updated: Account = { ...account, isArchived: false, updatedAt: new Date().toISOString() }
    await saveAccount(updated)
    setMessage('Account restored.')
    await refreshAfterTradeAction()
  }

  const handleImport = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const content = await file.text()
    const parsed = JSON.parse(content) as BackupBundle

    if (!window.confirm('Import this backup and merge the data into the local journal?')) {
      return
    }

    await importBackupBundle(parsed)
    setMessage('Backup imported successfully.')
    await refreshAfterTradeAction()
    event.target.value = ''
  }

  const exportAsJson = async (): Promise<void> => {
    const bundle = await exportBackupBundle()
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = 'trading-journal-backup.json'
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const openExportModal = (scope: 'all' | 'account' | 'view'): void => {
    setExportScope(scope)
    setExportModalOpen(true)
  }

  const exportScopedTrades = useMemo(() => {
    if (exportScope === 'all') {
      return trades.slice().sort((left, right) => right.tradeDate.localeCompare(left.tradeDate))
    }
    if (exportScope === 'account') {
      return accountScopedTrades
    }
    return visibleTrades
  }, [exportScope, trades, accountScopedTrades, visibleTrades])

  const exportPreview = {
    scopeLabel: exportScope === 'all' ? 'All Data' : exportScope === 'account' ? 'Current Account' : 'Current View',
    accountLabel: exportScope === 'all' ? 'All Accounts' : selectedAccountName,
    stockLabel: exportScope === 'view' && filters.script ? filters.script : 'All',
    dateLabel:
      exportScope === 'view' && (filters.startDate || filters.endDate)
        ? `${filters.startDate || '…'} → ${filters.endDate || '…'}`
        : 'All dates',
    statusLabel: exportScope === 'view' && filters.status !== 'all' ? filters.status : 'All',
    records: exportScopedTrades.length,
  }

  const buildExportRows = (list: Trade[]) =>
    list.map((trade, index) => ({
      'SR.NO': index + 1,
      DATE: trade.tradeDate,
      ACCOUNT: includeFullNamesInExport
        ? accounts.find((account) => account.id === trade.accountId)?.accountName ?? 'Unknown'
        : accountAliasById(trade.accountId),
      SCRIPT: trade.scriptName,
      SEGMENT: trade.segment,
      REASON: trade.reason,
      QTY: trade.quantity,
      'BUY/SELL': trade.side,
      'ENTRY PRICE': trade.entryPrice,
      'EXIT DATE': trade.exitDate || '',
      'EXIT PRICE': trade.exitPrice || '',
      STATUS: trade.status,
      'GROSS P/L': trade.grossPnl,
      CHARGES: 0,
      'NET P/L': trade.netPnl,
      NOTES: trade.notes,
    }))

  const downloadBlob = (blob: Blob, filename: string): void => {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const exportFileBaseName = (): string => {
    const scopePart = exportScope === 'all' ? 'all-data' : exportScope === 'account' ? 'current-account' : 'current-view'
    return `trading-journal-${scopePart}-${new Date().toISOString().slice(0, 10)}`
  }

  const runExport = (): void => {
    if (exportScopedTrades.length === 0) {
      return
    }

    const rows = buildExportRows(exportScopedTrades)
    const baseName = exportFileBaseName()

    if (exportFormat === 'csv') {
      const worksheet = XLSX.utils.json_to_sheet(rows)
      const csv = XLSX.utils.sheet_to_csv(worksheet)
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${baseName}.csv`)
    } else if (exportFormat === 'excel') {
      const worksheet = XLSX.utils.json_to_sheet(rows)
      worksheet['!cols'] = [
        { wch: 6 }, { wch: 11 }, { wch: 10 }, { wch: 16 }, { wch: 10 },
        { wch: 14 }, { wch: 6 }, { wch: 9 }, { wch: 11 }, { wch: 11 },
        { wch: 10 }, { wch: 8 }, { wch: 11 }, { wch: 9 }, { wch: 11 }, { wch: 24 },
      ]
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Journal')
      XLSX.writeFile(workbook, `${baseName}.xlsx`)
    } else {
      const doc = new jsPDF({ orientation: 'landscape' })
      doc.setFontSize(16)
      doc.text('TRADING JOURNAL', 14, 14)
      doc.setFontSize(10)
      doc.text(`Account: ${exportPreview.accountLabel}`, 14, 22)
      doc.text(`Stock: ${exportPreview.stockLabel}`, 14, 27)
      doc.text(`Date Range: ${exportPreview.dateLabel}`, 14, 32)
      doc.text(`Total Trades: ${exportPreview.records}`, 160, 22)
      doc.text(`Net P/L: ${getPnlLabel(getNetPnl(exportScopedTrades))}`, 160, 27)

      autoTable(doc, {
        startY: 38,
        head: [Object.keys(rows[0])],
        body: rows.map((row) => Object.values(row)),
        styles: { fontSize: 7, cellPadding: 2 },
        headStyles: { fillColor: [37, 99, 235], textColor: 255 },
        theme: 'grid',
        showHead: 'everyPage',
      })

      doc.save(`${baseName}.pdf`)
    }

    setExportModalOpen(false)
    setMessage(`Exported ${exportScopedTrades.length} trade${exportScopedTrades.length === 1 ? '' : 's'}.`)
  }

  const handleAttachmentChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      setTradeAttachment(String(reader.result ?? ''))
    }
    reader.readAsDataURL(file)
  }

  const calendarDays = useMemo(() => {
    const map = new Map<string, { count: number; pnl: number }>()

    visibleTrades.forEach((trade) => {
      const key = trade.tradeDate
      const entry = map.get(key) ?? { count: 0, pnl: 0 }
      entry.count += 1
      entry.pnl += trade.netPnl
      map.set(key, entry)
    })

    return Array.from(map.entries()).sort(([left], [right]) => right.localeCompare(left))
  }, [visibleTrades])

  const calendarDayMap = useMemo(() => new Map(calendarDays), [calendarDays])

  const toISODate = (d: Date): string => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  const addDays = (d: Date, days: number): Date => {
    const copy = new Date(d)
    copy.setDate(copy.getDate() + days)
    return copy
  }

  const calendarWeekDates = useMemo(() => {
    const start = addDays(calendarCursor, -calendarCursor.getDay())
    return Array.from({ length: 7 }, (_, i) => addDays(start, i))
  }, [calendarCursor])

  const calendarMonthWeeks = useMemo(() => {
    const year = calendarCursor.getFullYear()
    const month = calendarCursor.getMonth()
    const firstOfMonth = new Date(year, month, 1)
    const gridStart = addDays(firstOfMonth, -firstOfMonth.getDay())
    const weeks: Date[][] = []
    let cursor = gridStart
    for (let week = 0; week < 6; week += 1) {
      const row = Array.from({ length: 7 }, (_, i) => addDays(cursor, i))
      weeks.push(row)
      cursor = addDays(cursor, 7)
    }
    return weeks
  }, [calendarCursor])

  const calendarPeriodRange = useMemo((): [string, string] => {
    if (calendarViewMode === 'Day') {
      const iso = toISODate(calendarCursor)
      return [iso, iso]
    }
    if (calendarViewMode === 'Week') {
      return [toISODate(calendarWeekDates[0]), toISODate(calendarWeekDates[6])]
    }
    const year = calendarCursor.getFullYear()
    const month = calendarCursor.getMonth()
    const lastOfMonth = new Date(year, month + 1, 0)
    return [toISODate(new Date(year, month, 1)), toISODate(lastOfMonth)]
  }, [calendarViewMode, calendarCursor, calendarWeekDates])

  const calendarPeriodTrades = useMemo(() => {
    const [start, end] = calendarPeriodRange
    return visibleTrades.filter((trade) => trade.tradeDate >= start && trade.tradeDate <= end)
  }, [visibleTrades, calendarPeriodRange])

  const calendarPeriodStats = useMemo(() => {
    const closed = calendarPeriodTrades.filter((trade) => trade.status === 'CLOSED')
    const wins = closed.filter((trade) => trade.netPnl > 0)
    const net = calendarPeriodTrades.reduce((sum, trade) => sum + trade.netPnl, 0)
    return {
      total: calendarPeriodTrades.length,
      net,
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    }
  }, [calendarPeriodTrades])

  const calendarPeriodLabel = useMemo(() => {
    if (calendarViewMode === 'Day') {
      return calendarCursor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    }
    if (calendarViewMode === 'Week') {
      const start = calendarWeekDates[0]
      const end = calendarWeekDates[6]
      const sameMonth = start.getMonth() === end.getMonth()
      const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const endLabel = end.toLocaleDateString('en-US', sameMonth ? { day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
      return `${startLabel} – ${endLabel}`
    }
    return calendarCursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }, [calendarViewMode, calendarCursor, calendarWeekDates])

  const calendarGoPrev = (): void => {
    setCalendarCursor((current) => {
      if (calendarViewMode === 'Day') return addDays(current, -1)
      if (calendarViewMode === 'Week') return addDays(current, -7)
      return new Date(current.getFullYear(), current.getMonth() - 1, 1)
    })
  }

  const calendarGoNext = (): void => {
    setCalendarCursor((current) => {
      if (calendarViewMode === 'Day') return addDays(current, 1)
      if (calendarViewMode === 'Week') return addDays(current, 7)
      return new Date(current.getFullYear(), current.getMonth() + 1, 1)
    })
  }

  const calendarGoToday = (): void => setCalendarCursor(new Date())

  const openDayInJournal = (iso: string): void => {
    setFilters((current) => ({ ...current, startDate: iso, endDate: iso }))
    setActiveTab('journal')
  }

  const analyticsStats = useMemo(() => {
    const closedTrades = visibleTrades.filter((trade) => trade.status === 'CLOSED')
    const wins = closedTrades.filter((trade) => trade.netPnl > 0)
    const losses = closedTrades.filter((trade) => trade.netPnl < 0)
    const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0)
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0))
    const avgWin = wins.length ? grossProfit / wins.length : 0
    const avgLoss = losses.length ? grossLoss / losses.length : 0
    const largestWin = wins.length ? Math.max(...wins.map((trade) => trade.netPnl)) : 0
    const largestLoss = losses.length ? Math.min(...losses.map((trade) => trade.netPnl)) : 0
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0

    const bySegment = segmentOptions.map((segment) => ({
      segment,
      net: closedTrades.filter((trade) => trade.segment === segment).reduce((sum, trade) => sum + trade.netPnl, 0),
    }))

    const equityCurve: Array<{ date: string; value: number }> = []
    let running = 0
    closedTrades
      .slice()
      .sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))
      .forEach((trade) => {
        running += trade.netPnl
        equityCurve.push({ date: trade.tradeDate, value: running })
      })

    return {
      closedCount: closedTrades.length,
      winCount: wins.length,
      lossCount: losses.length,
      grossProfit,
      grossLoss,
      avgWin,
      avgLoss,
      largestWin,
      largestLoss,
      profitFactor,
      bySegment,
      equityCurve,
    }
  }, [visibleTrades])

  const chartSeries = useMemo(() => {
    const rangeDays: Record<typeof chartRange, number> = {
      '7D': 7,
      '30D': 30,
      '3M': 90,
      '1Y': 365,
    }

    const days = rangeDays[chartRange]
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    const cutoffKey = cutoff.toISOString().slice(0, 10)

    const dailyPnl = new Map<string, number>()
    visibleTrades
      .filter((trade) => trade.status === 'CLOSED' && trade.tradeDate >= cutoffKey)
      .forEach((trade) => {
        dailyPnl.set(trade.tradeDate, (dailyPnl.get(trade.tradeDate) ?? 0) + trade.netPnl)
      })

    const sortedDates = Array.from(dailyPnl.keys()).sort()
    let running = 0
    return sortedDates.map((date) => {
      running += dailyPnl.get(date) ?? 0
      return { date, value: running }
    })
  }, [visibleTrades, chartRange])

  return (
    <div className="app-shell">
      <header className="mobile-header">
        <div className="mobile-header-left">
          <div className="brand-mark">TJ</div>
          <span>Trading Journal</span>
        </div>
        <div className="mobile-header-right">
          <div className="notifications-wrap">
            <button
              type="button"
              className="icon-btn"
              aria-label="Notifications"
              onClick={() => setNotificationsOpen((current) => !current)}
            >
              <Bell size={18} />
              {openTradesAll.length > 0 && <span className="notif-dot" />}
            </button>
            {notificationsOpen && (
              <div className="notifications-panel">
                <div className="notifications-panel-head">
                  <strong>Notifications</strong>
                </div>
                {openTradesAll.length === 0 ? (
                  <p className="empty-inline">You're all caught up — no open positions.</p>
                ) : (
                  <div className="notifications-list">
                    {openTradesAll.slice(0, 6).map((trade) => (
                      <button
                        key={trade.id}
                        type="button"
                        className="notification-item"
                        onClick={() => {
                          setActiveTab('open-trades')
                          setNotificationsOpen(false)
                        }}
                      >
                        <span className="badge badge-open">OPEN</span>
                        <span className="notification-item-copy">
                          <strong>{trade.scriptName}</strong>
                          <span>{accountAliasById(trade.accountId)} • since {trade.tradeDate}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label="Toggle theme" onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}>
            {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <button type="button" className="icon-btn" aria-label="Open menu" onClick={() => setMobileMenuOpen(true)}>
            <Menu size={18} />
          </button>
        </div>
      </header>

      {mobileMenuOpen && (
        <div className="mobile-menu-backdrop" onClick={() => setMobileMenuOpen(false)}>
          <div className="mobile-menu" onClick={(event) => event.stopPropagation()}>
            <div className="mobile-menu-header">
              <strong>Menu</strong>
              <button type="button" className="close-btn" aria-label="Close menu" onClick={() => setMobileMenuOpen(false)}>×</button>
            </div>
            <nav className="mobile-menu-nav">
              {visibleNavItems.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={shownTab === item.key ? 'nav-item active' : 'nav-item'}
                    onClick={() => { setActiveTab(item.key); onTabSelect?.(); setMobileMenuOpen(false) }}
                  >
                    <Icon size={18} />
                    <span className="nav-label">{item.label}</span>
                  </button>
                )
              })}
              {extraNav.map((item) => {
                const Icon = item.icon
                return (
                  <button key={item.key} type="button" className={item.active ? 'nav-item active' : 'nav-item'} onClick={() => { item.onClick(); setMobileMenuOpen(false) }}>
                    <Icon size={18} />
                    <span className="nav-label">{item.label}</span>
                  </button>
                )
              })}
            </nav>
            <div className="mobile-menu-footer">
              <div className="eyebrow">Current Account</div>
              <select
                value={selectedAccount}
                aria-label="Trading account"
                onChange={(event) => setSelectedAccount(event.target.value)}
              >
                <option value="all">All Accounts</option>
                {accountOptions.map((account) => (
                  <option key={account.id} value={account.id}>
                    {getAccountAlias(account)}
                  </option>
                ))}
              </select>
              <div className="sidebar-status" style={{ marginTop: 16 }}>
                <span className="sidebar-status-dot"><span className="dot" />Online</span>
                <small>Local Data • Offline Ready</small>
              </div>
            </div>
          </div>
        </div>
      )}

      <header className="topbar">
        <div className="header-left">
          <div className="brand-wrap">
            <div className="brand-mark">TJ</div>
            <div className="brand-copy">
              <div className="eyebrow">Trading Journal</div>
              <h1>Portfolio Ledger</h1>
            </div>
          </div>
        </div>

        {mode !== 'business' && (
          <div className="header-center">
            <div className="account-selector-wrap">
              <div className="eyebrow">Trading Account</div>
              <div className="account-selector-row">
                <select
                  value={selectedAccount}
                  aria-label="Trading account"
                  onChange={(event) => setSelectedAccount(event.target.value)}
                >
                  <option value="all">All Accounts</option>
                  {accountOptions.map((account) => (
                    <option key={account.id} value={account.id}>
                      {getAccountAlias(account)}
                    </option>
                  ))}
                </select>
                {isPersonal && (
                  <button type="button" className="icon-btn" aria-label="Add trading account" onClick={() => openAccountForm()}>
                    <Plus size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="header-right">
          <div className="search-box">
            <Search size={16} />
            <input
              type="text"
              placeholder="Search trades, scripts, reasons..."
              aria-label="Search trades"
              value={filters.search}
              onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
            />
          </div>
          <div className="notifications-wrap">
            <button
              type="button"
              className="icon-btn"
              aria-label="Notifications"
              onClick={() => setNotificationsOpen((current) => !current)}
            >
              <Bell size={18} />
              {openTradesAll.length > 0 && <span className="notif-dot" />}
            </button>
            {notificationsOpen && (
              <div className="notifications-panel">
                <div className="notifications-panel-head">
                  <strong>Notifications</strong>
                </div>
                {openTradesAll.length === 0 ? (
                  <p className="empty-inline">You're all caught up — no open positions.</p>
                ) : (
                  <div className="notifications-list">
                    {openTradesAll.slice(0, 6).map((trade) => (
                      <button
                        key={trade.id}
                        type="button"
                        className="notification-item"
                        onClick={() => {
                          setActiveTab('open-trades')
                          setNotificationsOpen(false)
                        }}
                      >
                        <span className="badge badge-open">OPEN</span>
                        <span className="notification-item-copy">
                          <strong>{trade.scriptName}</strong>
                          <span>{accountAliasById(trade.accountId)} • since {trade.tradeDate}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <button type="button" className="icon-btn" aria-label="Toggle theme" onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}>
            {theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <div className="profile-inline" title={profileName || 'Set your name'}>
            <div className="profile-avatar">
              {getInitials(profileName) || <User size={16} />}
            </div>
          </div>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          {onGoHome && (
            <button type="button" className="nav-item sidebar-back-btn" onClick={onGoHome}>
              <ArrowLeft size={18} />
              <span className="nav-label">Modes</span>
            </button>
          )}
          <nav className="sidebar-nav">
            {visibleNavItems.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.key}
                  type="button"
                  className={shownTab === item.key ? 'nav-item active' : 'nav-item'}
                  onClick={() => { setActiveTab(item.key); onTabSelect?.() }}
                >
                  <Icon size={18} />
                  <span className="nav-label">{item.label}</span>
                </button>
              )
            })}
            {extraNav.map((item) => {
              const Icon = item.icon
              return (
                <button key={item.key} type="button" className={item.active ? 'nav-item active' : 'nav-item'} onClick={item.onClick}>
                  <Icon size={18} />
                  <span className="nav-label">{item.label}</span>
                </button>
              )
            })}
          </nav>

          <div className="sidebar-footer">
            <div className="sidebar-status">
              <span className="sidebar-status-dot"><span className="dot" />Online</span>
              <small>Local Data • Offline Ready</small>
            </div>
            <div className="sidebar-shield">
              <ShieldCheck size={18} />
              <p>Your data is stored locally on this device</p>
            </div>
          </div>
        </aside>

        <main className="content">
          {message && (
            <div className="status-bar">
              <span>{message}</span>
              <span className="offline-tag">Local Data</span>
            </div>
          )}

          {extraPage}

          {shownTab === 'dashboard' && (
            <section className="dashboard-panel">
              <div className="dashboard-header-row">
                <div>
                  <h2 className="dashboard-greeting">{getGreeting()}{profileName ? `, ${profileName}` : ''}</h2>
                  <p className="dashboard-subtitle">Track. Analyse. Improve. — Your Trading Journey</p>
                </div>
                {!readOnly && (
                  <div className="dashboard-actions">
                    {!readOnly && (
                      <button type="button" className="primary-btn" onClick={() => openTradeForm()}>
                        <Plus size={18} />
                        Add Trade
                      </button>
                    )}
                    <button type="button" className="secondary-btn" onClick={() => openTradeForm(undefined, true)}>
                      <Zap size={16} />
                      Quick Add
                    </button>
                  </div>
                )}
              </div>

              {isLoading ? (
                <div className="card-grid">
                  <div className="skeleton skeleton-card" />
                  <div className="skeleton skeleton-card" />
                  <div className="skeleton skeleton-card" />
                  <div className="skeleton skeleton-card" />
                </div>
              ) : (
                <div className="card-grid dashboard-cards">
                  <div className="stat-card profit-card">
                    <div className="stat-card-head">
                      <span>Net P/L</span>
                      <div className="stat-icon"><TrendingUp size={16} /></div>
                    </div>
                    <strong>{getPnlLabel(summary.net)}</strong>
                    <small>{summary.netPercent >= 0 ? '↗' : '↘'} {summary.netPercent >= 0 ? '+' : ''}{summary.netPercent.toFixed(1)}%</small>
                  </div>
                  <div className="stat-card blue-card">
                    <div className="stat-card-head">
                      <span>Win Rate</span>
                      <div className="stat-icon"><Target size={16} /></div>
                    </div>
                    <strong>{summary.winRate.toFixed(1)}%</strong>
                    <small>{summary.winningTrades} Wins / {summary.total} Trades</small>
                  </div>
                  <div className="stat-card purple-card">
                    <div className="stat-card-head">
                      <span>Total Trades</span>
                      <div className="stat-icon"><ListChecks size={16} /></div>
                    </div>
                    <strong>{summary.total}</strong>
                    <small>{selectedAccountName}</small>
                  </div>
                  <div className="stat-card amber-card">
                    <div className="stat-card-head">
                      <span>Open Trades</span>
                      <div className="stat-icon"><Clock3 size={16} /></div>
                    </div>
                    <strong>{summary.open}</strong>
                    <small>Active Positions</small>
                  </div>
                </div>
              )}

              <div className="analytics-split">
                <div className="mini-panel account-performance-card">
                  <div className="section-header-inline">
                    <div>
                      <h3>Account Performance</h3>
                      <p>Net P/L by Account</p>
                    </div>
                    <button type="button" className="text-link" onClick={() => setActiveTab('accounts')}>View All →</button>
                  </div>

                  <div className="account-mini-list">
                    {accountOptions.length === 0 ? (
                      <p className="empty-inline">No accounts yet. Add one to get started.</p>
                    ) : (
                      accountOptions.map((account) => {
                        const accountTrades = trades.filter((trade) => trade.accountId === account.id)
                        const accountNet = getNetPnl(accountTrades)
                        const invested = accountTrades
                          .filter((trade) => trade.status === 'CLOSED')
                          .reduce((sum, trade) => sum + trade.entryPrice * trade.quantity, 0)
                        const percent = invested > 0 ? (accountNet / invested) * 100 : 0

                        return (
                          <button
                            key={account.id}
                            type="button"
                            className={selectedAccount === account.id ? 'account-mini active' : 'account-mini'}
                            onClick={() => setSelectedAccount(account.id)}
                          >
                            <div className="broker-badge" style={{ background: brokerColor(account.accountName) }}>
                              {getAccountAlias(account)}
                            </div>
                            <div className="account-mini-copy">
                              <strong>{getAccountAlias(account)}</strong>
                              <span>{getPnlLabel(accountNet)}</span>
                            </div>
                            <div className={accountNet >= 0 ? 'account-mini-percent profit' : 'account-mini-percent loss'}>
                              {accountNet >= 0 ? '+' : ''}{percent.toFixed(1)}%
                            </div>
                          </button>
                        )
                      })
                    )}
                  </div>
                </div>

                <div className="mini-panel pnl-chart-card">
                  <div className="section-header-inline">
                    <div>
                      <h3>P/L Overview</h3>
                    </div>
                    <div className="range-toggle">
                      {(['7D', '30D', '3M', '1Y'] as const).map((range) => (
                        <button
                          key={range}
                          type="button"
                          className={chartRange === range ? 'range-pill active' : 'range-pill'}
                          onClick={() => setChartRange(range)}
                        >
                          {range}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="chart-canvas" aria-label="P/L chart">
                    {(() => {
                      const geometry = buildChartGeometry(chartSeries, 640, 230)
                      if (!geometry) {
                        return <div className="chart-empty">No closed trades in this range yet.</div>
                      }

                      const strokeColor = geometry.isPositive ? 'var(--success)' : 'var(--danger)'
                      const fillColor = geometry.isPositive ? 'var(--success-soft)' : 'var(--danger-soft)'

                      return (
                        <svg viewBox="0 0 640 230" preserveAspectRatio="none">
                          {[0.2, 0.4, 0.6, 0.8].map((fraction) => (
                            <line
                              key={fraction}
                              x1={0}
                              x2={640}
                              y1={230 * fraction}
                              y2={230 * fraction}
                              stroke="var(--border)"
                              strokeWidth={1}
                            />
                          ))}
                          <path d={geometry.areaPath} fill={fillColor} stroke="none" />
                          <path d={geometry.linePath} fill="none" stroke={strokeColor} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )
                    })()}
                  </div>
                </div>
              </div>

              <div className="mini-panel">
                <div className="dashboard-recent-head">
                  <h3>Recent Trades</h3>
                  <button type="button" className="text-link" onClick={() => setActiveTab('journal')}>View All →</button>
                </div>

                {isLoading ? (
                  <div className="table-wrap">
                    <div className="skeleton skeleton-row" />
                  </div>
                ) : visibleTrades.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state-icon"><NotebookPen size={22} /></div>
                    <h3>No trades yet</h3>
                    <p>Start recording your trading journey.</p>
                    {!readOnly && (
                      <button type="button" className="primary-btn" onClick={() => openTradeForm()}>
                        <Plus size={18} />
                        Add Trade
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Date</th>
                            <th>Segment</th>
                            <th>Script</th>
                            <th>Reason</th>
                            <th>Qty</th>
                            <th>B/S</th>
                            <th>Entry</th>
                            <th>Exit Date</th>
                            <th>Exit</th>
                            <th>P/L</th>
                            <th>Status</th>
                            <th>Account</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleTrades.slice(0, 5).map((trade, index) => (
                            <tr key={trade.id} onClick={() => { setActiveTab('journal'); setSelectedTradeId(trade.id) }}>
                              <td>{index + 1}</td>
                              <td>{trade.tradeDate}</td>
                              <td><span className={segmentBadgeClass[trade.segment]}>{segmentShortLabel[trade.segment]}</span></td>
                              <td>{trade.scriptName}</td>
                              <td>{trade.reason}</td>
                              <td>{trade.quantity}</td>
                              <td><span className={trade.side === 'BUY' ? 'badge badge-buy' : 'badge badge-sell'}>{trade.side}</span></td>
                              <td>{trade.entryPrice}</td>
                              <td>{trade.exitDate || '—'}</td>
                              <td>{trade.exitPrice > 0 ? trade.exitPrice : '—'}</td>
                              <td className={trade.netPnl >= 0 ? 'profit' : 'loss'}>{trade.status === 'CLOSED' ? getPnlLabel(trade.netPnl) : '—'}</td>
                              <td><span className={trade.status === 'OPEN' ? 'badge badge-open' : 'badge badge-closed'}>{trade.status}</span></td>
                              <td>{accountAliasById(trade.accountId)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="trade-card-list">
                      {visibleTrades.slice(0, 5).map((trade) => renderMobileTradeCard(trade, () => { setActiveTab('journal'); setSelectedTradeId(trade.id) }))}
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {shownTab === 'journal' && (
            <section className="panel">
              <div className="page-header-row">
                <div>
                  <h2>Journal</h2>
                  <p>{selectedAccountName}{filters.script ? ` • ${filters.script}` : ''}</p>
                </div>
                <button
                  type="button"
                  className="primary-btn"
                  disabled={visibleTrades.length === 0}
                  onClick={() => openExportModal('view')}
                >
                  <Download size={16} />
                  Export
                </button>
              </div>

              <div className="toolbar filters">
                <div className="filter-group search-filter">
                  <Search size={16} />
                  <input
                    type="search"
                    value={filters.search}
                    placeholder="Search script, reason, notes or ID"
                    onChange={(event) => setFilters({ ...filters, search: event.target.value })}
                  />
                </div>
                <div className="filter-chip-row">
                  <select value={filters.script} onChange={(event) => setFilters({ ...filters, script: event.target.value })}>
                    <option value="">All Stocks</option>
                    {stockSummaries.map((row) => (
                      <option key={row.scriptName} value={row.scriptName}>
                        {row.scriptName}
                      </option>
                    ))}
                  </select>
                  <select value={filters.segment} onChange={(event) => setFilters({ ...filters, segment: event.target.value })}>
                    <option value="all">All Segments</option>
                    {segmentOptions.map((segment) => (
                      <option key={segment} value={segment}>
                        {segment}
                      </option>
                    ))}
                  </select>
                  <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
                    <option value="all">All Status</option>
                    <option value="OPEN">OPEN</option>
                    <option value="CLOSED">CLOSED</option>
                  </select>
                  <select value={filters.side} onChange={(event) => setFilters({ ...filters, side: event.target.value })}>
                    <option value="all">All Sides</option>
                    <option value="BUY">BUY</option>
                    <option value="SELL">SELL</option>
                  </select>
                  <select value={filters.pnl} onChange={(event) => setFilters({ ...filters, pnl: event.target.value })}>
                    <option value="all">Win / Loss</option>
                    <option value="winning">Winning</option>
                    <option value="losing">Losing</option>
                  </select>
                  <input type="date" value={filters.startDate} onChange={(event) => setFilters({ ...filters, startDate: event.target.value })} />
                  <input type="date" value={filters.endDate} onChange={(event) => setFilters({ ...filters, endDate: event.target.value })} />
                  <button type="button" className="secondary-btn filter-btn" onClick={() => setFilters(defaultJournalFilters)}>
                    <Filter size={16} />
                    Clear Filters
                  </button>
                </div>
              </div>

              {!filters.script && stockSummaries.length > 0 && (
                <div className="stock-panel">
                  <div className="section-header-inline">
                    <div>
                      <h3>Stocks in {selectedAccountName}</h3>
                      <p>Tap a script to drill into its trade history</p>
                    </div>
                  </div>
                  <div className="stock-grid">
                    {stockSummaries.map((row) => (
                      <button
                        key={row.scriptName}
                        type="button"
                        className="stock-card"
                        onClick={() => setFilters({ ...filters, script: row.scriptName })}
                      >
                        <strong>{row.scriptName}</strong>
                        <span>{row.totalTrades} {row.totalTrades === 1 ? 'Trade' : 'Trades'}</span>
                        <span className={row.netPnl >= 0 ? 'profit' : 'loss'}>{getPnlLabel(row.netPnl)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {filters.script && selectedStockSummary && (
                <div className="stock-panel">
                  <div className="section-header-inline">
                    <div>
                      <h3>{filters.script}</h3>
                      <p>{selectedAccountName} • Stock performance overview</p>
                    </div>
                    <button type="button" className="text-link" onClick={() => setFilters({ ...filters, script: '' })}>← Change Stock</button>
                  </div>
                  <div className="stock-stats-grid">
                    <div><span>Total Trades</span><strong>{selectedStockSummary.totalTrades}</strong></div>
                    <div><span>Open</span><strong>{selectedStockSummary.openTrades}</strong></div>
                    <div><span>Closed</span><strong>{selectedStockSummary.closedTrades}</strong></div>
                    <div><span>Winning</span><strong className="profit">{selectedStockSummary.winningTrades}</strong></div>
                    <div><span>Losing</span><strong className="loss">{selectedStockSummary.losingTrades}</strong></div>
                    <div><span>Win Rate</span><strong>{selectedStockSummary.winRate.toFixed(1)}%</strong></div>
                    <div><span>Net P/L</span><strong className={selectedStockSummary.netPnl >= 0 ? 'profit' : 'loss'}>{getPnlLabel(selectedStockSummary.netPnl)}</strong></div>
                    <div><span>Avg P/L</span><strong className={selectedStockSummary.avgPnl >= 0 ? 'profit' : 'loss'}>{getPnlLabel(selectedStockSummary.avgPnl)}</strong></div>
                  </div>
                </div>
              )}

              {visibleTrades.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon"><NotebookPen size={22} /></div>
                  <h3>{trades.length === 0 ? 'No trades yet' : 'No trades found for this selection'}</h3>
                  <p>{trades.length === 0 ? 'Start recording your trading journey.' : 'Try adjusting your filters or clearing them.'}</p>
                  {trades.length === 0 ? (
                    !readOnly && (
                      <button type="button" className="primary-btn" onClick={() => openTradeForm()}>
                        <Plus size={18} />
                        Add Trade
                      </button>
                    )
                  ) : (
                    <button type="button" className="secondary-btn" onClick={() => setFilters(defaultJournalFilters)}>
                      <Filter size={16} />
                      Clear Filters
                    </button>
                  )}
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Date</th>
                        <th>Segment</th>
                        <th>Script</th>
                        <th>Reason</th>
                        <th>Qty</th>
                        <th>B/S</th>
                        <th>Entry</th>
                        <th>Exit Date</th>
                        <th>Exit</th>
                        <th>P/L</th>
                        <th>Status</th>
                        <th>Account</th>
                        <th aria-label="Chart" />
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTrades.map((trade, index) => (
                        <tr key={trade.id} onClick={() => setSelectedTradeId(trade.id)} className={selectedTradeId === trade.id ? 'selected-row' : ''}>
                          <td>{index + 1}</td>
                          <td>{trade.tradeDate}</td>
                          <td><span className={segmentBadgeClass[trade.segment]}>{segmentShortLabel[trade.segment]}</span></td>
                          <td>{trade.scriptName}</td>
                          <td>{trade.reason}</td>
                          <td>{trade.quantity}</td>
                          <td><span className={trade.side === 'BUY' ? 'badge badge-buy' : 'badge badge-sell'}>{trade.side}</span></td>
                          <td>{trade.entryPrice}</td>
                          <td>{trade.exitDate || '—'}</td>
                          <td>{trade.exitPrice > 0 ? trade.exitPrice : '—'}</td>
                          <td className={trade.netPnl >= 0 ? 'profit' : 'loss'}>{trade.status === 'CLOSED' ? getPnlLabel(trade.netPnl) : '—'}</td>
                          <td><span className={trade.status === 'OPEN' ? 'badge badge-open' : 'badge badge-closed'}>{trade.status}</span></td>
                          <td>{accountAliasById(trade.accountId)}</td>
                          <td>
                            <button
                              type="button"
                              className="secondary-btn chart-open-btn"
                              onClick={(event) => { event.stopPropagation(); openChart(trade.scriptName, trade.accountId, trade.id) }}
                            >
                              <CandlestickChart size={14} />
                              Chart
                            </button>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="row-actions-btn"
                              aria-label="Trade options"
                              onClick={(event) => { event.stopPropagation(); setSelectedTradeId(trade.id) }}
                            >
                              <MoreVertical size={15} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {visibleTrades.length > 0 && (
                <div className="trade-card-list">
                  {visibleTrades.map((trade) => renderMobileTradeCard(trade))}
                </div>
              )}

              {selectedTrade && (
                <div className="detail-card">
                  <div className="detail-header">
                    <div>
                      <h3>{selectedTrade.scriptName}</h3>
                      <p>{selectedTrade.reason}</p>
                    </div>
                    <div className="detail-actions">
                      {!readOnly && (
                        <>
                          <button type="button" className="secondary-btn" onClick={() => openTradeForm(selectedTrade)}>
                            Edit
                          </button>
                          <button type="button" className="secondary-btn" onClick={() => void handleCloseTrade(selectedTrade)}>
                            Close Trade
                          </button>
                          <button type="button" className="danger-btn" onClick={() => void handleTradeDelete(selectedTrade.id)}>
                            Delete
                          </button>
                        </>
                      )}
                      <button type="button" className="close-btn" aria-label="Close trade details" onClick={() => setSelectedTradeId(null)}>×</button>
                    </div>
                  </div>

                  <div className="detail-grid">
                    <div><strong>Account</strong><span>{accountAliasById(selectedTrade.accountId)}</span></div>
                    <div><strong>Date</strong><span>{selectedTrade.tradeDate}</span></div>
                    <div><strong>Segment</strong><span>{selectedTrade.segment}</span></div>
                    <div><strong>Quantity</strong><span>{selectedTrade.quantity}</span></div>
                    <div><strong>Side</strong><span>{selectedTrade.side}</span></div>
                    <div><strong>Entry Price</strong><span>{selectedTrade.entryPrice}</span></div>
                    <div><strong>Exit Date</strong><span>{selectedTrade.exitDate || '-'}</span></div>
                    <div><strong>Exit Price</strong><span>{selectedTrade.exitPrice || '-'}</span></div>
                    <div><strong>Status</strong><span>{selectedTrade.status}</span></div>
                    <div><strong>Net P/L</strong><span>{getPnlLabel(selectedTrade.netPnl)}</span></div>
                    <div className="span-2"><strong>Notes</strong><span>{selectedTrade.notes || 'No notes added.'}</span></div>
                  </div>

                  {selectedTradeAttachment && (
                    <div className="trade-screenshot">
                      <strong>Chart Screenshot</strong>
                      <button type="button" className="trade-screenshot-thumb" onClick={() => setLightboxOpen(true)}>
                        <img src={selectedTradeAttachment} alt="Trade chart screenshot" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {shownTab === 'open-trades' && (
            <section className="panel">
              <div className="page-header-row">
                <div>
                  <h2>Open Trades</h2>
                  <p>Monitor your active positions.</p>
                </div>
              </div>

              {openTrades.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon"><Clock3 size={22} /></div>
                  <h3>No open trades yet</h3>
                  <p>Start tracking your current positions from the dashboard.</p>
                  {!readOnly && (
                    <button type="button" className="primary-btn" onClick={() => openTradeForm()}>
                      <Plus size={18} />
                      Add Trade
                    </button>
                  )}
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Script</th>
                        <th>Account</th>
                        <th>Side</th>
                        <th>Qty</th>
                        <th>Entry</th>
                        <th>Current</th>
                        <th>Unrealized P/L</th>
                        <th>Date</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openTrades.map((trade) => (
                        <tr key={trade.id}>
                          <td>{trade.scriptName}</td>
                          <td>{accountAliasById(trade.accountId)}</td>
                          <td><span className={trade.side === 'BUY' ? 'badge badge-buy' : 'badge badge-sell'}>{trade.side}</span></td>
                          <td>{trade.quantity}</td>
                          <td>{trade.entryPrice}</td>
                          <td>{trade.exitPrice || trade.entryPrice}</td>
                          <td className={trade.netPnl >= 0 ? 'profit' : 'loss'}>{getPnlLabel(trade.netPnl)}</td>
                          <td>{trade.tradeDate}</td>
                          <td>{!readOnly && <button type="button" className="secondary-btn" onClick={() => void handleCloseTrade(trade)}>Close Trade</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {openTrades.length > 0 && (
                <div className="trade-card-list">
                  {openTrades.map((trade) => (
                    <div key={trade.id} className="trade-card" style={{ cursor: 'default' }}>
                      <div className="trade-card-top">
                        <strong>{trade.scriptName}</strong>
                        <span className="trade-card-alias">{accountAliasById(trade.accountId)}</span>
                      </div>
                      <div className="trade-card-meta">
                        <span className={trade.side === 'BUY' ? 'badge badge-buy' : 'badge badge-sell'}>{trade.side}</span>
                        <span>{trade.quantity} Qty</span>
                      </div>
                      <div className="trade-card-rows">
                        <div><span>Entry</span><strong>₹{trade.entryPrice}</strong></div>
                        <div><span>Current</span><strong>₹{trade.exitPrice || trade.entryPrice}</strong></div>
                        <div><span>Date</span><strong>{trade.tradeDate}</strong></div>
                      </div>
                      <div className="trade-card-footer">
                        <span className={trade.netPnl >= 0 ? 'profit' : 'loss'}>{getPnlLabel(trade.netPnl)}</span>
                        {!readOnly && <button type="button" className="secondary-btn" onClick={() => void handleCloseTrade(trade)}>Close Trade</button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {shownTab === 'calendar' && (
            <section className="panel calendar-panel">
              <div className="page-header-row">
                <div>
                  <h2>Calendar</h2>
                  <p>Track your trading activity, P/L and performance by date.</p>
                </div>
              </div>

              <div className="calendar-layout">
                <div className="calendar-main">
                  <div className="calendar-toolbar">
                    <div className="calendar-nav">
                      <button type="button" className="calendar-nav-btn" onClick={calendarGoPrev} aria-label="Previous">
                        <ChevronLeft size={16} />
                      </button>
                      <button type="button" className="calendar-nav-btn" onClick={calendarGoToday} aria-label="Today">
                        <CalendarDays size={16} />
                      </button>
                      <span className="calendar-period-label">{calendarPeriodLabel}</span>
                      <button type="button" className="calendar-nav-btn" onClick={calendarGoNext} aria-label="Next">
                        <ChevronRight size={16} />
                      </button>
                    </div>
                    <div className="range-toggle">
                      {(['Month', 'Week', 'Day'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={calendarViewMode === mode ? 'range-pill active' : 'range-pill'}
                          onClick={() => setCalendarViewMode(mode)}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>

                  {calendarViewMode === 'Day' ? (
                    <div className="calendar-day-view">
                      {(() => {
                        const iso = toISODate(calendarCursor)
                        const dayTrades = calendarPeriodTrades
                        return dayTrades.length === 0 ? (
                          <div className="empty-state">
                            <div className="empty-state-icon"><CalendarDays size={22} /></div>
                            <h3>No trades on this day</h3>
                            <p>Trades logged for this date will appear here.</p>
                            {!readOnly && (
                              <button type="button" className="primary-btn" onClick={() => openTradeForm()}>
                                <Plus size={18} />
                                Add Trade
                              </button>
                            )}
                          </div>
                        ) : (
                          <button type="button" className="calendar-day-view-summary" onClick={() => openDayInJournal(iso)}>
                            <strong>{dayTrades.length} {dayTrades.length === 1 ? 'trade' : 'trades'}</strong>
                            <em className={calendarPeriodStats.net >= 0 ? 'profit' : 'loss'}>{getPnlLabel(calendarPeriodStats.net)}</em>
                            <span>View in Journal →</span>
                          </button>
                        )
                      })()}
                    </div>
                  ) : (
                    <>
                      <div className="calendar-weekday-row">
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                          <div key={d} className="calendar-weekday">{d}</div>
                        ))}
                      </div>
                      <div className={calendarViewMode === 'Week' ? 'calendar-month-grid calendar-week-grid' : 'calendar-month-grid'}>
                        {(calendarViewMode === 'Week' ? [calendarWeekDates] : calendarMonthWeeks).map((week, wi) =>
                          week.map((date, di) => {
                            const iso = toISODate(date)
                            const payload = calendarDayMap.get(iso)
                            const inMonth = calendarViewMode === 'Week' || date.getMonth() === calendarCursor.getMonth()
                            const isToday = iso === toISODate(new Date())
                            const dotClass = !payload ? '' : payload.pnl > 0 ? 'profitable' : payload.pnl < 0 ? 'loss' : 'flat'
                            return (
                              <button
                                key={`${wi}-${di}`}
                                type="button"
                                className={`calendar-cell ${inMonth ? '' : 'outside-month'} ${isToday ? 'is-today' : ''}`}
                                onClick={() => openDayInJournal(iso)}
                              >
                                <span className="calendar-cell-date">{date.getDate()}</span>
                                {payload && (
                                  <span className="calendar-cell-detail">
                                    <span className={`calendar-cell-dot ${dotClass}`} />
                                    {payload.count} {payload.count === 1 ? 'trade' : 'trades'}
                                  </span>
                                )}
                              </button>
                            )
                          }),
                        )}
                      </div>
                    </>
                  )}
                </div>

                <aside className="calendar-sidebar">
                  <h3>{calendarPeriodLabel}</h3>
                  <div className="calendar-legend">
                    <span><span className="calendar-cell-dot profitable" /> Profitable</span>
                    <span><span className="calendar-cell-dot loss" /> Loss</span>
                    <span><span className="calendar-cell-dot flat" /> No Trades</span>
                  </div>

                  <div className="calendar-stat-row">
                    <div className="stat-icon"><ListChecks size={16} /></div>
                    <div>
                      <span>Total Trades</span>
                      <strong>{calendarPeriodStats.total}</strong>
                    </div>
                  </div>
                  <div className="calendar-stat-row">
                    <div className="stat-icon"><TrendingUp size={16} /></div>
                    <div>
                      <span>Net P/L</span>
                      <strong className={calendarPeriodStats.net >= 0 ? 'profit' : 'loss'}>{getPnlLabel(calendarPeriodStats.net)}</strong>
                    </div>
                  </div>
                  <div className="calendar-stat-row">
                    <div className="stat-icon"><Target size={16} /></div>
                    <div>
                      <span>Win Rate</span>
                      <strong>{calendarPeriodStats.winRate.toFixed(1)}%</strong>
                    </div>
                  </div>

                  {!readOnly && (
                    <>
                      <h4 className="calendar-quick-actions-title">Quick Actions</h4>
                      <div className="calendar-quick-actions">
                        <button type="button" className="primary-btn" onClick={() => openTradeForm()}>
                          <Plus size={16} />
                          Add Trade
                        </button>
                        <button type="button" className="secondary-btn" onClick={() => setActiveTab('analytics')}>
                          <BarChart3 size={16} />
                          View Reports
                        </button>
                      </div>
                    </>
                  )}
                </aside>
              </div>
            </section>
          )}

          {shownTab === 'analytics' && (
            <section className="panel analytics-panel">
              <div className="page-header-row">
                <div>
                  <h2>Analytics</h2>
                  <p>Performance breakdown for {selectedAccountName}.</p>
                </div>
              </div>

              {analyticsStats.closedCount === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon"><BarChart3 size={22} /></div>
                  <h3>Unable to show analytics yet</h3>
                  <p>Your journal data is safe — close a trade to see performance metrics here.</p>
                </div>
              ) : (
                <>
                  <div className="card-grid compact">
                    <div className="stat-card">
                      <span>Net P/L</span>
                      <strong className={summary.net >= 0 ? 'profit' : 'loss'}>{getPnlLabel(summary.net)}</strong>
                    </div>
                    <div className="stat-card">
                      <span>Win Rate</span>
                      <strong>{summary.winRate.toFixed(1)}%</strong>
                    </div>
                    <div className="stat-card">
                      <span>Profit Factor</span>
                      <strong>{analyticsStats.profitFactor === Infinity ? '∞' : analyticsStats.profitFactor.toFixed(2)}</strong>
                    </div>
                    <div className="stat-card">
                      <span>Average Win</span>
                      <strong className="profit">{getPnlLabel(analyticsStats.avgWin)}</strong>
                    </div>
                    <div className="stat-card">
                      <span>Average Loss</span>
                      <strong className="loss">{getPnlLabel(-analyticsStats.avgLoss)}</strong>
                    </div>
                    <div className="stat-card">
                      <span>Largest Win</span>
                      <strong className="profit">{getPnlLabel(analyticsStats.largestWin)}</strong>
                    </div>
                    <div className="stat-card">
                      <span>Largest Loss</span>
                      <strong className="loss">{getPnlLabel(analyticsStats.largestLoss)}</strong>
                    </div>
                  </div>

                  <div className="analytics-split">
                    <div className="mini-panel">
                      <div className="section-header-inline">
                        <div>
                          <h3>Equity Curve</h3>
                          <p>Cumulative net P/L over closed trades</p>
                        </div>
                      </div>
                      <div className="chart-canvas" aria-label="Equity curve">
                        {(() => {
                          const geometry = buildChartGeometry(analyticsStats.equityCurve, 640, 230)
                          if (!geometry) {
                            return <div className="chart-empty">No closed trades yet.</div>
                          }
                          const strokeColor = geometry.isPositive ? 'var(--success)' : 'var(--danger)'
                          const fillColor = geometry.isPositive ? 'var(--success-soft)' : 'var(--danger-soft)'
                          return (
                            <svg viewBox="0 0 640 230" preserveAspectRatio="none">
                              {[0.2, 0.4, 0.6, 0.8].map((fraction) => (
                                <line key={fraction} x1={0} x2={640} y1={230 * fraction} y2={230 * fraction} stroke="var(--border)" strokeWidth={1} />
                              ))}
                              <path d={geometry.areaPath} fill={fillColor} stroke="none" />
                              <path d={geometry.linePath} fill="none" stroke={strokeColor} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )
                        })()}
                      </div>
                    </div>

                    <div className="mini-panel">
                      <div className="section-header-inline">
                        <div>
                          <h3>Profit by Segment</h3>
                          <p>Net P/L split by CASH / FUTURES / OPTIONS</p>
                        </div>
                      </div>
                      <div className="account-mini-list">
                        {analyticsStats.bySegment.map(({ segment, net }) => {
                          const maxAbs = Math.max(1, ...analyticsStats.bySegment.map((row) => Math.abs(row.net)))
                          const widthPct = (Math.abs(net) / maxAbs) * 100
                          return (
                            <div key={segment} className="account-mini" style={{ cursor: 'default' }}>
                              <span className={segmentBadgeClass[segment]}>{segmentShortLabel[segment]}</span>
                              <div className="account-mini-copy">
                                <div className="mini-bar-track">
                                  <div
                                    className="mini-bar-fill"
                                    style={{ width: `${widthPct}%`, background: net >= 0 ? 'var(--success)' : 'var(--danger)' }}
                                  />
                                </div>
                              </div>
                              <div className={net >= 0 ? 'account-mini-percent profit' : 'account-mini-percent loss'}>{getPnlLabel(net)}</div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="mini-panel">
                    <div className="section-header-inline">
                      <div>
                        <h3>Win / Loss Distribution</h3>
                        <p>{analyticsStats.winCount} wins · {analyticsStats.lossCount} losses out of {analyticsStats.closedCount} closed trades</p>
                      </div>
                    </div>
                    <div style={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', marginTop: 14, border: '1px solid var(--border)' }}>
                      <div style={{ width: `${(analyticsStats.winCount / Math.max(1, analyticsStats.closedCount)) * 100}%`, background: 'var(--success)' }} />
                      <div style={{ width: `${(analyticsStats.lossCount / Math.max(1, analyticsStats.closedCount)) * 100}%`, background: 'var(--danger)' }} />
                    </div>
                  </div>
                </>
              )}
            </section>
          )}

          {shownTab === 'accounts' && isPersonal && (
            <section className="panel">
              <div className="page-header-row">
                <div>
                  <h2>Trading Accounts</h2>
                  <p>Manage your trading accounts and track performance separately.</p>
                </div>
                <button type="button" className="primary-btn" onClick={() => openAccountForm()}>
                  <Plus size={18} />
                  Add Account
                </button>
              </div>

              {accountOptions.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon"><Landmark size={22} /></div>
                  <h3>No trading accounts yet</h3>
                  <p>Add a broker account to start separating your P/L.</p>
                  <button type="button" className="primary-btn" onClick={() => openAccountForm()}>
                    <Plus size={18} />
                    Add Account
                  </button>
                </div>
              ) : (
              <div className="account-list">
                {accountOptions.map((account) => {
                  const accountTrades = trades.filter((trade) => trade.accountId === account.id)
                  const net = getNetPnl(accountTrades)
                  const winRate = accountTrades.length ? (accountTrades.filter((trade) => trade.netPnl > 0).length / accountTrades.length) * 100 : 0
                  const isRemoteOnly = remoteOnlyAccountIds.has(account.id)

                  return (
                    <div key={account.id} className="account-card premium-account-card">
                      <div className="account-card-top">
                        <div className="broker-symbol" style={{ background: brokerColor(account.accountName), color: 'white' }}>
                          {getAccountAlias(account)}
                        </div>
                        <div className="account-broker-copy">
                          <h3>{account.accountName}</h3>
                          <p>Alias: {getAccountAlias(account)} • {account.brokerName} • {account.accountType}</p>
                        </div>
                        <span className="status-pill">{isRemoteOnly ? '● Shared (read-only)' : '● Active'}</span>
                      </div>

                      <div className="account-metrics-row">
                        <div>
                          <label>Net P/L</label>
                          <strong>{getPnlLabel(net)}</strong>
                        </div>
                        <div>
                          <label>Trades</label>
                          <strong>{accountTrades.length}</strong>
                        </div>
                        <div>
                          <label>Win Rate</label>
                          <strong>{winRate.toFixed(1)}%</strong>
                        </div>
                      </div>

                      <div className="mini-actions account-actions">
                        <button
                          type="button"
                          className="primary-btn"
                          onClick={() => { setSelectedAccount(account.id); setFilters(defaultJournalFilters); setActiveTab('journal') }}
                        >
                          View Stocks
                        </button>
                        {!isRemoteOnly && (
                          <>
                            <button type="button" className="secondary-btn" onClick={() => openAccountForm(account)}>
                              Edit
                            </button>
                            <button type="button" className="secondary-btn" onClick={() => void handleArchiveAccount(account.id)}>
                              Archive
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              )}

              {archivedAccounts.length > 0 && (
                <div style={{ marginTop: 24 }}>
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => setShowArchived((current) => !current)}
                  >
                    {showArchived ? 'Hide' : 'Show'} Archived Accounts ({archivedAccounts.length})
                  </button>

                  {showArchived && (
                    <div className="account-list" style={{ marginTop: 12 }}>
                      {archivedAccounts.map((account) => (
                        <div key={account.id} className="account-card premium-account-card" style={{ opacity: 0.7 }}>
                          <div className="account-card-top">
                            <div className="broker-symbol" style={{ background: brokerColor(account.accountName), color: 'white' }}>
                              {getAccountAlias(account)}
                            </div>
                            <div className="account-broker-copy">
                              <h3>{account.accountName}</h3>
                              <p>Alias: {getAccountAlias(account)} • {account.brokerName} • {account.accountType}</p>
                            </div>
                            <span className="status-pill" style={{ background: 'var(--panel-muted)', color: 'var(--muted)' }}>Archived</span>
                          </div>
                          <div className="mini-actions account-actions">
                            <button type="button" className="secondary-btn" onClick={() => void handleUnarchiveAccount(account.id)}>
                              <RotateCcw size={15} />
                              Restore
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {shownTab === 'settings' && isPersonal && (
            <section className="panel settings-panel">
              <div className="page-header-row">
                <div>
                  <h2>Settings</h2>
                  <p>Manage your account, broker connections and application preferences.</p>
                </div>
              </div>

              <div className="settings-tabs" role="tablist" aria-label="Settings sections">
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === 'profile'}
                  className={`settings-tab-btn ${settingsTab === 'profile' ? 'active' : ''}`}
                  onClick={() => setSettingsTab('profile')}
                >
                  <User size={15} />
                  Profile
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === 'broker'}
                  className={`settings-tab-btn ${settingsTab === 'broker' ? 'active' : ''}`}
                  onClick={() => setSettingsTab('broker')}
                >
                  <Link2 size={15} />
                  Broker Connections
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === 'data'}
                  className={`settings-tab-btn ${settingsTab === 'data' ? 'active' : ''}`}
                  onClick={() => setSettingsTab('data')}
                >
                  <Download size={15} />
                  Data &amp; Backup
                </button>
              </div>

              {settingsTab === 'profile' && (
                <div className="mini-panel">
                  <h3 style={{ marginBottom: 4 }}>Profile</h3>
                  <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 13 }}>
                    This name is stored only on this device — every user of this app on their own device sees their own name.
                  </p>
                  <form onSubmit={(event) => void handleUpdateSettingsName(event)} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, color: 'var(--muted)', fontWeight: 700, fontSize: 12.5, flex: '1 1 240px' }}>
                      Display Name
                      <input
                        value={settingsNameDraft}
                        onChange={(event) => setSettingsNameDraft(event.target.value)}
                        placeholder="Your name"
                      />
                    </label>
                    <button type="submit" className="primary-btn">Save Name</button>
                  </form>
                </div>
              )}

              {settingsTab === 'broker' && (
                <div className="broker-settings-layout">
                  <div className="broker-card">
                    <div className="broker-card-header">
                      <div className="broker-card-heading">
                        <div className="broker-icon">
                          <img src={angelOneLogo} alt="Angel One" />
                        </div>
                        <div>
                          <div className="broker-title-row">
                            <h3>Angel One</h3>
                            <span className="broker-api-pill">SmartAPI</span>
                          </div>
                          <p>Get live market data and trading charts with Angel One SmartAPI.</p>
                        </div>
                      </div>
                      <span className={`badge ${angelOneStatus.status === 'connected' ? 'badge-closed' : angelOneStatus.status === 'connecting' ? 'badge-open' : 'badge-sell'}`}>
                        ● {angelOneStatus.status === 'connected' ? 'Connected' : angelOneStatus.status === 'connecting' ? 'Connecting…' : 'Disconnected'}
                      </span>
                    </div>

                    <div className="security-note-panel">
                      <Lock size={16} />
                      <div>
                        <strong>Secure &amp; Encrypted</strong>
                        <p>
                          Credentials are encrypted on this device (AES-GCM, non-extractable key) and never leave your browser except
                          to Angel One's own API. Nothing is hardcoded, logged, or sent anywhere else. Session tokens are kept in
                          memory only — reconnect after a page reload.
                        </p>
                      </div>
                    </div>

                    {angelOneStatus.message && angelOneStatus.status !== 'disconnected' && (
                      <p className={`broker-status-message ${angelOneStatus.status === 'connected' ? 'is-success' : angelOneStatus.status === 'connecting' ? 'is-muted' : 'is-danger'}`}>
                        {angelOneStatus.message}
                      </p>
                    )}

                    <h4 className="broker-section-title">Connection Details</h4>

                    <div className="form-row">
                      <label>
                        API Key <span className="required-dot">*</span>
                        <div className="password-field">
                          <input
                            type={angelOneRevealed.apiKey ? 'text' : 'password'}
                            autoComplete="off"
                            value={angelOneDraft.apiKey}
                            onChange={(event) => setAngelOneDraft({ ...angelOneDraft, apiKey: event.target.value })}
                            placeholder="From SmartAPI developer console"
                          />
                          <button
                            type="button"
                            className="password-toggle-btn"
                            aria-label={angelOneRevealed.apiKey ? 'Hide API Key' : 'Show API Key'}
                            onClick={() => setAngelOneRevealed((current) => ({ ...current, apiKey: !current.apiKey }))}
                          >
                            {angelOneRevealed.apiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </div>
                      </label>
                      <label>
                        Client Code <span className="required-dot">*</span>
                        <input
                          autoComplete="off"
                          value={angelOneDraft.clientCode}
                          onChange={(event) => setAngelOneDraft({ ...angelOneDraft, clientCode: event.target.value })}
                          placeholder="e.g. A123456"
                        />
                      </label>
                    </div>
                    <div className="form-row">
                      <label>
                        PIN <span className="required-dot">*</span>
                        <div className="password-field">
                          <input
                            type={angelOneRevealed.pin ? 'text' : 'password'}
                            autoComplete="off"
                            value={angelOneDraft.pin}
                            onChange={(event) => setAngelOneDraft({ ...angelOneDraft, pin: event.target.value })}
                            placeholder="Trading PIN"
                          />
                          <button
                            type="button"
                            className="password-toggle-btn"
                            aria-label={angelOneRevealed.pin ? 'Hide PIN' : 'Show PIN'}
                            onClick={() => setAngelOneRevealed((current) => ({ ...current, pin: !current.pin }))}
                          >
                            {angelOneRevealed.pin ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </div>
                      </label>
                      <label>
                        TOTP Secret <span className="required-dot">*</span>
                        <div className="password-field">
                          <input
                            type={angelOneRevealed.totpSecret ? 'text' : 'password'}
                            autoComplete="off"
                            value={angelOneDraft.totpSecret}
                            onChange={(event) => setAngelOneDraft({ ...angelOneDraft, totpSecret: event.target.value })}
                            placeholder="From authenticator app setup"
                          />
                          <button
                            type="button"
                            className="password-toggle-btn"
                            aria-label={angelOneRevealed.totpSecret ? 'Hide TOTP Secret' : 'Show TOTP Secret'}
                            onClick={() => setAngelOneRevealed((current) => ({ ...current, totpSecret: !current.totpSecret }))}
                          >
                            {angelOneRevealed.totpSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </div>
                      </label>
                    </div>

                    <div className="setup-guide">
                      <div className="setup-guide-title">
                        <Info size={15} />
                        How to get these details?
                      </div>
                      <ol>
                        <li>Open the Angel One SmartAPI Portal</li>
                        <li>Login with your Angel One account</li>
                        <li>Create a SmartAPI application</li>
                        <li>Get your API Key and Client Code</li>
                        <li>Use your Trading PIN and TOTP Secret</li>
                      </ol>
                      <a href="https://smartapi.angelone.in" target="_blank" rel="noreferrer" className="setup-guide-link">
                        View Setup Guide
                        <ExternalLink size={13} />
                      </a>
                    </div>

                    {angelOneTestResult && (
                      <p className={`broker-status-message ${angelOneTestResult === 'Connection successful.' ? 'is-success' : 'is-danger'}`}>
                        {angelOneTestResult}
                      </p>
                    )}

                    <div className="mini-actions broker-actions">
                      <button type="button" className="secondary-btn" disabled={!angelOneDraftComplete || angelOneTesting} onClick={() => void handleAngelOneTest()}>
                        {angelOneTesting ? <Loader2 size={16} className="spin-icon" /> : <ShieldCheck size={16} />}
                        {angelOneTesting ? 'Testing…' : 'Test Connection'}
                      </button>
                      {angelOneStatus.status === 'connected' ? (
                        <button type="button" className="secondary-btn" onClick={() => void handleAngelOneDisconnect()}>
                          <Unlink size={16} />
                          Disconnect
                        </button>
                      ) : (
                        <button type="button" className="primary-btn" disabled={!angelOneDraftComplete} onClick={() => void handleAngelOneConnect()}>
                          <Link2 size={16} />
                          Connect
                        </button>
                      )}
                      {angelOneHasSaved && (
                        <button type="button" className="danger-btn" onClick={() => void handleAngelOneForget()}>Forget Saved Credentials</button>
                      )}
                    </div>
                  </div>

                  <aside className="quick-info-card">
                    <h4>Quick Info</h4>

                    <div className="quick-info-section">
                      <span className="quick-info-heading">Supported Markets</span>
                      <ul>
                        <li><CheckCircle2 size={14} /> NSE Equities</li>
                        <li><CheckCircle2 size={14} /> NSE Indices</li>
                        <li><CheckCircle2 size={14} /> NFO Options</li>
                        <li><CheckCircle2 size={14} /> NFO Futures</li>
                      </ul>
                    </div>

                    <div className="quick-info-section">
                      <span className="quick-info-heading">Data Features</span>
                      <ul>
                        <li><CheckCircle2 size={14} /> Historical OHLC</li>
                        <li><CheckCircle2 size={14} /> Live Quotes</li>
                        <li><CheckCircle2 size={14} /> Live Trading Charts</li>
                      </ul>
                    </div>

                    <div className="quick-info-section">
                      <span className="quick-info-heading">Security Notes</span>
                      <ul>
                        <li><CheckCircle2 size={14} /> Credentials encrypted locally (AES-GCM)</li>
                        <li><CheckCircle2 size={14} /> Never stored or logged in plain text</li>
                        <li><CheckCircle2 size={14} /> Session tokens kept in memory only</li>
                      </ul>
                    </div>

                    <div className="quick-info-success-box">
                      <strong>Your data stays with you</strong>
                      <p>Your journal data and broker credentials remain on this device — nothing is uploaded to our servers.</p>
                    </div>
                  </aside>
                </div>
              )}

              {settingsTab === 'data' && (
                <div className="mini-panel">
                  <h3 style={{ marginBottom: 4 }}>Data &amp; Backup</h3>
                  <p style={{ margin: '0 0 16px', color: 'var(--muted)', fontSize: 13 }}>
                    Back up, export, or restore your local journal data.
                  </p>
                  <div className="settings-grid">
                    <button type="button" className="secondary-btn" onClick={() => void exportAsJson()}>Export Backup</button>
                    <button type="button" className="secondary-btn" onClick={() => openExportModal('all')}>
                      <Download size={16} />
                      Export All Data
                    </button>
                    <label className="import-button secondary-btn">
                      Import Backup
                      <input type="file" accept="application/json" onChange={handleImport} />
                    </label>
                  </div>
                </div>
              )}
            </section>
          )}
        </main>
      </div>

      {tradeFormOpen && (
        <div className="modal-backdrop" onClick={closeTradeForm}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{tradeDraft.id ? 'Edit Trade' : quickMode ? 'Quick Add Trade' : 'Add Trade'}</h2>
              <button type="button" className="close-btn" onClick={closeTradeForm}>×</button>
            </div>

            {formError && (
              <div className="error-banner">
                <div className="error-banner-copy">
                  <strong>Couldn't save trade</strong>
                  <span>{formError}</span>
                </div>
              </div>
            )}

            {writableAccountOptions.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon"><Landmark size={22} /></div>
                <h3>No trading accounts yet</h3>
                <p>Add a broker account first, then log your trade.</p>
                <button type="button" className="primary-btn" onClick={() => { closeTradeForm(); openAccountForm() }}>
                  <Plus size={18} />
                  Add Account
                </button>
              </div>
            ) : (
            <form onSubmit={handleTradeSubmit} className="trade-form">
            <div className="modal-scroll-body">
              <label>
                Trading Account
                <select
                  required
                  value={tradeDraft.accountId}
                  onChange={(event) => setTradeDraft({ ...tradeDraft, accountId: event.target.value })}
                >
                  {writableAccountOptions.map((account) => (
                    <option key={account.id} value={account.id}>{getAccountAlias(account)}</option>
                  ))}
                </select>
              </label>

              <p className="form-section-title">Trade Details</p>
              <div className="form-row">
                <label>
                  Segment
                  <div className="segmented">
                    {segmentOptions.map((segment) => (
                      <button
                        key={segment}
                        type="button"
                        className={tradeDraft.segment === segment ? 'active' : ''}
                        onClick={() => setTradeDraft({ ...tradeDraft, segment })}
                      >
                        {segmentShortLabel[segment]}
                      </button>
                    ))}
                  </div>
                </label>
                <label>
                  Script Name
                  <input
                    required
                    value={tradeDraft.scriptName}
                    onChange={(event) => setTradeDraft({ ...tradeDraft, scriptName: event.target.value })}
                    placeholder="NIFTY 23700 CE"
                  />
                </label>
              </div>

              <p className="form-section-title">Entry Details</p>
              <div className="form-row">
                <label>
                  Date
                  <input
                    required
                    type="date"
                    value={tradeDraft.tradeDate}
                    onChange={(event) => setTradeDraft({ ...tradeDraft, tradeDate: event.target.value })}
                  />
                </label>
                <label>
                  Buy / Sell
                  <div className="segmented">
                    <button type="button" className={tradeDraft.side === 'BUY' ? 'active' : ''} onClick={() => setTradeDraft({ ...tradeDraft, side: 'BUY' })}>BUY</button>
                    <button type="button" className={tradeDraft.side === 'SELL' ? 'active' : ''} onClick={() => setTradeDraft({ ...tradeDraft, side: 'SELL' })}>SELL</button>
                  </div>
                </label>
              </div>
              <div className="form-row">
                <label>
                  Quantity
                  <input
                    required
                    type="number"
                    min="1"
                    value={tradeDraft.quantity}
                    onChange={(event) => setTradeDraft({ ...tradeDraft, quantity: event.target.value })}
                  />
                </label>
                <label>
                  Entry Price
                  <input
                    required
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={tradeDraft.entryPrice}
                    onChange={(event) => setTradeDraft({ ...tradeDraft, entryPrice: event.target.value })}
                  />
                </label>
              </div>

              {!quickMode && (
                <>
                  <p className="form-section-title">Exit Details</p>
                  <div className="form-row">
                    <label>
                      Exit Date
                      <input
                        type="date"
                        value={tradeDraft.exitDate}
                        onChange={(event) => setTradeDraft({ ...tradeDraft, exitDate: event.target.value })}
                      />
                    </label>
                    <label>
                      Exit Price
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={tradeDraft.exitPrice}
                        onChange={(event) => setTradeDraft({ ...tradeDraft, exitPrice: event.target.value })}
                      />
                    </label>
                  </div>
                </>
              )}

              <p className="form-section-title">Trade Analysis</p>
              <div className={quickMode ? undefined : 'form-row'}>
                <label>
                  Reason
                  {reasonCustomMode ? (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        autoFocus
                        value={tradeDraft.reason}
                        onChange={(event) => setTradeDraft({ ...tradeDraft, reason: event.target.value })}
                        placeholder="Type your reason"
                      />
                      <button
                        type="button"
                        className="secondary-btn"
                        style={{ padding: '0 14px', whiteSpace: 'nowrap' }}
                        onClick={() => { setReasonCustomMode(false); setTradeDraft({ ...tradeDraft, reason: '' }) }}
                      >
                        List
                      </button>
                    </div>
                  ) : (
                    <select
                      value={tradeDraft.reason}
                      onChange={(event) => {
                        if (event.target.value === CUSTOM_REASON_SENTINEL) {
                          setReasonCustomMode(true)
                          setTradeDraft({ ...tradeDraft, reason: '' })
                          return
                        }
                        setTradeDraft({ ...tradeDraft, reason: event.target.value })
                      }}
                    >
                      <option value="">Select reason</option>
                      {reasonOptions.map((reason) => (
                        <option key={reason} value={reason}>{reason}</option>
                      ))}
                      <option value={CUSTOM_REASON_SENTINEL}>+ Custom Reason</option>
                    </select>
                  )}
                </label>
                {!quickMode && (
                  <label className="file-input">
                    Attach Chart Screenshot
                    <input type="file" accept="image/*" onChange={handleAttachmentChange} />
                    {tradeAttachment && (
                      <div className="attachment-preview">
                        <img src={tradeAttachment} alt="Attachment preview" />
                        <button type="button" className="text-link" onClick={() => setTradeAttachment('')}>Remove</button>
                      </div>
                    )}
                  </label>
                )}
              </div>

              {!quickMode && (
                <label>
                  Notes
                  <textarea
                    value={tradeDraft.notes}
                    onChange={(event) => setTradeDraft({ ...tradeDraft, notes: event.target.value })}
                    rows={3}
                  />
                </label>
              )}
            </div>

              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={closeTradeForm}>Cancel</button>
                <button type="submit" className="primary-btn">{quickMode ? 'Quick Save' : 'Save Trade'}</button>
              </div>
            </form>
            )}
          </div>
        </div>
      )}

      {accountFormOpen && (
        <div className="modal-backdrop" onClick={() => { setAccountFormOpen(false); setAccountFormError('') }}>
          <div className="modal-card small" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{accountDraft.id ? 'Edit Account' : 'Add Account'}</h2>
              <button type="button" className="close-btn" onClick={() => { setAccountFormOpen(false); setAccountFormError('') }}>×</button>
            </div>

            {accountFormError && (
              <div className="error-banner">
                <div className="error-banner-copy">
                  <strong>Couldn't save account</strong>
                  <span>{accountFormError}</span>
                </div>
              </div>
            )}

            <form onSubmit={handleAccountSave} className="account-form">
              <label>
                Account Name
                <input
                  value={accountDraft.accountName}
                  onChange={(event) => setAccountDraft({ ...accountDraft, accountName: event.target.value })}
                />
              </label>
              <label>
                Display Alias / Initials
                <input
                  value={accountDraft.alias}
                  onChange={(event) => setAccountDraft({ ...accountDraft, alias: event.target.value })}
                  placeholder={accountDraft.accountName ? getInitials(accountDraft.accountName) : 'e.g. AG'}
                  maxLength={6}
                />
              </label>
              <p style={{ margin: '-8px 0 0', fontSize: 12, color: 'var(--muted)' }}>
                Shown everywhere instead of the full name — dashboard, charts, trades, dropdowns. Full name stays private to this Accounts page.
              </p>
              <label>
                Broker
                <input
                  value={accountDraft.brokerName}
                  onChange={(event) => setAccountDraft({ ...accountDraft, brokerName: event.target.value })}
                />
              </label>
              <label>
                Account Type
                <select
                  value={accountDraft.accountType}
                  onChange={(event) => setAccountDraft({ ...accountDraft, accountType: event.target.value })}
                >
                  <option value="Trading">Trading</option>
                  <option value="Commodity">Commodity</option>
                  <option value="Options">Options</option>
                </select>
              </label>

              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setAccountFormOpen(false)}>Cancel</button>
                <button type="submit" className="primary-btn">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {profileModalOpen && (
        <div className="modal-backdrop">
          <div className="modal-card small" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Welcome to your Journal</h2>
            </div>
            <p style={{ marginTop: 0, color: 'var(--muted)', fontSize: 13.5 }}>
              This device is set up for its own local journal. What should we call you? This name stays only on this device.
            </p>
            <form
              onSubmit={(event) => void handleSaveOnboardingName(event)}
              className="account-form"
            >
              <label>
                Your Name
                <input
                  autoFocus
                  value={profileNameDraft}
                  onChange={(event) => setProfileNameDraft(event.target.value)}
                  placeholder="e.g. Yogesh"
                />
              </label>
              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => void commitOnboardingName()}>
                  Skip for now
                </button>
                <button type="submit" className="primary-btn">Continue</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {lightboxOpen && selectedTradeAttachment && (
        <div className="modal-backdrop lightbox-backdrop" onClick={() => setLightboxOpen(false)}>
          <div className="lightbox-card" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="close-btn lightbox-close" aria-label="Close" onClick={() => setLightboxOpen(false)}>×</button>
            <img src={selectedTradeAttachment} alt="Trade chart screenshot" />
          </div>
        </div>
      )}

      {exportModalOpen && (
        <div className="modal-backdrop" onClick={() => setExportModalOpen(false)}>
          <div className="modal-card small" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Export Data</h2>
              <button type="button" className="close-btn" aria-label="Close" onClick={() => setExportModalOpen(false)}>×</button>
            </div>

            <div className="export-form">
              <label>
                Scope
                <div className="segmented segmented-wrap">
                  <button type="button" className={exportScope === 'all' ? 'active' : ''} onClick={() => setExportScope('all')}>All Data</button>
                  <button type="button" className={exportScope === 'account' ? 'active' : ''} onClick={() => setExportScope('account')}>Current Account</button>
                  <button type="button" className={exportScope === 'view' ? 'active' : ''} onClick={() => setExportScope('view')}>Current View</button>
                </div>
              </label>

              <label>
                Format
                <div className="segmented">
                  <button type="button" className={exportFormat === 'excel' ? 'active' : ''} onClick={() => setExportFormat('excel')}>Excel</button>
                  <button type="button" className={exportFormat === 'pdf' ? 'active' : ''} onClick={() => setExportFormat('pdf')}>PDF</button>
                  <button type="button" className={exportFormat === 'csv' ? 'active' : ''} onClick={() => setExportFormat('csv')}>CSV</button>
                </div>
              </label>

              <label className="export-checkbox">
                <input
                  type="checkbox"
                  checked={includeFullNamesInExport}
                  onChange={(event) => setIncludeFullNamesInExport(event.target.checked)}
                />
                Include full account names in export
              </label>

              <div className="export-preview">
                <div className="export-preview-row"><span>Scope</span><strong>{exportPreview.scopeLabel}</strong></div>
                <div className="export-preview-row"><span>Account</span><strong>{exportPreview.accountLabel}</strong></div>
                <div className="export-preview-row"><span>Stock</span><strong>{exportPreview.stockLabel}</strong></div>
                <div className="export-preview-row"><span>Date</span><strong>{exportPreview.dateLabel}</strong></div>
                <div className="export-preview-row"><span>Status</span><strong>{exportPreview.statusLabel}</strong></div>
                <div className="export-preview-row"><span>Records</span><strong>{exportPreview.records} Trades</strong></div>
              </div>

              {exportPreview.records === 0 && (
                <p className="empty-inline">No trades found for this selection — nothing to export.</p>
              )}

              <div className="modal-footer">
                <button type="button" className="secondary-btn" onClick={() => setExportModalOpen(false)}>Cancel</button>
                <button type="button" className="primary-btn" disabled={exportPreview.records === 0} onClick={runExport}>
                  <Download size={16} />
                  Export
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {ambiguousInstrument && (
        <div className="modal-backdrop" onClick={() => setAmbiguousInstrument(null)}>
          <div className="modal-card small" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Select Instrument</h2>
              <button type="button" className="close-btn" aria-label="Close" onClick={() => setAmbiguousInstrument(null)}>×</button>
            </div>
            <p style={{ marginTop: 0, color: 'var(--muted)', fontSize: 13.5 }}>
              "{ambiguousInstrument.scriptName}" matches more than one instrument — pick the correct one to open its chart.
            </p>
            <div className="account-mini-list">
              {ambiguousInstrument.resolution.candidates.map((candidate) => (
                <button
                  key={candidate.symbol}
                  type="button"
                  className="account-mini"
                  onClick={() => chooseAmbiguousInstrument(candidate)}
                >
                  <div className="account-mini-copy">
                    <strong>{candidate.displayName}</strong>
                    <span>{candidate.symbol}</span>
                  </div>
                  <span className={`badge ${candidate.market === 'NFO' ? 'badge-fut' : 'badge-cash'}`}>{candidate.market}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {chartState.isOpen && chartState.instrument && (
        <div className={`chart-drawer-backdrop ${chartState.isMaximized ? 'chart-drawer-backdrop-maximized' : ''}`} onClick={closeChart}>
          <div onClick={(event) => event.stopPropagation()} className="chart-drawer-wrap">
            <TradingChart
              instrument={chartState.instrument}
              accountId={chartState.accountId}
              tradeId={chartState.tradeId}
              trades={chartTrades}
              isMaximized={chartState.isMaximized}
              onToggleMaximize={() => setChartState((current) => ({ ...current, isMaximized: !current.isMaximized }))}
              onClose={closeChart}
            />
          </div>
        </div>
      )}

      {!readOnly && (
        <button type="button" className="mobile-fab" onClick={() => openTradeForm()} aria-label="Add trade">
          <Plus size={18} />
          Trade
        </button>
      )}

      <nav className="bottom-nav">
        {visibleBottomNavItems.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.key}
              type="button"
              className={shownTab === item.key ? 'bottom-nav-item active' : 'bottom-nav-item'}
              onClick={() => { setActiveTab(item.key); onTabSelect?.() }}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}

export default App
