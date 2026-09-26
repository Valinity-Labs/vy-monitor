import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escrowRelease,
  legacyRelease,
  sixMonthsAfter,
  stakingRelease,
} from '../src/utils/committedSupplyMath.ts';

const WAD = 1_000_000_000_000_000_000n;
const DAY = 86_400n;
const timestamp = (date) => BigInt(Date.parse(date) / 1000);
const start = timestamp('2026-09-01T00:00:00Z');

function stakes(overrides = {}) {
  return {
    router: {
      active: true,
      unlockTime: start + 100n * DAY,
      principalVY: 1_000n * WAD,
      ...overrides.router,
    },
    yieldStake: {
      active: true,
      yieldBpsSnapshot: 1_000,
      startTime: start,
      endTime: start + 100n * DAY,
      lastAccrued: start,
      principalVY: 1_000n * WAD,
      pendingGross: 0n,
      grossPaidTotal: 0n,
      maxGross: 100n * WAD,
      ...overrides.yieldStake,
    },
  };
}

test('six calendar months preserves UTC time and clamps to February in leap years', () => {
  assert.equal(
    sixMonthsAfter(timestamp('2023-08-31T23:59:59Z')),
    timestamp('2024-02-29T23:59:59Z'),
  );
  assert.equal(
    sixMonthsAfter(timestamp('2024-08-31T12:34:56Z')),
    timestamp('2025-02-28T12:34:56Z'),
  );
});

test('six calendar months handles year rollover without treating a month as 30 days', () => {
  assert.equal(
    sixMonthsAfter(timestamp('2026-09-25T21:20:23Z')),
    timestamp('2027-03-25T21:20:23Z'),
  );
  assert.equal(
    sixMonthsAfter(timestamp('2026-01-31T00:00:00Z')),
    timestamp('2026-07-31T00:00:00Z'),
  );
});

test('paid escrow includes exact cutoff and excludes a release one second later', () => {
  const cutoff = timestamp('2027-03-25T21:20:23Z');
  assert.equal(escrowRelease({ maturity: cutoff, vyEscrow: 243n * WAD }, cutoff), 243n * WAD);
  assert.equal(escrowRelease({ maturity: cutoff + 1n, vyEscrow: 243n * WAD }, cutoff), 0n);
});

test('matured unclaimed preferred or insurance escrow stays owed', () => {
  assert.equal(escrowRelease({ maturity: start - DAY, vyEscrow: 17n * WAD }, start), 17n * WAD);
});

test('claimed preferred positions and insurance policies settling in cash contribute no VY', () => {
  // A preferred owner survives closing; an insurance owner can survive the USDC election.
  const closedPreferred = { owner: 'holder', maturity: start, vyEscrow: 0n, usdcPaid: 0n };
  const settlingInsurance = { owner: 'holder', maturity: start, vyEscrow: 0n, floorUsdc: 900_000_000n };
  assert.equal(escrowRelease(closedPreferred, start), 0n);
  assert.equal(escrowRelease(settlingInsurance, start), 0n);
});

test('staking includes principal at unlock and the complete unpaid term yield', () => {
  const { router, yieldStake } = stakes();
  // 1,000 principal earns 100 gross over its term; 5% ecosystem and 15% fee leave 80.
  assert.deepEqual(stakingRelease(router, yieldStake, router.unlockTime, 1_500), {
    principal: 1_000n * WAD,
    yield: 80n * WAD,
  });
  assert.equal(stakingRelease(router, yieldStake, router.unlockTime - 1n, 1_500).principal, 0n);
});

test('a stake maturing beyond the window contributes claimable yield but no principal', () => {
  const { router, yieldStake } = stakes();
  // Halfway through a 100-day term: 50 gross, 40 owed after the two fees.
  assert.deepEqual(stakingRelease(router, yieldStake, start + 50n * DAY, 1_500), {
    principal: 0n,
    yield: 40n * WAD,
  });
});

test('unpaid accrued yield and future yield are included once; previously paid yield is excluded', () => {
  const { router, yieldStake } = stakes({
    yieldStake: {
      lastAccrued: start + 40n * DAY,
      pendingGross: 10n * WAD,
      grossPaidTotal: 30n * WAD,
    },
  });
  // Of 100 promised gross, 30 was paid, 10 is pending, and 60 remains to accrue.
  assert.deepEqual(stakingRelease(router, yieldStake, start + 100n * DAY, 1_500), {
    principal: 1_000n * WAD,
    yield: 56n * WAD,
  });
});

