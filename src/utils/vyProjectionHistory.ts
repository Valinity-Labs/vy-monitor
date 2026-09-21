import { parseAbi, type Address, type ContractFunctionParameters, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import history from '../data/vyProjectionHistory.json';
import addresses from '../networks/mainnet/addresses.json';
import assetAddresses from '../networks/mainnet/assets.json';

/**
 * One observation of the monitor's own "Projected" tile: every VMMO book spent IN FULL into its own
 * venue (USDC in the UniV2 VY/USDC pair, WBTC/WETH/PAXG in their ValinityDAX pools) along that
 * venue's constant-product curve, reporting the highest venue. See `projCurve` in
 * src/pages/Mainnet.tsx — this is that table's last row, which is what the tile shows.
 */
export interface VyProjectionSample {
  block: number;
  /** Unix time in seconds. */
  ts: number;
  /** USD per one whole VY. */
  price: number;
  /** The venue whose curve ended highest: 'USDC', 'WBTC', 'WETH' or 'PAXG'. */
  pool: string;
}

interface VyProjectionHistoryFile {
  builtAtBlock: number;
  projection: { startBlock: number };
  stride: number;
  samples: VyProjectionSample[];
}

const committed = history as VyProjectionHistoryFile;

/** Build-time history committed with the app, oldest first. */
export const VY_PROJECTION_SNAPSHOT: VyProjectionSample[] = committed.samples;

const BUILT_AT_BLOCK = committed.builtAtBlock;
const SNAPSHOT_STRIDE = committed.stride;

/**
 * Merge snapshots by block, preferring a tail observation if a block overlaps. The original
 * snapshot object is retained when the tail adds nothing, avoiding needless chart rerenders.
 */
export function mergeVyProjectionSamples(
  snapshot: VyProjectionSample[], tail: VyProjectionSample[],
): VyProjectionSample[] {
  if (!tail.length) return snapshot;
  const byBlock = new Map(snapshot.map((sample) => [sample.block, sample]));
  let changed = false;
  for (const sample of tail) {
    if (!(sample.block >= 0) || !(sample.ts > 0) || !(sample.price > 0) ||
      !Number.isFinite(sample.price)) continue;
    const old = byBlock.get(sample.block);
    if (!old || old.ts !== sample.ts || old.price !== sample.price || old.pool !== sample.pool) {
      byBlock.set(sample.block, sample);
      changed = true;
    }
  }
  return changed ? [...byBlock.values()].sort((a, b) => a.block - b.block) : snapshot;
}

/**
 * Interpolated projected price at a unix-ms instant. Same semantics as the oracle series: there is
 * deliberately no backfill before the first observation — the VMMO desk did not exist, so neither
 * did the projection — and after the newest observation the last price is held.
 */
export function vyProjectionPriceAt(samples: VyProjectionSample[], ms: number): number {
  if (!samples.length || !Number.isFinite(ms)) return Number.NaN;
  const time = ms / 1_000;
  const first = samples[0];
  if (time < first.ts) return Number.NaN;
  if (time === first.ts) return first.price;
  const last = samples[samples.length - 1];
  if (time >= last.ts) return last.price;

  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (samples[middle].ts <= time) low = middle;
    else high = middle;
  }
  const before = samples[low];
  const after = samples[high];
  if (after.ts <= before.ts) return after.price;
  return before.price + ((time - before.ts) / (after.ts - before.ts)) *
    (after.price - before.price);
}

/**
 * The venue that wins at a unix-ms instant. Stepped, never interpolated: a pool name has no
 * midpoint, so a bar takes the name of the observation in force at its start.
 */
export function vyProjectionPoolAt(samples: VyProjectionSample[], ms: number): string | null {
  if (!samples.length || !Number.isFinite(ms)) return null;
  const time = ms / 1_000;
  if (time < samples[0].ts) return null;

  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (samples[middle].ts <= time) low = middle;
    else high = middle;
  }
  return time >= samples[high].ts ? samples[high].pool : samples[low].pool;
}

