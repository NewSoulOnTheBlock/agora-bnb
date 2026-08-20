// Minimal human-readable ABI fragments. Only what the read layer touches.

export const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
];

export const MEME_HOOK_ABI = [
  "function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)",
  "function pendingFees(bytes32 poolId, address currency) view returns (uint256)",
  "function pendingBuyback(bytes32 poolId, address currency) view returns (uint256)",
  "function hookFeeBps() view returns (uint256)",
  "function protocolFeeShareBps() view returns (uint256)",
  "function feeSweepOperator() view returns (address)",
  "function poolManager() view returns (address)",
  // poolId indexed; currency/amounts in data.
  "event HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount)",
  "event PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount, uint256 tokensLocked)",
];

export const FEE_ESCROW_ABI = [
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
];

export const LAUNCH_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  // Launchpad-specific: lets the UI detect graduation without any of our contracts.
  "function curve() view returns (address)",
  "function launchFactory() view returns (address)",
];

// ---------------------------------------------------------------------------
// TITHE contracts — not yet deployed. These are the interfaces the read layer
// is written against, so wiring them up later is a one-line address change.
// ---------------------------------------------------------------------------
export const TREASURY_ABI = [
  // NAV excludes TORII (marked at zero, spec §6) AND pendingIncome, which is
  // owed to stakers and therefore never backs the floor.
  "function nav() view returns (uint256)",
  "function eligibleSupply() view returns (uint256)",
  "function floorPerToken() view returns (uint256)",
  "function floorHighWaterMark() view returns (uint256)",
  "function usdgBalance() view returns (uint256)",
  "function ethBuffer() view returns (uint256)",
  "function liquidEth() view returns (uint256)",
  "function sleeveAssets() view returns (uint256)",
  "function sleeveCorpus() view returns (uint256)",
  "function unrealizedSurplus() view returns (uint256)",
  "function sleeveCapBps() view returns (uint256)",
  "function cumulativeTaxReceived() view returns (uint256)",
  "function cumulativeDonated() view returns (uint256)",
  "function cumulativePaidOut() view returns (uint256)",
  "function pendingIncome() view returns (uint256)",
  "function incomeShareBps() view returns (uint16)",
  "function cumulativeIncomeDistributed() view returns (uint256)",
  "function redeemer() view returns (address)",
  "function distributor() view returns (address)",
  "function operator() view returns (address)",
  "function cumulativeWithdrawn() view returns (uint256)",
  "function feeSink() view returns (address)",
  "function owner() view returns (address)",
  "function distributeIncome() returns (uint256)",
  "function poke()",
  // Emitted on every state change so the floor chart needs no indexer (§13.2).
  "event FloorUpdated(uint256 nav, uint256 eligibleSupply, uint256 timestamp)",
  "event FloorRegression(uint256 highWaterMark, uint256 current, uint256 timestamp)",
  // Corpus ETH leaving for off-contract yield deployment. navAfter is logged so
  // the corpus history is auditable from events alone.
  "event Withdrawn(address indexed to, uint256 amount, uint256 navAfter)",
];

export const FEE_SINK_ABI = [
  "function collectable() view returns (uint256 inEscrow, uint256 onCurve, uint256 held)",
  "function collect() returns (uint256)",
  "function sweep() returns (uint256)",
  "function curve() view returns (address)",
  "function treasury() view returns (address)",
];

export const STAKED_TORII_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function pendingYield(address account) view returns (uint256)",
  "function cumulativeRewards() view returns (uint256)",
  "function cumulativeClaimed() view returns (uint256)",
  "function asset() view returns (address)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function claim() returns (uint256)",
];

export const REDEEMER_ABI = [
  "function haircutBps() view returns (uint256)",
  "function redeemDelay() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function totalPaidOut() view returns (uint256)",
  "function queueLength() view returns (uint256)",
  "function epochCapBps() view returns (uint16)",
  "function epochRemaining() view returns (uint256)",
  "function requestsPaused() view returns (bool)",
  "function quote(uint256 amount) view returns (uint256)",
  "function requests(uint256 id) view returns (tuple(address owner, uint128 amount, uint128 snapshotFloor, uint64 requestedAt, bool executed))",
  "function preview(uint256 id) view returns (uint256 paid, uint256 executableAt, bool ready)",
  "function requestRedeem(uint256 amount) returns (uint256)",
  "function execute(uint256 id) returns (uint256)",
  "event RedeemRequested(uint256 indexed id, address indexed owner, uint256 amount, uint256 snapshotFloor, uint256 executableAt)",
  "event RedeemExecuted(uint256 indexed id, address indexed owner, uint256 amount, uint256 payFloor, uint256 paid)",
];

export const DISTRIBUTOR_ABI = [
  "function cumulativeToAgora() view returns (uint256)",
  "function preview(uint256 amount) view returns (uint256 toTorii)",
  "function distribute() payable",
];

