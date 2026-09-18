import { useEffect, useMemo, useState } from 'react';
import { useLiveTail } from '../utils/liveTail';
import { LOAD_LIMIT_MS } from '../utils/loadLimit';
import { PriceChart, type ChartOverlay } from './PriceChart';
import { TradeTape } from './TradeTape';
import {
  compareTrades, dropManipulatedTransactions, loadAllTrades, withEthGapBridge, type EraId, type Trade,
} from '../utils/priceHistory';
import { BENCHMARKS, BENCHMARK_SNAPSHOT, mergeSamples, rebased } from '../utils/benchmarks';

/**
 * VALINITY PRICE — the page's lead section: candles above, the tape below.
 *
 * It opens on the CURRENT pool only — the market a visitor can actually trade today. "Since
 * Genesis" widens the chart, the stats and the tape together to every contract since 2021 (MFC
 * on BNB Chain, then VY on Ethereum), so all three always describe the same set of trades.
 *
 * The current-pool view also draws BTC, ETH and gold — the reserve's three assets — each started
 * at VY's price at the start of the chosen range, so the chart shows VY against simply holding
 * what backs it.
 *
 * THE FIRST FRAME IS THE PRESENT. History ships in the bundle, but the bundle is only as current
 * as its last build, so the section waits for the live catch-up (useLiveTail) before drawing.
 * The page's loading screen covers that wait and lifts once `onReady` reports the chart drawn.
 */

const LIVE_ERA: EraId = 'vy-current';

type View = 'live' | 'genesis';

// A view's own resolution applies on "All": WEEKLY for both — ~23 candles for the current pool,
// ~230 for the lineage (at daily the lineage would be 1,600 sub-pixel candles that read as a line).
// The current pool actually opens on 3M, whose daily candles come from RANGES.
const VIEWS: Record<View, { symbol: string; exchange: string; resolution: string; sub: string }> = {
  live: {
    symbol: 'VY', exchange: 'Uniswap V2', resolution: '1W',
    sub: 'Current pool · VY/USDC on Uniswap V2 · Ethereum',
  },
  genesis: {
    symbol: 'VALINITY', exchange: 'Valinity', resolution: '1W',
    sub: 'Every Valinity contract since genesis · MFC on BNB Chain, then VY on Ethereum',
  },
};

type RangeKey = '30d' | '3m' | '6m' | '12m' | 'all';

// Each range opens at a resolution that gives its candles real width; "All" keeps the view's own.
const RANGES: { key: RangeKey; label: string; resolution?: string }[] = [
  { key: '30d', label: '30D', resolution: '240' },
  { key: '3m', label: '3M', resolution: '1D' },
  { key: '6m', label: '6M', resolution: '1D' },
  { key: '12m', label: '12M', resolution: '1D' },
  { key: 'all', label: 'All' },
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
  new Date(ts * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

const fmtPrice = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 4 : 2 });

const fmtPct = (ratio: number) => {
  if (!Number.isFinite(ratio)) return '—';
  const p = Math.abs(ratio * 100);
  return (ratio >= 0 ? '+' : '−') + p.toLocaleString('en-US', { maximumFractionDigits: p >= 100 ? 0 : 1 }) + '%';
};

// One shared empty list, so the Since Genesis view does not rebuild the chart when the
// benchmark tail arrives.
const NO_OVERLAYS: ChartOverlay[] = [];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="vy-price__stat-label">{label}</div>
      <div className="vy-price__stat-value">{value}</div>
    </div>
  );
}

// Each view's opening range: the current pool opens on its last three months (daily candles);
// Since Genesis opens on the whole history, which is the point of that view.
const DEFAULT_RANGE: Record<View, RangeKey> = { live: '3m', genesis: 'all' };
const openingRange = (v: View) => ({ key: DEFAULT_RANGE[v], from: rangeStart(DEFAULT_RANGE[v], Date.now()) });

