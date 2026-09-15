import { parseAbi, type Address, type ContractFunctionParameters, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import benchmarks from '../data/benchmarks.json';

/**
 * RESERVE-ASSET BENCHMARKS — Bitcoin, Ether and gold, drawn over the current pool's candles as
 * if the same money had bought each of them instead of VY.
 *
 * They are the three assets the reserve holds, so the lines answer the obvious question: how has
 * VY done against simply holding them? Every line starts at the pool's first trade ($0.0691 on
 * 13 Apr 2026) and then moves by exactly its asset's own USD return — a 7% rise in BTC puts the
 * BTC line 7% above $0.0691.
 *
 * Prices are Chainlink's on-chain USD feeds, committed by scripts/build-benchmarks.mjs and
 * extended past that snapshot at runtime by `fetchBenchmarkTail`.
 */

export type BenchmarkKey = 'btc' | 'eth' | 'xau';

export interface BenchmarkSample { block: number; ts: number; btc: number; eth: number; xau: number }

interface Feed { key: BenchmarkKey; address: string; decimals: number }

// Line colours, one per theme. Mirrored in App.css (--vy-bench-*) for the key above the chart.
export const BENCHMARKS: { key: BenchmarkKey; label: string; color: string; colorLight: string }[] = [
  { key: 'btc', label: 'BTC', color: '#F7931A', colorLight: '#F7931A' },
  { key: 'eth', label: 'ETH', color: '#A3A3A3', colorLight: '#737373' },
  { key: 'xau', label: 'Gold', color: '#FFD60A', colorLight: '#D4A106' },
];

const FEEDS = benchmarks.feeds as Feed[];
const BUILT_AT_BLOCK = benchmarks.builtAtBlock;
export const BENCHMARK_SNAPSHOT: BenchmarkSample[] = benchmarks.samples;

/** A feed's USD price at a unix-ms instant: linear between samples, clamped at both ends. */
function priceAt(samples: BenchmarkSample[], key: BenchmarkKey, ms: number): number {
  const t = ms / 1000;
  if (t <= samples[0].ts) return samples[0][key];
  const last = samples[samples.length - 1];
  if (t >= last.ts) return last[key];
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].ts <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  return a[key] + ((t - a.ts) / (b.ts - a.ts)) * (b[key] - a[key]);
}

/**
 * `key`'s path in VY's units: what `anchor.price` dollars put into the asset at `anchor.ts` would
 * be worth at any later instant. Equal to `anchor.price` at the anchor by construction.
 */
export function rebased(
  samples: BenchmarkSample[], key: BenchmarkKey, anchor: { ts: number; price: number }
): (ms: number) => number {
  const base = priceAt(samples, key, anchor.ts * 1000);
  return (ms) => (anchor.price * priceAt(samples, key, ms)) / base;
}

/** The committed samples plus any read since, oldest first. Same array when nothing is new. */
export function mergeSamples(snapshot: BenchmarkSample[], tail: BenchmarkSample[]): BenchmarkSample[] {
  const lastBlock = snapshot[snapshot.length - 1]?.block ?? -1;
  const fresh = tail.filter((s) => s.block > lastBlock);
  return fresh.length ? [...snapshot, ...fresh] : snapshot;
}

// ── Runtime tail ────────────────────────────────────────────────────────────

const FEED_ABI = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const MULTICALL_ABI = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256)']);

const DAY_BLOCKS = 7_200;
/** However stale the snapshot, a page load never makes more than this many calls for it. */
const MAX_TAIL_SAMPLES = 60;

/**
 * Feed prices from the snapshot's last block to the head: about one per day, plus the head
 * itself. One `eth_call` each — Multicall3 reads the three feeds and the block's timestamp
 * together. Samples that fail are dropped; the lines interpolate across the gap.
 */
export async function fetchBenchmarkTail(client: PublicClient): Promise<BenchmarkSample[]> {
  const head = Number(await client.getBlockNumber());
  if (head <= BUILT_AT_BLOCK) return [];
  const stride = Math.max(DAY_BLOCKS, Math.ceil((head - BUILT_AT_BLOCK) / MAX_TAIL_SAMPLES));
  const blocks: number[] = [];
  for (let b = BUILT_AT_BLOCK + stride; b < head; b += stride) blocks.push(b);
  blocks.push(head);

  const rows = await Promise.all(blocks.map(async (block): Promise<BenchmarkSample | null> => {
    try {
      const [ts, ...rounds] = (await client.multicall({
        blockNumber: BigInt(block),
        allowFailure: false,
        contracts: [
          { address: mainnet.contracts.multicall3.address, abi: MULTICALL_ABI, functionName: 'getCurrentBlockTimestamp' },
          ...FEEDS.map((f) => ({ address: f.address as Address, abi: FEED_ABI, functionName: 'latestRoundData' })),
        ] as ContractFunctionParameters[],
      })) as unknown as [bigint, ...(readonly [bigint, bigint, bigint, bigint, bigint])[]];
      const s: BenchmarkSample = { block, ts: Number(ts), btc: 0, eth: 0, xau: 0 };
      FEEDS.forEach((f, i) => { s[f.key] = Number(rounds[i][1]) / 10 ** f.decimals; });
      return FEEDS.every((f) => s[f.key] > 0) ? s : null;
    } catch {
      return null;
    }
  }));
  return rows.filter((s): s is BenchmarkSample => s !== null);
}
