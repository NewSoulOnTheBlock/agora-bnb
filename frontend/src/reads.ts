import { Contract } from "ethers";
import {
  readProvider, PANCAKE, TORII, ZERO, activeToken, SUITS_NFT,
} from "./chain";
import {
  STAKED_SUITS_ABI, DISTRIBUTOR_ABI, SUITS_ABI,
} from "./abis";
import { pairFor, priceFromReserves, type Pair } from "./poolkey";
import { multiRead, asBig, asStr, asBool } from "./multicall";

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
  pair: Pair;
  /** The pair address, kept under the old name so callers need no change. */
  id: string;
  reserve0: bigint | null;
  reserve1: bigint | null;
  /** Quote-side depth, in wei of BNB. The honest stand-in for v4 liquidity. */
  liquidity: bigint | null;
  /** Price of the token in the quote currency (BNB), as WAD. */
  priceWad: bigint | null;
  /** False while the pair holds nothing — still on the Flap curve. */
  initialised: boolean;
};

/**
 * The PancakeSwap V2 market for `token`, read straight off the pair.
 *
 * Two calls in one request. `getReserves` is the whole price; `factory.getPair`
 * rides along to separate two states the reserves alone cannot:
 *
 *   pair == address(0)   Flap has not graduated the token; no market exists
 *   pair != 0, empty     graduated, LP not yet in — a real, brief state
 *
 * On the v4 build these were indistinguishable, and reading the second as the
 * first once sent this codebase hunting a decoy pool. Here the factory answers
 * the question directly, so it is asked.
 */
