import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { DATE_LOCALE, LANG, tr } from '../utils/i18n';
import { ERAS, type Trade } from '../utils/priceHistory';
import {
  absoluteTime,
  defaultTradeAction,
  relativeAge,
  shortAddress,
  traderActivityByWallet,
  traderActivityKey,
  traderTier,
  traderTitle,
  tradeBarWidth,
} from '../utils/tradeTape';
import { useTradeTapeDetails } from '../utils/useTradeTapeDetails';

/**
 * THE TAPE — every trade, newest first, in the DexScreener idiom.
 *
 * One row per executed fill: how long ago it happened, its token and dollar size, the
 * counterparty's pair-specific VY activity tier, and a plain-language link to the transaction.
 *
 * Capped at the most recent `limit` fills (default 100). The cap is a display choice, not a
 * data one — the chart above is built from the FULL history, so trimming the tape costs
 * nothing in accuracy and keeps the table readable.
 *
 * `visibleRows` makes the table a WINDOW: that many rows are on screen and the rest roll inside
 * it, so the tape occupies the same space however many fills it holds and the page below it never
 * moves. Without it the table is as tall as its rows, as it was before.
 */

const money = (n: number) =>
  '$' + n.toLocaleString('en-US', { maximumFractionDigits: n < 1000 ? 2 : 0 });

const qty = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 });

const ACTION_ES: Record<string, string> = {
  'Bought VY on Uniswap': 'Compró VY en Uniswap',
  'Sold VY on Uniswap': 'Vendió VY en Uniswap',
  'Bought on P2P order book': 'Compró en el libro de órdenes P2P',
  'Sold on P2P order book': 'Vendió en el libro de órdenes P2P',
  'Valinity Staking · Deposited VY': 'Valinity Staking · Depositó VY',
  'Valinity Staking · Withdrew VY': 'Valinity Staking · Retiró VY',
  'Valinity Staking · Deposited asset': 'Valinity Staking · Depositó un activo',
  'Valinity Staking · Deposited ETH': 'Valinity Staking · Depositó ETH',
  'Valinity Staking · Withdrew asset': 'Valinity Staking · Retiró un activo',
  'Valinity Loan · Opened loan': 'Valinity Loan · Abrió un préstamo',
  'Valinity Loan · Increased loan': 'Valinity Loan · Aumentó un préstamo',
  'Valinity Loan · Closed loan': 'Valinity Loan · Cerró un préstamo',
  'Valinity Loan · Repaid loan': 'Valinity Loan · Pagó un préstamo',
  'Valinity Loan · Migrated loan': 'Valinity Loan · Migró un préstamo',
  'Valinity Loan · Migrated loans': 'Valinity Loan · Migró préstamos',
  'Valinity Loan · Liquidated loan': 'Valinity Loan · Liquidó un préstamo',
  'Valinity Yield · Claimed VY yield': 'Valinity Yield · Reclamó rendimiento de VY',
  'Valinity Yield · Claimed asset yield': 'Valinity Yield · Reclamó rendimiento de un activo',
  'Valinity Portal · Claimed entitlement': 'Valinity Portal · Reclamó una asignación',
  'Valinity Buyback · Executed buyback': 'Valinity Buyback · Ejecutó una recompra',
  'Valinity Acquisition · LTV rebalance': 'Valinity Acquisition · Rebalanceo LTV',
  'Valinity Acquisition · MTP rebalance': 'Valinity Acquisition · Rebalanceo MTP',
  'Valinity Alliance · Registered': 'Valinity Alliance · Se registró',
  'Valinity Alliance · Activated referrer': 'Valinity Alliance · Activó referidos',
  'Valinity Alliance · Activated builder': 'Valinity Alliance · Activó builder',
  'Valinity Alliance · Reached Tier 4': 'Valinity Alliance · Alcanzó Nivel 4',
  'Valinity Alliance · Launched V-DAO': 'Valinity Alliance · Lanzó una V-DAO',
  'Valinity Alliance · Joined V-DAO as partner': 'Valinity Alliance · Se unió como socio de V-DAO',
  'Valinity Alliance · Funded builder': 'Valinity Alliance · Financió builder',
  'Valinity Alliance · Claimed referral rewards': 'Valinity Alliance · Reclamó recompensas de referidos',
  'Valinity Exchange · DAX swap': 'Valinity Exchange · Intercambio DAX',
  'Valinity Exchange · Uniswap V3 swap': 'Valinity Exchange · Intercambio Uniswap V3',
  'Valinity Exchange · Bridged swap': 'Valinity Exchange · Intercambio puente',
  'Valinity Exchange · Minted tokenized stock': 'Valinity Exchange · Acuñó acción tokenizada',
  'Valinity Exchange · Redeemed tokenized stock': 'Valinity Exchange · Canjeó acción tokenizada',
  'Valinity Exchange · V-DAO swap': 'Valinity Exchange · Intercambio V-DAO',
};

const localAction = (action: string) => (LANG === 'es' ? (ACTION_ES[action] ?? action) : action);

type TapeRowStyle = CSSProperties & { '--vy-tape-fill': string };

