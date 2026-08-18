import { Contract } from "ethers";
import {
  readProvider, V4, PONS, AGORA, ZERO, activeToken, SUITS_NFT,
} from "./chain";
import {
  STATE_VIEW_ABI, MEME_HOOK_ABI, FEE_ESCROW_ABI, PONS_TOKEN_ABI,
  TREASURY_ABI, STAKED_AGORA_ABI, REDEEMER_ABI, STAKED_SUITS_ABI,
  DISTRIBUTOR_ABI, SUITS_ABI,
} from "./abis";
import { ponsPoolKey, poolId, priceFromSqrtX96, type PoolKey } from "./poolkey";

/**
 * Every read returns `null` on failure rather than throwing.
 *
 * This matters because most of TITHE's own contracts do not exist yet. A page
 * whose job is to be verifiable must render "unknown" honestly instead of
 * showing a zero that looks like a real measurement.
 */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Guard: a contract at the zero address is "not deployed", not "broken". */
function deployed(addr: string): boolean {
  return !!addr && addr !== ZERO;
}

// ---------------------------------------------------------------------------
// Pool state — live today
// ---------------------------------------------------------------------------

export type PoolState = {
  key: PoolKey;
  id: string;
  sqrtPriceX96: bigint | null;
  tick: number | null;
  liquidity: bigint | null;
  /** Price of the token in the quote currency (ETH), as WAD. */
  priceWad: bigint | null;
  /** False when the pool has never been initialised (still on the curve). */
  initialised: boolean;
};

export async function readPoolState(token: string): Promise<PoolState> {
  const key = ponsPoolKey(token);
  const id = poolId(key);
  const sv = new Contract(V4.stateView, STATE_VIEW_ABI, readProvider);

  // One wave, not two: these are independent reads and awaiting them in
  // sequence cost an extra round-trip on every poll.
  const [slot0, liquidity] = await Promise.all([
    safe(() => sv.getSlot0(id)),
    safe(() => sv.getLiquidity(id)),
  ]);

  const sqrtPriceX96: bigint | null = slot0 ? BigInt(slot0[0]) : null;
  const tick = slot0 ? Number(slot0[1]) : null;

  return {
    key,
    id,
    sqrtPriceX96,
    tick,
    liquidity: liquidity === null ? null : BigInt(liquidity),
    priceWad: sqrtPriceX96 ? priceFromSqrtX96(sqrtPriceX96, key, token) : null,
    initialised: !!sqrtPriceX96 && sqrtPriceX96 > 0n,
  };
}

// ---------------------------------------------------------------------------
// Token metadata + graduation state — live today
// ---------------------------------------------------------------------------

export type TokenInfo = {
  address: string;
  name: string | null;
  symbol: string | null;
  totalSupply: bigint | null;
  curve: string | null;
  /** Pons tokens keep a curve() pointer; a live pool means it has graduated. */
  graduated: boolean | null;
};

export async function readTokenInfo(address: string, poolInitialised: boolean): Promise<TokenInfo> {
  const t = new Contract(address, PONS_TOKEN_ABI, readProvider);
  const [name, symbol, totalSupply, curve] = await Promise.all([
    safe(() => t.name() as Promise<string>),
    safe(() => t.symbol() as Promise<string>),
    safe(async () => BigInt(await t.totalSupply())),
    safe(() => t.curve() as Promise<string>),
  ]);
  return {
    address,
    name,
    symbol,
    totalSupply,
    curve,
    graduated: curve === null ? null : poolInitialised,
  };
}

// ---------------------------------------------------------------------------
// Pons fee pipeline — live today. This is the tax, before it ever reaches us.
// ---------------------------------------------------------------------------

export type FeePipeline = {
  /** Accrued in the hook, NOT yet swept. Only Pons's operator can sweep. */
  pendingCreatorTaxEth: bigint | null;
  pendingFeesEth: bigint | null;
  /** Swept into escrow, claimable by us. */
  escrowBalanceEth: bigint | null;
  hookFeeBps: bigint | null;
  protocolFeeShareBps: bigint | null;
  /** Confirms the sweep gatekeeper is still who we recorded. */
  feeSweepOperator: string | null;
};

export async function readFeePipeline(pid: string, recipient: string): Promise<FeePipeline> {
  const hook = new Contract(PONS.memeHook, MEME_HOOK_ABI, readProvider);
  const escrow = new Contract(PONS.feeEscrow, FEE_ESCROW_ABI, readProvider);

  const [pendingCreatorTaxEth, pendingFeesEth, hookFeeBps, protocolFeeShareBps, feeSweepOperator] =
    await Promise.all([
      safe(async () => BigInt(await hook.pendingCreatorTax(pid, ZERO))),
      safe(async () => BigInt(await hook.pendingFees(pid, ZERO))),
      safe(async () => BigInt(await hook.hookFeeBps())),
      safe(async () => BigInt(await hook.protocolFeeShareBps())),
      safe(() => hook.feeSweepOperator() as Promise<string>),
    ]);

  const escrowBalanceEth = deployed(recipient)
    ? await safe(async () => BigInt(await escrow.balanceOf(recipient)))
    : null;

  return {
    pendingCreatorTaxEth, pendingFeesEth, escrowBalanceEth,
    hookFeeBps, protocolFeeShareBps, feeSweepOperator,
  };
}

