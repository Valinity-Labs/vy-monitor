import { lazy, Suspense } from 'react';
import './App.css';
import { LoadingScreen } from './components/LoadingScreen';

const Mainnet = lazy(() => import('./pages/Mainnet'));
const Testnet = lazy(() => import('./pages/Testnet'));

function App() {
  const searchParams = new URLSearchParams(location.search);
  const network = searchParams.get('network') ?? 'mainnet';
  const otherNetwork = network === 'mainnet' ? 'sepolia' : 'mainnet';

  return (
    <>
      <header>
        Valinity Monitor&nbsp;
        <a href={`?network=${otherNetwork}`}>[{network}]</a>
      </header>

      <Suspense fallback={network === 'mainnet' ? <LoadingScreen /> : <div>Loading...</div>}>
        {network === 'mainnet' ? <Mainnet /> : <Testnet />}
      </Suspense>
    </>
  )
}

export default App
