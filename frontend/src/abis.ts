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

export const PONS_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  // Pons-specific: lets the UI detect graduation state without any of our contracts.
  "function curve() view returns (address)",
  "function launchFactory() view returns (address)",
];

// ---------------------------------------------------------------------------
// TITHE contracts — not yet deployed. These are the interfaces the read layer
// is written against, so wiring them up later is a one-line address change.
// ---------------------------------------------------------------------------
export const TREASURY_ABI = [
  // NAV excluding TITH (TITH is always marked at zero — spec §6).
  "function nav() view returns (uint256)",
  "function eligibleSupply() view returns (uint256)",
  "function floorPerToken() view returns (uint256)",
  "function usdgBalance() view returns (uint256)",
  "function ethBuffer() view returns (uint256)",
  "function sleeveAssets() view returns (uint256)",
  "function sleeveCapBps() view returns (uint256)",
  "function cumulativeTaxReceived() view returns (uint256)",
  // Emitted on every state change so the floor chart needs no indexer (§13.2).
  "event FloorUpdated(uint256 nav, uint256 eligibleSupply, uint256 timestamp)",
];

export const STAKED_AGORA_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function pendingYield(address account) view returns (uint256)",
];

export const REDEEMER_ABI = [
  "function haircutBps() view returns (uint256)",
  "function redeemDelay() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function queueLength() view returns (uint256)",
];
