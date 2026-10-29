import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError, workspaceApi, type Me, type MyInvitationApi, type MyPortfolioInvitationApi, type TradingAccountApi, type Workspace } from './api'

interface WorkspaceAuthValue {
  status: 'loading' | 'signed-out' | 'signed-in'
  me: Me | null
  currentWorkspace: Workspace | null
  accounts: TradingAccountApi[]
  currentAccountId: string | null
  setCurrentAccountId: (id: string | null) => void
  accountsLoading: boolean
  accountsError: string | null
  refreshAccounts: () => Promise<void>
  createAccount: (name: string, brokerName: string, accountType: string, contactNumber?: string) => Promise<void>
  login: (email: string, password: string) => Promise<Me>
  signup: (email: string, password: string, displayName: string) => Promise<void>
  logout: () => Promise<void>
  myInvitations: MyInvitationApi[]
  refreshMyInvitations: () => Promise<void>
  acceptInvitation: (invitationId: string) => Promise<void>
  declineInvitation: (invitationId: string) => Promise<void>
  myPortfolioInvitations: MyPortfolioInvitationApi[]
  acceptPortfolioInvitation: (invitationId: string) => Promise<void>
  declinePortfolioInvitation: (invitationId: string) => Promise<void>
  updateDisplayName: (displayName: string) => Promise<void>
}

const WorkspaceAuthContext = createContext<WorkspaceAuthValue | null>(null)

export function WorkspaceAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'signed-out' | 'signed-in'>('loading')
  const [me, setMe] = useState<Me | null>(null)
  const [accounts, setAccounts] = useState<TradingAccountApi[]>([])
  const [accountsLoading, setAccountsLoading] = useState(false)
  const [accountsError, setAccountsError] = useState<string | null>(null)
  const [currentAccountId, setCurrentAccountId] = useState<string | null>(null)
  const [myInvitations, setMyInvitations] = useState<MyInvitationApi[]>([])
  const [myPortfolioInvitations, setMyPortfolioInvitations] = useState<MyPortfolioInvitationApi[]>([])

  const currentWorkspace = me?.workspaces[0] ?? null

  const refreshAccounts = useCallback(async () => {
    if (!currentWorkspace) {
      return
    }
    setAccountsLoading(true)
    setAccountsError(null)
    try {
      // Deliberately unfiltered: an account shared with this user (Phase
      // 4/5) lives in the *sharer's* workspace, not the current user's own,
      // so filtering by currentWorkspace.id would hide every "Shared With
      // Me" account. Every row returned here is already scoped server-side
      // to "accounts this user has an AccountMember row for" — never a raw
      // per-workspace listing.
      const list = await workspaceApi.listAccounts()
      setAccounts(list)
      setCurrentAccountId((current) => {
        if (current && list.some((a) => a.id === current)) {
          return current
        }
        return list[0]?.id ?? null
      })
    } catch (error) {
      setAccountsError(error instanceof ApiError ? error.message : 'Could not load trading accounts.')
    } finally {
      setAccountsLoading(false)
    }
  }, [currentWorkspace])

  const refreshMyInvitations = useCallback(async () => {
    try {
      setMyInvitations(await workspaceApi.myInvitations())
    } catch {
      // Non-fatal — the invitations inbox is a convenience, not core to the app working.
    }
    try {
      setMyPortfolioInvitations(await workspaceApi.myPortfolioInvitations())
    } catch {
      // Non-fatal, same as above.
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    workspaceApi
      .me()
      .then((result) => {
        if (cancelled) return
        setMe(result)
        setStatus('signed-in')
      })
      .catch(() => {
        if (cancelled) return
        setStatus('signed-out')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (status === 'signed-in') {
      void refreshAccounts()
      void refreshMyInvitations()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, currentWorkspace?.id])

  const login = useCallback(async (email: string, password: string) => {
    const result = await workspaceApi.login(email, password)
    setMe(result)
    setStatus('signed-in')
    return result
  }, [])

  const signup = useCallback(async (email: string, password: string, displayName: string) => {
    const result = await workspaceApi.signup(email, password, displayName)
    setMe(result)
    setStatus('signed-in')
  }, [])

  const logout = useCallback(async () => {
    await workspaceApi.logout().catch(() => {})
    setMe(null)
    setAccounts([])
    setCurrentAccountId(null)
    setMyInvitations([])
    setStatus('signed-out')
  }, [])

  const createAccount = useCallback(
    async (name: string, brokerName: string, accountType: string, contactNumber = '') => {
      if (!currentWorkspace) {
        return
      }
      const created = await workspaceApi.createAccount(currentWorkspace.id, name, brokerName, accountType, contactNumber)

      // Deliberately backend-only — Business accounts must never auto-create a
      // local (Dexie) counterpart, or they'd leak into the Personal Accounts
      // tab (which is 100% local-only by design). Anyone who wants a backend
      // account usable for local/offline trade entry can still link one
      // explicitly via "Link Local Data" (LinkLocalAccountPanel).
      setAccounts((current) => [...current, created])
      setCurrentAccountId(created.id)
    },
    [currentWorkspace],
  )

  const acceptInvitation = useCallback(async (invitationId: string) => {
    await workspaceApi.acceptInvitation(invitationId)
    setMyInvitations((current) => current.filter((i) => i.id !== invitationId))
    await refreshAccounts()
  }, [refreshAccounts])

  const declineInvitation = useCallback(async (invitationId: string) => {
    await workspaceApi.declineInvitation(invitationId)
    setMyInvitations((current) => current.filter((i) => i.id !== invitationId))
  }, [])

  const acceptPortfolioInvitation = useCallback(async (invitationId: string) => {
    await workspaceApi.acceptPortfolioInvitation(invitationId)
    setMyPortfolioInvitations((current) => current.filter((i) => i.id !== invitationId))
    await refreshAccounts()
  }, [refreshAccounts])

  const updateDisplayName = useCallback(async (displayName: string) => {
    const result = await workspaceApi.updateProfile(displayName)
    setMe(result)
  }, [])

  const declinePortfolioInvitation = useCallback(async (invitationId: string) => {
    await workspaceApi.declinePortfolioInvitation(invitationId)
    setMyPortfolioInvitations((current) => current.filter((i) => i.id !== invitationId))
  }, [])

  const value: WorkspaceAuthValue = {
    status,
    me,
    currentWorkspace,
    accounts,
    currentAccountId,
    setCurrentAccountId,
    accountsLoading,
    accountsError,
    refreshAccounts,
    createAccount,
    login,
    signup,
    logout,
    myInvitations,
    refreshMyInvitations,
    acceptInvitation,
    declineInvitation,
    myPortfolioInvitations,
    acceptPortfolioInvitation,
    declinePortfolioInvitation,
    updateDisplayName,
  }

  return <WorkspaceAuthContext.Provider value={value}>{children}</WorkspaceAuthContext.Provider>
}

export function useWorkspaceAuth(): WorkspaceAuthValue {
  const ctx = useContext(WorkspaceAuthContext)
  if (!ctx) {
    throw new Error('useWorkspaceAuth must be used inside WorkspaceAuthProvider')
  }
  return ctx
}
