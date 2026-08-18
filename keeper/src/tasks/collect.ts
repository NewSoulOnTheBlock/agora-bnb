import { Contract, type Wallet } from "ethers";
import { provider, ADDR } from "../config.js";
import { appraise, type Job, type Decision } from "../task.js";

const FEE_SINK_ABI = [
  "function collect() returns (uint256)",
  "function collectable() view returns (uint256 inEscrow, uint256 onCurve, uint256 held)",
];

/**
 * Pull the trade tax into the Treasury.
 *
 * `FeeSink.collect()` runs the whole ETH path in one call: claim whatever the
 * Pons escrow is holding, sweep whatever has accrued on the bonding curve, then
 * forward the lot to `Treasury.fund()`. Each leg is attempted independently
 * inside the contract, so an empty escrow does not lose the curve sweep.
 *
 * This is the job that matters most. Until someone calls it the tax sits in
 * Pons's escrow doing nothing — it is not in the corpus, so it is not backing
 * the floor and not being split with stakers.
 *
 * One thing it cannot fix: the *first* step of the Pons fee path,
 * `sweepPoolFees`, is gated on Pons's own `feeSweepOperator`. Tax can sit in
 * `pendingCreatorTax` where nobody but Pons can move it. `collectable()`
 * reports that separately so the log distinguishes "nothing to collect" from
 * "plenty to collect, and not ours to trigger".
 */
export const collectTax: Job = {
  name: "collect tax",
  target: ADDR.feeSink,

  async plan(signer: Wallet | null): Promise<Decision> {
    const sink = new Contract(ADDR.feeSink, FEE_SINK_ABI, provider);

    let inEscrow = 0n, onCurve = 0n, held = 0n;
    try {
      [inEscrow, onCurve, held] = await sink.collectable();
    } catch (e) {
      return { act: false, reason: `collectable() failed: ${(e as Error).message.split("\n")[0]}` };
    }

    const movable = inEscrow + onCurve + held;
    if (movable === 0n) return { act: false, reason: "escrow, curve and sink are all empty" };

    return appraise(sink, "collect", [], movable, signer);
  },

  async send(signer: Wallet): Promise<string> {
    const sink = new Contract(ADDR.feeSink, FEE_SINK_ABI, signer);
    const tx = await sink.collect();
    await tx.wait();
    return tx.hash;
  },
};
