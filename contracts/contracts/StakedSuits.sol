// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/**
 * @title StakedSuits
 * @notice Custodial staking for the Suits ERC-721 collection. Staked Suits earn
 *         a fixed slice of protocol yield (10% by default, set on the
 *         `Distributor`), paid in ETH and claimed pull-wise.
 *
 * Suits: `0x3ac7beb099c560f5a09bd822621327d8768f0625` on chain 4663 — a SeaDrop
 * ERC-721 clone, fully minted at **1111/1111**, fixed supply.
 *
 * ## One NFT, one share
 *
 * Every staked Suit earns identically. There is no rarity weighting, no lockup
 * multiplier and no time weighting — with a fixed 1111-piece collection those
 * would add governance surface and gas for no economic gain, and each of them is
 * a place for accounting to drift. `accRewardPerNft` is a single accumulator.
 *
 * ## Why custody rather than a balance snapshot
 *
 * The collection is **not** `ERC721Enumerable` — there is no `tokenOfOwnerByIndex`,
 * so a contract cannot enumerate what an address holds. The alternatives were:
 *
 *   - Pay on `ownerOf` at claim time. That pays *holders*, not *stakers*, which
 *     is not what was asked, and it lets one NFT be walked between wallets to
 *     claim repeatedly unless every claim is checkpointed anyway.
 *   - Have users declare their token IDs without custody. Then nothing stops a
 *     Suit being sold while still counted.
 *
 * Custody is the only option that makes "staked" mean something, so tokens move
 * into this contract and only the original staker can take them back.
 *
 * ## The transfer-validator risk — read this before deploying
 *
 * Suits has a Limit Break creator-token transfer validator set at
 * `0xA000027A9B2802E1ddf7000061001e5c005A0000`. Today its policy permits
 * `transferFrom` to a contract, which is what staking needs, and that was
 * verified by simulation against a live holder.
 *
 * But the **collection owner can change that policy at any time** via
 * `setTransferValidator`, and a stricter policy could block transfers out of
 * this contract — stranding staked NFTs. Nothing here can prevent that; the
 * collection is not ours. Two things reduce the blast radius:
 *
 *   1. `unstake` uses plain `transferFrom`, not `safeTransferFrom`, so it does
 *      not additionally depend on the receiver hook.
 *   2. Rewards are tracked independently of custody, so even if an NFT were
 *      stuck, its accrued ETH remains claimable via `claim()`.
 *
 * Anyone staking should understand they are trusting the Suits owner not to
 * tighten transfer policy. That is a property of the collection, not a bug here.
 */
contract StakedSuits is Ownable, ReentrancyGuard, IERC721Receiver {
    /// @dev Matches StakedTorii. Staked counts are tiny (≤1111) and rewards are
    ///      wei, so a smaller scalar would truncate small distributions to zero.
    uint256 private constant ACC_PRECISION = 1e30;

    IERC721 public immutable suits;

    /// @notice Cumulative ETH per staked NFT, scaled by ACC_PRECISION.
    uint256 public accRewardPerNft;

    /// @notice How many Suits are staked right now.
    uint256 public totalStaked;

    uint256 public cumulativeRewards;
    uint256 public cumulativeClaimed;

    /// @notice tokenId => who staked it. Only they can withdraw it.
    mapping(uint256 => address) public stakerOf;

    /// @notice How many Suits each account has staked.
    mapping(address => uint256) public stakedCount;

    mapping(address => uint256) private _rewardDebt;
    mapping(address => uint256) private _accrued;

    event Staked(address indexed account, uint256 indexed tokenId);
    event Unstaked(address indexed account, uint256 indexed tokenId);
    event RewardNotified(uint256 amount, uint256 accRewardPerNft);
    event Claimed(address indexed account, uint256 amount);

    error NoStakers();
    error NothingToNotify();
    error NothingToClaim();
    error NotStaker(uint256 tokenId);
    error EmptyTokenIds();
    error EthTransferFailed();

    constructor(address suits_, address owner_) Ownable(owner_) {
        suits = IERC721(suits_);
    }

    // -----------------------------------------------------------------------
    // Staking
    // -----------------------------------------------------------------------

    function stake(uint256[] calldata tokenIds) external nonReentrant {
        if (tokenIds.length == 0) revert EmptyTokenIds();
        _settle(msg.sender);

        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 id = tokenIds[i];
            // transferFrom (not safe) — the sender is an EOA or a contract that
            // already holds the token, and we are the receiver, so the hook adds
            // nothing but a dependency on validator policy.
            suits.transferFrom(msg.sender, address(this), id);
            stakerOf[id] = msg.sender;
            emit Staked(msg.sender, id);
        }

        stakedCount[msg.sender] += tokenIds.length;
        totalStaked += tokenIds.length;
        _syncDebt(msg.sender);
    }

    function unstake(uint256[] calldata tokenIds) external nonReentrant {
        if (tokenIds.length == 0) revert EmptyTokenIds();
        _settle(msg.sender);

        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 id = tokenIds[i];
            if (stakerOf[id] != msg.sender) revert NotStaker(id);
            delete stakerOf[id];
            suits.transferFrom(address(this), msg.sender, id);
            emit Unstaked(msg.sender, id);
        }

        stakedCount[msg.sender] -= tokenIds.length;
        totalStaked -= tokenIds.length;
        _syncDebt(msg.sender);
    }

    /// @dev Accept `safeTransferFrom` deposits too, but they are NOT credited —
    ///      crediting here would let a raw transfer bypass `stake`'s accounting.
    ///      Kept only so a stray safe transfer does not revert into a loss.
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    // -----------------------------------------------------------------------
    // Rewards
    // -----------------------------------------------------------------------

    /**
     * @notice Deliver ETH to staked Suits. Permissionless.
     * @dev Reverts when nothing is staked rather than swallowing the ETH — the
     *      Distributor relies on that revert to reroute the slice to TORII
     *      stakers instead of stranding it here.
     */
    function notifyReward() external payable {
        if (msg.value == 0) revert NothingToNotify();
        if (totalStaked == 0) revert NoStakers();

        accRewardPerNft += (msg.value * ACC_PRECISION) / totalStaked;
        cumulativeRewards += msg.value;
        emit RewardNotified(msg.value, accRewardPerNft);
    }

    receive() external payable {}

    function pendingYield(address account) public view returns (uint256) {
        return
            _accrued[account] +
            ((stakedCount[account] * accRewardPerNft) / ACC_PRECISION) -
            _rewardDebt[account];
    }

    function claim() external nonReentrant returns (uint256 amount) {
        _settle(msg.sender);

        amount = _accrued[msg.sender];
        if (amount == 0) revert NothingToClaim();
        _accrued[msg.sender] = 0;
        cumulativeClaimed += amount;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert EthTransferFailed();

        emit Claimed(msg.sender, amount);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice Total Suits in the collection that are currently staked.
    function stakedOf(address account) external view returns (uint256) {
        return stakedCount[account];
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    function _settle(address account) internal {
        _accrued[account] = pendingYield(account);
        _syncDebt(account);
    }

    function _syncDebt(address account) internal {
        _rewardDebt[account] = (stakedCount[account] * accRewardPerNft) / ACC_PRECISION;
    }
}
