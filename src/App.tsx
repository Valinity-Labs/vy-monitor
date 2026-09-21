import { lazy, Suspense, useCallback, useState } from 'react';
import './App.css';
import { LoadingScreen } from './components/LoadingScreen';
import { ThemeToggle } from './components/ThemeToggle';

const Mainnet = lazy(() => import('./pages/Mainnet'));

function App() {
  // One loading screen for the start-up, kept OUTSIDE the Suspense boundary so it survives the
  // code-split page arriving — the spinning mark is never torn down and restarted halfway
  // through. It is in the flow, below the price section, so the chart and the tape are on screen
  // and usable while the balance sheet's round trips finish underneath.
  const [loaded, setLoaded] = useState(false);
  const onLoaded = useCallback(() => setLoaded(true), []);

  return (
    <>
      <header>
        <ThemeToggle />
        Valinity Monitor&nbsp;
        <span className="network-label">[Ethereum mainnet]</span>
      </header>

      <Suspense fallback={null}>
        <Mainnet onLoaded={onLoaded} />
      </Suspense>

      <LoadingScreen done={loaded} inline />
    </>
  )
}

export default App
