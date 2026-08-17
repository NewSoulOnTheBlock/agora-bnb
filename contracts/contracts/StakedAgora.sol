// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IGate {
    function check(address account) external view returns (bool);
}

/**
 * @title StakedAgora (stAGORA)
 * @notice ERC-4626 vault over AGORA. Stakers receive the protocol's income
 *         stream; passive holders keep the redemption floor (spec §9).
 *
 * ## Why staking rather than per-holder reflection
 *
 * Eligible supply for income is simply `totalSupply()` of this vault. That is
 * the entire reason the design stakes instead of reflecting: no transfer-hook
 * checkpoints on AGORA (which has no hooks at all and cannot gain any), no
 * exclusion set to get wrong, no rebasing, and nothing downstream broken by a
 * balance that changes without a Transfer event.
 *
 * ## Rewards are ETH, not more AGORA
 *
 * The corpus is ETH-denominated, so income arrives as ETH. That means share
 * price does **not** grow: `totalAssets()` is just the AGORA held here, so
 * shares stay ~1:1 with deposits. Yield is tracked separately in a MasterChef-
 * style accumulator and claimed pull-wise.
 *
 * Keeping rewards out of `totalAssets()` is deliberate. If ETH income inflated
 * the share price, `convertToAssets` would report AGORA that the vault does not
 * hold, and every 4626 integrator downstream would be misled.
 *
 * ## Why the Distributor was folded in
 *
 * Spec §3.1 lists a separate `Distributor`. With native-ETH income there is
 * nothing for it to do but forward value and re-derive per-share accounting
 * this contract already maintains, so it would add an address to wire, a hop to
 * fund, and a failure point — for no benefit. `notifyReward()` takes ETH
 * directly. If income ever becomes multi-asset, split it back out.
 *
 * ## Share transfers settle rewards first
 *
 * stAGORA is itself an ERC-20. `_update` settles both parties' accrued rewards
 * before any balance moves, so buying shares never buys someone else's unclaimed
 * yield, and selling them never forfeits your own.
 */
contract StakedAgora is ERC4626, Ownable, ReentrancyGuard {
    /// @dev High precision: share supply can reach ~1e27 while a reward may be
    ///      a fraction of an ETH, and a smaller scalar would truncate to zero.
    uint256 private constant ACC_PRECISION = 1e30;

    /// @notice Cumulative ETH per share, scaled by ACC_PRECISION.
    uint256 public accRewardPerShare;

    /// @notice Total ETH ever delivered to stakers.
    uint256 public cumulativeRewards;

    /// @notice Total ETH claimed so far.
    uint256 public cumulativeClaimed;

    mapping(address => uint256) private _rewardDebt;
    mapping(address => uint256) private _accrued;

    /**
     * @notice Optional eligibility gate. Zero address = open to everyone.
     * @dev Spec §11 puts any allowlist or geofence HERE and on the Redeemer —
     *      never on AGORA itself, which has no transfer hooks and must stay a
     *      plain composable ERC-20. Pluggable so no policy is baked in now.
     */
    IGate public gate;

    event RewardNotified(uint256 amount, uint256 accRewardPerShare);
    event Claimed(address indexed account, uint256 amount);
    event GateSet(address indexed gate);

    error NoStakers();
    error NothingToClaim();
    error NothingToNotify();
    error EthTransferFailed();
    error NotAllowed(address account);

    constructor(IERC20 agora_, address owner_)
        ERC20(
            string.concat("Staked ", IERC20Metadata(address(agora_)).name()),
            string.concat("st", IERC20Metadata(address(agora_)).symbol())
        )
        ERC4626(agora_)
        Ownable(owner_)
    {}

    /// @dev Virtual-share offset against the classic 4626 first-depositor
    ///      donation attack. Cheap here because share price never legitimately
    ///      moves — rewards live outside `totalAssets()`.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    // -----------------------------------------------------------------------
    // Rewards
    // -----------------------------------------------------------------------

    /**
     * @notice Deliver ETH income to stakers. Permissionless.
     * @dev Reverts when nobody is staked rather than silently swallowing the
     *      ETH — the caller keeps its funds and can retry once there are shares.
     */
    function notifyReward() external payable {
        if (msg.value == 0) revert NothingToNotify();
        uint256 supply = totalSupply();
        if (supply == 0) revert NoStakers();

        accRewardPerShare += (msg.value * ACC_PRECISION) / supply;
        cumulativeRewards += msg.value;

        emit RewardNotified(msg.value, accRewardPerShare);
    }

    /// @dev Accept plain transfers, but they only count once notified.
    receive() external payable {}

    /// @notice ETH currently claimable by `account`.
    function pendingYield(address account) public view returns (uint256) {
        return
            _accrued[account] +
            ((balanceOf(account) * accRewardPerShare) / ACC_PRECISION) -
            _rewardDebt[account];
    }

    /// @notice Claim accrued ETH. Pull-based, so no loop can be griefed.
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
    // Gate
    // -----------------------------------------------------------------------

    function setGate(address gate_) external onlyOwner {
        gate = IGate(gate_);
        emit GateSet(gate_);
    }

    function _requireAllowed(address account) internal view {
        if (address(gate) != address(0) && !gate.check(account)) revert NotAllowed(account);
    }

    // -----------------------------------------------------------------------
    // ERC-4626 / ERC-20 plumbing
    // -----------------------------------------------------------------------

    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        _requireAllowed(receiver);
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override returns (uint256) {
        _requireAllowed(receiver);
        return super.mint(shares, receiver);
    }

    /**
     * @dev Settle rewards for both sides before any balance change, so accrual
     *      always reflects the balance actually held over the period.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) _settle(from);
        if (to != address(0)) _settle(to);

        super._update(from, to, value);

        if (from != address(0)) _syncDebt(from);
        if (to != address(0)) _syncDebt(to);
    }

    function _settle(address account) internal {
        _accrued[account] = pendingYield(account);
        _syncDebt(account);
    }

    function _syncDebt(address account) internal {
        _rewardDebt[account] = (balanceOf(account) * accRewardPerShare) / ACC_PRECISION;
    }
}
