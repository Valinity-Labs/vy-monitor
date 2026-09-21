import { useEffect, useMemo, useState } from 'react';
import { useLiveTail } from '../utils/liveTail';
import { PriceChart, type ChartOverlay } from './PriceChart';
import { TradeTape } from './TradeTape';
import {
  compareTrades, dropManipulatedTransactions, loadAllTrades, withEthGapBridge, type EraId, type Trade,
} from '../utils/priceHistory';
import {
  mergeVyOracleSamples, VY_ORACLE_SNAPSHOT, vyOraclePriceAt,
} from '../utils/vyOracleHistory';
import {
  mergeVyProjectionSamples, VY_PROJECTION_SNAPSHOT, vyProjectionPriceAt,
} from '../utils/vyProjectionHistory';
import {
  mergeVyBuybackSamples, VY_BUYBACK_SNAPSHOT, vyBuybackFutureUsdAt, vyBuybackFutureVyAt,
} from '../utils/vyBuybackHistory';
import { DATE_LOCALE, tr } from '../utils/i18n';

/**
 * VALINITY PRICE — the page's lead section: candles above, the tape below.
 *
 * It opens on the CURRENT pool only — the market a visitor can actually trade today. "Since
 * Genesis" widens the chart, the stats and the tape together to every contract since 2021 (MFC
 * on BNB Chain, then VY on Ethereum), so all three always describe the same set of trades.
 *
 * The current-pool view draws two reference lines beside the candles. FAIR VALUE is the official
 * DEX-oracle median VY/USD across the VY/WETH, VY/WBTC and VY/PAXG treasury pools. PROJECTED —
 * shaded, because it is a simulation and not a market — is where VMMO's whole book would take VY
 * in its best venue, replayed block by block (scripts/build-vy-projection-history.mjs). It starts
 * where VMMO was deployed and nowhere earlier. Neither line can be switched off: they are the two
 * numbers the page exists to compare the market price against. (The BTC/ETH/gold comparisons were
 * removed: valinity.io already shows that comparison.)
 *
 * IT DRAWS ON THE FIRST FRAME. History ships in the bundle, so the chart and the tape are on
 * screen in about a second, and the live catch-up (useLiveTail) streams into the same chart a
 * few seconds later — TradingView takes the new candles through the datafeed, so nothing is
 * rebuilt and the viewer's zoom survives. Until it lands, the newest candle and the price stat
 * are as recent as the last deploy. The rest of the monitor loads underneath, behind its own
 * loading screen, rather than holding this section back.
 */

const LIVE_ERA: EraId = 'vy-current';
const FAIR_VALUE_ID = 'vy-fair-value';
const FAIR_VALUE_LABEL = tr('Fair Value', 'Valor Justo');
const PROJECTED_ID = 'vy-projected';
const PROJECTED_LABEL = tr('Projected', 'Proyectado');
const FUTURE_ID = 'vy-buyback-future';
const FUTURE_LABEL = tr('Future Buyback', 'Recompra Futura');

type View = 'live' | 'genesis';

// A view's own resolution applies on "All": WEEKLY for both — ~23 candles for the current pool,
// ~230 for the lineage (at daily the lineage would be 1,600 sub-pixel candles that read as a line).
// The current pool actually opens on 30D, whose daily candles come from RANGES.
const VIEWS: Record<View, { symbol: string; exchange: string; resolution: string; sub: string }> = {
  live: {
    symbol: 'VY', exchange: 'Uniswap V2', resolution: '1W',
    sub: tr('Current pool · VY/USDC on Uniswap V2 · Ethereum', 'Pool actual · VY/USDC en Uniswap V2 · Ethereum'),
  },
  genesis: {
    symbol: 'VALINITY', exchange: 'Valinity', resolution: '1W',
    sub: tr('Every Valinity contract since genesis · MFC on BNB Chain, then VY on Ethereum',
      'Todos los contratos de Valinity desde el génesis · MFC en BNB Chain, luego VY en Ethereum'),
  },
};

