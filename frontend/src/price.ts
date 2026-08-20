import { readProvider, WBNB_USDT_PAIR, WBNB_ADDR, USDT_DECIMALS } from "./chain";
import { multiRead, asStr } from "./multicall";

/**
 * BNB priced in dollars, from the chain.
 *
 * ## Why not Chainlink, when Chainlink is actually here
 *
 * On chain 4663 there was no verified ETH/USD aggregator at all, so a DEX pair
 * was the only option. BNB Chain does have one — that argument does not carry
 * over, and it should not be pretended that it does.
 *
 * The reason is different and it still holds: **nothing reads this number
 * back.** It is the grey dollar line under an amount. The floor, redemption and
 * every NAV stay BNB-denominated end to end. Given that, a pair keeps the
 * page's one real promise — every figure on it is re-derivable from the RPC
 * alone, with no key, no CORS and no third party's uptime — and an oracle would
 * spend that promise on a number that decides nothing.
 *
 * ## The limit, stated plainly
 *
 * This is a **spot DEX price, not an oracle**. It is manipulable within a block
 * by anyone willing to move that pair. Display only. If a future feature ever
 * needs USD to decide money, use the Chainlink feed for that and leave this
 * where it is.
 *
 * Cross-checked against DexScreener's independent figure for the same pair:
 * **$652.36 vs $652.58, 0.033% apart.**
 */

/**
 * Two things changed from the v3 version, and both would have failed silently.
 *
 * A PancakeSwap V2 pair has **no `slot0()`** — that is a Uniswap v3 function.
 * Calling it here decodes to null and the dollar line simply disappears, with
 * nothing anywhere saying why.
 *
 * And USDT on BSC has **18 decimals**, not the 6 it has on Ethereum. The v3
 * maths scaled by `1e12` to bridge that gap; carrying that over would have
 * reported BNB at about six hundred trillion dollars.
 */
export async function readEthUsd(): Promise<number | null> {
  const r = await multiRead([
    {
      target: WBNB_USDT_PAIR,
      fragment: "function getReserves() view returns (uint112,uint112,uint32)",
    },
    { target: WBNB_USDT_PAIR, fragment: "function token0() view returns (address)" },
  ]);

  if (!r[0] || r[0].length < 2) return null;
  const reserve0 = BigInt(r[0][0] as bigint);
  const reserve1 = BigInt(r[0][1] as bigint);

  const token0 = asStr(r[1]);
  if (!token0 || reserve0 === 0n || reserve1 === 0n) return null;

  // Read live: this pair has USDT as token0 and WBNB as token1. Ordering is a
  // property of the two addresses and cannot change for a fixed pair, but it is
  // checked rather than assumed — the sorted order is not obvious by eye, and
  // getting it backwards yields a confident, wrong, and very small number.
  const wbnbIsToken0 = token0.toLowerCase() === WBNB_ADDR.toLowerCase();
  const wbnbReserve = wbnbIsToken0 ? reserve0 : reserve1;
  const usdtReserve = wbnbIsToken0 ? reserve1 : reserve0;

  // Both sides are 18 decimals on BSC, so the ratio is already dollars per BNB.
  const scale = 10 ** (18 - USDT_DECIMALS);
  const usd = (Number(usdtReserve) / Number(wbnbReserve)) * scale;

  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

/** Wei → dollars, given a USD/BNB rate. */
export function weiToUsd(wei: bigint | null | undefined, ethUsd: number | null): number | null {
  if (wei === null || wei === undefined || ethUsd === null) return null;
  return (Number(wei) / 1e18) * ethUsd;
}

/**
 * Dollars, formatted for a dashboard rather than an invoice: no cents above a
 * hundred dollars, and a `<$0.01` floor so a dust figure does not render as a
 * confident zero.
 */
export function fmtUsd(v: number | null): string | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (v === 0) return "$0";
  if (Math.abs(v) < 0.01) return "<$0.01";
  const digits = Math.abs(v) >= 100 ? 0 : 2;
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** Convenience: wei straight to a formatted dollar string. */
export function usdOf(wei: bigint | null | undefined, ethUsd: number | null): string | null {
  return fmtUsd(weiToUsd(wei, ethUsd));
}

export { readProvider };
