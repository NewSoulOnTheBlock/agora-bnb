# TITHE — Tax-Funded Endowment Token with a Ratcheting Redemption Floor

> **Working name:** TITHE (ticker `TITH`) — placeholder, see §12.
> **Chain:** Robinhood Chain (EVM, Arbitrum Orbit L2) — mainnet chainId **4663**, testnet **46630**, gas in ETH.
> **Launch venue:** **Pons v2** — 4% creator tax, paid out in **ETH** via the shared `V2MemeHook`.
> All addresses and pool parameters are **verified on-chain** — see Appendix A (§14).
> **Yield venue:** **Beefy Finance** — confirmed live on chain 4663, but see §4 for a severe capacity limit.
> **Status:** design only, not built. Written 2026-08-17.
> **Related:** [`agora-equity-reserve-design.md`](./agora-equity-reserve-design.md) (Olympus hard-floor pattern,
> USDG numeraire, ERC-8056/Chainlink oracle discipline); `memebrokers-evm/` (Hardhat 2 + Solidity 0.8.24 + OZ).

---

## 1. Thesis

Every buy and sell of TITHE pays a **4% tax, configured in the Pons v2 pool and paid in ETH**. That ETH
forms a permanent **corpus**. Yield earned on the corpus is paid to holders who stake into `stTITH`.
Separately, any holder may **burn TITHE to redeem a pro-rata slice of the corpus at a 5% haircut**, giving
the token a hard, ratcheting price floor.

TITHE is not a reflection coin. It is **a Tobin tax that transfers value from fast flow to patient capital,
anchored by a floor that rises on every trade.**

**Two structural facts shape everything below:**

1. **Because Pons settles the creator fee in ETH, the token carries no tax logic at all.** TITHE is a
   plain ERC-20 — no transfer hooks, no pair registry, no exemption set, no fee-on-transfer
   incompatibility. **Verified** against `PonsV2LauncherToken` (§14.6): no owner, blacklist, pause, mint,
   maxWallet or tax functions exist.
   > **Correction (2026-08-17, from live log analysis).** An earlier draft claimed "no mechanism ever
   > sells the token to fund itself." That is **too strong.** `HookFeeCollected` fires for **both legs of
   > every swap** — native ETH *and* the memecoin (measured: 1,397 ETH-denominated events alongside
   > hundreds of token-denominated ones over 100k blocks). `sweepPoolFees(poolId,
   > minConversionQuoteOut, …)` then converts the memecoin leg to quote before crediting the creator.
   > So a token-side sell **does** happen — it is performed by Pons's sweep rather than by our vault, on
   > Pons's schedule and not ours. Still materially better than a transfer-tax design (smaller, batched,
   > and not our code), but the sell pressure is not zero and the design must not claim otherwise.
2. **The yield leg does not currently scale.** Beefy on Robinhood Chain holds **~$125k total TVL across 40
   vaults, every one of them a two-asset LP position, with zero single-asset or stablecoin vaults**
   (measured 2026-08-17, §4). The corpus will exceed the entire chain's Beefy capacity within days at any
   real volume. **The floor is therefore the product, and yield is a sleeve that grows as the chain does.**
   §2 always implied this; the Beefy data makes it binding.

---

## 2. Why the floor is the product

Tax revenue is `0.04 × volume` per swap. Pons additionally pays the creator **70% of a 1% pool fee**, so
total protocol take is ≈ **4.7% of volume**:

| Daily volume | Take/day @4.7% | Corpus @ 1yr | Corpus ÷ $10M cap | Yield/yr @ 5% | APY on cap |
|---|---|---|---|---|---|
| $100k | $4.7k | $1.7M | 17% | $86k | 0.9% |
| $500k | $23.5k | $8.6M | 86% | $429k | 4.3% |
| $2M | $94k | $34M | 343% | $1.7M | 17% |

1. **The endowment dominates the income.** Within a year the corpus is a large fraction of — plausibly a
   multiple of — market cap, while the yield stream stays low single digits on cap.
2. **Without redemption the corpus is stranded and the token trades below its own book value.** This is the
   terminal failure mode of every historical revenue-share tax token. Redemption converts a stranded pile
   into an enforceable floor.
3. **Compare column 2 to Beefy's $125k chain-wide TVL.** At $500k/day the corpus passes the entire
   available yield capacity of the chain in **under a week**. Sizing, not APY, is the design problem.

