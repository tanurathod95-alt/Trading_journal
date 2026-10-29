import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import './workspace/workspace.css'
import './marketing/marketing.css'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { AdminPanel } from './admin/AdminPanel.tsx'
import { DeveloperPanel } from './developer/DeveloperPanel.tsx'
import { AuthGate } from './workspace/AuthGate.tsx'
import { WorkspaceAuthProvider } from './workspace/WorkspaceAuthContext.tsx'
import { ModeShell } from './workspace/ModeShell.tsx'
import { MarketingLayout } from './marketing/MarketingLayout.tsx'
import { Home } from './marketing/pages/Home.tsx'
import { Features } from './marketing/pages/Features.tsx'
import { ForTraders } from './marketing/pages/ForTraders.tsx'
import { ForPortfolioManagers } from './marketing/pages/ForPortfolioManagers.tsx'
import { Pricing } from './marketing/pages/Pricing.tsx'
import { Security } from './marketing/pages/Security.tsx'
import { About } from './marketing/pages/About.tsx'
import { Contact } from './marketing/pages/Contact.tsx'

registerSW({ immediate: true })

// crypto.randomUUID only exists in secure contexts (https / localhost); opened by LAN IP over http it is missing.
if (typeof crypto.randomUUID !== 'function') {
  Object.defineProperty(crypto, 'randomUUID', {
    value: () =>
      '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16),
      ),
  })
}

function AdminApp() {
  // Same sign-in gate as the app; the panel checks platform_role, and every /api/admin call is re-checked on the server.
  return (
    <ErrorBoundary label="Admin panel" fullPage>
      <AuthGate>
        <AdminPanel />
      </AuthGate>
    </ErrorBoundary>
  )
}

function DeveloperApp() {
  // Same sign-in gate as the app; the panel itself then checks platform_role, and every /api/dev call is re-checked on the server.
  return (
    <ErrorBoundary label="Developer panel" fullPage>
      <AuthGate>
        <DeveloperPanel />
      </AuthGate>
    </ErrorBoundary>
  )
}

function TradingJournalApp() {
  return (
    <ErrorBoundary label="Trading Journal" fullPage>
      <AuthGate>
        <ModeShell />
      </AuthGate>
    </ErrorBoundary>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost boundary — the last line of defence. Anything that escapes every
        narrower boundary below (a crash in the router itself, the auth provider, etc.)
        lands here instead of leaving a blank white page. */}
    <ErrorBoundary label="App" fullPage>
      <BrowserRouter>
        {/* Wraps both the marketing site and /app — the marketing site's nav
            needs sign-in state too, since "Login"/"Get Started" now open the
            auth modal right there on the homepage instead of navigating to a
            separate full-page screen under /app. */}
        <WorkspaceAuthProvider>
          <Routes>
            <Route element={<MarketingLayout />}>
              <Route index element={<ErrorBoundary label="Home page"><Home /></ErrorBoundary>} />
              <Route path="features" element={<ErrorBoundary label="Features page"><Features /></ErrorBoundary>} />
              <Route path="for-traders" element={<ErrorBoundary label="For Traders page"><ForTraders /></ErrorBoundary>} />
              <Route
                path="for-portfolio-managers"
                element={<ErrorBoundary label="For Portfolio Managers page"><ForPortfolioManagers /></ErrorBoundary>}
              />
              <Route path="pricing" element={<ErrorBoundary label="Pricing page"><Pricing /></ErrorBoundary>} />
              <Route path="security" element={<ErrorBoundary label="Security page"><Security /></ErrorBoundary>} />
              <Route path="about" element={<ErrorBoundary label="About page"><About /></ErrorBoundary>} />
              <Route path="contact" element={<ErrorBoundary label="Contact page"><Contact /></ErrorBoundary>} />
            </Route>
            {/* The actual SaaS product — everything built in Phases 1-10 — now
                lives at /app instead of the root path, so the public marketing
                site can own "/". Every existing login/workspace/journal
                behavior is unchanged, just mounted under a new path. */}
            <Route path="/app/admin/*" element={<AdminApp />} />
            <Route path="/app/dev/*" element={<DeveloperApp />} />
            <Route path="/app/*" element={<TradingJournalApp />} />
          </Routes>
        </WorkspaceAuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
