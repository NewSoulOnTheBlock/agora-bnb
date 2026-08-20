/**
 * AGORA on BNB Chain — step 3 of 3: deploy the staking side and wire everything.
 *
 *   npx hardhat run scripts/bind-bnb.ts --network bsc
 *
 * Requires in .env: TREASURY, AGORA_TOKEN, AGORA_VAULT, and optionally
 * VAULT_FACTORY (checked, not used).
 *
 * ## The step that quietly breaks the economics
 *
 * `Treasury.fund()` decides what an inflow *means* by looking at who sent it:
 *
 *     bool isTax = msg.sender == feeSink && feeSink != address(0);
 *
 * Tax is split — 70% corpus, 30% earmarked for stakers. Anything else is
 * treated as a donation and lands entirely in the corpus. So if `setFeeSink` is
 * never pointed at the AgoraVault, everything still *works*: the vault collects,
 * the Treasury's balance grows, the floor rises. Stakers simply never get paid,
 * and nothing anywhere reverts to say so.
 *
 * That is the same shape as the v1 failure on Robinhood Chain — a single wiring
 * step, no error, and the damage only visible much later. Hence this script
 * reads every binding back off-chain at the end and refuses to report success
 * unless each one is right.
 */
import { ethers, network } from "hardhat";

const line = () => console.log("─".repeat(72));
const req = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Set ${name} in .env`);
  return v;
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  const TREASURY = req("TREASURY");
  const AGORA_TOKEN = req("AGORA_TOKEN");
  const AGORA_VAULT = req("AGORA_VAULT");

  line();
  console.log("AGORA on BNB — step 3/3: staking side + wiring");
  line();
  console.log(`network   ${network.name}  (chainId ${net.chainId})`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`treasury  ${TREASURY}`);
  console.log(`token     ${AGORA_TOKEN}`);
  console.log(`vault     ${AGORA_VAULT}`);

  for (const [label, addr] of [
    ["TREASURY", TREASURY],
    ["AGORA_TOKEN", AGORA_TOKEN],
    ["AGORA_VAULT", AGORA_VAULT],
  ] as const) {
    if ((await ethers.provider.getCode(addr)) === "0x") {
      throw new Error(`No contract at ${label} ${addr} on chain ${net.chainId}.`);
    }
  }

  const treasury = await ethers.getContractAt("Treasury", TREASURY, deployer);
  const vault = await ethers.getContractAt("AgoraVault", AGORA_VAULT, deployer);

  // The vault Flap built must be the one that pays THIS treasury, and must be
  // bound to THIS token. A vault from someone else's factory would satisfy the
  // interface and route the tax somewhere else entirely.
  const vaultTreasury = await vault.treasury();
  const vaultToken = await vault.taxToken();
  if (vaultTreasury.toLowerCase() !== TREASURY.toLowerCase()) {
    throw new Error(`Vault pays ${vaultTreasury}, not the Treasury ${TREASURY}. Wrong vault.`);
  }
  if (vaultToken.toLowerCase() !== AGORA_TOKEN.toLowerCase()) {
    throw new Error(`Vault is bound to ${vaultToken}, not AGORA ${AGORA_TOKEN}. Wrong vault.`);
  }
  console.log("  ↳ vault checks out: pays this Treasury, bound to this token");

  const owner = await treasury.owner();
  const ownerIsDeployer = owner.toLowerCase() === deployer.address.toLowerCase();

  console.log("\ndeploying StakedAgora…");
  const staking = await (
    await ethers.getContractFactory("StakedAgora")
  ).deploy(AGORA_TOKEN, owner);
  await staking.waitForDeployment();
  const stakingAddr = await staking.getAddress();
  console.log(`  StakedAgora        ${stakingAddr}`);

  console.log("deploying AgoraDistributor…");
  const distributor = await (
    await ethers.getContractFactory("AgoraDistributor")
  ).deploy(stakingAddr);
  await distributor.waitForDeployment();
  const distributorAddr = await distributor.getAddress();
  console.log(`  AgoraDistributor   ${distributorAddr}   (no Suits, no owner)`);

  console.log("deploying Redeemer…");
  const redeemer = await (
    await ethers.getContractFactory("Redeemer")
  ).deploy(AGORA_TOKEN, TREASURY, owner);
  await redeemer.waitForDeployment();
  const redeemerAddr = await redeemer.getAddress();
  console.log(`  Redeemer           ${redeemerAddr}`);

  const wiring: [string, string][] = [
    ["setAgora", AGORA_TOKEN],
    ["setFeeSink", AGORA_VAULT],
    ["setDistributor", distributorAddr],
    ["setRedeemer", redeemerAddr],
  ];

  if (ownerIsDeployer) {
    console.log("\nwiring Treasury…");
    for (const [fn, arg] of wiring) {
      const tx = await (treasury as any)[fn](arg);
      await tx.wait();
      console.log(`  ${fn.padEnd(15)} ${arg}  (${tx.hash})`);
    }
  } else {
    line();
    console.log("ACTION REQUIRED — these are onlyOwner. Execute from governance:");
    for (const [fn, arg] of wiring) {
      console.log(`  to:   ${TREASURY}`);
      console.log(`  data: ${treasury.interface.encodeFunctionData(fn as any, [arg])}`);
    }
    line();
  }

  // ---- verification: read every binding back, do not trust the sends --------
  line();
  console.log("verification (read from chain)");
  line();

  const checks: [string, string, string][] = [
    ["Treasury.agora()", await treasury.agora(), AGORA_TOKEN],
    ["Treasury.feeSink()", await treasury.feeSink(), AGORA_VAULT],
    ["Treasury.distributor()", await treasury.distributor(), distributorAddr],
    ["Treasury.redeemer()", await treasury.redeemer(), redeemerAddr],
    ["Redeemer.treasury()", await redeemer.treasury(), TREASURY],
    ["Distributor.stakedAgora()", await distributor.stakedAgora(), stakingAddr],
    ["Vault.treasury()", await vault.treasury(), TREASURY],
    ["Vault.taxToken()", await vault.taxToken(), AGORA_TOKEN],
    ["Vault.vaultQuoteToken()", await vault.vaultQuoteToken(), ethers.ZeroAddress],
  ];

  let bad = 0;
  for (const [label, got, want] of checks) {
    const ok = got.toLowerCase() === want.toLowerCase();
    if (!ok) bad++;
    console.log(`  ${ok ? "OK  " : "FAIL"} ${label.padEnd(26)} ${got}`);
    if (!ok) console.log(`       expected ${want}`);
  }

  const shareBps = await treasury.incomeShareBps();
  console.log(`  ---- incomeShareBps ${shareBps}  (${Number(shareBps) / 100}% of tax to stakers)`);

  line();
  if (bad > 0) {
    console.log(`${bad} BINDING(S) WRONG — do not launch trading until these are fixed.`);
    if (!ownerIsDeployer) {
      console.log("If ownership is with governance, the calldata above still needs executing.");
    }
    process.exitCode = 1;
    return;
  }

  console.log("All bindings correct.");
  console.log("");
  console.log("Because feeSink is set, Treasury.fund() will classify the vault's");
  console.log("deposits as TAX and split them. Had this been missed, the same BNB");
  console.log("would have landed as a donation — all corpus, nothing for stakers,");
  console.log("and no revert anywhere to tell you.");
  console.log("");
  console.log("Record in .env:");
  console.log(`  STAKED_AGORA=${stakingAddr}`);
  console.log(`  DISTRIBUTOR=${distributorAddr}`);
  console.log(`  REDEEMER=${redeemerAddr}`);
  line();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