**Floor mechanics.** `floorPerToken = nav / eligibleSupply`. It ratchets because every taxed swap raises
the numerator, and every redemption removes `0.95 × pro-rata` from the numerator but a **full** pro-rata
share from the denominator — so the ratio *rises* for everyone who stays.

> **⚠ The invariant is numeraire-relative and LP-fragile.** `floorPerToken` is non-decreasing only in units
> of what the corpus holds, and only if those holdings can't lose value. An ETH corpus floors in ETH, not
> dollars. **An LP corpus doesn't floor at all** — impermanent loss can cut NAV with zero redemptions. This
> is why §4 caps LP exposure rather than treating Beefy as the corpus's home.

---

## 3. Architecture

```
   trader ⇄ Pons v2 pool ──── 4% tax + 70% of 1% pool fee, in ETH (hook-level) ───┐
                                                                                  ▼
                                                                           ┌─────────────┐
                                                                           │  FeeSink    │ payable,
                                                                           │  (dumb)     │ logic-free
                                                                           └──────┬──────┘
                                                              keeper: sweep()     │ ETH
                                                                                  ▼
                                                                           ┌─────────────┐
                                                     ETH → USDG core       │  Treasury   │ corpus
                                                                           └──┬───────┬──┘
                        ┌─── capped sleeve ──────────────────────────────────┘        │
                        ▼                                                             │
              ┌──────────────────┐   surplus-trim   ┌─────────────┐                    │
              │  BeefyAdapter[]  │ ───────────────► │ Distributor │                    │
              │  (LP, IL-exposed)│  (no harvest())  └──────┬──────┘                    │
              └──────────────────┘                         │              burn TITH →  │
                                                           ▼              pro-rata     ▼
                                                   ┌──────────────┐            ┌──────────┐
                                                   │  stTITH      │            │ Redeemer │
                                                   │  (ERC-4626)  │            └──────────┘
                                                   └──────────────┘             95% NAV, queued
                                                     claim() → USDG

   TitheToken: plain ERC-20, deployed by the Pons factory. Absent from this diagram because it does nothing.
```

### 3.1 Contract set

| Contract | Responsibility |
|---|---|
| `TitheToken` | **Not ours to write** — Pons factory deploys a fixed-supply ERC-20 (§8.1) |
| `FeeSink.sol` | Payable ETH receiver for the Pons payout. **Deliberately logic-free** (§5) |
| `Treasury.sol` | Sweeps `FeeSink`, ETH → USDG, corpus custody, NAV accounting (§6), per-adapter caps |
| `IYieldAdapter.sol` | `deposit / withdraw / realizeSurplus / totalAssets` — the only integration surface |
| `BeefyAdapter.sol` | Wraps a Beefy vault: `mooToken` balance × `getPricePerFullShare()`, principal high-water mark, reward-pool claim (§4.3) |
| `Distributor.sol` | Pulls realized surplus, pushes `accUsdgPerShare` into `stTITH` |
| `StakedTithe.sol` | ERC-4626 `stTITH`; deposit TITH, `claim()` USDG |
| `Redeemer.sol` | Burn-or-dead-address TITH → queued pro-rata claim at haircut (§7) |
| `NavOracle.sol` | Chainlink reads + staleness + Arbitrum sequencer-uptime guards |

Reuse the Memebrokers Hardhat 2 / Solidity 0.8.24 / OZ `Ownable` + `ReentrancyGuard` setup and the
`robinhood` network config via `RH_RPC_URL` / `RH_CHAIN_ID` / `PRIVATE_KEY`.

**There is no `Gate.sol`** — see §11. Gating goes on `stTITH` and `Redeemer`, never on the token.

---

## 4. The corpus — and the capacity wall

### 4.1 What the corpus is denominated in

The tax arrives in **ETH**. The choice of what to hold defines what the floor promises:

| Option | Floor denominated in | Notes |
|---|---|---|
| **Hold ETH** | ETH | RH Chain ETH is bridged — **no native staking yield**. Floor swings with ETH. |
| **Convert to USDG** *(recommended)* | **USD** | Legible dollar floor, the most defensible promise. USDG is the canonical dollar on this chain per the AGORA work. |
| **Index stock tokens** | Equity basket | Higher expected return, *volatile* floor, and stacks §11 exposure considerably. |

