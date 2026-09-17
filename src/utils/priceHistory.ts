import { formatUnits } from 'viem';
import mfcHistory from '../data/mfcHistory.json';
import vyHistory from '../data/vyHistory.json';

/**
 * VALINITY LIFETIME PRICE — the normalised trade stream behind the chart and the tape.
 *
 * Valinity has traded under several contracts across two chains. Each is an "era" with its own
 * venue and market structure, and this module flattens them into ONE list of trades so nothing
 * downstream has to care which era a print came from:
 *
 *   MFC v1   BNB Chain   OTC order book, BUSD-quoted    2021-12 → 2022-05
 *   MFC v2   BNB Chain   OTC order book                 excluded — one $10 test fill
 *   MFC v3   BNB Chain   OTC order book, BUSD-quoted    2022-05 → 2022-06
 *   MFC v4   BNB Chain   OTC order book, BUSD-quoted    2022-10 → 2023-04
 *   VY       Ethereum    Uniswap V2 VY/WETH             2024-04 → 2025-12
 *   VY       Ethereum    Uniswap V2 VY/USDC             2026-04 → live
 *
 * WHICH PRICE IS PLOTTED:
 *   - The OTC books and the closed VY/WETH pool plot the price each trade EXECUTED at.
 *   - The live VY/USDC pool plots the POOL'S OWN PRICE after each trade: USDC reserve ÷ VY
 *     reserve, from the `Sync` the pool emits with every swap. That is the price the pool quotes,
 *     what the web app reads with getReserves() and what DexScreener shows. A large swap's
 *     average fill differs from it by several percent, so the fill is kept separately as
 *     `execPrice` for the tape.
 *
 * NO REBASING. Prices are joined raw, with no conversion ratio applied at any handoff. The MFC
 * eras happen to line up closely on their own (v1 ends $0.2591, v3 opens $0.2609).
 */

export type EraId = 'mfc-v1' | 'mfc-v2' | 'mfc-v3' | 'mfc-v4' | 'vy-legacy' | 'vy-current';

export interface Era {
  id: EraId;
  label: string;
  symbol: string;
  chain: string;
  venue: string;
  explorer: string;
}

const BSCSCAN = 'https://bscscan.com';
const ETHERSCAN = 'https://etherscan.io';

export const ERAS: Record<EraId, Era> = {
  'mfc-v1': { id: 'mfc-v1', label: 'MFC v1', symbol: 'MFC', chain: 'BNB Chain', venue: 'P2P order book', explorer: BSCSCAN },
  'mfc-v2': { id: 'mfc-v2', label: 'MFC v2', symbol: 'MFC', chain: 'BNB Chain', venue: 'P2P order book', explorer: BSCSCAN },
  'mfc-v3': { id: 'mfc-v3', label: 'MFC v3', symbol: 'MFC', chain: 'BNB Chain', venue: 'P2P order book', explorer: BSCSCAN },
  'mfc-v4': { id: 'mfc-v4', label: 'MFC v4', symbol: 'MFC', chain: 'BNB Chain', venue: 'P2P order book', explorer: BSCSCAN },
  'vy-legacy': { id: 'vy-legacy', label: 'VY (legacy)', symbol: 'VY', chain: 'Ethereum', venue: 'Uniswap V2 · WETH', explorer: ETHERSCAN },
  'vy-current': { id: 'vy-current', label: 'VY (live)', symbol: 'VY', chain: 'Ethereum', venue: 'Uniswap V2 · USDC', explorer: ETHERSCAN },
};

/** Eras charted at the pool's own price rather than each trade's fill. */
const POOL_PRICED = new Set<string>(['vy-current']);

