/**
 * Push earmarked income out to stakers.
 *
 *   npx hardhat run scripts/distribute.ts --network robinhood
 *
 * Permissionless — `distributeIncome()` takes no arguments and its destination
 * is fixed, so anyone may crank it. It moves `Treasury.pendingIncome` to the
 * Distributor, which splits it between the two staking vaults.
 *
 * Reverts if NEITHER vault has stakers, in which case the income stays
 * earmarked rather than being stranded or quietly reclassified as corpus.
 */
import { ethers } from "hardhat";

const line = () => console.log("─".repeat(70));
const eth = (v: bigint) => ethers.formatEther(v);

async function main() {
  const [signer] = await ethers.getSigners();
  const t = await ethers.getContractAt("Treasury", process.env.TREASURY!, signer);
  const dist = await ethers.getContractAt("Distributor", await t.distributor(), ethers.provider);
  const stAgora = await ethers.getContractAt("StakedAgora", await dist.stakedAgora(), ethers.provider);
  const stSuits = await ethers.getContractAt("StakedSuits", await dist.stakedSuits(), ethers.provider);

  const [income, nav, floor, shares, suits] = await Promise.all([
    t.pendingIncome(), t.nav(), t.floorPerToken(),
    stAgora.totalSupply(), stSuits.totalStaked(),
  ]);

  line();
  console.log("DISTRIBUTE INCOME");
  line();
  console.log(`  earmarked income  ${eth(income)} ETH`);
  console.log(`  stAGORA staked    ${eth(shares)} shares`);
  console.log(`  Suits staked      ${suits} / 1111`);
  console.log(`  nav (untouched)   ${eth(nav)} ETH`);

  if (income === 0n) { console.log("\nNothing earmarked."); return; }

  const [toSuits, toAgora] = await dist.preview(income);
  console.log(`\n  → staked Suits    ${eth(toSuits)} ETH${suits === 0n ? "   (rerouted — none staked)" : ""}`);
  console.log(`  → stAGORA         ${eth(toAgora)} ETH`);

  console.log("\nsimulating…");
  await t.distributeIncome.staticCall();
  console.log("  ✓ simulates cleanly");

  const tx = await t.distributeIncome();
  console.log(`sending… ${tx.hash}`);
  await tx.wait();

  line();
  console.log("AFTER");
  const [income2, nav2, floor2, agoraRewards, suitsRewards] = await Promise.all([
    t.pendingIncome(), t.nav(), t.floorPerToken(),
    stAgora.cumulativeRewards(), stSuits.cumulativeRewards(),
  ]);
  console.log(`  earmarked income  ${eth(income2)} ETH`);
  console.log(`  paid to stAGORA   ${eth(agoraRewards)} ETH (cumulative)`);
  console.log(`  paid to Suits     ${eth(suitsRewards)} ETH (cumulative)`);
  console.log(`  nav               ${eth(nav2)} ETH   ${nav2 === nav ? "← unchanged, as designed" : "← CHANGED, investigate"}`);
  console.log(`  floorPerToken     ${eth(floor2)} ETH ${floor2 === floor ? "← unchanged" : ""}`);

  const you = await stAgora.pendingYield(signer.address);
  if (you > 0n) console.log(`\n  claimable by ${signer.address.slice(0, 10)}…  ${eth(you)} ETH`);
  line();
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
