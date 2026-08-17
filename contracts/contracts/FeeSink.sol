// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ITreasuryFund {
    function fund() external payable;
}

/**
 * @title FeeSink
 * @notice The address registered as AGORA's creator-fee recipient. It exists to
 *         be *boring*, and that is the entire design (spec §5).
 *
 * ## Why this contract has no logic
 *
 * The Pons fee path may pay out with a bare `transfer()`, which forwards only a
 * **2300-gas stipend**. Any `receive()` that writes storage (~20k gas for a cold
 * SSTORE), swaps, or routes would **revert** — losing the fee, or worse, bricking
 * the swap that triggered it. So the hot path here is an empty `receive()`:
 * no storage writes, no events, no external calls.
 *
 * `treasury` is `immutable`, so reading it costs no SLOAD — it is baked into the
 * contract's code. That keeps even `sweep()` cheap and, more importantly, makes
 * the destination impossible to change after deployment. There is no owner and
 * no setter: this contract cannot be repointed at an attacker's address, so it
 * needs no trust at all.
 *
 * ## Why `sweep()` is permissionless
 *
 * `sweep()` can only move ETH along its single hard-coded path into
 * `Treasury.fund()`. There is no destination to choose and no value to extract,
 * so gating it would only add a liveness dependency on a keeper. Anyone may
 * call it; ETH simply accrues here safely in the meantime (spec §10, "keeper
 * liveness — Low").
 *
 * ## What this contract does NOT do
 *
 * It does not claim from Pons. Pons fees are **pull-based** via
 * `V2FeeEscrow.claim()`, which pays `msg.sender`, and the sweep that moves fees
 * into escrow is gated on Pons's own `feeSweepOperator` (spec §14.4). So the
 * order of operations is: Pons's operator sweeps the pool → someone calls
 * `V2FeeEscrow.claim()` as this address → ETH lands here → `sweep()` → Treasury.
 * Step one is not ours to trigger.
 */
contract FeeSink {
    /// @notice Immutable destination. No setter exists, by design.
    ITreasuryFund public immutable treasury;

    event Swept(uint256 amount);

    error ZeroTreasury();
    error NothingToSweep();

    constructor(address treasury_) {
        if (treasury_ == address(0)) revert ZeroTreasury();
        treasury = ITreasuryFund(treasury_);
    }

    /// @notice The entire hot path. Must stay empty to survive a 2300-gas stipend.
    receive() external payable {}

    /// @dev Also accept payouts that arrive with unexpected calldata attached.
    fallback() external payable {}

    /// @notice Forward the full balance to the Treasury. Callable by anyone.
    function sweep() external returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) revert NothingToSweep();
        treasury.fund{value: amount}();
        emit Swept(amount);
    }
}
