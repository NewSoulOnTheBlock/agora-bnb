/**
 * Claim your accrued staking yield to the signing wallet.
 *
 *   npx hardhat run scripts/claim-yield.ts --network robinhood
 *
 * This pays out income you have already earned as a staker. It does NOT touch
 * the corpus, so NAV and the reported floor are unchanged — the ETH was never
 * counted as backing in the first place.
 *
 * Prefer this over `withdraw.ts` when you need funds: withdrawing takes money
 * out of the reserve and drops the floor, whereas claiming only moves what is
 * already yours.
 */
import { ethers } from "hardhat";

const line = () => console.log("─".repeat(70));
const eth = (v: bigint) => ethers.formatEther(v);

async function main() {
  const [signer] = await ethers.getSigners();
  const t = await ethers.getContractAt("Treasury", process.env.TREASURY!, ethers.provider);
  const dist = await ethers.getContractAt("Distributor", await t.distributor(), ethers.provider);

  const toriiVault = await ethers.getContractAt("StakedTorii", await dist.stakedAgora(), signer);
  const suitsVault = await ethers.getContractAt("StakedSuits", await dist.stakedSuits(), signer);

  const before = await ethers.provider.getBalance(signer.address);
  const navBefore = await t.nav();
  const floorBefore = await t.floorPerToken();

  line();
  console.log("CLAIM STAKING YIELD");
  line();
  console.log(`  wallet            ${signer.address}`);
  console.log(`  balance           ${eth(before)} ETH`);

  const [fromTorii, fromSuits] = await Promise.all([
    toriiVault.pendingYield(signer.address),
    suitsVault.pendingYield(signer.address),
  ]);
  console.log(`  claimable stTORII ${eth(fromTorii)} ETH`);
  console.log(`  claimable Suits   ${eth(fromSuits)} ETH`);

  if (fromTorii === 0n && fromSuits === 0n) {
    console.log("\nNothing to claim.");
    return;
  }

  for (const [label, vault, amount] of [
    ["stTORII", toriiVault, fromTorii],
    ["Suits", suitsVault, fromSuits],
  ] as const) {
    if (amount === 0n) continue;
    console.log(`\nclaiming ${eth(amount)} ETH from ${label}…`);
    const tx = await vault.claim();
    await tx.wait();
    console.log(`  ${tx.hash}`);
  }

  line();
  const after = await ethers.provider.getBalance(signer.address);
  console.log(`  balance now       ${eth(after)} ETH  (+${eth(after - before)} net of gas)`);
  console.log(`  nav               ${eth(await t.nav())} ETH  ${(await t.nav()) === navBefore ? "← untouched" : ""}`);
  console.log(`  floorPerToken     ${eth(await t.floorPerToken())} ETH ${(await t.floorPerToken()) === floorBefore ? "← untouched" : ""}`);
  line();
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
