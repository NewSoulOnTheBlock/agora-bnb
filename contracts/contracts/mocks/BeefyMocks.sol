// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Test doubles for the Beefy CLM sleeve.
 *
 * These exist to exercise the adapter's **guards** — access control, the TWAP
 * band, the vault-share cap, the calm gate, the realize cooldown — where the
 * fork cannot easily be pushed into the failing state on demand.
 *
 * They are deliberately NOT a model of Beefy's economics. The question "does a
 * real deposit mint the shares it should, and what does the round trip cost"
 * is answered by `scripts/rehearse-beefy.ts` against the live vault, because a
 * mock that agreed with my own assumptions would prove nothing.
 */

interface ISwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "eth");
    }

    /// @dev Lets `MockV3Pool` pay out a WETH leg. Backed by `fund()` below.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Add ETH backing without minting, so minted WETH stays redeemable.
    function fund() external payable {}

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

contract MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @dev A constant-price Uniswap v3 pool. `swap` settles at exactly `price`
 *      with no curve, which keeps the arithmetic under test the adapter's own.
 */
contract MockV3Pool {
    address public token0;
    address public token1;

    uint160 public sqrtPriceX96;
    int24 public tick;
    int24 public twapTickValue;

    /// @dev Set to make `observe` revert, proving `totalAssets()` still cannot.
    bool public observeBroken;

    constructor(address t0, address t1, uint160 sqrt_, int24 tick_) {
        token0 = t0;
        token1 = t1;
        sqrtPriceX96 = sqrt_;
        tick = tick_;
        twapTickValue = tick_;
    }

    function setSpot(uint160 sqrt_, int24 tick_) external {
        sqrtPriceX96 = sqrt_;
        tick = tick_;
    }

    function setTwapTick(int24 t) external {
        twapTickValue = t;
    }

    function setObserveBroken(bool b) external {
        observeBroken = b;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (sqrtPriceX96, tick, 0, 14400, 14400, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory liq)
    {
        require(!observeBroken, "observe");
        tickCumulatives = new int56[](2);
        liq = new uint160[](2);
        // cumulative[1] - cumulative[0] == twapTick * window
        tickCumulatives[0] = 0;
        tickCumulatives[1] = int56(twapTickValue) * int56(uint56(secondsAgos[0]));
    }

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1) {
        uint256 amountIn = uint256(amountSpecified);
        // price = (sqrt/2^96)^2, applied without slippage.
        uint256 p = (uint256(sqrtPriceX96) * uint256(sqrtPriceX96)) >> 192;
        uint256 out = zeroForOne ? amountIn * p : amountIn / p;

        if (zeroForOne) {
            amount0 = int256(amountIn);
            amount1 = -int256(out);
            MockToken(token1).mint(recipient, out);
        } else {
            amount1 = int256(amountIn);
            amount0 = -int256(out);
            MockToken(token0).mint(recipient, out);
        }

        ISwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}

contract MockStrategy {
    address public pool;

    constructor(address p) {
        pool = p;
    }
}

/// @dev Share-based two-asset vault. Shares are minted 1:1 against token0-equivalent.
contract MockCLM is ERC20 {
    address public t0;
    address public t1;
    address public strategy;
    bool public calm = true;

    uint256 public bal0;
    uint256 public bal1;

    constructor(address a, address b, address strat) ERC20("Mock CLM", "mCLM") {
        t0 = a;
        t1 = b;
        strategy = strat;
    }

    function setCalm(bool c) external {
        calm = c;
    }

    function isCalm() external view returns (bool) {
        return calm;
    }

    function wants() external view returns (address, address) {
        return (t0, t1);
    }

    function balances() external view returns (uint256, uint256) {
        return (bal0, bal1);
    }

    /// @dev Shares track token0 + token1, so the test's arithmetic stays legible.
    function previewDeposit(uint256 a0, uint256 a1)
        external
        pure
        returns (uint256, uint256, uint256, uint256, uint256)
    {
        return (a0 + a1, a0, a1, 0, 0);
    }

    function previewWithdraw(uint256 shares) public view returns (uint256, uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return (0, 0);
        return ((bal0 * shares) / supply, (bal1 * shares) / supply);
    }

    function deposit(uint256 a0, uint256 a1, uint256 minShares) external {
        uint256 shares = a0 + a1;
        require(shares >= minShares, "minShares");
        if (a0 != 0) IERC20(t0).transferFrom(msg.sender, address(this), a0);
        if (a1 != 0) IERC20(t1).transferFrom(msg.sender, address(this), a1);
        bal0 += a0;
        bal1 += a1;
        _mint(msg.sender, shares);
    }

    function withdraw(uint256 shares, uint256 min0, uint256 min1) external {
        (uint256 a0, uint256 a1) = previewWithdraw(shares);
        require(a0 >= min0 && a1 >= min1, "minAmounts");
        _burn(msg.sender, shares);
        bal0 -= a0;
        bal1 -= a1;
        if (a0 != 0) IERC20(t0).transfer(msg.sender, a0);
        if (a1 != 0) IERC20(t1).transfer(msg.sender, a1);
    }

    /// @dev Simulate appreciation, so surplus realization can be tested.
    function addYield(uint256 add0, uint256 add1) external {
        if (add0 != 0) {
            MockToken(t0).mint(address(this), add0);
            bal0 += add0;
        }
        if (add1 != 0) {
            MockToken(t1).mint(address(this), add1);
            bal1 += add1;
        }
    }
}

contract MockRewardPool is ERC20 {
    address public stakedToken;
    uint256 public rewardsLength;

    constructor(address staked) ERC20("Mock RP", "mRP") {
        stakedToken = staked;
    }

    function stake(uint256 amount) external {
        IERC20(stakedToken).transferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        IERC20(stakedToken).transfer(msg.sender, amount);
    }

    function getReward() external {}

    function exit() external {}
}

/// @dev Stands in for the Treasury so adapter calls can be made directly.
contract TreasuryCaller {
    receive() external payable {}

    function callDeposit(address adapter, uint256 amount) external payable {
        (bool ok, bytes memory ret) = adapter.call{value: amount}(abi.encodeWithSignature("deposit()"));
        if (!ok) _bubble(ret);
    }

    function callWithdraw(address adapter, uint256 amount) external returns (uint256) {
        (bool ok, bytes memory ret) = adapter.call(abi.encodeWithSignature("withdraw(uint256)", amount));
        if (!ok) _bubble(ret);
        return abi.decode(ret, (uint256));
    }

    function callRealize(address adapter) external returns (uint256) {
        (bool ok, bytes memory ret) = adapter.call(abi.encodeWithSignature("realizeSurplus()"));
        if (!ok) _bubble(ret);
        return abi.decode(ret, (uint256));
    }

    function _bubble(bytes memory ret) private pure {
        if (ret.length == 0) revert("call failed");
        assembly {
            revert(add(32, ret), mload(ret))
        }
    }
}