type RangeKey = '30d' | '3m' | '6m' | '12m' | 'all';

// Each range opens at a resolution that gives its candles real width; "All" keeps the view's own.
const RANGES: { key: RangeKey; label: string; resolution?: string }[] = [
  { key: '30d', label: '30D', resolution: '1D' },
  { key: '3m', label: '3M', resolution: '1D' },
  { key: '6m', label: '6M', resolution: '1D' },
  { key: '12m', label: '12M', resolution: '1D' },
  { key: 'all', label: tr('All', 'Todo') },
];

/** Where a range starts, unix seconds; null for all time. Months are calendar months. */
function rangeStart(key: RangeKey, nowMs: number): number | null {
  if (key === 'all') return null;
  if (key === '30d') return Math.floor(nowMs / 1000) - 30 * 86_400;
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - (key === '3m' ? 3 : key === '6m' ? 6 : 12));
  return Math.floor(d.getTime() / 1000);
}

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(DATE_LOCALE, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

const fmtPrice = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 4 : 2 });

/** A VY count for the legend: 1,128,217 reads as 1.13M VY beside the prices. */
const fmtVy = (n: number) =>
  (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n.toLocaleString('en-US', { maximumFractionDigits: 0 })) + ' VY';

/** A dollar figure for the legend, short enough to sit in a chip: $148,017 reads as $148K. */
const fmtUsdShort = (n: number) =>
  '$' + (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : n.toFixed(0));

const fmtPct = (ratio: number) => {
  if (!Number.isFinite(ratio)) return '—';
  const p = Math.abs(ratio * 100);
  return (ratio >= 0 ? '+' : '−') + p.toLocaleString('en-US', { maximumFractionDigits: p >= 100 ? 0 : 1 }) + '%';
};

// One shared empty list, so the Since Genesis view does not rebuild the chart when the
// benchmark tail arrives.
// The tape does not scroll inside itself, so it shows what fits under the chart and no more.
const TAPE_ROWS = 12;

const NO_OVERLAYS: ChartOverlay[] = [];
// The chart is what the page is for, so it gets real height — except on a phone, where 620px
// would be the whole screen. Decided once at load, like the language.
const CHART_HEIGHT =
  typeof window !== 'undefined' && window.matchMedia('(max-width: 40rem)').matches ? 440 : 620;
// Both lines start on; each legend chip is the switch for its own line.
const LINES_ON: Record<string, boolean> = {
  [FAIR_VALUE_ID]: true, [PROJECTED_ID]: true, [FUTURE_ID]: true,
};

function Stat({ label, value, lead }: { label: string; value: string; lead?: boolean }) {
  return (
    <div className={lead ? 'vy-price__stat vy-price__stat--lead' : 'vy-price__stat'}>
      <div className="vy-price__stat-label">{label}</div>
      <div className="vy-price__stat-value">{value}</div>
    </div>
  );
}

// Each view's opening range: the current pool opens on the last 30 days at daily candles — 30
// candles, one per day; Since Genesis opens on the whole history, which is the point of that view.
const DEFAULT_RANGE: Record<View, RangeKey> = { live: '30d', genesis: 'all' };
const openingRange = (v: View) => ({ key: DEFAULT_RANGE[v], from: rangeStart(DEFAULT_RANGE[v], Date.now()) });

