import { parseAbi, parseAbiItem, type Address, type ContractFunctionParameters, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import history from '../data/vyBuybackHistory.json';
import addresses from '../networks/mainnet/addresses.json';
import assetAddresses from '../networks/mainnet/assets.json';
import { scanFullHistory } from './logs';

/**
 * One observation of the "VY buyback" panel. Two slow series stack into the BASE — VY already off
 * the market — and the PROJECTION sits on top of it in BOTH units, because the two say different
 * things about the same event. Measured in VY the projection SATURATES against the venues' own
 * reserves (they hold ~95k VY between them and the book already buys more than half of it), so new
 * market-making capital barely moves the quantity; measured in USD it scales with the capital.
 */
export interface VyBuybackSample {
  block: number;
  /** Unix time in seconds. */
  ts: number;
  /**
   * Cumulative VY the buyback officers have sent into the VYT — `totalVyBoughtBack` in
   * src/pages/Mainnet.tsx. Monotone: VY does not come back out of the treasury to an officer.
   */
  boughtBackVy: number;
  /** The officers' own VY balance — the page's `buybackVyBalance`. Moves both ways. */
  heldVy: number;
  /**
   * VY the whole VMMO book would buy if deployed IN FULL, summed over every venue —
   * `projCurve.vyBoughtFull`. Null before the desk existed, and on a block it could not be read.
   */
  bookVy: number | null;
  /**
   * VY the arbitrage would buy in the public pool at that block's gap to the DAX — `arbBuyVy`.
   * Null on the same terms as `bookVy`.
   */
  arbVy: number | null;
  /**
   * The same book in DOLLARS: the capital it would spend — `desk.totalHeldUsd`. Summed over every
   * asset whose book answered, not over the surviving venues, so a stale TWAP costs `bookVy` its
   * venue without understating the capital.
   */
  bookUsd: number | null;
  /**
   * The USDC that arbitrage would spend buying its `arbVy` out of the public pool: Uu·q / (Vu − q).
   * 0 whenever `arbVy` is 0.
   */
  arbUsd: number | null;
}

interface VyBuybackHistoryFile {
  builtAtBlock: number;
  buyback: { projection: { startBlock: number } };
  stride: number;
  samples: VyBuybackSample[];
}

const committed = history as VyBuybackHistoryFile;

/** Build-time history committed with the app, oldest first. */
export const VY_BUYBACK_SNAPSHOT: VyBuybackSample[] = committed.samples;

const BUILT_AT_BLOCK = committed.builtAtBlock;
const SNAPSHOT_STRIDE = committed.stride;

/**
 * Merge snapshots by block, preferring a tail observation if a block overlaps. The original
 * snapshot object is retained when the tail adds nothing, avoiding needless chart rerenders.
 */
export function mergeVyBuybackSamples(
  snapshot: VyBuybackSample[], tail: VyBuybackSample[],
): VyBuybackSample[] {
  if (!tail.length) return snapshot;
  // A VY count is never negative and never NaN; the projection pair may legitimately be absent.
  const counted = (value: number): boolean => Number.isFinite(value) && value >= 0;
  const countedOrAbsent = (value: number | null): boolean => value === null || counted(value);
  const byBlock = new Map(snapshot.map((sample) => [sample.block, sample]));
  let changed = false;
  for (const sample of tail) {
    if (!(sample.block >= 0) || !(sample.ts > 0) ||
      !counted(sample.boughtBackVy) || !counted(sample.heldVy) ||
      !countedOrAbsent(sample.bookVy) || !countedOrAbsent(sample.arbVy) ||
      !countedOrAbsent(sample.bookUsd) || !countedOrAbsent(sample.arbUsd)) continue;
    const old = byBlock.get(sample.block);
    if (!old || old.ts !== sample.ts || old.boughtBackVy !== sample.boughtBackVy ||
      old.heldVy !== sample.heldVy || old.bookVy !== sample.bookVy || old.arbVy !== sample.arbVy ||
      old.bookUsd !== sample.bookUsd || old.arbUsd !== sample.arbUsd) {
      byBlock.set(sample.block, sample);
      changed = true;
    }
  }
  return changed ? [...byBlock.values()].sort((a, b) => a.block - b.block) : snapshot;
}

/** Index of the newest sample at or before `time`, or -1 when `time` precedes them all. */
function indexAt(samples: VyBuybackSample[], time: number): number {
  if (time < samples[0].ts) return -1;
  let low = 0;
  let high = samples.length - 1;
  while (high - low > 0) {
    const middle = (low + high + 1) >> 1;
    if (samples[middle].ts <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The base — VY already bought back and held — at a unix-ms instant. STEPPED, never interpolated:
 * this is a cumulative COUNT of tokens that moved in single transactions, so a midpoint between two
 * observations is a quantity that was never true. Before the first observation it is 0, which is
 * not a backfill but the fact: nothing had been bought back yet. NaN only when there is no history
 * to read at all, so a caller can tell "none yet" from "unknown".
 */
export function vyBuybackBaseAt(samples: VyBuybackSample[], ms: number): number {
  if (!samples.length || !Number.isFinite(ms)) return Number.NaN;
  const index = indexAt(samples, ms / 1_000);
  if (index < 0) return 0;
  return samples[index].boughtBackVy + samples[index].heldVy;
}

/**
 * Interpolate one projection series at `time`, skipping the nulls. A block whose venues could not
 * be read is a hole to bridge, not a zero to draw — so the nearest readable observation on each
 * side sets the line, exactly as a dropped projection point is bridged. Before the first readable
 * observation the answer is 0: the VMMO desk did not exist, so its book bought nothing.
 */
function projectedAt(
  samples: VyBuybackSample[], time: number, pick: (sample: VyBuybackSample) => number | null,
): number {
  const index = indexAt(samples, time);
  if (index < 0) return 0;

  let before = index;
  while (before >= 0 && pick(samples[before]) === null) before--;
  if (before < 0) return 0;

  let after = index + 1;
  while (after < samples.length && pick(samples[after]) === null) after++;
  const low = samples[before];
  if (after >= samples.length) return pick(low) as number;

  const high = samples[after];
  if (high.ts <= low.ts) return pick(high) as number;
  const a = pick(low) as number;
  const b = pick(high) as number;
  return a + ((time - low.ts) / (high.ts - low.ts)) * (b - a);
}

/**
 * The projection alone, in VY: what the VMMO book and the arbitrage would buy on top of the base.
 * 0 before the desk existed, so a caller can add it to anything without a hole. This SATURATES —
 * the venues only hold so much VY — which is why the panel draws `vyBuybackFutureUsdAt` beside it.
 */
export function vyBuybackFutureVyAt(samples: VyBuybackSample[], ms: number): number {
  if (!samples.length || !Number.isFinite(ms)) return Number.NaN;
  const time = ms / 1_000;
  return projectedAt(samples, time, (s) => s.bookVy) + projectedAt(samples, time, (s) => s.arbVy);
}

/**
 * The same projection in DOLLARS: the capital the book would spend plus the USDC the arbitrage
 * would spend. Same interpolation, same 0-before-it-existed. Unlike the VY figure this scales with
 * the money put to work, so it is the line that moves when new market-making capital arrives.
 */
export function vyBuybackFutureUsdAt(samples: VyBuybackSample[], ms: number): number {
  if (!samples.length || !Number.isFinite(ms)) return Number.NaN;
  const time = ms / 1_000;
  return projectedAt(samples, time, (s) => s.bookUsd) + projectedAt(samples, time, (s) => s.arbUsd);
}

/**
 * The whole stack at a unix-ms instant, in VY: the stepped base plus the interpolated projection.
 * The projection counts as 0 wherever it does not exist, so the total never dips when the panel
 * scrolls back past the desk's first block — the base simply stands alone there.
 */
export function vyBuybackTotalAt(samples: VyBuybackSample[], ms: number): number {
  const base = vyBuybackBaseAt(samples, ms);
  if (!Number.isFinite(base)) return base;
  return base + vyBuybackFutureVyAt(samples, ms);
}

/**
 * LIVE TAIL — the same six series scripts/build-vy-buyback-history.mjs commits, recomputed in the
 * browser so the panel keeps moving while the page is open.
 *
 * THE BASE IS A DELTA, NOT A RESCAN. The committed file's newest sample already carries the
 * cumulative bought-back and held totals at `builtAtBlock`, so the tail only has to scan the VY
 * Transfer logs the officers touched SINCE that block and add them on. That is two chunked getLogs
 * calls — one per topic position, because `from` and `to` are different indexed slots and a single
 * query would AND them — against the full-history rescan the page itself still pays for.
 *
 * THE PROJECTION IS A CALL. `bookVy` is `projCurve.vyBoughtFull` in src/pages/Mainnet.tsx: every
 * VMMO book spent IN FULL into its own venue — USDC in the UniV2 VY/USDC pair, WBTC/WETH/PAXG in
 * their ValinityDAX pools — with the VY removed summed across ALL of them, because the PRICE is the
 * highest venue but the QUANTITY is every venue at once. `arbVy` is `arbBuyVy`: the closed-form
 * crossing point q = (√kd·Vu − √ku·Vd) / (√ku + √kd) between the public pair and the three DAX
 * treasury pools, clamped to [0, Vu], with the VGC pool excluded because it is not part of fair
 * value. Depth is on the VAO TWAP marks and books on VBSO's, the same two reads the sheet uses, so
 * `usdIn / depth` is unit-consistent. `bookUsd` and `arbUsd` are those same two forces in dollars —
 * the capital each would spend — and cost no extra reads: both fall out of the batch already
 * fetched for the VY figures.
 *
 * One eth_call per sampled block: a single Multicall3 batch reads the timestamp, the pair reserves,
 * every DAX pool, every book and every mark at the same block, so a point can never be half one
 * block and half another. Nothing here throws: these run inside the page's 30-second poll, and a
 * dead RPC or a reverted venue must cost a point, never the chart.
 */

const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)']);
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
]);
const DAX_ABI = parseAbi([
  'function getNumPools() view returns (uint256)',
  'function getPoolReserves(uint256) view returns (address,uint256,uint256)',
]);
const VMMO_ABI = parseAbi(['function books(address) view returns (uint256,uint256,uint64)']);
const VBSO_ABI = parseAbi(['function assetUsdPrice(address) view returns (uint256)']);
const VAO_ABI = parseAbi(['function getAssetTwapPrice(address) view returns (uint256)']);
const MULTICALL_ABI = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256)']);
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

