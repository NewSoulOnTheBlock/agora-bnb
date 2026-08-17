/**
 * Deploy the AGORA Treasury + FeeSink (ETH-denominated corpus).
 *
 *   npm run deploy:robinhood
 *
 * Reads the signer from DEPLOYER_PRIVATE_KEY in .env — never from an argument,
 * so the key does not land in shell history.
 *
 * Deployment order matters: Treasury first, then FeeSink (which takes the
 * Treasury address as an immutable constructor arg), then point the Treasury at
 * the FeeSink. That last step is `onlyOwner`, so when ownership is a multisig
 * this script prints the calldata for governance to execute instead of failing.
 */
import { ethers, network } from "hardhat";

const AGORA_TOKEN =
  process.env.AGORA_TOKEN ?? "0x6853618673D952Fe602616F6f896cC7be8e25fCc";

function line() {
  console.log("─".repeat(72));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No signer. Set DEPLOYER_PRIVATE_KEY in .env (see .env.example)."
    );
  }

  const net = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  line();
  console.log("AGORA Treasury deployment — ETH-denominated corpus");
  line();
  console.log(`network      ${network.name}  (chainId ${net.chainId})`);
  console.log(`deployer     ${deployer.address}`);
  console.log(`balance      ${ethers.formatEther(balance)} ETH`);
  console.log(`AGORA token  ${AGORA_TOKEN}`);

  if (balance === 0n) {
    throw new Error("Deployer has no ETH — fund it before deploying.");
  }

  // --- sanity: is AGORA_TOKEN actually an ERC-20 on this chain? -------------
  const code = await ethers.provider.getCode(AGORA_TOKEN);
  if (code === "0x") {
    throw new Error(
      `No contract at AGORA_TOKEN ${AGORA_TOKEN} on chainId ${net.chainId}. ` +
        `Refusing to deploy a Treasury against a non-existent token.`
    );
  }
  const erc20 = new ethers.Contract(
    AGORA_TOKEN,
    [
      "function symbol() view returns (string)",
      "function totalSupply() view returns (uint256)",
    ],
    ethers.provider
  );
  const [symbol, totalSupply] = await Promise.all([
    erc20.symbol(),
    erc20.totalSupply(),
  ]);
  console.log(`             ↳ ${symbol}, supply ${ethers.formatEther(totalSupply)}`);

  // --- ownership ------------------------------------------------------------
  const owner = process.env.TREASURY_OWNER?.trim() || deployer.address;
  const ownerIsDeployer = owner.toLowerCase() === deployer.address.toLowerCase();

  console.log(`owner        ${owner}`);
  if (ownerIsDeployer) {
    line();
    console.log("⚠  TREASURY_OWNER is the deploying EOA.");
    console.log("   A single EOA will control the collective balance sheet.");
    console.log("   Spec §11's 'no discretionary management' lever and §10's");
    console.log("   adapter-exploit risk both argue for a multisig or timelock.");
    console.log("   Transfer ownership with transferOwnership() once one exists.");
    line();
  }

  // --- deploy ---------------------------------------------------------------
  console.log("\ndeploying Treasury…");
  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(AGORA_TOKEN, owner);
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log(`  Treasury  ${treasuryAddr}`);

  console.log("deploying FeeSink…");
  const FeeSink = await ethers.getContractFactory("FeeSink");
  const feeSink = await FeeSink.deploy(treasuryAddr);
  await feeSink.waitForDeployment();
  const feeSinkAddr = await feeSink.getAddress();
  console.log(`  FeeSink   ${feeSinkAddr}`);

  // --- wire ----------------------------------------------------------------
  if (ownerIsDeployer) {
    console.log("\nwiring Treasury.setFeeSink…");
    const tx = await treasury.setFeeSink(feeSinkAddr);
    await tx.wait();
    console.log(`  done (${tx.hash})`);
  } else {
    const data = treasury.interface.encodeFunctionData("setFeeSink", [feeSinkAddr]);
    line();
    console.log("ACTION REQUIRED — setFeeSink is onlyOwner and the owner is not");
    console.log("the deployer. Execute this from governance:");
    console.log(`  to:   ${treasuryAddr}`);
    console.log(`  data: ${data}`);
    line();
  }

  // --- read back what we deployed, rather than assuming ---------------------
  const [nav, eligible, floor, taxSeen] = await Promise.all([
    treasury.nav(),
    treasury.eligibleSupply(),
    treasury.floorPerToken(),
    treasury.cumulativeTaxReceived(),
  ]);

  line();
  console.log("post-deploy state (read from chain)");
  line();
  console.log(`nav                   ${ethers.formatEther(nav)} ETH`);
  console.log(`eligibleSupply        ${ethers.formatEther(eligible)} AGORA`);
  console.log(`floorPerToken         ${ethers.formatEther(floor)} ETH`);
  console.log(`cumulativeTaxReceived ${ethers.formatEther(taxSeen)} ETH`);
  console.log(`feeSink               ${await treasury.feeSink()}`);
  console.log(`redeemer              ${await treasury.redeemer()}  (unset until Redeemer ships)`);
  console.log(`sleeveBps             ${await treasury.sleeveBps()}`);

  line();
  console.log("NEXT STEPS");
  line();
  console.log("1. Wire the frontend — tithe/frontend/src/chain.ts:");
  console.log(`     feeSink:  "${feeSinkAddr}",`);
  console.log(`     treasury: "${treasuryAddr}",`);
  console.log("");
  console.log("2. Point AGORA's creator fees at the FeeSink. From the deployer");
  console.log("   of the Pons launch, on PonsV2LaunchFactory:");
  console.log(`     transferCreatorFeeRecipient(${AGORA_TOKEN}, ${feeSinkAddr})`);
  console.log("   NOTE: 3-day timelock + 3-day execution window. A contract IS");
  console.log("   an accepted recipient (probed and confirmed).");
  console.log("");
  console.log("3. Claim accrued fees as the FeeSink, then sweep:");
  console.log("     V2FeeEscrow.claim()   // pays msg.sender — must be called BY the sink");
  console.log("     FeeSink.sweep()       // permissionless");
  console.log("   Step 1 of the Pons fee path (sweepPoolFees) is gated on Pons's");
  console.log("   own feeSweepOperator and is not ours to trigger — spec §14.4.");
  console.log("");
  console.log("4. Test the whole path with a SMALL amount first. The sweepFees");
  console.log("   destination has never been verified — the public RPC exposes no");
  console.log("   trace API, so where the ETH lands is inferred, not proven.");
  line();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
