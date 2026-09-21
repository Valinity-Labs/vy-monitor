import { useEffect, useState } from 'react';
import { createPublicClient, http, parseAbiItem, type Address, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { MAINNET_RPC_URL, RPC_HTTP_OPTS } from '../config';
import { ERAS, VY_META, compareTrades, type Trade } from './priceHistory';
import { fetchBenchmarkTail, type BenchmarkSample } from './benchmarks';
import {
  fetchVyOracleHead, fetchVyOracleTail, mergeVyOracleSamples, type VyOracleSample,
} from './vyOracleHistory';
import {
  fetchVyProjectionHead, fetchVyProjectionTail, mergeVyProjectionSamples, type VyProjectionSample,
} from './vyProjectionHistory';
import {
  fetchVyBuybackHead, fetchVyBuybackTail, mergeVyBuybackSamples, type VyBuybackSample,
} from './vyBuybackHistory';

/**
 * LIVE TAIL — everything the current VY/USDC pool has done since the committed snapshot, kept
 * current while the page is open.
 *
 * src/data/vyHistory.json is a snapshot as of `builtAtBlock`. This hook catches up from there in
 * a handful of round trips — one `getLogs` for the pool's Swap AND Sync events, with any block or
 * sender lookups travelling as JSON-RPC BATCHES — and then polls every 30 seconds for new blocks
 * only. (The first version made a separate request per block and per transaction: 235 round trips
 * for two days of trading, which kept a phone on the snapshot for seconds before the present
 * arrived.)
 *
 * PRICE = THE POOL'S OWN PRICE. Uniswap V2 emits `Sync(reserve0, reserve1)` right before every
 * `Swap`, so each trade is charted at USDC reserve ÷ VY reserve as that trade left them — the
 * price the pool itself quotes, and what the web app reads with getReserves(). What the trade paid
 * on average is kept as `execPrice` for the tape; on a large swap the two differ by several percent.
 *
 * Failure-tolerant throughout: a failed request leaves the page with what it has, and the next
 * poll tries again from the same block.
 */

const SWAP = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
);
const SYNC = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)');

const POLL_MS = 30_000;
/** The tape shows the newest 100 trades; resolving senders further back buys nothing. */
const MAX_SENDER_LOOKUPS = 100;

interface LiveEra { id: string; pool: string; scannedTo: number; live?: boolean; quote: { decimals: number } }

interface PoolLog {
  eventName: 'Swap' | 'Sync';
  args: Record<string, bigint | string | undefined>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
  /** Returned by most current nodes; saves a block lookup per swap. */
  blockTimestamp?: bigint | string;
}

function currentEra(): LiveEra | undefined {
  return (VY_META.eras as unknown as LiveEra[]).find((e) => e.live);
}

/** Swaps from `fromBlock` to the head, and the last block they fully cover. */
async function fetchSince(
  client: PublicClient, era: LiveEra, fromBlock: bigint
): Promise<{ trades: Trade[]; lastBlock: bigint }> {
  const head = await client.getBlockNumber();
  if (fromBlock > head) return { trades: [], lastBlock: fromBlock - 1n };

  const logs = (await client.getLogs({
    address: era.pool as Address,
    events: [SWAP, SYNC],
    fromBlock,
    toBlock: head,
  })) as unknown as PoolLog[];
  logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));

  // Pair every Swap with the reserves it left: the Sync emitted just before it.
  const swaps: { log: PoolLog; r0: bigint; r1: bigint }[] = [];
  let reserves: [bigint, bigint] | undefined;
  for (const l of logs) {
    if (l.eventName === 'Sync') reserves = [l.args.reserve0 as bigint, l.args.reserve1 as bigint];
    else if (reserves) swaps.push({ log: l, r0: reserves[0], r1: reserves[1] });
  }
  if (!swaps.length) return { trades: [], lastBlock: head };

  const times = new Map<bigint, number>();
  const missing = new Set<bigint>();
  for (const { log } of swaps) {
    if (log.blockTimestamp !== undefined) times.set(log.blockNumber, Number(log.blockTimestamp));
    else missing.add(log.blockNumber);
  }
  const txs = [...new Set(swaps.map((s) => s.log.transactionHash))].slice(-MAX_SENDER_LOOKUPS);
  const senders = new Map<string, string>();

  // Both lookups go out together; the batched transport folds each into a single request.
  await Promise.all([
    ...[...missing].map((b) => client.getBlock({ blockNumber: b })
      .then((blk) => { times.set(b, Number(blk.timestamp)); })
      .catch(() => { /* retried on the next poll — see `cut` */ })),
    ...txs.map((h) => client.getTransaction({ hash: h })
      .then((tx) => { if (tx?.from) senders.set(h, tx.from.toLowerCase()); })
      .catch(() => { /* the tape falls back to the swap's recipient */ })),
  ]);

  // A swap whose time could not be read is not dropped: stop just before its block, and the next
  // poll starts there again.
  let cut = head;
  for (const { log } of swaps) if (!times.has(log.blockNumber) && log.blockNumber - 1n < cut) cut = log.blockNumber - 1n;

  const trades: Trade[] = [];
  for (const { log, r0, r1 } of swaps) {
    if (log.blockNumber > cut) continue;
    const { amount0In, amount1In, amount0Out, amount1Out } = log.args as {
      amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint;
    };
    const isBuy = amount1In > 0n && amount0Out > 0n;
    const isSell = amount0In > 0n && amount1Out > 0n;
    if (!isBuy && !isSell) continue;
    const vyRaw = isBuy ? amount0Out : amount0In;
    const quoteRaw = isBuy ? amount1In : amount1Out;
    if (vyRaw === 0n || quoteRaw === 0n || r0 === 0n) continue;

    // token0 is VY (18 decimals); token1 is USDC, so the quote leg is already dollars.
    const qty = Number(vyRaw) / 1e18;
    const usd = Number(quoteRaw) / 10 ** era.quote.decimals;
    trades.push({
      ts: times.get(log.blockNumber) as number,
      price: (Number(r1) / 10 ** era.quote.decimals) / (Number(r0) / 1e18),
      execPrice: usd / qty,
      qty,
      usd,
      address: senders.get(log.transactionHash) ?? String(log.args.to ?? '0x').toLowerCase(),
      txHash: log.transactionHash,
      key: `${log.transactionHash}:${log.logIndex}`,
      seq: Number(log.blockNumber) * 100_000 + log.logIndex,
      era: era.id as Trade['era'],
      side: isBuy ? 'buy' : 'sell',
      explorerUrl: `${ERAS['vy-current'].explorer}/tx/${log.transactionHash}`,
    });
  }
  return { trades: trades.sort(compareTrades), lastBlock: cut };
}

