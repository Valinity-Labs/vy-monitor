import { useEffect, useRef, useState } from 'react';
import { barCloseTime, openingPriceBand, type Trade } from '../utils/priceHistory';
import { createStaticDatafeed } from '../utils/staticDatafeed';

/**
 * VALINITY LIFETIME PRICE — TradingView Advanced Charts.
 *
 * The same licensed widget the web app uses for Hyperliquid markets, so this chart keeps the
 * full toolbar, drawing tools and indicators rather than being a second, lesser chart.
 *
 * ⚠️ LICENSING. Advanced Charts is license-gated and NOT redistributable, and this repository is
 * PUBLIC — so the library is never committed here (`public/charting_library/` is git-ignored).
 * The build downloads it from app.valinity.io and verifies every file against
 * scripts/charting_library.sha256, so it only ever reaches the published site (see README).
 *
 * Optional OVERLAYS draw extra lines on the candles' own price scale (the current-pool view uses
 * them for BTC, ETH and gold). Each is a TradingView custom indicator, so it gets a legend row
 * and an eye toggle like any built-in study.
 *
 * The chart is driven by a static datafeed over the trades it is handed, so `subscribeBars` is
 * a genuine no-op. Fresh swaps arrive through `useLiveTail`, which hands this component a new
 * trade list; the widget is rebuilt on that rather than streamed into.
 */

const LIB_SRC = `${import.meta.env.BASE_URL}charting_library/charting_library.standalone.js`;
const LIBRARY_PATH = `${import.meta.env.BASE_URL}charting_library/`;
// Weekly unless the caller asks otherwise. Four and a half years of trades is ~1,600 daily
// candles — under 1px each in a normal pane, which reads as a line rather than candles. Weekly
// gives ~230 bars with real width, and halves the share of zero-height bars in the MFC years.
const DEFAULT_RES = '1W';

// ── Minimal shape of the bits of the widget API this component drives ───────
interface TVSubscription { subscribe: (owner: unknown, cb: () => void, once?: boolean) => void }
interface TVPriceScale {
  setAutoScale?: (on: boolean) => void;
  setVisiblePriceRange?: (r: { from: number; to: number }) => void;
}
interface TVPane { getMainSourcePriceScale: () => TVPriceScale | null }
interface TVStudyApi { isVisible: () => boolean; setVisible: (visible: boolean) => void }
interface TVChartApi {
  setVisibleRange: (r: { from: number; to: number }) => Promise<void> | void;
  onDataLoaded?: () => TVSubscription;
  getPanes?: () => TVPane[];
  createStudy?: (name: string, forceOverlay?: boolean, lock?: boolean) => Promise<unknown>;
  getStudyById?: (id: unknown) => TVStudyApi;
}
interface TVWidget {
  onChartReady: (cb: () => void) => void;
  activeChart: () => TVChartApi;
  remove: () => void;
  subscribe?: (event: string, cb: (...args: unknown[]) => void) => void;
}
type TVWidgetCtor = new (opts: Record<string, unknown>) => TVWidget;
declare global {
  interface Window { TradingView?: { widget: TVWidgetCtor } }
}

/** Load the standalone bundle once per page, no matter how many charts mount. */
let libPromise: Promise<void> | undefined;
function loadLibrary(): Promise<void> {
  if (window.TradingView?.widget) return Promise.resolve();
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = LIB_SRC;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        libPromise = undefined; // let a later mount retry
        reject(new Error(`could not load ${LIB_SRC}`));
      };
      document.head.appendChild(el);
    });
  }
  return libPromise;
}

/**
 * A line drawn over the candles on the same price scale. `valueAt` is read at each candle's
 * CLOSE instant (see `barCloseTime`), so a line and the candle beneath it describe the same
 * moment rather than the line lagging by up to a bar.
 */
export interface ChartOverlay {
  id: string;
  label: string;
  color: string;
  colorLight: string;
  valueAt: (ms: number) => number;
}

const NO_OVERLAYS: ChartOverlay[] = [];
const NO_VISIBLE: Record<string, boolean> = {};

// Only the parts of the library's PineJS helper the overlay indicators call.
interface TVPineJS {
  Std: { time: (ctx: unknown) => number; period: (ctx: unknown) => string };
}

/**
 * One overlay as a custom indicator: a single line plot that is a price study linked to the main
 * series, so it shares the candles' log scale and zoom instead of getting a scale of its own.
 */
