import { useEffect, useRef, useState } from 'react';
import { barCloseTime, openingPriceBand, type Trade } from '../utils/priceHistory';
import { createStaticDatafeed } from '../utils/staticDatafeed';
import { useTheme } from '../utils/theme';
import { LANG, tr } from '../utils/i18n';

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
 * LIVE DATA IS STREAMED, NOT REBUILT. The widget is created once per series (view, symbol,
 * resolution, window, theme). When the trade list grows — the page catching up from the committed
 * snapshot, or a new swap while the page is open — the new candles are pushed into the chart
 * already on screen. Rebuilding instead repainted everything, which read as old data followed by
 * a reset.
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
  /** PriceScaleMode: 0 = normal (linear), 1 = logarithmic. */
  setMode?: (mode: number) => void;
}
interface TVPane {
  getMainSourcePriceScale: () => TVPriceScale | null;
  setHeight?: (height: number) => void;
}
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
  /** TradingView line width. The default comparison lines use 2; the DEX median uses 3. */
  lineWidth?: number;
  /**
   * 'area' draws the line with the shaded fill beneath it (the library's Area plot), which is how
   * the projection is shown; anything else is a plain line.
   */
  plotType?: 'line' | 'area';
  /**
   * 'area' only: the stroke on top of the shading. The fill keeps `color` so it stays a quiet
   * wash, while the line itself can be brighter than anything it is drawn over.
   */
  lineColor?: string;
  lineColorLight?: string;
  /** Keep a reference line visible and prevent the study from being edited or removed. */
  alwaysVisible?: boolean;
  locked?: boolean;
  valueAt: (ms: number) => number;
  /**
   * 'own' puts the study in its OWN PANEL under the candles, with its own scale — for a series
   * that is not a price at all (the buyback panel counts VY, in the millions).
   */
  pane?: 'price' | 'own';
  /**
   * Own-pane only: a second, lower series drawn as a solid band beneath `valueAt`, so the two
   * read as one stacked shape — a settled base with the moving part shaded on top of it.
   */
  baseValueAt?: (ms: number) => number;
  /** Own-pane only: what the chart legend calls `baseValueAt`'s line. */
  baseLabel?: string;
  /** Own-pane only: how the panel's numbers are written. 'volume' abbreviates 1,073,554 to 1.073M. */
  format?: 'price' | 'volume';
}

/** Price scale the chart opens on: true = logarithmic, false = linear. */
const LOG_SCALE = true;

// How much of the chart a study's own panel takes when it opens: about two grid squares, which
// leaves the candles the height they had before the panel existed. The viewer can still drag the
// divider — this is only where it starts.
const OWN_PANE_SHARE = 0.17;

/**
 * The price range a chosen window should open on: every trade inside it, plus each overlay read
 * across it, with a little air either side. Overlays are sampled rather than integrated — they are
 * smooth curves, so 64 reads find their extremes.
 */