**Recommendation: USDG core**, with a small ETH gas buffer. Note the conversion carries none of the
reflexivity a transfer-tax design has — the protocol never sells its own token.

> **Worth checking on Pons v2:** Pons v2 supports **pairs beyond ETH, including USDG and tokenized stocks**,
> and its hook "sets who receives trading fees **and what asset they are paid in**." If v2 lets the tax be
> paid directly in **USDG**, the ETH→USDG conversion step disappears entirely and the floor is
> dollar-denominated from the first trade. That is a materially better configuration than ETH payout, and
> it is a launch-time setting, not something changeable later. **Resolve before launching.**

### 4.2 Beefy on Robinhood Chain — measured, 2026-08-17

Beefy **is** live on chain 4663 (confirmed via `api.beefy.finance/tvl`). But:

- **40 vaults, ~$125,000 total TVL chain-wide.**
- **Largest vault: `uniswap-cow-robinhood-cashcat-weth-rp` at $67k** — a memecoin/WETH pair.
- **Every vault is a two-asset LP / CLM position. Zero single-asset vaults. Zero stablecoin-only vaults.**
  No USDG money market, no lending vault, no T-bill wrapper.
- Composition: memecoin/WETH pairs (`cashcat`, `tendies`, `frong`, `stonkbroker`), tokenized-stock/USDG
  pairs (`aapl`, `msft`, `tsla`, `gme`, `rddt`, `uso` — all under $600 TVL), and `weth-usdg` at **$4.5k**.

**Three consequences:**

1. **No safe home for the corpus exists on Beefy here.** Every option is an LP position carrying
   impermanent loss, and CLM concentration amplifies it. LP share value **can fall** — which breaks the
   floor invariant directly (§2).
2. **Capacity, not APY, is binding.** A $1M corpus in a $67k vault is ~94% of the pool: your own deposit
   collapses the APY, and exiting is impossible without severe slippage. Depositing the corpus as designed
   is not physically available.
3. **The tokenized-stock/USDG vaults are the most thesis-aligned** (equity exposure + USDG leg, echoing
   AGORA) **and the most starved** — a $500 vault cannot take a treasury allocation.

### 4.3 Policy that survives these facts

- **USDG core, held directly in `Treasury`.** Earns ~0% but is stable, instantly liquid for redemption, and
  is what the floor is measured in. This is the default destination for tax inflow.
