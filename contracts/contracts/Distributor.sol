// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRewardSink {
    function notifyReward() external payable;
    function totalSupply() external view returns (uint256);
}

interface INftRewardSink {
    function notifyReward() external payable;
    function totalStaked() external view returns (uint256);
}

/**
 * @title Distributor
 * @notice Splits protocol yield between staked Suits NFT holders and stAGORA
 *         stakers. Default split: **10% Suits / 90% AGORA**.
 *
 * ## Why this contract exists after being folded away
 *
 * `StakedAgora` originally absorbed the Distributor from spec §3.1, on the
 * grounds that with a single ETH-denominated sink a router would only forward
 * value and re-derive accounting the vault already kept. That reasoning held
 * exactly as long as there was one sink. There are now two, and a split has to
 * live somewhere that both can be reasoned about — so it comes back.
 *
 * ## Empty-sink rerouting
 *
 * Either side can legitimately have nobody staked, especially early. Neither
 * vault will accept ETH it cannot account for — both revert with `NoStakers` —
 * so this contract checks first and sends the whole amount to whichever side has
 * stakers.
 *
 * That is deliberate: the alternative is holding an undistributable balance
 * here, which quietly accrues an obligation nobody can claim and which no
 * accounting elsewhere can see. If **neither** side has stakers the call reverts
 * and the caller keeps its ETH to retry later, rather than parking value in a
 * contract with no owner-withdrawal path.
 *
 * ## Trust
 *
 * Both destinations are `immutable`. The owner can change only the split, and
 * only within a hard cap. There is no withdrawal function and no arbitrary call:
 * ETH that enters can only leave toward the two staking contracts.
 */
contract Distributor is Ownable, ReentrancyGuard {
    uint256 public constant BPS = 10_000;

    /// @notice Hard ceiling on the NFT slice, so governance cannot redirect the
    ///         whole income stream away from AGORA stakers.
    uint16 public constant MAX_SUITS_BPS = 3_000; // 30%

    /// @notice stAGORA vault.
    IRewardSink public immutable stakedAgora;

    /// @notice Staked Suits NFT vault.
    INftRewardSink public immutable stakedSuits;

    /// @notice Share of yield routed to staked Suits, in bps. Default 10%.
    uint16 public suitsBps = 1_000;

    uint256 public cumulativeToSuits;
    uint256 public cumulativeToAgora;

    event Distributed(uint256 total, uint256 toSuits, uint256 toAgora);
    event SuitsBpsSet(uint16 previous, uint16 current);
    event ReroutedToAgora(uint256 amount);
    event ReroutedToSuits(uint256 amount);

    error NothingToDistribute();
    error NoStakersAnywhere();
    error SuitsBpsTooHigh(uint16 requested, uint16 max);
    error ZeroAddress();

    constructor(address stakedAgora_, address stakedSuits_, address owner_) Ownable(owner_) {
        if (stakedAgora_ == address(0) || stakedSuits_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        stakedAgora = IRewardSink(stakedAgora_);
        stakedSuits = INftRewardSink(stakedSuits_);
    }

    /**
     * @notice Split and forward the attached ETH. Permissionless.
     * @dev Both destinations are fixed at construction, so an open caller can
     *      only push value along the one path it was always going to take.
     */
    function distribute() external payable nonReentrant {
        uint256 total = msg.value;
        if (total == 0) revert NothingToDistribute();

        bool suitsHasStakers = stakedSuits.totalStaked() != 0;
        bool agoraHasStakers = stakedAgora.totalSupply() != 0;

        if (!suitsHasStakers && !agoraHasStakers) revert NoStakersAnywhere();

        uint256 toSuits = (total * suitsBps) / BPS;
        uint256 toAgora = total - toSuits;

        // Reroute rather than strand. A sink with no stakers cannot account for
        // the ETH, and holding it here would create a claim nobody can exercise.
        if (!suitsHasStakers && toSuits != 0) {
            emit ReroutedToAgora(toSuits);
            toAgora += toSuits;
            toSuits = 0;
        }
        if (!agoraHasStakers && toAgora != 0) {
            emit ReroutedToSuits(toAgora);
            toSuits += toAgora;
            toAgora = 0;
        }

        if (toSuits != 0) {
            cumulativeToSuits += toSuits;
            stakedSuits.notifyReward{value: toSuits}();
        }
        if (toAgora != 0) {
            cumulativeToAgora += toAgora;
            stakedAgora.notifyReward{value: toAgora}();
        }

        emit Distributed(total, toSuits, toAgora);
    }

    /// @notice How `amount` would split right now, after any rerouting.
    function preview(uint256 amount) external view returns (uint256 toSuits, uint256 toAgora) {
        bool suitsHasStakers = stakedSuits.totalStaked() != 0;
        bool agoraHasStakers = stakedAgora.totalSupply() != 0;

        toSuits = (amount * suitsBps) / BPS;
        toAgora = amount - toSuits;

        if (!suitsHasStakers) {
            toAgora += toSuits;
            toSuits = 0;
        }
        if (!agoraHasStakers) {
            toSuits += toAgora;
            toAgora = 0;
        }
    }

    function setSuitsBps(uint16 bps) external onlyOwner {
        if (bps > MAX_SUITS_BPS) revert SuitsBpsTooHigh(bps, MAX_SUITS_BPS);
        emit SuitsBpsSet(suitsBps, bps);
        suitsBps = bps;
    }

    /// @dev Plain transfers are accepted but do nothing until `distribute()`.
    receive() external payable {}

    /// @notice Push any idle balance through the split. Permissionless.
    function flush() external returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) revert NothingToDistribute();
        // Re-enter through the payable path so one split rule governs both.
        (bool ok, ) = address(this).call{value: amount}(
            abi.encodeWithSelector(this.distribute.selector)
        );
        if (!ok) revert NoStakersAnywhere();
    }
}