function overlayIndicator(
  PineJS: TVPineJS, o: ChartOverlay, closeAt: (period: string, barMs: number) => number, light: boolean
) {
  return {
    name: o.label,
    metainfo: {
      _metainfoVersion: 53,
      id: `vy-overlay-${o.id}@tv-basicstudies-1`,
      description: o.label,
      shortDescription: o.label,
      is_price_study: true,
      isCustomIndicator: true,
      linkedToSeries: true,
      format: { type: 'inherit' },
      plots: [{ id: 'plot_0', type: 'line' }],
      defaults: {
        styles: {
          plot_0: {
            linestyle: 0, linewidth: 2, plottype: 0, trackPrice: false, transparency: 0, visible: true,
            color: light ? o.colorLight : o.color,
          },
        },
        inputs: {},
      },
      styles: { plot_0: { title: o.label, histogramBase: 0 } },
      inputs: [],
    },
    constructor: function (this: { main: (ctx: unknown) => number[] }) {
      this.main = (ctx) => {
        const t = PineJS.Std.time(ctx);
        // The library first calls `main` with an empty context to discover the plot.
        if (!Number.isFinite(t)) return [NaN];
        const ms = t < 1e11 ? t * 1000 : t;
        return [o.valueAt(closeAt(PineJS.Std.period(ctx), ms))];
      };
    },
  };
}

const prefersLight = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches;