/** One trade, normalised across chains and venues. Always USD-denominated. */
export interface Trade {
  /** Execution time, unix SECONDS. */
  ts: number;
  /** The charted price, USD per token — see the module header for which basis each era uses. */
  price: number;
  /** What the trade itself paid on average, when that differs from `price`. */
  execPrice?: number;
  /** Token quantity. */
  qty: number;
  /** USD value of the fill. */
  usd: number;
  /** The counterparty this print is attributed to (the EOA that sent the transaction). */
  address: string;
  txHash: string;
  /** Stable identity — one transaction can carry more than one fill. */
  key: string;
  /** Position on its chain (block × 100,000 + log index), to order trades within one block. */
  seq?: number;
  era: EraId;
  /** From the taker's side. The MFC books are buy-only; see `loadMfcTrades`. */
  side: 'buy' | 'sell';
  explorerUrl: string;
}

/**
 * Chain order: by time, then by position on the chain within the same second. Ordering by key
 * alone would sort same-block trades by transaction hash — effectively at random — and the last
 * price of a block could then be one from the middle of it.
 */
export const compareTrades = (a: Trade, b: Trade): number =>
  a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0) || a.key.localeCompare(b.key);

// ── MFC eras (BNB Chain) ────────────────────────────────────────────────────

interface RawMfcTrade {
  era: string; block: number; ts: number; tx: string;
  logIndex: number; offer: number; buyer: string; mfc: string; busd: string;
}

/** Era ids the chart must not plot, and why — read from the generated data, not hardcoded. */
export const EXCLUDED_ERAS: { id: string; label: string; reason: string }[] =
  (mfcHistory.eras as { id: string; label: string; excluded?: boolean; excludedReason?: string }[])
    .filter((e) => e.excluded)
    .map((e) => ({ id: e.id, label: e.label, reason: e.excludedReason ?? 'excluded' }));

const isExcluded = (id: string) => EXCLUDED_ERAS.some((e) => e.id === id);

/**
 * The MFC OTC books, from the committed scan (scripts/build-mfc-history.mjs).
 *
 * Every print is a BUY: a book only emits `TradeOffer` when a buyer fills a standing sell
 * tranche, so there is no sell side. Labelling half of them "sell" to make the tape resemble
 * an AMM's would invent a flow that never existed.
 */
export function loadMfcTrades(): Trade[] {
  const decimals = mfcHistory.decimals;
  const quoteDecimals = mfcHistory.quote.decimals;
  return (mfcHistory.trades as RawMfcTrade[])
    .filter((t) => !isExcluded(t.era))
    .map((t) => {
      const qty = Number(formatUnits(BigInt(t.mfc), decimals));
      const usd = Number(formatUnits(BigInt(t.busd), quoteDecimals));
      return {
        ts: t.ts,
        price: usd / qty,
        qty,
        usd,
        address: t.buyer,
        txHash: t.tx,
        key: `${t.tx}:${t.logIndex}`,
        seq: t.block * 100_000 + t.logIndex,
        era: t.era as EraId,
        side: 'buy' as const,
        explorerUrl: `${BSCSCAN}/tx/${t.tx}`,
      };
    });
}

// ── Ethereum eras ───────────────────────────────────────────────────────────

interface RawVyTrade {
  era: string; block: number; ts: number; tx: string; logIndex: number;
  side: string; maker: string; vy: string; quote: string; quoteUsd: number;
  /** The pool's price (USD) after this swap, from its Sync event. */
  poolPrice?: number | null;
}

interface RawVyEra { id: string; quote: { decimals: number }; [k: string]: unknown }

/**
 * LAUNCH-DAY DISCOVERY, EXCLUDED (legacy pool only).
 *
 * The legacy pool opened 2024-04-03 seeded with about 8 WETH. On that one day 281 swaps ran the
 * price from $0.22 to $7.94 and back to $0.347 — a 25x round trip on a few ETH of flow. Those
 * prints are REAL; they are not manipulation and not bad data. They are also not a market: a
 * pool that thin is still discovering its price, and a single day's excursion 6x above
 * everything before or since dominates four years of chart.
 *
 * So the chart starts that era at 2024-04-04. Two independent things say this is the honest
 * boundary rather than a flattering one: the era then opens at $0.3445, where the price actually
 * settled, and the MFC→Ethereum seam becomes +10% instead of +104%. The excluded swaps remain in
 * src/data/vyHistory.json.
 *
 * An outlier filter was tried for this and rejected: the spike is 129 prints, so a local rolling
 * median sits INSIDE it and removes nothing, while wrongly clipping MFC's early climb.
 */