export function TradeTape({
  trades, symbol, limit = 100, note, visibleRows,
}: { trades: Trade[]; symbol?: string; limit?: number; note?: string; visibleRows?: number }) {
  // `trades` arrives oldest-first (chart order); the tape reads newest-first.
  const rows = useMemo(() => trades.slice(-limit).reverse(), [limit, trades]);
  const details = useTradeTapeDetails(rows);
  const activityByWallet = useMemo(() => traderActivityByWallet(trades), [trades]);
  const [now, setNow] = useState(() => Date.now());
  const largestValue = useMemo(
    () => rows.reduce(
      (largest, trade) => Number.isFinite(trade.usd) ? Math.max(largest, trade.usd) : largest,
      0,
    ),
    [rows],
  );

  // The pool polls only when there may be new data. This small clock keeps relative ages honest
  // during a quiet market without causing the chart above to redraw.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (!rows.length) {
    return <div className="vy-tape__empty">{tr('No trades recorded.', 'No hay operaciones registradas.')}</div>;
  }

  return (
    <div className="vy-tape">
      <div className="vy-tape__head">
        <span>{tr('Transactions', 'Transacciones')}{symbol ? ` · ${symbol}` : ''}</span>
        <span className="vy-tape__count">
          {tr(
            `showing ${rows.length.toLocaleString('en-US')} of ${trades.length.toLocaleString('en-US')} · bar = USD size · icon = VY activity`,
            `mostrando ${rows.length.toLocaleString('en-US')} de ${trades.length.toLocaleString('en-US')} · barra = valor USD · icono = actividad VY`,
          )}
        </span>
      </div>

      {/* The window's height is a whole number of rows plus the sticky header, so a scroll can
          never stop on a half-drawn row. */}
      <div
        className="vy-tape__scroll"
        style={visibleRows ? { maxHeight: `calc(${visibleRows} * var(--vy-tape-row) + var(--vy-tape-head))` } : undefined}
      >
        <table className="vy-tape__table">
          <thead>
            <tr>
              <th>{tr('Age', 'Hace')}</th>
              <th className="vy-tape__num">{tr('Amount', 'Cantidad')}</th>
              <th className="vy-tape__num">{tr('USD value', 'Valor USD')}</th>
              <th className="vy-tape__wallet-head">{tr('Wallet', 'Billetera')}</th>
              <th className="vy-tape__action-head">{tr('Transaction', 'Transacción')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((trade) => {
              const explorer = ERAS[trade.era].explorer;
              const activity = activityByWallet.get(traderActivityKey(trade));
              const tier = traderTier(activity);
              const rawAction = details.actions.get(trade.txHash.toLowerCase()) ?? defaultTradeAction(trade);
              const action = localAction(rawAction);
              const style: TapeRowStyle = {
                '--vy-tape-fill': `${tradeBarWidth(trade.usd, largestValue).toFixed(2)}%`,
              };
              const age = relativeAge(trade.ts, now, LANG);
              const amount = `${qty(trade.qty)} ${ERAS[trade.era].symbol}`;
              const usdValue = money(trade.usd);
              const tierDescription = tier && activity
                ? traderTitle(tier, activity, LANG)
                : undefined;

              return (
                <tr
                  key={trade.key}
                  className={`vy-tape__row vy-tape__row--${trade.side}`}
                  style={style}
                >
                  <td
                    className="vy-tape__time"
                    title={absoluteTime(trade.ts, DATE_LOCALE)}
                    aria-label={`${tr('Age', 'Hace')}: ${age}`}
                  >
                    {age}
                  </td>
                  <td className="vy-tape__num vy-tape__c-amount" aria-label={`${tr('Amount', 'Cantidad')}: ${amount}`}>
                    {qty(trade.qty)} <span className="vy-tape__sym">{ERAS[trade.era].symbol}</span>
                  </td>
                  <td className="vy-tape__num vy-tape__c-value" aria-label={`${tr('USD value', 'Valor USD')}: ${usdValue}`}>
                    {usdValue}
                  </td>
                  <td className="vy-tape__c-addr" aria-label={`${tr('Wallet', 'Billetera')}: ${trade.address}${tierDescription ? ` · ${tierDescription}` : ''}`}>
                    <span className="vy-tape__wallet">
                      <a href={`${explorer}/address/${trade.address}`} target="_blank" rel="noreferrer"
                        className="vy-tape__addr" title={trade.address}>
                        {shortAddress(trade.address)}
                      </a>
                      {tier && tierDescription ? (
                        <span
                          className={`vy-tape__tier vy-tape__tier--${tier.label.toLowerCase()}`}
                          role="img"
                          aria-label={tierDescription}
                          title={tierDescription}
                          tabIndex={0}
                        >
                          {tier.emoji}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="vy-tape__c-action" aria-label={`${tr('Transaction', 'Transacción')}: ${action}`}>
                    <a href={trade.explorerUrl} target="_blank" rel="noreferrer"
                      className="vy-tape__action" title={`${action} · ${trade.txHash}`}>
                      <span className="vy-visually-hidden">
                        {trade.side === 'buy' ? tr('Underlying pool buy. ', 'Compra en el pool. ') : tr('Underlying pool sell. ', 'Venta en el pool. ')}
                      </span>
                      {action} <span aria-hidden="true">↗</span>
                    </a>
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
