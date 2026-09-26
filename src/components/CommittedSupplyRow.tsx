import { useEffect, useState } from 'react';
import type { PublicClient } from 'viem';
import { Amount, VY } from '../models';
import { fetchCommittedSupply, type CommittedSupply } from '../utils/committedSupply';
import { DATE_LOCALE, tr } from '../utils/i18n';
import { Value } from './core';
import './CommittedSupplyRow.css';

type SupplyState = {
  client: PublicClient;
  data: CommittedSupply | null;
};

const dateLabel = (timestamp: bigint) => new Date(Number(timestamp) * 1_000).toLocaleDateString(
  DATE_LOCALE,
  { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' },
);

export function CommittedSupplyRow({ client }: { client: PublicClient }) {
  const [state, setState] = useState<SupplyState | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      try {
        const data = await fetchCommittedSupply(client);
        if (active) setState({ client, data });
      } catch {
        // A failed source must never turn into an apparently complete zero total.
        if (active) setState({ client, data: null });
      } finally {
        if (active) timer = setTimeout(refresh, 60_000);
      }
    };

    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client]);

  const current = state?.client === client ? state : null;
  const data = current?.data;
  const breakdown = data ? [
    { label: tr('Staking principal', 'Capital en staking'), value: data.stakingPrincipal },
    { label: tr('Staking yield, after fees', 'Rendimiento de staking, neto de comisiones'), value: data.stakingYield },
    { label: tr('Preferred stock', 'Acciones preferentes'), value: data.preferred },
    { label: tr('Insurance', 'Seguros'), value: data.insurance },
    { label: tr('Paid legacy unlocks', 'Liberaciones antiguas ya pagadas'), value: data.legacy },
  ] : [];

  return (
    <tr className="vy-committed">
      <td className="vy-committed__label">
        <details className="vy-committed__details">
          <summary>
            {tr('Committed VY — next 6 months', 'VY comprometido — próximos 6 meses')}
          </summary>
          <div className="vy-committed__body">
            <p>{tr(
              'VY already sold or owed to holders, available by the end of the next six calendar months. Includes amounts already claimable and unpaid staking yield due within the period.',
              'VY ya vendido o adeudado a sus titulares, disponible al finalizar los próximos seis meses calendario. Incluye montos ya reclamables y rendimientos de staking pendientes correspondientes al período.',
            )}</p>
            <p>{tr(
              'Excludes unsold treasury balances, unpaid legacy debt and amounts already claimed. Insurance holders can choose USDC instead of VY; renewals and early exits can change the amount and timing.',
              'Excluye saldos de tesorería no vendidos, deuda antigua sin pagar y montos ya reclamados. Los titulares de seguros pueden elegir USDC en lugar de VY; las renovaciones y salidas anticipadas pueden cambiar el monto y la fecha.',
            )}</p>
            {data && <>
              <p className="vy-committed__period">
                {dateLabel(data.asOf)} – {dateLabel(data.cutoff)} (UTC)
              </p>
              <dl className="vy-committed__breakdown">
                {breakdown.map(({ label, value }) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd><Value>{new Amount(VY, value)}</Value></dd>
                  </div>
                ))}
              </dl>
            </>}
            {!current && <p>{tr('Reading current contract obligations…', 'Consultando las obligaciones actuales de los contratos…')}</p>}
            {current && !data && <p>{tr(
              'The complete total is temporarily unavailable. Retrying automatically every minute.',
              'El total completo no está disponible temporalmente. Se reintentará automáticamente cada minuto.',
            )}</p>}
          </div>
        </details>
      </td>
      <td className="vy-committed__amount" aria-live="polite" aria-busy={!current}>
        {data
          ? <Value includeSybmol={false}>{new Amount(VY, data.total)}</Value>
          : current ? tr('Unavailable', 'No disponible') : tr('Loading…', 'Cargando…')}
      </td>
    </tr>
  );
}
