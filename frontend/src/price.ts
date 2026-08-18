import { readProvider, WETH_USDG_POOL, WETH_ADDR } from "./chain";
import { multiRead, asBig, asStr } from "./multicall";

/**
 * ETH priced in dollars, from the chain.
 *
 * `ETH_USD_FEED` is deliberately null in `chain.ts`: no Chainlink aggregator has
 * been verified on 4663, and inventing an address would put wrong dollar
 * figures on a page whose whole claim is that its numbers are checkable. That
 * reasoning still stands — but it rules out an *unverified oracle*, not a price.
 *
 * USDG is Paxos's Global Dollar, six decimals, and the WETH/USDG Uniswap v3
 * pool is right there. Its spot price is a dollar quote for ETH that needs no
 * key, no CORS, no third-party uptime, and can be re-derived by anyone with the
 * RPC. Cross-checked against DexScreener's independent figure: **$1,911.14 vs
 * $1,913.64, 0.13% apart.**
 *
 * ## The limit, stated plainly
 *
 * This is a **spot DEX price, not an oracle**. It is manipulable within a block
 * by anyone willing to move that pool. So it is used for *display only* — the
 * dollar line under a figure — and touches nothing that decides money. The
 * floor, redemption and the adapter's NAV all stay ETH-denominated and never
 * see this number. Keep it that way.
 */

/** USD per 1 ETH, or null when the pool cannot be read. */
export async function readEthUsd(): Promise<number | null> {
  const r = await multiRead([
    { target: WETH_USDG_POOL, fragment: "function slot0() view returns (uint160)" },
    { target: WETH_USDG_POOL, fragment: "function token0() view returns (address)" },
  ]);

  const sqrt = asBig(r[0]);
  const token0 = asStr(r[1]);
  if (sqrt === null || sqrt === 0n || !token0) return null;

  // The maths below assumes WETH is token0 and USDG token1. If the pool is ever
  // redeployed the other way round, returning null beats silently inverting.
  if (token0.toLowerCase() !== WETH_ADDR.toLowerCase()) return null;

  const p = Number(sqrt) / 2 ** 96;
  // price = USDG per WETH in raw units; USDG has 6 decimals against WETH's 18,
  // so scale by 1e12 to get dollars per whole ETH.
  const usd = p * p * 1e12;

  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

/** Wei → dollars, given a USD/ETH rate. */
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
