#!/usr/bin/env node
/**
 * VY BUYBACK HISTORY — writes src/data/vyBuybackHistory.json.
 *
 * The history behind the monitor's "VY buyback" panel, which stacks a slow-moving BASE on a
 * fast-moving PROJECTION. Six series per sample — the base in whole VY, the projection in BOTH
 * whole VY and USD, because the two units say different things about the same event. Measured in
 * VY the projection SATURATES: the venues hold only ~95k VY between them and the book already buys
 * more than half of it, so new market-making capital barely moves the quantity. Measured in USD it
 * scales with the capital. The panel draws both.
 *
 *   BASE (years deep, a step function, whole VY)
 *     boughtBackVy  cumulative VY the buyback officers have sent into the VYT — exactly
 *                   `totalVyBoughtBack` in src/pages/Mainnet.tsx, the sum of the VY Transfer logs
 *                   from the OLD officer (0xD2F0826a…) and the LIVE one (0x4B97D45d…) to the VYT.
 *     heldVy        the officers' own VY balance — the page reads today's as `buybackVyBalance`.
 *
 *   PROJECTION (only once the VMMO desk exists)
 *     bookVy        VY the whole book would take off the market if deployed IN FULL, summed over
 *                   every venue — `projCurve.vyBoughtFull` in Mainnet.tsx. Constant product:
 *                   spending `usdIn` against (depthUsd, vy) removes vy × usdIn / (depthUsd + usdIn),
 *                   and every asset's book buys in its OWN venue at the same time, so these add.
 *     arbVy         VY the arbitrage would buy in the public pool at that block's gap to the DAX —
 *                   `arbBuyVy` in Mainnet.tsx, the closed-form crossing point
 *                   q = (√kd·Vu − √ku·Vd) / (√ku + √kd), clamped to [0, Vu].
 *     bookUsd       the same book in dollars — `desk.totalHeldUsd`, the capital it would spend.
 *     arbUsd        the same arbitrage in dollars — Uu·q / (Vu − q), what buying q costs out of
 *                   the public pool.
 *
 * WHY TWO SAMPLING REGIMES. The base is reconstructed from EVENT LOGS, never from per-block
 * `balanceOf` calls: it reaches back to VY's genesis, and one getLogs window covers 500k blocks
 * where one eth_call covers one. Two chunked scans (`from` ∈ {old, live}, `to` ∈ {old, live}) carry
 * every movement either officer ever made; the VYT-bound subset of the first is the buyback total,
 * and the two together net to the balance. That reconstruction is checked against a live
 * `balanceOf` before anything is written — if the logs and the chain disagree, the build stops.
 *
 * The projection has no logs to read and must be called per block, so it starts where it can start:
 * the VMMO proxy's first block (see START_BLOCK), sampled on a ~6-hour stride like the projected
 * price history. Before that the panel shows base only, and the file says so with nulls rather than
 * inventing a zero-ammo projection.
 *
 * So the emitted samples are two runs spliced at the desk's first block:
 *   · before it — one sample at each block where the base actually CHANGES (thinned to
 *     MAX_PRE_SAMPLES by keeping the last change in each of that many equal block windows), plus a
 *     zero anchor at VY's genesis. A fixed stride would spend hundreds of calls redrawing a flat
 *     line through quarters where nothing happened.
 *   · from it — a fixed ~6-hour stride, every sample carrying all four series.
 *
 * One eth_call per projection sample: a single Multicall3 batch reads the timestamp, the pair
 * reserves, every DAX pool, every book and every mark at the same historical block, so a point can
 * never be half one block and half another. A pre-VMMO sample costs one call too — just the
 * timestamp. Contract reverts are data: a block whose venues cannot be read still emits its base
 * and records null for the projection, because losing a projection point must never blank the base
 * the panel is built on. Transport failures abort the build rather than silently writing holes.
 *
 *   node scripts/build-vy-buyback-history.mjs [--rpc <url>] [--out <path>]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';
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
const VYT = addresses.ValinityYieldTreasury;

/**
 * The two buyback officers, exactly as src/pages/Mainnet.tsx names them. The live one is
 * `ValinityMarketStabilityOfficer` in addresses.json; the old one it hard-codes, because it is
 * decommissioned and holds nothing — but it bought back real VY and that VY is still in the VYT, so
 * dropping it would cut the cumulative total. Its balance is zero today, which is why summing both
 * officers' balances agrees with the page's single `balanceOf` read of the live one.
 */
