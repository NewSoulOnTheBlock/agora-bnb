/**
 * Proves the read layer works against live chain 4663 data.
 *
 * Deliberately a STANDALONE reimplementation (not an import of src/) so the
 * poolId derivation is checked independently rather than trusted.
 *
 *   npm run verify
 */
import { JsonRpcProvider, Contract, AbiCoder, keccak256, getAddress, id as topicId, formatEther } from "ethers";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const p = new JsonRpcProvider(RPC, 4663, { staticNetwork: true });

const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const MEME_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const FEE_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";
const ZERO = "0x0000000000000000000000000000000000000000";
const TICK_SPACING = 200;
const POOL_FEE = 0;

const DEMO = process.env.DEMO_TOKEN ?? "0xeB7dBef23947F67Ae8141CeCAeD90f8aD29A235C";

const T_INIT = topicId("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const T_HOOK_FEE = topicId("HookFeeCollected(bytes32,address,uint256,uint256)");

const Q192 = 1n << 192n;
const WAD = 10n ** 18n;

let pass = 0, fail = 0;
const ok = (m, extra = "") => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${m}${extra ? "  " + extra : ""}`); };
const no = (m, extra = "") => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}${extra ? "  " + extra : ""}`); };

function poolKeyOf(token, quote = ZERO) {
  const a = getAddress(token), b = getAddress(quote);
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0: c0, currency1: c1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: getAddress(MEME_HOOK) };
}
function poolIdOf(k) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
}
function priceWad(sqrtPriceX96, k, token) {
  if (!sqrtPriceX96) return null;
  const px192 = sqrtPriceX96 * sqrtPriceX96;
  if (getAddress(token) === getAddress(k.currency0)) return (px192 * WAD) / Q192;
  return px192 === 0n ? null : (Q192 * WAD) / px192;
}

console.log("\n=== 1. connectivity ===");
const head = await p.getBlockNumber();
const net = await p.getNetwork();
Number(net.chainId) === 4663 ? ok("chainId is 4663") : no(`chainId is ${net.chainId}, expected 4663`);
head > 0 ? ok("head block", String(head)) : no("no head block");

console.log("\n=== 2. contracts have code ===");
for (const [n, a] of [["StateView", STATE_VIEW], ["PoolManager", POOL_MANAGER], ["V2MemeHook", MEME_HOOK], ["V2FeeEscrow", FEE_ESCROW]]) {
  const code = await p.getCode(a);
  code && code !== "0x" ? ok(`${n} deployed`, `${(code.length - 2) / 2} bytes`) : no(`${n} has NO CODE at ${a}`);
}

console.log("\n=== 3. getLogs span (public RPC vs Alchemy's 10-block cap) ===");
for (const span of [10, 50_000, 450_000]) {
  try {
    await p.getLogs({ address: POOL_MANAGER, topics: [T_INIT], fromBlock: head - span, toBlock: head });
    ok(`getLogs accepts ${span.toLocaleString()}-block span`);
  } catch (e) { no(`getLogs rejected ${span} span`, String(e.shortMessage ?? e.message).slice(0, 60)); }
}