export const LAUNCH_EXCLUSION = {
  era: 'vy-legacy',
  from: Date.UTC(2024, 3, 3) / 1000,
  to: Date.UTC(2024, 3, 4) / 1000,
  label: '3 Apr 2024 launch-day price discovery',
  detail: '281 swaps, $452,118 — pool seeded with ~8 WETH, price ran $0.22 → $7.94 → $0.347 in one day',
};

const OUTLIER_WINDOW = 12; // prints each side of the reference median
const OUTLIER_RATIO = 5;   // flag a print beyond 5x (or under 1/5x) its local median

/**
 * FLASH-LOAN FILTER — for the AMM eras only.
 *
 * A flash loan can push an AMM's reserves to any ratio and release them in the same atomic
 * transaction, emitting swaps at prices that never existed for anyone. The live pool has had one:
 * 2026-07-14, transaction 0x2176cea6…, ELEVEN swaps moving 453,676 VY — fourteen times the pool's
 * entire reserves — printing up to $228.84 while VY traded near $0.15. (The web app documents the
 * same event from the Sync side: "6 prints of $147–$230".)
 *
 * Detection is a local rolling median: local so a genuine trend is never clipped, median so a
 * cluster of manipulated prints cannot drag the reference. But the UNIT OF REMOVAL is the whole
 * TRANSACTION, not the individual print — an atomic transaction is one economic event, and its
 * quiet-looking legs are the same manipulation seen from the other side.
 *
 * Exported because it runs twice: over the committed snapshot here, and again in the page over
 * the live pool's merged trades, so a manipulation after the snapshot is dropped as well.
 *
 * Scoped to the AMM eras deliberately: the MFC books hold no reserves, so they cannot be
 * flash-loaned, and their prints are sparse enough that MFC v1's genuine 14x climb would trip a
 * median filter.
 */
export function dropManipulatedTransactions(trades: Trade[]): Trade[] {
  if (trades.length < 2 * OUTLIER_WINDOW + 1) return trades;
  const bad = new Set<string>();
  for (let i = 0; i < trades.length; i++) {
    const lo = Math.max(0, i - OUTLIER_WINDOW);
    const hi = Math.min(trades.length, i + OUTLIER_WINDOW + 1);
    const win: number[] = [];
    for (let j = lo; j < hi; j++) if (j !== i) win.push(trades[j].price);
    win.sort((a, b) => a - b);
    const med = win[win.length >> 1];
    const p = trades[i].price;
    if (med > 0 && (p > med * OUTLIER_RATIO || p * OUTLIER_RATIO < med)) bad.add(trades[i].txHash);
  }
  return bad.size ? trades.filter((t) => !bad.has(t.txHash)) : trades;
}

/**
 * Both Ethereum Uniswap V2 pools: the closed VY/WETH era and the live VY/USDC era.
 *
 * Unlike the OTC books these venues have two sides, so `side` is real. The legacy pool quotes in
 * ETH, so each swap carries the ETH/USD mark that applied at its own block (see the builder) —
 * USD is derived from that, never from today's ETH price. The live pool quotes in USDC, so its
 * mark is 1, and it is charted at the pool's own price (see the module header).
 */
export function loadEthTrades(): Trade[] {
  const decimalsFor = new Map<string, number>(
    (vyHistory.eras as unknown as RawVyEra[]).map((e) => [e.id, e.quote.decimals])
  );
  const trades = (vyHistory.trades as RawVyTrade[])
    .filter((t) => !(t.era === LAUNCH_EXCLUSION.era
      && t.ts >= LAUNCH_EXCLUSION.from && t.ts < LAUNCH_EXCLUSION.to))
    .map((t) => {
      const qty = Number(formatUnits(BigInt(t.vy), 18));
      const usd = Number(formatUnits(BigInt(t.quote), decimalsFor.get(t.era) ?? 18)) * t.quoteUsd;
      const execPrice = usd / qty;
      return {
        ts: t.ts,
        price: POOL_PRICED.has(t.era) && t.poolPrice ? t.poolPrice : execPrice,
        execPrice,
        qty,
        usd,
        address: t.maker,
        txHash: t.tx,
        key: `${t.tx}:${t.logIndex}`,
        seq: t.block * 100_000 + t.logIndex,
        era: t.era as EraId,
        side: t.side === 'sell' ? ('sell' as const) : ('buy' as const),
        explorerUrl: `${ETHERSCAN}/tx/${t.tx}`,
      };
    })
    .sort(compareTrades);
  return dropManipulatedTransactions(trades);
}

