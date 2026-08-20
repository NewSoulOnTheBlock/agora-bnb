import { getAddress, getCreate2Address, keccak256, solidityPacked } from "ethers";
import { PANCAKE, WBNB_ADDR, ZERO } from "./chain";

/**
 * Finding and pricing the TORII market on PancakeSwap V2.
 *
 * ## What this file replaced
 *
 * On Robinhood Chain this module built a Uniswap v4 `PoolKey`, hashed it into a
 * `poolId`, and read `sqrtPriceX96` back out of a separate `StateView` contract.
 * None of that exists here. A PancakeSwap V2 market is one contract holding two
 * `uint112` reserves, and its address is a pure function of the two token
 * addresses — so the pool is *derived*, not looked up, and the price is a
 * division rather than a square.
 *
 * That removes the trap the v4 version carried. There, a freshly graduated pool
 * read zero until its LP was seeded, which looked exactly like a wrong key and
 * once sent this build chasing a decoy pool. Here a pair with no liquidity has
 * literally no code at that address until someone creates it, so "not yet" and
 * "wrong address" are distinguishable facts.
 */

export type Pair = {
  /** The pair contract. May hold no code yet — see `pairExists`. */
  address: string;
  token0: string;
  token1: string;
  /** True when TORII is `token0`, which decides which way to divide. */
  tokenIsZero: boolean;
};

/**
 * PancakeSwap V2 pair init code hash.
 *
 * NOT the Uniswap V2 one — Pancake forked and recompiled, so the hashes differ
 * and the Uniswap value silently yields a plausible-looking address that holds
 * nothing. Verified by deriving the live WBNB/USDT pair and matching the
 * factory's own answer byte for byte:
 *
 *   derived  0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE
 *   factory  0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE
 */
const INIT_CODE_HASH =
  "0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5";

/** Sort two addresses the way the factory does before hashing. */
export function sortTokens(a: string, b: string): [string, string] {
  const x = getAddress(a);
  const y = getAddress(b);
  return BigInt(x) < BigInt(y) ? [x, y] : [y, x];
}

/**
 * The pair address for `token` against `quote`, computed rather than queried.
 *
 * Native BNB is written as `address(0)` throughout this codebase; a pair is
 * always against **wrapped** BNB, so the zero address is translated here rather
 * than at every call site.
 */
export function pairFor(token: string, quote: string = ZERO): Pair {
  const a = getAddress(token);
  const b = getAddress(quote === ZERO ? WBNB_ADDR : quote);
  const [token0, token1] = sortTokens(a, b);

  const salt = keccak256(solidityPacked(["address", "address"], [token0, token1]));
  const address = getCreate2Address(PANCAKE.factory, salt, INIT_CODE_HASH);

  return { address, token0, token1, tokenIsZero: token0.toLowerCase() === a.toLowerCase() };
}

const WAD = 10n ** 18n;

/**
 * Price of the token in the quote asset, as a WAD.
 *
 * Both sides are assumed 18 decimals, which holds for every pairing this app
 * uses: BNB, WBNB and Binance-Peg USDT are all 18 on BSC — note that USDT is 6
 * decimals on Ethereum and 18 here, which is a standing trap when porting code
 * between the two.
 *
 * Returns null on an empty reserve rather than dividing by zero. A pair that
 * exists but holds nothing is a real state on a launch that has just graduated.
 */
export function priceFromReserves(
  reserve0: bigint,
  reserve1: bigint,
  tokenIsZero: boolean
): bigint | null {
  const tokenReserve = tokenIsZero ? reserve0 : reserve1;
  const quoteReserve = tokenIsZero ? reserve1 : reserve0;
  if (tokenReserve === 0n || quoteReserve === 0n) return null;
  return (quoteReserve * WAD) / tokenReserve;
}

/**
 * Constant-product output, fee included — the same arithmetic the router runs.
 *
 * PancakeSwap V2 takes 0.25%, applied to the input before the invariant, so the
 * numerator is scaled by 9975 and the denominator by 10000. Quoting without the
 * fee overstates the output by a quarter of a percent, which is enough to make
 * a minimum-out bound reject a perfectly good trade.
 */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const withFee = amountIn * 9975n;
  return (withFee * reserveOut) / (reserveIn * 10000n + withFee);
}

/** The inverse: how much input buys exactly `amountOut`. Rounds up, as V2 does. */
export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut <= 0n || reserveIn <= 0n || reserveOut <= amountOut) return 0n;
  return (reserveIn * amountOut * 10000n) / ((reserveOut - amountOut) * 9975n) + 1n;
}
