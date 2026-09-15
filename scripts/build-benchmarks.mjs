#!/usr/bin/env node
/**
 * RESERVE-ASSET BENCHMARKS — writes src/data/benchmarks.json.
 *
 * The current-pool chart draws Bitcoin, Ether and gold as if each had been bought at VY's first
 * price in that pool ($0.0691, 13 Apr 2026). They are the three assets the reserve holds, so the
 * lines show how VY has done against simply holding them. This file is their USD price history
 * from Chainlink's on-chain feeds, read at the block of that first trade and every ~4 hours
 * after it, up to the chain head.
 *
 * One `eth_call` per sample: Multicall3 reads all three feeds AND the block's own timestamp in a
 * single call, so every sample is internally consistent and needs no separate block lookup.
 *
 * Each feed is checked against its own on-chain `description()` before anything is sampled, so
 * a wrong address fails loudly instead of quietly charting some other asset.
 *
 * The pool is live, so this is a snapshot as of `builtAtBlock`; src/utils/liveTail.ts reads the
 * same feeds from there to the head at runtime.
 *
 *   node scripts/build-benchmarks.mjs [--rpc <url>] [--out <path>]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STRIDE = 1_200; // ~4 hours of Ethereum blocks
const CONCURRENCY = 12;

// Chainlink USD feeds on Ethereum mainnet.
const FEEDS = [
  { key: 'btc', label: 'BTC', address: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', description: 'BTC / USD' },
  { key: 'eth', label: 'ETH', address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', description: 'ETH / USD' },
  { key: 'xau', label: 'Gold', address: '0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6', description: 'XAU / USD' },
];

const FEED_ABI = parseAbi([
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
]);
const MULTICALL_ABI = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256)']);

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const RPC = arg('--rpc', 'https://api.valinity.io/rpc-proxy');
const OUT = resolve(ROOT, arg('--out', 'src/data/benchmarks.json'));

const client = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 60_000 }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ── The anchor: the current pool's first trade ──────────────────────────────
const vy = JSON.parse(readFileSync(resolve(ROOT, 'src/data/vyHistory.json'), 'utf8'));
const first = vy.trades.find((t) => t.era === 'vy-current');
if (!first) throw new Error('vyHistory.json has no vy-current trades — run build-eth-history.mjs first');

// ── Verify every feed is what it claims to be ───────────────────────────────
const feeds = [];
for (const f of FEEDS) {
  const [description, decimals] = await Promise.all([
    client.readContract({ address: f.address, abi: FEED_ABI, functionName: 'description' }),
    client.readContract({ address: f.address, abi: FEED_ABI, functionName: 'decimals' }),
  ]);
  if (description !== f.description) {
    throw new Error(`${f.address} describes itself as "${description}", expected "${f.description}"`);
  }
  feeds.push({ ...f, decimals });
}

// ── Sample ──────────────────────────────────────────────────────────────────
const head = Number(await client.getBlockNumber());
const blocks = [];
for (let b = first.block; b < head; b += STRIDE) blocks.push(b);
blocks.push(head);
console.log(`sampling ${feeds.map((f) => f.description).join(', ')} at ${blocks.length} blocks ` +
  `(${first.block.toLocaleString('en-US')} → ${head.toLocaleString('en-US')}) ...`);

async function sampleAt(block) {
  for (let i = 0; i < 6; i++) {
    try {
      const [ts, ...rounds] = await client.multicall({
        blockNumber: BigInt(block),
        allowFailure: false,
        contracts: [
          { address: mainnet.contracts.multicall3.address, abi: MULTICALL_ABI, functionName: 'getCurrentBlockTimestamp' },
          ...feeds.map((f) => ({ address: f.address, abi: FEED_ABI, functionName: 'latestRoundData' })),
        ],
      });
      const s = { block, ts: Number(ts) };
      feeds.forEach((f, k) => { s[f.key] = Number(rounds[k][1]) / 10 ** f.decimals; });
      return s;
    } catch { await sleep(400 * 2 ** i); }
  }
  return null;
}

const samples = await mapLimit(blocks, CONCURRENCY, sampleAt);
const missing = samples.filter((s) => !s || feeds.some((f) => !(s[f.key] > 0))).length;
if (missing) throw new Error(`${missing} of ${blocks.length} samples failed — refusing to write a history with holes`);
if (samples[0].ts !== first.ts) throw new Error(`anchor sample ts ${samples[0].ts} != first trade ts ${first.ts}`);

const out = {
  _comment:
    'GENERATED by scripts/build-benchmarks.mjs — do not edit by hand. USD prices of the reserve ' +
    'assets from Chainlink on Ethereum, from the current VY pool\'s first trade to builtAtBlock. ' +
    'The chart rebases each to VY\'s first price so all lines start together.',
  chain: 'ethereum', chainId: 1,
  anchor: { era: 'vy-current', block: first.block, ts: first.ts, tx: first.tx },
  feeds: feeds.map(({ key, label, address, description, decimals }) => ({ key, label, address, description, decimals })),
  stride: STRIDE,
  builtAtBlock: head,
  samples,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));

const d = (ts) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
const a = samples[0], z = samples[samples.length - 1];
console.log(`wrote ${OUT} — ${samples.length} samples, ${d(a.ts)} → ${d(z.ts)}`);
for (const f of feeds) {
  console.log(`  ${f.label.padEnd(4)} $${a[f.key].toFixed(2)} → $${z[f.key].toFixed(2)}  (${((z[f.key] / a[f.key] - 1) * 100).toFixed(1)}%)`);
}
