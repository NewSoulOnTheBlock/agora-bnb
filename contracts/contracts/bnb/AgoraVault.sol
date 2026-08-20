// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {VaultBaseV3} from "../flap/VaultBaseV3.sol";
import {
    VaultUISchema,
    VaultMethodSchema,
    FieldDescriptor,
    ApproveAction
} from "../flap/IVaultSchemasV1.sol";

interface ITreasuryFund {
    function fund() external payable;
}

/// @dev PancakeSwap V2 router. The fee-on-transfer variant is mandatory here:
///      AGORA is a *tax* token, so the amount that lands in the pair is smaller
///      than the amount sent, and the plain `swapExactTokensForETH` reverts with
///      `K` on exactly that mismatch.
interface IPancakeRouter02 {
    function WETH() external pure returns (address);

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/**
 * @title AgoraVault
 * @notice AGORA's Flap tax vault on BNB Chain — the contract Flap pays the 5%
 *         trade tax into, and the only route by which that tax reaches the
 *         Treasury.
 *
 * ## What this replaces, and why it is not a port
 *
 * On Robinhood Chain the equivalent contract is `FeeSink`, which had to *pull*
 * fees: Pons accrued creator tax inside its hook, a Pons-controlled keeper swept
 * it into an escrow, and only then could the sink call `claim()`. That keeper is
 * not ours, so collection could stall — and did, with tax sitting unreachable in
 * `pendingCreatorTax` until Pons chose to sweep.
 *
 * Flap pushes instead. Tax is transferred to this vault and our `receive()` is
 * invoked directly. There is no escrow, no `claim()`, and no third-party keeper
 * in the path. Every pull-side function of `FeeSink` — `claimFromEscrow`,
 * `sweepCurve`, `collect` — has no counterpart here because it has no purpose.
 *
 * ## The 2300-gas rule inverts on this chain
 *
 * `FeeSink.receive()` is deliberately empty, because Pons could forward only a
 * 2300-gas stipend and any storage write would revert. **That reasoning does not
 * apply to Flap** and must not be carried over: Flap forwards the dispatcher's
 * remaining gas, and the V3 spec *requires* `receive()` to advance the accounting
 * baseline — a storage write. The budget here is 1,000,000 gas (Flap rule 005),
 * not 2300.
 *
 * What the two rules share is the conclusion that heavy work stays out of the
 * hot path. `receive()` here does accounting and an event, nothing else: no
 * external calls, no loops, no swap. The swap lives in `convertAndForward`,
 * which anyone may call. A heavy `receive()` would make Flap's keeper fail to
 * dispatch AGORA at all.
 *
 * ## Quote is BNB; tax arrives in two different assets
 *
 * The vault's quote token is native BNB, so `accountedQuote` tracks **BNB only**.
 * That matters because Flap changes what it pays in:
 *
 *   - during the bonding curve, tax is taken in the quote token — BNB, which
 *     lands in `receive()` and is recognised immediately;
 *   - after DEX migration, tax is taken **in AGORA itself**.
 *
 * AGORA is therefore not quote revenue and is deliberately excluded from the
 * baseline. Treating it as revenue would be worse than useless: the Treasury
 * marks AGORA at zero when computing NAV, so forwarding the token leg raw would
 * grow the balance sheet by nothing while the tax kept being collected. The
 * post-graduation leg has to be sold for BNB first, which is what
 * `convertAndForward` exists to do.
 *
 * ## Trust model
 *
 * `treasury` is immutable and no function takes a destination argument, so BNB
 * can only ever reach the Treasury — the same property `FeeSink` had, and the
 * reason the collectors are safe to leave open to anyone.
 *
 * The one exception is Flap's mandated emergency pair (rule 009), which lets
 * Flap's Guardian drain the vault to an address of its choosing. That is a real
 * change in trust model versus `FeeSink`, which had no privileged caller at all
 * after renouncing. It is mitigated by design rather than by trust: this vault
 * is a pass-through, so anyone can forward the balance to the Treasury at any
 * time, and the Guardian's exposure is only ever the revenue that has arrived
 * since the last forward.
 *
 * Per Flap rule 004 every revert here is a `require` with a literal string, not
 * a custom error. That is the opposite of the house style in the neighbouring
 * contracts and is intentional — Flap's UI reads these strings.
 */
contract AgoraVault is VaultBaseV3, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Immutable destination for every BNB this contract forwards.
    ITreasuryFund public immutable treasury;

