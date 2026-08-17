import {
  AbiCoder, Contract, concat, getAddress, MaxUint256, toBeHex,
  type JsonRpcSigner,
} from "ethers";
import { readProvider, V4, ZERO } from "./chain";
import { ponsPoolKey, type PoolKey } from "./poolkey";

const coder = AbiCoder.defaultAbiCoder();

// ---------------------------------------------------------------------------
// UniversalRouter command + V4Router action opcodes.
//
// These byte values come from Uniswap's Commands.sol / Actions.sol and HAVE
// SHIFTED between v4-periphery releases. Before trusting them on a new chain,
// dry-run the calldata (see dryRunSwap) — a wrong opcode reverts rather than
// silently misbehaving, but you want to find that out from eth_call, not from a
// user's transaction.
// ---------------------------------------------------------------------------
const CMD_V4_SWAP = "0x10";

const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE_ALL = 0x0c;
const ACTION_TAKE_ALL = 0x0f;

const UNIVERSAL_ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
];

const PERMIT2_ABI = [
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
];

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

export type Quote = {
  amountOut: bigint;
  gasEstimate: bigint;
  /** Basis points the quote sits below a naive spot calculation. */
  impliedFeeBps: number | null;
};

/**
 * Quote a swap.
 *
 * MUST be staticCall: quoteExactInputSingle is non-view by declaration (it
 * reverts internally and catches the result), so calling it in a transaction
 * would waste gas and fail.
 *
 * This is the ONLY legitimate source of expected output. Pons pools have
 * poolFee = 0 and apply the creator tax dynamically inside the hook, so a
 * price derived from sqrtPriceX96 is short by the whole tax — measured at
 * 207 bps on a 1%-tax token, and it would be ~500 bps on TITHE at 4%.
 */
export async function quoteExactIn(
  token: string,
  amountIn: bigint,
  zeroForOne: boolean,
  spotImpliedOut?: bigint | null
): Promise<Quote> {
  const key = ponsPoolKey(token);
  const q = new Contract(V4.quoter, QUOTER_ABI, readProvider);
  const r = await q.quoteExactInputSingle.staticCall({
    poolKey: key,
    zeroForOne,
    exactAmount: amountIn,
    hookData: "0x",
  });
  const amountOut = BigInt(r[0]);
  let impliedFeeBps: number | null = null;
  if (spotImpliedOut && spotImpliedOut > 0n && amountOut <= spotImpliedOut) {
    impliedFeeBps = Number(((spotImpliedOut - amountOut) * 10_000n) / spotImpliedOut);
  }
  return { amountOut, gasEstimate: BigInt(r[1]), impliedFeeBps };
}

/** Apply slippage tolerance to a quote to get amountOutMinimum. */
export function minOut(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amountOut * (10_000n - bps)) / 10_000n;
}

// ---------------------------------------------------------------------------
// Calldata construction
// ---------------------------------------------------------------------------

function encodeV4SwapInput(
  key: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMin: bigint
): string {
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;

  // Action sequence: perform the swap, pay what we owe, collect what we're owed.
  const actions = concat([
    toBeHex(ACTION_SWAP_EXACT_IN_SINGLE, 1),
    toBeHex(ACTION_SETTLE_ALL, 1),
    toBeHex(ACTION_TAKE_ALL, 1),
  ]);

  const swapParams = coder.encode(
    [
      "((address,address,uint24,int24,address),bool,uint128,uint128,bytes)",
    ],
    [
      [
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
        zeroForOne,
        amountIn,
        amountOutMin,
        "0x",
      ],
    ]
  );

  // SETTLE_ALL takes a maximum we're willing to pay; TAKE_ALL a minimum to receive.
  const settleParams = coder.encode(["address", "uint256"], [currencyIn, amountIn]);
  const takeParams = coder.encode(["address", "uint256"], [currencyOut, amountOutMin]);

  return coder.encode(["bytes", "bytes[]"], [actions, [swapParams, settleParams, takeParams]]);
}

