import { Contract, MaxUint256, type JsonRpcSigner } from "ethers";
import { readProvider, TORII, ZERO } from "./chain";
import {
  STAKED_TORII_ABI, REDEEMER_ABI, TREASURY_ABI, FEE_SINK_ABI,
} from "./abis";
import { LAUNCH_TOKEN_ABI } from "./abis";

const ERC20_ABI = [
  ...LAUNCH_TOKEN_ABI,
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];

function ro(address: string, abi: string[]) {
  return new Contract(address, abi, readProvider);
}

// ---------------------------------------------------------------------------
// Per-account reads. All return null on failure rather than throwing, matching
// reads.ts — an unreachable contract must render as unknown, never as zero.
// ---------------------------------------------------------------------------

export type StakePosition = {
  toriiBalance: bigint | null;
  shares: bigint | null;
  sharesAsAssets: bigint | null;
  pendingYield: bigint | null;
  allowance: bigint | null;
};

export async function readStakePosition(account: string): Promise<StakePosition> {
  const empty: StakePosition = {
    toriiBalance: null, shares: null, sharesAsAssets: null, pendingYield: null, allowance: null,
  };
  if (TORII.token === ZERO) return empty;

  const token = ro(TORII.token, ERC20_ABI);
  const toriiBalance = await token.balanceOf(account).then(BigInt).catch(() => null);
  if (TORII.stakedAgora === ZERO) return { ...empty, toriiBalance };

  const v = ro(TORII.stakedAgora, STAKED_TORII_ABI);
  const [shares, pendingYield, allowance] = await Promise.all([
    v.balanceOf(account).then(BigInt).catch(() => null),
    v.pendingYield(account).then(BigInt).catch(() => null),
    token.allowance(account, TORII.stakedAgora).then(BigInt).catch(() => null),
  ]);
  const sharesAsAssets =
    shares === null ? null : await v.convertToAssets(shares).then(BigInt).catch(() => null);

  return { toriiBalance, shares, sharesAsAssets, pendingYield, allowance };
}

export type RedeemRequest = {
  id: number;
  owner: string;
  amount: bigint;
  snapshotFloor: bigint;
  requestedAt: number;
  executed: boolean;
  paid: bigint;
  executableAt: number;
  ready: boolean;
};

/** Newest-first queue entries belonging to `account`. */
export async function readMyRequests(account: string, max = 25): Promise<RedeemRequest[]> {
  if (TORII.redeemer === ZERO) return [];
  const r = ro(TORII.redeemer, REDEEMER_ABI);
  const len = Number(await r.queueLength().catch(() => 0n));
  const me = account.toLowerCase();
  const out: RedeemRequest[] = [];

  for (let i = len - 1; i >= 0 && out.length < max; i--) {
    try {
      const q = await r.requests(i);
      if (String(q.owner).toLowerCase() !== me) continue;
      const [paid, executableAt, ready] = await r.preview(i);
      out.push({
        id: i,
        owner: q.owner,
        amount: BigInt(q.amount),
        snapshotFloor: BigInt(q.snapshotFloor),
        requestedAt: Number(q.requestedAt),
        executed: q.executed,
        paid: BigInt(paid),
        executableAt: Number(executableAt),
        ready,
      });
    } catch {
      // A single unreadable entry must not blank the whole list.
    }
  }
  return out;
}

export async function quoteRedeem(amount: bigint): Promise<bigint | null> {
  if (TORII.redeemer === ZERO) return null;
  return ro(TORII.redeemer, REDEEMER_ABI).quote(amount).then(BigInt).catch(() => null);
}

export async function readCollectable(): Promise<{ inEscrow: bigint; onCurve: bigint; held: bigint } | null> {
  if (TORII.feeSink === ZERO) return null;
  try {
    const [inEscrow, onCurve, held] = await ro(TORII.feeSink, FEE_SINK_ABI).collectable();
    return { inEscrow: BigInt(inEscrow), onCurve: BigInt(onCurve), held: BigInt(held) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writes. Each returns the tx hash. Callers own the error surface.
// ---------------------------------------------------------------------------

async function send(signer: JsonRpcSigner, address: string, abi: string[], fn: string, args: unknown[], value?: bigint) {
  const c = new Contract(address, abi, signer);
  const tx = await c[fn](...args, value !== undefined ? { value } : {});
  await tx.wait();
  return tx.hash as string;
}

export const approveToriiForStaking = (s: JsonRpcSigner) =>
  send(s, TORII.token, ERC20_ABI, "approve", [TORII.stakedAgora, MaxUint256]);

export const stakeTorii = (s: JsonRpcSigner, assets: bigint, to: string) =>
  send(s, TORII.stakedAgora, STAKED_TORII_ABI, "deposit", [assets, to]);

export const unstakeTorii = (s: JsonRpcSigner, shares: bigint, to: string) =>
  send(s, TORII.stakedAgora, STAKED_TORII_ABI, "redeem", [shares, to, to]);

export const claimToriiYield = (s: JsonRpcSigner) =>
  send(s, TORII.stakedAgora, STAKED_TORII_ABI, "claim", []);

export const approveToriiForRedeemer = (s: JsonRpcSigner) =>
  send(s, TORII.token, ERC20_ABI, "approve", [TORII.redeemer, MaxUint256]);

export const requestRedeem = (s: JsonRpcSigner, amount: bigint) =>
  send(s, TORII.redeemer, REDEEMER_ABI, "requestRedeem", [amount]);

export const executeRedeem = (s: JsonRpcSigner, id: number) =>
  send(s, TORII.redeemer, REDEEMER_ABI, "execute", [id]);

/** Permissionless keeper actions — anyone may crank these. */
export const collectFees = (s: JsonRpcSigner) =>
  send(s, TORII.feeSink, FEE_SINK_ABI, "collect", []);

export const distributeIncome = (s: JsonRpcSigner) =>
  send(s, TORII.treasury, TREASURY_ABI, "distributeIncome", []);

export async function readRedeemerAllowance(account: string): Promise<bigint | null> {
  if (TORII.token === ZERO || TORII.redeemer === ZERO) return null;
  return ro(TORII.token, ERC20_ABI)
    .allowance(account, TORII.redeemer)
    .then(BigInt)
    .catch(() => null);
}
