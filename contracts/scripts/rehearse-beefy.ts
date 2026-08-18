/**
 * Full-lifecycle rehearsal of `BeefyCLMAdapter` against a **fork of chain
 * 4663**, using the real Beefy CLM vault, the real reward pool, the real
 * Uniswap v3 pool and the real WETH.
 *
 *   npx hardhat node --fork https://rpc.mainnet.chain.robinhood.com --port 8546
 *   npx hardhat run scripts/rehearse-beefy.ts --network forked
 *
 * Mocks cannot answer the questions that decide whether this is safe to
 * deploy: does Beefy's `isCalm()` gate actually pass, does the in-ratio split
 * mint the shares it should, how much does the pool's own 1% fee eat on the way
 * in and out, and does a full unwind really return the ETH. Only live state
 * answers those, so this runs against live state.
 *
 * It sends no real transactions — the fork is local and disposable.
 *
 * Override the venue with CLM / REWARD_POOL / WETH env vars to rehearse a
 * different vault (e.g. the weth-usdg one) before pointing the Treasury at it.
 */
import { ethers, network } from "hardhat";

// Beefy "Cow Uniswap Robinhood STONKBROKER-WETH", verified on chain 4663.
const CLM = process.env.CLM ?? "0x9CcCE25f82f37ef777552E3BBB2A01BC5574AbE8";
const REWARD_POOL = process.env.REWARD_POOL ?? "0xDAceb29D88ee1b5eFE8ac134523dC93A35548703";
const WETH = process.env.WETH ?? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const DEPOSIT = ethers.parseEther(process.env.DEPOSIT ?? "0.05");

const line = () => console.log("─".repeat(72));
const eth = (v: bigint) => `${ethers.formatEther(v)} ETH`;

async function main() {
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  line();
  console.log("BeefyCLMAdapter — forked rehearsal");
  line();
  console.log(`network      ${network.name} (chainId ${net.chainId})`);
  console.log(`block        ${await ethers.provider.getBlockNumber()}`);
  console.log(`signer       ${signer.address}`);
  console.log(`clm          ${CLM}`);
  console.log(`rewardPool   ${REWARD_POOL}`);
  console.log(`deposit      ${eth(DEPOSIT)}`);

  // ---------------------------------------------------------------- deploy
  line();
  console.log("1 · deploy Treasury + adapter");
  line();

  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(signer.address);
  await treasury.waitForDeployment();
  console.log(`treasury     ${await treasury.getAddress()}`);

  const Adapter = await ethers.getContractFactory("BeefyCLMAdapter");
  const adapter = await Adapter.deploy(
    await treasury.getAddress(),
    CLM,
    REWARD_POOL,
    WETH,
    signer.address
  );
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  console.log(`adapter      ${adapterAddr}`);
  console.log(`  pool       ${await adapter.pool()}`);
  console.log(`  paired     ${await adapter.paired()}`);
  console.log(`  wethIsT0   ${await adapter.wethIsToken0()}`);

  const [spotTick, twapTick, inBand] = await adapter.ticks();
  console.log(`  spot tick  ${spotTick}`);
  console.log(`  twap tick  ${twapTick}   inBand=${inBand}`);

  // ------------------------------------------------------------ fund + wire
  line();
  console.log("2 · fund the corpus and activate the sleeve");
  line();

  await (await treasury.fund({ value: ethers.parseEther("1") })).wait();
  console.log(`nav          ${eth(await treasury.nav())}`);

  await (await treasury.setSleeveBps(5000)).wait();
  await (await treasury.queueAdapter(adapterAddr)).wait();
  console.log("queued; advancing past the 2-day timelock…");
  await network.provider.send("evm_increaseTime", [2 * 24 * 3600 + 60]);
  await network.provider.send("evm_mine", []);
  await (await treasury.activateAdapter(adapterAddr)).wait();
  console.log(`adapters     ${await treasury.adapters()}`);

  // ---------------------------------------------------------------- deposit
  line();
  console.log("3 · deposit into Beefy");
  line();

  const navBefore = await treasury.nav();
  const floorBefore = await treasury.floorPerToken();

  await (await treasury.depositToAdapter(adapterAddr, DEPOSIT)).wait();

  const assets = await adapter.totalAssets();
  const principal = await adapter.principal();
  console.log(`principal    ${eth(principal)}`);
  console.log(`totalAssets  ${eth(assets)}`);
  console.log(`slippage     ${eth(principal - assets)}  (pool fee + swap impact)`);
  console.log(`shares       ${await adapter.sharesHeld()}`);
  console.log(`vault share  ${await adapter.vaultShareBps()} bps  (cap ${await adapter.maxVaultShareBps()})`);
  console.log(`healthy      ${await adapter.healthy()}`);
  console.log(`nav          ${eth(navBefore)} → ${eth(await treasury.nav())}`);
  console.log(`floor        ${floorBefore} → ${await treasury.floorPerToken()}`);
  console.log(`sleeveCorpus ${eth(await treasury.sleeveCorpus())}   (min(assets, principal))`);

  if ((await adapter.sharesHeld()) === 0n) throw new Error("no shares minted");

  // -------------------------------------------------------- partial unwind
  line();
  console.log("4 · partial withdrawal back to the Treasury");
  line();

  const half = assets / 2n;
  const balBefore = await ethers.provider.getBalance(await treasury.getAddress());
  await (await treasury.withdrawFromAdapter(adapterAddr, half)).wait();
  const balAfter = await ethers.provider.getBalance(await treasury.getAddress());

  console.log(`requested    ${eth(half)}`);
  console.log(`received     ${eth(balAfter - balBefore)}`);
  console.log(`principal    ${eth(await adapter.principal())}`);
  console.log(`totalAssets  ${eth(await adapter.totalAssets())}`);

  if (balAfter <= balBefore) throw new Error("partial withdrawal returned nothing");

  // ------------------------------------------------------------ full unwind
  line();
  console.log("5 · full exit, then remove the adapter");
  line();

  const bal2 = await ethers.provider.getBalance(await treasury.getAddress());
  await (await treasury.withdrawFromAdapter(adapterAddr, ethers.MaxUint256)).wait();
  const bal3 = await ethers.provider.getBalance(await treasury.getAddress());

  console.log(`received     ${eth(bal3 - bal2)}`);
  console.log(`shares left  ${await adapter.sharesHeld()}`);
  console.log(`totalAssets  ${eth(await adapter.totalAssets())}`);
  console.log(`principal    ${eth(await adapter.principal())}`);

  // `removeAdapter` refuses while the adapter still reports assets, so this
  // doubles as an assertion that the exit was genuinely complete.
  await (await treasury.removeAdapter(adapterAddr)).wait();
  console.log(`adapters     ${await treasury.adapters()}  ← removable, so the exit was clean`);

  const roundTrip = bal3 - balBefore;
  line();
  console.log("round trip");
  line();
  console.log(`deployed     ${eth(DEPOSIT)}`);
  console.log(`recovered    ${eth(roundTrip)}`);
  const poolFee = await new ethers.Contract(
    await adapter.pool(),
    ["function fee() view returns (uint24)"],
    ethers.provider
  ).fee();
  const lossBps = ((DEPOSIT - roundTrip) * 10_000n) / DEPOSIT;
  console.log(
    `cost         ${lossBps} bps  (two swaps through a ${Number(poolFee) / 10_000}% pool + CLM fees)`
  );
  line();
  console.log("PASS");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