// ---------------------------------------------------------------------------
// TITHE reserve — all null until the contracts ship
// ---------------------------------------------------------------------------

export type Reserve = {
  deployed: boolean;
  navWad: bigint | null;
  eligibleSupply: bigint | null;
  floorPerTokenWad: bigint | null;
  floorHighWaterMark: bigint | null;
  usdgBalance: bigint | null;
  ethBuffer: bigint | null;
  sleeveAssets: bigint | null;
  sleeveCorpus: bigint | null;
  unrealizedSurplus: bigint | null;
  sleeveCapBps: bigint | null;
  cumulativeTaxReceived: bigint | null;
  /** Owed to stakers. Deliberately NOT part of nav(). */
  pendingIncome: bigint | null;
  incomeShareBps: bigint | null;
  cumulativeIncomeDistributed: bigint | null;
  /** Corpus ETH taken out for off-contract yield deployment. */
  cumulativeWithdrawn: bigint | null;
  operator: string | null;
};

const NO_RESERVE: Reserve = {
  deployed: false, navWad: null, eligibleSupply: null, floorPerTokenWad: null,
  floorHighWaterMark: null, usdgBalance: null, ethBuffer: null, sleeveAssets: null,
  sleeveCorpus: null, unrealizedSurplus: null, sleeveCapBps: null,
  cumulativeTaxReceived: null, pendingIncome: null, incomeShareBps: null,
  cumulativeIncomeDistributed: null, cumulativeWithdrawn: null, operator: null,
};

export async function readReserve(): Promise<Reserve> {
  if (!deployed(AGORA.treasury)) return NO_RESERVE;

  const t = new Contract(AGORA.treasury, TREASURY_ABI, readProvider);
  const [
    navWad, eligibleSupply, floorPerTokenWad, floorHighWaterMark, usdgBalance,
    ethBuffer, sleeveAssets, sleeveCorpus, unrealizedSurplus, sleeveCapBps,
    cumulativeTaxReceived, pendingIncome, incomeShareBps, cumulativeIncomeDistributed,
    cumulativeWithdrawn, operator,
  ] = await Promise.all([
    safe(async () => BigInt(await t.nav())),
    safe(async () => BigInt(await t.eligibleSupply())),
    safe(async () => BigInt(await t.floorPerToken())),
    safe(async () => BigInt(await t.floorHighWaterMark())),
    safe(async () => BigInt(await t.usdgBalance())),
    safe(async () => BigInt(await t.ethBuffer())),
    safe(async () => BigInt(await t.sleeveAssets())),
    safe(async () => BigInt(await t.sleeveCorpus())),
    safe(async () => BigInt(await t.unrealizedSurplus())),
    safe(async () => BigInt(await t.sleeveCapBps())),
    safe(async () => BigInt(await t.cumulativeTaxReceived())),
    safe(async () => BigInt(await t.pendingIncome())),
    safe(async () => BigInt(await t.incomeShareBps())),
    safe(async () => BigInt(await t.cumulativeIncomeDistributed())),
    // Folded into the same wave. These were a second `await Promise.all`, which
    // bought a whole extra round-trip for two values nothing else depends on.
    safe(async () => BigInt(await t.cumulativeWithdrawn())),
    safe(() => t.operator() as Promise<string>),
  ]);
  return {
    deployed: true, navWad, eligibleSupply, floorPerTokenWad, floorHighWaterMark,
    usdgBalance, ethBuffer, sleeveAssets, sleeveCorpus, unrealizedSurplus,
    sleeveCapBps, cumulativeTaxReceived, pendingIncome, incomeShareBps,
    cumulativeIncomeDistributed, cumulativeWithdrawn, operator,
  };
}

export type Staking = {
  deployed: boolean;
  totalAssets: bigint | null;
  totalShares: bigint | null;
  cumulativeRewards: bigint | null;
  cumulativeClaimed: bigint | null;
};

export async function readStaking(): Promise<Staking> {
  if (!deployed(AGORA.stakedAgora)) {
    return { deployed: false, totalAssets: null, totalShares: null, cumulativeRewards: null, cumulativeClaimed: null };
  }
  const s = new Contract(AGORA.stakedAgora, STAKED_AGORA_ABI, readProvider);
  const [totalAssets, totalShares, cumulativeRewards, cumulativeClaimed] = await Promise.all([
    safe(async () => BigInt(await s.totalAssets())),
    safe(async () => BigInt(await s.totalSupply())),
    safe(async () => BigInt(await s.cumulativeRewards())),
    safe(async () => BigInt(await s.cumulativeClaimed())),
  ]);
  return { deployed: true, totalAssets, totalShares, cumulativeRewards, cumulativeClaimed };
}

