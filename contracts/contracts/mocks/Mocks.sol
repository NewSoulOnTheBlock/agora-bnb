// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";

/// @dev Stands in for the Pons-deployed AGORA: plain, fixed-supply, burnable.
contract MockAgora is ERC20 {
    constructor(uint256 supply) ERC20("Agora", "AGORA") {
        _mint(msg.sender, supply);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

/**
 * @dev A yield adapter whose value can be pushed up (yield) or down
 *      (impermanent loss) so the Treasury's floor-regression path is testable.
 *      Mirrors the real high-water-mark rule from spec §9.
 */
contract MockAdapter is IYieldAdapter {
    uint256 public assets;
    uint256 public principalHighWaterMark;

    receive() external payable {}

    function deposit() external payable {
        assets += msg.value;
        principalHighWaterMark += msg.value;
    }

    function withdraw(uint256 amount) external returns (uint256) {
        uint256 send = amount > assets ? assets : amount;
        assets -= send;
        if (send > principalHighWaterMark) {
            principalHighWaterMark = 0;
        } else {
            principalHighWaterMark -= send;
        }
        (bool ok, ) = msg.sender.call{value: send}("");
        require(ok, "MockAdapter: send failed");
        return send;
    }

    function realizeSurplus() external returns (uint256) {
        if (assets <= principalHighWaterMark) return 0;
        uint256 surplus = assets - principalHighWaterMark;
        assets -= surplus;
        (bool ok, ) = msg.sender.call{value: surplus}("");
        require(ok, "MockAdapter: send failed");
        return surplus;
    }

    function totalAssets() external view returns (uint256) {
        return assets;
    }

    /// @dev Simulate yield accrual: value appears without a deposit.
    function simulateYield() external payable {
        assets += msg.value;
    }

    /// @dev Simulate impermanent loss: reported value falls below principal.
    function simulateLoss(uint256 amount) external {
        assets = amount > assets ? 0 : assets - amount;
    }
}

/// @dev Forwards ETH using `transfer()`, i.e. with only a 2300-gas stipend.
contract StipendSender {
    function send(address to, uint256 amount) external {
        payable(to).transfer(amount);
    }

    receive() external payable {}
}

/// @dev An adapter that always reverts on `totalAssets()`, to prove the
///      Treasury's dependence on well-behaved adapters is real and documented.
contract RevertingAdapter is IYieldAdapter {
    function deposit() external payable {}

    function withdraw(uint256) external pure returns (uint256) {
        return 0;
    }

    function realizeSurplus() external pure returns (uint256) {
        return 0;
    }

    function totalAssets() external pure returns (uint256) {
        revert("adapter down");
    }
}