const VMMO = addresses.ValinityMarketMakerOfficer as Address;
const VBSO = addresses.ValinityBalanceSheetOfficer as Address;
const VAO = addresses.ValinityAcquisitionOfficer as Address; // same address as ValinityAssetOracle.
const DAX = addresses.ValinityDAX as Address;
const PAIR = addresses.VyUsdcPool as Address;
const VY_TOKEN = addresses.ValinityToken as Address;
const VYT = addresses.ValinityYieldTreasury as Address;

/**
 * The two buyback officers, exactly as src/pages/Mainnet.tsx names them. The old one is
 * decommissioned and holds nothing, but the VY it bought is still in the VYT — dropping it would
 * cut the cumulative total.
 */
const OFFICERS: Address[] = [
  '0xD2F0826af20EbDc833c8418E312F23f373F8500e',
  addresses.ValinityMarketStabilityOfficer as Address,
];

// Order matters only for readability; it is Mainnet.tsx's TABLE_ASSETS order. USDC is the one venue
// that is not a DAX pool, and the one asset with no VAO TWAP — the sheet marks it at $1.
const TABLE_ASSETS: { sym: string; address: Address; isDaxVenue: boolean }[] = [
  { sym: 'USDC', address: assetAddresses.USDC as Address, isDaxVenue: false },
  { sym: 'WBTC', address: assetAddresses.WBTC as Address, isDaxVenue: true },
  { sym: 'WETH', address: assetAddresses.WETH as Address, isDaxVenue: true },
  { sym: 'PAXG', address: assetAddresses.PAXG as Address, isDaxVenue: true },
];

