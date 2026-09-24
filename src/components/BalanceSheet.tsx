/**
 * VBSO balance-sheet presentation.
 *
 * FIVE BOXES, published together on purpose — never one alone. The projected price
 * leads on the left, two rows tall; the market it is projected from sits beside it,
 * and the two buyback counts close the row on the right:
 *
 *   projected   highest venue after VMMO spends  — each asset's book into its own
 *               its whole book (Mainnet.tsx)       pool; NOT VBSO.projectedVyPrice()
 *   market      sheet.usdPerVy                   — what VY trades at now
 *   loan/VY     borrowUsdPerVy                   — what a VY posted as collateral lends
 *   projected   undeployed book + today's        — what is still to be bought, and
 *    buyback    arbitrage gap                      only that; nothing already settled
 *   bought back bought back to date + held now   — the settled total, which only climbs
 *                                                  (so it is a box, not a chart line)
 *
 * The projection is a MECHANICAL buy-pressure calculation, not a forecast: it
 * assumes zero opposing flow for the entire deploy window, and much of the
 * liquidity it buys from is protocol-owned. The contract's own NatSpec requires
 * it to be shown with the inputs that produce it, so the tile carries ammo,
 * window and multiple inline — they are not optional decoration.
 *
 * floor (full) — equity ÷ circulating, which counts the covered loan book — was
 * removed from this panel on request. It read ~$1.22 against a ~$0.33 market
 * while being ~95% composed of loans collateralised in VY, i.e. a claim about VY
 * priced in VY. The underlying equity rows are still shown in the sheet below.
 */

import { tr } from '../utils/i18n';

export type Floors = {
  projected: number | null;
  /** The venue `projected` is read from — the highest one after the deploy. */
  projectedPool: string | null;
  projectedAmmoUsd: number;
  projectedWindowSec: number;
  projectedMultiple: number;
  /** Days until 99% of today's book has deployed — the horizon the projected price belongs to. */
  projectedDaysTo99: number | null;
  projectedError: string | null;
  /** What the whole undeployed book would buy off the market once it deploys. */
  burnProjectedVy: number | null;
  /** What the arbitrage would buy in the public pool at today's gap to the DAX; 0 when there is none. */
  burnArbVy: number | null;
  /** What the buyback officers have bought back to date, plus what they hold right now. */
  burnBoughtBackVy: number;
  hard: number;
  borrowUsdPerVy: number;
  ltvBps: number;
  maxLoanVy: number;
  /** The public VY/USDC pool: its own price, the only one anyone can actually trade at. */
  market: number;
  /** The VY oracle's median across the three DAX treasury pools — the public pool is not in it. */
  treasury: number;
  /** Hard assets plus the face value of the loan book — everything held or owed back. */
  tvl: number;
  circulating: number;
  equityUsd: number;
  hardEquityUsd: number;
  hardAssetsUsd: number;
  coveredLoansUsd: number;
  loansFaceUsd: number;
  stakerDebtUsd: number;
  mcapUsd: number;
  /** VBSO.vyOracle() — read live, so the tile cites whatever oracle is actually wired. */
  vyOracle: string | null;
};

const fmtDays = (sec: number) => {
  const d = sec / 86_400;
  return d >= 1 ? tr(`${d.toFixed(1)} days`, `${d.toFixed(1)} días`) : `${(sec / 3600).toFixed(1)} h`;
};