    /// @notice AGORA. Named `taxToken` because Flap's UI resolves the
    ///         `"taxToken"` approval type by calling this getter.
    IERC20 public immutable taxToken;

    /// @notice PancakeSwap V2 router used to sell the post-graduation token leg.
    IPancakeRouter02 public immutable router;

    /// @notice The revenue currency. `address(0)` — native BNB.
    address private immutable _quoteToken;

    /// @notice Recognised-and-not-yet-forwarded BNB revenue.
    /// @dev The V3 baseline. Every outflow MUST decrement this in the same
    ///      transaction or revenue recognition suppresses itself forever.
    uint256 public accountedQuote;

    /// @notice Cumulative BNB delivered to the Treasury.
    uint256 public cumulativeForwarded;

    /// @notice Cumulative AGORA sold for BNB.
    uint256 public cumulativeConverted;

    event RevenueRecognized(uint256 amount, uint256 baseline);
    event Forwarded(uint256 amount);
    event Converted(uint256 tokensIn, uint256 quoteOut);
    event EmergencyWithdrawNative(address indexed to, uint256 amount);
    event EmergencyWithdrawToken(address indexed token, address indexed to, uint256 amount);

    /// @dev The Guardian is the only privileged caller, and `_getGuardian()` is
    ///      hardcoded in VaultBase — there is no setter, so the mandate that the
    ///      Guardian's access cannot be revoked holds structurally.
    modifier onlyGuardian() {
        require(msg.sender == _getGuardian(), "AgoraVault: not guardian");
        _;
    }

    constructor(address treasury_, address taxToken_, address quoteToken_, address router_) {
        require(treasury_ != address(0), "AgoraVault: zero treasury");
        require(taxToken_ != address(0), "AgoraVault: zero tax token");
        require(router_ != address(0), "AgoraVault: zero router");
        // Native-only. `isQuoteTokenSupported` on the factory must agree with
        // this, because misdeclaring support strands the launch's tax revenue in
        // a vault that ignores it.
        require(quoteToken_ == address(0), "AgoraVault: quote must be native");

        treasury = ITreasuryFund(treasury_);
        taxToken = IERC20(taxToken_);
        router = IPancakeRouter02(router_);
        _quoteToken = quoteToken_;
    }

    // -----------------------------------------------------------------------
    // Hot path — accounting and an event, nothing more (Flap rule 005)
    // -----------------------------------------------------------------------

    receive() external payable {
        _syncRevenue();
    }

    /**
     * @dev Recognise revenue by delta, never by raw balance.
     *
     * The `<=` is load-bearing: Flap may ping a vault that has received nothing
     * — the same wallet can occupy several payout slots, and anyone may call
     * `receive()` — and a spurious wake must be a silent no-op rather than a
     * revert. Reverting here would make Flap's dispatch of AGORA fail.
     */
    function _syncRevenue() internal {
        uint256 bal = address(this).balance;
        if (bal <= accountedQuote) return;

        uint256 newRevenue = bal - accountedQuote;
        accountedQuote = bal;
        emit RevenueRecognized(newRevenue, bal);
    }

    /**
     * @notice Recognise any revenue that arrived without a wake call.
     * @dev The neutral recovery path: direct transfers and donations trigger no
     *      ping, so without this they would wait for the next dispatch.
     */
    function sync() external {
        _syncRevenue();
    }

    // -----------------------------------------------------------------------
    // Collectors — permissionless, single destination
    // -----------------------------------------------------------------------

    /**
     * @notice Forward all recognised BNB revenue to the Treasury.
     * @dev Permissionless: the destination is immutable, so an open caller can
     *      only push value along the one path it was always going to take.
     */
    function forwardQuote() external nonReentrant returns (uint256 amount) {
        amount = _forwardAll();
        require(amount > 0, "AgoraVault: nothing to forward");
    }