export type RedeemInfo = {
  deployed: boolean;
  haircutBps: bigint | null;
  redeemDelay: bigint | null;
  totalBurned: bigint | null;
  totalPaidOut: bigint | null;
  queueLength: bigint | null;
  epochCapBps: bigint | null;
  epochRemaining: bigint | null;
  requestsPaused: boolean | null;
};

export async function readRedeemer(): Promise<RedeemInfo> {
  if (!deployed(AGORA.redeemer)) {
    return {
      deployed: false, haircutBps: null, redeemDelay: null, totalBurned: null,
      totalPaidOut: null, queueLength: null, epochCapBps: null, epochRemaining: null,
      requestsPaused: null,
    };
  }
  const r = new Contract(AGORA.redeemer, REDEEMER_ABI, readProvider);
  const [haircutBps, redeemDelay, totalBurned, totalPaidOut, queueLength, epochCapBps, epochRemaining, requestsPaused] =
    await Promise.all([
      safe(async () => BigInt(await r.haircutBps())),
      safe(async () => BigInt(await r.redeemDelay())),
      safe(async () => BigInt(await r.totalBurned())),
      safe(async () => BigInt(await r.totalPaidOut())),
      safe(async () => BigInt(await r.queueLength())),
      safe(async () => BigInt(await r.epochCapBps())),
      safe(async () => BigInt(await r.epochRemaining())),
      safe(async () => (await r.requestsPaused()) as boolean),
    ]);
  return {
    deployed: true, haircutBps, redeemDelay, totalBurned, totalPaidOut,
    queueLength, epochCapBps, epochRemaining, requestsPaused,
  };
}

// ---------------------------------------------------------------------------
// Suits NFT staking. The collection is LIVE even while the vault is not, so
// collection reads and vault reads are reported separately.
// ---------------------------------------------------------------------------

export type SuitsInfo = {
  /** The ERC-721 itself — live regardless of the relaunch. */
  collection: {
    name: string | null;
    totalSupply: bigint | null;
    transferValidator: string | null;
  };
  vaultDeployed: boolean;
  totalStaked: bigint | null;
  cumulativeRewards: bigint | null;
  cumulativeClaimed: bigint | null;
  shareBps: bigint | null;
};

export async function readSuits(): Promise<SuitsInfo> {
  const nft = new Contract(SUITS_NFT, SUITS_ABI, readProvider);
  const [name, totalSupply, transferValidator] = await Promise.all([
    safe(() => nft.name() as Promise<string>),
    safe(async () => BigInt(await nft.totalSupply())),
    safe(() => nft.getTransferValidator() as Promise<string>),
  ]);
  const collection = { name, totalSupply, transferValidator };

  if (!deployed(AGORA.stakedSuits)) {
    return {
      collection, vaultDeployed: false, totalStaked: null,
      cumulativeRewards: null, cumulativeClaimed: null, shareBps: null,
    };
  }

  const v = new Contract(AGORA.stakedSuits, STAKED_SUITS_ABI, readProvider);
  const [totalStaked, cumulativeRewards, cumulativeClaimed] = await Promise.all([
    safe(async () => BigInt(await v.totalStaked())),
    safe(async () => BigInt(await v.cumulativeRewards())),
    safe(async () => BigInt(await v.cumulativeClaimed())),
  ]);

  const shareBps = deployed(AGORA.distributor)
    ? await safe(async () =>
        BigInt(await new Contract(AGORA.distributor, DISTRIBUTOR_ABI, readProvider).suitsBps())
      )
    : null;

  return { collection, vaultDeployed: true, totalStaked, cumulativeRewards, cumulativeClaimed, shareBps };
}

// ---------------------------------------------------------------------------
// Composite snapshot
// ---------------------------------------------------------------------------

export type Snapshot = {
  blockNumber: number | null;
  token: TokenInfo;
  isDemo: boolean;
  pool: PoolState;
  fees: FeePipeline;
  reserve: Reserve;
  staking: Staking;
  redeem: RedeemInfo;
  suits: SuitsInfo;
  /** price / floor − 1, as a percentage. Null until both sides are known. */
  premiumPct: number | null;
  fetchedAt: number;
};

export async function readSnapshot(): Promise<Snapshot> {
  const { address, isDemo } = activeToken();
  const blockNumber = await safe(() => readProvider.getBlockNumber());
  const pool = await readPoolState(address);
  const [token, fees, reserve, staking, redeem, suits] = await Promise.all([
    readTokenInfo(address, pool.initialised),
    readFeePipeline(pool.id, AGORA.feeSink),
    readReserve(),
    readStaking(),
    readRedeemer(),
    readSuits(),
  ]);

  let premiumPct: number | null = null;
  if (pool.priceWad && reserve.floorPerTokenWad && reserve.floorPerTokenWad > 0n) {
    premiumPct =
      (Number(pool.priceWad) / Number(reserve.floorPerTokenWad) - 1) * 100;
  }

  return {
    blockNumber, token, isDemo, pool, fees, reserve, staking, redeem, suits,
    premiumPct, fetchedAt: Date.now(),
  };
}
