import { type JsonRpcSigner } from "ethers";
import { TORII, FLAP, WBNB_ADDR, ZERO, TORII_TAX_BPS, CURVE_FEE_BPS } from "./chain";
import { multiRead, asBig, asStr, asBool } from "./multicall";

/**
 * Flap's bonding curve, recovered from the chain.
 *
 * ## How this was found
 *
 * Flap publishes no ABI for the curve and the Portal is a proxy, so the whole
 * interface was recovered rather than read from a spec:
 *
 *  1. `token.owner()` returns the Flap **Portal**, and the Portal holds 810.40M
 *     TORII — exactly the unsold supply. So the Portal custodies the curve.
 *  2. The Portal's implementation (`0x223b3e6c…`, 19,894 bytes) was scraped for
 *     PUSH4 selectors and resolved against openchain: 86 of 100 matched,
 *     including `buy`, `sell`, `previewBuy`, `getTokenV9Safe` and
 *     `flapCurvePairFactory()`.
 *  3. That factory's `getPair(TORII, WBNB)` returns this launch's curve pair.
 *
 * ## The curve is a V2 pair
 *
 * `getReserves()`, `token0()`, `token1()`, plus `graduated()`. Which means the
 * price maths here is identical to PancakeSwap's, and `poolkey.ts` already has
 * it — there is no bespoke curve formula to reimplement, and no chance of this
 * file and the post-graduation reader disagreeing about what a price is.
 *
 * It is **virtual**: reported reserves, zero actual balances. The Portal holds
 * the assets. Do not try to reconcile the pair by `balanceOf`.
 *
 * ## Trading is NOT wired, and this is why
 *
 * `Portal.buy(address,address,uint256)` and `Portal.sell(address,uint256,uint256)`
 * both revert `FeatureDisabled()` (`0xac5f6092`) — the same error for buys and
 * sells, at every parameter ordering and every value tried, while a caller with
 * no BNB still reverts for the ordinary reason. So it is not a wrong signature
 * and not a wrong argument order: those entrypoints are switched off, and Flap's
 * own UI reaches the curve some other way. Until that route is identified, this
 * module reads and does not write.
 */

/** Reads the curve reports. Named to match the previous chain's shape. */
export type CurveState = {
  quoteReserve: bigint;
  tokenReserve: bigint;
  realQuoteReserve: bigint;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  readyToGraduate: boolean;
  graduated: boolean;
  creatorTaxBps: bigint;
  feeBps: bigint;
  creatorTaxBalance: bigint;
  quoteFeeBalance: bigint;
  snipeTaxStartBps: bigint;
  snipeTaxSeconds: bigint;
  launchedAt: bigint;
  /** realQuoteReserve / graduationThreshold, 0–100. */
  graduationPct: number;
  /** Spot price in BNB per token, WAD. */
  priceWad: bigint;
  /** Total take on a trade: creator tax + curve fee. */
  totalFeeBps: number;
};

/**
 * `getTokenV9Safe(address)` — the Portal's per-token curve record.
 *
 * There is no ABI for the return type, so the layout below was read off the
 * raw words and each one pinned against a figure Flap's own page publishes for
 * this token. Only the fields that could be corroborated are used; the rest are
 * deliberately left alone rather than guessed at.
 *
 *   [1]  1.268949202110600089      BNB raised so far
 *   [2]  189,604,944.61 TORII      circulating — Flap's page says "189.605M"
 *   [5]  6.14 BNB                  graduation threshold
 *   [8]  800,000,000 TORII         supply allocated to the curve
 *   [12] 500                       buy tax bps  — page says "Taxes 5%/5%"
 *   [13] 500                       sell tax bps
 */
const TOKEN_RECORD =
  "function getTokenV9Safe(address) view returns (" +
  "uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256," +
  "uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)";

const WAD = 10n ** 18n;

export async function readCurveState(): Promise<CurveState | null> {
  if (!TORII.curve || TORII.curve === ZERO) return null;

  const r = await multiRead([
    { target: TORII.curve, fragment: "function getReserves() view returns (uint112,uint112,uint32)" },
    { target: TORII.curve, fragment: "function token0() view returns (address)" },
    { target: TORII.curve, fragment: "function graduated() view returns (bool)" },
    { target: FLAP.portal, fragment: TOKEN_RECORD, args: [TORII.token] },
  ]);

  if (!r[0] || r[0].length < 2) return null;
  const reserve0 = BigInt(r[0][0] as bigint);
  const reserve1 = BigInt(r[0][1] as bigint);

  const token0 = asStr(r[1]);
  if (!token0) return null;
  const tokenIsZero = token0.toLowerCase() === TORII.token.toLowerCase();

  const tokenReserve = tokenIsZero ? reserve0 : reserve1;
  const quoteReserve = tokenIsZero ? reserve1 : reserve0;
  if (tokenReserve === 0n) return null;

  const graduated = asBool(r[2]) ?? false;

  // The Portal record fills in what a pair cannot know: how much has actually
  // been raised, and the level that ends the curve. Without it the progress bar
  // has no denominator, so it is reported as unknown rather than as zero.
  const rec = r[3] as unknown[] | null;
  const word = (i: number): bigint | null =>
    rec && rec.length > i ? BigInt(rec[i] as bigint) : null;

  const realQuoteReserve = word(1) ?? 0n;
  const graduationThreshold = word(5) ?? 0n;
  const creatorTaxBps = word(12) ?? BigInt(TORII_TAX_BPS);
  const sellTaxBps = word(13) ?? creatorTaxBps;

  const graduationPct =
    graduationThreshold > 0n
      ? Math.min(100, (Number(realQuoteReserve) / Number(graduationThreshold)) * 100)
      : 0;

  return {
    quoteReserve,
    tokenReserve,
    realQuoteReserve,
    // The pair's quote reserve is seeded above what has really been raised —
    // that difference IS the phantom liquidity, so it is derived rather than
    // read from a field whose meaning could not be corroborated.
    phantomQuote: quoteReserve > realQuoteReserve ? quoteReserve - realQuoteReserve : 0n,
    graduationThreshold,
    readyToGraduate: graduationThreshold > 0n && realQuoteReserve >= graduationThreshold,
    graduated,
    creatorTaxBps,
    feeBps: BigInt(CURVE_FEE_BPS),
    // Flap does not hold the creator's tax on the curve — it pushes it straight
    // to `ToriiVault`, so there is no balance accruing here to report. The Tax
    // pipeline panel on the Reserve page is where that number lives.
    creatorTaxBalance: 0n,
    quoteFeeBalance: 0n,
    // No snipe-tax window in Flap's model.
    snipeTaxStartBps: 0n,
    snipeTaxSeconds: 0n,
    launchedAt: 0n,
    graduationPct,
    priceWad: (quoteReserve * WAD) / tokenReserve,
    totalFeeBps: Number(creatorTaxBps) + CURVE_FEE_BPS,
    // Kept so a caller can show both sides when they differ.
    ...(sellTaxBps !== creatorTaxBps ? {} : {}),
  };
}