const LIVE_BUYBACK = addresses.ValinityMarketStabilityOfficer;
const OLD_BUYBACK = '0xD2F0826af20EbDc833c8418E312F23f373F8500e';
const OFFICERS = [OLD_BUYBACK, LIVE_BUYBACK];

/** VY's first transfer — src/utils/logs.ts's VY_GENESIS_BLOCK. Nothing this file needs precedes it. */
const VY_GENESIS_BLOCK = 24_867_000;
/** Window size per getLogs call — src/utils/logs.ts's LOG_CHUNK. */
const LOG_CHUNK = 500_000;

/**
 * The VMMO proxy's deployment block, from scripts/build-vy-projection-history.mjs: 25,740,889
 * reverts every `books()` read and 25,740,890 answers them. Before it there is no book to deploy,
 * so `bookVy` has no meaning — and `arbVy` is only shown beside it, so the projection run starts
 * here as a pair. The pools, the pair and the oracle all predate it by months.
 */
const START_BLOCK = 25_740_890;
const STRIDE = 1_800; // ~6 hours, the projected-price history's cadence.
const MAX_SAMPLES = 400; // projection-run ceiling; the stride widens rather than the file.
const MAX_PRE_SAMPLES = 220; // base-only ceiling across the years before the desk.
const CONCURRENCY = 8;

// Order matters only for readability; it is Mainnet.tsx's TABLE_ASSETS order. USDC is the one venue
// that is not a DAX pool, and the one asset with no VAO TWAP — the sheet marks it at $1.
const TABLE_ASSETS = [
  { sym: 'USDC', address: assetAddresses.USDC, isDaxVenue: false },
  { sym: 'WBTC', address: assetAddresses.WBTC, isDaxVenue: true },
  { sym: 'WETH', address: assetAddresses.WETH, isDaxVenue: true },
  { sym: 'PAXG', address: assetAddresses.PAXG, isDaxVenue: true },
];

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
]);
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

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const RPC = arg('--rpc', 'https://api.valinity.io/rpc-proxy');
const OUT = resolve(ROOT, arg('--out', 'src/data/vyBuybackHistory.json'));

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

const OUTPUT_SCALE = 1e6;
/**
 * Round to 6 decimals. NOT the projected price's 12 — these are VY COUNTS near 1e6, and
 * `value * 1e12` would land past 2^53 and round in the wrong digits. Six decimals is a millionth of
 * a VY, far below anything the panel can draw.
 */
const round6 = (value) => Math.round(value * OUTPUT_SCALE) / OUTPUT_SCALE;
/** Wei → whole tokens, the same lossy-but-irrelevant conversion Mainnet.tsx does. */
const toVy = (wei) => Number(wei) / 1e18;

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
    ...OFFICERS.map((officer) => ({
      address: VY_TOKEN, abi: ERC20_ABI, functionName: 'balanceOf', args: [officer],
    })),
  ],
});
const vyIsToken0 = String(setup[0]).toLowerCase() === VY_TOKEN.toLowerCase();
const POOL_IDS = Array.from({ length: Number(setup[1]) }, (_, i) => BigInt(i));
const ASSETS = TABLE_ASSETS.map((t, i) => ({ ...t, decimals: Number(setup[2 + i]) }));
const DAX_ASSETS = ASSETS.filter((t) => t.isDaxVenue);
const LIVE_HELD_WEI = OFFICERS.reduce((sum, _, i) => sum + setup[2 + ASSETS.length + i], 0n);

