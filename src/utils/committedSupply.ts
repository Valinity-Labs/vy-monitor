import type { Address, PublicClient } from 'viem';
import addresses from '../networks/mainnet/addresses.json' with { type: 'json' };
import {
  releaseRouterAbi, releaseYieldAbi, releaseLegacyAbi, releasePreferredAbi,
  releaseInsuranceAbi, releaseDepositEvent, releaseLegacyEvent,
} from '../networks/mainnet/committedSupply.ts';
import { LOG_CHUNK, VY_GENESIS_BLOCK } from './logs.ts';
import { escrowRelease, legacyRelease, sixMonthsAfter, stakingRelease } from './committedSupplyMath.ts';

const router = { address: addresses.ValinityStakingRouter as Address, abi: releaseRouterAbi };
const yieldOfficer = { address: addresses.ValinityYieldOfficer as Address, abi: releaseYieldAbi };
const loanOfficer = { address: addresses.ValinityLoanOfficer as Address, abi: releaseLegacyAbi };
const preferredOfficer = { address: addresses.ValinityPreferredStockOfficer as Address, abi: releasePreferredAbi };
const insuranceOfficer = { address: addresses.ValinityInsuranceOfficer as Address, abi: releaseInsuranceAbi };

export interface CommittedSupply {
  blockNumber: bigint;
  asOf: bigint;
  cutoff: bigint;
  stakingPrincipal: bigint;
  stakingYield: bigint;
  preferred: bigint;
  insurance: bigint;
  legacy: bigint;
  total: bigint;
}

interface DiscoveredPositions {
  toBlock: bigint;
  stakes: Map<string, { user: Address; stakeId: number }>;
  legacy: Map<string, { borrower: Address; asset: Address }>;
}

// Cache identities only, never balances or maturities. Re-read current records on
// every snapshot: slots can be withdrawn/reused, and contracts can be renewed.
const discoveries = new WeakMap<PublicClient, DiscoveredPositions>();

async function discoverPositions(client: PublicClient, blockNumber: bigint) {
  const cached = discoveries.get(client);
  const previous = cached && cached.toBlock <= blockNumber ? cached : undefined;
  const stakes = new Map(previous?.stakes);
  const legacy = new Map(previous?.legacy);
  // Replay the recent tail to cover ordinary reorgs. Extra discovered identities
  // are harmless: their current getters return zero when no position exists.
  const start = previous && previous.toBlock - 64n > VY_GENESIS_BLOCK
    ? previous.toBlock - 64n : VY_GENESIS_BLOCK;
  for (let fromBlock = start; fromBlock <= blockNumber; fromBlock += LOG_CHUNK) {
    const toBlock = fromBlock + LOG_CHUNK - 1n < blockNumber ? fromBlock + LOG_CHUNK - 1n : blockNumber;
    const [deposits, unlocks] = await Promise.all([
      client.getLogs({ address: router.address, event: releaseDepositEvent, fromBlock, toBlock, strict: true }),
      client.getLogs({ address: loanOfficer.address, event: releaseLegacyEvent, fromBlock, toBlock, strict: true }),
    ]);
    for (const { args: { user, stakeId } } of deposits) {
      stakes.set(`${user.toLowerCase()}:${stakeId}`, { user, stakeId });
    }
    for (const { args: { borrower, asset } } of unlocks) {
      legacy.set(`${borrower.toLowerCase()}:${asset.toLowerCase()}`, { borrower, asset });
    }
  }
  const result = { toBlock: blockNumber, stakes, legacy };
  discoveries.set(client, result);
  return result;
}

const PAGE_SIZE = 64;

async function readStaking(
  client: PublicClient, blockNumber: bigint, cutoff: bigint,
  positions: DiscoveredPositions['stakes'], feeBps: number, totalStaked: bigint,
) {
  const keys = [...positions.values()];
  let principal = 0n;
  let yieldDue = 0n;
  let allPrincipal = 0n;
  for (let i = 0; i < keys.length; i += PAGE_SIZE) {
    const page = keys.slice(i, i + PAGE_SIZE);
    const [stakes, yields] = await Promise.all([
      client.multicall({
        contracts: page.map(({ user, stakeId }) => ({ ...router, functionName: 'stakes' as const, args: [user, BigInt(stakeId)] as const })),
        blockNumber, allowFailure: false,
      }),
      client.multicall({
        contracts: page.map(({ user, stakeId }) => ({ ...yieldOfficer, functionName: 'getStake' as const, args: [user, stakeId] as const })),
        blockNumber, allowFailure: false,
      }),
    ]);
    stakes.forEach(([active, , unlockTime, , , , principalVY], index) => {
      if (active) allPrincipal += principalVY;
      const due = stakingRelease({ active, unlockTime, principalVY }, yields[index], cutoff, feeBps);
      principal += due.principal;
      yieldDue += due.yield;
    });
  }
  if (allPrincipal !== totalStaked) throw new Error('Staking records do not reconcile with totalStakedVY');
  return { principal, yieldDue };
}