console.log("\n=== 4. poolId derivation vs a live Initialize event ===");
let live = null;
try {
  const logs = await p.getLogs({ address: POOL_MANAGER, topics: [T_INIT], fromBlock: head - 200_000, toBlock: head });
  const ponsPools = logs.filter((l) => getAddress("0x" + l.data.slice(2).slice(128, 192).slice(24)) === getAddress(MEME_HOOK));
  console.log(`  ${logs.length} Initialize events, ${ponsPools.length} using V2MemeHook`);
  if (ponsPools.length) {
    const L = ponsPools[ponsPools.length - 1];
    const c0 = getAddress("0x" + L.topics[2].slice(26));
    const c1 = getAddress("0x" + L.topics[3].slice(26));
    const d = L.data.slice(2);
    const w = (i) => d.slice(i * 64, (i + 1) * 64);
    const fee = parseInt(w(0), 16);
    const tsRaw = BigInt("0x" + w(1));
    const tickSpacing = tsRaw > (1n << 255n) ? Number(tsRaw - (1n << 256n)) : Number(tsRaw);
    const hooks = getAddress("0x" + w(2).slice(24));
    const computed = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint24", "int24", "address"], [c0, c1, fee, tickSpacing, hooks]));
    computed.toLowerCase() === L.topics[1].toLowerCase()
      ? ok("poolId = keccak256(abi.encode(PoolKey))", computed.slice(0, 18) + "…")
      : no("poolId derivation MISMATCH", `${computed} vs ${L.topics[1]}`);
    fee === POOL_FEE ? ok(`Pons pool fee is ${POOL_FEE} (dynamic via hook)`) : no(`unexpected pool fee ${fee}`);
    tickSpacing === TICK_SPACING ? ok(`tickSpacing is ${TICK_SPACING}`) : no(`unexpected tickSpacing ${tickSpacing}`);
    const token = c0 === ZERO ? c1 : c0;
    live = { token, poolId: L.topics[1], key: { currency0: c0, currency1: c1, fee, tickSpacing, hooks } };
    console.log(`  live Pons pool token: ${token}`);
  } else no("found no pool using V2MemeHook in 200k blocks");
} catch (e) { no("Initialize scan failed", String(e.shortMessage ?? e.message).slice(0, 80)); }

console.log("\n=== 5. pool state read (StateView.getSlot0) ===");
const sv = new Contract(STATE_VIEW, [
  "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
  "function getLiquidity(bytes32) view returns (uint128)",
], p);

// Reconstruct from the token (what the app does), AND query the event's own
// poolId (ground truth). If the first fails but the second works, the app's
// PoolKey assumption -- not StateView -- is what's wrong.
const targets = [["configured DEMO_TOKEN (reconstructed key)", DEMO, null]];
if (live) targets.push(["discovered pool (event poolId)", live.token, live.poolId]);

let anyPriced = false;
for (const [label, token, knownPid] of targets) {
  const k = poolKeyOf(token);
  const pid = knownPid ?? poolIdOf(k);
  try {
    const [sqrtPriceX96, tick] = await sv.getSlot0(pid);
    const liq = await sv.getLiquidity(pid);
    const sp = BigInt(sqrtPriceX96);
    if (sp > 0n) {
      const price = knownPid && k.currency0 !== ZERO && k.currency1 !== ZERO ? null : priceWad(sp, k, token);
      anyPriced = true;
      ok(`${label} pool INITIALISED`, `${token}`);
      console.log(`       poolId    ${pid}`);
      console.log(price ? `       price     ${Number(formatEther(price)).toPrecision(6)} ETH per token`
                        : `       price     (token/token pair - not ETH-denominated)`);
      console.log(`       tick      ${tick}   liquidity ${liq}`);
    } else {
      console.log(`  \x1b[33mINFO\x1b[0m ${label} not initialised (still on bonding curve): ${token}`);
    }
  } catch (e) { no(`${label} getSlot0 threw`, String(e.shortMessage ?? e.message).slice(0, 70)); }
}
anyPriced ? ok("priced at least one live Pons pool end-to-end")
          : no("could not price any pool — StateView address or PoolKey may be wrong");

console.log("\n=== 6. Pons fee pipeline reads ===");
const hook = new Contract(MEME_HOOK, [
  "function pendingCreatorTax(bytes32,address) view returns (uint256)",
  "function hookFeeBps() view returns (uint256)",
  "function protocolFeeShareBps() view returns (uint256)",
  "function feeSweepOperator() view returns (address)",
  "function poolManager() view returns (address)",
], p);
try {
  const pm = await hook.poolManager();
  getAddress(pm) === getAddress(POOL_MANAGER)
    ? ok("hook.poolManager() matches our PoolManager")
    : no("hook points at a DIFFERENT PoolManager", pm);
  ok("hookFeeBps", String(await hook.hookFeeBps()));
  ok("protocolFeeShareBps", String(await hook.protocolFeeShareBps()));
  ok("feeSweepOperator", await hook.feeSweepOperator());
  const pid = live ? live.poolId : poolIdOf(poolKeyOf(DEMO));
  ok("pendingCreatorTax(poolId, ETH)", formatEther(await hook.pendingCreatorTax(pid, ZERO)) + " ETH");
} catch (e) { no("hook reads failed", String(e.shortMessage ?? e.message).slice(0, 80)); }

