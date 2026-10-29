import { useState } from 'react'
import { Eye, Loader2 } from 'lucide-react'
import App from '../App'
import { workspaceApi } from '../workspace/api'

/**
 * Support "view as customer": opens the customer's real dashboard — the same screen they see — read-only, on top of the
 * admin console. Every action in it that would write is hidden, and the server refuses writes from a view session anyway.
 * Only the customer's server-side accounts are available; a Personal-mode journal lives in their own browser.
 */
export function ViewAs({ viewId, onExit }: { viewId: string; onExit: () => void }) {
  const [who, setWho] = useState<{ name: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ending, setEnding] = useState(false)

  async function end(): Promise<void> {
    setEnding(true)
    try {
      await workspaceApi.adminEndViewAs(viewId)
    } catch {
      // already ended or unreachable — either way, leave the screen
    }
    onExit()
  }

  return (
    <div className="adm-viewas-screen">
      <div className="adm-viewing adm-viewing-bar" role="status">
        <Eye size={18} />
        <div>
          <strong>{error ? 'Could not open this view' : who ? `Viewing ${who.name}'s dashboard — read-only` : 'Opening…'}</strong>
          <p>
            {error ??
              (who?.truncated
                ? 'Showing their 5,000 most recent trades. Their personal-mode journal lives in their own browser and can’t be viewed. Journal notes and trade reasons are private.'
                : 'Exactly what they see, but you can’t change anything. Their personal-mode journal lives in their own browser and can’t be viewed. Journal notes and trade reasons are private.')}
          </p>
        </div>
        <div className="adm-viewing-actions">
          {error ? (
            <button type="button" className="dev-btn" onClick={onExit}>
              Back to users
            </button>
          ) : (
            <button type="button" className="dev-btn adm-btn-danger" onClick={() => void end()} disabled={ending}>
              {ending && <Loader2 size={14} className="ws-spin" />} End view
            </button>
          )}
        </div>
      </div>
      <div className="adm-viewas-app">
        <App
          mode="view"
          supportViewId={viewId}
          onSupportLoaded={(info) => (info.error ? setError(info.error) : setWho({ name: info.displayName, truncated: info.truncated }))}
        />
      </div>
    </div>
  )
}
