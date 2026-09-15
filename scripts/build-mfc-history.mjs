#!/usr/bin/env node
/**
 * MFC (BNB CHAIN) PRICE HISTORY BUILDER — writes src/data/mfcHistory.json.
 *
 * MFC — "My Freedom Coin" — is the first Valinity-lineage asset. It ran through FOUR token
 * contracts on BNB Chain and never once had a liquidity pool: verified against PancakeSwap V1
 * and V2, Biswap and ApeSwap for BUSD, USDT, WBNB and USDC pairs, no pair was ever created.
 * Every price it ever printed came from an on-chain OTC order book, one per token:
 *
 *   CreateOffer(offerId, ...)                            a priced tranche is listed
 *   TradeOffer(offerId, buyer, mfcAmt, busdAmt, _, ts)   A FILL — the price print
 *   CloseOffer(offerId, ...)                             the tranche is closed
 *
 * PRICE = busdAmt / mfcAmt. Each fill charges a symmetric 2% fee on both legs, so the gross and
 * net-of-fee ratios agree to ~10 decimals — the price is the same number either way. BUSD is a
 * dollar stablecoin, so it is already USD; no FX needed. Each event also carries its own
 * timestamp, so no block-timestamp lookups are needed either.
 *
 * The token/exchange pairings below were established by on-chain discovery, not assumption:
 * the deployer's contracts were enumerated by nonce, then each exchange was matched to its
 * token by which contract actually holds inventory of which token.
 *
 * WHY BUILD-TIME. These eras are closed and immutable, and the scan is thousands of wide
 * getLogs against a BSC archive node — far too slow for a page load, and BSC is not otherwise
 * part of this app's infrastructure. Scanning once and committing the result means the shipped
 * monitor needs no BSC RPC at all.
 *
 *   node scripts/build-mfc-history.mjs [--rpc <url>] [--out <path>] [--era <id>]
 *
 * The cache under .cache/mfc/<era>/ stores EXPLICIT scanned ranges ("lo hi" per line) rather
 * than chunk indices, so correcting a start block re-scans only the newly exposed blocks
 * instead of invalidating everything.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TOPIC = {
  trade: '0x2c3dde900e24e531af912d8d496ff68b3c98ad86f9f20f9ad833da66f143b5e5',
  create: '0x923290180b01ce184543bf950ceaa6ae1084176cc3cbaf1cf1cc947955f239f0',
  close: '0x37a30d6e3fcaec3144b11d51892b9eadbb0ec4d2a8a813d64bb6065c3adfcffa',
};
const BUSD = '0xe9e7cea3dedca5984780bafc599bd69add087d56';

/**
 * `from` values are the CREATION BLOCK of each exchange, confirmed by locating the creation
 * transaction (the `to: null` tx whose receipt names the contract) — not by an eth_getCode
 * binary search, which returned a block 153 too late for v1 on one public archive endpoint.
 *
 * `to` bounds each scan well past that era's last observed activity, so "no trades after" is
 * a measured fact rather than an assumption.
 */
const ERAS = [
  {
    id: 'mfc-v1', label: 'MFC v1', token: '0xc47fb4da534fb35bee9d0ec19ec17c284ab96c23',
    exchange: '0x666c4a79d4407891574d1E542d5F60ed923E203f', from: 13_301_807, to: 28_589_959,
  },
  {
    id: 'mfc-v2', label: 'MFC v2', token: '0x8ce7915c9892310362f0dd8b319aba7169e37d13',
    exchange: '0x6592A2CDeCdb31f56EaffD6167F7F28036a2aE10', from: 17_552_549, to: 19_414_548,
    // Nine days old and superseded by v3. Its book took exactly one fill: $10 at $0.000076,
    // a deployment test. Kept in the data for completeness, excluded from the chart, because
    // one test print would otherwise open a candle three orders of magnitude off the market.
    excluded: true,
    excludedReason: 'single $10 test fill at $0.000076; superseded by v3 after nine days',
  },
  {
    id: 'mfc-v3', label: 'MFC v3', token: '0xf621058a76f085660e3ffab5ebd2430a3656524d',
    exchange: '0xCf6c50dC995c95Cc7C04dFeeF4Cd15CDFA5A5aa7', from: 17_801_304, to: 19_712_303,
  },
  {
    id: 'mfc-v4', label: 'MFC v4 (My Freedom Coin)', token: '0xb34ac1d882d3d4cd1d4ae2b5951b816bc5817ba5',
    exchange: '0xfa127212ecF509be945f6c18f419Db045dFD41fd', from: 22_295_528, to: 45_000_000,
  },
];

// NodeReal's public BSC archive endpoint — the only free one found that is BOTH archive-capable
// and accepts a 50k-block getLogs window (Binance dataseeds are pruned; drpc caps at 10k).
// Its daily quota is small; pass --rpc for a private node and this gets much faster.
const DEFAULT_RPC = 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3';
const CHUNK = 49_000;
const CONCURRENCY = 4;

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const RPC = arg('--rpc', DEFAULT_RPC);
const OUT = resolve(ROOT, arg('--out', 'src/data/mfcHistory.json'));
const ONLY = arg('--era', null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 8) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(90_000),
      });
      const j = await res.json();
      if (j.result !== undefined && j.result !== null) return j.result;
    } catch { /* retried */ }
    await sleep(500 * 2 ** Math.min(i, 5));
  }
  return null;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; await fn(items[i]); }
  }));
}

/** Ranges already scanned, as [lo, hi] pairs, merged and sorted. */
function readCovered(file) {
  if (!existsSync(file)) return [];
  const rs = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => l.split(/\s+/).map(Number)).filter((r) => r.length === 2 && r.every(Number.isFinite))
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [lo, hi] of rs) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}