try {
  const esc = new Contract(FEE_ESCROW, ["function balanceOf(address) view returns (uint256)"], p);
  ok("escrow.balanceOf(zero) callable", formatEther(await esc.balanceOf(ZERO)) + " ETH");
} catch (e) { no("escrow read failed", String(e.shortMessage ?? e.message).slice(0, 70)); }

console.log("\n=== 7. tax history scan (HookFeeCollected) ===");
try {
  const pid = live ? live.poolId : poolIdOf(poolKeyOf(DEMO));
  const logs = await p.getLogs({ address: MEME_HOOK, topics: [T_HOOK_FEE, pid], fromBlock: head - 450_000, toBlock: head });
  // MUST filter by currency: the hook emits for BOTH legs (native ETH and the
  // memecoin). Summing across them adds ether to token units.
  const byCur = new Map();
  for (const l of logs) {
    const d = l.data.slice(2);
    const cur = getAddress("0x" + d.slice(24, 64));
    const tax = BigInt("0x" + d.slice(128, 192));
    const e = byCur.get(cur) ?? { n: 0, sum: 0n };
    e.n++; e.sum += tax; byCur.set(cur, e);
  }
  const eth = byCur.get(getAddress(ZERO)) ?? { n: 0, sum: 0n };
  ok(`HookFeeCollected scan`, `${logs.length} events across ${byCur.size} currencies`);
  ok(`native-ETH tax leg`, `${eth.n} events, ${formatEther(eth.sum)} ETH`);
  for (const [c, e] of byCur) {
    if (c === getAddress(ZERO)) continue;
    console.log(`       token leg ${c}  ${e.n} events  ${formatEther(e.sum)} (token units)`);
  }
  if (!logs.length) console.log("       (0 is plausible for a quiet pool — the scan itself succeeded)");
} catch (e) { no("tax history scan failed", String(e.shortMessage ?? e.message).slice(0, 80)); }

