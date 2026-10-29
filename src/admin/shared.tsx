import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { AdminPage } from '../workspace/api'
import type { Tone } from './helpers'

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`dev-badge dev-badge-${tone}`}>{children}</span>
}

export function Pager({ data, page, onPage }: { data: AdminPage<unknown> | null; page: number; onPage: (page: number) => void }) {
  if (!data || data.total === 0) return null
  const pages = Math.max(1, Math.ceil(data.total / data.page_size))
  const from = (page - 1) * data.page_size + 1
  const to = Math.min(data.total, page * data.page_size)
  return (
    <div className="adm-pager">
      <span className="dev-muted">
        {from}–{to} of {data.total}
      </span>
      <button type="button" className="dev-btn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
        <ChevronLeft size={14} />
      </button>
      <span className="dev-muted">
        Page {page} of {pages}
      </span>
      <button type="button" className="dev-btn" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

/** Shared loading / error / empty handling so every list reads the same. */
export function ListState({ loading, error, empty, emptyText, children }: { loading: boolean; error: string | null; empty: boolean; emptyText: string; children: ReactNode }) {
  if (error) return <div className="dev-alert">{error}</div>
  if (loading && empty) return <p className="dev-empty">Loading…</p>
  if (empty) return <p className="dev-empty">{emptyText}</p>
  return <div className={loading ? 'adm-refreshing' : undefined}>{children}</div>
}

export function Metadata({ value }: { value: unknown }) {
  if (value === null || value === undefined || (typeof value === 'object' && Object.keys(value as object).length === 0)) return <span className="dev-muted">—</span>
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return <code className="adm-code">{text.length > 140 ? `${text.slice(0, 140)}…` : text}</code>
}
