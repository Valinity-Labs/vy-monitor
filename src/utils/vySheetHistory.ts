import { parseAbi, type Address, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import history from '../data/vySheetHistory.json';
import addresses from '../networks/mainnet/addresses.json';

/**
 * One observation of `VBSO.sheet()`: the four raw dollar totals the two balance-sheet panels are
 * drawn from. Everything shown is derived here rather than stored, so the file can never hold a
 * total that disagrees with its own parts.
 *
 *   TOTAL VALUE LOCKED  holdings + loans   every asset held, plus every asset owed back
 *   LIQUID EQUITY       holdings - debt    what is on hand, net of what stakers can claim
 *
 * The two live on scales two orders apart — TVL is ~$11.7M against liquid equity's ~$140K — which
 * is why they are drawn in separate panels rather than one.
 */
export interface VySheetSample {
  block: number;
  /** Unix time in seconds. */
  ts: number;
  /** hardAssetsUsd — the coins the system actually holds. */
  holdings: number;
  /** loansFaceUsd — face value of what borrowers owe back to unlock their collateral. */
  loans: number;
  /** stakerDebtUsd — principal plus unclaimed yield owed to stakers. */
  debt: number;
  /** mcapUsd — the contract's own market cap, struck at its oracle's price. */
  mcap: number;
}

interface VySheetHistoryFile {
  builtAtBlock: number;
  sheet: { startBlock: number };
  stride: number;
  samples: VySheetSample[];
}

const committed = history as VySheetHistoryFile;

/** Build-time history committed with the app, oldest first. */
export const VY_SHEET_SNAPSHOT: VySheetSample[] = committed.samples;

const BUILT_AT_BLOCK = committed.builtAtBlock;

/** Merge by block, preferring the tail. The same array comes back when nothing is new. */
export function mergeVySheetSamples(
  snapshot: VySheetSample[], tail: VySheetSample[],
): VySheetSample[] {
  if (!tail.length) return snapshot;
  const byBlock = new Map(snapshot.map((s) => [s.block, s]));
  let changed = false;
  for (const s of tail) {
    if (!(s.block >= 0) || !(s.ts > 0) || !Number.isFinite(s.holdings)) continue;
    const old = byBlock.get(s.block);
    if (!old || old.ts !== s.ts || old.holdings !== s.holdings || old.loans !== s.loans
      || old.debt !== s.debt || old.mcap !== s.mcap) {
      byBlock.set(s.block, s);
      changed = true;
    }
  }
  return changed ? [...byBlock.values()].sort((a, b) => a.block - b.block) : snapshot;
}

/**
 * Interpolated value at a unix-ms instant. No backfill before the first observation — the series
 * simply did not exist — and the last value is held after the newest one.
 */
function valueAt(samples: VySheetSample[], ms: number, pick: (s: VySheetSample) => number): number {
  if (!samples.length || !Number.isFinite(ms)) return Number.NaN;
  const time = ms / 1_000;
  const first = samples[0];
  if (time < first.ts) return Number.NaN;
  if (time === first.ts) return pick(first);
  const last = samples[samples.length - 1];
  if (time >= last.ts) return pick(last);

  let low = 0;
  let high = samples.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (samples[mid].ts <= time) low = mid;
    else high = mid;
  }
  const before = samples[low];
  const after = samples[high];
  if (after.ts <= before.ts) return pick(after);
  return pick(before) + ((time - before.ts) / (after.ts - before.ts)) * (pick(after) - pick(before));
}

/** Every asset the system holds or is owed back: hard assets + the face value of the loan book. */
export const vyTvlAt = (s: VySheetSample[], ms: number) => valueAt(s, ms, (x) => x.holdings + x.loans);
/** The coins on hand, net of what stakers can claim. */
export const vyLiquidEquityAt = (s: VySheetSample[], ms: number) => valueAt(s, ms, (x) => x.holdings - x.debt);
/** The coins on hand, gross. */
export const vyHoldingsAt = (s: VySheetSample[], ms: number) => valueAt(s, ms, (x) => x.holdings);
/** The contract's own market cap — total supply at ITS oracle, not at the public pool. */
export const vyMcapAt = (s: VySheetSample[], ms: number) => valueAt(s, ms, (x) => x.mcap);

// ── Live tail ───────────────────────────────────────────────────────────────────────────────────
/**
 * The same `sheet()` the builder commits, read in the browser so the panels keep moving while the
 * page is open. Nothing here throws: these run inside the page's 30-second poll, and a dead RPC or
 * a reverted sheet (the VAO guard does fire) must cost a point, never the chart.
 */

const VBSO_ABI = parseAbi([
  'function sheet() view returns (uint256 hardAssetsUsd,uint256 coveredLoansUsd,uint256 loansFaceUsd,uint256 stakerDebtUsd,uint256 equityUsd,uint256 fuelUsd,uint256 demandUsd,uint16 masterRateBps,uint16 eraMaxBps,uint8 era,uint256 mcapUsd,uint256 usdPerVy,uint256 custodyCollateralUsd,uint256 custodyEarnedUsd)',
]);
const MULTICALL_ABI = parseAbi(['function getCurrentBlockTimestamp() view returns (uint256)']);

const VBSO = addresses.ValinityBalanceSheetOfficer as Address;

const round2 = (v: number) => Math.round(v * 100) / 100;
const usd = (wad: bigint) => round2(Number(wad) / 1e18);

async function sampleAt(client: PublicClient, block: bigint): Promise<VySheetSample | null> {
  try {
    const [ts, sheet] = await client.multicall({
      blockNumber: block,
      allowFailure: true,
      batchSize: 0,
      contracts: [
        { address: mainnet.contracts.multicall3.address, abi: MULTICALL_ABI, functionName: 'getCurrentBlockTimestamp' },
        { address: VBSO, abi: VBSO_ABI, functionName: 'sheet' },
      ],
    });
    if (ts.status !== 'success' || sheet.status !== 'success') return null;
    const s = sheet.result as readonly bigint[];
    return {
      block: Number(block),
      ts: Number(ts.result),
      holdings: usd(s[0]),
      loans: usd(s[2]),
      debt: usd(s[3]),
      mcap: usd(s[10]),
    };
  } catch {
    return null;
  }
}

/** One observation at the chain head — the every-poll case. */
export async function fetchVySheetHead(client: PublicClient): Promise<VySheetSample | null> {
  try {
    return await sampleAt(client, await client.getBlockNumber());
  } catch {
    return null;
  }
}

/**
 * Everything since the committed snapshot, on the snapshot's own stride, plus the head. Run once
 * on the first poll so a bundle built days ago still draws a current line.
 */
export async function fetchVySheetTail(client: PublicClient): Promise<VySheetSample[]> {
  try {
    const head = Number(await client.getBlockNumber());
    if (!(head > BUILT_AT_BLOCK)) {
      const now = await fetchVySheetHead(client);
      return now ? [now] : [];
    }
    const stride = committed.stride > 0 ? committed.stride : 1_800;
    const blocks: bigint[] = [];
    for (let b = BUILT_AT_BLOCK + stride; b < head; b += stride) blocks.push(BigInt(b));
    blocks.push(BigInt(head));
    // Serial: this is the page's own RPC budget, shared with the chart's other tails.
    const out: VySheetSample[] = [];
    for (const b of blocks) {
      const s = await sampleAt(client, b);
      if (s) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}