export function PriceChart({
  trades, symbol, exchange, resolution = DEFAULT_RES, overlays = NO_OVERLAYS, visibleFrom,
  overlayVisible = NO_VISIBLE, onOverlayToggle, height = 460,
}: {
  trades: Trade[]; symbol: string; exchange: string; resolution?: string;
  overlays?: ChartOverlay[];
  /** Which overlays are switched on, by id. Anything missing is off. */
  overlayVisible?: Record<string, boolean>;
  /** Called when the viewer switches an overlay with the chart legend's own eye. */
  onOverlayToggle?: (id: string, visible: boolean) => void;
  /** Open on the window from this unix-seconds instant to the last trade; omit for all history. */
  visibleFrom?: number;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [light, setLight] = useState(prefersLight);

  // Overlay on/off is applied to the LIVE widget rather than rebuilding it, so switching a line
  // keeps the viewer's zoom. The widget effect reads these refs when it creates the studies.
  const studiesRef = useRef(new Map<string, TVStudyApi>());
  const visibleRef = useRef(overlayVisible);
  const toggleRef = useRef(onOverlayToggle);
  useEffect(() => {
    visibleRef.current = overlayVisible;
    toggleRef.current = onOverlayToggle;
    for (const [id, study] of studiesRef.current) {
      try {
        const want = !!overlayVisible[id];
        if (study.isVisible() !== want) study.setVisible(want);
      } catch {
        studiesRef.current.delete(id); // removed from the legend by the viewer
      }
    }
  }, [overlayVisible, onOverlayToggle]);

  // Rebuild on theme flip — the widget takes its theme at construction time.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!mq) return;
    const onChange = () => setLight(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!containerRef.current || !trades.length) return;
    let widget: TVWidget | undefined;
    let cancelled = false;
    const studies = studiesRef.current;

    // Candle close instants per resolution, built on first use: the overlays ask for whichever
    // resolution the viewer has picked.
    const closeFns = new Map<string, (barMs: number) => number>();
    const closeAt = (period: string, barMs: number) => {
      let f = closeFns.get(period);
      if (!f) { f = barCloseTime(trades, period); closeFns.set(period, f); }
      return f(barMs);
    };

    loadLibrary()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        const Widget = window.TradingView?.widget;
        if (!Widget) throw new Error('charting library loaded but window.TradingView.widget is missing');

        widget = new Widget({
          container: containerRef.current,
          library_path: LIBRARY_PATH,
          datafeed: createStaticDatafeed(trades, symbol, exchange),
          symbol,
          interval: resolution,
          locale: 'en',
          autosize: true,
          timezone: 'Etc/UTC',
          theme: light ? 'Light' : 'Dark',
          disabled_features: [
            'header_symbol_search',
            'symbol_search_hot_key',
            'header_compare',
            'go_to_date',
            // The library otherwise saves chart settings in localStorage and lets them override
            // `overrides` on the next visit — so a viewer who once saw the dark theme keeps a dark
            // pane under a light page after switching their system theme. Always start clean.
            'use_localstorage_for_settings',
          ],
          enabled_features: ['hide_left_toolbar_by_default'],
          custom_indicators_getter: (PineJS: TVPineJS) =>
            Promise.resolve(overlays.map((o) => overlayIndicator(PineJS, o, closeAt, light))),
          // The overlay indicators read this component's data through their closures, which a
          // worker thread cannot see — keep indicator maths on the main thread.
          workers: { enabled: false },
          overrides: {
            'paneProperties.background': light ? '#ffffff' : '#181818',
            'paneProperties.backgroundType': 'solid',
            // The lifetime spans $0.0179 to $7.94 — three orders of magnitude. On a linear
            // scale the entire four-year MFC period collapses into a flat line at the bottom.
            'scalesProperties.logScale': true,
          },
        });

        widget.onChartReady(() => {
          if (cancelled) return;
          // Every era here ended in the past, but the widget opens anchored at "now" — so the
          // bars can load correctly and STILL sit far off-screen to the left. Snap the viewport
          // onto the data itself. This runs once when the chart is ready and again the first
          // time data actually lands, because on a cold load the ready callback can fire before
          // any bar has arrived and a range set against an empty series does not stick.
          // A chosen window opens on itself and lets the price scale fit it; all history opens on
          // the band the asset actually lived in.
          const last = trades[trades.length - 1].ts;
          const first = visibleFrom !== undefined ? Math.max(visibleFrom, trades[0].ts) : trades[0].ts;
          const pad = Math.max((last - first) * 0.03, 86_400);
          const band = visibleFrom === undefined ? openingPriceBand(trades) : null;
          const snap = () => {
            const chart = widget?.activeChart();
            if (!chart) return;
            try {
              // The library rejects this after 10s if the range cannot be reached — e.g. when the
              // widget was replaced by a newer one mid-load. Nothing to recover; just don't let it
              // surface as an unhandled rejection.
              void Promise.resolve(chart.setVisibleRange({ from: first - pad, to: last + pad })).catch(() => { });
            } catch {
              /* range snapping is a nicety; a failure must not blank the chart */
            }
            // Open on the band the asset actually lived in. Every trade is still loaded and
            // still in the tape — the Ethereum launch spike is simply above the initial
            // viewport, and zooming out reaches it.
            if (band) {
              try {
                const scale = chart.getPanes?.()[0]?.getMainSourcePriceScale();
                // Autoscale would immediately refit to the full extent, spike included.
                scale?.setAutoScale?.(false);
                scale?.setVisiblePriceRange?.(band);
              } catch {
                /* the log scale below already keeps the full range legible */
              }
            }
          };
          try {
            widget?.activeChart().onDataLoaded?.().subscribe(null, snap, true);
          } catch {
            /* older library builds may not expose it — the direct call below still runs */
          }
          snap();

          for (const o of overlays) {
            try {
              const chart = widget?.activeChart();
              void chart?.createStudy?.(o.label, false, false)?.then((id) => {
                const study = id == null || cancelled ? undefined : chart.getStudyById?.(id);
                if (!study) return;
                study.setVisible(!!visibleRef.current[o.id]);
                studies.set(o.id, study);
              }).catch(() => { });
            } catch {
              /* an overlay that fails to draw must not take the candles down with it */
            }
          }
          // The legend's eye switches a line too — report it so the buttons above the chart follow.
          widget?.subscribe?.('study_properties_changed', () => {
            for (const [id, study] of studies) {
              try {
                const on = study.isVisible();
                if (on !== !!visibleRef.current[id]) toggleRef.current?.(id, on);
              } catch {
                studies.delete(id);
              }
            }
          });
        });
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });

    return () => {
      cancelled = true;
      studies.clear();
      try { widget?.remove(); } catch { /* already torn down */ }
    };
  }, [trades, symbol, exchange, resolution, overlays, visibleFrom, light]);

  if (error) {
    return (
      <div className="box box--warning">
        <strong>Chart unavailable.</strong> {error}
        <div style={{ marginTop: '0.4rem', fontSize: '0.72rem' }}>
          The TradingView Advanced Charts bundle must be present at <code>public/charting_library/</code>.
        </div>
      </div>
    );
  }

  return <div ref={containerRef} className="vy-chart" style={{ height }} />;
}
