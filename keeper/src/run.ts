import { formatEther } from "ethers";
import { provider, wallet, hasKey, EXECUTE, INTERVAL_S, MIN_RATIO, CHAIN_ID, RPC_URL } from "./config.js";
import { log, type Job } from "./task.js";
import { collectTax } from "./tasks/collect.js";
import { distributeIncome } from "./tasks/distribute.js";
import { realizeSurplus } from "./tasks/realize.js";

/**
 * The TORII keeper.
 *
 * Three jobs, run in order, on a loop:
 *
 *   collect tax     FeeSink.collect()            escrow + curve → Treasury
 *   distribute      Treasury.distributeIncome()  earmarked income → stakers
 *   realize surplus Treasury.realizeSurplus(a)   sleeve yield → earmarked income
 *
 * Order matters: collecting can create income to distribute in the same pass,
 * and realizing surplus creates income for the next one.
 *
 * ## What this deliberately does not do
 *
 * It does not move corpus ETH into or out of a yield venue. `depositToAdapter`,
 * `withdrawFromAdapter`, `setSleeveBps` and `withdraw` are all owner-only, and
 * they stay that way — allocating capital is a decision, not a cron job. The
 * keeper only pushes value along paths the contracts already fixed, which is
 * why it can run unattended with a key that has no privileges.
 *
 * ## Failure policy
 *
 * A job that throws is logged and the loop continues. A keeper that dies on a
 * transient RPC error is worse than no keeper, because the tax quietly stops
 * reaching the corpus and nothing announces it.
 */

const JOBS: Job[] = [collectTax, distributeIncome, realizeSurplus];

const line = () => console.log("─".repeat(72));

async function pass(): Promise<void> {
  const signer = hasKey() ? wallet() : null;

  for (const job of JOBS) {
    try {
      const decision = await job.plan(signer);

      if (!decision.act) {
        log(job.name, decision);
        continue;
      }

      if (!EXECUTE || !signer) {
        log(job.name, decision, "(dry run — set KEEPER_EXECUTE=1 to send)");
        continue;
      }

      const hash = await job.send(signer);
      log(job.name, decision, `→ ${hash}`);
    } catch (e) {
      const msg = (e as Error).message?.split("\n")[0] ?? String(e);
      console.log(`${new Date().toISOString().slice(11, 19)}  ${job.name.padEnd(18)} ERROR  ${msg}`);
    }
  }
}

async function main() {
  const once = process.argv.includes("--once");

  line();
  console.log("TORII keeper");
  line();
  console.log(`rpc        ${RPC_URL}`);
  console.log(`chain      ${CHAIN_ID}`);
  console.log(`mode       ${EXECUTE ? "LIVE — transactions will be sent" : "dry run"}`);
  console.log(`min ratio  ${MIN_RATIO}× gas`);
  console.log(`interval   ${once ? "single pass" : `${INTERVAL_S}s`}`);

  if (hasKey()) {
    const w = wallet();
    const bal = await provider.getBalance(w.address);
    console.log(`keeper     ${w.address}`);
    console.log(`gas        ${formatEther(bal)} ETH`);
    if (bal === 0n) {
      console.log("");
      console.log("⚠  The keeper wallet has no ETH. Every job will fail at estimation.");
    }
  } else {
    console.log("keeper     (no key — planning only)");
  }
  line();

  await pass();
  if (once) return;

  // `setTimeout` rather than `setInterval`: a slow pass must not overlap the
  // next one, or two keepers race each other for the same nonce.
  const tick = async () => {
    await pass();
    setTimeout(tick, INTERVAL_S * 1000);
  };
  setTimeout(tick, INTERVAL_S * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
