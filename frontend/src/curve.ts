import { Contract, MaxUint256, type JsonRpcSigner } from "ethers";
import { readProvider, AGORA, ZERO } from "./chain";

/**
 * Pons v2 bonding curve.
 *
 * The curve contract is NOT verified on Blockscout and does not bytecode-match
 * any verified PonsV2Curve template (10,229b vs 9,193–9,360b), so this ABI was
 * recovered by scraping PUSH4 selectors out of the deployed bytecode and
 * resolving them against the openchain signature database.
 *
 * buy()'s parameter order was then pinned by simulation: of the three plausible
 * orderings, only (quoteAmountIn, minTokensOut, recipient) succeeds — the other
 * two revert. For a native-quote curve, quoteAmountIn must equal msg.value.
 */
export const CURVE_ABI = [
  // trading
  "function buy(uint256 quoteAmountIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
  "function sell(uint256 tokenAmountIn, uint256 minQuoteOut, address recipient) returns (uint256)",
  // reserves / pricing
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function tokenReserve() view returns (uint256)",
  "function quoteReserve() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function phantomQuote() view returns (uint256)",
  "function reservedTokens() view returns (uint256)",
  "function launchSupply() view returns (uint256)",
  // graduation
  "function graduationThreshold() view returns (uint256)",
  "function readyToGraduate() view returns (bool)",
  "function graduated() view returns (bool)",
  // economics
  "function creatorTaxBps() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function protocolFeeShareBps() view returns (uint256)",
  "function snipeTaxStartBps() view returns (uint256)",
  "function snipeTaxSeconds() view returns (uint256)",
  "function launchedAt() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function quoteFeeBalance() view returns (uint256)",
  // misc
  "function isNativeQuote() view returns (bool)",
  "function token() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

/** Any address with ETH, used only as an eth_call `from` for indicative quotes. */
const QUOTE_FROM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

const WAD = 10n ** 18n;

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
  /** Spot price in ETH per token, WAD. */
  priceWad: bigint;
  /** Total take on a trade: creator tax + curve fee. */
  totalFeeBps: number;
};

export async function readCurveState(): Promise<CurveState | null> {
  if (!AGORA.curve || AGORA.curve === ZERO) return null;
  const c = new Contract(AGORA.curve, CURVE_ABI, readProvider);
  try {
    const [
      quoteReserve, tokenReserve, realQuoteReserve, phantomQuote,
      graduationThreshold, readyToGraduate, graduated,
      creatorTaxBps, feeBps, creatorTaxBalance, quoteFeeBalance,
      snipeTaxStartBps, snipeTaxSeconds, launchedAt,
    ] = await Promise.all([
      c.quoteReserve(), c.tokenReserve(), c.realQuoteReserve(), c.phantomQuote(),
      c.graduationThreshold(), c.readyToGraduate(), c.graduated(),
      c.creatorTaxBps(), c.feeBps(), c.creatorTaxBalance(), c.quoteFeeBalance(),
      c.snipeTaxStartBps(), c.snipeTaxSeconds(), c.launchedAt(),
    ]);
    const qr = BigInt(quoteReserve), tr = BigInt(tokenReserve);
    const gt = BigInt(graduationThreshold), rq = BigInt(realQuoteReserve);
    return {
      quoteReserve: qr,
      tokenReserve: tr,
      realQuoteReserve: rq,
      phantomQuote: BigInt(phantomQuote),
      graduationThreshold: gt,
      readyToGraduate: Boolean(readyToGraduate),
      graduated: Boolean(graduated),
      creatorTaxBps: BigInt(creatorTaxBps),
      feeBps: BigInt(feeBps),
      creatorTaxBalance: BigInt(creatorTaxBalance),
      quoteFeeBalance: BigInt(quoteFeeBalance),
      snipeTaxStartBps: BigInt(snipeTaxStartBps),
      snipeTaxSeconds: BigInt(snipeTaxSeconds),
      launchedAt: BigInt(launchedAt),
      graduationPct: gt > 0n ? Number((rq * 10_000n) / gt) / 100 : 0,
      priceWad: tr > 0n ? (qr * WAD) / tr : 0n,
      totalFeeBps: Number(BigInt(creatorTaxBps) + BigInt(feeBps)),
    };
  } catch {
    return null;
  }
}

