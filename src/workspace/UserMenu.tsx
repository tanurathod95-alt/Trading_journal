import { useEffect, useRef, useState } from 'react'
import { Building2, LogOut, Receipt, User } from 'lucide-react'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U'
}

export function UserMenu({
  displayName,
  email,
  onProfile,
  onMyWorkspace,
  onBilling,
  onLogout,
}: {
  displayName: string
  email: string
  onProfile: () => void
  onMyWorkspace?: () => void
  onBilling?: () => void
  onLogout: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className="ws-user-menu" ref={ref}>
      <button type="button" className="ws-user-menu-trigger" onClick={() => setOpen((v) => !v)}>
        <span className="ws-user-avatar">{initials(displayName)}</span>
        <span className="ws-user-menu-name">{displayName}</span>
      </button>

      {open && (
        <>
          <div className="ws-dropdown-backdrop" onClick={() => setOpen(false)} />
          <div className="ws-dropdown ws-user-dropdown">
            <div className="ws-user-dropdown-header">
              <strong>{displayName}</strong>
              <span className="ws-muted small">{email}</span>
            </div>
            <button type="button" className="ws-dropdown-item" onClick={() => { setOpen(false); onProfile() }}>
              <User size={15} />
              Profile &amp; Password
            </button>
            {onMyWorkspace && (
              <button type="button" className="ws-dropdown-item" onClick={() => { setOpen(false); onMyWorkspace() }}>
                <Building2 size={15} />
                My Workspace
              </button>
            )}
            {onBilling && (
              <button type="button" className="ws-dropdown-item" onClick={() => { setOpen(false); onBilling() }}>
                <Receipt size={15} />
                Billing
              </button>
            )}
            <button type="button" className="ws-dropdown-item ws-dropdown-item-danger" onClick={() => { setOpen(false); onLogout() }}>
              <LogOut size={15} />
              Logout
            </button>
          </div>
        </>
      )}
    </div>
  )
}
