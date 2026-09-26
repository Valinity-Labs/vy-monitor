import assert from 'node:assert/strict';
import test from 'node:test';
import addresses from '../src/networks/mainnet/addresses.json' with { type: 'json' };
import { fetchCommittedSupply } from '../src/utils/committedSupply.ts';
import { sixMonthsAfter } from '../src/utils/committedSupplyMath.ts';
import { LOG_CHUNK, VY_GENESIS_BLOCK } from '../src/utils/logs.ts';

const timestamp = BigInt(Date.parse('2026-09-25T12:00:00Z') / 1000);
const cutoff = sixMonthsAfter(timestamp);
const address = (id) => `0x${id.toString(16).padStart(40, '0')}`;
const key = (user, id) => `${user.toLowerCase()}:${id}`;
const loanKey = (borrower, asset) => `${borrower.toLowerCase()}:${asset.toLowerCase()}`;
const sameAddress = (left, right) => left.toLowerCase() === right.toLowerCase();
const emptyYield = () => ({
  active: false, tierId: 0, yieldBpsSnapshot: 0, startTime: 0n, endTime: 0n,
  lastAccrued: 0n, principalVY: 0n, pendingGross: 0n, grossPaidTotal: 0n, maxGross: 0n,
});
const emptyLoan = () => ({ collateral: 0n, principal: 0n, openedAt: 0n, interestAppliedAt: 0n, interestCarry: 0n });

function fixture() {
  const state = {
    block: { number: VY_GENESIS_BLOCK + LOG_CHUNK + 10n, timestamp },
    logs: [], stakes: new Map(), yields: new Map(), legacy: new Map(),
    preferred: new Map(), insurance: new Map(), feeBps: 500,
    totalStakedOverride: undefined, preferredOutstandingOverride: undefined,
    insuranceOutstandingOverride: undefined, failure: undefined,
  };
  const calls = { blocks: 0, logs: [], multicalls: [] };
  const client = {
    async getBlock() {
      calls.blocks++;
      return { ...state.block };
    },
    async getLogs(request) {
      calls.logs.push(request);
      assert.equal(request.strict, true);
      assert.ok(request.fromBlock >= VY_GENESIS_BLOCK);
      assert.ok(request.toBlock <= state.block.number);
      assert.ok(request.toBlock - request.fromBlock < LOG_CHUNK);
      if (state.failure === 'logs') throw new Error('Event provider unavailable');
      return state.logs.filter((log) => log.eventName === request.event.name
        && log.blockNumber >= request.fromBlock && log.blockNumber <= request.toBlock);
    },
    async multicall(request) {
      calls.multicalls.push(request);
      assert.equal(request.blockNumber, state.block.number, 'every state read uses the snapshot block');
      assert.equal(request.allowFailure, false, 'individual failures must reject the snapshot');
      assert.ok(request.contracts.length <= 64);
      return request.contracts.map((contract) => {
        const { functionName, args = [] } = contract;
        if (state.failure === functionName) throw new Error(`${functionName} unavailable`);
        switch (functionName) {
          case 'feeBps': return state.feeBps;
          case 'totalStakedVY': return state.totalStakedOverride
            ?? [...state.stakes.values()].reduce((sum, row) => sum + (row[0] ? row[6] : 0n), 0n);
          case 'stakes': return state.stakes.get(key(args[0], args[1])) ?? [false, 0, 0n, 0n, 0n, 0n, 0n];
          case 'getStake': return state.yields.get(key(args[0], args[1])) ?? emptyYield();
          case 'getLegacyPosition': return state.legacy.get(loanKey(...args)) ?? [emptyLoan(), []];
          case 'nextId': {
            const rows = sameAddress(contract.address, addresses.ValinityPreferredStockOfficer)
              ? state.preferred : state.insurance;
            return [...rows.keys()].reduce((max, id) => id > max ? id : max, 0n);
          }
          case 'outstandingVy': return sameAddress(contract.address, addresses.ValinityPreferredStockOfficer)
            ? state.preferredOutstandingOverride ?? [...state.preferred.values()].reduce((sum, row) => sum + row[5], 0n)
            : state.insuranceOutstandingOverride ?? [...state.insurance.values()].reduce((sum, row) => sum + row.vyEscrow, 0n);
          case 'positions': {
            assert.ok(state.preferred.has(args[0]), `unexpected preferred ID ${args[0]}`);
            return state.preferred.get(args[0]);
          }
          case 'policyOf': {
            assert.ok(state.insurance.has(args[0]), `unexpected policy ID ${args[0]}`);
            return state.insurance.get(args[0]);
          }
          default: throw new Error(`Unexpected contract read ${functionName}`);
        }
      });
    },
  };
  function deposit(user, stakeId, principalVY, unlockTime = cutoff, blockNumber = VY_GENESIS_BLOCK + 1n) {
    state.logs.push({ eventName: 'Deposit', blockNumber, args: { user, stakeId, vyAmount: principalVY } });
    // Seven outputs: large, distinct LP credits catch accidental six-output decoding.
    state.stakes.set(key(user, stakeId), [true, 1, unlockTime, timestamp, 888_888n, 999_999n, principalVY]);
  }
  function legacy(borrower, asset, tranches, blockNumber = VY_GENESIS_BLOCK + 1n) {
    state.logs.push({ eventName: 'LegacyUnlockPurchased', blockNumber, args: { borrower, asset } });
    state.legacy.set(loanKey(borrower, asset), [{ ...emptyLoan(), collateral: 900_000n, principal: 700_000n }, tranches]);
  }
  function preferred(id, vyEscrow, maturity = cutoff) {
    state.preferred.set(id, [address(999), maturity, 1, 100, 100, vyEscrow, 0n, 0n]);
  }
  function insurance(id, vyEscrow, maturity = cutoff) {
    state.insurance.set(id, { owner: address(999), maturity, term: 1, drawCapAtOpen: 0,
      floorUsdc: 0n, vyEscrow, graceAtOpen: 0, depositUsdc: 0n });
  }
  const reads = (method) => calls.multicalls.flatMap(({ contracts }) => contracts)
    .filter(({ functionName }) => functionName === method);
  return { client, state, calls, deposit, legacy, preferred, insurance, reads };
}

