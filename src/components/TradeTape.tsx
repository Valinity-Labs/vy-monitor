import { ERAS, decimalsForPrice, type Trade } from '../utils/priceHistory';

/**
 * THE TAPE — every trade, newest first, in the DexScreener idiom.
 *
 * One row per executed fill: when it happened, the price it printed at, the size, the dollar
 * value, the counterparty, and a link straight to the transaction on the chain's explorer.
 *
 * Capped at the most recent `limit` fills (default 100). The cap is a display choice, not a
 * data one — the chart above is built from the FULL history, so trimming the tape costs
 * nothing in accuracy and keeps the table readable.
 */

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const money = (n: number) =>
  '$' + n.toLocaleString('en-US', { maximumFractionDigits: n < 1000 ? 2 : 0 });

const qty = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 });

const price = (n: number) =>
  '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: decimalsForPrice(n),
    maximumFractionDigits: decimalsForPrice(n),
  });

const when = (ts: number) =>
  new Date(ts * 1000).toLocaleString('en-US', {
    year: '2-digit', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  });

export function TradeTape({
  trades, symbol, limit = 100, note,
}: { trades: Trade[]; symbol?: string; limit?: number; note?: string }) {
  // `trades` arrives oldest-first (chart order); the tape reads newest-first.
  const rows = trades.slice(-limit).reverse();

  if (!rows.length) {
    return <div className="vy-tape__empty">No trades recorded.</div>;
  }

  return (
    <div className="vy-tape">
      <div className="vy-tape__head">
        <span>Transactions{symbol ? ` · ${symbol}` : ''}</span>
        <span className="vy-tape__count">
          showing {rows.length.toLocaleString('en-US')} of {trades.length.toLocaleString('en-US')}
        </span>
      </div>

      <div className="vy-tape__scroll">
        <table className="vy-tape__table">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th>Side</th>
              <th className="vy-tape__num">Price</th>
              <th className="vy-tape__num">Amount</th>
              <th className="vy-tape__num">Value</th>
              <th>Address</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const explorer = ERAS[t.era].explorer;
              return (
                <tr key={t.key}>
                  <td className="vy-tape__time">{when(t.ts)}</td>
                  <td className="vy-tape__c-side">
                    <span className={`vy-tape__side vy-tape__side--${t.side}`}>{t.side}</span>
                  </td>
                  {/* What this trade actually paid. The chart plots the pool's price after it. */}
                  <td className="vy-tape__num vy-tape__price">{price(t.execPrice ?? t.price)}</td>
                  <td className="vy-tape__num vy-tape__c-amount">
                    {qty(t.qty)} <span className="vy-tape__sym">{ERAS[t.era].symbol}</span>
                  </td>
                  <td className="vy-tape__num vy-tape__c-value">{money(t.usd)}</td>
                  <td className="vy-tape__c-addr">
                    <a href={`${explorer}/address/${t.address}`} target="_blank" rel="noreferrer"
                      className="vy-tape__addr" title={t.address}>
                      {shortAddr(t.address)}
                    </a>
                  </td>
                  <td className="vy-tape__c-tx">
                    <a href={t.explorerUrl} target="_blank" rel="noreferrer"
                      className="vy-tape__tx" title={t.txHash}>↗</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {note && <div className="vy-tape__note">{note}</div>}
    </div>
  );
}
