import { JsonRpcProvider } from "ethers";

// ---------------------------------------------------------------------------
// Robinhood Chain (EVM, Arbitrum Orbit L2)
// ---------------------------------------------------------------------------
export const CHAIN_ID = 4663;
export const CHAIN_ID_HEX = "0x1237";

// The PUBLIC endpoint is deliberately preferred over the Alchemy key used by
// memebrokers-evm, for two reasons:
//   1. No key ends up in the shipped bundle (the Memebrokers key leaked that way).
//   2. Alchemy's free tier caps eth_getLogs at a 10-BLOCK range, which makes
//      history scanning impossible. The public RPC accepts ~500k-block ranges.
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

// Largest eth_getLogs span the public RPC will accept. 1_000_000 fails.
export const MAX_LOG_SPAN = 450_000;

export const EXPLORER = "https://robinhoodchain.blockscout.com";

export const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER],
};

export const readProvider = new JsonRpcProvider(RPC_URL, CHAIN_ID, {
  staticNetwork: true,
});

export const ZERO = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Uniswap v4 — verified on chain 4663, 2026-08-17.
// See docs/tithe-endowment-token-design.md §14 for how each was disambiguated.
// This chain hosts 34 contracts named "PoolManager" and 36 named
// "UniversalRouter"; do NOT resolve these by name search.
// ---------------------------------------------------------------------------
export const V4 = {
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",

  // RESOLVED 2026-08-17. All 12 candidates static-called quoteExactInputSingle
  // against a live Pons pool and returned BYTE-IDENTICAL amountOut, so they are
  // equivalent deployments and any one works. The quote came in 207 bps under
  // spot, confirming the quoter executes the hook and includes its dynamic fee.
  //
  // NEVER call this inside a transaction: quoteExactInputSingle is non-view by
  // declaration (it reverts internally and catches), so it must go through
  // eth_call / staticCall only.
  quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
} as const;

// ---------------------------------------------------------------------------
// Pons v2
// ---------------------------------------------------------------------------
export const PONS = {
  launchFactory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  memeHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044", // PoolKey.hooks
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  feeSweepOperator: "0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2", // Pons-controlled
  locker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",

  // Verified launch-config constants.
  poolFee: 0, // no static LP fee — the hook applies fees dynamically
  tickSpacing: 200,
  graduationThresholdWei: 4_200_000_000_000_000_000n, // 4.2 ETH
  maxCreatorTaxBps: 1000, // 10% cap; TITHE uses 400
  hookFeeBps: 100, // 1% pool fee
  creatorFeeShareBps: 7000, // creator's share of the pool fee
  snipeTaxStartBps: 9900, // 99% for the first 3 seconds after launch
  snipeTaxSeconds: 3,
} as const;

// VERIFIED on the live curve 2026-08-17: creatorTaxBps() == 400. Not an assumption.
export const AGORA_TAX_BPS = 400; // 4%
export const CURVE_FEE_BPS = 100; // 1% — curve feeBps()

// ---------------------------------------------------------------------------
// AGORA. The token and its bonding curve are LIVE. The reserve contracts are not
// written yet, so they stay at the zero address and every read against them
// resolves to `null` — the UI renders an honest "not deployed" instead of zeros.
// ---------------------------------------------------------------------------
/**
 * ---------------------------------------------------------------------------
 * v2 — LIVE on chain 4663. Verified 2026-08-17, 18/18 checks.
 * ---------------------------------------------------------------------------
 *
 * The v1 token (`0x6853618673D952Fe602616F6f896cC7be8e25fCc`) is **dead and must
 * never be wired back in.** `transferCreatorFeeRecipient` was pointed at the
 * Treasury rather than the FeeSink; because that call reassigns the curve's
 * `deployer` — the only address permitted to call `sweepFees` — the fee stream
 * became collectable only by a contract structurally incapable of collecting it,
 * and the change was not reversible.
 *
 * v2 fixed it by ORDERING: contracts deployed first, then the token launched
 * with `params.creatorFeeRecipient` already set to the FeeSink, so no
 * post-launch transfer step ever existed to get wrong.
 *
 * Confirmed on chain rather than assumed:
 *   curve.deployer()          == feeSink   (the check v1 failed)
 *   sweepFees from feeSink    ALLOWED
 *   sweepFees from the EOA    BLOCKED      (rights genuinely moved)
 *   FeeSink.owner()           == 0x0       (renounced by setCurve)
 *   Treasury.agora/redeemer/distributor all bound
 */