/** Every era, oldest print first. */
export function loadAllTrades(): Trade[] {
  return [...loadMfcTrades(), ...loadEthTrades()].sort(compareTrades);
}

export const MFC_META = mfcHistory;
export const VY_META = vyHistory;

// ── Candles ─────────────────────────────────────────────────────────────────

export interface Bar {
  /** Bucket start, unix MILLISECONDS (what TradingView wants). */
  time: number;
  open: number; high: number; low: number; close: number; volume: number;
}

export const RES_MS: Record<string, number> = {
  '60': 3_600e3, '240': 14_400e3,
  '1D': 86_400e3, D: 86_400e3,
  '1W': 604_800e3, W: 604_800e3,
  // Nominal only — months are bucketed by the calendar, not by a fixed span. Kept here so
  // callers that just need an approximate width (viewport maths) still get a sane number.
  '1M': 2_592_000e3, M: 2_592_000e3,
};
export const resolutionMs = (r: string): number => RES_MS[r] ?? 86_400e3;

const isMonthly = (r: string) => r === '1M' || r === 'M';

/** Bucket start for a timestamp, and the start of the following bucket. */
function bucketing(resolution: string) {
  if (isMonthly(resolution)) {
    // Calendar months, not 30-day blocks: a fixed span drifts against real months and makes
    // TradingView's monthly axis label the wrong period.
    const start = (ms: number) => {
      const d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    };
    const next = (b: number) => {
      const d = new Date(b);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    };
    return { start, next };
  }
  const ms = resolutionMs(resolution);
  return { start: (t: number) => Math.floor(t / ms) * ms, next: (b: number) => b + ms };
}

/**
 * A move this large across an era boundary means the price did NOT carry from one contract to
 * the next. Every MFC handoff is well inside it (+0.7%, +5.7%, +10%); the legacy→current
 * Ethereum handoff is −80% and is not.
 */
const SERIES_BREAK = 0.5;

/**
 * OHLC over a trade stream (which must be in chain order — see `compareTrades`).
 *
 * EMPTY BUCKETS CARRY THE PREVIOUS CLOSE FORWARD. Deliberately not the sparse, no-fill basis
 * DexScreener uses for AMM pairs: most of this lifetime was an OTC tranche book, where between
 * fills the standing offer price IS the market price. That also covers the two dead stretches
 * inside the MFC lineage (Jun–Oct 2022, Apr 2023–Apr 2024) — the asset kept its value across
 * them, it simply had no venue.
 *
 * EXCEPT ACROSS A SERIES BREAK. When one contract's market ends and the next opens at a
 * completely different level, carrying forward tells two lies at once: it paints the dead
 * months at a price nobody could get, and then it charges the entire fall to the FIRST CANDLE
 * OF THE NEW CONTRACT — which is how an 80% collapse that happened when the old pool's
 * liquidity was pulled ends up drawn as one enormous red candle on the new token's opening day.
 *
 * The legacy Ethereum pool traded at $0.3494 with 406,802 VY of depth and was drained 21 hours
 * later; 115 days passed with no market on either contract; the new pool then opened at
 * $0.0691. So at that boundary the fill is suppressed and the new era opens on its own first
 * trade. The chart shows each contract at the level it actually traded, with an honest gap
 * between — rather than inventing a flat line and then blaming the new token for the drop.
 */
