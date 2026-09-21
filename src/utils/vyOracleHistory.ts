import { parseAbi, type Address, type ContractFunctionParameters, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import history from '../data/vyOracleHistory.json';

/** One observation of the median VY/USD price across the WETH, WBTC and PAXG treasury routes. */
export interface VyOracleSample {
  block: number;
  /** Unix time in seconds. */
  ts: number;
  /** USD per one whole VY. */
  price: number;
}

interface VyOracleHistoryFile {
  builtAtBlock: number;
  oracle: { address: string; deploymentBlock: number };
  stride: number;
  samples: VyOracleSample[];
}

const committed = history as VyOracleHistoryFile;

/** Build-time history committed with the app, oldest first. */
export const VY_ORACLE_SNAPSHOT: VyOracleSample[] = committed.samples;

const ORACLE_ADDRESS = committed.oracle.address as Address;
const BUILT_AT_BLOCK = committed.builtAtBlock;
const SNAPSHOT_STRIDE = committed.stride;

/**
 * Merge snapshots by block, preferring a tail observation if a block overlaps. The original
 * snapshot object is retained when the tail adds nothing, avoiding needless chart rerenders.
 */
export function mergeVyOracleSamples(
  snapshot: VyOracleSample[], tail: VyOracleSample[],
): VyOracleSample[] {
  if (!tail.length) return snapshot;
  const byBlock = new Map(snapshot.map((sample) => [sample.block, sample]));
  let changed = false;
  for (const sample of tail) {
    if (!(sample.block >= 0) || !(sample.ts > 0) || !(sample.price > 0) ||
      !Number.isFinite(sample.price)) continue;
    const old = byBlock.get(sample.block);
    if (!old || old.ts !== sample.ts || old.price !== sample.price) {
      byBlock.set(sample.block, sample);
      changed = true;
    }
  }
  return changed ? [...byBlock.values()].sort((a, b) => a.block - b.block) : snapshot;
}

/**
 * Interpolated oracle price at a unix-ms instant. There is deliberately no backfill before the
 * contract's first valid observation; after the newest observation the last price is held.
 */
export function vyOraclePriceAt(samples: VyOracleSample[], ms: number): number {
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

const ORACLE_ABI = parseAbi([
  'function vyPerUsdcExDirectX112() view returns (uint256)',
  'function legPricesX112() view returns (uint256,uint256,uint256,uint256)',
]);
const MULTICALL_ABI = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256)']);
const Q112 = 1n << 112n;
const TOKEN_DECIMAL_ADJUSTMENT = 10n ** 12n;
const OUTPUT_SCALE = 10n ** 12n;
const MAX_TAIL_SAMPLES = 60;

function median3(a: bigint, b: bigint, c: bigint): bigint {
  return [a, b, c].sort((x, y) => x < y ? -1 : x > y ? 1 : 0)[1];
}

function usdPerVy(encoded: bigint): number {
  if (encoded <= 0n) return Number.NaN;
  const scaled = (Q112 * TOKEN_DECIMAL_ADJUSTMENT * OUTPUT_SCALE + encoded / 2n) / encoded;
  return Number(scaled) / Number(OUTPUT_SCALE);
}

async function sampleAt(client: PublicClient, block: number): Promise<VyOracleSample | null> {
  try {
    const [timestamp, aggregate, legs] = (await client.multicall({
      blockNumber: BigInt(block),
      allowFailure: false,
      contracts: [
        {
          address: mainnet.contracts.multicall3.address,
          abi: MULTICALL_ABI,
          functionName: 'getCurrentBlockTimestamp',
        },
        { address: ORACLE_ADDRESS, abi: ORACLE_ABI, functionName: 'vyPerUsdcExDirectX112' },
        { address: ORACLE_ADDRESS, abi: ORACLE_ABI, functionName: 'legPricesX112' },
      ] as ContractFunctionParameters[],
    })) as unknown as [bigint, bigint, readonly [bigint, bigint, bigint, bigint]];

    const [, weth, wbtc, paxg] = legs;
    if (weth === 0n || wbtc === 0n || paxg === 0n) return null;
    const median = median3(weth, wbtc, paxg);
    if (aggregate === 0n || aggregate !== median) return null;
    const price = usdPerVy(aggregate);
    return price > 0 && Number.isFinite(price)
      ? { block, ts: Number(timestamp), price }
      : null;
  } catch {
    return null;
  }
}

/**
 * Fetch observations after the committed file through the current head. Historical catch-up is
 * kept near the build-time four-hour cadence and capped at 60 calls; the exact head is always
 * included. A failed treasury leg drops that point so interpolation bridges the gap.
 */
export async function fetchVyOracleTail(client: PublicClient): Promise<VyOracleSample[]> {
  const head = Number(await client.getBlockNumber());
  if (head <= BUILT_AT_BLOCK) return [];

  const stride = Math.max(SNAPSHOT_STRIDE, Math.ceil((head - BUILT_AT_BLOCK) / MAX_TAIL_SAMPLES));
  const blocks: number[] = [];
  for (let block = BUILT_AT_BLOCK + stride; block < head; block += stride) blocks.push(block);
  blocks.push(head);

  const rows = await Promise.all(blocks.map((block) => sampleAt(client, block)));
  return rows.filter((sample): sample is VyOracleSample => sample !== null);
}

/** One fully-validated observation at the current head, for the live poll after catch-up. */
export async function fetchVyOracleHead(client: PublicClient): Promise<VyOracleSample | null> {
  const head = Number(await client.getBlockNumber());
  return sampleAt(client, head);
}