async function readLegacy(
  client: PublicClient, blockNumber: bigint, cutoff: bigint,
  positions: DiscoveredPositions['legacy'],
) {
  const keys = [...positions.values()];
  let total = 0n;
  for (let i = 0; i < keys.length; i += PAGE_SIZE) {
    const rows = await client.multicall({
      contracts: keys.slice(i, i + PAGE_SIZE).map(({ borrower, asset }) => ({
        ...loanOfficer, functionName: 'getLegacyPosition' as const, args: [borrower, asset] as const,
      })),
      blockNumber, allowFailure: false,
    });
    // The loan itself is deliberately ignored. Each queued tranche was paid for
    // independently, including partial repayments on loans that still have debt.
    for (const [, tranches] of rows) total += legacyRelease(tranches, cutoff);
  }
  return total;
}

function idPage(first: bigint, last: bigint): bigint[] {
  const ids: bigint[] = [];
  for (let id = first; id <= last && ids.length < PAGE_SIZE; id++) ids.push(id);
  return ids;
}

async function readPreferred(client: PublicClient, blockNumber: bigint, cutoff: bigint) {
  const [lastId, outstanding] = await client.multicall({
    contracts: [
      { ...preferredOfficer, functionName: 'nextId' },
      { ...preferredOfficer, functionName: 'outstandingVy' },
    ], blockNumber, allowFailure: false,
  });
  let total = 0n;
  let allEscrow = 0n;
  // Both new officers allocate ++nextId: the endpoint is inclusive, starting at 1.
  for (let first = 1n; first <= lastId; first += BigInt(PAGE_SIZE)) {
    const rows = await client.multicall({
      contracts: idPage(first, lastId).map(id => ({ ...preferredOfficer, functionName: 'positions' as const, args: [id] as const })),
      blockNumber, allowFailure: false,
    });
    for (const [, maturity, , , , vyEscrow] of rows) {
      allEscrow += vyEscrow;
      total += escrowRelease({ maturity, vyEscrow }, cutoff);
    }
  }
  if (allEscrow !== outstanding) throw new Error('Preferred stock records do not reconcile with outstanding VY');
  return total;
}

async function readInsurance(client: PublicClient, blockNumber: bigint, cutoff: bigint) {
  const [lastId, outstanding] = await client.multicall({
    contracts: [
      { ...insuranceOfficer, functionName: 'nextId' },
      { ...insuranceOfficer, functionName: 'outstandingVy' },
    ], blockNumber, allowFailure: false,
  });
  let total = 0n;
  let allEscrow = 0n;
  for (let first = 1n; first <= lastId; first += BigInt(PAGE_SIZE)) {
    const rows = await client.multicall({
      contracts: idPage(first, lastId).map(id => ({ ...insuranceOfficer, functionName: 'policyOf' as const, args: [id] as const })),
      blockNumber, allowFailure: false,
    });
    for (const policy of rows) {
      allEscrow += policy.vyEscrow;
      total += escrowRelease(policy, cutoff);
    }
  }
  if (allEscrow !== outstanding) throw new Error('Insurance records do not reconcile with outstanding VY');
  return total;
}

/**
 * Complete mainnet snapshot of current paid/owed VY due by six calendar months.
 * All reads and event discovery use ONE block. Any failed source rejects the
 * entire total; an incomplete scan or reverted read must never appear as zero.
 * This is a commitment measure, not additional circulating supply: staked VY
 * and sold escrow can already be included in the overview's circulating figure.
 */
export async function fetchCommittedSupply(client: PublicClient): Promise<CommittedSupply> {
  const block = await client.getBlock();
  const blockNumber = block.number;
  if (blockNumber === null) throw new Error('Committed supply requires a mined block');
  const cutoff = sixMonthsAfter(block.timestamp);
  const [positions, [feeBps, totalStaked]] = await Promise.all([
    discoverPositions(client, blockNumber),
    client.multicall({
      contracts: [
        { ...yieldOfficer, functionName: 'feeBps' },
        { ...router, functionName: 'totalStakedVY' },
      ], blockNumber, allowFailure: false,
    }),
  ]);
  const [staking, preferred, insurance, legacy] = await Promise.all([
    readStaking(client, blockNumber, cutoff, positions.stakes, feeBps, totalStaked),
    readPreferred(client, blockNumber, cutoff),
    readInsurance(client, blockNumber, cutoff),
    readLegacy(client, blockNumber, cutoff, positions.legacy),
  ]);
  return {
    blockNumber, asOf: block.timestamp, cutoff,
    stakingPrincipal: staking.principal, stakingYield: staking.yieldDue,
    preferred, insurance, legacy,
    total: staking.principal + staking.yieldDue + preferred + insurance + legacy,
  };
}