const MAX_TAIL_SAMPLES = 60;
const OUTPUT_SCALE = 1e6;
/**
 * Round to 6 decimals, the precision the committed file is written at. NOT the projected price's
 * 12 — these are VY COUNTS near 1e6, and `value * 1e12` would land past 2^53.
 */
const round6 = (value: number): number => Math.round(value * OUTPUT_SCALE) / OUTPUT_SCALE;

// Batch layout. The timestamp and the pair reserves lead; the rest is sized by the pool count.
const I_TIMESTAMP = 0;
const I_RESERVES = 1;
const I_POOLS = 2;

type CallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: unknown };

interface BuybackAsset { sym: string; address: Address; isDaxVenue: boolean; decimals: number }

interface Immutables {
  vyIsToken0: boolean;
  assets: BuybackAsset[];
  daxAssets: BuybackAsset[];
  /** The batch read at every sampled block — its args never depend on the block. */
  contracts: ContractFunctionParameters[];
  iBooks: number;
  iMarks: number;
  iTwaps: number;
}

/**
 * Token decimals and the pair's token ordering cannot change, and re-reading them on every sampled
 * block would only pad the batch, so they are read once and kept for the life of the page — exactly
 * what the build script does at its own level. `getNumPools` CAN grow, so the head count is used as
 * the upper bound on pool ids: at an older block the ids that did not exist yet simply revert and
 * drop out, and a pool listed after the page opened is missed until it is reloaded.
 */
