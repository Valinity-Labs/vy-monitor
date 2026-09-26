import { parseAbi, parseAbiItem } from 'viem';

// Read-only slices of the deployed mainnet ABIs, verified September 25, 2026.
// In particular, VSR V7 has SEVEN outputs, including startTime; older deployment
// metadata with six outputs would silently decode uniCredits as principalVY.
export const releaseRouterAbi = parseAbi([
  'function totalStakedVY() view returns (uint256)',
  'function stakes(address,uint256) view returns (bool active,uint8 tierId,uint64 unlockTime,uint64 startTime,uint256 daxCredits,uint256 uniCredits,uint256 principalVY)',
]);
export const releaseYieldAbi = parseAbi([
  'function feeBps() view returns (uint16)',
  'function getStake(address,uint8) view returns ((bool active,uint8 tierId,uint16 yieldBpsSnapshot,uint64 startTime,uint64 endTime,uint64 lastAccrued,uint256 principalVY,uint256 pendingGross,uint256 grossPaidTotal,uint256 maxGross))',
]);
export const releaseLegacyAbi = parseAbi([
  'function getLegacyPosition(address,address) view returns ((uint256 collateral,uint256 principal,uint64 openedAt,uint64 interestAppliedAt,uint256 interestCarry) loan,(uint128 vy,uint64 unlockAt)[] tranches)',
]);
export const releasePreferredAbi = parseAbi([
  'function nextId() view returns (uint64)',
  'function outstandingVy() view returns (uint128)',
  'function positions(uint256 id) view returns (address owner,uint56 maturity,uint8 term,uint16 discount,uint16 exitCharge,uint96 vyEscrow,uint96 vgcOwed,uint64 usdcPaid)',
]);
export const releaseInsuranceAbi = parseAbi([
  'function nextId() view returns (uint120)',
  'function outstandingVy() view returns (uint128)',
  'function policyOf(uint256 id) view returns ((address owner,uint64 maturity,uint8 term,uint16 drawCapAtOpen,uint96 floorUsdc,uint128 vyEscrow,uint32 graceAtOpen,uint128 depositUsdc))',
]);

export const releaseDepositEvent = parseAbiItem('event Deposit(address indexed user,uint8 stakeId,uint256 vyAmount,uint8 tierId,uint256 vdaxMinted,uint256 uniMinted,uint256 daxCreditsAdd,uint256 uniCreditsAdd)');
export const releaseLegacyEvent = parseAbiItem('event LegacyUnlockPurchased(address indexed borrower,address indexed asset,uint256 vyFreed,uint256 surcharge,uint64 unlockAt)');