    /**
     * @notice Sell the AGORA tax leg for BNB and forward the proceeds.
     * @param amountIn     AGORA to sell; `0` means the entire balance.
     * @param minQuoteOut  Minimum BNB from the swap. Caller-supplied on purpose.
     * @param deadline     Unix timestamp after which the swap must not execute.
     *
     * @dev Why the caller sets the slippage bound: this function is
     *      permissionless, and a hardcoded or owner-set bound would either be
     *      wrong at some price or become a privileged lever over everyone else's
     *      execution. Requiring `minQuoteOut` from the caller keeps sandwich
     *      protection in the hands of whoever pays for the transaction, and
     *      leaves no parameter an insider could move against users.
     *
     *      The swap sends BNB to this contract, which re-enters `receive()` and
     *      advances the baseline — so the proceeds are recognised before they
     *      are forwarded, without any special-casing here.
     */
    function convertAndForward(uint256 amountIn, uint256 minQuoteOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 forwarded)
    {
        require(deadline >= block.timestamp, "AgoraVault: deadline passed");
        require(minQuoteOut > 0, "AgoraVault: minQuoteOut required");

        uint256 balance = taxToken.balanceOf(address(this));
        uint256 sellAmount = amountIn == 0 ? balance : amountIn;
        require(sellAmount > 0, "AgoraVault: no tokens to convert");
        require(sellAmount <= balance, "AgoraVault: amount exceeds balance");

        uint256 quoteBefore = address(this).balance;

        // forceApprove: AGORA may be a non-standard ERC20, and a stale non-zero
        // allowance would make a plain approve revert.
        taxToken.forceApprove(address(router), sellAmount);

        address[] memory path = new address[](2);
        path[0] = address(taxToken);
        path[1] = router.WETH();

        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            sellAmount, minQuoteOut, path, address(this), deadline
        );

        // Clear any residual allowance left by a fee-on-transfer partial spend.
        taxToken.forceApprove(address(router), 0);

        uint256 received = address(this).balance - quoteBefore;
        require(received >= minQuoteOut, "AgoraVault: insufficient output");

        cumulativeConverted += sellAmount;
        emit Converted(sellAmount, received);

