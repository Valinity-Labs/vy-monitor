import { toEventSelector, toFunctionSelector, type TransactionReceipt } from 'viem';
import addresses from '../networks/mainnet/addresses.json';
import { ERAS, type Trade } from './priceHistory';

export type TraderTier = {
  label: 'Shrimp' | 'Fish' | 'Dolphin' | 'Whale';
  emoji: '🦐' | '🐟' | '🐬' | '🐋';
  range: string;
};

export type TraderActivity = {
  boughtVY: number;
  soldVY: number;
  buys: number;
  sells: number;
};

const SHRIMP: TraderTier = { label: 'Shrimp', emoji: '🦐', range: '<1,000 VY' };
const FISH: TraderTier = { label: 'Fish', emoji: '🐟', range: '≥1,000 and <10,000 VY' };
const DOLPHIN: TraderTier = { label: 'Dolphin', emoji: '🐬', range: '≥10,000 and <100,000 VY' };
const WHALE: TraderTier = { label: 'Whale', emoji: '🐋', range: '≥100,000 VY' };

/** Exactly three hexadecimal characters after 0x, then the final three. */
export function shortAddress(address: string): string {
  if (!address.startsWith('0x') || address.length < 10) return address;
  return `${address.slice(0, 5)}…${address.slice(-3)}`;
}

