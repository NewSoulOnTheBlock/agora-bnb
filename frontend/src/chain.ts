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
export const AGORA: {
  token: string; curve: string; deployer: string;
  feeSink: string; treasury: string; stakedAgora: string; redeemer: string;
} = {
  // Live: launched via PonsV2LaunchFactory, verified on-chain 2026-08-17.
  token: "0x6853618673D952Fe602616F6f896cC7be8e25fCc",
  curve: "0xfDE832b62dc27782619260E2579fF07EebAEc6DD",
  deployer: "0x2Fb89C8ce53E0527BC29e0861c4bEE1331d39d19",

  // The deployer EOA is ALREADY the on-chain creator-fee recipient (verified via
  // factory.getLaunchedToken field [2] and curve.buybackCreatorRecipient), so no
  // transferCreatorFeeRecipient call was needed to point the fee path here.
  //
  // As feeSink this is fully functional: V2FeeEscrow.balanceOf(feeSink) is a real
  // read, so "Claimable in escrow" now shows live data.
  //
  // As treasury it is a PLACEHOLDER. An EOA implements none of TREASURY_ABI
  // (nav/eligibleSupply/floorPerToken/...), so readReserve() clears the
  // `deployed` guard but every inner read returns null — NAV, floor and corpus
  // render "—" (unknown) rather than "not deployed". Replace with the real
  // Treasury contract address once it ships.
  feeSink: "0x2Fb89C8ce53E0527BC29e0861c4bEE1331d39d19",
  treasury: "0x2Fb89C8ce53E0527BC29e0861c4bEE1331d39d19",

  // Not deployed yet.
  stakedAgora: ZERO,
  redeemer: ZERO,
};

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

export function explorerAddr(a: string): string {
  return `${EXPLORER}/address/${a}`;
}
