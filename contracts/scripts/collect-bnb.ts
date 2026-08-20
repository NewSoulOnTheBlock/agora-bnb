/**
 * Push collected tax from the ToriiVault into the Treasury.
 *
 *   npx hardhat run scripts/collect-bnb.ts --network bsc
 *
 * Requires TORII_VAULT and TREASURY in .env. Permissionless — the vault's
 * destination is immutable and no function here takes a destination argument,
 * so anyone may run this and it can only push value along the one path it was
 * always going to take. It costs the caller gas and pays them nothing.
 *
 * ## Why this is not `collect-fees.ts`
 *
 * On Robinhood Chain collection is a PULL: sweep the curve, claim the escrow,
 * forward. Three calls, and the middle one depends on a Pons keeper that is not
 * ours — which is exactly how tax ended up stranded in `pendingCreatorTax`.
 *
 * Flap pushes. The BNB is already in the vault by the time anyone looks; the
 * only thing left to do is move it on. So there is no claim step here, and
 * nothing to wait for.
 *
 * ## Two assets, two paths
 *
 * The vault's quote token is native BNB, so `accountedQuote` tracks BNB only:
 *
 *   - BNB (bonding-curve-era tax) -> `forwardQuote()`
 *   - TORII (post-graduation tax) -> `convertAndForward()`, which sells it for
 *     BNB first. Forwarding it raw would be pointless: the Treasury marks TORII
 *     at zero when computing NAV, so the balance sheet would not move.
 *
 * `convertAndForward` also sweeps any BNB already recognised, so when both legs
 * are present one call handles both.
 *
 * Set SLIPPAGE_BPS to bound the swap (default 500 = 5%). The bound is
 * caller-supplied by design — a hardcoded one would be wrong at some price, and
 * an owner-settable one would be a lever over everyone else's execution.
 */
import { ethers } from "hardhat";

const line = () => console.log("─".repeat(72));
const bnb = (v: bigint) => `${ethers.formatEther(v)} BNB`;

const req = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Set ${name} in .env`);
  return v;
};

async function main() {
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 56n && net.chainId !== 97n) {
    throw new Error(`Chain ${net.chainId} is not a BNB chain. Use --network bsc.`);
  }

  const VAULT = req("TORII_VAULT");
  const TREASURY = req("TREASURY");
  const slippageBps = BigInt(process.env.SLIPPAGE_BPS ?? "500");

  const vault = await ethers.getContractAt("ToriiVault", VAULT, signer);
  const treasury = await ethers.getContractAt("Treasury", TREASURY, signer);
  const token = await ethers.getContractAt("StakedTorii", await vault.taxToken(), signer);

  // The vault must be the one this Treasury actually recognises, or the forward
  // lands as a donation instead of tax and the staker share is never earmarked.
  const feeSink = await treasury.feeSink();
  if (feeSink.toLowerCase() !== VAULT.toLowerCase()) {
    throw new Error(
      `Treasury.feeSink() is ${feeSink}, not the vault ${VAULT}. Forwarding now would ` +
        `book the BNB as a donation — all corpus, nothing for stakers. Fix the wiring first.`
    );
  }

  const snap = async (tag: string) => {
    const [held, accounted, tokenBal, nav, income, floor, tax] = await Promise.all([
      ethers.provider.getBalance(VAULT),
      vault.accountedQuote(),
      token.balanceOf(VAULT),
      treasury.nav(),
      treasury.pendingIncome(),
      treasury.floorPerToken(),
      treasury.cumulativeTaxReceived(),
    ]);
    console.log(tag);
    console.log(`   vault:    ${bnb(held)} held · ${bnb(accounted)} recognised · ${ethers.formatEther(tokenBal)} TORII`);
    console.log(`   treasury: nav ${bnb(nav)} · owed to stakers ${bnb(income)} · tax ${bnb(tax)}`);
    console.log(`   floorPerToken ${floor} wei`);
    return { held, accounted, tokenBal, nav, income, floor, tax };
  };

  line();
  console.log("COLLECT — ToriiVault → Treasury");
  line();
  console.log(`signer ${signer.address}  balance ${bnb(await ethers.provider.getBalance(signer.address))}`);
  console.log(`vault  ${VAULT}`);
  const before = await snap("\nbefore:");

  if (before.held === 0n && before.tokenBal === 0n) {
    console.log("\nNothing to collect. No transaction sent.");
    return;
  }

  if (before.tokenBal > 0n) {
    // Quote through the router, then discount it. getAmountsOut is optimistic
    // for a fee-on-transfer token — it does not know the transfer tax — so the
    // slippage bound has to absorb that as well as price movement.
    const router = new ethers.Contract(
      await vault.router(),
      ["function WETH() view returns (address)", "function getAmountsOut(uint256,address[]) view returns (uint256[])"],
      ethers.provider
    );
    const path = [await vault.taxToken(), await router.WETH()];
    let minOut = 1n;
    try {
      const amounts = await router.getAmountsOut(before.tokenBal, path);
      const quoted = BigInt(amounts[amounts.length - 1]);
      minOut = (quoted * (10_000n - slippageBps)) / 10_000n;
      if (minOut === 0n) minOut = 1n;
      console.log(`\nconvertAndForward — selling ${ethers.formatEther(before.tokenBal)} TORII`);
      console.log(`   quoted ${bnb(quoted)}, min ${bnb(minOut)} at ${Number(slippageBps) / 100}% slippage`);
    } catch {
      console.log("\nconvertAndForward — router could not quote (thin or missing pool).");
      console.log("   Refusing to send with an unbounded minOut. Set SLIPPAGE_BPS and a");
      console.log("   manual floor, or wait for liquidity.");
      return;
    }

    const deadline = Math.floor(Date.now() / 1000) + 600;
    const tx = await vault.convertAndForward(0, minOut, deadline);
    console.log(`   ${tx.hash}`);
    await tx.wait();
  } else {
    console.log(`\nforwardQuote — pushing ${bnb(before.held)} to the Treasury`);
    const tx = await vault.forwardQuote();
    console.log(`   ${tx.hash}`);
    await tx.wait();
  }

  const after = await snap("\nafter:");

  line();
  const delivered = after.tax - before.tax;
  console.log(`delivered to the Treasury   ${bnb(delivered)}`);
  if (delivered > 0n) {
    const toStakers = after.income - before.income;
    console.log(`  → corpus (raises the floor) ${bnb(delivered - toStakers)}`);
    console.log(`  → owed to stakers           ${bnb(toStakers)}`);
    console.log(`\nfloorPerToken ${before.floor} → ${after.floor} wei`);
  }
  console.log("\nStaker income needs `distribute` to reach stAGORA. ToriiDistributor");
  console.log("reverts NoStakers while StakedTorii.totalSupply() is 0, which leaves the");
  console.log("income earmarked in the Treasury rather than stranded.");
  line();
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