test('remaining contractual promise caps the yield even if pending accrual exceeds it', () => {
  const { router, yieldStake } = stakes({
    yieldStake: { pendingGross: 40n * WAD, grossPaidTotal: 75n * WAD },
  });
  assert.equal(stakingRelease(router, yieldStake, start + 100n * DAY, 1_500).yield, 20n * WAD);
});

test('fully paid yield is zero while unclaimed principal remains due', () => {
  const { router, yieldStake } = stakes({
    yieldStake: { pendingGross: 7n * WAD, grossPaidTotal: 100n * WAD },
  });
  assert.deepEqual(stakingRelease(router, yieldStake, start + 100n * DAY, 1_500), {
    principal: 1_000n * WAD,
    yield: 0n,
  });
});

test('ecosystem retention and live staking fee round separately in wei', () => {
  const { router, yieldStake } = stakes({
    yieldStake: { lastAccrued: start + 100n * DAY, pendingGross: 19n, maxGross: 19n },
  });
  // At 19 wei, 5% floors to 0 and 15% floors to 2. Combining fees would wrongly keep 3.
  assert.equal(stakingRelease(router, yieldStake, router.unlockTime, 1_500).yield, 17n);
  // A changed live fee applies independently of the snapshotted earning rate.
  assert.equal(stakingRelease(router, yieldStake, router.unlockTime, 0).yield, 19n);
});

test('router principal can remain due with no active Yield Officer entry', () => {
  const { router, yieldStake } = stakes({
    yieldStake: { active: false, startTime: 0n, endTime: 0n, pendingGross: 90n * WAD },
  });
  assert.deepEqual(stakingRelease(router, yieldStake, router.unlockTime, 1_500), {
    principal: 1_000n * WAD,
    yield: 0n,
  });
});

test('inactive router and yield entries cannot reintroduce claimed obligations', () => {
  const { router, yieldStake } = stakes({ router: { active: false }, yieldStake: { active: false } });
  assert.deepEqual(stakingRelease(router, yieldStake, start + 100n * DAY, 1_500), {
    principal: 0n,
    yield: 0n,
  });
});

test('matured unclaimed staking debt remains included without accruing beyond the term', () => {
  const { router, yieldStake } = stakes();
  assert.deepEqual(stakingRelease(router, yieldStake, start + 500n * DAY, 1_500), {
    principal: 1_000n * WAD,
    yield: 80n * WAD,
  });
});

test('legacy repayment tranches count purchased VY only, including partial repayments', () => {
  const loan = {
    unpaidCollateralVY: 10_000n * WAD,
    tranches: [
      { vy: 12n * WAD, unlockAt: start - DAY },
      { vy: 8n * WAD, unlockAt: start },
      { vy: 30n * WAD, unlockAt: start + 1n },
      { vy: 0n, unlockAt: start - DAY },
    ],
  };
  // Repayment released 20 VY by this cutoff, even though a larger unpaid loan remains.
  assert.equal(legacyRelease(loan.tranches, start), 20n * WAD);
  assert.equal(legacyRelease([], start), 0n);
});

test('large obligations retain exact bigint precision down to the last wei', () => {
  const exact = 9_007_199_254_740_993_123_456_789_012_345_678_901n;
  assert.equal(escrowRelease({ maturity: start, vyEscrow: exact }, start), exact);
  assert.equal(legacyRelease([
    { vy: exact, unlockAt: start },
    { vy: 2n, unlockAt: start },
  ], start), 9_007_199_254_740_993_123_456_789_012_345_678_903n);
  const { router, yieldStake } = stakes({
    router: { principalVY: exact },
    yieldStake: { active: false },
  });
  assert.equal(stakingRelease(router, yieldStake, router.unlockTime, 1_500).principal, exact);
});

test('invalid active staking terms and impossible yield fees fail instead of hiding bad reads', () => {
  const { router, yieldStake } = stakes();
  assert.throws(() => stakingRelease(router, { ...yieldStake, endTime: start }, start, 1_500), /Invalid staking yield term/);
  assert.throws(() => stakingRelease(router, yieldStake, start, -1), /Invalid staking yield fee/);
  assert.throws(() => stakingRelease(router, yieldStake, start, 9_501), /Invalid staking yield fee/);
});