async function readImmutables(client: PublicClient): Promise<Immutables> {
  const setup = (await client.multicall({
    allowFailure: false,
    batchSize: 0,
    contracts: [
      { address: PAIR, abi: PAIR_ABI, functionName: 'token0' },
      { address: DAX, abi: DAX_ABI, functionName: 'getNumPools' },
      ...TABLE_ASSETS.map((t) => ({ address: t.address, abi: ERC20_ABI, functionName: 'decimals' })),
    ] as ContractFunctionParameters[],
  })) as unknown as [string, bigint, ...number[]];

  const vyIsToken0 = String(setup[0]).toLowerCase() === VY_TOKEN.toLowerCase();
  const poolIds = Array.from({ length: Number(setup[1]) }, (_, i) => BigInt(i));
  const assets: BuybackAsset[] = TABLE_ASSETS.map((t, i) => ({ ...t, decimals: Number(setup[2 + i]) }));
  const daxAssets = assets.filter((t) => t.isDaxVenue);

  const iBooks = I_POOLS + poolIds.length;
  const iMarks = iBooks + assets.length;
  const iTwaps = iMarks + assets.length;
  const contracts = [
    {
      address: mainnet.contracts.multicall3.address,
      abi: MULTICALL_ABI,
      functionName: 'getCurrentBlockTimestamp',
    },
    { address: PAIR, abi: PAIR_ABI, functionName: 'getReserves' },
    ...poolIds.map((id) => ({
      address: DAX, abi: DAX_ABI, functionName: 'getPoolReserves', args: [id],
    })),
    ...assets.map((t) => ({ address: VMMO, abi: VMMO_ABI, functionName: 'books', args: [t.address] })),
    ...assets.map((t) => ({
      address: VBSO, abi: VBSO_ABI, functionName: 'assetUsdPrice', args: [t.address],
    })),
    ...daxAssets.map((t) => ({
      address: VAO, abi: VAO_ABI, functionName: 'getAssetTwapPrice', args: [t.address],
    })),
  ] as ContractFunctionParameters[];

  return { vyIsToken0, assets, daxAssets, contracts, iBooks, iMarks, iTwaps };
}

let immutables: Promise<Immutables> | null = null;

/** Memoized in module scope, and forgotten on failure so the next poll can try again. */
function loadImmutables(client: PublicClient): Promise<Immutables> {
  immutables ??= readImmutables(client).catch((error: unknown) => {
    immutables = null;
    throw error;
  });
  return immutables;
}

/** A running base total at the block it took effect. */
interface BaseStep { block: number; boughtBackVy: number; heldVy: number }

/**
 * The base at `builtAtBlock`, taken straight from the committed file's newest sample. Everything
 * the tail reads is an increment on this, which is what keeps a live poll from rescanning years of
 * Transfer logs it already summed at build time.
 */
const ANCHOR: BaseStep = VY_BUYBACK_SNAPSHOT.length
  ? {
    block: BUILT_AT_BLOCK,
    boughtBackVy: VY_BUYBACK_SNAPSHOT[VY_BUYBACK_SNAPSHOT.length - 1].boughtBackVy,
    heldVy: VY_BUYBACK_SNAPSHOT[VY_BUYBACK_SNAPSHOT.length - 1].heldVy,
  }
  : { block: BUILT_AT_BLOCK, boughtBackVy: 0, heldVy: 0 };

/**
 * Every block since `builtAtBlock` where the officers moved VY, as running totals. Two chunked
 * scans: what they SENT (the VYT-bound subset is the buyback) and what they RECEIVED. Order within
 * a block is irrelevant — only the block's net matters, and a sample carries the state at its end.
 */
