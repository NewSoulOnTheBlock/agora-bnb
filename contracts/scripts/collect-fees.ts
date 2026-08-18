/**
 * Move accrued creator tax from the bonding curve into the Treasury.
 *
 *   npx hardhat run scripts/collect-fees.ts --network robinhood
 *
 * Every call here is PERMISSIONLESS and every destination is immutable — the
 * FeeSink has no function that takes a destination address, so this can only
 * push value along the one path it was always going to take. Anyone can run it.
 *
 * ## Why three calls and not FeeSink.collect()
 *
 * Pre-graduation, `curve.sweepFees()` does not pay the caller. It moves the
 * accrued tax into Pons's V2FeeEscrow and credits the fee recipient there; the
 * recipient then has to call `escrow.claim()` to actually receive it. Pons is
 * pull-based at every stage.
 *
 * `FeeSink.collect()` claims the escrow BEFORE sweeping the curve, so on a
 * first run it claims an empty escrow, moves the tax into the escrow, finds its
 * own balance still zero and reverts `NothingToSweep` — rolling the sweep back
 * with it. The order is wrong. Doing the same three steps by hand works today
 * and needs no redeploy.
 */
import { ethers } from "hardhat";

const FEE_SINK = process.env.FEE_SINK!;
const TREASURY = process.env.TREASURY!;
const CURVE = process.env.CURVE!;
const ESCROW = process.env.PONS_FEE_ESCROW ?? "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";

const line = () => console.log("─".repeat(70));
const eth = (v: bigint) => `${ethers.formatEther(v)} ETH`;

async function main() {
  const [signer] = await ethers.getSigners();
  const sink = await ethers.getContractAt("FeeSink", FEE_SINK, signer);
  const treasury = await ethers.getContractAt("Treasury", TREASURY, signer);
  const curve = new ethers.Contract(
    CURVE, ["function creatorTaxBalance() view returns (uint256)"], ethers.provider
  );
  const escrow = new ethers.Contract(
    ESCROW, ["function balanceOf(address) view returns (uint256)"], ethers.provider
  );

  const snap = async (tag: string) => {
    const [onCurve, inEscrow, held, tax, nav, income] = await Promise.all([
      curve.creatorTaxBalance(),
      escrow.balanceOf(FEE_SINK),
      ethers.provider.getBalance(FEE_SINK),
      treasury.cumulativeTaxReceived(),
      treasury.nav(),
      treasury.pendingIncome(),
    ]);
    console.log(`${tag}`);
    console.log(`   curve tax ${eth(onCurve)} · escrow ${eth(inEscrow)} · sink ${eth(held)}`);
    console.log(`   treasury: tax ${eth(tax)} · nav ${eth(nav)} · owed to stakers ${eth(income)}`);
    return { onCurve, inEscrow, held, tax, nav, income };
  };

  line();
  console.log("COLLECT FEES");
  line();
  console.log(`signer ${signer.address}  balance ${eth(await ethers.provider.getBalance(signer.address))}`);
  const before = await snap("\nbefore:");

  if (before.onCurve === 0n && before.inEscrow === 0n && before.held === 0n) {
    console.log("\nNothing to collect.");
    return;
  }

  // 1 — curve → escrow
  if (before.onCurve > 0n) {
    console.log(`\n1/3  sweepCurve — move ${eth(before.onCurve)} from the curve into the escrow`);
    const tx = await sink.sweepCurve(0);
    await tx.wait();
    console.log(`     ${tx.hash}`);
    await snap("     →");
  } else {
    console.log("\n1/3  sweepCurve — skipped, curve is empty");
  }

  // 2 — escrow → sink
  const mid = await escrow.balanceOf(FEE_SINK);
  if (mid > 0n) {
    console.log(`\n2/3  claimFromEscrow — pull ${eth(mid)} into the FeeSink`);
    const tx = await sink.claimFromEscrow();
    await tx.wait();
    console.log(`     ${tx.hash}`);
    await snap("     →");
  } else {
    console.log("\n2/3  claimFromEscrow — skipped, escrow credited nothing");
    console.log("     (if the curve had a balance, sweepFees sent it somewhere else —");
    console.log("      stop and re-diagnose before running this again)");
  }

  // 3 — sink → treasury
  const held = await ethers.provider.getBalance(FEE_SINK);
  if (held > 0n) {
    console.log(`\n3/3  sweep — forward ${eth(held)} to the Treasury`);
    const tx = await sink.sweep();
    await tx.wait();
    console.log(`     ${tx.hash}`);
  } else {
    console.log("\n3/3  sweep — skipped, the sink holds nothing");
  }

  const after = await snap("\nafter:");

  line();
  const delivered = after.tax - before.tax;
  console.log(`delivered to the Treasury   ${eth(delivered)}`);
  if (delivered > 0n) {
    console.log(`  → corpus (raises the floor) ${eth(delivered - (after.income - before.income))}`);
    console.log(`  → owed to stakers           ${eth(after.income - before.income)}`);
    console.log(`\nfloorPerToken now ${ethers.formatEther(await treasury.floorPerToken())} ETH`);
  }
  line();
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
