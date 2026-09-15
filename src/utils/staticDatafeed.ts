import { buildCandles, decimalsForPrice, type Bar, type Trade } from './priceHistory';

/**
 * A TradingView datafeed over a FIXED trade list — history that has already ended.
 *
 * Kept out of the chart component so it can be exercised directly in tests: the awkward part
 * of this file is not drawing, it is answering the library's request windows correctly, and
 * that is worth checking without a browser.
 */

export interface TVPeriodParams { from: number; to: number; firstDataRequest: boolean; countBack: number }
export interface TVSymbolInfo { ticker: string; name: string }
export interface TVBar { time: number; open: number; high: number; low: number; close: number; volume?: number }
export interface TVBarsMeta { noData: boolean; nextTime?: number }

// Monthly matters here: the MFC years were a fixed-price tranche book, so at daily resolution
// 400 of 487 candles have zero height and the whole period reads as a hairline. At monthly,
// every MFC bar has a real range.
export const SUPPORTED_RES = ['60', '240', '1D', '1W', '1M'];

export function createStaticDatafeed(trades: Trade[], symbol: string, exchange: string) {
  // Candles are rebuilt per resolution rather than cached: the whole history is a few hundred
  // trades, so bucketing it costs less than the bookkeeping a cache would need.
  const barsFor = (resolution: string): Bar[] => buildCandles(trades, resolution);
  const lastPrice = trades.length ? trades[trades.length - 1].price : 1;

  return {
    onReady: (cb: (c: unknown) => void) =>
      setTimeout(() => cb({
        supported_resolutions: SUPPORTED_RES,
        supports_marks: false,
        supports_timescale_marks: false,
        supports_time: true,
      }), 0),

    searchSymbols: (_a: string, _b: string, _c: string, onResult: (r: unknown[]) => void) => onResult([]),

    resolveSymbol: (_name: string, onResolve: (info: unknown) => void) =>
      setTimeout(() => onResolve({
        ticker: symbol,
        name: symbol,
        description: `${symbol} / USD`,
        type: 'crypto',
        session: '24x7',
        timezone: 'Etc/UTC',
        exchange,
        listed_exchange: exchange,
        format: 'price',
        minmov: 1,
        pricescale: 10 ** decimalsForPrice(lastPrice),
        has_intraday: true,
        has_daily: true,
        has_weekly_and_monthly: true,
        supported_resolutions: SUPPORTED_RES,
        volume_precision: 0,
        // The eras plotted here are closed, so there is no live bar to wait on. Saying
        // "streaming" would leave the widget showing a perpetual connecting state.
        data_status: 'endofday',
      }), 0),

    /**
     * Bars for a window — written for history that ENDED IN THE PAST, which is the whole
     * difficulty here.
     *
     * The widget's first request is always anchored at now: `[now − countBack·interval, now]`.
     * For a closed era that window lies entirely to the RIGHT of every bar we have, so a naive
     * `from`/`to` filter returns nothing, and answering that with a bare `noData: true` tells
     * the widget to stop looking — it never pages back and the chart renders empty.
     *
     * Two things prevent that. First, `countBack` is honoured as the library asks: when it is
     * present, `from` is ignored and the last `countBack` bars ending at `to` are returned, so
     * an anchored-at-now request naturally yields the tail of real history. Second, when a
     * window holds nothing but older bars exist, `nextTime` points at the newest of them, so the
     * widget seeks back instead of concluding the symbol has no history at all.
     *
     * `to` is EXCLUSIVE ("rightmost requested bar - not inclusive"). Returning the bar AT `to`
     * hands the library back the oldest bar it already holds every time it pages left, so at
     * the start of history it never hears "no more data" and keeps asking — a chart that sits
     * on its loading spinner. And `nextTime` is in MILLISECONDS and may only point backwards.
     */
    getBars: (
      _symbolInfo: TVSymbolInfo,
      resolution: string,
      periodParams: TVPeriodParams,
      onResult: (bars: TVBar[], meta: TVBarsMeta) => void
    ) => {
      const all = barsFor(resolution);
      if (!all.length) return onResult([], { noData: true });

      const fromMs = periodParams.from * 1000;
      const toMs = periodParams.to * 1000;
      const before = all.filter((b) => b.time < toMs);

      const bars = periodParams.countBack > 0
        ? before.slice(-periodParams.countBack)
        : before.filter((b) => b.time >= fromMs);

      if (bars.length) return onResult(bars, { noData: false });

      // Nothing in the window: point back at the newest earlier bar, or — if the window is
      // already before the first bar — say plainly that history has ended.
      const older = before[before.length - 1];
      return onResult([], older ? { noData: true, nextTime: older.time } : { noData: true });
    },

    // Closed history: nothing streams. Kept as required no-ops.
    subscribeBars: () => { },
    unsubscribeBars: () => { },
  };
}