export const AGORA: {
  token: string; curve: string; deployer: string;
  feeSink: string; treasury: string; stakedAgora: string; redeemer: string;
  stakedSuits: string; distributor: string;
} = {
  token: "0x286b4b456Bd10FD1745A7b7B33f25a804DDf5F04",
  curve: "0x05CDABCA3e464e00a91B81021dc881e2e8238fEE",
  deployer: "0x2Fb89C8ce53E0527BC29e0861c4bEE1331d39d19",

  feeSink: "0xb8Bc3E208cAA463b96c0A62c23E88905a7CEbB7E",
  treasury: "0x7A3B8322dd85C6e9F24D3A0a8D66514ad0E26C5c",

  stakedAgora: "0x92dEbC6a1A8afE872EEb6aBac05DC3Fb1347D463",
  redeemer: "0x6315505083eBB08ABf26CC70123D2af6D49184C0",
  stakedSuits: "0xE76Cb0cc3EcA2959a8384A5a0Fe00A3EA0E5e1A3",
  distributor: "0xf422916f139CB003B0FDC36edC73a816D17B914b",
};

/**
 * The Suits ERC-721 — LIVE and independent of the relaunch.
 * SeaDrop clone, fully minted 1111/1111, chain 4663.
 *
 * Note it is NOT ERC721Enumerable, so the UI cannot list a wallet's token IDs
 * from the chain alone; holders enter IDs manually and the app verifies
 * ownership before offering to stake them.
 *
 * A Limit Break transfer validator is active at
 * `0xA000027A9B2802E1ddf7000061001e5c005A0000`. Its current policy permits
 * transfers into a contract, which is what staking needs, but the collection
 * owner can tighten it at any time.
 */
export const SUITS_NFT = "0x3ac7beb099c560f5a09bd822621327d8768f0625";
export const SUITS_SUPPLY = 1111;
export const SUITS_VALIDATOR = "0xA000027A9B2802E1ddf7000061001e5c005A0000";
/** Secondary market. Where a would-be staker goes to acquire a Suit. */
export const SUITS_MARKET = "https://opensea.io/collection/suitsonchain";

/**
 * Suits staking is DISABLED because it cannot currently work.
 *
 * The collection sits at Limit Break transfer-security **level 3** —
 * "allowlisted operators only". `StakedSuits.stake()` calls
 * `suits.transferFrom(owner, vault, id)` with the *vault* as `msg.sender`,
 * which makes the vault an operator, and it is not on the allowlist:
 *
 *   isOperatorWhitelisted(list 0, 0xE76Cb0cc…e1A3) → false
 *
 * Verified by control tests: an owner-initiated transfer INTO the vault
 * succeeds and a transfer to an EOA succeeds, but a vault-as-operator transfer
 * reverts. So it is the operator policy, not the destination and not a missing
 * approval — no amount of approving fixes it.
 *
 * The vault contract is fine and needs no redeploy. Flip this to `true` the
 * moment the Suits owner (0x53977e37…f6ED) allowlists the vault or drops the
 * collection to security level 1 or 0.
 *
 * Until then the Distributor reroutes the Suits share to stAGORA, which is the
 * designed fallback and is working correctly.
 */
export const SUITS_STAKING_ENABLED = false;

/** Share of yield routed to staked Suits. Mirrors Distributor.suitsBps default. */
export const SUITS_SHARE_BPS = 1000;

// A REAL, already-GRADUATED, ETH-paired Pons v2 pool, used only to prove the
// read layer works against live chain data before TITHE exists. Override with
// VITE_DEMO_TOKEN. Setting TITHE.token above takes precedence over this.
//
// Verified: currency0 = ETH, currency1 = this token, hooks = V2MemeHook, and
// StateView.getSlot0 returns a live non-zero sqrtPriceX96. Most Pons tokens are
// still on the bonding curve and would read as uninitialised.
export const DEMO_TOKEN =
  (import.meta.env?.VITE_DEMO_TOKEN as string | undefined) ??
  "0xeB7dBef23947F67Ae8141CeCAeD90f8aD29A235C";

