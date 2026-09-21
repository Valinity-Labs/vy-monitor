import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The app is up, so this load was not a stale-cache one — clear the guard in index.html so a
// later stale load is still allowed its one reload.
try { sessionStorage.removeItem('vy-stale-reload'); } catch { /* private mode */ }

// A lazily imported chunk that 404s hits the same deleted-by-deploy problem, but after the page
// has mounted, so the guard's "nothing rendered" check never fires. Vite reports it here.
addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  try {
    if (sessionStorage.getItem('vy-stale-reload')) return;
    sessionStorage.setItem('vy-stale-reload', '1');
  } catch { return; }
  location.reload();
})
