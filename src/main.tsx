import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/base.css';
import './i18n';
import HomePage from './pages/HomePage';
import SinglePlayerPage from './pages/SinglePlayerPage';

// Socket.IO is only needed in rooms, so the multiplayer page is its own chunk.
const MultiplayerPage = lazy(() => import('./multiplayer/MultiplayerPage'));
const path = window.location.pathname.replace(/\/+$/, '');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {path.endsWith('/multiplayer')
      ? <Suspense fallback={<main className="state"><div className="spinner" /></main>}><MultiplayerPage /></Suspense>
      : path.endsWith('/singleplayer') ? <SinglePlayerPage /> : <HomePage />}
  </StrictMode>,
);
