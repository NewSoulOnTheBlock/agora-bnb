/**
 * AGORA on BNB Chain — step 1 of 3: deploy before the token exists.
 *
 *   npx hardhat run scripts/deploy-bnb.ts --network bscTestnet
 *   npx hardhat run scripts/deploy-bnb.ts --network bsc
 *
 * ## Why this is not `deploy.ts` with a different RPC
 *
 * There is no Pons on BNB Chain, so the tax does not come from a bonding-curve
 * hook and there is no fee escrow to claim from. Flap provides the launch and
 * *pushes* the tax into a vault we supply. That changes four things:
 *
 *   - `FeeSink` is replaced by `bnb/AgoraVault`, which Flap's VaultPortal
 *     deploys for us during the launch — so its address cannot be known here.
 *   - The tax rate is **5%**, not 4%. Flap offers 1/3/5/10% only.
 *   - `Distributor` is replaced by `bnb/AgoraDistributor`: the Suits ERC-721 is
 *     a Robinhood Chain collection with no BNB deployment, so that vault and its
 *     split are gone entirely.
 *   - The ordering constraint moves. On Robinhood the FeeSink had to exist
 *     before the launch so it could be named `creatorFeeRecipient`. Here the
 *     *factory* has to exist before the launch, because the launch call names it
 *     and Flap constructs the vault from it.
 *
 * Then: launch on Flap (step 2), then `bind-bnb.ts` (step 3).
 */
import { ethers, network } from "hardhat";

/** PancakeSwap V2 router — the vault sells the post-graduation token leg here. */
const PANCAKE_V2_ROUTER =
  process.env.PANCAKE_ROUTER ?? "0x10ED43C718714eb63d5aA57B78B54704E256024E";

/** Flap VaultPortal, chain 56. Used only to echo the launch call. */
const FLAP_VAULT_PORTAL =
  process.env.FLAP_VAULT_PORTAL ?? "0x90497450f2a706f1951b5bdda52B4E5d16f34C06";

const line = () => console.log("─".repeat(72));

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in .env.");

  const net = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  line();
  console.log("AGORA on BNB — step 1/3: deploy (token does NOT exist yet)");
  line();
  console.log(`network   ${network.name}  (chainId ${net.chainId})`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`balance   ${ethers.formatEther(balance)} BNB`);
  if (balance === 0n) throw new Error("Deployer has no BNB.");

  if (net.chainId !== 56n && net.chainId !== 97n) {
    throw new Error(
      `Chain ${net.chainId} is not a Flap BNB chain. Flap resolves its Portal and ` +
        `Guardian from a hardcoded table; use --network bsc or --network bscTestnet.`
    );
  }

  // A router with no code would not fail until the first post-graduation swap,
  // by which time the tax leg is already piling up unsellable.
  const routerCode = await ethers.provider.getCode(PANCAKE_V2_ROUTER);
  if (routerCode === "0x") {
    throw new Error(`No contract at PANCAKE_ROUTER ${PANCAKE_V2_ROUTER} on chain ${net.chainId}.`);
  }
  console.log(`router    ${PANCAKE_V2_ROUTER}  (${(routerCode.length - 2) / 2} bytes)`);

  const owner = process.env.TREASURY_OWNER?.trim() || deployer.address;
  const ownerIsDeployer = owner.toLowerCase() === deployer.address.toLowerCase();
  console.log(`owner     ${owner}`);
  if (ownerIsDeployer) {
    line();
    console.log("⚠  TREASURY_OWNER is the deploying EOA — a single key will control");
    console.log("   the collective balance sheet, including withdraw(). Move to a");
    console.log("   multisig with transferOwnership() before the corpus holds value.");
    line();
  }

  console.log("\ndeploying Treasury…");
  const treasury = await (await ethers.getContractFactory("Treasury")).deploy(owner);
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log(`  Treasury           ${treasuryAddr}`);

  console.log("deploying AgoraVaultFactory…");
  const factory = await (
    await ethers.getContractFactory("AgoraVaultFactory")
  ).deploy(treasuryAddr, PANCAKE_V2_ROUTER);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`  AgoraVaultFactory  ${factoryAddr}`);

  line();
  console.log("post-deploy state (read from chain)");
  line();
  console.log(`Treasury.agora()      ${await treasury.agora()}   <- ZERO until step 3`);
  console.log(`Treasury.feeSink()    ${await treasury.feeSink()}   <- ZERO until step 3`);
  console.log(`Treasury.redeemer()   ${await treasury.redeemer()}   <- no BNB can leave`);
  console.log(`Factory.treasury()    ${await factory.treasury()}`);
  console.log(`Factory.router()      ${await factory.router()}`);
  console.log(`Factory.specVersion() ${await factory.factorySpecVersion()}`);
  console.log(
    `Factory quote support native=${await factory.isQuoteTokenSupported(ethers.ZeroAddress)}`
  );

  line();
  console.log("NEXT — step 2: launch AGORA on Flap with this factory");
  line();
  console.log(`Call ${FLAP_VAULT_PORTAL}.newTokenV6WithVault(params) with:`);
  console.log("");
  console.log("  tokenVersion   TOKEN_TAXED_V3");
  console.log("  quoteToken     0x0000000000000000000000000000000000000000  (native BNB)");
  console.log("  buyTaxRate     500        // 5%");
  console.log("  sellTaxRate    500        // 5%");
  console.log("  vaultBps       10000      // 100% of the tax to the reserve vault");
  console.log("  deflationBps   0");
  console.log("  dividendBps    0");
  console.log("  lpBps          0");
  console.log(`  vaultFactory   ${factoryAddr}`);
  console.log("  vaultData      0x         // this factory takes no launch-time config");
  console.log("");
  console.log("Those numbers are not advisory. AgoraVaultFactory._validateBeforeLaunch");
  console.log("rejects the launch outright if the rate is not 5/5 or vaultBps is not");
  console.log("10000 — so a mis-typed form fails at creation instead of producing a");
  console.log("token that looks correct and underfunds the reserve forever.");
  console.log("");
  console.log("Put this in .env before running step 3:");
  console.log("");
  console.log(`  TREASURY=${treasuryAddr}`);
  console.log(`  VAULT_FACTORY=${factoryAddr}`);
  console.log("  AGORA_TOKEN=<address emitted by the launch>");
  console.log("  AGORA_VAULT=<VaultCreated.vault from the launch tx>");
  line();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