test('one-block snapshot deduplicates reused slots and sums only current paid commitments', async () => {
  const f = fixture();
  const user = address(1);
  f.deposit(user, 0, 50_000n);
  f.deposit(user, 0, 1_000n, cutoff, VY_GENESIS_BLOCK + 5n); // same slot, new stake
  f.deposit(user, 49, 2_000n, timestamp + 2n * (cutoff - timestamp));
  f.state.yields.set(key(user, 49), {
    ...emptyYield(), active: true, yieldBpsSnapshot: 5_000,
    startTime: timestamp, endTime: timestamp + 2n * (cutoff - timestamp),
    lastAccrued: timestamp, principalVY: 2_000n, maxGross: 1_000n,
  });
  // Withdrawn slot events remain in history, but its live values are cleared.
  f.deposit(user, 1, 100_000n);
  f.state.stakes.set(key(user, 1), [false, 0, 0n, 0n, 0n, 0n, 0n]);
  f.legacy(address(2), address(3), [{ vy: 70n, unlockAt: cutoff }, { vy: 900n, unlockAt: cutoff + 1n }]);
  f.legacy(address(2), address(3), [{ vy: 70n, unlockAt: cutoff }, { vy: 900n, unlockAt: cutoff + 1n }]);
  f.preferred(1n, 30n);
  f.preferred(2n, 300n, cutoff + 1n);
  f.preferred(3n, 0n); // claimed row retains its owner
  f.insurance(1n, 40n, timestamp - 1n); // matured but unclaimed
  f.insurance(2n, 0n); // cash election cleared its escrow

  assert.deepEqual(await fetchCommittedSupply(f.client), {
    blockNumber: f.state.block.number, asOf: timestamp, cutoff,
    stakingPrincipal: 1_000n, stakingYield: 450n, preferred: 30n,
    insurance: 40n, legacy: 70n, total: 1_590n,
  });
  assert.equal(f.calls.blocks, 1);
  assert.equal(f.reads('stakes').length, 3);
  assert.equal(f.reads('getStake').length, 3);
  assert.equal(f.reads('getLegacyPosition').length, 1);
  for (const event of ['Deposit', 'LegacyUnlockPurchased']) {
    const ranges = f.calls.logs.filter((request) => request.event.name === event);
    assert.equal(ranges[0].fromBlock, VY_GENESIS_BLOCK);
    assert.equal(ranges.at(-1).toBlock, f.state.block.number);
    assert.equal(ranges[1].fromBlock, ranges[0].toBlock + 1n);
  }
});

