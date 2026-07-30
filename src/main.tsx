import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'

const DifficultyLabeler = lazy(() => import('./labeler/DifficultyLabeler.tsx'))
const labelerRequested = new URLSearchParams(window.location.search).get('tool') === 'labeler'
  || window.location.pathname.endsWith('/labeler')
const labelerEnabled = import.meta.env.DEV || import.meta.env.VITE_LABELER_ENABLED === 'true'

const labelerUnavailable = (
  <main className="centered-state">
    <div className="state-icon" aria-hidden="true">!</div>
    <h1>Internal tool unavailable</h1>
    <p>The difficulty labeler is disabled in this deployment.</p>
    <a className="btn btn-primary" href={import.meta.env.BASE_URL}>Back to SteamGuess</a>
  </main>
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {labelerRequested ? (
      labelerEnabled ? (
        <Suspense fallback={<main className="centered-state"><div className="loader" /></main>}>
          <DifficultyLabeler />
        </Suspense>
      ) : labelerUnavailable
    ) : <App />}
  </StrictMode>,
)
