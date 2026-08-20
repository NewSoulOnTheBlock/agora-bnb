import { JsonRpcProvider, FetchRequest } from "ethers";

/**
 * ---------------------------------------------------------------------------
 * BNB Chain (56)
 * ---------------------------------------------------------------------------
 *
 * This file is the whole difference between the two deployments. TORII on BNB
 * is not the Robinhood Chain build with a different RPC — three of its four
 * external dependencies are different contracts entirely:
 *
 *   Robinhood Chain (4663)          BNB Chain (56)
 *   ─────────────────────────       ─────────────────────────
 *   Pons v2 bonding curve           Flap
 *   Uniswap v4 + StateView          PancakeSwap V2 pairs
 *   FeeSink pulls tax               ToriiVault is pushed tax
 *   4% creator tax                  5% (Flap offers 1/3/5/10 only)
 *   Suits ERC-721 staking           — no BNB deployment, dropped
 *
 * Everything verified live against chain 56 on 2026-08-20; each address below
 * says what was checked rather than only where it came from.
 */

export const CHAIN_ID = 56;
export const CHAIN_ID_HEX = "0x38";

/**
 * ## Reads work everywhere. Logs almost nowhere.
 *
 * `eth_call` is served by every public BSC endpoint, so balances, reserves and
 * every contract getter are free and fast. `eth_getLogs` is a different story,
 * and it was measured rather than assumed — eight public endpoints, 2026-08-20:
 *
 *   bsc-dataseed.bnbchain.org        eth_getLogs refused outright
 *   bsc-dataseed1.defibit.io         refused
 *   1rpc.io/bnb                      refused
 *   bsc.blockrazor.xyz               refused
 *   bsc-mainnet.public.blastapi.io   refused
 *   bsc.meowrpc.com                  "method not supported"
 *   rpc.ankr.com/bsc                 requires a key
 *   bsc-rpc.publicnode.com           works, but only ~9,960 blocks deep
 *
 * BSC now produces a block every **0.45 seconds**, so that best case is about
 * **1.2 hours** of history. Nothing that needs a day of events — the candle
 * chart, the distribution history — can run on a free endpoint here. That is a
 * property of the chain's public infrastructure, not of this code.
 *
 * So the app degrades honestly: everything read by `eth_call` is always live,
 * and the log-backed views say what they are missing instead of rendering an
 * empty chart as though the token had never traded. Point `VITE_BSC_RPC_URL` at
 * an archive endpoint and they light up with no other change.
 */
export const RPC_URL =
  (import.meta.env?.VITE_BSC_RPC_URL as string | undefined) ??
  "https://bsc-dataseed.bnbchain.org";

/**
 * The log endpoint, kept separate from the read endpoint on purpose.
 *
 * The fastest dataseed cannot serve logs at all, and the one that can is slower
 * for everything else. Splitting them means the pages everyone looks at are not
 * paying for a capability only two views need.
 */
export const LOG_RPC_URL =
  (import.meta.env?.VITE_BSC_LOG_RPC_URL as string | undefined) ??
  "https://bsc-rpc.publicnode.com";

/**
 * How far back logs can be requested.
 *
 * publicnode caps by **result count** — its own error is "query exceeds max
 * results 20000, retry with the range X-Y" — and separately refuses anything
 * older than roughly ten thousand blocks without a token. For a token as quiet
 * as a fresh launch the result cap is not the binding one; the archive depth
 * is. Scanners here split on the suggested range when the first bites and stop
 * at the wall when the second does.
 */
export const MAX_LOG_SPAN = 9_000;

/**
 * Total depth a log scan may reach, in blocks.
 *
 * Without this the scanner walked its full `maxChunks` — six chunks of 9,000 —
 * and five of them landed past the archive wall, so every page load fired five
 * requests that could only ever come back **403 Archive requests require a
 * personal token**. They were caught and ignored, which is worse than it
 * sounds: the console filled with failures that looked like a bug in this code
 * and were actually the endpoint doing exactly what it says it does.
 *
 * So the scan stops at the wall instead of knocking on it. Measured by binary
 * search against publicnode: 9,960 blocks. 9,000 leaves headroom for the wall
 * moving as the head advances mid-scan.
 *
 * A configured `VITE_BSC_LOG_RPC_URL` is assumed to be an archive node and is
 * not clamped — that is the whole point of setting it.
 */