test('pages more than 64 positions and includes each officer last allocated ID', async () => {
  const f = fixture();
  for (let i = 0; i < 65; i++) {
    f.deposit(address(1 + Math.floor(i / 50)), i % 50, 1n);
    f.legacy(address(100 + i), address(999), [{ vy: 2n, unlockAt: cutoff }]);
    f.preferred(BigInt(i + 1), 3n);
    f.insurance(BigInt(i + 1), 4n);
  }
  const result = await fetchCommittedSupply(f.client);
  assert.equal(result.total, 650n);
  assert.equal(result.stakingPrincipal, 65n);
  for (const name of ['stakes', 'getStake', 'getLegacyPosition', 'positions', 'policyOf']) {
    assert.equal(f.reads(name).length, 65, `${name} fully enumerated`);
    const pages = f.calls.multicalls.filter(({ contracts }) => contracts[0].functionName === name);
    assert.deepEqual(pages.map(({ contracts }) => contracts.length), [64, 1]);
  }
  assert.deepEqual(f.reads('positions').map(({ args }) => args[0]), Array.from({ length: 65 }, (_, i) => BigInt(i + 1)));
  assert.equal(f.reads('policyOf').at(-1).args[0], 65n);
});

test('empty deployment counters read no phantom position zero', async () => {
  const f = fixture();
  assert.equal((await fetchCommittedSupply(f.client)).total, 0n);
  assert.equal(f.reads('positions').length, 0);
  assert.equal(f.reads('policyOf').length, 0);
});

test('cached discovery refreshes balances and finds later deposits without recounting old events', async () => {
  const f = fixture();
  const originalBlock = f.state.block.number;
  f.deposit(address(1), 0, 100n, cutoff, originalBlock - 10n);
  assert.equal((await fetchCommittedSupply(f.client)).total, 100n);

  f.state.block.number += 100n;
  f.deposit(address(1), 0, 200n, cutoff, originalBlock + 10n);
  f.deposit(address(1), 1, 300n, cutoff, originalBlock + 20n);
  f.calls.logs.length = 0;
  f.calls.multicalls.length = 0;
  assert.equal((await fetchCommittedSupply(f.client)).total, 500n);
  assert.equal(f.reads('stakes').length, 2);
  assert.equal(f.calls.logs[0].fromBlock, originalBlock - 64n);

  // A provider returning an older block must restart discovery, never query a
  // negative window or rely on a cached scan completed after the new snapshot.
  f.state.block.number = originalBlock - 20n;
  f.state.stakes.clear();
  f.calls.logs.length = 0;
  f.calls.multicalls.length = 0;
  assert.equal((await fetchCommittedSupply(f.client)).total, 0n);
  assert.equal(f.calls.logs[0].fromBlock, VY_GENESIS_BLOCK);
  assert.equal(f.reads('stakes').length, 0);
});

test('any unavailable source rejects the whole result instead of returning a partial total', async (t) => {
  for (const failure of ['logs', 'feeBps', 'stakes', 'getStake', 'getLegacyPosition', 'positions', 'policyOf']) {
    await t.test(failure, async () => {
      const f = fixture();
      f.deposit(address(1), 0, 100n);
      f.legacy(address(2), address(3), [{ vy: 100n, unlockAt: cutoff }]);
      f.preferred(1n, 100n);
      f.insurance(1n, 100n);
      f.state.failure = failure;
      await assert.rejects(fetchCommittedSupply(f.client), /unavailable/);
    });
  }
});

test('on-chain aggregate mismatches reject incomplete staking and escrow enumeration', async (t) => {
  for (const [override, message] of [
    ['totalStakedOverride', /Staking records do not reconcile/],
    ['preferredOutstandingOverride', /Preferred stock records do not reconcile/],
    ['insuranceOutstandingOverride', /Insurance records do not reconcile/],
  ]) {
    await t.test(override, async () => {
      const f = fixture();
      f.state[override] = 1n; // a live obligation with no discoverable matching record
      await assert.rejects(fetchCommittedSupply(f.client), message);
    });
  }
});