export type CurveQuote = {
  amountOut: bigint;
  /** true when it came from a real simulation rather than reserve math. */
  exact: boolean;
};

/**
 * Quote a curve buy.
 *
 * Prefers a staticCall of buy() with minOut = 0, which returns the true output
 * including the 4% creator tax and 1% curve fee. Falls back to constant-product
 * math when simulation isn't possible (no funded `from`), which is close but not
 * authoritative — hence the `exact` flag, so the UI can say which it showed.
 */
export async function quoteBuy(ethIn: bigint, from?: string | null): Promise<CurveQuote | null> {
  if (ethIn <= 0n) return null;
  const c = new Contract(AGORA.curve, CURVE_ABI, readProvider);
  try {
    const out = await c.buy.staticCall(ethIn, 0n, from ?? QUOTE_FROM, {
      value: ethIn,
      from: from ?? QUOTE_FROM,
    });
    return { amountOut: BigInt(out), exact: true };
  } catch {
    const st = await readCurveState();
    if (!st) return null;
    const feeBps = BigInt(st.totalFeeBps);
    const dxEff = (ethIn * (10_000n - feeBps)) / 10_000n;
    const denom = st.quoteReserve + dxEff;
    if (denom === 0n) return null;
    return { amountOut: (st.tokenReserve * dxEff) / denom, exact: false };
  }
}

export async function quoteSell(tokensIn: bigint, from?: string | null): Promise<CurveQuote | null> {
  if (tokensIn <= 0n) return null;
  const c = new Contract(AGORA.curve, CURVE_ABI, readProvider);
  if (from) {
    try {
      const out = await c.sell.staticCall(tokensIn, 0n, from, { from });
      return { amountOut: BigInt(out), exact: true };
    } catch {
      // Usually means no balance or no approval — fall through to math.
    }
  }
  const st = await readCurveState();
  if (!st) return null;
  const denom = st.tokenReserve + tokensIn;
  if (denom === 0n) return null;
  const gross = (st.quoteReserve * tokensIn) / denom;
  const feeBps = BigInt(st.totalFeeBps);
  return { amountOut: (gross * (10_000n - feeBps)) / 10_000n, exact: false };
}

export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amountOut * (10_000n - bps)) / 10_000n;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function curveBuy(
  signer: JsonRpcSigner, ethIn: bigint, minTokensOut: bigint, recipient: string
) {
  const c = new Contract(AGORA.curve, CURVE_ABI, signer);
  return c.buy(ethIn, minTokensOut, recipient, { value: ethIn });
}

export async function curveSell(
  signer: JsonRpcSigner, tokensIn: bigint, minEthOut: bigint, recipient: string
) {
  const c = new Contract(AGORA.curve, CURVE_ABI, signer);
  return c.sell(tokensIn, minEthOut, recipient);
}

/** Selling on the curve needs an ERC-20 allowance; buying does not. */
export async function readCurveAllowance(owner: string): Promise<bigint> {
  const t = new Contract(AGORA.token, ERC20_ABI, readProvider);
  return BigInt(await t.allowance(owner, AGORA.curve));
}

export async function approveCurve(signer: JsonRpcSigner) {
  const t = new Contract(AGORA.token, ERC20_ABI, signer);
  return t.approve(AGORA.curve, MaxUint256);
}

export async function readTokenBalance(owner: string): Promise<bigint> {
  const t = new Contract(AGORA.token, ERC20_ABI, readProvider);
  return BigInt(await t.balanceOf(owner));
}

/** Dry-run a curve trade so failures surface as text, not a wallet rejection. */
export async function dryRunCurve(
  kind: "buy" | "sell",
  from: string,
  amountIn: bigint,
  minOut: bigint
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const c = new Contract(AGORA.curve, CURVE_ABI, readProvider);
  try {
    if (kind === "buy") {
      await c.buy.staticCall(amountIn, minOut, from, { value: amountIn, from });
    } else {
      await c.sell.staticCall(amountIn, minOut, from, { from });
    }
    return { ok: true };
  } catch (e: any) {
    const reason =
      e?.revert?.name ?? e?.shortMessage ?? e?.info?.error?.message ?? e?.message ?? "unknown revert";
    return { ok: false, reason: String(reason).slice(0, 220) };
  }
}
