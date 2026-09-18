import { lazy, Suspense, useCallback, useState } from 'react';
import './App.css';
import { LoadingScreen } from './components/LoadingScreen';
import { ThemeToggle } from './components/ThemeToggle';

const Mainnet = lazy(() => import('./pages/Mainnet'));

function App() {
  // One loading screen for the whole start-up — the code-split page download and the data behind
  // it — so the spinning mark is never torn down and restarted halfway through.
  const [loaded, setLoaded] = useState(false);
  const onLoaded = useCallback(() => setLoaded(true), []);

  return (
    <>
      <LoadingScreen done={loaded} />
      <header>
        <ThemeToggle />
        Valinity Monitor&nbsp;
        <span className="network-label">[Ethereum mainnet]</span>
      </header>

      <Suspense fallback={null}>
        <Mainnet onLoaded={onLoaded} />
      </Suspense>
    </>
  )
}

export default App
