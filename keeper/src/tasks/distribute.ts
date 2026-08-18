import { Contract, type Wallet } from "ethers";
import { provider, ADDR } from "../config.js";
import { appraise, type Job, type Decision } from "../task.js";

const TREASURY_ABI = [
  "function distributeIncome() returns (uint256)",
  "function pendingIncome() view returns (uint256)",
];
const SINK_ABI = ["function totalSupply() view returns (uint256)", "function totalStaked() view returns (uint256)"];

/**
 * Forward earmarked income to the stakers.
 *
 * `pendingIncome` is ETH the Treasury has already set aside — it is excluded
 * from `nav()`, so it is not backing the floor and it is not yet in anyone's
 * hands either. It just sits until someone calls this.
 *
 * The call reverts when **neither** staking side has stakers, because the
 * Distributor refuses to hold an obligation nobody can claim. That is a normal
 * state, not a failure, so this checks both sinks first and reports it as a
 * skip rather than letting a revert reach the log as an error.
 */
export const distributeIncome: Job = {
  name: "distribute",
  target: ADDR.treasury,

  async plan(signer: Wallet | null): Promise<Decision> {
    const t = new Contract(ADDR.treasury, TREASURY_ABI, provider);

    let pending = 0n;
    try {
      pending = await t.pendingIncome();
    } catch (e) {
      return { act: false, reason: `pendingIncome() failed: ${(e as Error).message.split("\n")[0]}` };
    }
    if (pending === 0n) return { act: false, reason: "no income earmarked" };

    // Both sinks empty → the Distributor reverts by design. Say so plainly.
    const stAgora = new Contract(ADDR.stakedAgora, SINK_ABI, provider);
    const suits = new Contract(ADDR.stakedSuits, SINK_ABI, provider);
    const [shares, staked] = await Promise.all([
      stAgora.totalSupply().catch(() => 0n),
      suits.totalStaked().catch(() => 0n),
    ]);
    if (shares === 0n && staked === 0n) {
      return { act: false, reason: "nobody is staked on either side — income stays earmarked", value: pending };
    }

    return appraise(t, "distributeIncome", [], pending, signer);
  },

  async send(signer: Wallet): Promise<string> {
    const t = new Contract(ADDR.treasury, TREASURY_ABI, signer);
    const tx = await t.distributeIncome();
    await tx.wait();
    return tx.hash;
  },
};