/** A VY quantity: whole tokens, because these are millions-scale counts. */
const fmtVy = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} VY`;

const fmtUsd = (n: number, dp = 4) =>
  n >= 1000
    ? '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : '$' + n.toFixed(dp);

export function BackingTiles({ floors }: { floors: Floors }) {
  return (
    <>
      <div className="vy-tiles">
        <div className="vy-tile">
          <div className="vy-tile__label">
            <span className="vy-swatch" style={{ background: 'var(--vy-series-1)' }} />
            {tr('Projected', 'Proyectado')}
          </div>
          <div className="vy-tile__value" style={{ color: 'var(--vy-series-1)' }}>
            {floors.projected == null ? '—' : fmtUsd(floors.projected)}
          </div>
          {floors.projected == null ? (
            <div className="vy-tile__caveat">{floors.projectedError ?? tr('unavailable', 'no disponible')}</div>
          ) : (
            <>
              <div className="vy-tile__hint">
                {tr(
                  `${floors.projectedPool} pool · ${floors.projectedMultiple.toFixed(2)}× the highest pool now · once VMMO deploys its book`,
                  `pool ${floors.projectedPool} · ${floors.projectedMultiple.toFixed(2)}× el pool más alto de ahora · cuando VMMO despliegue su libro`,
                )}
              </div>
              <div className="vy-tile__caveat">
                {tr('ammo', 'munición')} {fmtUsd(floors.projectedAmmoUsd, 0)}
                {floors.projectedDaysTo99 !== null && (
                  <>{tr(
                    ` · 99% deployed in ${floors.projectedDaysTo99} days`,
                    ` · 99% desplegado en ${floors.projectedDaysTo99} días`,
                  )}</>
                )}
              </div>
            </>
          )}
        </div>

        <div className="vy-tile">
          <div className="vy-tile__label">
            <span className="vy-swatch" style={{ background: 'var(--vy-dex-gold)' }} />
            {tr('Total VY Bought Back', 'Total de VY Recomprado')}
          </div>
          <div className="vy-tile__value vy-tile__value--count" style={{ color: 'var(--vy-dex-gold)' }}>
            {fmtVy(floors.burnBoughtBackVy)}
          </div>
          <div className="vy-tile__hint">
            {tr(
              'bought back to date, plus what the buyback officers hold right now',
              'recomprado hasta hoy, más lo que los oficiales de recompra mantienen ahora',
            )}
          </div>
        </div>

        <div className="vy-tile">
          <div className="vy-tile__label">
            <span className="vy-swatch" style={{ background: 'var(--vy-ink-2)' }} />
            {tr('Market', 'Mercado')}
          </div>
          <div className="vy-tile__value" style={{ color: 'var(--vy-ink-2)' }}>
            {fmtUsd(floors.market)}
          </div>
          <div className="vy-tile__hint">{tr('what VY actually trades at', 'a lo que realmente cotiza VY')}</div>
          <div className="vy-tile__caveat">
            {tr('price of the public ', 'precio del ')}
            <a href="https://etherscan.io/address/0xf96cCac0bfd5de8d1F69EA9F9f43ed3B174c2705" target="_blank" rel="noreferrer">
              {tr('VY/USDC pool', 'pool público VY/USDC')}
            </a>
            {tr(' itself — USDC reserve ÷ VY reserve', ' — reserva de USDC ÷ reserva de VY')}
          </div>
        </div>

        <div className="vy-tile">
          <div className="vy-tile__label">
            <span className="vy-swatch" style={{ background: 'var(--vy-ink-line)' }} />
            {tr('Treasury Value', 'Valor del Tesoro')}
          </div>
          <div className="vy-tile__value" style={{ color: 'var(--vy-ink-line)' }}>
            {fmtUsd(floors.treasury)}
          </div>
          <div className="vy-tile__hint">
            {tr(
              "the treasury's own three pools — VY/WETH, VY/WBTC, VY/PAXG",
              'los tres pools propios del tesoro — VY/WETH, VY/WBTC, VY/PAXG',
            )}
          </div>
          <div className="vy-tile__caveat">
            {tr('time-weighted median from the Valinity ', 'mediana ponderada por tiempo del ')}
            {floors.vyOracle ? (
              <a href={`https://etherscan.io/address/${floors.vyOracle}`} target="_blank" rel="noreferrer">
                {tr('price oracle', 'oráculo de precios de Valinity')}
              </a>
            ) : tr('price oracle', 'oráculo de precios de Valinity')}
            {tr('. The public pool is not in it — nobody trades there.',
                '. El pool público no forma parte de ella — nadie negocia ahí.')}
          </div>
        </div>

        <div className="vy-tile">
          <div className="vy-tile__label">
            <span className="vy-swatch" style={{ background: 'var(--vy-green)' }} />
            {tr('Loan to VY value', 'Préstamo por valor de VY')}
          </div>
          <div className="vy-tile__value" style={{ color: 'var(--vy-green)' }}>
            {fmtUsd(floors.borrowUsdPerVy)}
          </div>
          <div className="vy-tile__hint">
            {tr(
              `per VY posted, at ${(floors.ltvBps / 100).toFixed(0)}% LTV`,
              `por VY en garantía, al ${(floors.ltvBps / 100).toFixed(0)}% de LTV`,
            )}
          </div>
          <div className="vy-tile__caveat">
            {tr(
              `max ${floors.maxLoanVy.toLocaleString('en-US', { maximumFractionDigits: 0 })} VY per loan`,
              `máx. ${floors.maxLoanVy.toLocaleString('en-US', { maximumFractionDigits: 0 })} VY por préstamo`,
            )}
          </div>
        </div>

        <div className="vy-tile">
          <div className="vy-tile__label">
            <span className="vy-swatch" style={{ background: 'var(--vy-series-2)' }} />
            {tr('Projected VY Buyback', 'Recompra Proyectada de VY')}
          </div>
          <div className="vy-tile__value vy-tile__value--count" style={{ color: 'var(--vy-series-2)' }}>
            {floors.burnProjectedVy === null && floors.burnArbVy === null
              ? '—'
              : fmtVy((floors.burnProjectedVy ?? 0) + (floors.burnArbVy ?? 0))}
          </div>
          <div className="vy-tile__hint">
            {floors.burnProjectedVy === null
              ? tr('the book is unavailable', 'el libro no está disponible')
              : tr(
                `${fmtVy(floors.burnProjectedVy)} the VMMO book will buy`,
                `${fmtVy(floors.burnProjectedVy)} que comprará el libro de VMMO`,
              )}
            {' · '}
            {floors.burnArbVy === null
              ? tr('pool depth unavailable', 'profundidad de los pools no disponible')
              : floors.burnArbVy > 0
                ? tr(
                  `${fmtVy(floors.burnArbVy)} the arbitrage will buy at today's gap to treasury value`,
                  `${fmtVy(floors.burnArbVy)} que comprará el arbitraje con la brecha actual al valor del tesoro`,
                )
                : tr(
                  'nothing from the arbitrage — the market is at or above treasury value',
                  'nada del arbitraje — el mercado está en o por encima del valor del tesoro',
                )}
          </div>
        </div>

      </div>

    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Holdings / Debt / Invested / Equity
