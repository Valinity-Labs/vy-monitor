#!/usr/bin/env node
/**
 * VY PROJECTED-PRICE HISTORY — writes src/data/vyProjectionHistory.json.
 *
 * This is the monitor's OWN projection, not VBSO.projectedVyPrice(). The contract view starts from
 * the oracle's time-averaged median and splits the ammo pro-rata by depth; the balance sheet's
 * `projCurve` (src/pages/Mainnet.tsx) does what VMMO actually does — each asset's book buys VY in
 * that asset's own venue: USDC in the UniV2 VY/USDC pair, WBTC/WETH/PAXG in their ValinityDAX
 * pools. So every venue is walked up its own constant-product curve from live reserves,
 *
 *     price = spot × (1 + usdIn / depthUsd)²,   spot = depthUsd / vyReserve
 *
 * and the HIGHEST venue is the number, named. Arbitrage pulls the venues back together afterwards,
 * so a point is the peak a deploy reaches, not where it settles.
 *
 * The series records the FULLY DEPLOYED point of that curve — f = 1, `usdIn` is each venue's whole
 * held book — because that is exactly what the sheet's "Projected" tile shows (it is deliberately
 * the last row of projCurve, so the tile and the table can never disagree). The release curve
 * 1 − e^(−t/W) therefore never enters this file: it only shapes the intermediate rows.
 *
 * Marks: the asset leg of a DAX pool is valued at the VAO TWAP (`getAssetTwapPrice`), the book at
 * VBSO's `assetUsdPrice`, exactly as Mainnet.tsx values `daxPools.reserveAssetUSD` and the desk
 * rows' `heldUsd`. Those two reads return the identical WAD on every block sampled here — VBSO
 * marks off the same oracle — which is what makes `usdIn / depthUsd` unit-consistent. A mark that
 * reverts (PAXG's thin UniV3 pool does go stale) zeroes its own venue rather than the sample: the
 * venue drops out and the remaining ones still answer, which is what the page does.
 *
 * One eth_call per sample: a single Multicall3 batch reads the timestamp, the pair reserves, every
 * DAX pool, every book and every mark at the same historical block, so a point can never be half
 * one block and half another. Contract reverts are data — a sample with no usable venue, or with no
 * VMMO desk to read, becomes a counted gap. Transport failures abort the build rather than silently
 * writing holes.
 *
 *   node scripts/build-vy-projection-history.mjs [--rpc <url>] [--out <path>]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import addresses from '../src/networks/mainnet/addresses.json' with { type: 'json' };
import assetAddresses from '../src/networks/mainnet/assets.json' with { type: 'json' };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VMMO = addresses.ValinityMarketMakerOfficer;
const VBSO = addresses.ValinityBalanceSheetOfficer;
const VAO = addresses.ValinityAcquisitionOfficer; // same address as ValinityAssetOracle.
const DAX = addresses.ValinityDAX;
const PAIR = addresses.VyUsdcPool;
const VY_TOKEN = addresses.ValinityToken;

/**
 * The VMMO proxy's deployment block. Before it, `books()` has no code to call and the projection
 * has no ammo to project — the tile itself is absent, so there is nothing to backfill. Found by
 * bisecting `getCode`: block 25,740,889 reverts all four `books()` reads and 25,740,890 answers
 * them (with empty books, which is a real and honest zero-ammo projection). The DAX pools, the
 * UniV2 pair and the VAO all predate this by months, so the desk is the binding constraint.
 */
const START_BLOCK = 25_740_890;
const STRIDE = 1_800; // ~6 hours, one notch coarser than the oracle history's 4.
const MAX_SAMPLES = 400;
const CONCURRENCY = 8;

// Order matters only for readability; it is Mainnet.tsx's TABLE_ASSETS order. USDC is the one venue
// that is not a DAX pool, and the one asset with no VAO TWAP — the sheet marks it at $1.
const TABLE_ASSETS = [
  { sym: 'USDC', address: assetAddresses.USDC, isDaxVenue: false },
  { sym: 'WBTC', address: assetAddresses.WBTC, isDaxVenue: true },
  { sym: 'WETH', address: assetAddresses.WETH, isDaxVenue: true },
  { sym: 'PAXG', address: assetAddresses.PAXG, isDaxVenue: true },
];

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

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const RPC = arg('--rpc', 'https://api.valinity.io/rpc-proxy');
const OUT = resolve(ROOT, arg('--out', 'src/data/vyProjectionHistory.json'));

const client = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 60_000 }) });
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let complete = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
      complete++;
      if (complete % 50 === 0 || complete === items.length) {
        console.log(`  ${complete}/${items.length}`);
      }
    }
  }));
  return out;
}

const OUTPUT_SCALE = 1e12;
/** Round to 12 decimals, the precision the oracle history is written at. */
const round12 = (value) => Math.round(value * OUTPUT_SCALE) / OUTPUT_SCALE;