export const HAS_ARCHIVE = !!import.meta.env?.VITE_BSC_LOG_RPC_URL;
export const MAX_LOG_DEPTH = HAS_ARCHIVE ? Number.MAX_SAFE_INTEGER : 9_000;

/** Seconds per block, measured over 1000 blocks. Used to size log windows. */
export const BLOCK_SECONDS = 0.45;

export const EXPLORER = "https://bscscan.com";

export const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER],
};

function provider(url: string) {
  const req = new FetchRequest(url);
  // BSC public endpoints answer a single call quickly and a JSON-RPC batch with
  // a 429. Multicall3 already collapses the reads that matter into one call, so
  // there is nothing to gain from batching on top of it.
  return new JsonRpcProvider(req, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
}

export const readProvider = provider(RPC_URL);

/** Only for `eth_getLogs`. See `LOG_RPC_URL`. */
export const logProvider = RPC_URL === LOG_RPC_URL ? readProvider : provider(LOG_RPC_URL);

export const ZERO = "0x0000000000000000000000000000000000000000";

/** Native BNB is spelled `address(0)` in this codebase, as ETH was on 4663. */
export const NATIVE = ZERO;

// ---------------------------------------------------------------------------
// PancakeSwap V2 — where TORII trades after it graduates off Flap
// ---------------------------------------------------------------------------
/**
 * V2, not V3, and not by accident: Flap graduates a token into a PancakeSwap
 * **V2** pair, and `ToriiVault.convertAndForward` sells its token leg through
 * the V2 router. Reading a V3 pool would be reading a market the protocol does
 * not use.
 *
 * V2 is also the easier read. A pair is two `uint112` reserves — no
 * `sqrtPriceX96`, no tick maths, no separate `StateView` contract, and no
 * poolId to derive. Most of `poolkey.ts` simply has no counterpart here.
 *
 * Verified by behaviour rather than by bytecode presence, which is the lesson
 * from `55f97ac`: the router was asked what it thinks it is.
 *
 *   router.WETH()    == 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c  (WBNB)
 *   router.factory() == 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73
 */
export const PANCAKE = {
  router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
  /** 0.25% total, of which 0.17% goes to LPs. Constant-product after fee. */
  feeBps: 25,
} as const;

/** Wrapped BNB. Confirmed `symbol() == "WBNB"`, `decimals() == 18`. */
export const WBNB_ADDR = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

/** Binance-Peg USDT on BSC. 18 decimals here, unlike the 6 it has on Ethereum. */
export const USDT_ADDR = "0x55d398326f99059fF775485246999027B3197955";
export const USDT_DECIMALS = 18;

/**
 * The WBNB/USDT PancakeSwap V2 pair — the dollar quote for BNB.
 *
 * Read live: `token0` is USDT and `token1` is WBNB, so the ratio is inverted
 * relative to what the ordering suggests. Cross-checked at the time of writing
 * against the pair's own reserves: **BNB ≈ $649.33**.
 *
 * Display only, exactly as on 4663. It is a spot DEX price, manipulable inside
 * a block, and it must never reach the floor, redemption or any adapter NAV.
 */
export const WBNB_USDT_PAIR = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE";

// ---------------------------------------------------------------------------
// Flap — the launchpad, and the source of the tax
// ---------------------------------------------------------------------------
/**
 * Flap replaces Pons, and inverts the mechanism.
 *
 * On Pons the tax accrued inside a hook and had to be *pulled* by a keeper we
 * did not control — which is how v1 stalled, with tax sitting unreachable in
 * `pendingCreatorTax`. Flap **pushes** the tax into a vault we supply, so there
 * is no sweep to wait on and no third party in the path.
 *
 * `ToriiVault` is that vault. Flap's VaultPortal deploys it during the launch
 * from `ToriiVaultFactory`, so its address is not known until the token exists —
 * it lands in `TORII.feeSink` below, keeping the same name the rest of the app
 * already uses for "the contract the tax arrives at".
 *
 * Portal, Guardian and VaultPortal are all 2,882-byte proxies; the addresses
 * are the ones `flap/VaultBase.sol` resolves for `block.chainid == 56`, so the
 * frontend and the contracts cannot drift apart on them.
 */
export const FLAP = {
  vaultPortal: "0x90497450f2a706f1951b5bdda52B4E5d16f34C06",
  portal: "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0",
  guardian: "0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b",
} as const;

/**
 * 5%, not 4%.
 *
 * Flap permits 1/3/5/10% only, so the 4% used on Robinhood Chain is not
 * expressible here. `ToriiVaultFactory._validateBeforeLaunch` refuses to launch
 * unless the split is 500/500 bps and `vaultBps` is 10000 — the v1 lesson
 * enforced on-chain rather than left to whoever fills in the launch form.
 */
export const TORII_TAX_BPS = 500; // 5%

/** Flap's own cut of a trade, separate from the creator tax. */
export const CURVE_FEE_BPS = 100;

// ---------------------------------------------------------------------------
// TORII on BNB — LIVE. Verified on chain 56, 2026-08-20.
// ---------------------------------------------------------------------------
/**
 * Token name is 神社 (shénshè, "shrine"); the symbol is TORII. Supply is a flat
 * 1,000,000,000, eighteen decimals, and the token itself is a 45-byte minimal
 * proxy deployed by Flap.
 *
 * ## There are TWO Treasury contracts on this chain, and only one is wired
 *
 * Both hold identical 11,051-byte bytecode and share the same owner, so nothing
 * about either address tells you which is which. The difference is entirely in
 * their state, read live:
 *
 *   0x2384b63A…  agora/feeSink/distributor/redeemer  all set     <- LIVE
 *   0x9839E620…  every one of them address(0)                    <- empty
 *
 * And the satellites agree with the first: `Redeemer.treasury()` and
 * `Vault.treasury()` both return `0x2384b63A…`.
 *
 * This matters more than a typo would, because wiring the empty one does not
 * fail. `nav()`, `eligibleSupply()` and `floorPerToken()` all answer **0**
 * rather than reverting, so the Reserve page would render a complete, confident
 * dashboard reporting a protocol with nothing in it. That is the exact failure
 * this codebase keeps designing against, and here it is available as a
 * copy-paste mistake.
 *
 * If these ever need to change, take them from what the *satellites* point at,
 * not from a deploy log — the satellites cannot be out of date about
 * themselves.
 */
export const TORII: {
  token: string; curve: string; deployer: string;
  feeSink: string; treasury: string; stakedAgora: string; redeemer: string;
  stakedSuits: string; distributor: string;
} = {
  /** 神社 · TORII. `Treasury.agora()` and `Vault.taxToken()` both name it. */
  token: "0x5830D9306B7EDf396C1f3fc023fDDcc75Ae97777",

  /**
   * Flap's bonding curve. Not yet known to the frontend: the token has NOT
   * graduated — `PancakeFactory.getPair` still returns address(0) for the
   * TORII/WBNB pair — so trading is entirely on Flap's own contract, which is
   * per-launch and not derivable from the token address.
   */
  curve: (import.meta.env?.VITE_TORII_CURVE as string) || ZERO,

  deployer: "0x442a46D9364abf5CE274956cC7563B1189541cF7",

  /** `bnb/ToriiVault` — Flap pushes the 5% here. Holds real BNB already. */
  feeSink: "0x0938F48DC611684F4f06C38471BfE8454d88c9A4",

  /** The wired one. See the note above before changing this. */
  treasury: "0x2384b63A5D58696FC01BceA32D5416b4864BBE1a",

  /** stTORII — ERC-4626 over TORII. 21 decimals, see below. */
  stakedAgora: "0x47c5608b9cA68Fd78F2bBAf89f29cc23887b55d6",
  redeemer: "0xcF4894339cD07c9577e870ae213f4e9bd71e3fb1",

  /** Permanently zero on BNB — the Suits collection is a 4663 contract. */
  stakedSuits: ZERO,

  /** `bnb/ToriiDistributor`. No `treasury()` getter: it has no owner and no
   *  second sink, so there is nothing for it to be bound to. */
  distributor: "0xE675ebE3Ee9764064652aa1d00fF60b4971Addcc",
};

/** `ToriiVaultFactory` — Flap constructs the vault from this at launch. */
export const TORII_VAULT_FACTORY = "0xb7F484436fAc0E9BB341931250015d97A2Ca5Bb4";

/**
 * The pair TORII will trade in once Flap graduates it.
 *
 * Derived, not looked up — a PancakeSwap V2 pair address is a pure function of
 * its two tokens, so this is knowable before the pair exists. `readPoolState`
 * asks the factory whether it has been created yet, which is how "not
 * graduated" stays distinguishable from "graduated but no liquidity".
 */
export const TORII_WBNB_PAIR = "0x38dfBf0cd27270375a7D9A7588a794B4e0995bCf";

/**
 * stTORII does **not** have 18 decimals. It has 21.
 *
 * `StakedTorii._decimalsOffset()` returns 3 — OpenZeppelin's virtual-share
 * defence against the classic 4626 first-depositor donation attack — and
 * ERC-4626 defines `decimals() = underlying decimals + offset`. So one whole
 * stTORII is `1e21`, and it is still worth exactly one TORII: the share price
 * never legitimately moves, because rewards are BNB and live outside
 * `totalAssets()`.
 *
 * Formatting a share balance through `formatEther` therefore prints it **1000×
 * too large** — a 10,000,000 TORII stake rendering as "10,000,000,000 stTORII".
 * Anything that touches a raw share number must scale by this, not by WAD.
 * Nothing on-chain is affected: the reward accumulator divides and multiplies
 * by the same supply, so the offset cancels, and the floor is computed from
 * TORII's own `totalSupply()`, never the vault's.
 *
 * This was a live display bug on the other chain before it was caught. The
 * contract is the same source, so the trap is the same here.
 */
export const ST_TORII_DECIMALS = 21;

// ---------------------------------------------------------------------------
// Suits — not on this chain
// ---------------------------------------------------------------------------
/**
 * The Suits collection lives on chain 4663 and has no BNB deployment, so the
 * whole NFT side is off here: no tab, no folder, no share of income.
 *
 * `ToriiDistributor` on BNB reflects that in the contract rather than only in
 * the UI — losing the second sink removed the split, `suitsBps`, the reroute
 * logic and `Ownable` with it, so that contract has no privileged caller at
 * all. `SUITS_SHARE_BPS` is therefore 0 and stakers receive the whole income
 * share, not 90% of it.
 */
export const SUITS_STAKING_ENABLED = false;
export const SUITS_SHARE_BPS = 0;
export const SUITS_NFT = ZERO;
export const SUITS_SUPPLY = 0;
export const SUITS_VALIDATOR = ZERO;
export const SUITS_MARKET = "";

/** No demo token on this chain: nothing is live to point at yet. */
export const DEMO_TOKEN = ZERO;

/** The token the UI reads. */
export function activeToken(): { address: string; isDemo: boolean } {
  return { address: TORII.token, isDemo: false };
}

/**
 * BNB/USD comes from the WBNB/USDT pair above, not from an oracle.
 *
 * Chainlink does publish a BNB/USD aggregator on 56, and it would be the better
 * source if any of these numbers decided money. None of them do — the figure is
 * a dollar line under an amount and nothing reads it back — so the pair keeps
 * the page's one rule intact: every number on it is re-derivable from the RPC
 * alone, with no third party and no key.
 */
export const ETH_USD_FEED: string | null = null;

/** Where people actually look at the chart. DexScreener covers BSC. */
export const GMGN_URL = TORII.token !== ZERO
  ? `https://dexscreener.com/bsc/${TORII.token.toLowerCase()}`
  : "https://dexscreener.com/bsc";

// ---------------------------------------------------------------------------
// Beefy
// ---------------------------------------------------------------------------
/**
 * Empty, and it should stay empty until there is something to put in it.
 *
 * The 4663 registry is baked in over there because the operator was already
 * deploying corpus ETH by hand into 33 known vaults, and a stale three-entry
 * list had silently read a real position as zero. Neither condition holds here:
 * nothing has been withdrawn on BNB, so an invented list of BSC vaults would be
 * 400 reads a page load that can only ever return zero, plus a standing
 * invitation to mistake a guess for a holding.
 *
 * Fill it from `api.beefy.finance/vaults?chain=bsc` when the sleeve is actually
 * used here. Tuple order: [id, label, CLM vault, reward pool].
 */
export const BEEFY_VAULTS: [string, string, string, string][] = [];

/** Aliases the Beefy reader expects. On this chain the quote asset is WBNB. */
export const WETH_ADDR = WBNB_ADDR;
export const USDG_ADDR = USDT_ADDR;
export const WETH_USDG_POOL = WBNB_USDT_PAIR;

export function beefyUrl(id: string): string {
  return `https://app.beefy.com/vault/${id}`;
}

export function explorerAddr(a: string): string {
  return `${EXPLORER}/address/${a}`;
}

export function explorerTx(h: string): string {
  return `${EXPLORER}/tx/${h}`;
}
