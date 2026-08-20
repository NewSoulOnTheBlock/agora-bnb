import { Contract, MaxUint256, type JsonRpcSigner } from "ethers";
import { readProvider, PANCAKE, WBNB_ADDR, ZERO } from "./chain";
import { pairFor, getAmountOut } from "./poolkey";
import { multiRead, asBig } from "./multicall";

/**
 * Swapping TORII on PancakeSwap V2.
 *
 * ## Most of the old file was Uniswap v4 ceremony, and it is gone
 *
 * The 4663 build encoded UniversalRouter commands and V4Router action opcodes
 * by hand, routed approvals through Permit2, and had to call a non-view quoter
 * by `staticCall` because Pons applied its tax dynamically inside a hook — a
 * price derived from `sqrtPriceX96` was short by the whole tax, measured at 207
 * bps on a 1% token.
 *
 * None of that applies. PancakeSwap V2 is a plain router with a plain ERC-20
 * `approve`, and the tax is not charged by the pool at all — Flap takes it at
 * the token level, so the constant-product formula IS the quote. That means the
 * quote can be computed locally from reserves, with no round trip and nothing
 * to dry-run.
 *
 * ## The one thing that still needs the router's own answer
 *
 * Whether TORII charges a transfer fee. `getAmountsOut` prices the swap, not
 * the transfer, so a fee-on-transfer token quotes high and then reverts against
 * its own minimum-out. Rather than guess, sells go through
 * `swapExactTokensForETHSupportingFeeOnTransferTokens`, which tolerates both
 * cases — the same function `ToriiVault.convertAndForward` uses, so the app and
 * the protocol take the same path.
 */

const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
];

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

export type Quote = {
  amountOut: bigint;
  gasEstimate: bigint;
  /** Basis points the quote sits below a zero-slippage spot calculation. */
  impliedFeeBps: number | null;
};

/** BNB → TORII is `[WBNB, token]`; the reverse for a sell. */
export function pathFor(token: string, buying: boolean): string[] {
  return buying ? [WBNB_ADDR, token] : [token, WBNB_ADDR];
}

/**
 * Quote a swap from the pair's own reserves.
 *
 * Computed locally rather than asked of the router. `getAmountsOut` would
 * return the same number — it runs this exact arithmetic — but it costs a round
 * trip per keystroke, and the reserves are already on the page.
 *
 * `impliedFeeBps` compares the result against a zero-slippage spot fill, so it
 * reports price impact plus the 0.25% pool fee together. That is what the trader
 * actually gives up, which is more useful than either half alone.
 */
export async function quoteExactIn(
  token: string,
  amountIn: bigint,
  buying: boolean,
  spotImpliedOut?: bigint | null
): Promise<Quote> {
  const pair = pairFor(token);

  const r = await multiRead([
    { target: pair.address, fragment: "function getReserves() view returns (uint112,uint112,uint32)" },
  ]);
  if (!r[0] || !r[0].length) throw new Error("No PancakeSwap pair yet — the token has not graduated.");

  const reserve0 = BigInt(r[0][0] as bigint);
  const reserve1 = BigInt(r[0][1] as bigint);

  // `tokenIsZero` says which reserve is TORII; the other is WBNB.
  const tokenReserve = pair.tokenIsZero ? reserve0 : reserve1;
  const quoteReserve = pair.tokenIsZero ? reserve1 : reserve0;

  const amountOut = buying
    ? getAmountOut(amountIn, quoteReserve, tokenReserve)
    : getAmountOut(amountIn, tokenReserve, quoteReserve);

  let impliedFeeBps: number | null = null;
  if (spotImpliedOut && spotImpliedOut > 0n && amountOut <= spotImpliedOut) {
    impliedFeeBps = Number(((spotImpliedOut - amountOut) * 10_000n) / spotImpliedOut);
  }

  return { amountOut, gasEstimate: 0n, impliedFeeBps };
}

export function minOut(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export type SwapCall = {
  to: string;
  data: string;
  value: bigint;
  deadline: number;
};

const iface = new Contract(ZERO, ROUTER_ABI).interface;

export function buildSwapCall(opts: {
  token: string;
  buying: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient: string;
  deadlineSeconds?: number;
}): SwapCall {
  const deadline = Math.floor(Date.now() / 1000) + (opts.deadlineSeconds ?? 600);
  const path = pathFor(opts.token, opts.buying);

  // Both directions use the fee-supporting variants. They are correct for a
  // token with no transfer fee too, so there is no branch to get wrong later if
  // the token ever gains one.
  const data = opts.buying
    ? iface.encodeFunctionData("swapExactETHForTokensSupportingFeeOnTransferTokens", [
        opts.minAmountOut, path, opts.recipient, deadline,
      ])
    : iface.encodeFunctionData("swapExactTokensForETHSupportingFeeOnTransferTokens", [
        opts.amountIn, opts.minAmountOut, path, opts.recipient, deadline,
      ]);

  return { to: PANCAKE.router, data, value: opts.buying ? opts.amountIn : 0n, deadline };
}

/**
 * Simulate before signing.
 *
 * The v4 version needed this because hand-encoded router opcodes shift between
 * releases and a wrong byte reverts. That risk is gone, but the check is worth
 * keeping for a different one: a sell reverts when the router has no allowance,
 * and finding that out from `eth_call` is much better than from a failed
 * transaction the user paid for.
 */
export async function dryRunSwap(call: SwapCall, from: string): Promise<string | null> {
  try {
    await readProvider.call({ to: call.to, data: call.data, value: call.value, from });
    return null;
  } catch (e: any) {
    return e?.shortMessage ?? e?.reason ?? e?.message ?? "simulation failed";
  }
}

export type ApprovalState = {
  /** Buys spend native BNB, so nothing needs approving. */
  needsApproval: boolean;
  allowance: bigint | null;
};

/**
 * One approval, not two.
 *
 * Uniswap's router required an ERC-20 approval to Permit2 *and* a Permit2
 * allowance to the router — two transactions before a first sell. PancakeSwap
 * V2 pulls tokens with a plain `transferFrom`, so it is one ordinary approve.
 */
export async function readApprovals(
  token: string,
  owner: string,
  amount: bigint
): Promise<ApprovalState> {
  if (!owner || token === ZERO) return { needsApproval: false, allowance: null };

  const r = await multiRead([
    {
      target: token,
      fragment: "function allowance(address,address) view returns (uint256)",
      args: [owner, PANCAKE.router],
    },
  ]);

  const allowance = asBig(r[0]);
  return { needsApproval: allowance !== null && allowance < amount, allowance };
}

export async function approveRouter(signer: JsonRpcSigner, token: string) {
  const c = new Contract(token, ERC20_ABI, signer);
  const tx = await c.approve(PANCAKE.router, MaxUint256);
  await tx.wait();
  return tx.hash as string;
}

export async function sendSwap(signer: JsonRpcSigner, call: SwapCall) {
  const tx = await signer.sendTransaction({ to: call.to, data: call.data, value: call.value });
  await tx.wait();
  return tx.hash as string;
}