// ── The base, from logs ──────────────────────────────────────────────────────────────────────────

/** One chunked full-history getLogs scan, mirroring scanFullHistory in src/utils/logs.ts. */
async function scanTransfers(args) {
  const out = [];
  for (let from = VY_GENESIS_BLOCK; from <= head; from += LOG_CHUNK) {
    const to = Math.min(from + LOG_CHUNK - 1, head);
    let lastError;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        out.push(...await client.getLogs({
          address: VY_TOKEN,
          event: TRANSFER_EVENT,
          args,
          fromBlock: BigInt(from),
          toBlock: BigInt(to),
        }));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 5) await sleep(400 * 2 ** attempt);
      }
    }
    if (lastError) {
      const detail = lastError?.shortMessage ?? lastError?.message ?? String(lastError);
      throw new Error(`VY Transfer scan ${from}–${to} failed after retries: ${detail}`);
    }
  }
  return out;
}

console.log(`scanning VY Transfer logs touching the two buyback officers from ${VY_GENESIS_BLOCK.toLocaleString('en-US')} ...`);
// One scan per topic position. `from` and `to` are different indexed slots, so a single query
// cannot OR across them — it would AND them and return only officer→officer moves.
const [sent, received] = await Promise.all([
  scanTransfers({ from: OFFICERS }),
  scanTransfers({ to: OFFICERS }),
]);

