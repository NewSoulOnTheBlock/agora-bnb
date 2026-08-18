import { Contract, Interface } from "ethers";
import { readProvider } from "./chain";

/**
 * Multicall3, for reads that would otherwise be dozens of round-trips.
 *
 * ## Why this had to exist
 *
 * Scanning the operator's position across Beefy's 33 vaults on this chain means
 * 66 `balanceOf` reads. Issued as parallel `eth_call`s — which is what ethers
 * does by default, batching them into one JSON-RPC array — the public Robinhood
 * endpoint answers **HTTP 429, Too Many Requests**. It rate-limits the batch as
 * a batch, so there is no batch size that both fits and is worth sending.
 *
 * `aggregate3` sidesteps that entirely: 66 reads become **one** `eth_call`,
 * which the endpoint is happy to serve. Verified live on chain 4663 — the
 * canonical deployment is present and answers correctly.
 *
 * ## One quirk worth writing down
 *
 * `Multicall3.getBlockNumber()` returns ~25.7M here while the chain is at
 * ~39.7M. That is not a broken deployment: this is an Arbitrum Orbit L2, and
 * `block.number` read from inside a contract returns the **L1** block. Nothing
 * here depends on it, but it is the kind of number that starts a wild goose
 * chase if you meet it cold. The chain also hosts `ArbMulticall2` at
 * `0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1`, verified on Blockscout, which
 * exposes `getL1BlockNumber()` alongside `getBlockNumber()` and makes the same
 * point explicitly.
 *
 * ## Why Multicall3 rather than that ArbMulticall2
 *
 * `ArbMulticall2.tryAggregate` takes a single `requireSuccess` flag for the
 * whole batch, so one unreadable vault fails the sweep or none of them do.
 * `aggregate3` carries `allowFailure` per call, which is what a 33-vault scan
 * across third-party contracts actually needs. Both are live; this one degrades
 * better.
 */

/** Canonical Multicall3, same address on every chain that has it. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MC3_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
];

export type Call = { target: string; callData: string };

/**
 * Run every call in one request.
 *
 * `allowFailure` is always true and a failed call comes back as `null` rather
 * than throwing: one unreadable vault in a 33-vault sweep must not blank the
 * whole panel.
 *
 * Returns `null` for every call if the aggregate itself fails, so callers only
 * ever have to handle "no data" rather than a rejected promise.
 */
export async function aggregate3(calls: Call[]): Promise<(string | null)[]> {
  if (!calls.length) return [];
  try {
    const mc = new Contract(MULTICALL3, MC3_ABI, readProvider);
    const res: { success: boolean; returnData: string }[] = await mc.aggregate3(
      calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))
    );
    return res.map((r) => (r.success && r.returnData !== "0x" ? r.returnData : null));
  } catch {
    return calls.map(() => null);
  }
}

/** Convenience: encode one function against many targets, decode a single value. */
export async function readMany<T>(
  targets: string[],
  fragment: string,
  args: unknown[],
  decode: (raw: string, iface: Interface) => T
): Promise<(T | null)[]> {
  const iface = new Interface([fragment]);
  const name = iface.fragments[0].format("sighash").split("(")[0];
  const callData = iface.encodeFunctionData(name, args);

  const raw = await aggregate3(targets.map((target) => ({ target, callData })));
  return raw.map((r) => {
    if (r === null) return null;
    try {
      return decode(r, iface);
    } catch {
      return null;
    }
  });
}

/** The common case: a function returning a single uint256. */
export async function readManyUint(
  targets: string[],
  fragment: string,
  args: unknown[] = []
): Promise<(bigint | null)[]> {
  const iface = new Interface([fragment]);
  const name = iface.fragments[0].format("sighash").split("(")[0];
  return readMany(targets, fragment, args, (raw) => {
    const [v] = iface.decodeFunctionResult(name, raw);
    return BigInt(v);
  });
}

export type MCall = { target: string; fragment: string; args?: unknown[] };

/**
 * Read many different functions, on many different contracts, in one request.
 *
 * This is the workhorse the page readers use. Each entry carries its own
 * human-readable fragment, so a call site stays as legible as the ethers
 * `Contract` call it replaces:
 *
 * ```ts
 * const r = await multiRead([
 *   { target: T, fragment: "function nav() view returns (uint256)" },
 *   { target: T, fragment: "function eligibleSupply() view returns (uint256)" },
 * ]);
 * ```
 *
 * A call that reverts, or a contract that is not there, decodes to `null` — the
 * same contract as the old per-call `safe()` wrapper, so readers keep rendering
 * "unavailable" for one bad value instead of losing the whole panel.
 */
export async function multiRead(calls: MCall[]): Promise<(unknown[] | null)[]> {
  const ifaces = calls.map((c) => new Interface([c.fragment]));
  const names = ifaces.map((i) => i.fragments[0].format("sighash").split("(")[0]);

  const encoded = calls.map((c, i) => ({
    target: c.target,
    callData: ifaces[i].encodeFunctionData(names[i], c.args ?? []),
  }));

  const raw = await aggregate3(encoded);

  return raw.map((r, i) => {
    if (r === null) return null;
    try {
      return Array.from(ifaces[i].decodeFunctionResult(names[i], r));
    } catch {
      return null;
    }
  });
}

/** First return value as a bigint, or null. */
export function asBig(v: unknown[] | null): bigint | null {
  if (!v || v.length === 0) return null;
  try {
    return BigInt(v[0] as bigint);
  } catch {
    return null;
  }
}

/** First return value as a string, or null. */
export function asStr(v: unknown[] | null): string | null {
  return v && v.length ? String(v[0]) : null;
}

/** First return value as a boolean, or null. */
export function asBool(v: unknown[] | null): boolean | null {
  return v && v.length ? Boolean(v[0]) : null;
}
