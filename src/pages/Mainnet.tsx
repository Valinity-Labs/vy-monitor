import flatten from 'lodash/flatten';
import omit from 'lodash/omit';
import startCase from 'lodash/startCase';
import { Suspense, type JSX } from 'react';
import { createPublicClient, http, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { Value } from '../components/core';
import { CONTRACT_ACRONYMS, MAINNET_RPC_URL } from '../config';
import { Amount, USD, VY } from '../models';
import networks from '../networks';
import createResource from '../utils/createResource';

const client = createPublicClient({
  chain: mainnet,
  transport: http(MAINNET_RPC_URL),
});

const dataResource = createResource(async () => {
  const networkName = 'mainnet';
  const { abis, addresses, assets: assetAddresses } = networks[networkName];
  const assetAddrs = Object.values(assetAddresses) as Address[];

  const getContractConfig = <T extends keyof typeof abis>(name: T, address?: Address) => {
    return {
      abi: abis[name],
      address: address ?? (addresses as Record<string, Address>)[name as string]
    }
  }

  const vyTokenConfig = getContractConfig('ValinityToken');
  const vaoConfig = getContractConfig('ValinityAcquisitionOfficer');
  const vcoConfig = getContractConfig('ValinityCapOfficer');
  const vloConfig = getContractConfig('ValinityLoanOfficer');

  const assets = await Promise.all(assetAddrs.map(async assetAddr => {
    const tokenConfig = getContractConfig('ERC20', assetAddr);
    const results = await client.multicall({
      contracts: [
        { ...tokenConfig, functionName: 'decimals' },
        { ...tokenConfig, functionName: 'symbol' },
        { ...vaoConfig, functionName: 'getSpotPriceUSD', args: [assetAddr] },
        { ...vloConfig, functionName: 'getAssetView', args: [assetAddr] },
        { ...vaoConfig, functionName: 'getLTVF', args: [assetAddr] },
        { ...vcoConfig, functionName: 'getAssetCap', args: [assetAddr] },
        { ...vcoConfig, functionName: 'getAssetCollateralized', args: [assetAddr] }
      ],
      allowFailure: true
    });

    const errors: string[] = [];
    const get = <T,>(idx: number, label: string, fallback: T): T => {
      const r = results[idx];
      if (r.status === 'success') return r.result as T;
      errors.push(`${label}: ${(r.error as Error).message ?? 'reverted'}`);
      return fallback;
    };

    const decimals = get(0, 'decimals', 18);
    const symbol = get(1, 'symbol', assetAddr.slice(0, 10));
    const spotPrice = get(2, 'getSpotPriceUSD', 0n);
    const assetView = results[3].status === 'success'
      ? results[3].result as { ltv: bigint; reserveBalance: bigint; totalLoaned: bigint }
      : (() => { errors.push(`getAssetView: ${(results[3].error as Error).message ?? 'reverted'}`); return { ltv: 0n, reserveBalance: 0n, totalLoaned: 0n }; })();
    const { ltv, reserveBalance, totalLoaned } = assetView;
    const ltvf = get(4, 'getLTVF', 0n);
    const cap = get(5, 'getAssetCap', 0n);
    const collateralized = get(6, 'getAssetCollateralized', 0n);

    const currency = { symbol, decimals };
    const scaleFactor = BigInt(10) ** BigInt(18 - decimals);

    return {
      symbol,
      currency,
      address: assetAddr,
      errors,
      spotPrice: new Amount(USD, spotPrice),
      LTV: ltv,
      LTVF: new Amount(USD, ltvf),
      reserveBalance: new Amount(currency, reserveBalance),
      reserveBalanceUSD: new Amount(USD, spotPrice ? ((reserveBalance * scaleFactor) * spotPrice) / BigInt(1e18) : 0n),
      totalLoaned: new Amount(currency, totalLoaned),
      totalLoanedUSD: new Amount(USD, spotPrice ? ((totalLoaned * scaleFactor) * spotPrice) / BigInt(1e18) : 0n),
      cap: new Amount(VY, cap),
      collateralized: new Amount(VY, collateralized)
    }
  }));

  const overviewErrors: string[] = [];

  const overviewResults = await client.multicall({
    contracts: [
      { ...vyTokenConfig, functionName: 'totalSupply' },
      { ...vaoConfig, functionName: 'getMTP' }
    ],
    allowFailure: true
  });

  const vyTotalSupply = overviewResults[0].status === 'success'
    ? overviewResults[0].result as bigint
    : (() => { overviewErrors.push(`totalSupply: ${(overviewResults[0].error as Error).message ?? 'reverted'}`); return 0n; })();
  const mtp = overviewResults[1].status === 'success'
    ? overviewResults[1].result
    : (() => { overviewErrors.push(`getMTP: ${(overviewResults[1].error as Error).message ?? 'reverted'}`); return 'ERROR'; })();

  const tokenHolders = [
    'ValinityYieldTreasury',
    'ValinityReserveTreasury',
    'ValinityCapOfficer',
    'ValinityPortal',
    'AdminSafe'
  ] as const;

  const tokenHolderReads = tokenHolders.map(name => {
    return [
      {
        ...vyTokenConfig,
        functionName: 'balanceOf',
        args: [(addresses as Record<string, Address>)[name]]
      },
      ...assets.map(asset => ({
        abi: abis.ERC20,
        address: asset.address,
        functionName: 'balanceOf',
        args: [(addresses as Record<string, Address>)[name]]
      }))
    ]
  });

  const balancesRaw = await client.multicall({
    contracts: flatten(tokenHolderReads),
    allowFailure: true
  });

  const balanceMap = {} as { [K in typeof tokenHolders[number]]: Amount<bigint>[] }
  const balancesResultBatchLen = assets.length + 1;

  for (let i = 0; i < tokenHolders.length; i++) {
    const holder = tokenHolders[i];
    const batch = balancesRaw.slice(
      i * balancesResultBatchLen,
      balancesResultBatchLen + i * balancesResultBatchLen
    );
    balanceMap[holder] = batch.map((r, j) => {
      const currency = j === 0 ? VY : assets[j - 1].currency;
      if (r.status === 'success') return new Amount(currency, r.result as bigint);
      overviewErrors.push(`balanceOf(${holder}, ${currency.symbol}): reverted`);
      return new Amount(currency, 0n);
    })
  }

  const totalUncollateralized = (
    vyTotalSupply -
    balanceMap.ValinityYieldTreasury[0].value -
    balanceMap.ValinityReserveTreasury[0].value -
    balanceMap.ValinityCapOfficer[0].value
  );

  let tvl = 0n;
  for (const asset of assets) {
    tvl += (asset.reserveBalanceUSD.value as bigint) + (asset.totalLoanedUSD.value as bigint);
  }

  return {
    overview: {
      'VY Total Supply': new Amount(VY, vyTotalSupply),
      'Total Uncollateralized': new Amount(VY, totalUncollateralized),
      TVL: new Amount(USD, tvl),
      MTP: mtp
    },
    overviewErrors,
    balanceMap,
    assets: assets.map(asset => omit(asset, ['currency'])),
  };
});

export default function Testnet() {
  return (
    <Suspense fallback={<p style={{ textAlign: 'center' }}>Loading...</p>}>
      <Content />
    </Suspense>
  )
}

function Content() {
  const data = dataResource.read();

  return (
    <div className="monitor">
      <div>
        <h2>Overview</h2>
        <div className={`box ${data.overviewErrors.length > 0 ? 'box--error' : ''}`}>
          {data.overviewErrors.length > 0 && (
            <div className="error-list">
              {data.overviewErrors.map((err, i) => (
                <div key={i} className="error-item">✗ {err}</div>
              ))}
            </div>
          )}
          {renderValues(data.overview)}
        </div>
      </div>

      <div>
        <h2>Balances</h2>
        <div className="box">
          <BalanceTable data={data.balanceMap} />
        </div>
      </div>

      <div>
        <h2>Assets</h2>
        {data.assets.map(({ symbol, errors, ...values }) => (
          <div key={symbol} className={`box ${errors && errors.length > 0 ? 'box--error' : ''}`}>
            <h3>
              {symbol}
              {errors && errors.length > 0 && (
                <span className="error-badge">⚠ {errors.length} error{errors.length > 1 ? 's' : ''}</span>
              )}
            </h3>
            {errors && errors.length > 0 && (
              <div className="error-list">
                {errors.map((err, i) => (
                  <div key={i} className="error-item">✗ {err}</div>
                ))}
              </div>
            )}
            {renderValues(values)}
          </div>
        ))}
      </div>
    </div>
  )
}

function renderValues(
  data: object,
  transform?: (key: string, value: unknown) => unknown
): JSX.Element {
  return (
    <table>
      <tbody>
        {Object.entries(data).map(([key, value]) => (
          <tr key={key}>
            <td >
              <strong>{startCase(key)}</strong>
            </td>
            <td>
              <Value>{transform ? transform(key, value) : value}</Value>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const BalanceTable = ({ data }: {
  data: { [key: string]: Amount<bigint>[] }
}) => {
  const totals: Amount<bigint>[] = [];

  for (const amounts of Object.values(data)) {
    amounts.forEach((amount, i) => {
      const sum = totals[i] ?? new Amount(amount.currency, 0n);
      sum.value += amount.value;
      totals[i] = sum;
    });
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Holder</th>
          {Object.values(data)[0].map(amount => (
            <th key={amount.currency.symbol}>{amount.currency.symbol}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Object.entries(data).map(([holder, amounts]) => (
          <tr key={holder}>
            <td>
              {CONTRACT_ACRONYMS[holder as keyof typeof CONTRACT_ACRONYMS] ?? holder}
            </td>
            {amounts.map(amount => (
              <td key={amount.currency.symbol}>
                <Value includeSybmol={false}>{amount}</Value>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          {totals.map(amount => (
            <td key={amount.currency.symbol}>
              <Value includeSybmol={false}>{amount}</Value>
            </td>
          ))}
        </tr>
      </tfoot>
    </table>
  )
}