/** The parts of [from, to] not yet covered, split into CHUNK-sized pieces. */
function outstanding(from, to, covered) {
  const gaps = [];
  let cursor = from;
  for (const [lo, hi] of covered) {
    if (hi < cursor) continue;
    if (lo > cursor) gaps.push([cursor, Math.min(lo - 1, to)]);
    cursor = Math.max(cursor, hi + 1);
    if (cursor > to) break;
  }
  if (cursor <= to) gaps.push([cursor, to]);
  const chunks = [];
  for (const [lo, hi] of gaps) {
    for (let b = lo; b <= hi; b += CHUNK) chunks.push([b, Math.min(b + CHUNK - 1, hi)]);
  }
  return chunks;
}

const words = (data) => {
  const hex = data.slice(2); const out = [];
  for (let i = 0; i < hex.length; i += 64) out.push(BigInt('0x' + hex.slice(i, i + 64)));
  return out;
};

async function buildEra(era) {
  const dir = `${ROOT}/.cache/mfc/${era.id}`;
  mkdirSync(dir, { recursive: true });
  const logsFile = `${dir}/logs.jsonl`;
  const doneFile = `${dir}/covered.txt`;

  const todo = outstanding(era.from, era.to, readCovered(doneFile));
  if (todo.length) {
    console.log(`[${era.id}] scanning ${todo.length} chunk(s)`);
    let ok = 0, failed = 0;
    await mapLimit(todo, CONCURRENCY, async ([lo, hi]) => {
      const logs = await rpc('eth_getLogs', [{
        address: era.exchange, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16),
      }]);
      if (logs === null) { failed++; return; }
      if (logs.length) appendFileSync(logsFile, logs.map((l) => JSON.stringify(l)).join('\n') + '\n');
      appendFileSync(doneFile, `${lo} ${hi}\n`);
      if (++ok % 100 === 0) console.log(`  ${ok}/${todo.length}`);
    });
    // A hole silently truncates history, so never write a file that claims coverage it lacks.
    if (failed) throw new Error(`[${era.id}] ${failed} chunk(s) failed — re-run to fill the gaps`);
  } else {
    console.log(`[${era.id}] fully cached`);
  }

  const seen = new Set();
  const trades = [];
  let offers = 0, closes = 0;
  if (existsSync(logsFile)) {
    for (const line of readFileSync(logsFile, 'utf8').split('\n')) {
      if (!line) continue;
      const log = JSON.parse(line);
      const block = Number(log.blockNumber);
      if (block < era.from || block > era.to) continue;
      const key = `${log.transactionHash}:${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = log.topics[0];
      const w = words(log.data);
      if (t === TOPIC.trade) {
        if (w[2] === 0n || w[3] === 0n) continue; // a zero leg has no price
        trades.push({
          era: era.id, block, ts: Number(w[5]), tx: log.transactionHash,
          logIndex: Number(log.logIndex), offer: Number(w[0]),
          buyer: '0x' + w[1].toString(16).padStart(40, '0'),
          mfc: w[2].toString(), busd: w[3].toString(),
        });
      } else if (t === TOPIC.create) offers++;
      else if (t === TOPIC.close) closes++;
    }
  }
  trades.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return { trades, offers, closes };
}

// ── Main ────────────────────────────────────────────────────────────────────
const eras = [];
const allTrades = [];
for (const era of ERAS) {
  if (ONLY && era.id !== ONLY) continue;
  const { trades, offers, closes } = await buildEra(era);
  const px = trades.map((t) => Number(t.busd) / Number(t.mfc));
  eras.push({
    id: era.id, label: era.label, token: era.token, exchange: era.exchange,
    scannedFrom: era.from, scannedTo: era.to,
    tradeCount: trades.length, offersCreated: offers, offersClosed: closes,
    firstTs: trades[0]?.ts ?? null, lastTs: trades.at(-1)?.ts ?? null,
    minPrice: px.length ? Math.min(...px) : null,
    maxPrice: px.length ? Math.max(...px) : null,
    ...(era.excluded ? { excluded: true, excludedReason: era.excludedReason } : {}),
  });
  allTrades.push(...trades);
  const d = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '—');
  console.log(`[${era.id}] ${trades.length} trades  ${d(trades[0]?.ts)} → ${d(trades.at(-1)?.ts)}` +
    (px.length ? `  $${Math.min(...px).toFixed(6)} → $${Math.max(...px).toFixed(6)}` : '') +
    (era.excluded ? '  (EXCLUDED from chart)' : ''));
}
allTrades.sort((a, b) => a.ts - b.ts || a.block - b.block || a.logIndex - b.logIndex);
if (!allTrades.length) throw new Error('no trades decoded — refusing to write empty history');

const out = {
  _comment:
    'GENERATED by scripts/build-mfc-history.mjs — do not edit by hand. MFC ("My Freedom Coin") ' +
    'ran through four token contracts on BNB Chain, each with its own on-chain OTC order book. ' +
    'No MFC version ever had a liquidity pool. Each trade is a TradeOffer fill priced in BUSD.',
  chain: 'bsc', chainId: 56, symbol: 'MFC', name: 'My Freedom Coin',
  quote: { symbol: 'BUSD', address: BUSD, decimals: 18 },
  decimals: 18,
  eras,
  tradeCount: allTrades.length,
  trades: allTrades,
};
mkdirSync(dirname(OUT), { recursive: true });
// Pretty-printed on purpose. Vite parses JSON imports into JS objects, so this file's
// whitespace never reaches the bundle — it costs nothing shipped, and one line per
// field keeps `git diff` on a regenerated history readable instead of one huge line.
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\nwrote ${OUT} — ${allTrades.length} trades across ${eras.length} eras`);
