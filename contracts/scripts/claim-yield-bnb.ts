/**
 * Claim your stTORII staking yield on BNB Chain.
 *
 *   npx hardhat run scripts/claim-yield-bnb.ts --network bsc
 *
 * Requires TREASURY in .env. Claims for the signer only — `claim()` pays
 * `msg.sender`, so this cannot be used to claim on anyone else's behalf.
 *
 * ## Why `claim-yield.ts` cannot be used here
 *
 * That script reads `dist.stakedSuits()` and claims from both vaults.
 * `ToriiDistributor` has no Suits sink, so it reverts before doing anything.
 * There is exactly one place to claim from on BNB.
 *
 * ## Where the money has to be before this pays anything
 *
 * Yield reaches a staker through three separate steps, and stalling at any one
 * of them looks identical from here — a zero balance:
 *
 *   1. tax lands in the ToriiVault      → collect-bnb.ts   (forward to Treasury)
 *   2. Treasury earmarks the staker cut → automatic, but ONLY if incomeShareBps
 *                                          is non-zero at the time of the forward
 *   3. earmarked income reaches stTORII → distribute-bnb.ts
 *
 * So this script reports the whole pipeline rather than just your balance. A
 * zero claim with income sitting at step 2 is a missing crank, not an empty
 * protocol, and the two deserve different reactions.
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
      `Chain ${net.chainId} is not a BNB chain. For Robinhood use scripts/claim-yield.ts.`
    );
  }

  const [signer] = await ethers.getSigners();
  const t = await ethers.getContractAt("Treasury", TREASURY, signer);
  const dist = await ethers.getContractAt("ToriiDistributor", await t.distributor(), ethers.provider);
  const staking = await ethers.getContractAt("StakedTorii", await dist.stakedAgora(), signer);

  const [pending, shares, totalShares, earmarked, vaultAddr] = await Promise.all([
    staking.pendingYield(signer.address),
    staking.balanceOf(signer.address),
    staking.totalSupply(),
    t.pendingIncome(),
    t.feeSink(),
  ]);
  const inVault = await ethers.provider.getBalance(vaultAddr);

  line();
  console.log("CLAIM stTORII YIELD — BNB");
  line();
  console.log(`network   ${network.name} (chainId ${net.chainId})`);
  console.log(`signer    ${signer.address}`);
  console.log(`  your stTORII shares   ${shares}`);
  console.log(`  total stTORII shares  ${totalShares}`);
  console.log(`  your claimable yield  ${bnb(pending)}`);

  console.log("\npipeline behind that number:");
  console.log(`  1. in the vault, unforwarded   ${bnb(inVault)}   → collect-bnb.ts`);
  console.log(`  2. earmarked, undistributed    ${bnb(earmarked)}   → distribute-bnb.ts`);
  console.log(`  3. yours to claim              ${bnb(pending)}`);

  if (pending === 0n) {
    console.log("\nNothing to claim.");
    if (shares === 0n) {
      console.log("You hold no stTORII — stake first, then yield accrues from the next");
      console.log("distribution onward. Distributions are not retroactive.");
    } else if (earmarked > 0n) {
      console.log("Income IS earmarked but has not been distributed. Run distribute-bnb.ts");
      console.log("and then claim again.");
    } else if (inVault > 0n) {
      console.log("Tax is sitting in the vault unforwarded. Run collect-bnb.ts first.");
    }
    return;
  }

  console.log("\nsimulating…");
  await staking.claim.staticCall();
  console.log("  ✓ simulates cleanly");

  const before = await ethers.provider.getBalance(signer.address);
  const tx = await staking.claim();
  console.log(`sending… ${tx.hash}`);
  const rc = await tx.wait();

  const after = await ethers.provider.getBalance(signer.address);
  const gas = rc!.gasUsed * (rc!.gasPrice ?? 0n);

  line();
  // after = before + claimed - gas, so the claim actually credited is
  // (after - before) + gas. Deriving it this way cross-checks the contract's
  // reported figure against the wallet's real balance change.
  const credited = after - before + gas;
  console.log(`claimed        ${bnb(credited)}${credited === pending ? "" : `   (contract reported ${bnb(pending)})`}`);
  console.log(`gas paid       ${bnb(gas)}`);
  console.log(`net to wallet  ${bnb(after - before)}   (balance ${bnb(after)})`);
  console.log(`remaining claimable ${bnb(await staking.pendingYield(signer.address))}`);
  line();
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