- **Beefy sleeve, double-capped:** `min(sleeveBps × nav, vaultCapBps × vault.totalTVL)` with
  `vaultCapBps ≤ 2000` (never more than 20% of a vault's TVL) and `sleeveBps` starting near zero. The
  sleeve grows automatically as Beefy's RH TVL grows, and never becomes the pool.
- **Restrict to `weth-usdg` and stock/USDG pairs.** Never a memecoin pair — correlated, illiquid, and IL
  against a corpus whose entire job is to be reliable.
- **Prefer 0-withdrawal-fee vaults**, because distribution withdraws every epoch (§9). Beefy applies a
  withdrawal fee on *some* vaults; a fee turns frequent distribution into a leak.
- **Deposit the underlying directly — never ZAP** (0.05% zap fee).
- **Vault deprecation is routine at Beefy.** The adapter needs a migration path and a monitored
  `status != 'active'` alarm.
- **Two layers of contract risk** — Beefy strategy plus the underlying Uniswap CLM. Per-adapter caps are
  the only real defense, and the corpus floor never leaves USDG.

**Also worth checking (non-Beefy):** whether any RH-native lending market or USDG money-market token
exists. That would be a far better core venue than any LP position, and would let the yield story stand up
on its own.

---

## 5. Receiving the Pons payout — the gas-stipend trap

The fee recipient must survive **any** payout convention, including a bare `transfer()` with a **2300-gas
stipend**. Any `receive()` that writes storage, swaps, or routes will **revert** — losing the fee or, worse,
bricking trades. So `FeeSink` is deliberately dumb:

```solidity
contract FeeSink {
    receive() external payable {}          // the entire hot path
    function sweep() external {            // keeper-called, permissionless
        treasury.fund{value: address(this).balance}();
    }
}
```

Conversion, allocation, and accounting all live in `Treasury.fund()`. `sweep()` is permissionless because
it can only move ETH along its one intended path.

**Pons v2 verification items — mostly RESOLVED, see §14:**
1. **Push or pull?** If creator fees accrue and must be claimed, the keeper needs a `claim()` before
   `sweep()`, and `FeeSink` may need to be the registered creator/fee-rights holder.
2. **Contract or EOA-only recipient?** If EOA-only, a keeper EOA forwards to `Treasury` — worse trust-wise,
   and better known before launch.
3. **Is the 4% mutable post-launch?** Determines whether the §8 decay schedule exists at all. Pons documents
   creator tax as configurable **up to 10%**; mutability after launch is the open part.
4. **Payout asset selectable?** See §4.1 — USDG payout would be a significant improvement.
5. **Is the tax charged during the bonding-curve phase, or only after graduation?** Pons graduates at
   **4.2 ETH** into a permanently locked full-range Uniswap v4 position. Pre-graduation tax treatment
   determines whether the floor starts accreting from trade one.

---

## 6. NAV accounting

```
nav             = Treasury USDG
                + Treasury ETH (oracle-priced)
                + Σ adapter.totalAssets()          // Beefy: mooBal × getPricePerFullShare() / 1e18
                  ── TITH is marked at ZERO, always ──
eligibleSupply  = totalSupply − burned/dead − TITH held by protocol contracts
floorPerToken   = nav / eligibleSupply
```

Non-negotiable rules:

1. **TITH is never corpus.** No tax arrives in TITH here, but any future buyback would hold it — and a
   token backing itself makes the floor self-referentially inflatable. Mark at zero, and exclude the same
   balances from the denominator so numerator and denominator agree.
2. **Never value ERC-8056 assets off raw `balanceOf`.** Tokenized stocks hold `balanceOf` constant and move
   value via `uiMultiplier()`. Use `balanceOfUI()` / Chainlink — the AGORA trap, and directly relevant
   because the stock/USDG Beefy vaults hold these.
3. **`getPricePerFullShare()` is not a safe redemption price on its own.** LP/CLM share prices are
   manipulable within a block (donation and flash-loan vectors) and can legitimately fall. Feed redemption
   from a **lagged or per-block-capped NAV**, never a spot read.
4. **Every NAV read is oracle-gated** — Chainlink staleness + Arbitrum sequencer-uptime. NAV sets the
   redemption price, so a stale read is a direct theft vector. Redemption must **revert**, not degrade.

**Income vs. principal.** Only *realized* surplus is distributable. Unrealized appreciation stays in the
corpus and raises the floor. `Distributor` may only spend what `realizeSurplus()` actually returned.

---

## 7. Redemption

```
requestRedeem(amount):
    move TITH to burn/dead immediately        // supply drops now → floor rises now
    snapshot navPerToken (lagged, §6.3)
    enqueue(caller, amount, snapshotNav, timestamp)

execute(id) after redeemDelay:
    payoutNav = min(snapshotNav, currentNav)  // no gaming a NAV move in either direction
    pay caller: amount × payoutNav × 0.95     // haircut stays in corpus
```

- **Burn-on-request** makes the benefit to remaining holders immediate and the queue non-free to abandon.
- **`min(snapshot, current)`** blocks both "request during a spike, execute after" and the reverse.
- **The 5% haircut stays in the corpus**, so redemption is accretive to non-redeemers — that's what makes it
  a floor rather than a run.
- Pays in **USDG from the core**, so a redemption wave never forces liquidation of the Beefy sleeve at a
  loss. Per-epoch cap enforces this.
- **`burn()` and `burnFrom()` DO exist** on `PonsV2LauncherToken` (verified, §14), so redemption performs a
  real burn and `totalSupply()` stays authoritative. No dead-address workaround needed.

---

## 8. The tax

4% on buys and sells, **set in the Pons v2 pool via the shared `V2MemeHook`** — not in the token.
Nothing in `TitheToken` implements or knows about it.

**What that buys us**, relative to a transfer-tax design:

| Transfer-tax problem | Status here |
|---|---|
| Uniswap v3 / aggregators revert on fee-on-transfer | **Gone** — TITH is a plain ERC-20 |
| Tax collected in the token → protocol must sell itself | **Gone** — payout is ETH |
| `isPair` registry, pool registration, factory watcher | **Gone** |
| Exemption-set bugs (vault taxing itself recursively) | **Gone** |
| Gas overhead on every transfer | **Gone** |
| Untaxed side-pools | **Remains** — pools outside Pons trade tax-free |

Mitigating the last row is easier than usual: Pons graduates into a **permanently locked full-range v4
position**, so the canonical pool's depth can't be pulled out from under you. Side-pools arb against a book
nobody can rug.

### 8.1 Consequences of not owning the token contract

Pons deploys a **fixed-supply** token from its factory, so:
- **No hooks can ever be added** — which is exactly what we want (§11), but it's a constraint, not a choice.
- **`burn()` and `burnFrom()` DO exist** (verified §14) → §7 burns for real.
- **No mint** → supply is fixed; the only supply change is redemption burn. Good for the floor.
- **Verify the deployed bytecode before committing** — read the factory's token implementation and confirm
  it's a vanilla ERC-20 with no owner privileges, no blacklist, and no upgradeability.

### 8.2 Round-trip drag

8% round trip materially suppresses volume and pushes market makers away — the tax taxes the activity that
funds it. If Pons permits a mutable rate (§5.3), decay to ~1% over 12–18 months: bootstrap the corpus, then
stop strangling liquidity. If immutable, that lever doesn't exist and the §10 volume-decay risk rises.

---

## 9. Distribution — and why Beefy needs a surplus-trim, not a harvest

`stTITH` is a standard **ERC-4626** vault over TITH. Eligible supply is `stTITH.totalSupply()` — the whole
reason for staking over per-holder reflection: no transfer-hook checkpoints (this design has no hooks at
all), no exclusion set to get wrong, no accounting drift, no rebasing, nothing downstream broken.

**Beefy auto-compounds, so there is no harvestable income stream.** Yield exists only as an increase in
`getPricePerFullShare()` — mooToken count stays constant while redemption value grows. To pay stakers, the
adapter must **realize** the appreciation:

```
realizeSurplus():
    assets  = mooBal × getPricePerFullShare() / 1e18
    surplus = assets > principalHighWaterMark ? assets - principalHighWaterMark : 0
    withdraw(surplus) → USDG → Distributor
    // high-water mark unchanged; IL below the mark simply pays nothing
```

This is the same pattern as AGORA's Rebalancer trimming ERC-8056 multiplier-driven NAV surplus — worth
sharing the implementation.

Two Beefy-specific wrinkles:
- **A high-water mark means IL pauses distribution rather than distributing principal.** Correct and
  conservative: the floor is never funded backwards to pay stakers.
- **`-rp` (reward pool) vaults accrue a separate incentive token** needing its own claim step before it's
  countable or sellable.

`Distributor` holds `accUsdgPerShare`; `claim()` pays **USDG** pull-style. Epochs should be **weekly or
monthly**, not per-block, to amortize any withdrawal fee and gas.

**The split is intentional:** passive holders get the redemption floor; stakers get the income stream. Both
from the same corpus, and any future lockup lever lives in `stTITH` alone.

---

## 10. Risks

| Risk | Severity | Handling |
|---|---|---|
| **Yield capacity doesn't exist** — $125k chain-wide Beefy TVL vs. a corpus that outgrows it in days | **Critical** | §4.3 double cap; USDG core earns ~0 and that is accepted; reposition on the floor (§1.2) |
| **LP/IL breaks the floor invariant** | **Critical** | Sleeve capped; core never leaves USDG; high-water mark in `realizeSurplus` |
| **Adapter exploit** — the corpus *is* the token's value | Critical | Per-adapter caps; two-layer Beefy risk acknowledged; governance timelock on adapter adds |
| **Volume death spiral** — tax suppresses volume → corpus stalls | High | Rate decay *if Pons permits*; floor keeps working at zero volume |
| **NAV manipulation via `getPricePerFullShare`** | High | Lagged / per-block-capped NAV for redemption; oracle guards |
| **Pons payout convention mismatch** (2300-gas stipend / pull-based / EOA-only) | High | §5 — logic-free `FeeSink`; verify on **testnet 46630 first** |
| **Wrong payout asset locked at launch** (ETH when USDG was available) | High | §4.1 — resolve before launch; not changeable after |
| **Immutable 4%** | Medium | Verify pre-launch; if fixed, accept permanent volume drag |
| **Pons platform risk** — Uniswap's `pools.trade` out-launched Pons on its first day | Medium | Fee rights are hook-held and Pons lets communities inherit abandoned projects' rights; still, a launchpad you depend on losing a land war is a real dependency |
| **Redemption run** | Medium | Haircut + delay + accretive-to-stayers math + per-epoch cap + USDG core |
| **Beefy vault deprecation** | Medium | `status` monitor + adapter migration path |
| **Keeper liveness** | Low | `sweep()` permissionless; ETH accrues safely in `FeeSink` meanwhile |

---

## 11. Regulatory flag

A token marketed as *"hold this and receive a share of income from a pooled portfolio"* sits close to the
textbook shape of an investment contract, and moves closer if the corpus holds tokenized equities.
**This is a flag, not advice — get counsel before any public launch.**

Levers that reduce (never eliminate) exposure:
- **No discretionary management** — adapters, caps and weights governance-set and non-discretionary.
- **Gate the income and redemption contracts, not the token.** The AGORA spec ships a dormant ERC-1404
  `GATE` on the token itself — **do not copy that here**, and in fact §8.1 makes it impossible. A transfer
  gate needs a transfer hook, which would forfeit the plain-ERC-20 win. Since the security-like behaviour
  lives in `stTITH` and `Redeemer`, put any allowlist or geofence there. TITHE stays freely composable; the
  yield claim is the gateable surface.

---

## 12. Open decisions

1. **Payout asset — ETH or USDG?** (§4.1) Launch-time and irreversible. USDG removes a conversion step and
   dollar-denominates the floor from trade one. **Highest-impact item.**
2. ~~**Pons v2 fee mechanics**~~ — **RESOLVED (§14).** Fees are **pull-based** via `V2FeeEscrow.claim()`. Remaining: rate mutability, payout-asset
   selectability, bonding-curve-phase tax. **Blocking for implementation.**
3. **Does any RH-native lending market or USDG money-market token exist?** (§4.3) If yes, it replaces Beefy
   as the core venue and the yield story stands on its own. If no, accept ~0% on the core.
4. **Initial `sleeveBps`** — is a Beefy sleeve worth the IL and contract risk at $125k chain TVL, or does
   the corpus sit 100% USDG until capacity exists? *(Leaning: 100% USDG at launch, sleeve later.)*
5. **Tax decay schedule** — 4% → 1% over 12–18 months if mutable; otherwise moot.
6. **Name and ticker** — TITHE/`TITH` is a placeholder chosen because "tithe" names the mechanism exactly:
   a fixed levy on every transaction funding a common purse.
7. **Redemption epoch cap** — what fraction of the USDG core per epoch?
8. **Launch distribution** — the floor starts at zero. Pons's 4.2 ETH bonding curve means the pre-graduation
   phase seeds it; decide whether to also seed the treasury directly.
9. **Governance** — multisig at launch vs. token-voted, in tension with §11's non-discretionary lever.

---

## 13. Build phases

1. **Pons + Beefy reconnaissance on testnet 46630.** Launch a throwaway token with a 4% tax, point the fee
   at a logic-free `FeeSink`, and empirically answer every question in §5 and §12.1–2. Read the Pons factory's
   token implementation bytecode (§8.1). Confirm a Beefy vault's `getPricePerFullShare` / withdrawal-fee
   behaviour with a small real deposit. **Phase one because the answers reshape phases 2–4.**
2. **FeeSink + Treasury.** Sweep, ETH → USDG with `minOut`, corpus custody. `NavOracle` with staleness +
   sequencer guards. Test NAV with TITH deliberately held by a protocol contract — must contribute **zero**.
3. **Redemption.** `Redeemer` with queue, haircut, `min(snapshot, current)`, epoch cap. Fuzz the floor
   invariant: **`floorPerToken`, measured in the corpus numeraire, must be non-decreasing across every
   sequence of taxes and redemptions.** The most important test in the repo. *Ships before staking — the
   floor is the product (§1.2).*
4. **Staking + distribution.** `stTITH` (ERC-4626) + `Distributor`; verify `accUsdgPerShare` across
   deposits/withdrawals mid-epoch.
5. **BeefyAdapter.** Double cap, principal high-water mark, `-rp` reward claim, `status` monitor, migration
   path. Starts at `sleeveBps = 0`.
6. **Governance timelock.**
7. **Testnet end-to-end**, then audit, then mainnet.

---

## 14. Appendix A — Verified on-chain facts (chain 4663, 2026-08-17)

All addresses below were derived independently and then cross-checked against Blockscout's curated
`metadata_tag` labels; every derivation agreed with its tag. Method: the canonical `PoolManager` is the one
that the periphery contracts' `poolManager()` getters agree on (27 of ~60 candidates), and the outliers
point at *other chains'* PoolManagers (`0x000000000004444c…` = Ethereum, `0x498581fF…` = Base) — i.e.
copy-paste clones. **Do not trust Blockscout name search alone: this chain has 34 contracts named
`PoolManager`, 36 named `UniversalRouter`, and 14 named `PonsV2LaunchFactory`.**

### 14.1 Uniswap v4 (canonical cluster)

| Contract | Address | Confidence |
|---|---|---|
| `PoolManager` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | **High** — 27 votes, metadata-tagged, 2,950 `Initialize` events / 500k blocks, and Pons's own `poolManager()` returns it |
| `UniversalRouter` | `0x8876789976dEcBfCbBbe364623C63652db8C0904` | **High** — 9,311,836 txs (next candidate 945k), metadata-tagged |
| `Permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | **High** — canonical cross-chain address, code present (9,152 bytes), and Pons's `permit2()` returns it |
| `PositionManager` | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | **High** — read directly from `PonsV2LaunchFactory.positionManager()`, metadata-tagged |
| `StateView` | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | **Medium** — metadata-tagged; 2 candidates point at the right PoolManager |
| `V4Quoter` | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` | **LOW — UNRESOLVED** (§14.5) |

> **Why tx count fails for `V4Quoter` and `StateView`:** both are called exclusively via `eth_call`, which
> never produces a transaction. All 12 `V4Quoter` candidates point at the correct PoolManager and all show
> ~0 txs, so activity ranking carries no signal. See §14.5 for the resolution method.

### 14.2 Pons v2

| Contract | Address | Notes |
|---|---|---|
| `PonsV2LaunchFactory` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | `launchEnabled = true`; the hook's `factory()` points back at it (mutual confirmation) |
| `V2MemeHook` | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | **The `hooks` field of the PoolKey** |
| `V2FeeEscrow` | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` | Where creator fees land, pull-based |
| `feeSweepOperator` | `0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2` | **Pons-controlled** — see §14.4 |
| `locker` | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` | Permanent LP lock |

**Verified parameters** (all match public reporting, itself a good sign):

| Parameter | Value |
|---|---|
| `maxCreatorTaxBps` | **1000 (10% cap)** — our 4% = 400 bps is well inside |
| `hookFeeBps` | **100 (1% pool fee)** |
| `protocolFeeShareBps` | **3000** → 30% protocol / **70% creator** |
| `buybackBurnBps` | 5000 |
| `launchFee` | 500000000000000 wei = **0.0005 ETH** |
| `graduationThreshold` | 4200000000000000000 = **4.2 ETH** |
| `supply` | 1e27 = **1,000,000,000 tokens** (18 dec) |
| `curveFeeBps` | 100 (1% bonding-curve fee) |
| `phantomQuote` | 1.68 ETH |
| `poolFee` / `tickSpacing` | **0 / 200** |
| `snipeTaxStartBps` / `snipeTaxSeconds` | **9900 (99%) / 3 seconds** |
| `CREATOR_FEE_RECIPIENT_TIMELOCK` | 259200 = **3 days** (execution window also 3 days) |

**`poolFee = 0` matters:** the pool carries no static LP fee, so the 4% tax and the 1% fee are both applied
**dynamically by the hook** in `beforeSwap`. This is exactly why quoting must go through `V4Quoter` (which
executes the hook) and never through a spot-price calculation.

**`snipeTaxStartBps = 9900` matters:** a **99% tax for the first 3 seconds** after launch. `launchToken`
accepts a `snipeTaxExemptions` address array. Plan the launch around this and warn users in the UI.

### 14.3 The PoolKey — this is what unblocks the swap widget

For an ETH-paired Pons v2 token:

```
PoolKey {
  currency0   : 0x0000000000000000000000000000000000000000   // native ETH — always sorts first
  currency1   : <TITHE token address>
  fee         : 0
  tickSpacing : 200
  hooks       : 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
}

poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
```

**The derivation was verified** against a live pool's `Initialize` event — the computed hash matched the
event's indexed `poolId` exactly. For a USDG-paired pool, re-check ordering (`currency0 < currency1`).

Because `currency0` is native ETH, **buys need no Permit2 and no approval** — attach `value` to the call.
Only sells (TITHE in) require a Permit2 allowance.

### 14.4 The fee path is entirely Pons — and step 2 is not ours

```
swap ──► V2MemeHook accrues pendingCreatorTax(poolId, currency)
      ──► sweepPoolFees(poolId, minConversionQuoteOut, minBuybackTokensOut)
             ↑ gated on feeSweepOperator = 0x49BbF2b7… (PONS-CONTROLLED)
      ──► creator share credited into V2FeeEscrow
      ──► V2FeeEscrow.claim()          ← ours to call; pays msg.sender
```

Two consequences:

1. **Fees are PULL-based, not pushed.** The recipient calls `claim()`. So `FeeSink` needs a
   `claimFromEscrow()` that calls `V2FeeEscrow.claim()`, plus a trivial `receive()`. The logic-free
   `receive()` advice in §5 still stands — the escrow may pay via `transfer()` with a 2300-gas stipend —
   but for a different reason than §5 originally assumed.
2. **⚠ Corpus accrual depends on a keeper we do not control.** Tax sits in `pendingCreatorTax` until Pons's
   `feeSweepOperator` sweeps the pool. We cannot force it. `rescuePoolFees(poolId)` exists on the hook, and
   `rescueCurveFees` / `GRADUATION_RESCUE_DELAY` (7 days) on the factory — these look like escape hatches,
   but their access control is **unverified**. This is now a top-tier risk (§10) and a blocking question (§12).

Free live reads for the frontend, needing no contract of ours:
- `V2MemeHook.pendingCreatorTax(poolId, currency)` — tax accrued, not yet swept
- `V2FeeEscrow.balanceOf(recipient)` — swept, not yet claimed
- `HookFeeCollected(poolId, currency, feeAmount, taxAmount)` event — **cumulative tax history**
- `PoolFeesSwept(poolId, protocolAmount, buybackAmount, creatorAmount, tokensLocked)` event

### 14.5 Remaining verification

1. **`V4Quoter` identity** — 12 candidates, all pointing at the correct PoolManager, all ~0 txs. Resolve by
   `staticCall`ing `quoteExactInputSingle` on each against a known live Pons pool and keeping whichever
   returns a sane amount. An afternoon's work, and a hard blocker for the swap widget.
2. **`sweepPoolFees` access control** — `staticCall` it from an arbitrary address; if it reverts, we are
   dependent on Pons's operator (§14.4.2).
3. **Is the per-token creator tax mutable after launch?** No `setCreatorTax` appears in the v2 factory's
   write set; the tax appears fixed in `launchToken`'s `params` tuple. **If so, the §8.2 decay schedule is
   impossible and 4% is permanent.** Confirm by decoding the `launchToken` params tuple.
4. **Payout asset selectable at launch?** `approvedPairTokens(address)` and `setPairTokenEconomics` exist, so
   USDG-paired launches are supported — confirm the creator tax is then paid in USDG (§4.1, §12.1).

### 14.6 The token contract — §1's central claim holds

`PonsV2LauncherToken` exposes exactly 18 functions:

```
allowance, approve, balanceOf, burn, burnFrom, curve, decimals, deployer,
description, getTokenInfo, launchFactory, logo, name, socials, symbol,
totalSupply, transfer, transferFrom
```

- **No `owner`, no blacklist, no pause, no mint, no maxWallet/maxTx, no tax logic, no trading toggle.**
  §1's "plain, fully composable ERC-20" claim is **confirmed**. All restrictions (snipe tax, dynamic fee)
  live in the hook, not the token.
- **`burn` and `burnFrom` exist** → §7 performs a real burn and `totalSupply()` stays authoritative. The
  dead-address workaround previously assumed in §7/§8.1 is **not needed**.
- `curve()` and `launchFactory()` give the frontend **graduation-state detection** (bonding curve vs.
  graduated v4 pool) for free.

### 14.7 RPC

| Endpoint | `eth_getLogs` range | Use |
|---|---|---|
| `https://rpc.mainnet.chain.robinhood.com` | **≤ ~500k blocks** (1M fails) | **History scans** — `FloorUpdated`, `HookFeeCollected` |
| Alchemy `robinhood-mainnet` (existing key) | **10 blocks** (free tier) | Point reads only; unusable for history |

The public RPC removes any need for an indexer or subgraph. Note the existing Alchemy key is the
**known-compromised** Memebrokers deployer key — read-only use is fine, but rotation is still outstanding.

Chain is busy: ~2,950 pool initializations and ~550 Pons v2 launches per day.
