import { Contract, type Wallet } from "ethers";
import { provider, ADDR } from "../config.js";
import { appraise, waitFor, type Job, type Decision } from "../task.js";

const TREASURY_ABI = [
  "function adapters() view returns (address[])",
  "function realizeSurplus(address) returns (uint256)",
  "function unrealizedSurplus() view returns (uint256)",
];

/**
 * Pull yield out of the sleeve and earmark it as staker income.
 *
 * Beefy auto-compounds, so there is no harvest — yield shows up only as the
 * adapter's position being worth more than the principal high-water mark.
 * `realizeSurplus` trims that difference back into the Treasury, where
 * `distributeIncome` can then pay it out.
 *
 * **Dormant until an adapter exists.** `sleeveBps` is 0 and `adapters()` is
 * empty today, so this reports "no adapters" every pass and costs one view
 * call. It is written now so the keeper does not need changing on the day the
 * adapter is activated.
 *
 * Note the adapter refuses to realize while Beefy reports the vault is not
 * calm, and enforces its own cooldown. Both surface here as a revert in
 * simulation, which is the correct outcome — the keeper should not be pushing
 * value out on a price that Beefy itself considers unreliable.
 */
export const realizeSurplus: Job = {
  name: "realize surplus",
  target: ADDR.treasury,

  async plan(signer: Wallet | null): Promise<Decision> {
    const t = new Contract(ADDR.treasury, TREASURY_ABI, provider);

    let adapters: string[] = [];
    try {
      adapters = await t.adapters();
    } catch (e) {
      return { act: false, reason: `adapters() failed: ${(e as Error).message.split("\n")[0]}` };
    }
    if (!adapters.length) return { act: false, reason: "no adapters — sleeve is not deployed" };

    let surplus = 0n;
    try {
      surplus = await t.unrealizedSurplus();
    } catch {
      return { act: false, reason: "unrealizedSurplus() failed" };
    }
    if (surplus === 0n) return { act: false, reason: "sleeve is at or below its high-water mark" };

    // One adapter at a time. Whichever is first is fine — the next pass takes
    // the next one, and batching them would make one bad adapter fail them all.
    return appraise(t, "realizeSurplus", [adapters[0]], surplus, signer);
  },

  async send(signer: Wallet): Promise<string> {
    const t = new Contract(ADDR.treasury, TREASURY_ABI, signer);
    const adapters: string[] = await t.adapters();
    const tx = await t.realizeSurplus(adapters[0]);
    const state = await waitFor(tx);
    return state === "timeout" ? `${tx.hash} (unconfirmed after 120s)` : tx.hash;
  },
};