export type SwapCall = {
  to: string;
  data: string;
  value: bigint;
  /** Convenience copy for the UI. */
  amountOutMin: bigint;
};

export function buildSwapCall(opts: {
  token: string;
  amountIn: bigint;
  amountOutMin: bigint;
  /** true = spending currency0. For an ETH-paired pool that means buying. */
  zeroForOne: boolean;
  deadlineSeconds?: number;
}): SwapCall {
  const { token, amountIn, amountOutMin, zeroForOne, deadlineSeconds = 900 } = opts;
  const key = ponsPoolKey(token);
  const input = encodeV4SwapInput(key, zeroForOne, amountIn, amountOutMin);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

  const router = new Contract(V4.universalRouter, UNIVERSAL_ROUTER_ABI, readProvider);
  const data = router.interface.encodeFunctionData("execute", [
    CMD_V4_SWAP,
    [input],
    deadline,
  ]);

  // Native ETH input is attached as msg.value — no approval, no Permit2.
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const value = currencyIn === ZERO ? amountIn : 0n;

  return { to: V4.universalRouter, data, value, amountOutMin };
}

/**
 * Simulate the exact transaction before offering it to the user.
 *
 * amountOutMinimum is the only thing standing between the user and a sandwich,
 * and a mis-encoded action array fails in ways that are opaque on-chain. An
 * eth_call first turns "transaction reverted" into a readable reason, costs
 * nothing, and catches wrong opcodes, stale quotes, and missing allowances.
 */
export async function dryRunSwap(
  call: SwapCall,
  from: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await readProvider.call({
      to: call.to,
      data: call.data,
      value: call.value,
      from: getAddress(from),
    });
    return { ok: true };
  } catch (e: any) {
    const reason =
      e?.shortMessage ??
      e?.info?.error?.message ??
      e?.reason ??
      e?.message ??
      "unknown revert";
    return { ok: false, reason: String(reason).slice(0, 240) };
  }
}

// ---------------------------------------------------------------------------
// Sell-side approvals (Permit2). Buys need none.
// ---------------------------------------------------------------------------

export type ApprovalState = {
  /** ERC-20 → Permit2. One-time, unlimited. */
  erc20ToPermit2: boolean;
  /** Permit2 → UniversalRouter, for this token, unexpired and sufficient. */
  permit2ToRouter: boolean;
};

const PERMIT2_MAX_AMOUNT = (1n << 160n) - 1n;
const PERMIT2_MAX_EXPIRATION = (1n << 48n) - 1n;

export async function readApprovals(
  token: string,
  owner: string,
  needed: bigint
): Promise<ApprovalState> {
  const erc20 = new Contract(token, ERC20_ABI, readProvider);
  const permit2 = new Contract(V4.permit2, PERMIT2_ABI, readProvider);

  const [erc20Allowance, p2] = await Promise.all([
    erc20.allowance(owner, V4.permit2) as Promise<bigint>,
    permit2.allowance(owner, token, V4.universalRouter) as Promise<[bigint, bigint, bigint]>,
  ]);

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  return {
    erc20ToPermit2: BigInt(erc20Allowance) >= needed,
    permit2ToRouter: BigInt(p2[0]) >= needed && BigInt(p2[1]) > nowSec,
  };
}

export async function approveErc20ToPermit2(signer: JsonRpcSigner, token: string) {
  const c = new Contract(token, ERC20_ABI, signer);
  return c.approve(V4.permit2, MaxUint256);
}

export async function approvePermit2ToRouter(signer: JsonRpcSigner, token: string) {
  const c = new Contract(V4.permit2, PERMIT2_ABI, signer);
  return c.approve(token, V4.universalRouter, PERMIT2_MAX_AMOUNT, PERMIT2_MAX_EXPIRATION);
}

export async function sendSwap(signer: JsonRpcSigner, call: SwapCall) {
  return signer.sendTransaction({ to: call.to, data: call.data, value: call.value });
}