/**
 * LIVE TAIL — the same projection scripts/build-vy-projection-history.mjs commits, recomputed in
 * the browser so the line keeps moving while the page is open.
 *
 * Every VMMO book is spent IN FULL into its own venue — USDC in the UniV2 VY/USDC pair,
 * WBTC/WETH/PAXG in their ValinityDAX pools — along that venue's constant-product curve,
 *
 *     price = spot * (1 + usdIn / depthUsd)**2,   spot = depthUsd / vyReserve,   usdIn = heldUsd
 *
 * and the HIGHEST venue is the number, named. That is f = 1, the last row of `projCurve` in
 * src/pages/Mainnet.tsx, which is exactly what the sheet's "Projected" tile shows — so the tile,
 * the table and this line can never disagree. The release curve never enters here.
 *
 * Marks: a DAX pool's asset leg is valued at the VAO TWAP (`getAssetTwapPrice`), the book at
 * VBSO's `assetUsdPrice`, the same two reads Mainnet.tsx values `reserveAssetUSD` and `heldUsd`
 * with, which is what makes `usdIn / depthUsd` unit-consistent. A mark that reverts (PAXG's thin
 * UniV3 pool does go stale) zeroes its own venue rather than the sample.
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

const VMMO = addresses.ValinityMarketMakerOfficer as Address;
const VBSO = addresses.ValinityBalanceSheetOfficer as Address;
const VAO = addresses.ValinityAcquisitionOfficer as Address; // same address as ValinityAssetOracle.
const DAX = addresses.ValinityDAX as Address;
const PAIR = addresses.VyUsdcPool as Address;
const VY_TOKEN = addresses.ValinityToken as Address;

// Order matters only for readability; it is Mainnet.tsx's TABLE_ASSETS order. USDC is the one venue
// that is not a DAX pool, and the one asset with no VAO TWAP — the sheet marks it at $1.
const TABLE_ASSETS: { sym: string; address: Address; isDaxVenue: boolean }[] = [
  { sym: 'USDC', address: assetAddresses.USDC as Address, isDaxVenue: false },
  { sym: 'WBTC', address: assetAddresses.WBTC as Address, isDaxVenue: true },
  { sym: 'WETH', address: assetAddresses.WETH as Address, isDaxVenue: true },
  { sym: 'PAXG', address: assetAddresses.PAXG as Address, isDaxVenue: true },
];

const MAX_TAIL_SAMPLES = 60;
const OUTPUT_SCALE = 1e12;
/** Round to 12 decimals, the precision the committed file is written at. */
const round12 = (value: number): number => Math.round(value * OUTPUT_SCALE) / OUTPUT_SCALE;

// Batch layout. The timestamp and the pair reserves lead; the rest is sized by the pool count.
const I_TIMESTAMP = 0;
const I_RESERVES = 1;
const I_POOLS = 2;

type CallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: unknown };

interface ProjectionAsset { sym: string; address: Address; isDaxVenue: boolean; decimals: number }