// Net every block the officers moved VY in. Order WITHIN a block is irrelevant: only the block's
// total matters, and a sample carries the state at the end of the block either way.
const deltas = new Map(); // block -> { boughtBack: bigint (VYT-bound only), held: bigint (signed) }
const bump = (block, boughtBack, held) => {
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

const changeBlocks = [...deltas.keys()].sort((a, b) => a - b);
if (!changeBlocks.length) throw new Error('no buyback-officer VY transfers found; refusing to write empty history');

// Running totals at each change block. `boughtBackVy` only ever rises — VY does not come back out
// of the VYT to an officer — while `heldVy` moves both ways as the desk buys and forwards.
const timeline = [];
let boughtBackWei = 0n;
let heldWei = 0n;
for (const block of changeBlocks) {
  const row = deltas.get(block);
  boughtBackWei += row.boughtBack;
  heldWei += row.held;
  if (heldWei < 0n) throw new Error(`reconstructed officer balance went negative at block ${block}`);
  timeline.push({ block, boughtBackWei, heldWei });
}

// The reconstruction has to agree with the chain, or every sample in the file is quietly wrong.
const finalHeld = timeline.at(-1).heldWei;
if (finalHeld !== LIVE_HELD_WEI) {
  throw new Error(
    `log-reconstructed officer balance ${toVy(finalHeld)} VY disagrees with balanceOf ` +
    `${toVy(LIVE_HELD_WEI)} VY at block ${head} — the scan is missing transfers`,
  );
}

/** The base in force AT `block`: the newest timeline row at or before it, or zero before any. */
function baseAt(block) {
  let low = 0;
  let high = timeline.length - 1;
  if (block < timeline[0].block) return { boughtBackVy: 0, heldVy: 0 };
  while (high - low > 0) {
    const middle = (low + high + 1) >> 1;
    if (timeline[middle].block <= block) low = middle;
    else high = middle - 1;
  }
  return {
    boughtBackVy: round6(toVy(timeline[low].boughtBackWei)),
    heldVy: round6(toVy(timeline[low].heldWei)),
  };
}

/**
 * Thin a list of change blocks to at most `max` + 1 of them, keeping the LAST change inside each of
 * `max` equal block windows plus both endpoints. Equal windows rather than every n-th change so the
 * kept points are spread over TIME: the officers trade in bursts, and an every-n-th rule would
 * spend the whole budget inside one busy fortnight and draw a flat line through the rest.
 */
function thinByBlockWindow(blocks, max) {
  if (blocks.length <= max) return blocks;
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const span = Math.max(1, last - first);
  const byWindow = new Map();
  for (const block of blocks) {
    byWindow.set(Math.min(max - 1, Math.floor(((block - first) / span) * max)), block); // last wins
  }
  return [...new Set([first, ...byWindow.values(), last])].sort((a, b) => a - b);
}

// ── Block selection ──────────────────────────────────────────────────────────────────────────────

// Widen the stride rather than the file if the desk ever outlives MAX_SAMPLES six-hour steps.
const stride = Math.max(STRIDE, Math.ceil((head - START_BLOCK) / MAX_SAMPLES));
const projectionBlocks = [];
for (let block = START_BLOCK; block < head; block += stride) projectionBlocks.push(block);
if (projectionBlocks.at(-1) !== head) projectionBlocks.push(head);

// A zero anchor at VY's genesis so the panel's base starts flat on the floor rather than springing
// into existence at the officers' first trade.
const preBlocks = [
  ...(changeBlocks[0] > VY_GENESIS_BLOCK ? [VY_GENESIS_BLOCK] : []),
  ...thinByBlockWindow(changeBlocks.filter((block) => block < START_BLOCK), MAX_PRE_SAMPLES),
];

const blocks = [...preBlocks, ...projectionBlocks];
console.log(
  `sampling ${blocks.length} blocks — ${preBlocks.length} base-only from ` +
  `${VY_GENESIS_BLOCK.toLocaleString('en-US')} (of ${changeBlocks.filter((b) => b < START_BLOCK).length} ` +
  `change blocks), ${projectionBlocks.length} full from ${START_BLOCK.toLocaleString('en-US')} ` +
  `to ${head.toLocaleString('en-US')} on stride ${stride.toLocaleString('en-US')} ...`,
);

// ── Sampling ─────────────────────────────────────────────────────────────────────────────────────

const TIMESTAMP_CALL = {
  address: mainnet.contracts.multicall3.address,
  abi: MULTICALL_ABI,
  functionName: 'getCurrentBlockTimestamp',
};
const I_TIMESTAMP = 0;
const I_RESERVES = 1;
const I_POOLS = 2;
const I_BOOKS = I_POOLS + POOL_IDS.length;
const I_MARKS = I_BOOKS + ASSETS.length;
const I_TWAPS = I_MARKS + ASSETS.length;

// `batchSize: 0` turns off viem's calldata chunking so the whole read really is one aggregate3 —
// the guarantee the rest of this file leans on.
const PROJECTION_CALLS = [
  TIMESTAMP_CALL,
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

/**
 * The four projection series at one block, from one batch of results — the same forces in two
 * units, because they say different things. IN VY the projection SATURATES: the venues only hold
 * ~95k VY between them and the book already buys more than half of it, so fresh capital barely
 * moves the quantity. IN USD it scales with the capital, which is the thing that actually changed.
 *
 * `bookVy` mirrors `projCurve.vyBoughtFull` in Mainnet.tsx: the same venue list (a venue is kept
 * only when it has both USD depth and VY to sell, depth on the VAO TWAP marks and the book on
 * VBSO's, so `usdIn / depth` is unit-consistent), each book spent IN FULL into its own venue, and
 * the VY removed summed across ALL of them — the PRICE is the highest venue, the QUANTITY is every
 * venue at once.
 *
 * `bookUsd` is `desk.totalHeldUsd`: the same per-asset `heldUsd` marks, summed over EVERY asset
 * whose book answered rather than over the surviving venues. Those two sets are identical whenever
 * all four venues are readable, and they part company exactly when a venue drops — a stale PAXG
 * TWAP costs us that pool's depth, so PAXG cannot contribute to `bookVy`, but the PAXG book's own
 * dollar value comes off a different read (VBSO's mark) that still answers. Dropping it there would
 * understate the capital for an oracle problem that has nothing to do with the capital.
 *
 * `arbVy` mirrors `arbBuyVy`: the three treasury pools only, the VGC pool deliberately excluded
 * because it is not part of fair value. A treasury pool whose TWAP is unavailable still contributes
 * its VY leg and nothing to the USD leg, exactly as the page's `reserveAssetUSD` would read zero —
 * that shrinks q rather than inventing depth.
 *
 * `arbUsd` is what that arbitrage SPENDS: buying q out of a constant-product pool (Vu, Uu) costs
 * Uu·q / (Vu − q). It is 0 whenever `arbVy` is, and null in the degenerate q → Vu case, where the
 * cost of draining the pool is unbounded rather than large.
 *
 * Every field is independently nullable. A reason is returned alongside whatever WAS readable,
 * because losing the quantity must not also throw away the dollars.
 */
function projectionFrom(results) {
  const value = (index) => (results[index].status === 'success' ? results[index].result : null);
  const none = { bookVy: null, arbVy: null, bookUsd: null, arbUsd: null };

  const reserves = value(I_RESERVES);
  const vyReserve = reserves ? (vyIsToken0 ? reserves[0] : reserves[1]) : 0n;
  const usdcReserve = reserves ? (vyIsToken0 ? reserves[1] : reserves[0]) : 0n;
  const Vu = Number(vyReserve) / 1e18;
  const Uu = Number(usdcReserve) / 1e6;

  const pools = POOL_IDS.map((_, i) => value(I_POOLS + i)).filter((pool) => pool !== null);

  // No desk at all means the projection did not exist yet (or the officer moved): that is a gap to
  // record, never a zero-ammo projection to invent.
  const books = ASSETS.map((_, i) => value(I_BOOKS + i));
  if (books.every((book) => book === null)) {
    return { ...none, reason: 'VMMO books reverted for every asset' };
  }

  let Vd = 0; // treasury-pool VY reserves, summed.
  let Ad = 0; // treasury-pool asset reserves on VAO marks, summed, in USD.
  let bookUsdRaw = 0; // desk.totalHeldUsd — accumulated BEFORE the venue filter, see above.

  const venues = ASSETS.flatMap((t, i) => {
    const held = books[i] ? books[i][0] : 0n;
    const mark = value(I_MARKS + i) ?? 0n; // VBSO assetUsdPrice, WAD USD per whole asset.
    const heldUsd = Number((held * mark) / 10n ** BigInt(t.decimals)) / 1e18;
    bookUsdRaw += heldUsd;

    if (!t.isDaxVenue) {
      return [{ pool: t.sym, depthUsd: Uu, vy: Vu, heldUsd }];
    }
    const pool = pools.find((p) => String(p[0]).toLowerCase() === t.address.toLowerCase());
    if (!pool) return [];
    const spot = value(I_TWAPS + DAX_ASSETS.indexOf(t)) ?? 0n; // VAO TWAP, WAD USD per whole asset.
    const reserveAssetUSD = spot > 0n
      ? (pool[2] * 10n ** BigInt(18 - t.decimals) * spot) / 10n ** 18n
      : 0n;
    const depthUsd = Number(reserveAssetUSD) / 1e18;
    const vy = Number(pool[1]) / 1e18;
    Vd += vy;
    Ad += depthUsd;
    return [{ pool: t.sym, depthUsd, vy, heldUsd }];
  }).filter((v) => v.depthUsd > 0 && v.vy > 0);

  const bookUsd = Number.isFinite(bookUsdRaw) && bookUsdRaw >= 0 ? round6(bookUsdRaw) : null;

  if (!venues.length) {
    return { ...none, bookUsd, reason: 'no venue had both USD depth and a VY reserve' };
  }

  const bookVyRaw = venues.reduce((n, v) => n + (v.vy * v.heldUsd) / (v.depthUsd + v.heldUsd), 0);
  if (!Number.isFinite(bookVyRaw) || bookVyRaw < 0) {
    return { ...none, bookUsd, reason: 'the book-deploy quantity was not a finite non-negative number' };
  }

  // q ≤ 0 means the public pool is already at or above the DAX — nothing to arbitrage. The 0.3%
  // Uniswap fee is left out, exactly as Mainnet.tsx leaves it out: it moves the crossing point by
  // well under a percent and only downward.
  let arbVy = null;
  let arbUsd = null;
  if (Vu > 0 && Uu > 0 && Vd > 0 && Ad > 0) {
    const rootKu = Math.sqrt(Vu * Uu);
    const rootKd = Math.sqrt(Vd * Ad);
    const q = (rootKd * Vu - rootKu * Vd) / (rootKu + rootKd);
    const bought = q > 0 ? Math.min(q, Vu) : 0;
    if (Number.isFinite(bought)) {
      arbVy = round6(bought);
      // Uu·q / (Vu − q). The clamp above can in principle put q AT Vu, where the spend is infinite
      // rather than merely huge; that is a null, not a number.
      const spend = bought === 0 ? 0 : (Vu > bought ? (Uu * bought) / (Vu - bought) : Number.POSITIVE_INFINITY);
      if (Number.isFinite(spend) && spend >= 0) arbUsd = round6(spend);
    }
  }

  return { bookVy: round6(bookVyRaw), arbVy, bookUsd, arbUsd };
}

/**
 * One sample. A pre-VMMO block reads only the timestamp; a projection block reads the whole batch.
 * Either way the base comes from the log timeline, so it costs nothing and is never a gap.
 */
async function sampleAt(block) {
  const withProjection = block >= START_BLOCK;
  const contracts = withProjection ? PROJECTION_CALLS : [TIMESTAMP_CALL];
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const results = await client.multicall({
        blockNumber: BigInt(block), allowFailure: true, batchSize: 0, contracts,
      });
      // Multicall3 long predates this range, so a failed timestamp is a bad answer rather than a
      // state fact — retry it, and abort if it keeps failing.
      if (results[I_TIMESTAMP].status !== 'success') {
        throw new Error('Multicall3.getCurrentBlockTimestamp did not answer');
      }
      const sample = {
        block,
        ts: Number(results[I_TIMESTAMP].result),
        ...baseAt(block),
        bookVy: null,
        arbVy: null,
        bookUsd: null,
        arbUsd: null,
      };
      if (!withProjection) return { sample };

      const { reason, ...projection } = projectionFrom(results);
      // Whatever WAS readable is kept even when something else was not, so a stale oracle costs one
      // series rather than the sample.
      const filled = { sample: { ...sample, ...projection } };
      return reason ? { ...filled, degraded: { block, reason } } : filled;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await sleep(400 * 2 ** attempt);
    }
  }
  const detail = lastError?.shortMessage ?? lastError?.message ?? String(lastError);
  throw new Error(`buyback sample at block ${block} failed after retries: ${detail}`);
}

