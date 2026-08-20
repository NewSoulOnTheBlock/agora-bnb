// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Stands in for the Treasury's `fund()` entry point.
contract MockFundSink {
    uint256 public funded;
    uint256 public calls;

    event Funded(uint256 amount);

    function fund() external payable {
        funded += msg.value;
        calls += 1;
        emit Funded(msg.value);
    }
}

/// @dev A Treasury that rejects funding, to prove the vault does not silently
///      zero its baseline when the forward fails.
contract RevertingFundSink {
    function fund() external payable {
        revert("MockTreasury: refused");
    }
}

/**
 * @dev Minimal PancakeSwap V2 router.
 *
 * `rateWeiPerToken` is BNB paid per whole token (18dp), so a test can set an
 * exact expected output rather than modelling a curve.
 *
 * `taxBps` reproduces the property that actually matters here: AGORA is a tax
 * token, so the router receives less than `amountIn`. That is why production
 * uses `...SupportingFeeOnTransferTokens`, and this mock exists to keep that
 * assumption honest rather than assumed.
 */
contract MockPancakeRouter {
    address public immutable weth;
    uint256 public rateWeiPerToken;
    uint16 public taxBps;

    constructor(address weth_, uint256 rateWeiPerToken_) {
        weth = weth_;
        rateWeiPerToken = rateWeiPerToken_;
    }

    receive() external payable {}

    function WETH() external view returns (address) {
        return weth;
    }

    function setRate(uint256 rateWeiPerToken_) external {
        rateWeiPerToken = rateWeiPerToken_;
    }

    function setTaxBps(uint16 taxBps_) external {
        taxBps = taxBps_;
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        require(deadline >= block.timestamp, "MockRouter: expired");
        require(path.length == 2, "MockRouter: bad path");
        require(path[1] == weth, "MockRouter: path must end in WETH");

        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        // Only the post-tax amount is treated as having reached the pair.
        uint256 effective = amountIn - (amountIn * taxBps) / 10_000;
        uint256 out = (effective * rateWeiPerToken) / 1e18;
        require(out >= amountOutMin, "MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
        require(address(this).balance >= out, "MockRouter: not funded");

        (bool ok, ) = to.call{value: out}("");
        require(ok, "MockRouter: transfer failed");
    }
}

/// @dev A token that charges a transfer tax, so the vault's swap path is
///      exercised against a fee-on-transfer ERC20 rather than a clean one.
contract MockTaxToken is ERC20 {
    uint16 public taxBps;

    constructor(uint16 taxBps_) ERC20("Mock AGORA", "mAGORA") {
        taxBps = taxBps_;
        _mint(msg.sender, 1_000_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Lets a test switch the transfer tax on after funding the vault, so
    ///      the untaxed set-up transfer does not skew the expected swap output.
    function setTaxBps(uint16 taxBps_) external {
        taxBps = taxBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || taxBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * taxBps) / 10_000;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, address(0xdead), fee);
    }
}

/// @dev stAGORA stand-in for the distributor tests.
contract MockRewardSink {
    uint256 public supply;
    uint256 public received;

    function setSupply(uint256 s) external {
        supply = s;
    }

    function totalSupply() external view returns (uint256) {
        return supply;
    }

    function notifyReward() external payable {
        received += msg.value;
    }
}
