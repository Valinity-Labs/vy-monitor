import { useMemo, useState } from 'react';
import { useLiveTail } from '../utils/liveTail';
import { PriceChart, type ChartOverlay } from './PriceChart';
import { TradeTape } from './TradeTape';
import { loadAllTrades, type EraId, type Trade } from '../utils/priceHistory';
import { BENCHMARKS, BENCHMARK_SNAPSHOT, mergeSamples, rebased } from '../utils/benchmarks';

/**
 * VALINITY PRICE — the page's lead section: candles above, the tape below.
 *
 * It opens on the CURRENT pool only — the market a visitor can actually trade today. "Since
 * Genesis" widens the chart, the stats and the tape together to every contract since 2021 (MFC
 * on BNB Chain, then VY on Ethereum), so all three always describe the same set of trades.
 *
 * The current-pool view also draws BTC, ETH and gold — the reserve's three assets — each started
 * at the pool's first price, so the chart shows VY against simply holding what backs it.
 *
 * Everything here comes from committed JSON, so it paints on the first frame. That is why it
 * sits ABOVE the RPC gate in Mainnet: the balance sheet needs a few hundred round trips and
 * roughly fifteen seconds, and a chart of closed history has no reason to wait on it.
 */

const LIVE_ERA: EraId = 'vy-current';

type View = 'live' | 'genesis';

// Both views open on WEEKLY candles: ~23 for the current pool, ~230 for the lineage (at daily the
// lineage would be 1,600 sub-pixel candles that read as a line). The range buttons switch to finer
// candles for shorter windows.
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

const fmtUsd = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });

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

export function LifetimePrice() {
  const [view, setView] = useState<View>('live');
  // The start is fixed when the button is pressed, so "last 30 days" does not creep forward (and
  // rebuild the chart) on every re-render.
  const [range, setRange] = useState<{ key: RangeKey; from: number | null }>({ key: 'all', from: null });
  // The reserve-asset lines start OFF — the viewer asks for them, here or with the chart legend's
  // eye, and the two stay in step.
  const [linesOn, setLinesOn] = useState<Record<string, boolean>>({});
  const snapshot = useMemo(() => loadAllTrades(), []);
  const tail = useLiveTail();

  // Keep the SAME array reference when there is no tail, so the chart does not tear down and
  // rebuild the TradingView widget (and lose the viewer's zoom) on every poll that finds
  // nothing new — which is most of them.
  const trades = useMemo(() => {
    if (!tail.trades.length) return snapshot;
    const seen = new Set(snapshot.map((t) => t.key));
    const fresh = tail.trades.filter((t) => !seen.has(t.key));
    if (!fresh.length) return snapshot;
    return [...snapshot, ...fresh].sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
  }, [snapshot, tail.trades]);

  const samples = useMemo(() => mergeSamples(BENCHMARK_SNAPSHOT, tail.benchmarks), [tail.benchmarks]);

  // Memoised for the same reason: the widget is rebuilt only when the view or the data changes.
  const shown = useMemo(
    () => (view === 'live' ? trades.filter((t) => t.era === LIVE_ERA) : trades),
    [trades, view]
  );

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

  if (!shown.length) {
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
  const volume = shown.reduce((n: number, t: Trade) => n + t.usd, 0);
  const makers = new Set(shown.map((t: Trade) => t.address)).size;

  return (
    <div className="vy-price">
      <div className="vy-price__head">
        <div>
          <div className="vy-price__title">VALINITY / USD</div>
          <div className="vy-price__sub">{cfg.sub}</div>
        </div>
        <div className="vy-price__controls">
          <span className="vy-price__sub">{fmtDate(start.ts)} → {fmtDate(last.ts)}</span>
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
            onClick={() => setView(view === 'live' ? 'genesis' : 'live')}
            title={view === 'live' ? 'Every Valinity contract since 2021' : 'Back to the current VY/USDC pool'}
          >
            {view === 'live' ? 'Since Genesis' : '← Live Pool'}
          </button>
        </div>
      </div>

      <div className="vy-price__stats">
        <Stat label="First trade" value={fmtPrice(first.price)} />
        <Stat label="Last trade" value={fmtPrice(last.price)} />
        <Stat label="All-time low" value={fmtPrice(low)} />
        <Stat label="All-time high" value={fmtPrice(high)} />
        <Stat label="Volume" value={fmtUsd(volume)} />
        <Stat label="Trades" value={shown.length.toLocaleString('en-US')} />
        <Stat label="Wallets" value={makers.toLocaleString('en-US')} />
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
          <span className="vy-price__bench-hint">
            Click BTC, ETH or Gold to draw it on the chart — or use the 👁 next to its name in the chart legend
          </span>
        </div>
      )}

      <PriceChart
        trades={shown} symbol={cfg.symbol} exchange={cfg.exchange}
        resolution={resolution} overlays={overlays} visibleFrom={range.from ?? undefined}
        overlayVisible={linesOn}
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
    </div>
  );
}