export interface LiveTail {
  /** Swaps on the current pool since the committed snapshot, oldest first. */
  trades: Trade[];
  /** Reserve-asset prices since the committed benchmark snapshot. */
  benchmarks: BenchmarkSample[];
  /** Three-treasury-pool VY/USD median since the committed oracle snapshot. */
  vyOracle: VyOracleSample[];
  vyProjection: VyProjectionSample[];
  vyBuyback: VyBuybackSample[];
  /** The first catch-up has finished (or failed). Until then the page only has the snapshot. */
  settled: boolean;
}

const NONE: LiveTail = {
  trades: [], benchmarks: [], vyOracle: [], vyProjection: [], vyBuyback: [], settled: false,
};

/**
 * Swaps and reserve-asset prices since the snapshots, growing as the pool trades.
 *
 * Returns the SAME object when a poll finds nothing new, so nothing downstream re-renders.
 */
export function useLiveTail(): LiveTail {
  const [tail, setTail] = useState<LiveTail>(NONE);

  useEffect(() => {
    const era = currentEra();
    let active = true;
    let busy = false;
    let first = true;
    let nextBlock = era ? BigInt(era.scannedTo) + 1n : 0n;
    const client = createPublicClient({
      chain: mainnet,
      transport: http(MAINNET_RPC_URL, { ...RPC_HTTP_OPTS, batch: { batchSize: 100 } }),
    }) as PublicClient;

    const load = async () => {
      if (busy) return;
      busy = true;
      const wasFirst = first;
      first = false;
      try {
        const [swaps, bench, oracle, projection, buyback] = await Promise.allSettled([
          era ? fetchSince(client, era, nextBlock) : Promise.resolve({ trades: [] as Trade[], lastBlock: nextBlock - 1n }),
          wasFirst ? fetchBenchmarkTail(client) : Promise.resolve([] as BenchmarkSample[]),
          wasFirst
            ? fetchVyOracleTail(client)
            : fetchVyOracleHead(client).then((sample) => sample ? [sample] : []),
          wasFirst
            ? fetchVyProjectionTail(client)
            : fetchVyProjectionHead(client).then((sample) => sample ? [sample] : []),
          wasFirst
            ? fetchVyBuybackTail(client)
            : fetchVyBuybackHead(client).then((sample) => sample ? [sample] : []),
        ]);
        if (!active) return;
        if (swaps.status === 'fulfilled') nextBlock = swaps.value.lastBlock + 1n;
        setTail((prev) => {
          const fresh = swaps.status === 'fulfilled' ? swaps.value.trades : [];
          const trades = fresh.length ? [...prev.trades, ...fresh] : prev.trades;
          const benchmarks = bench.status === 'fulfilled' && bench.value.length ? bench.value : prev.benchmarks;
          const vyOracle = oracle.status === 'fulfilled'
            ? mergeVyOracleSamples(prev.vyOracle, oracle.value)
            : prev.vyOracle;
          const vyProjection = projection.status === 'fulfilled'
            ? mergeVyProjectionSamples(prev.vyProjection, projection.value)
            : prev.vyProjection;
          const vyBuyback = buyback.status === 'fulfilled'
            ? mergeVyBuybackSamples(prev.vyBuyback, buyback.value)
            : prev.vyBuyback;
          const settled = prev.settled || wasFirst;
          return trades === prev.trades && benchmarks === prev.benchmarks &&
            vyOracle === prev.vyOracle && vyProjection === prev.vyProjection &&
            vyBuyback === prev.vyBuyback && settled === prev.settled
            ? prev
            : { trades, benchmarks, vyOracle, vyProjection, vyBuyback, settled };
        });
      } finally {
        busy = false;
      }
    };

    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, []);

  return tail;
}