// ── Immutables, read once at the head ────────────────────────────────────────────────────────────
// Token decimals and the pair's token ordering cannot change, and re-reading them on every sampled
// block would only pad the batch. `getNumPools` CAN grow, so the head count is used as the upper
// bound on pool ids: at an older block the ids that did not exist yet simply revert and drop out.
const head = Number(await client.getBlockNumber());
if (head < START_BLOCK) {
  throw new Error(`chain head ${head} predates the VMMO desk's first block ${START_BLOCK}`);
}

const setup = await client.multicall({
  allowFailure: false,
  batchSize: 0,
  contracts: [
    { address: PAIR, abi: PAIR_ABI, functionName: 'token0' },
    { address: DAX, abi: DAX_ABI, functionName: 'getNumPools' },
    ...TABLE_ASSETS.map((t) => ({ address: t.address, abi: ERC20_ABI, functionName: 'decimals' })),
  ],
});
const vyIsToken0 = String(setup[0]).toLowerCase() === VY_TOKEN.toLowerCase();
const POOL_IDS = Array.from({ length: Number(setup[1]) }, (_, i) => BigInt(i));
const ASSETS = TABLE_ASSETS.map((t, i) => ({ ...t, decimals: Number(setup[2 + i]) }));
const DAX_ASSETS = ASSETS.filter((t) => t.isDaxVenue);

// Batch layout. `batchSize: 0` turns off viem's calldata chunking so the whole read really is one
// aggregate3 — the guarantee the rest of this file leans on.
const I_TIMESTAMP = 0;
const I_RESERVES = 1;
const I_POOLS = 2;
const I_BOOKS = I_POOLS + POOL_IDS.length;
const I_MARKS = I_BOOKS + ASSETS.length;
const I_TWAPS = I_MARKS + ASSETS.length;

function contractsFor() {
  return [
    {
      address: mainnet.contracts.multicall3.address,
      abi: MULTICALL_ABI,
      functionName: 'getCurrentBlockTimestamp',
    },
    { address: PAIR, abi: PAIR_ABI, functionName: 'getReserves' },
    ...POOL_IDS.map((id) => ({
      address: DAX, abi: DAX_ABI, functionName: 'getPoolReserves', args: [id],
    })),
    ...ASSETS.map((t) => ({ address: VMMO, abi: VMMO_ABI, functionName: 'books', args: [t.address] })),
    ...ASSETS.map((t) => ({
      address: VBSO, abi: VBSO_ABI, functionName: 'assetUsdPrice', args: [t.address],
    })),
    ...DAX_ASSETS.map((t) => ({
      address: VAO, abi: VAO_ABI, functionName: 'getAssetTwapPrice', args: [t.address],
    })),
  ];
}

/**
 * The projection at one block, from one batch of results. Mirrors `projCurve` in Mainnet.tsx line
 * for line: a venue is kept only when it has both USD depth and VY to sell, and the winner is the
 * venue whose curve ends highest once its whole book has been spent into it.
 */
function projectionFrom(results) {
  const value = (index) => (results[index].status === 'success' ? results[index].result : null);

  const reserves = value(I_RESERVES);
  const vyReserve = reserves ? (vyIsToken0 ? reserves[0] : reserves[1]) : 0n;
  const usdcReserve = reserves ? (vyIsToken0 ? reserves[1] : reserves[0]) : 0n;

  const pools = POOL_IDS.map((_, i) => value(I_POOLS + i)).filter((pool) => pool !== null);

  // No desk at all means the projection did not exist yet (or the officer moved): that is a gap to
  // record, never a zero-ammo projection to invent.
  const books = ASSETS.map((_, i) => value(I_BOOKS + i));
  if (books.every((book) => book === null)) return { reason: 'VMMO books reverted for every asset' };

  const venues = ASSETS.flatMap((t, i) => {
    const held = books[i] ? books[i][0] : 0n;
    const mark = value(I_MARKS + i) ?? 0n; // VBSO assetUsdPrice, WAD USD per whole asset.
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
    const spot = value(I_TWAPS + DAX_ASSETS.indexOf(t)) ?? 0n; // VAO TWAP, WAD USD per whole asset.
    const reserveAssetUSD = spot > 0n
      ? (pool[2] * 10n ** BigInt(18 - t.decimals) * spot) / 10n ** 18n
      : 0n;
    return [{
      pool: t.sym,
      depthUsd: Number(reserveAssetUSD) / 1e18,
      vy: Number(pool[1]) / 1e18,
      heldUsd,
    }];
  }).filter((v) => v.depthUsd > 0 && v.vy > 0);

  if (!venues.length) return { reason: 'no venue had both USD depth and a VY reserve' };

  const best = venues
    .map((v) => ({ pool: v.pool, priceUsd: (v.depthUsd / v.vy) * (1 + v.heldUsd / v.depthUsd) ** 2 }))
    .reduce((a, b) => (b.priceUsd > a.priceUsd ? b : a));

  if (!(best.priceUsd > 0) || !Number.isFinite(best.priceUsd)) {
    return { reason: 'the winning venue did not produce a positive finite price' };
  }
  return { price: round12(best.priceUsd), pool: best.pool };
}

