import { Contract, formatEther, type Wallet } from "ethers";
import { provider, EXECUTE, MIN_RATIO } from "./config.js";

/**
 * The shape every job shares, and the guard rails that apply to all of them.
 *
 * A job answers three questions in order, and stops at the first "no":
 *
 *   1. **Is there anything to do?** A view read. Costs nothing.
 *   2. **Does it actually simulate?** `staticCall` against live state. This is
 *      what stops the keeper broadcasting a transaction that was always going
 *      to revert — `distributeIncome()` reverts when neither staking side has
 *      stakers, and that is a normal, expected state, not an error.
 *   3. **Is it worth the gas?** The value moved has to clear `MIN_RATIO` times
 *      the estimated cost. Sweeping dust at a loss fills nobody's corpus.
 *
 * Only then does it send, and only if `KEEPER_EXECUTE=1`.
 */

export type Decision =
  | { act: false; reason: string; value?: bigint }
  | { act: true; value: bigint; gasCost: bigint };

export type Job = {
  name: string;
  /** Human-readable target, for the log line. */
  target: string;
  /** Decide whether to run, without sending anything. */
  plan(signer: Wallet | null): Promise<Decision>;
  /** Send it. Only called when `plan` said act and EXECUTE is on. */
  send(signer: Wallet): Promise<string>;
};

export const eth = (v: bigint) => `${formatEther(v)} ETH`;

/** Current gas price, with a small cushion so an estimate is not optimistic. */
export async function gasPrice(): Promise<bigint> {
  const fee = await provider.getFeeData();
  const p = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  return (p * 12n) / 10n;
}

/**
 * Simulate, then price the call.
 *
 * Returns a Decision so callers do not each re-implement the same three checks.
 * `value` is what the call moves; a job that cannot know it should pass the
 * best figure it has and say so in the log.
 */
export async function appraise(
  contract: Contract,
  fn: string,
  args: unknown[],
  value: bigint,
  signer: Wallet | null
): Promise<Decision> {
  if (value === 0n) return { act: false, reason: "nothing to move" };

  // Without a key there is nothing to simulate from; report the intent instead
  // of failing, so `npm run once` is useful before a wallet exists.
  if (!signer) return { act: false, reason: "no key — dry plan only", value };

  const withSigner = contract.connect(signer) as Contract;

  try {
    await withSigner[fn].staticCall(...args);
  } catch (e) {
    const msg = (e as Error).message?.split("\n")[0] ?? String(e);
    return { act: false, reason: `would revert: ${msg}`, value };
  }

  let gas: bigint;
  try {
    gas = await withSigner[fn].estimateGas(...args);
  } catch {
    return { act: false, reason: "gas estimation failed", value };
  }

  const cost = gas * (await gasPrice());
  if (value < cost * BigInt(MIN_RATIO)) {
    return {
      act: false,
      reason: `not worth it — moves ${eth(value)}, costs ~${eth(cost)} (needs ${MIN_RATIO}×)`,
      value,
    };
  }

  return { act: true, value, gasCost: cost };
}

/** One line per job, so a long-running log stays readable. */
export function log(job: string, d: Decision, extra = "") {
  const stamp = new Date().toISOString().slice(11, 19);
  if (!d.act) {
    const v = d.value !== undefined ? ` [${eth(d.value)}]` : "";
    console.log(`${stamp}  ${job.padEnd(18)} skip   ${d.reason}${v}`);
    return;
  }
  const mode = EXECUTE ? "SEND" : "would";
  console.log(
    `${stamp}  ${job.padEnd(18)} ${mode}   moves ${eth(d.value)} · gas ~${eth(d.gasCost)} ${extra}`
  );
}
