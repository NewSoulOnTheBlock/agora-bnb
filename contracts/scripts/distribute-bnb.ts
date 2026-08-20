/**
 * Push earmarked income out to stTORII stakers on BNB Chain.
 *
 *   npx hardhat run scripts/distribute-bnb.ts --network bsc
 *
 * Requires TREASURY in .env. Permissionless — `distributeIncome()` takes no
 * arguments and its destination is fixed, so anyone may crank it.
 *
 * ## Why `distribute.ts` cannot be used here
 *
 * That script reads `dist.stakedSuits()`. `ToriiDistributor` has no such
 * function: the Suits ERC-721 is a Robinhood Chain collection with no BNB
 * deployment, so the BNB distributor is single-sink. Dropping Suits changed the
 * Distributor's ABI, which silently made every script that reads that ABI
 * BNB-incompatible — this is the replacement for the one that matters.
 *
 * With one sink there is no split to preview and no reroute to reason about:
 * every unit of earmarked income goes to stTORII.
 *
 * ## The revert that is not a bug
 *
 * `ToriiDistributor` reverts `NoStakers` while `StakedTorii.totalSupply()` is 0.
 * That is deliberate. The vault cannot account for ETH nobody has staked
 * against, and accepting it would create a claim no one can exercise. Reverting
 * leaves the income earmarked in the Treasury — still owed, still distributable
 * the moment somebody stakes — rather than stranded in a vault or quietly
 * reclassified as corpus.
 */
import { ethers, network } from "hardhat";

const line = () => console.log("─".repeat(72));
const bnb = (v: bigint) => `${ethers.formatEther(v)} BNB`;

async function main() {
  const TREASURY = process.env.TREASURY?.trim();
  if (!TREASURY) throw new Error("TREASURY not set in .env");

  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 56n && net.chainId !== 97n) {
    throw new Error(
      `Chain ${net.chainId} is not a BNB chain. For Robinhood use scripts/distribute.ts, ` +
        `which understands the two-sink Distributor.`
    );
  }

  const [signer] = await ethers.getSigners();
  const t = await ethers.getContractAt("Treasury", TREASURY, signer);
  const dist = await ethers.getContractAt("ToriiDistributor", await t.distributor(), ethers.provider);
  const staking = await ethers.getContractAt("StakedTorii", await dist.stakedAgora(), ethers.provider);

  const [income, nav, floor, shares, share] = await Promise.all([
    t.pendingIncome(),
    t.nav(),
    t.floorPerToken(),
    staking.totalSupply(),
    t.incomeShareBps(),
  ]);

  line();
  console.log("DISTRIBUTE INCOME — BNB");
  line();
  console.log(`network   ${network.name} (chainId ${net.chainId})`);
  console.log(`treasury  ${TREASURY}`);
  console.log(`  earmarked income  ${bnb(income)}`);
  console.log(`  stTORII supply    ${shares} shares`);
  console.log(`  incomeShareBps    ${share}  (${Number(share) / 100}% of future tax)`);
  console.log(`  nav (untouched)   ${bnb(nav)}`);

  if (income === 0n) {
    console.log("\nNothing earmarked.");
    if (share === 0n) {
      console.log("incomeShareBps is 0, so tax is booked entirely as corpus and income");
      console.log("will never accrue. Run set-income-share.ts if that is not intended.");
    }
    return;
  }

  if (shares === 0n) {
    console.log("\nNo stTORII stakers — distribute() would revert NoStakers.");
    console.log("The income stays earmarked in the Treasury and is not lost. No");
    console.log("transaction sent.");
    return;
  }

  console.log(`\n  → stTORII         ${bnb(income)}   (single sink; no Suits on BNB)`);

  console.log("\nsimulating…");
  await t.distributeIncome.staticCall();
  console.log("  ✓ simulates cleanly");

  const tx = await t.distributeIncome();
  console.log(`sending… ${tx.hash}`);
  await tx.wait();

  line();
  console.log("AFTER");
  const [income2, nav2, floor2, paid] = await Promise.all([
    t.pendingIncome(),
    t.nav(),
    t.floorPerToken(),
    staking.cumulativeRewards().catch(() => 0n),
  ]);
  console.log(`  earmarked income  ${bnb(income2)}`);
  console.log(`  paid to stTORII   ${bnb(paid)} (cumulative)`);
  console.log(`  nav               ${bnb(nav2)}   ${nav2 === nav ? "← unchanged, as designed" : "← CHANGED, investigate"}`);
  console.log(`  floorPerToken     ${floor2} wei ${floor2 === floor ? "← unchanged" : "← CHANGED, investigate"}`);

  const you = await staking.pendingYield(signer.address).catch(() => 0n);
  if (you > 0n) console.log(`\n  claimable by ${signer.address.slice(0, 10)}…  ${bnb(you)}`);
  line();
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