        forwarded = _forwardAll();
        require(forwarded > 0, "AgoraVault: nothing to forward");
    }

    /// @dev Recognise first, then spend — and decrement the baseline in the same
    ///      transaction as the outflow, which is the rule whose breach deadlocks
    ///      a V3 vault permanently.
    function _forwardAll() internal returns (uint256 amount) {
        _syncRevenue();

        amount = accountedQuote;
        if (amount == 0) return 0;

        accountedQuote = 0;
        cumulativeForwarded += amount;

        treasury.fund{value: amount}();
        emit Forwarded(amount);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice BNB recognised and awaiting forwarding, including any unsynced.
    function pendingQuote() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice AGORA held and awaiting conversion — the post-graduation tax leg.
    function pendingTaxToken() external view returns (uint256) {
        return taxToken.balanceOf(address(this));
    }

    // -----------------------------------------------------------------------
    // Emergency controls — Flap rule 009, Guardian-only
    // -----------------------------------------------------------------------

    /**
     * @notice Guardian escape hatch for native currency.
     * @dev `accountedQuote` is reset because the balance it describes is gone.
     *      Leaving the baseline above the real balance would make
     *      `bal <= accountedQuote` true forever and suppress all future revenue
     *      recognition — the deadlock this vault is otherwise built to avoid.
     */
    function emergencyWithdrawNative(address to) external onlyGuardian nonReentrant {
        require(to != address(0), "Zero address");
        uint256 bal = address(this).balance;
        if (bal > 0) {
            accountedQuote = 0;
            (bool ok, ) = to.call{value: bal}("");
            require(ok, "Native transfer failed");
            emit EmergencyWithdrawNative(to, bal);
        }
    }

    /// @notice Guardian escape hatch for any stuck ERC-20, including AGORA.
    function emergencyWithdrawToken(address token, address to) external onlyGuardian nonReentrant {
        require(token != address(0) && to != address(0), "Zero address");
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            IERC20(token).safeTransfer(to, bal);
            emit EmergencyWithdrawToken(token, to, bal);
        }
    }

    // -----------------------------------------------------------------------
    // Flap discovery surface
    // -----------------------------------------------------------------------

    function vaultQuoteToken() public view override returns (address quoteToken) {
        return _quoteToken;
    }

    function description() public pure override returns (string memory) {
        return
            "AGORA reserve vault. The 5% trade tax is forwarded to the AGORA Treasury, "
            "where 70% backs a redemption floor that only ratchets upward and 30% is paid "
            "to stakers. The post-graduation token leg is sold for BNB first. Every "
            "destination is immutable and every collector is permissionless.";
    }

    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "AgoraReserveVault";
        schema.description =
            "Routes AGORA's trade tax into the AGORA Treasury. Anyone may call the "
            "collectors; funds can only ever reach the Treasury.";

        schema.methods = new VaultMethodSchema[](5);

        // 0 — pendingQuote()
        schema.methods[0].name = "pendingQuote";
        schema.methods[0].description = "BNB held by the vault, awaiting forwarding to the Treasury.";
        schema.methods[0].inputs = new FieldDescriptor[](0);
        schema.methods[0].outputs = new FieldDescriptor[](1);
        schema.methods[0].outputs[0] = FieldDescriptor("amount", "uint256", "BNB awaiting forwarding", 18);
        schema.methods[0].approvals = new ApproveAction[](0);
        schema.methods[0].isWriteMethod = false;

        // 1 — pendingTaxToken()
        schema.methods[1].name = "pendingTaxToken";
        schema.methods[1].description = "AGORA held by the vault, awaiting conversion to BNB.";
        schema.methods[1].inputs = new FieldDescriptor[](0);
        schema.methods[1].outputs = new FieldDescriptor[](1);
        schema.methods[1].outputs[0] = FieldDescriptor("amount", "uint256", "AGORA awaiting conversion", 18);
        schema.methods[1].approvals = new ApproveAction[](0);
        schema.methods[1].isWriteMethod = false;

        // 2 — cumulativeForwarded()
        schema.methods[2].name = "cumulativeForwarded";
        schema.methods[2].description = "Total BNB delivered to the Treasury since deployment.";
        schema.methods[2].inputs = new FieldDescriptor[](0);
        schema.methods[2].outputs = new FieldDescriptor[](1);
        schema.methods[2].outputs[0] = FieldDescriptor("amount", "uint256", "Cumulative BNB forwarded", 18);
        schema.methods[2].approvals = new ApproveAction[](0);
        schema.methods[2].isWriteMethod = false;

        // 3 — forwardQuote()
        schema.methods[3].name = "forwardQuote";
        schema.methods[3].description =
            "Forward all recognised BNB revenue to the AGORA Treasury. Anyone may call this.";
        schema.methods[3].inputs = new FieldDescriptor[](0);
        schema.methods[3].outputs = new FieldDescriptor[](1);
        schema.methods[3].outputs[0] = FieldDescriptor("amount", "uint256", "BNB forwarded", 18);
        schema.methods[3].approvals = new ApproveAction[](0);
        schema.methods[3].isWriteMethod = true;

        // 4 — convertAndForward(uint256,uint256,uint256)
        schema.methods[4].name = "convertAndForward";
        schema.methods[4].description =
            "Sell the AGORA tax leg for BNB on PancakeSwap and forward the proceeds to the "
            "Treasury. Set minQuoteOut to bound slippage. Anyone may call this.";
        schema.methods[4].inputs = new FieldDescriptor[](3);
        schema.methods[4].inputs[0] = FieldDescriptor("amountIn", "uint256", "AGORA to sell; 0 sells the full balance", 18);
        schema.methods[4].inputs[1] = FieldDescriptor("minQuoteOut", "uint256", "Minimum BNB to accept from the swap", 18);
        schema.methods[4].inputs[2] = FieldDescriptor("deadline", "time", "Timestamp after which the swap must not execute", 0);
        schema.methods[4].outputs = new FieldDescriptor[](1);
        schema.methods[4].outputs[0] = FieldDescriptor("forwarded", "uint256", "BNB forwarded to the Treasury", 18);
        // No approval: the vault sells tokens it already holds.
        schema.methods[4].approvals = new ApproveAction[](0);
        schema.methods[4].isWriteMethod = true;
    }
}
