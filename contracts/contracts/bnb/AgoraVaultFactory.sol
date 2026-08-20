// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VaultFactoryBaseV2} from "../flap/VaultFactoryBaseV2.sol";
import {IVaultFactoryValidationV2} from "../flap/IVaultFactory.sol";
import {VaultDataSchema, FieldDescriptor} from "../flap/IVaultSchemasV1.sol";
import {AgoraVault} from "./AgoraVault.sol";

/**
 * @title AgoraVaultFactory
 * @notice Deploys the AGORA reserve vault when AGORA is launched on Flap.
 *
 * ## Why the launch guard matters more than the deploy
 *
 * The v1 launch on Robinhood Chain failed for a reason that had nothing to do
 * with the contracts being wrong: the *launch parameters* were wrong, and by the
 * time that was visible the mistake was irreversible. The v2 relaunch fixed it
 * by making the correct wiring structural — the fee recipient was baked into the
 * launch call, so there was no later step left to get wrong.
 *
 * `_validateBeforeLaunch` is the same idea applied to BNB. Flap calls it before
 * creating the token, and a `false` return aborts the launch. So rather than
 * trusting whoever fills in the launch form, this factory refuses to let AGORA
 * be created with economics that would quietly break the reserve:
 *
 *   - **Tax must be 5% on both sides.** Flap permits 1/3/5/10%; AGORA's design
 *     assumes one rate and the Treasury's accounting is built around it.
 *   - **All of the tax must route to the vault.** `vaultBps` below 100% diverts
 *     part of every trade to dividends, deflation or LP — value that never
 *     reaches the Treasury and therefore never backs the redemption floor.
 *   - **Quote must be native BNB**, matching `AgoraVault.vaultQuoteToken()`.
 *     Misdeclaring this strands tax revenue in a vault that ignores it.
 *
 * A launch that violates any of these fails loudly at creation time instead of
 * producing a token that looks right and underfunds the reserve forever.
 */
contract AgoraVaultFactory is VaultFactoryBaseV2 {
    /**
     * @notice AGORA's tax rate. 5% — the nearest rate Flap offers to the 4% used
     *         on Robinhood Chain, which is not selectable here (Flap allows 1%,
     *         3%, 5% or 10% only).
     *
     * @dev Unit is **basis points**, confirmed against Flap's own documentation
     *      rather than inferred from the field name: `TokenStateV8` documents
     *      `buyTaxRate` / `sellTaxRate` as "in basis points", and Flap's launch
     *      example passes `buyTaxRate: 300` for a 3% buy tax. So 5% is 500.
     *
     *      Both sides are checked because Flap permits asymmetric rates — its
     *      own example launches 3% buy against 10% sell. AGORA is symmetric by
     *      design and the Treasury's accounting assumes a single rate, so a
     *      lopsided launch is rejected rather than quietly accommodated.
     *
     *      Do not "fix" a rejected launch by deleting this check: it is what
     *      stops a mis-typed rate from silently underfunding the reserve.
     *
     *      Note the rate is not the whole cost to a trader — Flap adds its own
     *      1% platform fee on top, so 5% here means roughly 6% round-trip.
     */
    uint16 public constant REQUIRED_TAX_BPS = 500;

    /// @notice The whole tax must reach the vault; nothing may be diverted.
    uint16 public constant REQUIRED_VAULT_BPS = 10_000;

    /// @notice AGORA Treasury — the immutable destination of every vault.
    address public immutable treasury;

    /// @notice PancakeSwap V2 router the vaults use to sell the token tax leg.
    address public immutable router;

    event VaultCreated(
        address indexed vault, address indexed taxToken, address indexed creator, address quoteToken
    );

    constructor(address treasury_, address router_) {
        require(treasury_ != address(0), "AgoraVaultFactory: zero treasury");
        require(router_ != address(0), "AgoraVaultFactory: zero router");
        treasury = treasury_;
        router = router_;
    }

    /**
     * @notice Deploy a vault for a newly launched AGORA token.
     * @dev Only the VaultPortal may call this. Without that guard anyone could
     *      mint vaults that look official and point somewhere else.
     *
     *      `vaultData` is unused: the Treasury and router are fixed at factory
     *      construction rather than supplied per launch, so no launch-time input
     *      can redirect where the tax ends up.
     */
    function newVault(address taxToken, address quoteToken, address creator, bytes calldata vaultData)
        external
        override
        returns (address vault)
    {
        require(msg.sender == _getVaultPortal(), "AgoraVaultFactory: not vault portal");
        require(taxToken != address(0), "AgoraVaultFactory: zero tax token");
        require(quoteToken == address(0), "AgoraVaultFactory: quote must be native");
        vaultData;

        vault = address(new AgoraVault(treasury, taxToken, quoteToken, router));
        emit VaultCreated(vault, taxToken, creator, quoteToken);
    }

    /// @notice Native BNB only — this must agree with `AgoraVault`, because the
    ///         VaultPortal rejects launches whose quote the factory refuses.
    function isQuoteTokenSupported(address quoteToken) external pure override returns (bool supported) {
        return quoteToken == address(0);
    }

    /// @dev Enforced before the token exists, so a bad launch cannot happen at all.
    function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
        internal
        pure
        override
        returns (bool success, string memory reason)
    {
        if (data.quoteToken != address(0)) {
            return (false, "AGORA must launch with native BNB as the quote token");
        }
        if (data.buyTaxRate != REQUIRED_TAX_BPS || data.sellTaxRate != REQUIRED_TAX_BPS) {
            return (false, "AGORA requires a 5% tax on both buys and sells");
        }
        if (data.vaultBps != REQUIRED_VAULT_BPS) {
            return (false, "AGORA requires 100% of the tax to route to the reserve vault");
        }
        return (true, "");
    }

    /// @notice "v2.3" opts this factory into the V3 validation flow, which is
    ///         required for `vaultQuoteToken()` to be cross-checked at launch.
    function factorySpecVersion() public pure override returns (string memory) {
        return "v2.3";
    }

    /// @dev The factory takes no launch-time configuration, so the schema is
    ///      empty by design — see `newVault`.
    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description =
            "No configuration. The AGORA Treasury and the PancakeSwap router are fixed when "
            "the factory is deployed, so no launch-time input can redirect the tax.";
        schema.fields = new FieldDescriptor[](0);
        schema.isArray = false;
    }
}
