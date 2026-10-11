// Vitest runs in node: provide the minimum browser globals that app modules read at import time.
import 'fake-indexeddb/auto'

const g = globalThis as unknown as { window?: unknown }
if (g.window === undefined) {
  g.window = { location: { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', pathname: '/', search: '' } }
}