async function readBaseSteps(client: PublicClient): Promise<BaseStep[]> {
  const from = BigInt(ANCHOR.block + 1);
  const scan = (args: { from: Address[] } | { to: Address[] }) =>
    scanFullHistory(client, (fromBlock, toBlock) => client.getLogs({
      address: VY_TOKEN, event: TRANSFER_EVENT, args, fromBlock, toBlock,
    }), from);
  const [sent, received] = await Promise.all([
    scan({ from: OFFICERS }),
    scan({ to: OFFICERS }),
  ]);

  const deltas = new Map<number, { boughtBack: bigint; held: bigint }>();
  const bump = (block: bigint, boughtBack: bigint, held: bigint): void => {
    const key = Number(block);
    const row = deltas.get(key) ?? { boughtBack: 0n, held: 0n };
    row.boughtBack += boughtBack;
    row.held += held;
    deltas.set(key, row);
  };
  for (const log of sent) {
    const value = log.args.value ?? 0n;
    const toVyt = String(log.args.to).toLowerCase() === VYT.toLowerCase();
    bump(log.blockNumber, toVyt ? value : 0n, -value);
  }
  for (const log of received) bump(log.blockNumber, 0n, log.args.value ?? 0n);

  const steps: BaseStep[] = [];
  let boughtBackWei = 0n;
  let heldWei = 0n;
  for (const block of [...deltas.keys()].sort((a, b) => a - b)) {
    const row = deltas.get(block)!;
    boughtBackWei += row.boughtBack;
    heldWei += row.held;
    steps.push({
      block,
      boughtBackVy: round6(ANCHOR.boughtBackVy + Number(boughtBackWei) / 1e18),
      heldVy: round6(ANCHOR.heldVy + Number(heldWei) / 1e18),
    });
  }
  return steps;
}

/**
 * The base in force AT `block`. Steps past `block` are ignored rather than assumed absent, because
 * the scan runs to ITS OWN head — which can already be a block or two ahead of the one being
 * sampled — and folding those in would date a future balance to the past.
 */
function baseAtBlock(steps: BaseStep[], block: number): BaseStep {
  let base = ANCHOR;
  for (const step of steps) {
    if (step.block > block) break;
    base = step;
  }
  return base;
}

/**
 * The four projection series at one block, from one batch. Mirrors Mainnet.tsx: a venue is kept
 * only when it has both USD depth and VY to sell, and spending `usdIn` against (depthUsd, vy)
 * removes vy × usdIn / (depthUsd + usdIn) tokens. A block with no usable venue — or with no VMMO
 * desk to read at all — leaves those series null, which the lookups bridge rather than draw as zero.
 *
 * `bookUsd` is accumulated BEFORE the venue filter, because it is `desk.totalHeldUsd`: a venue
 * drops out of `bookVy` when its pool depth cannot be priced, but the book's own dollar value comes
 * off VBSO's mark, a different read that still answers. Keeping it is the difference between
 * "we could not price the pool" and "there is no capital".
 *
 * A treasury pool whose TWAP is unavailable still contributes its VY leg and nothing to the USD
 * leg, exactly as the page's `reserveAssetUSD` would read zero: that shrinks q, never invents depth.
 */
