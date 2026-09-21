#!/usr/bin/env node
/**
 * VY TREASURY-ORACLE HISTORY — writes src/data/vyOracleHistory.json.
 *
 * ValinityVYPriceOracleTWAP expresses each route as UQ112x112 VY-wei per USDC-wei. The chart
 * needs the inverse, in token units (USD per VY):
 *
 *   USD/VY = 2^112 * 10^(18 - 6) / encodedVYWeiPerUsdcWei
 *
 * `vyPerUsdcExDirectX112()` is the contract's median excluding the direct VY/USDC market. It is
 * intentionally backed here by `legPricesX112()`: a sample is accepted only when all three
 * treasury routes (WETH, WBTC and PAXG; tuple positions 1..3) are non-zero and their median is
 * exactly the aggregate. This prevents the oracle's fault-softening from quietly turning a
 * three-route median into a surviving one- or two-route value.
 *
 * One eth_call per sample: Multicall3 reads the timestamp, aggregate and four leg prices at the
 * same historical block. Invalid treasury-leg samples become gaps; transport failures abort the
 * build rather than silently producing incomplete history.
 *
 *   node scripts/build-vy-oracle-history.mjs [--rpc <url>] [--out <path>]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ORACLE = '0x6df9a2FA586ff348fc35918dB13c93e52403f070';
const DEPLOYMENT_BLOCK = 25_561_237;
const STRIDE = 1_200; // ~4 hours, matching the chart's 240-minute resolution.
const CONCURRENCY = 8;

const ORACLE_ABI = parseAbi([
  'function vyPerUsdcExDirectX112() view returns (uint256)',
  'function legPricesX112() view returns (uint256,uint256,uint256,uint256)',
]);
const MULTICALL_ABI = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256)']);

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const RPC = arg('--rpc', 'https://api.valinity.io/rpc-proxy');
const OUT = resolve(ROOT, arg('--out', 'src/data/vyOracleHistory.json'));

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

const Q112 = 1n << 112n;
const TOKEN_DECIMAL_ADJUSTMENT = 10n ** 12n; // VY has 18 decimals; USDC has 6.
const OUTPUT_SCALE = 10n ** 12n;

/** Convert encoded VY-wei/USDC-wei to USD per whole VY, rounded to 12 decimals. */
function usdPerVy(encoded) {
  if (encoded <= 0n) return Number.NaN;
  const scaled = (Q112 * TOKEN_DECIMAL_ADJUSTMENT * OUTPUT_SCALE + encoded / 2n) / encoded;
  return Number(scaled) / Number(OUTPUT_SCALE);
}

function median3(a, b, c) {
  return [a, b, c].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))[1];
}

async function sampleAt(block) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const [timestamp, aggregate, legs] = await client.multicall({
        blockNumber: BigInt(block),
        allowFailure: false,
        contracts: [
          {
            address: mainnet.contracts.multicall3.address,
            abi: MULTICALL_ABI,
            functionName: 'getCurrentBlockTimestamp',
          },
          { address: ORACLE, abi: ORACLE_ABI, functionName: 'vyPerUsdcExDirectX112' },
          { address: ORACLE, abi: ORACLE_ABI, functionName: 'legPricesX112' },
        ],
      });

      const [, weth, wbtc, paxg] = legs;
      if (weth === 0n || wbtc === 0n || paxg === 0n) {
        return { rejected: { block, reason: 'one or more treasury legs returned zero' } };
      }
      const median = median3(weth, wbtc, paxg);
      if (aggregate === 0n || aggregate !== median) {
        return { rejected: { block, reason: 'ex-direct aggregate did not equal the three-leg median' } };
      }
      const price = usdPerVy(aggregate);
      if (!(price > 0) || !Number.isFinite(price)) {
        return { rejected: { block, reason: 'aggregate could not be converted to a positive finite price' } };
      }
      return { sample: { block, ts: Number(timestamp), price } };
    } catch (error) {
      lastError = error;
      if (attempt < 5) await sleep(400 * 2 ** attempt);
    }
  }
  const detail = lastError?.shortMessage ?? lastError?.message ?? String(lastError);
  throw new Error(`oracle sample at block ${block} failed after retries: ${detail}`);
}

const head = Number(await client.getBlockNumber());
if (head < DEPLOYMENT_BLOCK) {
  throw new Error(`chain head ${head} predates oracle deployment block ${DEPLOYMENT_BLOCK}`);
}

const blocks = [];
for (let block = DEPLOYMENT_BLOCK; block < head; block += STRIDE) blocks.push(block);
if (blocks.at(-1) !== head) blocks.push(head);

console.log(
  `sampling the VY treasury-oracle median at ${blocks.length} blocks ` +
  `(${DEPLOYMENT_BLOCK.toLocaleString('en-US')} → ${head.toLocaleString('en-US')}) ...`,
);

const results = await mapLimit(blocks, CONCURRENCY, sampleAt);
const samples = results.flatMap((result) => result.sample ? [result.sample] : []);
const rejected = results.flatMap((result) => result.rejected ? [result.rejected] : []);
if (!samples.length) throw new Error('every oracle sample was rejected; refusing to write empty history');
for (let index = 1; index < samples.length; index++) {
  if (samples[index].block <= samples[index - 1].block || samples[index].ts <= samples[index - 1].ts) {
    throw new Error(`oracle samples are not strictly increasing at block ${samples[index].block}`);
  }
}

const out = {
  _comment:
    'GENERATED by scripts/build-vy-oracle-history.mjs — do not edit by hand. USD per VY from ' +
    'the median of the oracle\'s WETH, WBTC and PAXG routes. Direct VY/USDC is excluded. A point ' +
    'is omitted unless all three treasury routes are non-zero and agree with the ex-direct aggregate.',
  chain: 'ethereum',
  chainId: 1,
  oracle: {
    name: 'ValinityVYPriceOracleTWAP',
    address: ORACLE,
    deploymentBlock: DEPLOYMENT_BLOCK,
    aggregateFunction: 'vyPerUsdcExDirectX112',
    legsFunction: 'legPricesX112',
    treasuryLegIndexes: { weth: 1, wbtc: 2, paxg: 3 },
    encoding: 'UQ112x112 VY-wei per USDC-wei',
  },
  stride: STRIDE,
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
  `${date(first.ts)} → ${date(last.ts)}, $${first.price} → $${last.price}`,
);
