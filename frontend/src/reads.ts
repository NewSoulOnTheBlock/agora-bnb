import { Contract } from "ethers";
import {
  readProvider, V4, PONS, AGORA, ZERO, activeToken,
} from "./chain";
import {
  STATE_VIEW_ABI, MEME_HOOK_ABI, FEE_ESCROW_ABI, PONS_TOKEN_ABI,
  TREASURY_ABI, STAKED_AGORA_ABI, REDEEMER_ABI,
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

  const slot0 = await safe(() => sv.getSlot0(id));
  const liquidity = await safe(() => sv.getLiquidity(id));

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
  usdgBalance: bigint | null;
  ethBuffer: bigint | null;
  sleeveAssets: bigint | null;
  sleeveCapBps: bigint | null;
  cumulativeTaxReceived: bigint | null;
};

export async function readReserve(): Promise<Reserve> {
  if (!deployed(AGORA.treasury)) {
    return {
      deployed: false, navWad: null, eligibleSupply: null, floorPerTokenWad: null,
      usdgBalance: null, ethBuffer: null, sleeveAssets: null, sleeveCapBps: null,
      cumulativeTaxReceived: null,
    };
  }
  const t = new Contract(AGORA.treasury, TREASURY_ABI, readProvider);
  const [navWad, eligibleSupply, floorPerTokenWad, usdgBalance, ethBuffer, sleeveAssets, sleeveCapBps, cumulativeTaxReceived] =
    await Promise.all([
      safe(async () => BigInt(await t.nav())),
      safe(async () => BigInt(await t.eligibleSupply())),
      safe(async () => BigInt(await t.floorPerToken())),
      safe(async () => BigInt(await t.usdgBalance())),
      safe(async () => BigInt(await t.ethBuffer())),
      safe(async () => BigInt(await t.sleeveAssets())),
      safe(async () => BigInt(await t.sleeveCapBps())),
      safe(async () => BigInt(await t.cumulativeTaxReceived())),
    ]);
  return {
    deployed: true, navWad, eligibleSupply, floorPerTokenWad, usdgBalance,
    ethBuffer, sleeveAssets, sleeveCapBps, cumulativeTaxReceived,
  };
}

export type Staking = {
  deployed: boolean;
  totalAssets: bigint | null;
  totalShares: bigint | null;
};

export async function readStaking(): Promise<Staking> {
  if (!deployed(AGORA.stakedAgora)) {
    return { deployed: false, totalAssets: null, totalShares: null };
  }
  const s = new Contract(AGORA.stakedAgora, STAKED_AGORA_ABI, readProvider);
  const [totalAssets, totalShares] = await Promise.all([
    safe(async () => BigInt(await s.totalAssets())),
    safe(async () => BigInt(await s.totalSupply())),
  ]);
  return { deployed: true, totalAssets, totalShares };
}

export type RedeemInfo = {
  deployed: boolean;
  haircutBps: bigint | null;
  redeemDelay: bigint | null;
  totalBurned: bigint | null;
};

export async function readRedeemer(): Promise<RedeemInfo> {
  if (!deployed(AGORA.redeemer)) {
    return { deployed: false, haircutBps: null, redeemDelay: null, totalBurned: null };
  }
  const r = new Contract(AGORA.redeemer, REDEEMER_ABI, readProvider);
  const [haircutBps, redeemDelay, totalBurned] = await Promise.all([
    safe(async () => BigInt(await r.haircutBps())),
    safe(async () => BigInt(await r.redeemDelay())),
    safe(async () => BigInt(await r.totalBurned())),
  ]);
  return { deployed: true, haircutBps, redeemDelay, totalBurned };
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
  /** price / floor − 1, as a percentage. Null until both sides are known. */
  premiumPct: number | null;
  fetchedAt: number;
};

export async function readSnapshot(): Promise<Snapshot> {
  const { address, isDemo } = activeToken();
  const blockNumber = await safe(() => readProvider.getBlockNumber());
  const pool = await readPoolState(address);
  const [token, fees, reserve, staking, redeem] = await Promise.all([
    readTokenInfo(address, pool.initialised),
    readFeePipeline(pool.id, AGORA.feeSink),
    readReserve(),
    readStaking(),
    readRedeemer(),
  ]);

  let premiumPct: number | null = null;
  if (pool.priceWad && reserve.floorPerTokenWad && reserve.floorPerTokenWad > 0n) {
    premiumPct =
      (Number(pool.priceWad) / Number(reserve.floorPerTokenWad) - 1) * 100;
  }

  return {
    blockNumber, token, isDemo, pool, fees, reserve, staking, redeem,
    premiumPct, fetchedAt: Date.now(),
  };
}
