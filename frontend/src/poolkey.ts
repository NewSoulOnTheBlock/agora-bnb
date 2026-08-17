import { AbiCoder, keccak256, getAddress } from "ethers";
import { PONS, ZERO } from "./chain";

export type PoolKey = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

/**
 * Build the PoolKey for a Pons v2 pool.
 *
 * v4 requires currency0 < currency1 by address. Native ETH is address(0), so an
 * ETH-paired pool always has ETH as currency0 — but we sort explicitly anyway so
 * that a USDG-paired launch works without a second code path.
 */
export function ponsPoolKey(token: string, quote: string = ZERO): PoolKey {
  const a = getAddress(token);
  const b = getAddress(quote);
  const [currency0, currency1] =
    BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return {
    currency0,
    currency1,
    fee: PONS.poolFee, // 0 — the hook applies fees dynamically
    tickSpacing: PONS.tickSpacing, // 200
    hooks: getAddress(PONS.memeHook),
  };
}

/**
 * poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
 *
 * Verified against a live pool's Initialize event on chain 4663 — the computed
 * hash matched the event's indexed poolId exactly.
 */
export function poolId(key: PoolKey): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint24", "int24", "address"],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
    )
  );
}

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const WAD = 10n ** 18n;

/**
 * Price of `token` denominated in the quote currency, as a WAD (1e18) bigint.
 *
 * sqrtPriceX96 encodes sqrt(amount1/amount0) * 2^96, i.e. the price of
 * currency0 measured in currency1. Which side our token sits on decides whether
 * we invert. Everything stays in bigint until the final formatting step —
 * squaring a uint160 overflows a JS number badly.
 *
 * Assumes both currencies are 18 decimals (true for ETH and Pons tokens). A
 * USDG pair would need a decimals adjustment here.
 */
export function priceFromSqrtX96(
  sqrtPriceX96: bigint,
  key: PoolKey,
  token: string
): bigint | null {
  if (sqrtPriceX96 === 0n) return null; // pool not initialised
  const priceX192 = sqrtPriceX96 * sqrtPriceX96; // (amount1/amount0) * 2^192
  const tokenIsCurrency0 =
    getAddress(token) === getAddress(key.currency0);

  if (tokenIsCurrency0) {
    // price of token = currency1 per currency0
    return (priceX192 * WAD) / Q192;
  }
  // token is currency1 → invert: currency0 per currency1
  if (priceX192 === 0n) return null;
  return (Q192 * WAD) / priceX192;
}

/** Human-readable sanity helper: sqrtPriceX96 → float, for logs only. */
export function sqrtToFloat(sqrtPriceX96: bigint): number {
  return Number(sqrtPriceX96) / Number(Q96);
}
