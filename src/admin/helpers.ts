import { useCallback, useEffect, useState } from 'react'
import { ApiError, type AdminPage, type AdminQuery } from '../workspace/api'

export type Tone = 'ok' | 'warn' | 'down' | 'idle'

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 0) return `in ${formatSpan(-seconds)}`
  if (seconds < 45) return 'just now'
  return `${formatSpan(seconds)} ago`
}

function formatSpan(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}

export function inr(amount: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount)
}

export function limitText(value: number | null): string {
  return value === null ? 'unlimited' : String(value)
}

export function subscriptionTone(status: string | null): Tone {
  if (status === 'ACTIVE') return 'ok'
  if (status === 'PENDING') return 'warn'
  if (status === 'EXPIRED' || status === 'CANCELED') return 'down'
  return 'idle'
}

export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

interface PagedState<T> {
  requestKey: string
  data: AdminPage<T> | null
  error: string | null
}

/** Loads one page of an admin list. Changing any filter returns to page 1; `loading` is derived, so stale rows never show as fresh. */
export function usePaged<T>(fetcher: (q: AdminQuery) => Promise<AdminPage<T>>, filters: AdminQuery, pageSize = 25) {
  const filterKey = JSON.stringify(filters)
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 })
  const page = pageState.key === filterKey ? pageState.page : 1
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<PagedState<T>>({ requestKey: '', data: null, error: null })
  const requestKey = `${filterKey}|${page}|${nonce}`

  useEffect(() => {
    let cancelled = false
    fetcher({ ...JSON.parse(filterKey), page, page_size: pageSize })
      .then((data) => !cancelled && setState({ requestKey, data, error: null }))
      .catch((err) => !cancelled && setState({ requestKey, data: null, error: err instanceof ApiError ? err.message : 'Could not load this list.' }))
    return () => {
      cancelled = true
    }
    // fetcher is a stable method on workspaceApi; the request is fully described by the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])

  return {
    data: state.data,
    error: state.error,
    loading: state.requestKey !== requestKey,
    page,
    setPage: (next: number) => setPageState({ key: filterKey, page: next }),
    reload: useCallback(() => setNonce((n) => n + 1), []),
  }
}
