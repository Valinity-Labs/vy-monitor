#!/usr/bin/env node
/**
 * BALANCE-SHEET HISTORY — writes src/data/vySheetHistory.json.
 *
 * Four numbers straight out of `VBSO.sheet()`, sampled through time so the chart can draw them
 * beside the price instead of only stating today's value:
 *
 *   holdings   hardAssetsUsd    the coins the system actually holds
 *   debt       stakerDebtUsd    principal + unclaimed yield owed to stakers
 *   loans      loansFaceUsd     face value of what borrowers owe back to unlock their collateral
 *   mcap       mcapUsd          the contract's own market cap, struck at its oracle's price
 *
 * The monitor derives the rest so this file stays raw reads only:
 *
 *   TOTAL VALUE LOCKED  = holdings + loans   — every asset the system holds or is owed
 *   LIQUID EQUITY       = holdings - debt    — the coins on hand, net of what stakers can claim
 *
 * `sheet()` is a single call that values the whole book off the VAO's TWAP marks, so a sample is
 * internally consistent by construction. It CAN revert — `PriceUnavailable()` when an asset's
 * Uniswap V3 observation has aged past the VAO's guard, which PAXG's thin pool does — and that is
 * data, not an error: the block becomes a counted gap and the series interpolates across it.
 * Transport failures abort instead, rather than silently writing a hole.
 *
 * One eth_call per sample: Multicall3 reads the block's own timestamp and the sheet together.
 *
 *   node scripts/build-vy-sheet-history.mjs [--rpc <url>] [--out <path>]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import addresses from '../src/networks/mainnet/addresses.json' with { type: 'json' };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VBSO = addresses.ValinityBalanceSheetOfficer;

/**
 * The same first block the projection history starts from — the VMMO desk's deployment. The sheet
 * itself answers earlier, but every other line under the candles starts here, and a panel that
 * reaches further back than the ones beside it invites a comparison across windows that do not
 * match.
 */
const START_BLOCK = 25_740_890;
const STRIDE = 1_800; // ~6 hours, matching the projection history
const MAX_SAMPLES = 400;
const CONCURRENCY = 8;

const VBSO_ABI = parseAbi([
  'function sheet() view returns (uint256 hardAssetsUsd,uint256 coveredLoansUsd,uint256 loansFaceUsd,uint256 stakerDebtUsd,uint256 equityUsd,uint256 fuelUsd,uint256 demandUsd,uint16 masterRateBps,uint16 eraMaxBps,uint8 era,uint256 mcapUsd,uint256 usdPerVy,uint256 custodyCollateralUsd,uint256 custodyEarnedUsd)',
]);
const MULTICALL_ABI = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256)']);

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const RPC = arg('--rpc', 'https://api.valinity.io/rpc-proxy');
const OUT = resolve(ROOT, arg('--out', 'src/data/vySheetHistory.json'));

const client = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 60_000 }) });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
      if (complete % 50 === 0 || complete === items.length) console.log(`  ${complete}/${items.length}`);
    }
  }));
  return out;
}

/** Cents. These are dollar totals in the millions; more precision than that is noise. */
const round2 = (v) => Math.round(v * 100) / 100;
const usd = (wad) => round2(Number(wad) / 1e18);

const head = Number(await client.getBlockNumber());
if (head < START_BLOCK) throw new Error(`chain head ${head} predates ${START_BLOCK}`);

const blocks = [];
for (let b = START_BLOCK; b < head; b += STRIDE) blocks.push(b);
blocks.push(head);
const stride = blocks.length > MAX_SAMPLES
  ? Math.ceil(blocks.length / MAX_SAMPLES)
  : 1;
const sampled = blocks.filter((_, i) => i % stride === 0 || i === blocks.length - 1);
console.log(`sampling VBSO.sheet() at ${sampled.length} blocks (${sampled[0]} → ${head}) ...`);

async function sampleAt(block) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const [tsResult, sheetResult] = await client.multicall({
        blockNumber: BigInt(block),
        allowFailure: true,
        batchSize: 0,
        contracts: [
          { address: mainnet.contracts.multicall3.address, abi: MULTICALL_ABI, functionName: 'getCurrentBlockTimestamp' },
          { address: VBSO, abi: VBSO_ABI, functionName: 'sheet' },
        ],
      });
      if (tsResult.status !== 'success') throw tsResult.error ?? new Error('no timestamp');
      // A reverted sheet is a GAP, not a failure: the guard fired at this block and there is no
      // honest reading to write. Returning null here keeps the attempt loop for transport faults.
      if (sheetResult.status !== 'success') return { block, gap: true };
      const s = sheetResult.result;
      return {
        block,
        ts: Number(tsResult.result),
        holdings: usd(s[0]),
        loans: usd(s[2]),
        debt: usd(s[3]),
        mcap: usd(s[10]),
      };
    } catch {
      await sleep(400 * 2 ** attempt);
    }
  }
  return null;
}

const results = await mapLimit(sampled, CONCURRENCY, sampleAt);
const failed = results.filter((r) => r === null).length;
if (failed) throw new Error(`${failed} of ${sampled.length} samples failed on transport — refusing to write a series with holes`);

const gaps = results.filter((r) => r.gap).length;
const samples = results.filter((r) => !r.gap && r.ts > 0);
if (!samples.length) throw new Error('every sample reverted — nothing to write');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  _comment:
    'GENERATED by scripts/build-vy-sheet-history.mjs — do not edit by hand. VBSO.sheet() through '
    + 'time: holdings (hardAssetsUsd), loans (loansFaceUsd), debt (stakerDebtUsd) and mcap '
    + '(mcapUsd), in USD. TVL = holdings + loans; liquid equity = holdings - debt.',
  chain: 'ethereum',
  chainId: 1,
  vbso: VBSO,
  builtAtBlock: head,
  sheet: { startBlock: START_BLOCK },
  stride: STRIDE * stride,
  gaps,
  samples,
}, null, 1) + '\n');

const newest = samples[samples.length - 1];
console.log(`wrote ${samples.length} samples → ${OUT}  (${gaps} gaps)`);
console.log(`  newest: holdings $${newest.holdings.toLocaleString('en-US')} · loans $${newest.loans.toLocaleString('en-US')}`);
console.log(`          TVL $${(newest.holdings + newest.loans).toLocaleString('en-US')} · mcap $${newest.mcap.toLocaleString('en-US')} · liquid equity $${(newest.holdings - newest.debt).toLocaleString('en-US')}`);
