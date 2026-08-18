/**
 * Withdraw corpus ETH from the Treasury to the operator wallet.
 *
 *   WITHDRAW_ETH=0.17 npx hardhat run scripts/withdraw.ts --network robinhood
 *
 * Dry run by default. Set WITHDRAW_EXECUTE=1 to actually send.
 *
 * `withdraw` takes an amount but NO destination — funds can only reach
 * `Treasury.operator()`. It is capped at `liquidEth()`, so ETH already
 * earmarked for stakers cannot be touched.
 *
 * This lowers NAV and therefore the reported floor. That is not a bug: the
 * floor reports what currently backs each token, and this removes backing.
 * The script prints the before/after floor so the effect is explicit, and the
 * transaction emits `Withdrawn(to, amount, navAfter)` plus `FloorRegression`.
 */
import { ethers } from "hardhat";

const line = () => console.log("─".repeat(70));
const eth = (v: bigint) => ethers.formatEther(v);

async function main() {
  // Amount defaults so only the execute flag has to be typed. WITHDRAW_EXECUTE
  // deliberately has NO default: this moves reserve funds and drops the floor,
  // so firing it must always be an explicit act rather than the result of
  // running a file.
  const raw = process.env.WITHDRAW_ETH?.trim() || "0.17";
  const amount = ethers.parseEther(raw);

  const [signer] = await ethers.getSigners();
  const t = await ethers.getContractAt("Treasury", process.env.TREASURY!, signer);

  const [owner, operator, nav, liquid, income, floor, supply, already] = await Promise.all([
    t.owner(), t.operator(), t.nav(), t.liquidEth(), t.pendingIncome(),
    t.floorPerToken(), t.eligibleSupply(), t.cumulativeWithdrawn(),
  ]);

  line();
  console.log("WITHDRAW FROM TREASURY");
  line();
  console.log(`signer            ${signer.address}`);
  console.log(`owner             ${owner}`);
  console.log(`operator (dest)   ${operator}`);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log("\nSigner is not the owner. Execute from governance:");
    console.log(`  to:   ${process.env.TREASURY}`);
    console.log(`  data: ${t.interface.encodeFunctionData("withdraw", [amount])}`);
    return;
  }

  line();
  console.log("BEFORE");
  console.log(`  nav (corpus)      ${eth(nav)} ETH`);
  console.log(`  liquid (max out)  ${eth(liquid)} ETH`);
  console.log(`  owed to stakers   ${eth(income)} ETH   ← cannot be withdrawn`);
  console.log(`  floorPerToken     ${eth(floor)} ETH`);
  console.log(`  withdrawn to date ${eth(already)} ETH`);

  if (amount > liquid) {
    line();
    throw new Error(
      `Requested ${eth(amount)} but only ${eth(liquid)} is corpus. ` +
      `The remaining ${eth(income)} is owed to stakers and is not withdrawable.`
    );
  }

  const navAfter = nav - amount;
  const floorAfter = supply > 0n ? (navAfter * 10n ** 18n) / supply : 0n;
  const dropPct = floor > 0n ? Number((floor - floorAfter) * 10000n / floor) / 100 : 0;

  line();
  console.log("AFTER");
  console.log(`  nav (corpus)      ${eth(navAfter)} ETH`);
  console.log(`  floorPerToken     ${eth(floorAfter)} ETH`);
  console.log(`  \x1b[33mfloor falls ${dropPct.toFixed(1)}%\x1b[0m — this emits FloorRegression`);
  console.log(`  owed to stakers   ${eth(income)} ETH   (unchanged)`);

  line();
  console.log("simulating…");
  await t.withdraw.staticCall(amount);
  console.log("  ✓ simulates cleanly");

  if (process.env.WITHDRAW_EXECUTE !== "1") {
    line();
    console.log("DRY RUN — nothing sent.");
    console.log(`Re-run with WITHDRAW_EXECUTE=1 WITHDRAW_ETH=${raw} to send.`);
    line();
    return;
  }

  const tx = await t.withdraw(amount);
  console.log(`sending… ${tx.hash}`);
  await tx.wait();

  line();
  console.log(`withdrew ${eth(amount)} ETH to ${operator}`);
  console.log(`  nav now           ${eth(await t.nav())} ETH`);
  console.log(`  floorPerToken now ${eth(await t.floorPerToken())} ETH`);
  console.log(`  withdrawn to date ${eth(await t.cumulativeWithdrawn())} ETH`);
  line();
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