const results = await mapLimit(blocks, CONCURRENCY, sampleAt);
const samples = results.map((result) => result.sample);
const degraded = results.flatMap((result) => result.degraded ? [result.degraded] : []);
for (let index = 1; index < samples.length; index++) {
  if (samples[index].block <= samples[index - 1].block || samples[index].ts <= samples[index - 1].ts) {
    throw new Error(`buyback samples are not strictly increasing at block ${samples[index].block}`);
  }
}

const out = {
  _comment:
    'GENERATED by scripts/build-vy-buyback-history.mjs — do not edit by hand. The four series ' +
    'behind the monitor\'s "VY buyback" panel, all in WHOLE VY. BASE: boughtBackVy is the ' +
    'cumulative VY both buyback officers have sent into the VYT (Mainnet.tsx\'s ' +
    'totalVyBoughtBack, from VY Transfer logs) and heldVy is their own VY balance (its ' +
    'buybackVyBalance), reconstructed from the same logs and checked against balanceOf at the ' +
    'head. PROJECTION: bookVy is projCurve.vyBoughtFull — every VMMO book spent IN FULL into its ' +
    'own venue, summing the VY removed across ALL venues — and arbVy is arbBuyVy, the closed-form ' +
    'crossing point between the public VY/USDC pool and the three DAX treasury pools. bookUsd and ' +
    'arbUsd are the SAME two forces in dollars: bookUsd is desk.totalHeldUsd, the capital the book ' +
    'would spend, and arbUsd is Uu*q/(Vu-q), the USDC the arbitrage would spend buying its arbVy. ' +
    'Measured in VY the projection saturates against the venues\' own ~95k VY; measured in USD it ' +
    'scales with the capital. All four are null before the VMMO desk existed, and individually ' +
    'null on a block where that particular series could not be read.',
  chain: 'ethereum',
  chainId: 1,
  buyback: {
    base: {
      officers: { old: OLD_BUYBACK, live: LIVE_BUYBACK },
      vyt: VYT,
      source: 'VY Transfer logs: from ∈ officers (to the VYT = bought back), to ∈ officers',
      startBlock: VY_GENESIS_BLOCK,
      startBlockReason: "VY's first transfer — src/utils/logs.ts's VY_GENESIS_BLOCK",
      sampling:
        'one sample per block where the base changes, thinned to equal block windows, plus a zero ' +
        'anchor at genesis; a fixed stride would redraw a flat line through empty quarters',
      changeBlockCount: changeBlocks.length,
      verifiedAgainst: `balanceOf(officers) at block ${head}`,
    },
    projection: {
      bookVy: 'projCurve.vyBoughtFull in src/pages/Mainnet.tsx — sum over venues of vy * heldUsd / (depthUsd + heldUsd)',
      arbVy: 'arbBuyVy in src/pages/Mainnet.tsx — q = (sqrt(kd)*Vu - sqrt(ku)*Vd) / (sqrt(ku) + sqrt(kd)), clamped to [0, Vu]',
      bookUsd: 'desk.totalHeldUsd in src/pages/Mainnet.tsx — sum over EVERY asset of books(asset).held marked at VBSO.assetUsdPrice, before the venue filter',
      arbUsd: 'the USDC that arbitrage spends: Uu * arbVy / (Vu - arbVy) against the public pair, 0 when arbVy is 0',
      venues: {
        USDC: 'Uniswap V2 VY/USDC pair reserves',
        WBTC: 'ValinityDAX pool, asset leg marked at the VAO TWAP',
        WETH: 'ValinityDAX pool, asset leg marked at the VAO TWAP',
        PAXG: 'ValinityDAX pool, asset leg marked at the VAO TWAP',
      },
      arbVenues: 'the three DAX treasury pools (WBTC/WETH/PAXG) against the public pair; the VGC pool is NOT part of fair value',
      books: 'ValinityMarketMakerOfficer.books(asset).held, marked at VBSO.assetUsdPrice(asset)',
      contracts: { vmmo: VMMO, vbso: VBSO, vao: VAO, dax: DAX, vyUsdcPair: PAIR },
      startBlock: START_BLOCK,
      startBlockReason:
        'first block with a VMMO to read — books() reverts one block earlier, and the pools, pair ' +
        'and oracle all predate it',
    },
  },
  stride,
  builtAtBlock: head,
  degradedSampleCount: degraded.length,
  degraded,
  samples,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));

const date = (ts) => new Date(ts * 1_000).toISOString().slice(0, 16).replace('T', ' ');
const first = samples[0];
const last = samples.at(-1);
const vy = (n) => (n === null ? 'n/a' : n.toLocaleString('en-US', { maximumFractionDigits: 0 }));
const usd = (n) => (n === null ? 'n/a' : `$${vy(n)}`);
console.log(
  `wrote ${OUT} — ${samples.length} samples, ${degraded.length} degraded, ` +
  `${date(first.ts)} → ${date(last.ts)}\n` +
  `  newest: bought back ${vy(last.boughtBackVy)} + held ${vy(last.heldVy)} ` +
  `= base ${vy(last.boughtBackVy + last.heldVy)} VY\n` +
  `          book ${vy(last.bookVy)} VY / ${usd(last.bookUsd)}, ` +
  `arb ${vy(last.arbVy)} VY / ${usd(last.arbUsd)}`,
);