// ─────────────────────────────────────────────────────────────
/**
 * The four-column balance sheet, every input read from VMMO:
 *
 *   HOLDINGS  VMMO.heldOf(asset) — system holdings, all five sources
 *   DEBT      aggReservedAsset + aggWithdrawingAsset — principal + unclaimed yield
 *             Debt is shown against the asset that BACKS it: the USDC book's
 *             invested slice (USDC debt − USDC held, split pro-rata on holdings
 *             because nothing on chain tags which WBTC came from which USDC)
 *             moves onto WETH/WBTC/PAXG.
 *   EQUITY    holdings − debt, per asset
 *
 * Every row reconciles: holdings − debt = equity, and the totals do too.
 */
export type AssetRow = {
  symbol: string;
  heldNative: string;
  heldUsd: number;
  debtNative: string;
  debtUsd: number;
  equityUsd: number;
};

export type AssetTable = {
  rows: AssetRow[];
  totals: { held: number; debt: number; equity: number; ratio: number };
  /** The TVL column: held, owed back, and the VY locked as collateral for the owed part. */
  locked: { heldUsd: number; owedUsd: number; collateralVy: number };
};

// Minus sign OUTSIDE the dollar sign — `'$' + (-20921).toLocaleString()` would
// render "$-20,921". Rows can legitimately go negative now that debt is shown per
// asset rather than spread, so this is a live path, not a defensive branch.
const money = (n: number) =>
  (n < 0 ? '\u2212$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

function Col({
  title, sub, children, accent,
}: { title: string; sub: string; children: React.ReactNode; accent?: string }) {
  return (
    <div className="vy-col">
      <div className="vy-col__head" style={accent ? { color: accent } : undefined}>{title}</div>
      <div className="vy-col__sub">{sub}</div>
      {children}
    </div>
  );
}

function Cell({ sym, native, usd, muted }: { sym: string; native: string | null; usd: number; muted?: boolean }) {
  return (
    <div className={`vy-cell${muted ? ' vy-cell--muted' : ''}`}>
      <div className="vy-cell__sym">{sym}</div>
      <div className="vy-cell__native">{native ?? '—'}</div>
      <div className="vy-cell__usd">{money(usd)}</div>
    </div>
  );
}

export function HoldingsTable({ table }: { table: AssetTable }) {
  const { rows, totals, locked } = table;
  const over = totals.held >= totals.debt;

  return (
    <div className="vy-sheet">
      <div className="vy-cols vy-cols--locked">
        {/* The widest measure, first: everything the system holds or is owed back. Its rows are
            not per-asset like the three beside it, so they do not share their baselines. */}
        <Col
          title={tr('Total Value Locked', 'Valor Total Bloqueado')}
          sub={tr('held, owed back, and the VY locked for it', 'en tenencia, por cobrar, y el VY bloqueado por ello')}
          accent="#1d5fd0"
        >
          <div className="vy-cell">
            <div className="vy-cell__sym">{tr('Held', 'En tenencia')}</div>
            <div className="vy-cell__native">{tr('hard assets on hand', 'activos duros disponibles')}</div>
            <div className="vy-cell__usd">{money(locked.heldUsd)}</div>
          </div>
          <div className="vy-cell">
            <div className="vy-cell__sym">{tr('Owed to the system', 'Adeudado al sistema')}</div>
            <div className="vy-cell__native">{tr('loans out, at face', 'préstamos vigentes, a valor nominal')}</div>
            <div className="vy-cell__usd">{money(locked.owedUsd)}</div>
          </div>
          {/* A COUNT, not dollars: it secures the row above rather than adding to it, so it is
              marked as VY and left out of the total below. */}
          <div className="vy-cell vy-cell--vy">
            <div className="vy-cell__sym">{tr('VY locked for it', 'VY bloqueado por ello')}</div>
            <div className="vy-cell__native">{tr('collateral treasury', 'tesorería de garantías')}</div>
            <div className="vy-cell__usd">{fmtVy(locked.collateralVy)}</div>
          </div>
          <div className="vy-col__total">{money(locked.heldUsd + locked.owedUsd)}</div>
        </Col>

        <Col title={tr('Holdings', 'Tenencias')} sub={tr('total ecosystem holdings', 'tenencias totales del ecosistema')} accent="var(--vy-series-1)">
          {rows.map((r) => <Cell key={r.symbol} sym={r.symbol} native={r.heldNative} usd={r.heldUsd} />)}
          <div className="vy-col__total">{money(totals.held)}</div>
        </Col>

        <Col title={tr('Debt', 'Deuda')} sub={tr('principal + unclaimed yield, per asset', 'principal + rendimiento no reclamado, por activo')} accent="var(--vy-series-2)">
          {rows.map((r) => <Cell key={r.symbol} sym={r.symbol} native={r.debtNative} usd={r.debtUsd} />)}
          <div className="vy-col__total">{money(totals.debt)}</div>
        </Col>

        <Col title={tr('Equity', 'Patrimonio')} sub={tr('holdings minus debt', 'tenencias menos deuda')}>
          {rows.map((r) => (
            <div className="vy-cell" key={r.symbol}>
              <div className="vy-cell__sym">{r.symbol}</div>
              <div className="vy-cell__native">&nbsp;</div>
              <div className={`vy-cell__usd${r.equityUsd < 0 ? ' vy-cell__usd--neg' : ''}`}>
                {money(r.equityUsd)}
              </div>
            </div>
          ))}
          <div className="vy-col__total">{money(totals.equity)}</div>
        </Col>
      </div>

      <div className={`vy-verdict${over ? '' : ' vy-verdict--bad'}`}>
        <span className="vy-verdict__mark">{over ? '✓' : '✗'}</span>
        <span>
          <strong>{money(totals.held)}</strong> {tr('held against', 'respaldado frente a')}{' '}
          <strong>{money(totals.debt)}</strong> {tr('owed', 'adeudado')} —{' '}
          <strong>{totals.ratio.toFixed(2)}×</strong>{' '}
          {over ? tr('overcollateralized', 'sobrecolateralizado') : tr('UNDERCOLLATERALIZED', 'SUBCOLATERALIZADO')}, {tr('equity', 'patrimonio')}{' '}
          <strong>{money(totals.equity)}</strong>
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Era ladder
// ─────────────────────────────────────────────────────────────
/**
 * Market-cap ratchet. The reached rung carries the check; the rest are targets.
 *
 * Each rung shows the interest ceiling it unlocks. The rate is the premium anchor
 * (read live) scaled by that era's multiplier, so the ladder steps DOWN as the
 * market cap grows: 100% of anchor at era 0, then 80.28 / 64.44 / 51.94 / 41.67%.
 * Those multipliers are `internal pure` in the contract and cannot be read, so
 * they are transcribed here — and the rung for the CURRENT era is checked against
 * the live `eraMaxBps`. A mismatch is shown rather than silently printed wrong.
 */
export type AssetMult = {
  symbol: string;
  multBps: number;
  /** Set when the asset is NOT priced by the era model — VY is quoted by the VYO,
   *  which never reads `era`. Rendered flat in every rung instead of stepping down,
   *  because a rate that does not ratchet must not be drawn as if it did. */
  fixedBps?: number;
};

export function EraLadder({
  era, mcapUsd, anchorBps, liveEraMaxBps, assetMults, tier3TermDays, vyPriceUsd,
}: {
  era: number; mcapUsd: number; anchorBps: number; liveEraMaxBps: number;
  assetMults: AssetMult[]; tier3TermDays: number; vyPriceUsd: number;
}) {
  const rungs = [
    { era: 0, label: 'Era 0', threshold: 0, multBps: 10_000 },
    { era: 1, label: '$7M', threshold: 7_000_000, multBps: 8_028 },
    { era: 2, label: '$70M', threshold: 70_000_000, multBps: 6_444 },
    { era: 3, label: '$700M', threshold: 700_000_000, multBps: 5_194 },
    { era: 4, label: '$7B', threshold: 7_000_000_000, multBps: 4_167 },
  ].map((r) => ({
    ...r,
    // Math.floor replicates the contract's uint16 truncation — without it era 1
    // prints 14.26% where the chain says 14.25%.
    ratePct: Math.floor((anchorBps * r.multBps) / 10_000) / 100,
    relPct: r.multBps / 100,
  }));

  const hasFixed = assetMults.some((a) => a.fixedBps !== undefined);
  const next = rungs.find((r) => r.era === era + 1);
  const current = rungs.find((r) => r.era === era);
  // 1 bp of tolerance: the contract floors the multiply, we do not.
  const drift =
    current && Math.abs(current.ratePct * 100 - liveEraMaxBps) > 1;

  return (
    <div className="vy-ladder-wrap">
      {/* States the BASIS on the right, where the eye lands after the rungs. These
          are ceilings at the top tier over its full term — not an APY and not what
          a tier 1 stake quotes — so the qualifier travels with the numbers. */}
      <div className="vy-ladder__head">
        <span>{tr('Max yield ceiling per asset', 'Techo máximo de rendimiento por activo')}</span>
        {tier3TermDays > 0 && (
          <span className="vy-ladder__term">
            {tr('premium tier 3 · total over a', 'nivel premium 3 · total en un plazo de')}{' '}
            <strong>{tr(`${tier3TermDays}-day`, `${tier3TermDays} días`)}</strong>
            {tr(' term', '')}
          </span>
        )}
      </div>
      <div className="vy-ladder">
        {rungs.map((r) => (
          <div
            key={r.era}
            className={`vy-rung${r.era === era ? ' vy-rung--now' : ''}${r.era < era ? ' vy-rung--done' : ''}`}
          >
            <div className="vy-rung__top">
              <span className="vy-rung__mark">{r.era <= era ? '✓' : ''}</span>
              {r.label}
            </div>
            <div className="vy-rung__rate">{r.ratePct.toFixed(2)}%</div>
            <div className="vy-rung__rel">{tr(`${r.relPct.toFixed(0)}% of anchor`, `${r.relPct.toFixed(0)}% del ancla`)}</div>

            {assetMults.length > 0 && (
              <div className="vy-rung__assets">
                {assetMults.map((a) => {
                  // Math.floor twice: the contract truncates to uint16 at each step.
                  const capBps = Math.floor((anchorBps * r.multBps) / 10_000);
                  // `fixedBps` opts out of the ratchet entirely — see AssetMult.
                  const bps = a.fixedBps ?? Math.floor((capBps * a.multBps) / 10_000);
                  // Bars are scaled against ONE fixed reference — the anchor at era 0,
                  // which is USDC's ceiling — so a bar's length means the same thing in
                  // every rung and the staircase is visible across the whole ladder.
                  // Scaling per-rung would make every rung look identical.
                  const w = Math.max(2, (bps / anchorBps) * 100);
                  return (
                    <div
                      className={`vy-arate${a.fixedBps ? ' vy-arate--fixed' : ''}`}
                      key={a.symbol}
                      title={a.fixedBps
                        ? tr(
                          `${a.symbol} is quoted by the VYO, which does not read the era — this rate does not step down.`,
                          `${a.symbol} lo cotiza el VYO, que no lee la era — esta tasa no baja.`,
                        )
                        : undefined}
                    >
                      <span className="vy-arate__sym">{a.symbol}</span>
                      <span className="vy-arate__track">
                        <span className="vy-arate__fill" style={{ width: `${w}%` }} />
                      </span>
                      <span className="vy-arate__pct">{(bps / 100).toFixed(2)}%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {/* Sixth cell, filling the space the five rungs leave. It carries the
            market cap that DRIVES the ratchet plus the explanation, so cause and
            effect sit on one line instead of the reader pairing a figure at the
            bottom of the section with a ladder at the top. */}
        <div className="vy-rung vy-rung--note">
          <div className="vy-rung__top">{tr('Market cap', 'Capitalización de Mercado')}</div>
          <div className="vy-mcap">{money(mcapUsd)}</div>
          <div className="vy-rung__note-body">
            {tr(
              'Max interest steps down as market cap grows.',
              'El interés máximo baja a medida que crece la capitalización de mercado.',
            )}{' '}
            {next && (
              <>
                {tr(
                  `${money(next.threshold - mcapUsd)} more reaches era ${next.era}, cutting the ceiling from ${current?.ratePct.toFixed(2) ?? ''}% to ${next.ratePct.toFixed(2)}%.`,
                  `${money(next.threshold - mcapUsd)} más alcanza la era ${next.era}, bajando el techo de ${current?.ratePct.toFixed(2) ?? ''}% a ${next.ratePct.toFixed(2)}%.`,
                )}
              </>
            )}
            {!next && <>{tr('Final era — the ceiling does not step down again.', 'Era final — el techo no vuelve a bajar.')}</>}
          </div>
          {drift && (
            <div className="vy-rung__drift">
              {tr(
                `Ladder disagrees with on-chain eraMaxBps (${(liveEraMaxBps / 100).toFixed(2)}%) — multiplier table is stale.`,
                `La escalera no coincide con eraMaxBps on-chain (${(liveEraMaxBps / 100).toFixed(2)}%) — la tabla de multiplicadores está desactualizada.`,
              )}
            </div>
          )}
        </div>
      </div>

      {/* The price the market cap above is struck at, and the one caveat the bars
          cannot carry themselves. Both sit at the bottom because both qualify every
          number above them. */}
      <div className="vy-ladder__foot">
        <span>
          VY <strong>${vyPriceUsd.toFixed(4)}</strong>
          <span className="vy-ladder__foot-sep">·</span>
          {tr(
            'treasury value × total supply, as the contract computes it — the era ratchet reads this, not the public pool',
            'valor del tesoro × suministro total, tal como lo calcula el contrato — el trinquete de eras lee esto, no el pool público',
          )}
        </span>
        {hasFixed && (
          <span>
            {tr("VY's own rate is set by the", 'La tasa propia de VY la fija el')}{' '}
            <strong>VYO</strong>
            {tr(
              ', not by the era — it is shown flat because it does not step down with the rungs.',
              ', no la era — se muestra plana porque no baja con los escalones.',
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Trading volume
// ─────────────────────────────────────────────────────────────
export type VolumeRow = {
  symbol: string;
  day: number; month: number; all: number;
  dayCount: number; monthCount: number; allCount: number;
};

export type VolumeData = {
  rows: VolumeRow[];
  totals: { day: number; month: number; all: number };
  txCount: { day: number; month: number; all: number };
};

/**
 * Asset flow through each venue, in USD. Historical flow is valued at TODAY's
 * marks — per-trade historical pricing is not available from a transfer log, so
 * the all-time column is "what that flow is worth now", not what it was worth
 * when it happened. The 24h column is unaffected in practice.
 */
export function TradingVolume({
  volume, progress,
}: { volume: VolumeData | null; progress: { done: number; total: number } | null }) {
  if (!volume) {
    return (
      <div className="vy-vol">
        <div className="vy-vol__title">{tr('Trading volume', 'Volumen de negociación')}</div>
        <div className="vy-vol__loading">
          {progress && progress.total > 0
            ? tr(
              `indexing VY transactions… ${progress.done.toLocaleString('en-US')} / ${progress.total.toLocaleString('en-US')}`,
              `indexando transacciones de VY… ${progress.done.toLocaleString('en-US')} / ${progress.total.toLocaleString('en-US')}`,
            )
            : tr('reading transfer logs…', 'leyendo registros de transferencias…')}
        </div>
      </div>
    );
  }
  const { rows, totals } = volume;
  return (
    <div className="vy-vol">
      <div className="vy-vol__title">{tr('Trading volume', 'Volumen de negociación')}</div>
      <table className="vy-vol__table">
        <thead>
          <tr>
            <th />
            <th>24h</th>
            <th>30d</th>
            <th>{tr('All time', 'Histórico')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol}>
              <td className="vy-vol__sym">{r.symbol}</td>
              <td>{money(r.day)}</td>
              <td>{money(r.month)}</td>
              <td>{money(r.all)}</td>
            </tr>
          ))}
          <tr className="vy-vol__total">
            <td>Total</td>
            <td>{money(totals.day)}</td>
            <td>{money(totals.month)}</td>
            <td>{money(totals.all)}</td>
          </tr>
        </tbody>
      </table>
      <div className="vy-vol__note">
        {tr(
          `every USDC/WBTC/WETH/PAXG leg inside a VY transaction (${volume.txCount.all.toLocaleString('en-US')} txs indexed), valued at today's marks.`,
          `cada tramo de USDC/WBTC/WETH/PAXG dentro de una transacción de VY (${volume.txCount.all.toLocaleString('en-US')} txs indexadas), valorado a los precios de hoy.`,
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Market-maker desk
// ─────────────────────────────────────────────────────────────

export type DeskRow = {
  symbol: string;
  heldNative: string;
  heldUsd: number;
  readyNative: string;
  readyUsd: number;
  lastAccrual: number;
};

export type ProjPoint = {
  label: string;
  deployedPct: number;
  /** Highest venue price after the deploy, and which venue it is. */
  priceUsd: number;
  pool: string;
};

export type Desk = {
  deployWindowSec: number;
  stalestAccrual: number;
  rows: DeskRow[];
  totalHeldUsd: number;
  totalReadyUsd: number;
  /** `livePriceUsd`/`livePool`: the highest venue before any deploy — the × baseline. */
  projCurve: { livePriceUsd: number; livePool: string; rows: ProjPoint[] } | null;
  errors: string[];
};

/**
 * The desk's own book, not the same coins valued again.
 *
 * `held` is inventory sitting on the officer awaiting deployment; the drip
 * releases it over `deployWindow`, and `ready` is the slice released so far.
 * Read as a pair they answer "how much dry powder, and how much of it can move
 * today" — which is the question the projected-price tile's ammo figure begs.
 */
export function MarketMakerDesk({ desk }: { desk: Desk }) {

  return (
    <div className="vy-desk">
      <div className="vy-desk__head">
        <div>
          <div className="vy-desk__label">{tr('Undeployed book', 'Libro sin desplegar')}</div>
          <div className="vy-desk__big">{fmtUsd(desk.totalHeldUsd, 0)}</div>
        </div>
        <div>
          <div className="vy-desk__label">{tr('Ready to deploy', 'Listo para desplegar')}</div>
          <div className="vy-desk__big">{fmtUsd(desk.totalReadyUsd, 0)}</div>
        </div>
        <div>
          <div className="vy-desk__label">{tr('Deploy window', 'Ventana de despliegue')}</div>
          <div className="vy-desk__big">{fmtDays(desk.deployWindowSec)}</div>
        </div>
      </div>

      <table className="vy-desk__table">
        <thead>
          <tr>
            <th />
            <th>{tr('holdings', 'tenencias')}</th>
            <th>{tr('ready to deploy', 'listo para desplegar')}</th>
          </tr>
        </thead>
        <tbody>
          {desk.rows.map((r) => (
            <tr key={r.symbol}>
              <td><strong>{r.symbol}</strong></td>
              <td>
                {r.heldNative}
                <span className="vy-desk__usd">{fmtUsd(r.heldUsd, 0)}</span>
              </td>
              <td>
                {r.readyNative}
                <span className="vy-desk__usd">{fmtUsd(r.readyUsd, 0)}</span>
              </td>

            </tr>
          ))}
        </tbody>
      </table>

      {desk.projCurve && (
        <div className="vy-proj">
          <div className="vy-proj__title">
            {tr('Projected VY as the book deploys', 'VY proyectado a medida que se despliega el libro')}
            <span className="vy-proj__tag">
              {tr(
                `highest pool · × vs ${desk.projCurve.livePool} pool now ${fmtUsd(desk.projCurve.livePriceUsd)} · not a forecast`,
                `pool más alto · × vs pool ${desk.projCurve.livePool} ahora ${fmtUsd(desk.projCurve.livePriceUsd)} · no es un pronóstico`,
              )}
            </span>
          </div>

          <table className="vy-desk__table">
            <thead>
              <tr>
                <th />
                <th>{tr('book deployed', 'libro desplegado')}</th>
                <th>{tr('projected VY', 'VY proyectado')}</th>
                <th>pool</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {desk.projCurve.rows.map((r) => {
                const x = r.priceUsd / desk.projCurve!.livePriceUsd;
                return (
                  <tr key={r.label}>
                    <td><strong>{r.label}</strong></td>
                    <td>{r.deployedPct.toFixed(1)}%</td>
                    <td>{fmtUsd(r.priceUsd)}</td>
                    <td>{r.pool}</td>
                    <td className="vy-proj__x">{x.toFixed(2)}×</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

        </div>
      )}
    </div>
  );
}