/** The token the UI reads. AGORA is live, so demo mode is off. */
export function activeToken(): { address: string; isDemo: boolean } {
  if (AGORA.token !== ZERO) return { address: AGORA.token, isDemo: false };
  return { address: DEMO_TOKEN, isDemo: true };
}

/**
 * ETH/USD price feed. Intentionally unset: no Chainlink ETH/USD aggregator on
 * chain 4663 has been verified, and inventing an address would silently produce
 * wrong dollar figures on a page whose entire job is to be verifiable.
 * Until this is filled in, the UI shows ETH-denominated values only.
 */
export const ETH_USD_FEED: string | null = null;

/**
 * Graduation, and a trap worth recording.
 *
 * The Pons PoolKey — `fee = 0`, `hooks = V2MemeHook`, `tickSpacing = 200` — is
 * the correct key both before and after graduation, and `poolkey.ts` derives it
 * unchanged. There is no override here, and there should not be one.
 *
 * The trap: between the curve graduating and the locked LP actually being
 * seeded, `StateView.getSlot0` on that derived id returns **zero**. Reading a
 * zero there and concluding the derivation was wrong is a mistake — it happened
 * during this build, and led to a hunt through `Initialize` events that turned
 * up `0x716f4492…`, a pool with the same currencies but a different fee, no
 * hook, and **zero liquidity**. It was a decoy. The real pool is the derived
 * one, and it started answering as soon as the LP landed.
 *
 * If the price ever reads zero again after graduation, wait for the LP rather
 * than changing the key.
 */

/** GMGN's page for the token — the chart people actually look at. */
export const GMGN_URL =
  "https://gmgn.ai/robinhood/token/0x286b4b456bd10fd1745a7b7b33f25a804ddf5f04";


// ---------------------------------------------------------------------------
// Beefy — where withdrawn corpus ETH actually goes
// ---------------------------------------------------------------------------
/**
 * `Treasury.withdraw()` sends corpus ETH to the operator wallet, which then
 * deploys it on beefy.com. Until the on-chain adapter is activated that is the
 * only route available, and it means the deployed ETH sits outside `nav()`.
 *
 * The dashboard used to report that as a bare "withdrawn" total and nothing
 * else, which read as though money had gone missing. It has not — it is in
 * these vaults, and every one of them is readable from the chain.
 *
 * **The whole registry is here, not just the vaults in use.** A three-entry
 * list went stale within a day: the operator moved into
 * `up33-cow-robinhood-up-stonkbroker-rp`, which was not on it, and the position
 * silently read as zero. There is no way to enumerate an address's ERC-20
 * holdings on-chain, so the alternatives were to hard-code a guess or to call
 * Beefy's API at runtime. Neither is acceptable on a page whose point is that
 * every number is verifiable against the RPC alone — so the full list is baked
 * in and all of it is scanned. It is one cheap `balanceOf` per vault, batched.
 *
 * Snapshot of Beefy's registry for chain 4663, 2026-08-18. Re-run
 * `api.beefy.finance/gov-vaults` and add rows if Beefy launches more.
 *
 * Tuple order: [id, label, CLM vault, reward pool].
 */
