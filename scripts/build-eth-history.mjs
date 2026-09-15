#!/usr/bin/env node
/**
 * ETHEREUM VY PRICE HISTORY — writes src/data/vyHistory.json.
 *
 * After the MFC era on BNB Chain, Valinity moved to Ethereum. There have been TWO pools:
 *
 *   vy-legacy   VY 0x40e5a14e   Uniswap V2 VY/WETH   0x18a5734A   Apr 2024 → Dec 2025 (closed)
 *   vy-current  VY 0x597b2952   Uniswap V2 VY/USDC   0xf96cCac0   Apr 2026 → live
 *
 * Both are read the same way — every `Swap` becomes one executed trade, in the same shape the
 * MFC builder produces — so the chart and tape treat every era in Valinity's life identically.
 *
 * PRICE BASIS. Executed trade prices, never the reserve mid: what the swap actually paid.
 * (The reserve mid at each `Sync` is what DexScreener plots, but the MFC eras have no reserves,
 * and mixing bases across a spliced lifetime chart would make the seams meaningless.)
 *
 * USD. The current pool quotes in USDC and is already dollars. The legacy pool quotes in ETH,
 * so USD comes from Chainlink's on-chain ETH/USD feed sampled roughly daily and interpolated to
 * each swap's block — as trustless as the pool read, and ~600 calls instead of thousands. It is
 * the mark that applied AT THE TIME, not today's ETH price.
 *
 * THE LEGACY CUTOFF. Liquidity was pulled from the legacy pool in two burns on 2025-12-20
 * (21:05 and 21:26 UTC, -406,803 VY / -47.3 WETH together), emptying it. Afterwards it holds
 * dust and its implied "price" is division by a rounding error, swinging orders of magnitude on
 * trades worth cents. History stops at the first burn: past that block it is not a market.
 *
 * THE CURRENT ERA IS LIVE, so this file is a snapshot as of the block it was built at. Re-run
 * to refresh; `scannedTo` in the output records exactly how current it is.
 *
 *   node scripts/build-eth-history.mjs [--rpc <url>] [--out <path>] [--era <id>]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const ETH_SAMPLE_STRIDE = 7_200; // ~1 day of Ethereum blocks
const CONCURRENCY = 20;

const ERAS = [
  {
    id: 'vy-legacy',
    label: 'VY (Uniswap V2, WETH)',
    token: '0x40e5a14e1d151f34fea6b8e6197c338e737f9bf2',
    pool: '0x18a5734Ae2cf886E705f4a8Ef4aF092c80Bb1aeC',
    created: 19_571_733, // 2024-04-03 00:40 UTC
    cutoffBlock: 24_056_383, // first of the two burns that emptied the pool, 2025-12-20 21:05
    cutoffReason: 'liquidity removed 2025-12-20 21:05 UTC (block 24,056,383); pool holds dust afterwards',
    quote: { symbol: 'WETH', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18, usd: 'chainlink' },
  },
  {
    id: 'vy-current',
    label: 'VY (Uniswap V2, USDC)',
    token: '0x597b29520098d6aaca3b2e0d1a380315c9240454',
    pool: '0xf96cCac0bfd5de8d1F69EA9F9f43ed3B174c2705',
    created: 24_867_746, // 2026-04-13 02:05 UTC
    cutoffBlock: null, // live — runs to the chain head at build time
    cutoffReason: null,
    quote: { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, usd: 'stable' },
  },
];

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const RPC = arg('--rpc', 'https://api.valinity.io/rpc-proxy');
const OUT = resolve(ROOT, arg('--out', 'src/data/vyHistory.json'));
const ONLY = arg('--era', null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 6) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(180_000),
      });
      const j = await res.json();
      if (j.result !== undefined && j.result !== null) return j.result;
    } catch { /* retried */ }
    await sleep(400 * 2 ** Math.min(i, 4));
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const words = (data) => {
  const hex = data.slice(2); const out = [];
  for (let i = 0; i < hex.length; i += 64) out.push(BigInt('0x' + hex.slice(i, i + 64)));
  return out;
};

/** A block -> ETH/USD lookup, sampled across [from, to] and linearly interpolated. */
async function ethUsdSeries(from, to) {
  const blocks = [];
  for (let b = from; b <= to; b += ETH_SAMPLE_STRIDE) blocks.push(b);
  if (blocks[blocks.length - 1] !== to) blocks.push(to);
  console.log(`  sampling Chainlink ETH/USD at ${blocks.length} blocks ...`);
  const samples = (await mapLimit(blocks, CONCURRENCY, async (b) => {
    // latestRoundData() -> (roundId, answer, startedAt, updatedAt, answeredInRound); answer 8dp.
    const r = await rpc('eth_call', [{ to: CHAINLINK_ETH_USD, data: '0xfeaf968c' }, '0x' + b.toString(16)]);
    if (!r || r.length <= 2) return null;
    return { block: b, usd: Number(BigInt('0x' + r.slice(2).slice(64, 128))) / 1e8 };
  })).filter((s) => s && s.usd > 0);
  if (samples.length < 2) throw new Error('could not read an ETH/USD series — refusing to guess');
  console.log(`    ${samples.length} samples, $${samples[0].usd.toFixed(0)} -> $${samples[samples.length - 1].usd.toFixed(0)}`);
  return (block) => {
    if (block <= samples[0].block) return samples[0].usd;
    const last = samples[samples.length - 1];
    if (block >= last.block) return last.usd;
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid].block <= block) lo = mid; else hi = mid; }
    const a = samples[lo], b = samples[hi];
    return a.usd + ((block - a.block) / (b.block - a.block)) * (b.usd - a.usd);
  };
}

