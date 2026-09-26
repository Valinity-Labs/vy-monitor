/** Six calendar months in UTC, clamping month-end (Aug 31 → Feb 28/29). */
export function sixMonthsAfter(timestamp: bigint): bigint {
  const date = new Date(Number(timestamp) * 1000);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 6);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return BigInt(Math.floor(date.getTime() / 1000));
}

export interface RouterStake {
  active: boolean;
  unlockTime: bigint;
  principalVY: bigint;
}

export interface YieldStake {
  active: boolean;
  yieldBpsSnapshot: number;
  startTime: bigint;
  endTime: bigint;
  lastAccrued: bigint;
  principalVY: bigint;
  pendingGross: bigint;
  grossPaidTotal: bigint;
  maxGross: bigint;
}

const min = (a: bigint, b: bigint) => a < b ? a : b;

/**
 * Current unpaid obligations, at the stake's contracted rate through the cutoff.
 * VYO._accrue/_calcYield/_settleYield: yield is claimable during a lock, so a
 * stake maturing after the window still contributes yield, but not principal.
 * Already-matured unpaid obligations remain included; claimed amounts do not.
 */
export function stakingRelease(
  stake: RouterStake,
  yieldStake: YieldStake,
  cutoff: bigint,
  feeBps: number,
): { principal: bigint; yield: bigint } {
  const principal = stake.active && stake.unlockTime <= cutoff ? stake.principalVY : 0n;
  if (!yieldStake.active) return { principal, yield: 0n };
  if (feeBps < 0 || feeBps > 9500) throw new Error('Invalid staking yield fee');

  const until = min(cutoff, yieldStake.endTime);
  const duration = yieldStake.endTime - yieldStake.startTime;
  if (duration <= 0n) throw new Error('Invalid staking yield term');
  const accrued = until > yieldStake.lastAccrued
    ? yieldStake.principalVY * BigInt(yieldStake.yieldBpsSnapshot)
      * (until - yieldStake.lastAccrued) / (10_000n * duration)
    : 0n;
  const remaining = yieldStake.maxGross > yieldStake.grossPaidTotal
    ? yieldStake.maxGross - yieldStake.grossPaidTotal : 0n;
  const gross = min(yieldStake.pendingGross + accrued, remaining);
  // VYO retains 5% in VYT and sends the separate live fee to the buyback officer.
  // Neither is VY owed to the staker. Preserve Solidity's per-fee rounding.
  const net = gross - gross * 500n / 10_000n - gross * BigInt(feeBps) / 10_000n;
  return { principal, yield: net };
}

/** Paid preferred/insurance escrow; closed or cash-settling rows have zero VY. */
export function escrowRelease(
  position: { maturity: bigint; vyEscrow: bigint },
  cutoff: bigint,
): bigint {
  return position.maturity <= cutoff ? position.vyEscrow : 0n;
}

/** Only the purchased, still-unclaimed tranches, never unpaid loan collateral. */
export function legacyRelease(
  tranches: readonly { vy: bigint; unlockAt: bigint }[],
  cutoff: bigint,
): bigint {
  return tranches.reduce((sum, tranche) => sum + (tranche.unlockAt <= cutoff ? tranche.vy : 0n), 0n);
}
