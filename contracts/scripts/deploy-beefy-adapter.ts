/**
 * Deploy a `BeefyCLMAdapter` and print the governance sequence that activates it.
 *
 *   CLM=0x… REWARD_POOL=0x… npx hardhat run scripts/deploy-beefy-adapter.ts --network robinhood
 *
 * Deploying the adapter is harmless on its own — it holds nothing and the
 * Treasury does not know about it. Three separate owner actions, one of them
 * behind a 2-day timelock, stand between this script and any corpus ETH moving.
 * That ordering is deliberate: adding an adapter is the single most dangerous
 * action available to governance, because an adapter can hold the corpus.
 *
 * Rehearse against a fork before running this for real:
 *   npx hardhat node --fork $RH_RPC_URL --port 8546
 *   npx hardhat run scripts/rehearse-beefy.ts --network forked
 */
import { ethers, network } from "hardhat";

const WETH = process.env.WETH ?? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const line = () => console.log("─".repeat(72));

async function main() {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY in .env.");

  const TREASURY = process.env.TREASURY?.trim();
  const CLM = process.env.CLM?.trim();
  const REWARD_POOL = process.env.REWARD_POOL?.trim() ?? ethers.ZeroAddress;

  if (!TREASURY) throw new Error("TREASURY not set in .env");
  if (!CLM) throw new Error("CLM not set — the Beefy cowcentrated vault address");

  const net = await ethers.provider.getNetwork();

  line();
  console.log("BeefyCLMAdapter — deploy");
  line();
  console.log(`network      ${network.name} (chainId ${net.chainId})`);
  console.log(`deployer     ${signer.address}`);
  console.log(`treasury     ${TREASURY}`);
  console.log(`clm          ${CLM}`);
  console.log(`rewardPool   ${REWARD_POOL}`);
  console.log(`weth         ${WETH}`);

  // ------------------------------------------------------------- preflight
  line();
  console.log("PREFLIGHT");
  line();

  const clm = new ethers.Contract(
    CLM,
    [
      "function wants() view returns (address,address)",
      "function totalSupply() view returns (uint256)",
      "function balances() view returns (uint256,uint256)",
      "function isCalm() view returns (bool)",
      "function symbol() view returns (string)",
    ],
    ethers.provider
  );

  const symbol = await clm.symbol();
  const [t0, t1] = await clm.wants();
  console.log(`vault        ${symbol}`);
  console.log(`token0       ${t0}`);
  console.log(`token1       ${t1}`);

  const wethLower = WETH.toLowerCase();
  if (t0.toLowerCase() !== wethLower && t1.toLowerCase() !== wethLower) {
    line();
    console.log("✗ ABORT — neither side of this vault is WETH.");
    console.log("  This adapter converts ETH into the pair through a single pool.");
    console.log("  A vault with no WETH leg (the USDG/stock pairs, for example)");
    console.log("  needs a two-hop route and is out of scope for this contract.");
    throw new Error("vault is not WETH-paired");
  }

  const [b0, b1] = await clm.balances();
  console.log(`balances     ${b0} / ${b1}`);
  console.log(`isCalm       ${await clm.isCalm()}`);

  if (REWARD_POOL !== ethers.ZeroAddress) {
    const rp = new ethers.Contract(
      REWARD_POOL,
      ["function stakedToken() view returns (address)"],
      ethers.provider
    );
    const staked = await rp.stakedToken();
    if (staked.toLowerCase() !== CLM.toLowerCase()) {
      throw new Error(`reward pool stakes ${staked}, not the CLM`);
    }
    console.log(`rewardPool   stakes the CLM ✓`);
  }

  const treasury = new ethers.Contract(
    TREASURY,
    [
      "function owner() view returns (address)",
      "function nav() view returns (uint256)",
      "function sleeveBps() view returns (uint16)",
    ],
    ethers.provider
  );
  const owner = await treasury.owner();
  const nav = await treasury.nav();
  console.log(`nav          ${ethers.formatEther(nav)} ETH`);
  console.log(`sleeveBps    ${await treasury.sleeveBps()}`);
  console.log(`owner        ${owner}`);

  // ---------------------------------------------------------------- deploy
  line();
  console.log("DEPLOY");
  line();

  const Adapter = await ethers.getContractFactory("BeefyCLMAdapter");
  const adapter = await Adapter.deploy(TREASURY, CLM, REWARD_POOL, WETH, owner);
  await adapter.waitForDeployment();
  const addr = await adapter.getAddress();

  console.log(`adapter      ${addr}`);
  console.log(`  pool       ${await adapter.pool()}`);
  console.log(`  paired     ${await adapter.paired()}`);
  console.log(`  wethIsT0   ${await adapter.wethIsToken0()}`);

  const [spot, twap, inBand] = await adapter.ticks();
  console.log(`  spot/twap  ${spot} / ${twap}  inBand=${inBand}`);

  // -------------------------------------------------------------- next steps
  line();
  console.log("NEXT — three owner actions, and a 2-day wait in the middle");
  line();
  console.log(`  1. Treasury.queueAdapter(${addr})`);
  console.log(`  2. wait 2 days (ADAPTER_TIMELOCK), then`);
  console.log(`     Treasury.activateAdapter(${addr})`);
  console.log(`  3. Treasury.setSleeveBps(<bps>)      // 0 today, so no deposit is possible`);
  console.log(`  4. Treasury.depositToAdapter(${addr}, <wei>)`);
  console.log("");
  console.log("Calldata, if the owner is a multisig:");
  const t = new ethers.Interface([
    "function queueAdapter(address)",
    "function activateAdapter(address)",
    "function setSleeveBps(uint16)",
    "function depositToAdapter(address,uint256)",
  ]);
  console.log(`  queueAdapter     ${t.encodeFunctionData("queueAdapter", [addr])}`);
  console.log(`  activateAdapter  ${t.encodeFunctionData("activateAdapter", [addr])}`);
  line();
  console.log("Start small. The first deposit should be a size you are willing to");
  console.log("lose to a mistake, and `FeeSink.collect()` keeps printing meanwhile.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