export function LifetimePrice({ onReady }: { onReady?: () => void }) {
  const [view, setView] = useState<View>('live');
  // The start is fixed when the range is chosen, so "last 3 months" does not creep forward (and
  // rebuild the chart) on every re-render.
  const [range, setRange] = useState<{ key: RangeKey; from: number | null }>(() => openingRange('live'));
  // The reserve-asset lines start ON; the viewer can hide any of them here or with the chart
  // legend's eye, and the two stay in step.
  const [linesOn, setLinesOn] = useState<Record<string, boolean>>(
    () => Object.fromEntries(BENCHMARKS.map((b) => [b.key, true]))
  );
  const snapshot = useMemo(() => loadAllTrades(), []);
  const tail = useLiveTail();

  // Past the load limit, draw from the snapshot; the live catch-up streams into that same chart.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), LOAD_LIMIT_MS);
    return () => clearTimeout(timer);
  }, []);
  const ready = tail.settled || waited;

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

  const samples = useMemo(() => mergeSamples(BENCHMARK_SNAPSHOT, tail.benchmarks), [tail.benchmarks]);

  const shown = useMemo(
    () => (view === 'live' ? trades.filter((t) => t.era === LIVE_ERA) : trades),
    [trades, view]
  );
  // The chart alone also draws the bridge across the Ethereum gap; stats and tape stay real trades.
  const charted = useMemo(() => (view === 'live' ? shown : withEthGapBridge(shown)), [shown, view]);

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

  // Each reserve asset as if VY's price at the anchor had bought it instead. Nothing is drawn
  // before the anchor, so every line visibly starts at the same point as the candles.
  const overlays = useMemo<ChartOverlay[]>(() => {
    if (view !== 'live' || !anchor || !samples.length) return NO_OVERLAYS;
    const startMs = anchor.ts * 1000;
    return BENCHMARKS.map((b) => {
      const value = rebased(samples, b.key, anchor);
      return {
        id: b.key, label: b.label, color: b.color, colorLight: b.colorLight,
        valueAt: (ms: number) => (ms < startMs ? NaN : value(ms)),
      };
    });
  }, [view, anchor, samples]);

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

  return (
    <div className="vy-price">
      <div className="vy-price__head">
        <div>
          <div className="vy-price__title">VALINITY / USD</div>
          <div className="vy-price__sub">{cfg.sub}</div>
        </div>
        <div className="vy-price__controls">
          {ready && <span className="vy-price__sub">{fmtDate(start.ts)} → {fmtDate(last.ts)}</span>}
          <div className="vy-price__ranges" role="group" aria-label="Time range">
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
            title={view === 'live' ? 'Every Valinity contract since 2021' : 'Back to the current VY/USDC pool'}
          >
            {view === 'live' ? 'Since Genesis' : '← Live Pool'}
          </button>
        </div>
      </div>

      {!ready ? (
        <div className="vy-price__loading" aria-busy="true">Loading the live pool from Ethereum…</div>
      ) : (
        <>
          <div className="vy-price__stats">
            <Stat label="First price" value={fmtPrice(first.price)} />
            <Stat label="Price" value={fmtPrice(last.price)} />
            <Stat label="All-time low" value={fmtPrice(low)} />
            <Stat label="All-time high" value={fmtPrice(high)} />
          </div>

          {overlays.length > 0 && (
            <div className="vy-price__bench">
              <span className="vy-price__bench-lead">All started at {fmtPrice(start.price)} on {fmtDate(start.ts)}</span>
              <span className="vy-price__bench-item">
                <strong>VY</strong> {fmtPct(last.price / start.price - 1)}
              </span>
              {overlays.map((o) => {
                const on = !!linesOn[o.id];
                return (
                  <button
                    key={o.id}
                    type="button"
                    className={`vy-price__bench-item vy-price__bench-toggle vy-price__bench-toggle--${o.id}`}
                    aria-pressed={on}
                    title={`${on ? 'Hide' : 'Show'} ${o.label} on the chart`}
                    onClick={() => setLinesOn((prev) => ({ ...prev, [o.id]: !on }))}
                  >
                    <span className={`vy-price__bench-swatch vy-price__bench-swatch--${o.id}`} />
                    <strong>{o.label}</strong> {fmtPct(o.valueAt(last.ts * 1000) / start.price - 1)}
                  </button>
                );
              })}
            </div>
          )}

          <PriceChart
            trades={charted} seriesKey={view} symbol={cfg.symbol} exchange={cfg.exchange}
            resolution={resolution} overlays={overlays} visibleFrom={range.from ?? undefined}
            overlayVisible={linesOn} onReady={onReady}
            onOverlayToggle={(id, on) => setLinesOn((prev) => (!!prev[id] === on ? prev : { ...prev, [id]: on }))}
          />

          <TradeTape
            trades={shown}
            symbol="VY"
            limit={100}
            note={view === 'genesis'
              ? "Amounts are in each era's own token — MFC on BNB Chain, VY on Ethereum — and link to that chain's explorer."
              : undefined}
          />
        </>
      )}
    </div>
  );
}
