import { useEffect, useState } from 'react';
import { createPublicClient, http, parseAbiItem, type Address, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { MAINNET_RPC_URL, RPC_HTTP_OPTS } from '../config';
import { ERAS, VY_META, type Trade } from './priceHistory';
import { fetchBenchmarkTail, type BenchmarkSample } from './benchmarks';

/**
 * LIVE TAIL — the swaps that happened after the committed snapshot was built.
 *
 * src/data/vyHistory.json is generated at build time, so the current VY/USDC pool is only
 * current as of `builtAtBlock`. Everything before that ships in the bundle and paints on the
 * first frame; this hook fetches only the blocks SINCE, so the chart reaches the present without
 * the page waiting on a network round trip to draw anything at all.
 *
 * It is deliberately small and failure-tolerant: one `getLogs` over a narrow range, and if
 * anything goes wrong the component keeps the snapshot and simply stops a little short of now.
 * A stale-by-hours chart is a much better outcome than a blank one.
 *
 * The reserve-asset prices drawn over the current pool (src/utils/benchmarks.ts) are extended
 * here too, on the FIRST load only and in the same state update as the swaps — so the chart is
 * rebuilt once for both, not once per source.
 */

const SWAP = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
);

/** Resolving tx.from is one call per transaction — worth it for a handful, not for thousands. */
const MAX_SENDER_LOOKUPS = 150;

interface LiveEra { id: string; pool: string; scannedTo: number; live?: boolean; quote: { decimals: number } }

function currentEra(): LiveEra | undefined {
  return (VY_META.eras as unknown as LiveEra[]).find((e) => e.live);
}

async function fetchTail(client: PublicClient, era: LiveEra): Promise<Trade[]> {
  const head = await client.getBlockNumber();
  const from = BigInt(era.scannedTo) + 1n;
  if (from > head) return [];

  const logs = await client.getLogs({
    address: era.pool as Address,
    event: SWAP,
    fromBlock: from,
    toBlock: head,
  });
  if (!logs.length) return [];

  // Block timestamps: one call per distinct block, which for a tail is a handful.
  const blocks = [...new Set(logs.map((l) => l.blockNumber))];
  const times = new Map<bigint, number>();
  await Promise.all(blocks.map(async (b) => {
    try {
      const blk = await client.getBlock({ blockNumber: b });
      times.set(b, Number(blk.timestamp));
    } catch { /* a missing timestamp drops that swap below */ }
  }));

  // `sender`/`to` on a Swap are usually a router; the tape promises the actual sender.
  const txs = [...new Set(logs.map((l) => l.transactionHash))];
  const senders = new Map<string, string>();
  if (txs.length <= MAX_SENDER_LOOKUPS) {
    await Promise.all(txs.map(async (h) => {
      try {
        const tx = await client.getTransaction({ hash: h });
        if (tx?.from) senders.set(h, tx.from.toLowerCase());
      } catch { /* falls back to the log's `to` */ }
    }));
  }

  const out: Trade[] = [];
  for (const l of logs) {
    const ts = times.get(l.blockNumber);
    if (ts === undefined || l.transactionHash === null || l.logIndex === null) continue;
    const { amount0In, amount1In, amount0Out, amount1Out } = l.args as {
      amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint;
    };
    const isBuy = amount1In > 0n && amount0Out > 0n;
    const isSell = amount0In > 0n && amount1Out > 0n;
    if (!isBuy && !isSell) continue;
    const vyRaw = isBuy ? amount0Out : amount0In;
    const quoteRaw = isBuy ? amount1In : amount1Out;
    if (vyRaw === 0n || quoteRaw === 0n) continue;

    const qty = Number(vyRaw) / 1e18;
    // The live pool quotes in USDC, so the quote leg is already dollars.
    const usd = Number(quoteRaw) / 10 ** era.quote.decimals;
    out.push({
      ts,
      price: usd / qty,
      qty,
      usd,
      address: senders.get(l.transactionHash) ?? (l.args as { to?: string }).to?.toLowerCase() ?? '0x',
      txHash: l.transactionHash,
      key: `${l.transactionHash}:${l.logIndex}`,
      era: era.id as Trade['era'],
      side: isBuy ? 'buy' : 'sell',
      explorerUrl: `${ERAS['vy-current'].explorer}/tx/${l.transactionHash}`,
    });
  }
  return out.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
}

export interface LiveTail {
  /** Swaps on the current pool since the committed snapshot. */
  trades: Trade[];
  /** Reserve-asset prices since the committed benchmark snapshot. */
  benchmarks: BenchmarkSample[];
}

const NONE: LiveTail = { trades: [], benchmarks: [] };

/** Every poll re-reads the whole tail, so "changed" has to be decided by content, not identity. */
const sameTrades = (a: Trade[], b: Trade[]) =>
  a.length === b.length && a[a.length - 1]?.key === b[b.length - 1]?.key;

/**
 * Swaps and reserve-asset prices since the snapshots. Empty until (and unless) they load, so
 * callers render the committed history immediately and treat the tail as an enhancement.
 *
 * Returns the SAME object when a poll finds nothing new. Without that, each poll would hand back
 * a fresh but identical array and the chart would be torn down — losing the viewer's zoom —
 * every two minutes.
 */
export function useLiveTail(): LiveTail {
  const [tail, setTail] = useState<LiveTail>(NONE);

  useEffect(() => {
    const era = currentEra();
    let active = true;
    let firstLoad = true;
    const client = createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC_URL, RPC_HTTP_OPTS) }) as PublicClient;

    const load = async () => {
      const withBenchmarks = firstLoad;
      firstLoad = false;
      const [swaps, bench] = await Promise.allSettled([
        era ? fetchTail(client, era) : Promise.resolve([]),
        withBenchmarks ? fetchBenchmarkTail(client) : Promise.resolve([]),
      ]);
      if (!active) return;
      setTail((prev) => {
        const fresh = swaps.status === 'fulfilled' ? swaps.value : [];
        const trades = fresh.length && !sameTrades(prev.trades, fresh) ? fresh : prev.trades;
        const benchmarks = bench.status === 'fulfilled' && bench.value.length ? bench.value : prev.benchmarks;
        return trades === prev.trades && benchmarks === prev.benchmarks ? prev : { trades, benchmarks };
      });
    };
    void load();
    // The pool trades a few times a day, so this is about staying fresh in a tab left open,
    // not about tick-by-tick streaming.
    const timer = setInterval(() => void load(), 120_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  return tail;
}