async function buildEra(era, head) {
  const to = era.cutoffBlock ? era.cutoffBlock - 1 : head;
  console.log(`[${era.id}] Swap logs ${era.created.toLocaleString('en-US')} -> ${to.toLocaleString('en-US')} ...`);
  const raw = await rpc('eth_getLogs', [{
    address: era.pool, topics: [SWAP_TOPIC],
    fromBlock: '0x' + era.created.toString(16), toBlock: '0x' + to.toString(16),
  }]);
  if (!Array.isArray(raw)) throw new Error(`[${era.id}] eth_getLogs failed`);
  console.log(`  ${raw.length.toLocaleString('en-US')} swaps`);

  const ethUsdAt = era.quote.usd === 'chainlink' ? await ethUsdSeries(era.created, to) : null;

  // A Swap's `sender`/`to` are usually a router or aggregator, not a person. The tape promises
  // "the address that made this transaction", so that has to be tx.from.
  const uniqueTx = [...new Set(raw.map((l) => l.transactionHash))];
  console.log(`  resolving ${uniqueTx.length.toLocaleString('en-US')} transaction senders ...`);
  const senders = new Map();
  await mapLimit(uniqueTx, CONCURRENCY, async (h) => {
    const tx = await rpc('eth_getTransactionByHash', [h]);
    if (tx?.from) senders.set(h, tx.from.toLowerCase());
  });

  const trades = [];
  let skipped = 0;
  for (const l of raw) {
    const [a0In, a1In, a0Out, a1Out] = words(l.data);
    const isBuy = a1In > 0n && a0Out > 0n;   // quote in, VY out
    const isSell = a0In > 0n && a1Out > 0n;  // VY in, quote out
    if (!isBuy && !isSell) { skipped++; continue; }
    const vy = isBuy ? a0Out : a0In;
    const quote = isBuy ? a1In : a1Out;
    if (vy === 0n || quote === 0n) { skipped++; continue; }
    const block = Number(l.blockNumber);
    trades.push({
      era: era.id, block,
      ts: Number(BigInt(l.blockTimestamp)),
      tx: l.transactionHash,
      logIndex: Number(l.logIndex),
      side: isBuy ? 'buy' : 'sell',
      maker: senders.get(l.transactionHash) ?? ('0x' + l.topics[2].slice(-40)),
      vy: vy.toString(),
      quote: quote.toString(),
      // 1 for a stablecoin quote; the ETH/USD mark at this block otherwise.
      quoteUsd: ethUsdAt ? Number(ethUsdAt(block).toFixed(2)) : 1,
    });
  }
  trades.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  if (skipped) console.log(`  skipped ${skipped} degenerate swap(s)`);
  return { trades, scannedTo: to };
}

// -- Main --------------------------------------------------------------------
const head = Number(await rpc('eth_blockNumber', []));
if (!Number.isFinite(head)) throw new Error('could not read chain head');

const eras = [];
const allTrades = [];
for (const era of ERAS) {
  if (ONLY && era.id !== ONLY) continue;
  const { trades, scannedTo } = await buildEra(era, head);
  const priceOf = (t) =>
    (Number(t.quote) / 10 ** era.quote.decimals) / (Number(t.vy) / 1e18) * t.quoteUsd;
  const px = trades.map(priceOf);
  eras.push({
    id: era.id, label: era.label, token: era.token, pool: era.pool,
    quote: era.quote, decimals: 18,
    scannedFrom: era.created, scannedTo,
    live: era.cutoffBlock === null,
    cutoffReason: era.cutoffReason,
    tradeCount: trades.length,
    firstTs: trades[0]?.ts ?? null, lastTs: trades[trades.length - 1]?.ts ?? null,
    minPrice: px.length ? Math.min(...px) : null,
    maxPrice: px.length ? Math.max(...px) : null,
  });
  allTrades.push(...trades);
  const d = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '-');
  console.log(`[${era.id}] ${trades.length} trades  ${d(trades[0]?.ts)} -> ${d(trades[trades.length - 1]?.ts)}` +
    (px.length ? `  $${Math.min(...px).toFixed(4)} .. $${Math.max(...px).toFixed(4)}  (first $${px[0].toFixed(4)}, last $${px[px.length - 1].toFixed(4)})` : ''));
}
allTrades.sort((a, b) => a.ts - b.ts || a.block - b.block || a.logIndex - b.logIndex);
if (!allTrades.length) throw new Error('no swaps decoded — refusing to write empty history');

const out = {
  _comment:
    'GENERATED by scripts/build-eth-history.mjs — do not edit by hand. Valinity on Ethereum: the ' +
    'legacy VY/WETH pool and the current, LIVE VY/USDC pool. Prices are per-swap execution ' +
    'prices; the legacy era converts ETH->USD with an interpolated Chainlink series.',
  chain: 'ethereum', chainId: 1, symbol: 'VY',
  builtAtBlock: head,
  eras,
  tradeCount: allTrades.length,
  trades: allTrades,
};
mkdirSync(dirname(OUT), { recursive: true });
// Pretty-printed on purpose. Vite parses JSON imports into JS objects, so this file's
// whitespace never reaches the bundle — it costs nothing shipped, and one line per
// field keeps `git diff` on a regenerated history readable instead of one huge line.
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\nwrote ${OUT} — ${allTrades.length} trades across ${eras.length} era(s), head ${head.toLocaleString('en-US')}`);