interface Immutables {
  vyIsToken0: boolean;
  assets: ProjectionAsset[];
  daxAssets: ProjectionAsset[];
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
  const assets: ProjectionAsset[] = TABLE_ASSETS.map((t, i) => ({
    ...t, decimals: Number(setup[2 + i]),
  }));
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

/**
 * The projection at one block, from one batch. Mirrors `projCurve` in Mainnet.tsx line for line: a
 * venue is kept only when it has both USD depth and VY to sell, and the winner is the venue whose
 * curve ends highest once its whole book has been spent into it. A block with no usable venue — or
 * with no VMMO desk to read at all — is a gap, never a zero-ammo projection to invent.
 */
async function sampleAt(
  client: PublicClient, block: number, one: Immutables,
): Promise<VyProjectionSample | null> {
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

    const reserves = value(I_RESERVES) as readonly [bigint, bigint, number] | null;
    const vyReserve = reserves ? (one.vyIsToken0 ? reserves[0] : reserves[1]) : 0n;
    const usdcReserve = reserves ? (one.vyIsToken0 ? reserves[1] : reserves[0]) : 0n;

    type Pool = readonly [string, bigint, bigint];
    const pools: Pool[] = [];
    for (let i = I_POOLS; i < one.iBooks; i++) {
      const pool = value(i) as Pool | null;
      if (pool) pools.push(pool);
    }

    const books = one.assets.map((_, i) => value(one.iBooks + i) as readonly [bigint, bigint, bigint] | null);
    if (books.every((book) => book === null)) return null;

    const venues = one.assets.flatMap((t, i) => {
      const book = books[i];
      const held = book ? book[0] : 0n;
      const mark = (value(one.iMarks + i) as bigint | null) ?? 0n; // WAD USD per whole asset.
      const heldUsd = Number((held * mark) / 10n ** BigInt(t.decimals)) / 1e18;

      if (!t.isDaxVenue) {
        return [{
          pool: t.sym,
          depthUsd: Number(usdcReserve) / 1e6,
          vy: Number(vyReserve) / 1e18,
          heldUsd,
        }];
      }
      const pool = pools.find((p) => String(p[0]).toLowerCase() === t.address.toLowerCase());
      if (!pool) return [];
      const spot = (value(one.iTwaps + one.daxAssets.indexOf(t)) as bigint | null) ?? 0n; // VAO TWAP.
      const reserveAssetUsd = spot > 0n
        ? (pool[2] * 10n ** BigInt(18 - t.decimals) * spot) / 10n ** 18n
        : 0n;
      return [{
        pool: t.sym,
        depthUsd: Number(reserveAssetUsd) / 1e18,
        vy: Number(pool[1]) / 1e18,
        heldUsd,
      }];
    }).filter((v) => v.depthUsd > 0 && v.vy > 0);

    if (!venues.length) return null;

    const best = venues
      .map((v) => ({ pool: v.pool, priceUsd: (v.depthUsd / v.vy) * (1 + v.heldUsd / v.depthUsd) ** 2 }))
      .reduce((a, b) => (b.priceUsd > a.priceUsd ? b : a));

    return best.priceUsd > 0 && Number.isFinite(best.priceUsd)
      ? { block, ts: Number(timestamp), price: round12(best.priceUsd), pool: best.pool }
      : null;
  } catch {
    return null;
  }
}

/**
 * Fetch observations after the committed file through the current head. Historical catch-up is kept
 * near the build-time six-hour cadence and capped at 60 calls; the exact head is always included. A
 * venue that cannot be read drops that point so interpolation bridges the gap, and a failure to
 * reach the chain at all returns nothing rather than throwing into the poll.
 */
export async function fetchVyProjectionTail(client: PublicClient): Promise<VyProjectionSample[]> {
  try {
    const [head, one] = await Promise.all([
      client.getBlockNumber().then(Number),
      loadImmutables(client),
    ]);
    if (head <= BUILT_AT_BLOCK) return [];

    const stride = Math.max(SNAPSHOT_STRIDE, Math.ceil((head - BUILT_AT_BLOCK) / MAX_TAIL_SAMPLES));
    const blocks: number[] = [];
    for (let block = BUILT_AT_BLOCK + stride; block < head; block += stride) blocks.push(block);
    blocks.push(head);

    const rows = await Promise.all(blocks.map((block) => sampleAt(client, block, one)));
    return rows.filter((sample): sample is VyProjectionSample => sample !== null);
  } catch {
    return [];
  }
}

/** One fully-validated observation at the current head, for the live poll after catch-up. */
export async function fetchVyProjectionHead(client: PublicClient): Promise<VyProjectionSample | null> {
  try {
    const [head, one] = await Promise.all([
      client.getBlockNumber().then(Number),
      loadImmutables(client),
    ]);
    return await sampleAt(client, head, one);
  } catch {
    return null;
  }
}