export async function readPoolState(token: string): Promise<PoolState> {
  const pair = pairFor(token);

  const r = await multiRead([
    {
      target: pair.address,
      fragment: "function getReserves() view returns (uint112,uint112,uint32)",
    },
    {
      target: PANCAKE.factory,
      fragment: "function getPair(address,address) view returns (address)",
      args: [pair.token0, pair.token1],
    },
  ]);

  const reserve0 = r[0] && r[0].length ? BigInt(r[0][0] as bigint) : null;
  const reserve1 = r[0] && r[0].length > 1 ? BigInt(r[0][1] as bigint) : null;

  const registered = asStr(r[1]);
  const exists = !!registered && registered !== ZERO;

  const priceWad =
    reserve0 !== null && reserve1 !== null
      ? priceFromReserves(reserve0, reserve1, pair.tokenIsZero)
      : null;

  return {
    pair,
    id: pair.address,
    reserve0,
    reserve1,
    liquidity:
      reserve0 !== null && reserve1 !== null
        ? (pair.tokenIsZero ? reserve1 : reserve0)
        : null,
    priceWad,
    initialised: exists && priceWad !== null,
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
  const r = await multiRead([
    { target: address, fragment: "function name() view returns (string)" },
    { target: address, fragment: "function symbol() view returns (string)" },
    { target: address, fragment: "function totalSupply() view returns (uint256)" },
    { target: address, fragment: "function curve() view returns (address)" },
  ]);
  const curve = asStr(r[3]);
  return {
    address,
    name: asStr(r[0]),
    symbol: asStr(r[1]),
    totalSupply: asBig(r[2]),
    curve,
    graduated: curve === null ? null : poolInitialised,
  };
}

// ---------------------------------------------------------------------------
// Pons fee pipeline — live today. This is the tax, before it ever reaches us.
// ---------------------------------------------------------------------------

export type FeePipeline = {
  /**
   * TORII sitting in the vault, taxed post-graduation and not yet sold.
   * Named for the old shape so the shared UI compiles on both chains.
   */
  pendingCreatorTaxEth: bigint | null;
  /** BNB in the vault, recognised as revenue and awaiting `forwardQuote()`. */
  pendingFeesEth: bigint | null;
  /** Everything the vault has ever pushed into the Treasury. */
  escrowBalanceEth: bigint | null;
  hookFeeBps: bigint | null;
  protocolFeeShareBps: bigint | null;
  /** No gatekeeper on this chain — kept null so the UI can say so. */
  feeSweepOperator: string | null;
};

/**
 * The tax pipeline, which on BNB runs the opposite direction.
 *
 * On Pons the tax accrued inside a hook and had to be *pulled*: `sweepFees` was
 * callable only by an operator Pons controlled, so the pipeline's interesting
 * number was "how much is stuck behind someone else's keeper". v1 died there.
 *
 * Flap **pushes**. The tax arrives at `ToriiVault` as an ordinary transfer and
 * the vault recognises it by balance delta, so nothing is ever gated on a third
 * party. What is worth reading changed to match:
 *
 *   pendingQuote()      BNB recognised, waiting for `forwardQuote()`
 *   pendingTaxToken()   TORII taken as tax after graduation, still unsold
 *   cumulativeForwarded everything that has reached the Treasury
 *
 * `pendingTaxToken` is the one that needs explaining. Post-graduation the tax
 * arrives denominated in TORII, and the Treasury marks TORII at **zero** — a
 * token that backs itself would make the floor self-referentially inflatable.
 * Forwarding that leg raw would therefore grow the balance sheet by nothing, so
 * it has to be sold for BNB first, through `convertAndForward()`. A number
 * sitting here is not lost; it is revenue that has not been converted yet.
 *
 * `pid` is the pair address rather than a v4 poolId, and is unused: the vault
 * is per-token, not per-pool.
 */
export async function readFeePipeline(_pid: string, recipient: string): Promise<FeePipeline> {
  if (!deployed(recipient)) {
    return {
      pendingCreatorTaxEth: null, pendingFeesEth: null, escrowBalanceEth: null,
      hookFeeBps: null, protocolFeeShareBps: null, feeSweepOperator: null,
    };
  }

  const V = recipient;
  const r = await multiRead([
    { target: V, fragment: "function pendingTaxToken() view returns (uint256)" },
    { target: V, fragment: "function pendingQuote() view returns (uint256)" },
    { target: V, fragment: "function cumulativeForwarded() view returns (uint256)" },
  ]);

  return {
    pendingCreatorTaxEth: asBig(r[0]),
    pendingFeesEth: asBig(r[1]),
    escrowBalanceEth: asBig(r[2]),
    // Flap's cut and the creator split are launch parameters fixed by
    // `ToriiVaultFactory._validateBeforeLaunch`, not values the vault exposes.
    hookFeeBps: null,
    protocolFeeShareBps: null,
    feeSweepOperator: null,
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
  if (!deployed(TORII.treasury)) return NO_RESERVE;

  // One `eth_call`, not sixteen. Issued individually these were two sequential
  // waves of parallel reads, and the public endpoint rate-limits a JSON-RPC
  // batch as a batch — the Reserve page was paying for that on every poll.
  const T = TORII.treasury;
  const f = (sig: string) => ({ target: T, fragment: `function ${sig} view returns (uint256)` });

  const r = await multiRead([
    f("nav()"), f("eligibleSupply()"), f("floorPerToken()"), f("floorHighWaterMark()"),
    f("usdgBalance()"), f("ethBuffer()"), f("sleeveAssets()"), f("sleeveCorpus()"),
    f("unrealizedSurplus()"), f("sleeveCapBps()"), f("cumulativeTaxReceived()"),
    f("pendingIncome()"), f("incomeShareBps()"), f("cumulativeIncomeDistributed()"),
    f("cumulativeWithdrawn()"),
    { target: T, fragment: "function operator() view returns (address)" },
  ]);

  return {
    deployed: true,
    navWad: asBig(r[0]),
    eligibleSupply: asBig(r[1]),
    floorPerTokenWad: asBig(r[2]),
    floorHighWaterMark: asBig(r[3]),
    usdgBalance: asBig(r[4]),
    ethBuffer: asBig(r[5]),
    sleeveAssets: asBig(r[6]),
    sleeveCorpus: asBig(r[7]),
    unrealizedSurplus: asBig(r[8]),
    sleeveCapBps: asBig(r[9]),
    cumulativeTaxReceived: asBig(r[10]),
    pendingIncome: asBig(r[11]),
    incomeShareBps: asBig(r[12]),
    cumulativeIncomeDistributed: asBig(r[13]),
    cumulativeWithdrawn: asBig(r[14]),
    operator: asStr(r[15]),
  };
}

export type Staking = {
  deployed: boolean;
  totalAssets: bigint | null;
  /** Raw stTORII supply — 21 decimals, not 18. See `ST_TORII_DECIMALS`. */
  totalShares: bigint | null;
  cumulativeRewards: bigint | null;
  cumulativeClaimed: bigint | null;
};

export async function readStaking(): Promise<Staking> {
  if (!deployed(TORII.stakedAgora)) {
    return { deployed: false, totalAssets: null, totalShares: null, cumulativeRewards: null, cumulativeClaimed: null };
  }
  const A = TORII.stakedAgora;
  const f = (sig: string) => ({ target: A, fragment: `function ${sig} view returns (uint256)` });
  const r = await multiRead([
    f("totalAssets()"), f("totalSupply()"), f("cumulativeRewards()"), f("cumulativeClaimed()"),
  ]);
  return {
    deployed: true,
    totalAssets: asBig(r[0]),
    totalShares: asBig(r[1]),
    cumulativeRewards: asBig(r[2]),
    cumulativeClaimed: asBig(r[3]),
  };
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
  if (!deployed(TORII.redeemer)) {
    return {
      deployed: false, haircutBps: null, redeemDelay: null, totalBurned: null,
      totalPaidOut: null, queueLength: null, epochCapBps: null, epochRemaining: null,
      requestsPaused: null,
    };
  }
  const R = TORII.redeemer;
  const f = (sig: string) => ({ target: R, fragment: `function ${sig} view returns (uint256)` });
  const r = await multiRead([
    f("haircutBps()"), f("redeemDelay()"), f("totalBurned()"), f("totalPaidOut()"),
    f("queueLength()"), f("epochCapBps()"), f("epochRemaining()"),
    { target: R, fragment: "function requestsPaused() view returns (bool)" },
  ]);
  return {
    deployed: true,
    haircutBps: asBig(r[0]),
    redeemDelay: asBig(r[1]),
    totalBurned: asBig(r[2]),
    totalPaidOut: asBig(r[3]),
    queueLength: asBig(r[4]),
    epochCapBps: asBig(r[5]),
    epochRemaining: asBig(r[6]),
    requestsPaused: asBool(r[7]),
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

  if (!deployed(TORII.stakedSuits)) {
    return {
      collection, vaultDeployed: false, totalStaked: null,
      cumulativeRewards: null, cumulativeClaimed: null, shareBps: null,
    };
  }

  const v = new Contract(TORII.stakedSuits, STAKED_SUITS_ABI, readProvider);
  const [totalStaked, cumulativeRewards, cumulativeClaimed] = await Promise.all([
    safe(async () => BigInt(await v.totalStaked())),
    safe(async () => BigInt(await v.cumulativeRewards())),
    safe(async () => BigInt(await v.cumulativeClaimed())),
  ]);

  const shareBps = deployed(TORII.distributor)
    ? await safe(async () =>
        BigInt(await new Contract(TORII.distributor, DISTRIBUTOR_ABI, readProvider).suitsBps())
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
    readFeePipeline(pool.id, TORII.feeSink),
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