// ---------------------------------------------------------------------------
// 8. TORII bonding curve — the live trading venue until graduation
// ---------------------------------------------------------------------------
console.log("\n=== 8. TORII curve (live trade path) ===");
{
  // Defaulted to the live v2 relaunch on Robinhood Chain (chain 4663).
  //
  // These were previously left empty on purpose: defaulting to the **v1**
  // addresses would have reported a dead launch as a healthy trade path, since
  // that token's creator-fee recipient was misdirected to a contract incapable
  // of sweeping and the change was irreversible. v2 fixed it by ordering, so
  // defaulting is now correct — but the original hazard has not gone away, so
  // the dead v1 token is refused outright below rather than merely undefaulted.
  //
  // NOTE these stay AGORA-era addresses after the TORII rename: they are the
  // live chain-4663 deployment, which is not rebranded and not redeployed. The
  // TORII launch is a separate BNB deployment with its own addresses.
  const V1_DEAD_TOKEN = "0x6853618673D952Fe602616F6f896cC7be8e25fCc";
  const CURVE = process.env.TORII_CURVE ?? "0x05CDABCA3e464e00a91B81021dc881e2e8238fEE";
  const TORII_T = process.env.TORII_TOKEN ?? "0x286b4b456Bd10FD1745A7b7B33f25a804DDf5F04";

  if (TORII_T.toLowerCase() === V1_DEAD_TOKEN.toLowerCase()) {
    no("token is the dead v1 launch — its fee stream is unrecoverable");
    console.log("        v1 must never be wired back in. Use the v2 token.");
  }
  const RICH = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
  const abi = [
    "function buy(uint256,uint256,address) payable returns (uint256)",
    "function creatorTaxBps() view returns (uint256)",
    "function feeBps() view returns (uint256)",
    "function graduated() view returns (bool)",
    "function realQuoteReserve() view returns (uint256)",
    "function graduationThreshold() view returns (uint256)",
    "function creatorTaxBalance() view returns (uint256)",
    "function token() view returns (address)",
    "function isNativeQuote() view returns (bool)",
  ];
  if (!CURVE || !TORII_T) {
    console.log("  \x1b[33mSKIP\x1b[0m  relaunch pending — set TORII_CURVE and TORII_TOKEN to run");
    console.log("        e.g. TORII_TOKEN=0x… TORII_CURVE=0x… npm run verify");
  } else {
  const c = new Contract(CURVE, abi, p);
  try {
    getAddress(await c.token()) === getAddress(TORII_T)
      ? ok("curve.token() == TORII")
      : no("curve points at a different token");
    const tax = await c.creatorTaxBps();
    Number(tax) === 400 ? ok("creatorTaxBps == 400 (4%, as designed)") : no(`creatorTaxBps is ${tax}, design assumes 400`);
    ok("feeBps", String(await c.feeBps()));
    ok("isNativeQuote", String(await c.isNativeQuote()));
    const rq = await c.realQuoteReserve(), gt = await c.graduationThreshold();
    ok("graduation", `${formatEther(rq)} / ${formatEther(gt)} ETH = ${(Number(rq * 10000n / gt) / 100).toFixed(3)}%`);
    ok("graduated", String(await c.graduated()));
    ok("creatorTaxBalance", `${formatEther(await c.creatorTaxBalance())} ETH already accrued`);
    // buy(quoteIn, minOut, to) — parameter order pinned by simulation.
    //
    // Only meaningful BEFORE graduation. Once the token graduates the curve is
    // closed and buy() reverts by design, so simulating it reports a healthy,
    // expected state as a failure. Trading then routes through the v4 pool,
    // which sections 4 and 5 already price end to end.
    if (await c.graduated()) {
      ok("buy simulation skipped", "curve closed — graduated, trades route via v4");
    } else {
      const amt = 10n ** 15n;
      const out = await c.buy.staticCall(amt, 0n, RICH, { value: amt, from: RICH });
      BigInt(out) > 0n
        ? ok("buy(quoteIn,minOut,to) simulates", `0.001 ETH -> ${formatEther(out)} TORII`)
        : no("buy simulation returned 0");
    }
  } catch (e) {
    no("curve checks failed", String(e.shortMessage ?? e.message).slice(0, 90));
  }
  }
}

// ---------------------------------------------------------------------------
// 9. Suits NFT — live and independent of the relaunch
// ---------------------------------------------------------------------------
console.log("\n=== 9. Suits collection (staking target) ===");
{
  const SUITS = "0x3ac7beb099c560f5a09bd822621327d8768f0625";
  const c = new Contract(SUITS, [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function totalSupply() view returns (uint256)",
    "function maxSupply() view returns (uint256)",
    "function supportsInterface(bytes4) view returns (bool)",
    "function getTransferValidator() view returns (address)",
    "function ownerOf(uint256) view returns (address)",
  ], p);
  try {
    const [name, supply, max] = await Promise.all([c.name(), c.totalSupply(), c.maxSupply()]);
    name === "Suits" ? ok("name", name) : no(`name is ${name}, expected Suits`);
    supply === max
      ? ok("fully minted", `${supply} / ${max}`)
      : no(`not fully minted: ${supply} / ${max}`);

    (await c.supportsInterface("0x80ac58cd"))
      ? ok("is ERC-721")
      : no("does not report ERC-721 support");

    // The UI depends on this being FALSE — it is why token IDs are typed in.
    (await c.supportsInterface("0x780e9d63"))
      ? no("reports Enumerable — the UI assumes it is not")
      : ok("NOT Enumerable", "confirms IDs must be entered by hand");

    const v = await c.getTransferValidator();
    if (v === "0x0000000000000000000000000000000000000000") {
      ok("no transfer validator", "staking transfers unrestricted");
    } else {
      ok("transfer validator present", `${v.slice(0, 12)}… — policy can change`);
    }
    ok("ownerOf(1) reachable", (await c.ownerOf(1)).slice(0, 12) + "…");
  } catch (e) {
    no("suits checks failed", String(e.shortMessage ?? e.message).slice(0, 90));
  }
}


console.log(`\n${"=".repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`${"=".repeat(60)}\n`);
process.exit(fail > 0 ? 1 : 0);
