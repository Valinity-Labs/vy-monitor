import './App.css';
import Mainnet from './pages/Mainnet';
import Testnet from './pages/Testnet';

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

      {network === 'mainnet' ? <Mainnet /> : <Testnet />}
    </>
  )
}

export default App
