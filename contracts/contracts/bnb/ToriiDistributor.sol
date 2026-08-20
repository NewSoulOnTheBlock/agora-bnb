// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRewardSink {
    function notifyReward() external payable;
    function totalSupply() external view returns (uint256);
}

/**
 * @title ToriiDistributor
 * @notice Forwards earmarked income to stTORII. The BNB Chain deployment's
 *         replacement for `Distributor`.
 *
 * ## What changed, and what fell out of it
 *
 * The Robinhood Chain `Distributor` split income between two sinks — stTORII and
 * staked Suits — with a governable `suitsBps` and a reroute path for whichever
 * sink happened to have no stakers. None of that survives here: the Suits
 * ERC-721 is a Robinhood Chain collection with no BNB deployment, so there is no
 * second sink to split toward.
 *
 * Removing it removed more than one destination. Gone with it:
 *
 *   - `suitsBps` and `setSuitsBps`, and therefore `Ownable` — with a single
 *     fixed destination there is no split left to govern, so this contract has
 *     **no privileged caller of any kind**. That is a straightforward security
 *     improvement over the two-sink version, which needed an owner purely to
 *     move a ratio.
 *   - the reroute logic, which existed only to avoid stranding value in a sink
 *     that could not account for it.
 *
 * ## What deliberately did not change
 *
 * The `NoStakers` guard stays. If stTORII has no stakers, `notifyReward` cannot
 * account for the ETH, and accepting it anyway would create a claim nobody can
 * exercise. Reverting leaves the income earmarked in the Treasury — recoverable,
 * and distributable the moment somebody stakes — rather than stranded here or
 * quietly reclassified as corpus.
 */
contract ToriiDistributor is ReentrancyGuard {
    /// @notice The single, immutable destination for all distributed income.
    IRewardSink public immutable stakedAgora;

    uint256 public cumulativeToAgora;

    event Distributed(uint256 amount);

    error NothingToDistribute();
    error NoStakers();
    error ZeroAddress();

    constructor(address stakedTorii_) {
        if (stakedTorii_ == address(0)) revert ZeroAddress();
        stakedAgora = IRewardSink(stakedTorii_);
    }

    /**
     * @notice Forward the attached BNB to stTORII. Permissionless.
     * @dev The destination is fixed at construction and no argument names one,
     *      so an open caller can only push value along the one path it was
     *      always going to take.
     */
    function distribute() external payable nonReentrant {
        uint256 total = msg.value;
        if (total == 0) revert NothingToDistribute();
        if (stakedAgora.totalSupply() == 0) revert NoStakers();

        cumulativeToAgora += total;
        stakedAgora.notifyReward{value: total}();

        emit Distributed(total);
    }

    /**
     * @notice How `amount` would be routed right now.
     * @dev Retained so the Treasury-side tooling keeps a uniform shape across
     *      chains. With one sink the answer is always "all of it", but a caller
     *      should not have to special-case which chain it is talking to.
     */
    function preview(uint256 amount) external pure returns (uint256 toTorii) {
        return amount;
    }

    /// @dev Plain transfers are accepted but do nothing until `flush()`.
    receive() external payable {}

    /// @notice Push any idle balance through to stTORII. Permissionless.
    function flush() external returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) revert NothingToDistribute();
        // Re-enter through the payable path so one rule governs both entries.
        (bool ok, ) = address(this).call{value: amount}(
            abi.encodeWithSelector(this.distribute.selector)
        );
        if (!ok) revert NoStakers();
    }
}