export function LifetimePrice({ onReady }: { onReady?: () => void }) {
  const [view, setView] = useState<View>('live');
  // The start is fixed when the range is chosen, so "last 3 months" does not creep forward (and
  // rebuild the chart) on every re-render.
  const [range, setRange] = useState<{ key: RangeKey; from: number | null }>(() => openingRange('live'));
  // Which reference lines are drawn. The chart legend's own eye stays in step with these chips.
  const [linesOn, setLinesOn] = useState<Record<string, boolean>>(LINES_ON);
  const snapshot = useMemo(() => loadAllTrades(), []);
  const tail = useLiveTail();

  // The committed snapshot plus everything since. The flash-loan filter runs again over the live
  // pool's merged trades, so a manipulation that happens after the snapshot is dropped too. The
  // SAME array comes back when nothing is new, so nothing downstream redraws.
  const trades = useMemo(() => {
    if (!tail.trades.length) return snapshot;
    const seen = new Set(snapshot.map((t) => t.key));
    const fresh = tail.trades.filter((t) => !seen.has(t.key));
    if (!fresh.length) return snapshot;
    const merged = [...snapshot, ...fresh].sort(compareTrades);
    const keep = new Set(dropManipulatedTransactions(merged.filter((t) => t.era === LIVE_ERA)).map((t) => t.key));
    return merged.filter((t) => t.era !== LIVE_ERA || keep.has(t.key));
  }, [snapshot, tail.trades]);

  const oracleSamples = useMemo(
    () => mergeVyOracleSamples(VY_ORACLE_SNAPSHOT, tail.vyOracle),
    [tail.vyOracle]
  );
  const projectionSamples = useMemo(
    () => mergeVyProjectionSamples(VY_PROJECTION_SNAPSHOT, tail.vyProjection),
    [tail.vyProjection]
  );
  const buybackSamples = useMemo(
    () => mergeVyBuybackSamples(VY_BUYBACK_SNAPSHOT, tail.vyBuyback),
    [tail.vyBuyback]
  );

  const shown = useMemo(
    () => (view === 'live' ? trades.filter((t) => t.era === LIVE_ERA) : trades),
    [trades, view]
  );
  // The chart alone also draws synthetic continuity points; stats and tape stay real trades. In
  // the live view, carry the unchanged VY/USDC reserve price to the newest oracle observation so
  // a quiet pool can still be compared with today's DEX median. In the lineage view, bridge the
  // documented gap between the two Ethereum markets.
  const charted = useMemo(() => {
    if (view !== 'live') return withEthGapBridge(shown);
    const last = shown[shown.length - 1];
    const oracleHead = oracleSamples[oracleSamples.length - 1];
    if (!last || !oracleHead || oracleHead.ts <= last.ts) return shown;
    return [...shown, {
      ...last,
      ts: oracleHead.ts,
      execPrice: last.price,
      qty: 0,
      usd: 0,
      key: `vy-current-carry:${oracleHead.block}`,
      seq: (last.seq ?? 0) + 1,
      synthetic: true,
    }];
  }, [shown, view, oracleSamples]);

  // Where the comparison starts: VY's price at the left edge of the chosen range (the last trade
  // at or before it), or the first trade when the range reaches back past the start of the data.
  const anchor = useMemo(() => {
    if (!shown.length) return null;
    if (range.from === null || range.from <= shown[0].ts) return { ts: shown[0].ts, price: shown[0].price };
    let prev = shown[0];
    for (const t of shown) {
      if (t.ts > range.from) break;
      prev = t;
    }
    return { ts: range.from, price: prev.price };
  }, [shown, range.from]);

  // Fair value is the oracle's real VY/USD median — never rebased, and never painted backward
  // before the oracle existed.
  const overlays = useMemo<ChartOverlay[]>(() => {
    if (view !== 'live' || !anchor) return NO_OVERLAYS;
    return [{
      id: FAIR_VALUE_ID,
      label: FAIR_VALUE_LABEL,
      color: '#e5c983',
      colorLight: '#9a6a20',
      lineWidth: 3,
      locked: true,
      valueAt: (ms: number) => vyOraclePriceAt(oracleSamples, ms),
    }, {
      id: PROJECTED_ID,
      label: PROJECTED_LABEL,
      color: '#4d8ff5',
      colorLight: '#2a78d6',
      lineWidth: 2,
      plotType: 'area',
      // The wash stays the quiet blue; the stroke on top is brighter, so the line reads against
      // its own shading.
      lineColor: '#59d7ff',
      lineColorLight: '#1273d4',
      locked: true,
      valueAt: (ms: number) => vyProjectionPriceAt(projectionSamples, ms),
    }, {
      // The ONLY panel under the candles, and the only buyback number that moves both ways: the
      // settled total only ever climbs, so it is a balance-sheet box rather than a line.
      id: FUTURE_ID,
      label: tr('Future buyback $', 'Recompra futura $'),
      baseLabel: tr('Future buyback VY', 'Recompra futura VY'),
      // Deeper orange for the VY line, bright for the dollars.
      color: '#c2410c',
      colorLight: '#9a3412',
      lineColor: '#ffb066',
      lineColorLight: '#c2410c',
      lineWidth: 2,
      pane: 'own',
      format: 'volume',
      locked: true,
      // TWO UNITS, one panel. Dollars are what the desk raises; VY is what the pools can actually
      // give up, and it saturates — today the book's dollars jumped 37% while the VY it buys rose
      // 13%. They sit close enough in magnitude ($148k against 55k VY) to share one scale.
      valueAt: (ms: number) => vyBuybackFutureUsdAt(buybackSamples, ms),
      baseValueAt: (ms: number) => vyBuybackFutureVyAt(buybackSamples, ms),
    }];
  }, [view, anchor, oracleSamples, projectionSamples, buybackSamples]);

  const empty = !shown.length;
  useEffect(() => { if (empty) onReady?.(); }, [empty, onReady]);

  if (empty) {
    return (
      <div className="vy-price">
        <div className="box box--warning">
          No price history is bundled. Run <code>node scripts/build-mfc-history.mjs</code> and{' '}
          <code>node scripts/build-eth-history.mjs</code> to generate it.
        </div>
      </div>
    );
  }

  const cfg = VIEWS[view];
  const first = shown[0];
  const last = shown[shown.length - 1];
  const start = anchor ?? { ts: first.ts, price: first.price };
  const resolution = RANGES.find((r) => r.key === range.key)?.resolution ?? cfg.resolution;
  const prices = shown.map((t: Trade) => t.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const chartEndTs = charted[charted.length - 1]?.ts ?? last.ts;
  const oracleAtChartEnd = vyOraclePriceAt(oracleSamples, chartEndTs * 1000);
  const projectedAtChartEnd = vyProjectionPriceAt(projectionSamples, chartEndTs * 1000);
  const futureVyAtChartEnd = vyBuybackFutureVyAt(buybackSamples, chartEndTs * 1000);
  const futureUsdAtChartEnd = vyBuybackFutureUsdAt(buybackSamples, chartEndTs * 1000);

  return (
    <div className="vy-price">
      <div className="vy-price__head">
        <div>
          <div className="vy-price__title">VALINITY / USD</div>
          <div className="vy-price__sub">{cfg.sub}</div>
        </div>
        <div className="vy-price__controls">
          {<span className="vy-price__sub">{fmtDate(start.ts)} → {fmtDate(chartEndTs)}</span>}
          <div className="vy-price__ranges" role="group" aria-label={tr('Time range', 'Rango de tiempo')}>
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                className="vy-price__range"
                aria-pressed={range.key === r.key}
                onClick={() => setRange({ key: r.key, from: rangeStart(r.key, Date.now()) })}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="vy-price__toggle"
            onClick={() => {
              const next = view === 'live' ? 'genesis' : 'live';
              setView(next);
              setRange(openingRange(next));
            }}
            title={view === 'live'
              ? tr('Every Valinity contract since 2021', 'Todos los contratos de Valinity desde 2021')
              : tr('Back to the current VY/USDC pool', 'Volver al pool actual VY/USDC')}
          >
            {view === 'live' ? tr('Since Genesis', 'Desde el Génesis') : tr('← Live Pool', '← Pool en Vivo')}
          </button>
        </div>
      </div>

      <>
          <div className="vy-price__stats">
            <Stat label={tr('First price', 'Primer precio')} value={fmtPrice(first.price)} />
            <Stat label={tr('All-time low', 'Mínimo histórico')} value={fmtPrice(low)} />
            <Stat label={tr('All-time high', 'Máximo histórico')} value={fmtPrice(high)} />
            {/* Last and largest: the three around it are history, this is the price now. */}
            <Stat label={tr('Price', 'Precio')} value={fmtPrice(last.price)} lead />
          </div>

          {overlays.length > 0 && (
            <div className="vy-price__bench">
              <button
                type="button"
                className="vy-price__bench-item vy-price__bench-toggle vy-price__bench-oracle"
                aria-pressed={!!linesOn[FAIR_VALUE_ID]}
                onClick={() => setLinesOn((prev) => ({ ...prev, [FAIR_VALUE_ID]: !prev[FAIR_VALUE_ID] }))}
                title={tr(
                  'Time-weighted median VY/USD price from the Valinity DEX VY/ETH, VY/BTC and VY/Gold pools',
                  'Precio medio ponderado por tiempo de VY/USD en los pools VY/ETH, VY/BTC y VY/Oro del DEX de Valinity'
                )}
              >
                <span className="vy-price__bench-swatch vy-price__bench-swatch--oracle" />
                <strong>{FAIR_VALUE_LABEL}</strong>{' '}
                {Number.isFinite(oracleAtChartEnd) ? fmtPrice(oracleAtChartEnd) : '—'}
              </button>
              <button
                type="button"
                className="vy-price__bench-item vy-price__bench-toggle vy-price__bench-projected"
                aria-pressed={!!linesOn[PROJECTED_ID]}
                onClick={() => setLinesOn((prev) => ({ ...prev, [PROJECTED_ID]: !prev[PROJECTED_ID] }))}
                title={tr(
                  "Where VMMO's whole market-making book would take VY in its best venue — a simulation, not a market price",
                  'Donde el libro completo de VMMO llevaría a VY en su mejor venue — una simulación, no un precio de mercado'
                )}
              >
                <span className="vy-price__bench-swatch vy-price__bench-swatch--projected" />
                <strong>{PROJECTED_LABEL}</strong>{' '}
                {Number.isFinite(projectedAtChartEnd) ? fmtPrice(projectedAtChartEnd) : '—'}
              </button>
              <button
                type="button"
                className="vy-price__bench-item vy-price__bench-toggle vy-price__bench-future"
                aria-pressed={!!linesOn[FUTURE_ID]}
                onClick={() => setLinesOn((prev) => ({ ...prev, [FUTURE_ID]: !prev[FUTURE_ID] }))}
                title={tr(
                  'What the VMMO book and the arbitrage would spend, and the VY that buys — the part that moves when VY falls',
                  'Lo que gastarían el libro de VMMO y el arbitraje, y el VY que compra — la parte que se mueve cuando VY cae'
                )}
              >
                <span className="vy-price__bench-swatch vy-price__bench-swatch--future" />
                <strong>{FUTURE_LABEL}</strong>{' '}
                {Number.isFinite(futureUsdAtChartEnd) ? fmtUsdShort(futureUsdAtChartEnd) : '—'}
                {Number.isFinite(futureVyAtChartEnd) ? ` · ${fmtVy(futureVyAtChartEnd)}` : ''}
              </button>
              <span className="vy-price__bench-item">
                <strong>VY</strong> {fmtPct(last.price / start.price - 1)}
              </span>
            </div>
          )}

          <PriceChart
            trades={charted} seriesKey={view} symbol={cfg.symbol} exchange={cfg.exchange}
            resolution={resolution} overlays={overlays} visibleFrom={range.from ?? undefined}
            height={CHART_HEIGHT}
            overlayVisible={linesOn} onReady={onReady}
            onOverlayToggle={(id, on) =>
              setLinesOn((prev) => (!!prev[id] === on ? prev : { ...prev, [id]: on }))}
          />

          <TradeTape
            trades={shown}
            symbol="VY"
            limit={TAPE_ROWS}
            note={view === 'genesis'
              ? tr("Amounts are in each era's own token — MFC on BNB Chain, VY on Ethereum — and link to that chain's explorer.",
                'Los montos están en el token de cada era — MFC en BNB Chain, VY en Ethereum — y enlazan al explorador de esa red.')
              : undefined}
          />
      </>
    </div>
  );
}
