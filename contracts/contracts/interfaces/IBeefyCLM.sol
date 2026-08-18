// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * External interfaces for the Beefy CLM sleeve.
 *
 * Every signature below was read from a **verified implementation on chain
 * 4663**, not inferred from bytecode and not copied from Beefy's docs:
 *
 *   BeefyVaultConcLiq  0xfd4017ad7c1092aafebc82621b4dee59f178d74c
 *                      (implementation behind the EIP-1167 clone at
 *                       0x9CcCE25f82f37ef777552E3BBB2A01BC5574AbE8)
 *   BeefyRewardPool    0x7A6849A714D8014685310F20AEC07053FDbED442
 *                      (implementation behind the BeaconProxy at
 *                       0xDAceb29D88ee1b5eFE8ac134523dC93A35548703)
 *   UniswapV3Pool      0x9cd74d5980A4BF60408B9bA2B0F6a3d368EBf594
 *                      (verified source, canonical v3 — `observe` present,
 *                       observationCardinality 14400)
 *
 * Guessing an ABI is how the first deployment died. These were checked.
 */

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Beefy's Cowcentrated Liquidity Manager vault. Two-asset, share-based.
interface IBeefyVaultConcLiq {
    /// @notice Deposit both tokens. Reverts if the strategy is not "calm".
    function deposit(uint256 amount0, uint256 amount1, uint256 minShares) external;

    /// @notice Burn `shares`, receiving both tokens.
    function withdraw(uint256 shares, uint256 minAmount0, uint256 minAmount1) external;

    /// @notice What `amount0`/`amount1` would mint, and the fees taken.
    /// @return shares   Shares minted
    /// @return used0    Token0 actually consumed
    /// @return used1    Token1 actually consumed
    /// @return fee0     Token0 fee
    /// @return fee1     Token1 fee
    function previewDeposit(uint256 amount0, uint256 amount1)
        external
        view
        returns (uint256 shares, uint256 used0, uint256 used1, uint256 fee0, uint256 fee1);

    /// @notice What burning `shares` would return, in both tokens.
    function previewWithdraw(uint256 shares) external view returns (uint256 amount0, uint256 amount1);

    /// @notice Total token0/token1 held across the vault's positions.
    function balances() external view returns (uint256 amount0, uint256 amount1);

    /// @notice (token0, token1).
    function wants() external view returns (address token0, address token1);

    /**
     * @notice Beefy's own price-manipulation guard.
     * @dev False when the pool price has moved too far from its TWAP. Beefy's
     *      strategy reverts deposits while uncalm; this adapter checks it up
     *      front so the failure is legible rather than an opaque inner revert.
     */
    function isCalm() external view returns (bool);

    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function strategy() external view returns (address);
}

/// @dev The `-rp` wrapper. Holds CLM shares and streams extra reward tokens.
interface IBeefyRewardPool {
    function stake(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function exit() external;
    function getReward() external;
    function balanceOf(address) external view returns (uint256);
    function stakedToken() external view returns (address);
    function rewardsLength() external view returns (uint256);
    function rewards(uint256) external view returns (address);
    function earned(address account) external view returns (address[] memory, uint256[] memory);
}

interface IUniswapV3PoolMin {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice Cumulative ticks at each `secondsAgo`. The TWAP source.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function token0() external view returns (address);
    function token1() external view returns (address);
}