export function buildCandles(trades: Trade[], resolution: string): Bar[] {
  if (!trades.length) return [];
  const { start, next } = bucketing(resolution);

  const byBucket = new Map<number, Trade[]>();
  for (const t of trades) {
    const b = start(t.ts * 1000);
    const arr = byBucket.get(b);
    if (arr) arr.push(t);
    else byBucket.set(b, [t]);
  }

  const keys = [...byBucket.keys()].sort((a, b) => a - b);
  const bars: Bar[] = [];
  let prevClose: number | undefined;
  let prevEra: EraId | undefined;

  for (const key of keys) {
    const pts = byBucket.get(key) as Trade[];
    const firstTrade = pts[0];
    const lastTrade = pts[pts.length - 1];

    const broke = prevClose !== undefined && prevEra !== undefined
      && firstTrade.era !== prevEra
      && Math.abs(firstTrade.price / prevClose - 1) > SERIES_BREAK;

    if (prevClose !== undefined && !broke) {
      // Quiet buckets between the last trade and this one: the standing price persisted.
      const from = bars.length ? next(bars[bars.length - 1].time) : key;
      for (let b = from; b < key; b = next(b)) {
        bars.push({ time: b, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
      }
    }

    // After a break the new contract opens on its own first print, not the old one's close.
    const open = broke || prevClose === undefined ? firstTrade.price : prevClose;
    let high = open;
    let low = open;
    let volume = 0;
    for (const t of pts) {
      if (t.price > high) high = t.price;
      if (t.price < low) low = t.price;
      volume += t.usd;
    }
    bars.push({ time: key, open, high, low, close: lastTrade.price, volume });
    prevClose = lastTrade.price;
    prevEra = lastTrade.era;
  }
  return bars;
}

/**
 * When each candle's close was set: the time of the last trade in its bucket, or — for a quiet
 * bucket the chart fills forward — the end of the bucket. Anything drawn alongside the candles
 * (the reserve-asset lines) is read at these instants, so a line and a candle compare the same
 * moment instead of the line lagging its candle by up to a whole bar.
 */
export function barCloseTime(trades: Trade[], resolution: string): (barTimeMs: number) => number {
  const { start, next } = bucketing(resolution);
  const lastTrade = new Map<number, number>();
  // Oldest first, so the last write for a bucket is its closing trade.
  for (const t of trades) lastTrade.set(start(t.ts * 1000), t.ts * 1000);
  return (bar) => lastTrade.get(bar) ?? next(bar);
}

/** Price decimals that keep a sub-cent asset readable without trailing noise. */
export const decimalsForPrice = (p: number): number => {
  if (!(p > 0)) return 4;
  return Math.min(8, Math.max(2, 5 - Math.floor(Math.log10(p))));
};

/**
 * The price band the chart should OPEN on.
 *
 * Every trade stays in the data — the launch of the Ethereum pool genuinely printed up to
 * ~$7.94 within minutes on real liquidity, and deleting that would be falsifying the record.
 * But it is ~25x the price the asset spent its life at, so opening the view on the full extent
 * would squash a four-year history into the bottom sliver of the pane. So the initial window is
 * a high percentile rather than the maximum, and the user can zoom out to the spike freely.
 */
export function openingPriceBand(trades: Trade[]): { from: number; to: number } | null {
  if (trades.length < 20) return null;
  const sorted = trades.map((t) => t.price).filter((p) => p > 0).sort((a, b) => a - b);
  if (sorted.length < 20) return null;
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

  // The FLOOR is the all-time low, not a percentile. The cheapest prints are the start of the
  // whole story — MFC opened at $0.0179 — and they are a small share of the trade count, so any
  // low percentile would clip the earliest years straight off the bottom of the chart.
  const lo = sorted[0];

  // The CEILING trims only the brief launch spike. The Ethereum pool printed above $1 on 129
  // swaps confined to five days in April 2024; that tail drags the 98th/99th percentiles up to
  // $2–$5.50 and would make "zoomed" meaningless, so the cut sits just above the sustained
  // range (95th percentile ≈ $0.86).
  const hi = at(0.96);
  if (!(hi > lo)) return null;
  return { from: lo * 0.9, to: hi * 1.25 };
}