export const BEEFY_VAULTS: [string, string, string, string][] = [
  ["uniswap-cow-robinhood-aapl-usdg-rp", "AAPL-USDG", "0x0B7dF93Bb66E13923a2153217B4a29Ec7CC3Efc1", "0x68a2E1Cf0007d28728774619d1aC89f66FA99894"],
  ["uniswap-cow-robinhood-cashcat-usdg-rp", "CASHCAT-USDG", "0x104E6823bAB0be3fe9b48c5fB0F0413301d935a4", "0x8f6E62ac78B06F4f45DB8dE37C8A8B6e1F3e3a13"],
  ["uniswap-cow-robinhood-cashcat-weth-rp", "CASHCAT-WETH", "0x0BF46176b181D8bB5bbF57C5d200c79daF416221", "0xA79fF9Ca6250A0ddEbc051dD898A4a892Caa4859"],
  ["uniswap-cow-robinhood-frong-weth-rp", "FRONG-WETH", "0xd5319D37F56C70F10da99BFB3A38694D5BD1fF22", "0x5bc50ABa09C285529C14290179AC345D0baA033e"],
  ["uniswap-cow-robinhood-gme-usdg-10000-rp", "GME-USDG", "0x3AB58808c6feC9CC0Ec56A04800e306C08fFB5e0", "0x28a7d169942bb50F51A2E53262Ca736980FE183f"],
  ["uniswap-cow-robinhood-gme-usdg-rp", "GME-USDG", "0x4f95D85389de296869A5a815A1AA05ec32F7efb5", "0x0365ce42fbe05C07Cb835c06d3B68dD871E94Ae4"],
  ["uniswap-cow-robinhood-msft-usdg-rp", "MSFT-USDG", "0xE36274737D99273d353d8d9F0a51c1AeA7426C31", "0xd9993b44E8d014F4ad979cb7706673386cd31520"],
  ["uniswap-cow-robinhood-rddt-usdg-rp", "RDDT-USDG", "0x3Ca0b5eb3133982A982B72BfAD4dA71a6A6433Ef", "0x9eA8596752349525786e44d909432663B0680e7D"],
  ["uniswap-cow-robinhood-spcx-usdg-rp", "SPCX-USDG", "0xc32834aC40a6529b2f7Bb2b9Af496aF0640Fc508", "0x7de04eD76BDE435df1526a994AC7f864274dc137"],
  ["uniswap-cow-robinhood-spy-usdg-rp", "SPY-USDG", "0xe71389553681e8cC0b9164898D58b631fEd7586b", "0x18B52a793BC1261661236A7f39E7348659FbFD0a"],
  ["uniswap-cow-robinhood-stonkbroker-weth-rp", "STONKBROKER-WETH", "0x9CcCE25f82f37ef777552E3BBB2A01BC5574AbE8", "0xDAceb29D88ee1b5eFE8ac134523dC93A35548703"],
  ["uniswap-cow-robinhood-tendies-weth-rp", "TENDIES-WETH", "0xAAa8C1e4F75Ec7DF802607D827Ea0efE8dCDDbDD", "0xcD68b5A8850E5A10531bDE1BC657329575E40E2C"],
  ["uniswap-cow-robinhood-tsla-usdg-rp", "TSLA-USDG", "0x6A5057a50178Cc9C90577d8Df401E7fBE79De9FD", "0xfE8585e7E1925C3Cf944772C75820c4DF47f1341"],
  ["uniswap-cow-robinhood-usdg-intc-rp", "INTC-USDG", "0xBb18aCfeeB566E8549F83bF0F0E01Bd0B2a7BdD2", "0x8C241D00EE324162A1a727f0167EB470c5B456e5"],
  ["uniswap-cow-robinhood-usdg-nvda-rp", "NVDA-USDG", "0xDaF08ca084DCbA9e801549803dE82160ADcAa1De", "0x11907281043B89F3b507159F37D254941B5f6525"],
  ["uniswap-cow-robinhood-uso-usdg-rp", "USO-USDG", "0x1176141bdBe958576a2c064b15cA0e94f0A5981F", "0x7627E96758938951498F071988CB47c6bB52dD7F"],
  ["uniswap-cow-robinhood-weth-coin-rp", "COIN-WETH", "0x83c2934FF42756e4FFaF0433c9E246e6888F3EF6", "0xC887326A6015f279FC68B5f6f93a1BE5899A5f2e"],
  ["uniswap-cow-robinhood-weth-mstr-rp", "MSTR-WETH", "0x0151a001B2EAb292a36Ffd8c1A42396dAe221848", "0xC6A55D8E2a0700fFA760D1C8361A82Ec4DeE0Dfe"],
  ["uniswap-cow-robinhood-weth-nvda-rp", "NVDA-WETH", "0xC61179279abB6cf3CEcCce23641B3d69986Ec777", "0x9776f496DFC4464df76B8503Ca1Ba95D116D1E02"],
  ["uniswap-cow-robinhood-weth-pons-rp", "PONS-WETH", "0x4F702C76dd9D7841784922f87470E3F718aAF6DA", "0xedBAa34DCBA4250F6BF9582ddED03244e623268D"],
  ["uniswap-cow-robinhood-weth-up-rp", "UP-WETH", "0xcB968f8382e3Fd875F47fbbde59Fdf46feB8b447", "0x41691Cb706ed97eF1AaF675D627EF5B01145E7d6"],
  ["uniswap-cow-robinhood-weth-usdg-rp", "USDG-WETH", "0x1e8d576F71D5F416e7573b960fF59C4Fb77976ad", "0x72cF42d5951e3F2F9Da265601a064A075600d036"],
  ["uniswap-cow-robinhood-weth-virtual-rp", "VIRTUAL-WETH", "0xc61b3b381C34A636451ba66A62792Bd84A78E112", "0x093f6613Dc96AF7c834A439F0a0aF18836B2dFdf"],
  ["up33-cow-robinhood-cashcat-weth-rp", "CASHCAT-WETH", "0x137731B8B2D7Cd24aB4A4A9061f2D7b4Fd1aBFEE", "0x3B2162ea5C3F6f20Eb05818f40d54857d1Aa3B45"],
  ["up33-cow-robinhood-up-stonkbroker-rp", "STONKBROKER-UP", "0xd922173C136443a1F7795A86B28Da964ea2BF6bc", "0x788D31D39da6252F228b5842d9215bb7abB83F8B"],
  ["up33-cow-robinhood-usdg-intc-rp", "INTC-USDG", "0x599ac767099bB6f01712867BfA1Fc1Aa27DEFD37", "0x0e7fb97a89b20A682521c5D29868E50A7b693979"],
  ["up33-cow-robinhood-usdg-nvda-rp", "NVDA-USDG", "0x63185DA98b76E7FA49d5d0611a6E211ee2988201", "0x6485817467Fd2129622e57b20577CF2697F3dDe2"],
  ["up33-cow-robinhood-weth-frong-rp", "FRONG-WETH", "0x9818f01EDCcc3d8EB86B859931C3B877cf44A108", "0xa3EDa31c3d7C886a6Ff3ccB69D4045C05EAaf3b3"],
  ["up33-cow-robinhood-weth-stonkbroker-rp", "STONKBROKER-WETH", "0x5794bB61E83397049c40D87BbF3d44AF583A27Ce", "0x10f9e8B973B5EA104618bd334f3CC2c0ff7E15F2"],
  ["up33-cow-robinhood-weth-tendies-rp", "TENDIES-WETH", "0x9619bFB1f2D97E2B23F23310205e4c2089c1A45d", "0xF8AB44EA77cE06E9b42De8021449Af01B3De977d"],
  ["up33-cow-robinhood-weth-up-rp", "UP-WETH", "0x36759534741E28Eb052238738963D684bFe719E4", "0xCC3DB04bB136A34E8569c1EfF2Ab19E3FA915d48"],
  ["up33-cow-robinhood-weth-usdg-rp", "USDG-WETH", "0x4319C71984790f96ac190a7709B380F6F27DD238", "0x55fD3b49Ef7E5f9a31DA68051989F5f749658f99"],
  ["up33-cow-robinhood-weth-virtual-rp", "VIRTUAL-WETH", "0x37698C12ecc727178617c5b7d694377eb98dE058", "0x5eD2B060b7f8809E6aC41DD769fE3528Fe44f424"],
];

export const WETH_ADDR = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const USDG_ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

/**
 * The WETH/USDG Uniswap v3 pool, used only to price a USDG leg back into ETH.
 * Verified: token0 = WETH, token1 = USDG (6 decimals), fee 500.
 */
export const WETH_USDG_POOL = "0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a";

/** Beefy's page for a vault, for anyone who wants to check the position. */
export function beefyUrl(id: string): string {
  return `https://app.beefy.com/vault/${id}`;
}

export function explorerAddr(a: string): string {
  return `${EXPLORER}/address/${a}`;
}