function windowPriceBand(
  trades: Trade[], from: number, to: number, overlays: ChartOverlay[]
): { from: number; to: number } | null {
  let lo = Infinity;
  let hi = 0;
  for (const t of trades) {
    if (t.ts < from || t.ts > to || !(t.price > 0)) continue;
    if (t.price < lo) lo = t.price;
    if (t.price > hi) hi = t.price;
  }
  const step = (to - from) / 64;
  for (const o of overlays) {
    if (o.pane === 'own') continue; // counts, not prices — they have their own scale
    for (let ts = from; ts <= to; ts += step) {
      const v = o.valueAt(ts * 1000);
      if (!Number.isFinite(v) || v <= 0) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!(hi > lo) || !Number.isFinite(lo)) return null;
  return { from: lo * 0.9, to: hi * 1.15 };
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
 * Values come through `valueAt`, which reads the overlay's LATEST data rather than the data it
 * was created with, so candles streamed in later get correct line values too.
 */
function overlayIndicator(
  PineJS: TVPineJS, o: ChartOverlay, valueAt: (ms: number) => number,
  closeAt: (period: string, barMs: number) => number, light: boolean,
  baseAt: (ms: number) => number = () => NaN
) {
  const area = o.plotType === 'area';
  const ownPane = o.pane === 'own';
  const stacked = ownPane && !!o.baseValueAt;
  return {
    name: o.label,
    metainfo: {
      _metainfoVersion: 53,
      id: `vy-overlay-${o.id}@tv-basicstudies-1`,
      description: o.label,
      shortDescription: o.label,
      // A price study shares the candles' scale; an own-pane study gets a panel and a scale of
      // its own, which is the only honest way to draw a VY COUNT beside a USD price.
      is_price_study: !ownPane,
      isCustomIndicator: true,
      linkedToSeries: !ownPane,
      format: o.format === 'volume' ? { type: 'volume' } : { type: 'inherit' },
      // An area overlay is TWO plots over the same values: the wash (an Area plot, whose line
      // can only be the fill's own colour) and a brighter stroke on top of it. The wash is drawn
      // with display = Pane only, so the legend and the price scale report the stroke alone and
      // the value never appears twice.
      plots: area || stacked
        ? [{ id: 'plot_0', type: 'line' }, { id: 'plot_1', type: 'line' }]
        : [{ id: 'plot_0', type: 'line' }],
      defaults: {
        styles: {
          plot_0: stacked
            ? {
              // The TOTAL: a solid stroke, the brighter of the two.
              linestyle: 0, linewidth: o.lineWidth ?? 2, plottype: 0, trackPrice: false,
              transparency: 0, visible: true,
              color: light ? (o.lineColorLight ?? o.colorLight) : (o.lineColor ?? o.color),
            }
            : area
            ? {
              // The wash: 4 = the library's Area plot. Pane only (StudyPlotDisplayTarget.Pane),
              // so it never reaches the legend, the data window or the price scale.
              linestyle: 0, linewidth: 1, plottype: 4, trackPrice: false,
              transparency: 82, visible: true, display: 1,
              color: light ? o.colorLight : o.color,
            }
            : {
              linestyle: 0, linewidth: o.lineWidth ?? 2, plottype: 0, trackPrice: false,
              transparency: 0, visible: true,
              color: light ? o.colorLight : o.color,
            },
          ...(stacked ? {
            plot_1: {
              // The settled base: the same hue, a step deeper, so the gap between the two IS the
              // projection.
              linestyle: 0, linewidth: o.lineWidth ?? 2, plottype: 0, trackPrice: false,
              transparency: 0, visible: true,
              color: light ? o.colorLight : o.color,
            },
          } : area ? {
            plot_1: {
              linestyle: 0, linewidth: o.lineWidth ?? 2, plottype: 0, trackPrice: false,
              transparency: 0, visible: true,
              color: light ? (o.lineColorLight ?? o.colorLight) : (o.lineColor ?? o.color),
            },
          } : {}),
        },
        inputs: {},
      },
      styles: {
        plot_0: { title: area ? `${o.label} shade` : o.label, histogramBase: 0 },
        ...(stacked ? { plot_1: { title: o.baseLabel ?? `${o.label} base`, histogramBase: 0 } }
          : area ? { plot_1: { title: o.label, histogramBase: 0 } } : {}),
      },
      inputs: [],
    },
    constructor: function (this: { main: (ctx: unknown) => number[] }) {
      this.main = (ctx) => {
        const t = PineJS.Std.time(ctx);
        // The library first calls `main` with an empty context to discover the plot.
        if (!Number.isFinite(t)) return area || stacked ? [NaN, NaN] : [NaN];
        const ms = t < 1e11 ? t * 1000 : t;
        const bar = closeAt(PineJS.Std.period(ctx), ms);
        const v = valueAt(bar);
        if (stacked) return [v, baseAt(bar)];
        return area ? [v, v] : [v];
      };
    },
  };
}

export function PriceChart({
  trades, seriesKey, symbol, exchange, resolution = DEFAULT_RES, overlays = NO_OVERLAYS, visibleFrom,
  overlayVisible = NO_VISIBLE, onOverlayToggle, onReady, height = 460,
}: {
  /** Called once the widget has drawn (or failed to), so the page can lift its loading screen. */
  onReady?: () => void;
  trades: Trade[];
  /**
   * Identity of the series on screen. The widget is rebuilt only when this — or the symbol,
   * resolution, window or theme — changes. A trade list that merely GROWS is streamed in.
   */
  seriesKey: string;
  symbol: string; exchange: string; resolution?: string;
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
  // The widget takes its theme at construction time, so a theme flip rebuilds it.
  const light = useTheme() === 'light';

  // The open widget reads the LATEST trades and overlays through these refs, so data that changes
  // while the chart is on screen reaches it without a rebuild.
  const tradesRef = useRef(trades);
  const overlaysRef = useRef(overlays);
  const feedRef = useRef<ReturnType<typeof createStaticDatafeed> | null>(null);
  const closeFnsRef = useRef(new Map<string, (barMs: number) => number>());

  // Declared BEFORE the widget effect: when a new series and new trades arrive together, the
  // rebuild must already see the new trades.
  useEffect(() => {
    if (tradesRef.current === trades) return;
    tradesRef.current = trades;
    closeFnsRef.current.clear();
    feedRef.current?.push();
  }, [trades]);

  useEffect(() => {
    overlaysRef.current = overlays;
    // Oracle-only updates can arrive while the VY/USDC pool is quiet. Re-emit the
    // latest candle so TradingView recalculates its studies without rebuilding the
    // widget (and therefore without resetting the viewer's zoom).
    feedRef.current?.push();
  }, [overlays]);

  // Overlay on/off is applied to the LIVE widget rather than rebuilding it, so switching a line
  // keeps the viewer's zoom. The widget effect reads these refs when it creates the studies.
  const studiesRef = useRef(new Map<string, TVStudyApi>());
  const visibleRef = useRef(overlayVisible);
  const toggleRef = useRef(onOverlayToggle);
  const readyRef = useRef(onReady);
  useEffect(() => {
    visibleRef.current = overlayVisible;
    toggleRef.current = onOverlayToggle;
    readyRef.current = onReady;
    for (const [id, study] of studiesRef.current) {
      try {
        const spec = overlaysRef.current.find((o) => o.id === id);
        const want = !!spec?.alwaysVisible || !!overlayVisible[id];
        if (study.isVisible() !== want) study.setVisible(want);
      } catch {
        studiesRef.current.delete(id); // removed from the legend by the viewer
      }
    }
  }, [overlayVisible, onOverlayToggle, onReady]);

  // Which overlays exist decides the studies to create; their data can change without a rebuild.
  const overlayKey = overlays.map((o) => o.id).join(',');

  useEffect(() => {
    if (!containerRef.current || !tradesRef.current.length) return;
    let widget: TVWidget | undefined;
    let cancelled = false;
    const studies = studiesRef.current;
    const specs = overlaysRef.current;

    // Candle close instants per resolution, built on first use and dropped whenever the trade
    // list changes: the overlays ask for whichever resolution the viewer has picked.
    const closeFns = closeFnsRef.current;
    closeFns.clear();
    const closeAt = (period: string, barMs: number) => {
      let f = closeFns.get(period);
      if (!f) { f = barCloseTime(tradesRef.current, period); closeFns.set(period, f); }
      return f(barMs);
    };

    const feed = createStaticDatafeed(() => tradesRef.current, symbol, exchange);
    feedRef.current = feed;

    loadLibrary()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        const Widget = window.TradingView?.widget;
        if (!Widget) throw new Error('charting library loaded but window.TradingView.widget is missing');

        widget = new Widget({
          container: containerRef.current,
          library_path: LIBRARY_PATH,
          datafeed: feed,
          symbol,
          interval: resolution,
          locale: LANG,
          // Spanish would switch the chart to decimal commas; the rest of the page keeps en-US numbers.
          numeric_formatting: { decimal_sign: '.', grouping_separator: ',' },
          autosize: true,
          timezone: 'Etc/UTC',
          theme: light ? 'Light' : 'Dark',
          // The library's own loading screen is a bright blue spinner by default; blend it into the
          // pane so a (re)build never flashes it.
          loading_screen: {
            backgroundColor: light ? '#ffffff' : '#181818',
            foregroundColor: light ? '#d0d0d0' : '#3a3a3a',
          },
          disabled_features: [
            'header_symbol_search',
            'symbol_search_hot_key',
            'header_compare',
            'go_to_date',
            // The library otherwise saves chart settings in localStorage and lets them override
            // `overrides` on the next visit — so a viewer who once saw the dark theme keeps a dark
            // pane under a light page after switching theme. Always start clean.
            'use_localstorage_for_settings',
            // The library's own coach marks — "Press and hold to see detailed chart values" and
            // friends — pop up over the chart and have to be dismissed. Nothing on this page needs
            // teaching; the chart is there to be read.
            'popup_hints',
          ],
          enabled_features: ['hide_left_toolbar_by_default'],
          custom_indicators_getter: (PineJS: TVPineJS) =>
            Promise.resolve(specs.map((o) => overlayIndicator(
              PineJS, o,
              (ms) => overlaysRef.current.find((x) => x.id === o.id)?.valueAt(ms) ?? NaN,
              closeAt, light,
              (ms) => overlaysRef.current.find((x) => x.id === o.id)?.baseValueAt?.(ms) ?? NaN,
            ))),
          // The overlay indicators read this component's data through their closures, which a
          // worker thread cannot see — keep indicator maths on the main thread.
          workers: { enabled: false },
          overrides: {
            'paneProperties.background': light ? '#ffffff' : '#181818',
            'paneProperties.backgroundType': 'solid',
          },
        });
        // A handle for local debugging and tests only; stripped from production builds.
        if (import.meta.env.DEV) (window as unknown as { __vyChart?: TVWidget }).__vyChart = widget;

        widget.onChartReady(() => {
          if (cancelled) return;
          // The widget opens anchored at "now", so bars can load correctly and still sit
          // off-screen. Snap the viewport onto the data — once when the chart is ready and again
          // the first time data lands, because on a cold load ready can fire before any bar has
          // arrived and a range set against an empty series does not stick. A chosen window opens
          // on itself and lets the price scale fit it; all history opens on the band the asset
          // actually lived in.
          const trades = tradesRef.current;
          const last = trades[trades.length - 1].ts;
          const first = visibleFrom !== undefined ? Math.max(visibleFrom, trades[0].ts) : trades[0].ts;
          const pad = Math.max((last - first) * 0.03, 86_400);
          // The band the scale opens on. All history opens on the band the asset actually lived
          // in; a chosen window opens on what is IN that window — candles AND the reference lines,
          // because an area plot's fill reaches toward zero and would otherwise drag a log scale
          // down to 0.00001 and flatten every candle against the top.
          const band = visibleFrom === undefined
            ? openingPriceBand(trades)
            : windowPriceBand(trades, first, last, overlaysRef.current);
          // The buyback panel counts VY in the millions and its area plots fill from zero, so
          // autoscale would open on 0…1.13M and squash the part that actually moves into a
          // sliver. Fit that panel to the band its series occupies, and open it two grid squares
          // tall — a footnote under the candles rather than a third of the chart. Runs after the
          // study exists — the panel is not there until then.
          const fitOwnPanes = () => {
            const chart = widget?.activeChart();
            if (!chart) return;
            // Pane 0 is the candles; each own-pane study lands in the next pane, in the order the
            // studies were created.
            let paneIndex = 0;
            for (const o of overlaysRef.current) {
              if (o.pane !== 'own') continue;
              paneIndex += 1;
              let lo = Infinity;
              let hi = 0;
              for (let ts = first; ts <= last; ts += Math.max((last - first) / 64, 1)) {
                for (const v of [o.valueAt(ts * 1000), o.baseValueAt?.(ts * 1000) ?? NaN]) {
                  if (!Number.isFinite(v) || v <= 0) continue;
                  if (v < lo) lo = v;
                  if (v > hi) hi = v;
                }
              }
              if (!(hi > 0) || !Number.isFinite(lo)) continue;
              try {
                const pane = chart.getPanes?.()[paneIndex];
                // Height from the container, not the `height` prop, so the effect keeps its
                // existing dependencies — and so a panel is sized against what is on screen.
                const box = containerRef.current?.clientHeight ?? 0;
                if (box > 0) pane?.setHeight?.(Math.round(box * OWN_PANE_SHARE));
                const scale = pane?.getMainSourcePriceScale();
                scale?.setAutoScale?.(false);
                scale?.setVisiblePriceRange?.({ from: lo * 0.97, to: hi * 1.03 });
              } catch {
                /* the panel still reads, just from zero */
              }
            }
          };

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
            // ONE SWITCH for the price scale: log spaces equal PERCENTAGE moves equally, so the
            // cent-era candles and a $5 projection are both readable; linear gives the top of the
            // range all the room. (`scalesProperties.logScale` does nothing in this library
            // version — the scale's own setMode is the supported way.) Flip LOG_SCALE to false to
            // go back; the viewer can also use the chart's own log/auto buttons at any time.
            try {
              chart.getPanes?.()[0]?.getMainSourcePriceScale()?.setMode?.(LOG_SCALE ? 1 : 0);
            } catch {
              /* the chart's own log button still works */
            }
            if (band) {
              try {
                const scale = chart.getPanes?.()[0]?.getMainSourcePriceScale();
                // Autoscale would immediately refit to the full extent, spike included.
                scale?.setAutoScale?.(false);
                scale?.setVisiblePriceRange?.(band);
              } catch {
                /* the full range stays reachable by zooming out */
              }
            }
          };
          // Ready means candles are on screen: the first data load, or a moment after the widget
          // is up if this library build has no data-loaded event.
          const ready = () => { if (!cancelled) readyRef.current?.(); };
          setTimeout(ready, 1500);
          try {
            widget?.activeChart().onDataLoaded?.().subscribe(null, () => { snap(); ready(); }, true);
          } catch {
            /* older library builds may not expose it — the direct call below still runs */
          }
          snap();

          for (const o of specs) {
            try {
              const chart = widget?.activeChart();
              void chart?.createStudy?.(o.label, false, !!o.locked)?.then((id) => {
                const study = id == null || cancelled ? undefined : chart.getStudyById?.(id);
                if (!study) return;
                study.setVisible(!!o.alwaysVisible || !!visibleRef.current[o.id]);
                studies.set(o.id, study);
                // The panel only exists once its study does, so this is where it gets fitted.
                if (o.pane === 'own') setTimeout(fitOwnPanes, 50);
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
                const spec = overlaysRef.current.find((o) => o.id === id);
                if (spec?.alwaysVisible) {
                  if (!on) study.setVisible(true);
                } else if (on !== !!visibleRef.current[id]) {
                  toggleRef.current?.(id, on);
                }
              } catch {
                studies.delete(id);
              }
            }
          });
        });
      })
      .catch((e: Error) => { if (!cancelled) { setError(e.message); readyRef.current?.(); } });

    return () => {
      cancelled = true;
      studies.clear();
      try { widget?.remove(); } catch { /* already torn down */ }
    };
  }, [seriesKey, symbol, exchange, resolution, visibleFrom, overlayKey, light]);

  if (error) {
    return (
      <div className="box box--warning">
        <strong>{tr('Chart unavailable.', 'Gráfico no disponible.')}</strong> {error}
        <div style={{ marginTop: '0.4rem', fontSize: '0.72rem' }}>
          The TradingView Advanced Charts bundle must be present at <code>public/charting_library/</code>.
        </div>
      </div>
    );
  }

  return <div ref={containerRef} className="vy-chart" style={{ height }} />;
}