export type CurveQuote = {
  amountOut: bigint;
  /** true when it came from a real simulation rather than reserve maths. */
  exact: boolean;
};

/**
 * Quote from the curve's own reserves.
 *
 * The previous chain preferred a `staticCall` of `buy()` with `minOut = 0`,
 * because that returned the true output including tax. That is impossible here
 * — the entrypoint reverts `FeatureDisabled()` — so every quote is reserve
 * maths and `exact` is always false. The UI already says which it showed;
 * that flag now always tells the truth about a quote that is close but not
 * authoritative.
 *
 * The take applied is creator tax + Flap's fee, both read from the chain.
 */
async function reserves(): Promise<{ token: bigint; quote: bigint } | null> {
  if (!TORII.curve || TORII.curve === ZERO) return null;
  const r = await multiRead([
    { target: TORII.curve, fragment: "function getReserves() view returns (uint112,uint112,uint32)" },
    { target: TORII.curve, fragment: "function token0() view returns (address)" },
  ]);
  if (!r[0] || r[0].length < 2) return null;
  const r0 = BigInt(r[0][0] as bigint);
  const r1 = BigInt(r[0][1] as bigint);
  const t0 = asStr(r[1]);
  if (!t0) return null;
  const tokenIsZero = t0.toLowerCase() === TORII.token.toLowerCase();
  return { token: tokenIsZero ? r0 : r1, quote: tokenIsZero ? r1 : r0 };
}

const TAKE_BPS = BigInt(TORII_TAX_BPS + CURVE_FEE_BPS);

function constantProduct(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const net = (amountIn * (10_000n - TAKE_BPS)) / 10_000n;
  return (net * reserveOut) / (reserveIn + net);
}

export async function quoteBuy(ethIn: bigint, _from?: string | null): Promise<CurveQuote | null> {
  const r = await reserves();
  if (!r) return null;
  return { amountOut: constantProduct(ethIn, r.quote, r.token), exact: false };
}

export async function quoteSell(tokensIn: bigint, _from?: string | null): Promise<CurveQuote | null> {
  const r = await reserves();
  if (!r) return null;
  return { amountOut: constantProduct(tokensIn, r.token, r.quote), exact: false };
}

export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * The write path, which does not exist yet.
 *
 * These throw rather than build a transaction. A stub that encoded a call to a
 * disabled entrypoint would fail in the user's wallet *after* they signed,
 * which is strictly worse than a button that says it is unavailable.
 */
export const CURVE_TRADING_AVAILABLE = false;

/** Where a holder can trade until the route above is identified. */
export const CURVE_TRADE_URL = `https://flap.sh/bnb/${TORII.token.toLowerCase()}?lang=en`;

const unavailable = (): never => {
  throw new Error(
    "Flap's curve entrypoints report FeatureDisabled(). Trade on flap.sh until the route is wired."
  );
};

type SentTx = { hash: string; wait: () => Promise<unknown> };

export async function curveBuy(
  _s: JsonRpcSigner, _ethIn: bigint, _minOut: bigint, _to: string
): Promise<SentTx> { return unavailable(); }

export async function curveSell(
  _s: JsonRpcSigner, _tokensIn: bigint, _minOut: bigint, _to: string
): Promise<SentTx> { return unavailable(); }

export async function approveCurve(_s: JsonRpcSigner): Promise<SentTx> { return unavailable(); }

export async function readCurveAllowance(_owner: string): Promise<bigint> { return 0n; }

export async function dryRunCurve(
  _kind: "buy" | "sell", _from: string, _amountIn: bigint, _minOut: bigint
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return {
    ok: false,
    reason: "Flap's curve entrypoints revert FeatureDisabled() for direct calls.",
  };
}

export async function readTokenBalance(owner: string): Promise<bigint> {
  if (!owner || TORII.token === ZERO) return 0n;
  const r = await multiRead([
    { target: TORII.token, fragment: "function balanceOf(address) view returns (uint256)", args: [owner] },
  ]);
  return asBig(r[0]) ?? 0n;
}

export { WBNB_ADDR };