/** Compact, continuously useful ages in the same idiom as a live trade feed. */
export function relativeAge(timestampSeconds: number, nowMs: number, language: 'en' | 'es' = 'en'): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1_000) - timestampSeconds);
  let value: string;
  if (seconds < 60) value = `${seconds}s`;
  else if (seconds < 3_600) value = language === 'es' ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 60)}m`;
  else if (seconds < 86_400) value = `${Math.floor(seconds / 3_600)}h`;
  else if (seconds < 604_800) value = `${Math.floor(seconds / 86_400)}d`;
  else if (seconds < 2_592_000) value = language === 'es' ? `${Math.floor(seconds / 604_800)} sem` : `${Math.floor(seconds / 604_800)}w`;
  else if (seconds < 31_536_000) value = `${Math.floor(seconds / 2_592_000)}mo`;
  else value = language === 'es' ? `${Math.floor(seconds / 31_536_000)}a` : `${Math.floor(seconds / 31_536_000)}y`;
  return language === 'es' ? `hace ${value}` : `${value} ago`;
}

export function absoluteTime(timestampSeconds: number, locale = 'en-US'): string {
  return new Date(timestampSeconds * 1_000).toLocaleString(locale, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC',
    timeZoneName: 'short',
  });
}

/**
 * Keep tiny fills visible while still making the largest visible fill reach the full row width.
 * Square-root scaling prevents one outlier from flattening every other bar to a hairline.
 */
export function tradeBarWidth(valueUsd: number, largestValueUsd: number): number {
  if (!Number.isFinite(valueUsd) || !Number.isFinite(largestValueUsd) || valueUsd <= 0 || largestValueUsd <= 0) return 0;
  return Math.min(100, 8 + 92 * Math.sqrt(valueUsd / largestValueUsd));
}

/**
 * Dexscreener-style maker activity for the VY eras in the supplied tape.
 * Buys and sells stay separate because the badge is based on the larger side, not their sum.
 */
export function traderActivityByWallet(trades: Trade[]): ReadonlyMap<string, TraderActivity> {
  const activity = new Map<string, TraderActivity>();
  for (const trade of trades) {
    if ((trade.era !== 'vy-current' && trade.era !== 'vy-legacy')
      || !Number.isFinite(trade.qty) || trade.qty <= 0) continue;
    const address = trade.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
    const key = `${trade.era}:${address}`;
    const current = activity.get(key) ?? { boughtVY: 0, soldVY: 0, buys: 0, sells: 0 };
    if (trade.side === 'buy') {
      current.boughtVY += trade.qty;
      current.buys += 1;
    } else {
      current.soldVY += trade.qty;
      current.sells += 1;
    }
    activity.set(key, current);
  }
  return activity;
}

export const traderActivityKey = (trade: Pick<Trade, 'era' | 'address'>): string =>
  `${trade.era}:${trade.address.toLowerCase()}`;

/** Rank from the larger of cumulative VY bought or sold, mirroring Dexscreener's maker method. */
export function traderTier(activity: TraderActivity | undefined): TraderTier | undefined {
  if (!activity) return undefined;
  const rankedVolume = Math.max(activity.boughtVY, activity.soldVY);
  if (rankedVolume >= 100_000) return WHALE;
  if (rankedVolume >= 10_000) return DOLPHIN;
  if (rankedVolume >= 1_000) return FISH;
  return SHRIMP;
}

export function traderTitle(
  tier: TraderTier,
  activity: TraderActivity,
  language: 'en' | 'es' = 'en',
): string {
  const formatVY = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const rankedVolume = Math.max(activity.boughtVY, activity.soldVY);
  const rank = language === 'es'
    ? ({ Shrimp: 'Camarón', Fish: 'Pez', Dolphin: 'Delfín', Whale: 'Ballena' } as const)[tier.label]
    : tier.label;
  const range = language === 'es'
    ? ({
        Shrimp: 'menos de 1.000 VY',
        Fish: '1.000–10.000 VY',
        Dolphin: '10.000–100.000 VY',
        Whale: '100.000+ VY',
      } as const)[tier.label]
    : tier.range;
  return language === 'es'
    ? `${rank} (${range}) · actividad ${formatVY(rankedVolume)} VY · compró ${formatVY(activity.boughtVY)} VY (${activity.buys}) · vendió ${formatVY(activity.soldVY)} VY (${activity.sells})`
    : `${rank} trader (${range}) · ${formatVY(rankedVolume)} VY activity · bought ${formatVY(activity.boughtVY)} VY (${activity.buys}) · sold ${formatVY(activity.soldVY)} VY (${activity.sells})`;
}

export function defaultTradeAction(trade: Trade): string {
  const verb = trade.side === 'buy' ? 'Bought' : 'Sold';
  const venue = ERAS[trade.era].venue.toLowerCase().includes('uniswap')
    ? 'Uniswap'
    : ERAS[trade.era].venue;
  return `${verb}${trade.era === 'vy-current' || trade.era === 'vy-legacy' ? ' VY' : ''} on ${venue}`;
}

const lower = (value: string) => value.toLowerCase();
const contract = {
  loan: lower(addresses.ValinityLoanOfficer),
  staking: lower(addresses.ValinityStakingRouter),
  yield: lower(addresses.ValinityYieldOfficer),
  portal: lower(addresses.ValinityPortal),
  acquisition: lower(addresses.ValinityAcquisitionOfficer),
  buyback: lower(addresses.ValinityMarketStabilityOfficer),
  // Newer contracts are audited in this repository but have not yet been added to addresses.json.
  alliance: '0x514f0abf411dd63edd92dad9ceb7e39e0aed259f',
  exchange: '0x48c88b807b13593bac4a5ea75ebd4fec83f827d7',
} as const;
const actionContracts = new Set<string>(Object.values(contract));

const callAction = new Map<string, string>();
const addCall = (address: string, signatureOrSelector: string, label: string) => {
  const selector = signatureOrSelector.startsWith('0x')
    ? signatureOrSelector.toLowerCase()
    : toFunctionSelector(signatureOrSelector).toLowerCase();
  callAction.set(`${address}:${selector}`, label);
};

// User-facing methods verified against the repository's as-deployed source. The destination
// address is part of the key so a coincidentally matching four-byte selector cannot be mislabeled.
addCall(contract.staking, 'depositStake(uint8,uint256,uint256,uint256)', 'Valinity Staking · Deposited VY');
addCall(contract.staking, 'withdrawStake(uint8,uint256)', 'Valinity Staking · Withdrew VY');
addCall(contract.staking, 'depositAssetStake(address,uint256,uint8,uint256)', 'Valinity Staking · Deposited asset');
addCall(contract.staking, 'depositETHStake(uint8,uint256)', 'Valinity Staking · Deposited ETH');
addCall(contract.staking, 'withdrawAssetStake(uint256,uint256)', 'Valinity Staking · Withdrew asset');

addCall(contract.loan, 'openLoan(address,uint256)', 'Valinity Loan · Opened loan');
addCall(contract.loan, 'increaseLoan(address,uint256)', 'Valinity Loan · Increased loan');
addCall(contract.loan, 'repayLoan(address,uint256)', 'Valinity Loan · Repaid loan');
addCall(contract.loan, 'liquidateUnderwater(address,address[])', 'Valinity Loan · Liquidated loan');
addCall(contract.loan, 'migrateLoans((address,address,uint256,uint256)[])', 'Valinity Loan · Migrated loans');

addCall(contract.yield, 'claimYield(uint8)', 'Valinity Yield · Claimed VY yield');
addCall(contract.yield, 'claimAssetYield(uint256)', 'Valinity Yield · Claimed asset yield');
addCall(contract.portal, 'claim()', 'Valinity Portal · Claimed entitlement');
addCall(contract.buyback, 'executeBuyback()', 'Valinity Buyback · Executed buyback');
addCall(contract.acquisition, 'executeAcquireByLTV()', 'Valinity Acquisition · LTV rebalance');
addCall(contract.acquisition, 'executeAcquireByMTP()', 'Valinity Acquisition · MTP rebalance');

addCall(contract.alliance, 'purchaseTier1WithUSDC(address)', 'Valinity Alliance · Registered');
addCall(contract.alliance, 'purchaseTier1WithETH(address,uint256)', 'Valinity Alliance · Registered');
addCall(contract.alliance, 'purchaseTier2WithUSDC(address)', 'Valinity Alliance · Activated referrer');
addCall(contract.alliance, 'purchaseTier2WithETH(address,uint256)', 'Valinity Alliance · Activated referrer');
addCall(contract.alliance, 'purchaseTier3WithUSDC(address)', 'Valinity Alliance · Activated builder');
addCall(
  contract.alliance,
  'launchVDAO(string,string,uint256,bytes32,uint8,address,uint256,uint256,uint256,address)',
  'Valinity Alliance · Launched V-DAO',
);
addCall(contract.alliance, 'registerAsPartner(address,bool,address)', 'Valinity Alliance · Joined V-DAO as partner');
addCall(contract.alliance, 'fundMyBuilder()', 'Valinity Alliance · Funded builder');
addCall(contract.alliance, 'claimMine()', 'Valinity Alliance · Claimed referral rewards');

// VEO's as-deployed audit supplies canonical selectors for tuple-heavy methods.
addCall(contract.exchange, '0xf0de31e8', 'Valinity Exchange · DAX swap');
addCall(contract.exchange, '0xa71b393f', 'Valinity Exchange · Uniswap V3 swap');
addCall(contract.exchange, '0xcf6012d9', 'Valinity Exchange · Bridged swap');
addCall(contract.exchange, '0x22b34add', 'Valinity Exchange · Minted tokenized stock');
addCall(contract.exchange, '0x49629d75', 'Valinity Exchange · Redeemed tokenized stock');
addCall(contract.exchange, '0xd235111d', 'Valinity Exchange · V-DAO swap');

/** Decode the actual top-level contract and four-byte calldata signature. */
export function actionFromTransaction(transaction: { to?: string | null; input?: string }): string | undefined {
  if (!transaction.to || !transaction.input || transaction.input.length < 10) return undefined;
  return callAction.get(`${lower(transaction.to)}:${transaction.input.slice(0, 10).toLowerCase()}`);
}

export function isKnownActionTarget(address?: string | null): boolean {
  return !!address && actionContracts.has(lower(address));
}

const eventTopic = {
  vyStaked: toEventSelector('Deposit(address,uint8,uint256,uint8,uint256,uint256,uint256,uint256)'),
  vyUnstaked: toEventSelector('Withdraw(address,uint8,uint8,uint256,uint256,uint256,uint256)'),
  assetStaked: toEventSelector('AssetStakeDeposited(address,uint256,address,uint256,uint8,uint256,bool)'),
  assetUnstaked: toEventSelector('AssetStakeWithdrawn(address,uint256,address,uint256,uint256,uint256)'),
  yieldPaid: toEventSelector('YieldPaid(address,uint8,uint256,uint256,uint256,bool)'),
  assetYieldPaid: toEventSelector('AssetYieldPaid(address,uint256,address,uint256,uint256,bool)'),
  loan: toEventSelector('LoanEvent(uint8,address,address,int256,int256,uint256,uint256,uint256,uint256)'),
  portalClaim: toEventSelector('EntitlementClaimed(address,uint256)'),
  acquired: toEventSelector('Acquired(uint8,address,address,uint256,uint256,uint256)'),
  buyback: toEventSelector('BuybackExecuted(address,address,uint256,uint256,uint256,uint256)'),
  tierPurchased: toEventSelector('TierPurchased(address,uint8,uint256,uint256)'),
  vdaoLaunched: toEventSelector('VDAOLaunched(address,address,uint256,uint256)'),
  partnerRegistered: toEventSelector('PartnerRegistered(address,address,uint256)'),
  allianceClaimed: toEventSelector('Claimed(address,uint256)'),
  cctpBridged: toEventSelector('CCTPBridged(address,address,uint256,uint64)'),
} as const;

type ReceiptLog = TransactionReceipt['logs'][number];

const matches = (log: ReceiptLog, address: string, topic: string) =>
  lower(log.address) === address && lower(log.topics[0] ?? '') === topic;

function dataWord(data: `0x${string}`, index: number): bigint | undefined {
  const start = 2 + index * 64;
  const word = data.slice(start, start + 64);
  return word.length === 64 ? BigInt(`0x${word}`) : undefined;
}

/**
 * A receipt can reveal the user-facing protocol action that caused an underlying pool swap.
 * This intentionally returns nothing for an ordinary swap so the side/venue fallback stays exact.
 */
export function actionFromReceipt(receipt: Pick<TransactionReceipt, 'logs'>): string | undefined {
  const logs = receipt.logs;

  if (logs.some((log) => matches(log, contract.staking, eventTopic.vyStaked))) {
    return 'Valinity Staking · Deposited VY';
  }
  if (logs.some((log) => matches(log, contract.staking, eventTopic.vyUnstaked))) {
    return 'Valinity Staking · Withdrew VY';
  }
  if (logs.some((log) => matches(log, contract.staking, eventTopic.assetStaked))) {
    return 'Valinity Staking · Deposited asset';
  }
  if (logs.some((log) => matches(log, contract.staking, eventTopic.assetUnstaked))) {
    return 'Valinity Staking · Withdrew asset';
  }

  const loanLog = logs.find((log) => matches(log, contract.loan, eventTopic.loan));
  if (loanLog) {
    const eventType = loanLog.topics[1] ? Number(BigInt(loanLog.topics[1])) : -1;
    if (eventType === 0) return 'Valinity Loan · Opened loan';
    if (eventType === 1) return 'Valinity Loan · Increased loan';
    if (eventType === 2) return dataWord(loanLog.data, 5) === 0n
      ? 'Valinity Loan · Closed loan'
      : 'Valinity Loan · Repaid loan';
    if (eventType === 3) return 'Valinity Loan · Migrated loan';
    if (eventType === 4) return 'Valinity Loan · Liquidated loan';
  }

  if (logs.some((log) => matches(log, contract.buyback, eventTopic.buyback))) {
    return 'Valinity Buyback · Executed buyback';
  }
  const acquiredLog = logs.find((log) => matches(log, contract.acquisition, eventTopic.acquired));
  if (acquiredLog) {
    const reason = acquiredLog.topics[1] ? Number(BigInt(acquiredLog.topics[1])) : -1;
    return reason === 0
      ? 'Valinity Acquisition · MTP rebalance'
      : 'Valinity Acquisition · LTV rebalance';
  }
  if (logs.some((log) => matches(log, contract.alliance, eventTopic.vdaoLaunched))) {
    return 'Valinity Alliance · Launched V-DAO';
  }
  if (logs.some((log) => matches(log, contract.alliance, eventTopic.partnerRegistered))) {
    return 'Valinity Alliance · Joined V-DAO as partner';
  }
  const tierLog = logs.find((log) => matches(log, contract.alliance, eventTopic.tierPurchased));
  if (tierLog) {
    const tier = tierLog.topics[2] ? Number(BigInt(tierLog.topics[2])) : -1;
    if (tier === 1) return 'Valinity Alliance · Registered';
    if (tier === 2) return 'Valinity Alliance · Activated referrer';
    if (tier === 3) return 'Valinity Alliance · Activated builder';
    if (tier === 4) return 'Valinity Alliance · Reached Tier 4';
  }
  if (logs.some((log) => matches(log, contract.alliance, eventTopic.allianceClaimed))) {
    return 'Valinity Alliance · Claimed referral rewards';
  }
  if (logs.some((log) => matches(log, contract.alliance, eventTopic.cctpBridged))) {
    return 'Valinity Alliance · Funded builder';
  }
  if (logs.some((log) => matches(log, contract.portal, eventTopic.portalClaim))) {
    return 'Valinity Portal · Claimed entitlement';
  }

  const yieldLog = logs.find((log) => matches(log, contract.yield, eventTopic.yieldPaid));
  if (yieldLog && dataWord(yieldLog.data, 3) === 0n) return 'Valinity Yield · Claimed VY yield';

  const assetYieldLog = logs.find((log) => matches(log, contract.yield, eventTopic.assetYieldPaid));
  if (assetYieldLog && dataWord(assetYieldLog.data, 2) === 0n) {
    return 'Valinity Yield · Claimed asset yield';
  }

  return undefined;
}