async function sampleAt(
  client: PublicClient, block: number, one: Immutables, steps: BaseStep[],
): Promise<VyBuybackSample | null> {
  try {
    const results = (await client.multicall({
      blockNumber: BigInt(block),
      allowFailure: true,
      batchSize: 0,
      contracts: one.contracts,
    })) as unknown as CallResult[];

    const value = (index: number): unknown => {
      const row = results[index];
      return row && row.status === 'success' ? row.result : null;
    };

    const timestamp = value(I_TIMESTAMP) as bigint | null;
    if (timestamp === null) return null;

    const base = baseAtBlock(steps, block);
    const sample: VyBuybackSample = {
      block,
      ts: Number(timestamp),
      boughtBackVy: base.boughtBackVy,
      heldVy: base.heldVy,
      bookVy: null,
      arbVy: null,
      bookUsd: null,
      arbUsd: null,
    };

    const reserves = value(I_RESERVES) as readonly [bigint, bigint, number] | null;
    const vyReserve = reserves ? (one.vyIsToken0 ? reserves[0] : reserves[1]) : 0n;
    const usdcReserve = reserves ? (one.vyIsToken0 ? reserves[1] : reserves[0]) : 0n;
    const vu = Number(vyReserve) / 1e18;
    const uu = Number(usdcReserve) / 1e6;

    type Pool = readonly [string, bigint, bigint];
    const pools: Pool[] = [];
    for (let i = I_POOLS; i < one.iBooks; i++) {
      const pool = value(i) as Pool | null;
      if (pool) pools.push(pool);
    }

    const books = one.assets.map((_, i) => value(one.iBooks + i) as readonly [bigint, bigint, bigint] | null);
    if (books.every((book) => book === null)) return sample;

    let vd = 0; // treasury-pool VY reserves, summed.
    let ad = 0; // treasury-pool asset reserves on VAO marks, summed, in USD.
    let bookUsd = 0; // desk.totalHeldUsd — accumulated BEFORE the venue filter, see above.

    const venues = one.assets.flatMap((t, i) => {
      const book = books[i];
      const held = book ? book[0] : 0n;
      const mark = (value(one.iMarks + i) as bigint | null) ?? 0n; // WAD USD per whole asset.
      const heldUsd = Number((held * mark) / 10n ** BigInt(t.decimals)) / 1e18;
      bookUsd += heldUsd;

      if (!t.isDaxVenue) return [{ depthUsd: uu, vy: vu, heldUsd }];

      const pool = pools.find((p) => String(p[0]).toLowerCase() === t.address.toLowerCase());
      if (!pool) return [];
      const spot = (value(one.iTwaps + one.daxAssets.indexOf(t)) as bigint | null) ?? 0n; // VAO TWAP.
      const reserveAssetUsd = spot > 0n
        ? (pool[2] * 10n ** BigInt(18 - t.decimals) * spot) / 10n ** 18n
        : 0n;
      const depthUsd = Number(reserveAssetUsd) / 1e18;
      const vy = Number(pool[1]) / 1e18;
      vd += vy;
      ad += depthUsd;
      return [{ depthUsd, vy, heldUsd }];
    }).filter((v) => v.depthUsd > 0 && v.vy > 0);

    if (Number.isFinite(bookUsd) && bookUsd >= 0) sample.bookUsd = round6(bookUsd);
    if (!venues.length) return sample;

    const bookVy = venues.reduce((n, v) => n + (v.vy * v.heldUsd) / (v.depthUsd + v.heldUsd), 0);
    if (Number.isFinite(bookVy) && bookVy >= 0) sample.bookVy = round6(bookVy);

    // q ≤ 0 means the public pool is already at or above the DAX — nothing to arbitrage. The 0.3%
    // Uniswap fee is left out, exactly as Mainnet.tsx leaves it out: it moves the crossing point by
    // well under a percent and only downward.
    if (vu > 0 && uu > 0 && vd > 0 && ad > 0) {
      const rootKu = Math.sqrt(vu * uu);
      const rootKd = Math.sqrt(vd * ad);
      const q = (rootKd * vu - rootKu * vd) / (rootKu + rootKd);
      const arbVy = q > 0 ? Math.min(q, vu) : 0;
      if (Number.isFinite(arbVy)) {
        sample.arbVy = round6(arbVy);
        // Uu·q / (Vu − q). The clamp can in principle put q AT Vu, where draining the pool costs an
        // unbounded amount rather than merely a large one; that is a null, not a number.
        const spend = arbVy === 0 ? 0
          : (vu > arbVy ? (uu * arbVy) / (vu - arbVy) : Number.POSITIVE_INFINITY);
        if (Number.isFinite(spend) && spend >= 0) sample.arbUsd = round6(spend);
      }
    }

    return sample;
  } catch {
    return null;
  }
}

/**
 * Fetch observations after the committed file through the current head. Historical catch-up is kept
 * near the build-time six-hour cadence and capped at 60 calls; the exact head is always included. A
 * block that cannot be read drops that point so the lookups bridge the gap, and a failure to reach
 * the chain at all returns nothing rather than throwing into the poll.
 */
export async function fetchVyBuybackTail(client: PublicClient): Promise<VyBuybackSample[]> {
  try {
    const [head, one, steps] = await Promise.all([
      client.getBlockNumber().then(Number),
      loadImmutables(client),
      readBaseSteps(client),
    ]);
    if (head <= BUILT_AT_BLOCK) return [];

    const stride = Math.max(SNAPSHOT_STRIDE, Math.ceil((head - BUILT_AT_BLOCK) / MAX_TAIL_SAMPLES));
    const blocks: number[] = [];
    for (let block = BUILT_AT_BLOCK + stride; block < head; block += stride) blocks.push(block);
    blocks.push(head);

    const rows = await Promise.all(blocks.map((block) => sampleAt(client, block, one, steps)));
    return rows.filter((sample): sample is VyBuybackSample => sample !== null);
  } catch {
    return [];
  }
}

/** One fully-validated observation at the current head, for the live poll after catch-up. */
export async function fetchVyBuybackHead(client: PublicClient): Promise<VyBuybackSample | null> {
  try {
    const [head, one, steps] = await Promise.all([
      client.getBlockNumber().then(Number),
      loadImmutables(client),
      readBaseSteps(client),
    ]);
    return await sampleAt(client, head, one, steps);
  } catch {
    return null;
  }
}