async function sampleAt(block) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const results = await client.multicall({
        blockNumber: BigInt(block),
        allowFailure: true,
        batchSize: 0,
        contracts: contractsFor(),
      });
      // Multicall3 long predates this range, so a failed timestamp is a bad answer rather than a
      // state fact — retry it, and abort if it keeps failing.
      if (results[I_TIMESTAMP].status !== 'success') {
        throw new Error('Multicall3.getCurrentBlockTimestamp did not answer');
      }
      const projection = projectionFrom(results);
      if (projection.reason) return { rejected: { block, reason: projection.reason } };
      return {
        sample: {
          block,
          ts: Number(results[I_TIMESTAMP].result),
          price: projection.price,
          pool: projection.pool,
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt < 5) await sleep(400 * 2 ** attempt);
    }
  }
  const detail = lastError?.shortMessage ?? lastError?.message ?? String(lastError);
  throw new Error(`projection sample at block ${block} failed after retries: ${detail}`);
}

// Widen the stride rather than the file if the desk ever outlives MAX_SAMPLES six-hour steps.
const stride = Math.max(STRIDE, Math.ceil((head - START_BLOCK) / MAX_SAMPLES));
const blocks = [];
for (let block = START_BLOCK; block < head; block += stride) blocks.push(block);
if (blocks.at(-1) !== head) blocks.push(head);

console.log(
  `sampling the fully-deployed VY projection at ${blocks.length} blocks ` +
  `(${START_BLOCK.toLocaleString('en-US')} → ${head.toLocaleString('en-US')}, ` +
  `stride ${stride.toLocaleString('en-US')}) ...`,
);

const results = await mapLimit(blocks, CONCURRENCY, sampleAt);
const samples = results.flatMap((result) => result.sample ? [result.sample] : []);
const rejected = results.flatMap((result) => result.rejected ? [result.rejected] : []);
if (!samples.length) throw new Error('every projection sample was rejected; refusing to write empty history');
for (let index = 1; index < samples.length; index++) {
  if (samples[index].block <= samples[index - 1].block || samples[index].ts <= samples[index - 1].ts) {
    throw new Error(`projection samples are not strictly increasing at block ${samples[index].block}`);
  }
}

const out = {
  _comment:
    'GENERATED by scripts/build-vy-projection-history.mjs — do not edit by hand. USD per VY the ' +
    'monitor\'s own "Projected" tile shows: every VMMO book spent IN FULL into its own venue ' +
    '(USDC in the UniV2 VY/USDC pair, WBTC/WETH/PAXG in their ValinityDAX pools) along that ' +
    'venue\'s constant-product curve, price = spot * (1 + usdIn / depthUsd)^2, reporting the ' +
    'HIGHEST venue and naming it. NOT VBSO.projectedVyPrice(). A point is omitted when no venue ' +
    'had both USD depth and a VY reserve, or when the VMMO desk could not be read at all.',
  chain: 'ethereum',
  chainId: 1,
  projection: {
    basis: 'fully deployed (f = 1) — the last row of projCurve in src/pages/Mainnet.tsx',
    formula: 'price = (depthUsd / vyReserve) * (1 + heldUsd / depthUsd) ** 2, highest venue wins',
    venues: {
      USDC: 'Uniswap V2 VY/USDC pair reserves',
      WBTC: 'ValinityDAX pool, asset leg marked at the VAO TWAP',
      WETH: 'ValinityDAX pool, asset leg marked at the VAO TWAP',
      PAXG: 'ValinityDAX pool, asset leg marked at the VAO TWAP',
    },
    books: 'ValinityMarketMakerOfficer.books(asset).held, marked at VBSO.assetUsdPrice(asset)',
    contracts: { vmmo: VMMO, vbso: VBSO, vao: VAO, dax: DAX, vyUsdcPair: PAIR },
    startBlock: START_BLOCK,
    startBlockReason:
      'first block with a VMMO to read — books() reverts one block earlier, and the pools, pair ' +
      'and oracle all predate it',
  },
  stride,
  builtAtBlock: head,
  rejectedSampleCount: rejected.length,
  rejected,
  samples,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));

const date = (ts) => new Date(ts * 1_000).toISOString().slice(0, 16).replace('T', ' ');
const first = samples[0];
const last = samples.at(-1);
console.log(
  `wrote ${OUT} — ${samples.length} samples, ${rejected.length} rejected, ` +
  `${date(first.ts)} → ${date(last.ts)}, ` +
  `$${first.price} (${first.pool}) → $${last.price} (${last.pool})`,
);
