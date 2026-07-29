import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'

const DifficultyLabeler = lazy(() => import('./labeler/DifficultyLabeler.tsx'))
const isLabeler = new URLSearchParams(window.location.search).get('tool') === 'labeler'
  || window.location.pathname.endsWith('/labeler')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isLabeler ? (
      <Suspense fallback={<main className="centered-state"><div className="loader" /></main>}>
        <DifficultyLabeler />
      </Suspense>
    ) : <App />}
  </StrictMode>,
)
