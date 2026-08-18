/**
 * Queue a yield adapter on the live Treasury, starting the 2-day timelock.
 *
 *   ADAPTER=0x… npx hardhat run scripts/queue-adapter.ts --network robinhood
 *
 * Queuing moves no funds and is reversible with `cancelQueuedAdapter`. It only
 * starts a clock — `activateAdapter` cannot succeed until ADAPTER_TIMELOCK has
 * elapsed, and even then `sleeveBps` must be raised above 0 before any corpus
 * ETH can be deposited. Three further owner actions stand between this and a
 * single wei moving.
 */
import { ethers } from "hardhat";
const line = () => console.log("─".repeat(70));

async function main() {
  const adapter = process.env.ADAPTER?.trim();
  if (!adapter) throw new Error("Set ADAPTER=0x…");
  const [signer] = await ethers.getSigners();
  const t = await ethers.getContractAt("Treasury", process.env.TREASURY!, signer);

  const owner = await t.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log("Not the owner. From governance:");
    console.log(`  to:   ${process.env.TREASURY}`);
    console.log(`  data: ${t.interface.encodeFunctionData("queueAdapter", [adapter])}`);
    return;
  }

  // Sanity: it must actually look like an adapter before we start its clock.
  const a = new ethers.Contract(adapter, [
    "function treasury() view returns (address)",
    "function totalAssets() view returns (uint256)",
    "function principal() view returns (uint256)",
  ], ethers.provider);

  line();
  console.log("QUEUE ADAPTER");
  line();
  console.log(`  treasury    ${await t.getAddress()}`);
  console.log(`  adapter     ${adapter}`);
  console.log(`  its treasury ${await a.treasury()}`);
  if ((await a.treasury()).toLowerCase() !== (await t.getAddress()).toLowerCase())
    throw new Error("adapter points at a DIFFERENT treasury — refusing");
  console.log(`  totalAssets ${ethers.formatEther(await a.totalAssets())} ETH`);
  console.log(`  principal   ${ethers.formatEther(await a.principal())} ETH`);
  console.log(`  sleeveBps   ${await t.sleeveBps()}  ← still 0, so no deposit is possible`);

  const already = await t.isAdapter(adapter);
  if (already) { console.log("\nAlready active."); return; }

  console.log("\nsimulating…");
  await t.queueAdapter.staticCall(adapter);
  const tx = await t.queueAdapter(adapter);
  console.log(`sending… ${tx.hash}`);
  await tx.wait();

  const queuedAt = await t.adapterQueuedAt(adapter);
  const timelock = await t.ADAPTER_TIMELOCK();
  const executable = Number(queuedAt) + Number(timelock);
  line();
  console.log(`queued at   ${new Date(Number(queuedAt) * 1000).toISOString()}`);
  console.log(`executable  ${new Date(executable * 1000).toISOString()}`);
  console.log(`             (${(Number(timelock) / 86400).toFixed(0)} days)`);
  console.log("\nCancel any time before then with cancelQueuedAdapter.");
  line();
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
