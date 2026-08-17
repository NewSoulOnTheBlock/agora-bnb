# AGORA contracts — Treasury + FeeSink

The collective balance sheet behind AGORA's redemption floor. **ETH-denominated corpus**
(spec [§4.1](../docs/design.md), option 1).

```bash
npm install
npm run compile
npm test                  # 43 tests
```

## Why ETH-denomination makes v1 oracle-free

```
nav()         = address(this).balance + Σ adapter.totalAssets()
floorPerToken = nav * 1e18 / eligibleSupply
```

Both terms are natively in wei, so **no price feed is involved anywhere**. That matters
more on chain 4663 than it sounds: no Chainlink ETH/USD aggregator has been verified there,
so a USD-denominated corpus would have had to invent a price source for the single number
that sets the redemption price. Spec §6.4 requires every NAV read to be gated on oracle
staleness and Arbitrum sequencer uptime — with an ETH corpus and no adapters, there is no
oracle to gate and `nav()` cannot go stale.

**The cost, stated plainly:** the floor is denominated in ETH, so its dollar value moves
with ETH. A floor of 0.000001 ETH/AGORA is hard in ether and soft in dollars. Spec §4.1
recommended USDG for exactly this reason; ETH was chosen deliberately over that advice.

## The owner CAN withdraw corpus ETH — read this before trusting the floor

`Treasury.withdraw(amount)` sends corpus ETH to a single `operator` address so it can be
deployed into yield-generating activity off-contract. That is a deliberate product decision,
and it has a direct consequence:

> **`floorPerToken()` is advisory, not enforceable.** It reports what backs each token *right
> now*. It is not a level the contract can hold, because corpus ETH can leave without a
> redemption.

Do not describe AGORA as having a *guaranteed* or *hard* floor. The honest description is a
**reported floor** that ratchets up with tax and redemptions and falls when the operator
withdraws. Every withdrawal emits `Withdrawn(to, amount, navAfter)` and fires
`FloorRegression`, so the entire history is auditable from events with no indexer.

### What is still structurally guaranteed

- **No arbitrary call.** No `execute(address,bytes)`, no `delegatecall`, no upgradeability.
  `withdraw()` takes an amount but **no destination** — funds can only reach `operator`. A
  compromised owner key bounds where corpus ETH lands, though not whether it leaves. A test
  asserts the function signature has exactly one `uint256` parameter.
- **Staker income is untouchable.** Withdrawal is capped at `liquidEth()`, which excludes
  `pendingIncome`. ETH earmarked for stAGORA and staked Suits is owed to third parties, not
  corpus, and the owner cannot reach it.
- **Redemption settles honestly through a withdrawal.** `Redeemer` pays
  `min(snapshotFloor, currentFloor)`, so a withdrawal between request and execution *reduces*
  the payout rather than letting anyone claim value that is no longer there — and it can never
  make a matured request revert. A test proves exactly this.
- **Holders extract value only through redemption.** `payout()` is callable solely by
  `redeemer`.

Other owner powers remain enumerated and bounded: set the fee sink, redeemer, distributor and
operator; manage an adapter allowlist behind a 2-day timelock; move ETH into a capped sleeve;
adjust the supply-exclusion list.

## Design decisions worth knowing before you touch this

**`FeeSink.receive()` is empty on purpose.** The Pons fee path may pay with a bare
`transfer()`, forwarding only a **2300-gas stipend**. Any receiver that writes storage
(~20k gas) would revert — losing the fee, or bricking the swap that triggered it. A test
sends ETH through a real `transfer()` to prove the sink survives it. `treasury` is
`immutable` with no setter, so the sink cannot be repointed and needs no trust.

**Floor regressions emit, they never revert.** Reverting on a falling floor would brick
redemption at exactly the moment holders most want out, converting an accounting problem
into a trapped-funds problem. `floorHighWaterMark` records the peak and `FloorRegression`
fires when it is violated — only possible once a yield sleeve exists and takes IL.

**A broken adapter contributes zero rather than reverting.** `sleeveAssets()` wraps each
`totalAssets()` call in try/catch. This is a trade, not a free win: an unreadable adapter
*understates* NAV and drops the floor. The alternative propagates the revert, which makes
`nav()` revert — and because `payout()` touches `nav()`, that would brick redemption
permanently. A visibly wrong floor is recoverable; a frozen treasury is not. Monitor
`unhealthyAdapters()` so a zero contribution is never mistaken for a real loss.

This was caught by a failing test, not by inspection. The first version called
`totalAssets()` inside `removeAdapter()`, so a broken adapter also bricked the only path
that could remove it.

**Limit of that defense:** try/catch survives a revert but not gas exhaustion. An adapter
that burns all forwarded gas can still make `nav()` unusable. Calling untrusted code cannot
be made fully safe — the allowlist and timelock are the real mitigations, which is why
adding an adapter is the one action delayed by 2 days while removal is immediate.

**AGORA is never corpus.** It is marked at zero in `nav()` and the same balance is removed
from `eligibleSupply()` so the two agree (spec §6.1). Consequence: donating AGORA to the
Treasury shrinks the denominator and *raises* reported `floorPerToken` without adding value.
It is not profitable to do, but `floorPerToken()` is therefore not manipulation-proof
against a donor — the Redeemer must price against a **lagged** NAV per spec §6.3.

**Do not add the staking vault to the exclusion list.** It *custodies* user AGORA rather
than owning it; stakers must keep their floor backing. Exclude only AGORA the protocol owns.

## Deploying — contracts BEFORE the token

This ordering is not a preference, it is the fix for how the first deployment failed.

```bash
cp .env.example .env             # fill in; .env is gitignored at the repo root
npm run rehearse                 # optional: full dry run vs. a local node
npm run deploy:robinhood         # 1. Treasury + FeeSink (no token yet)
npm run launch:robinhood         # 2. launch — DRY RUN unless LAUNCH_EXECUTE=1
npm run bind:robinhood           # 3. setAgora + setCurve, after verifying
```

**Why this order.** Pons lets you set `params.creatorFeeRecipient` **at launch**. Because the
FeeSink already exists, the token is born with the correct recipient and there is no
post-launch `transferCreatorFeeRecipient` step to misaddress. That call is instant — there is
**no timelock on it**, contrary to what the factory's timelock constants suggest; those belong
to the `setCreatorFeeRecipient` path, which reverts. In the first deployment that call went to
the Treasury instead of the FeeSink, and because `sweepFees` is authorized on the curve's
`deployer`, the only address allowed to collect became a contract with no way to do it.

`scripts/launch.ts` is a **dry run by default** and resolves the undocumented
`expectedEconomics` commitment by simulating candidates rather than guessing. `scripts/bind.ts`
**aborts** if `curve.deployer()` is not the FeeSink, so a bad launch cannot be bound and traded
into.

The signing key is read from `DEPLOYER_PRIVATE_KEY` in `.env` and nowhere else — never from a
command argument, since shell history persists those.

Prefer a hardware wallet or an encrypted keystore. Failing that, generate a **fresh,
disposable** deploy key funded with just enough gas — nothing here requires the deployer to
retain power, since ownership is handed to `TREASURY_OWNER` at construction.

Set `TREASURY_OWNER` to a multisig or timelock. If it is left blank the script uses the
deployer EOA and prints a warning: a single EOA owning the collective balance sheet is what
spec §11's "no discretionary management" lever argues against.

To rehearse the whole flow against a local node first:

```bash
npx hardhat node
npx hardhat run scripts/seed-local.ts --network localhost      # prints a mock AGORA
AGORA_TOKEN=<printed> npx hardhat run scripts/deploy.ts --network localhost
```

## After deployment

1. **Wire the frontend** — `frontend/src/chain.ts`, replacing the deployer-EOA placeholders:
   ```ts
   feeSink:  "0x…",   // the FeeSink
   treasury: "0x…",   // the Treasury
   ```
   The read layer is already written against this exact ABI, so no other change is needed.

2. **Point AGORA's creator fees at the FeeSink**, from the Pons launch deployer:
   ```
   PonsV2LaunchFactory.transferCreatorFeeRecipient(AGORA, feeSink)
   ```
   **3-day timelock + 3-day execution window.** A contract is an accepted recipient
   (probed and confirmed). Only `transferCreatorFeeRecipient` works — `setCreatorFeeRecipient`,
   `executeCreatorFeeRecipientChange` and `cancelCreatorFeeRecipientChange` all revert.

3. **Claim, then sweep:** `V2FeeEscrow.claim()` pays `msg.sender`, so it must be called *by*
   the FeeSink. Then `FeeSink.sweep()` (permissionless). Step one of the Pons fee path —
   `sweepPoolFees` — is gated on Pons's own `feeSweepOperator` and is **not ours to trigger**
   (spec §14.4).

4. **Test with a small amount first.** The `sweepFees` destination has never been verified:
   the public RPC exposes no trace API, so where the ETH lands is inferred, not proven.

## StakedAgora — the income side

ERC-4626 vault over AGORA. Eligible supply for income is just `totalSupply()` of the vault,
which is the whole reason the design stakes rather than reflects: no transfer-hook checkpoints
on AGORA (which has none and can never gain any), no exclusion set to get wrong, no rebasing.

**Rewards are ETH and deliberately stay OUT of `totalAssets()`.** Share price therefore never
moves — shares are ~1:1 with deposits — and yield is tracked in a MasterChef-style accumulator
claimed pull-wise via `claim()`. If ETH income inflated the share price, `convertToAssets`
would report AGORA the vault does not hold and mislead every 4626 integrator downstream.

`_update` settles both parties before any share transfer, so buying shares never buys
someone else's unclaimed yield and selling never forfeits your own.

**Deviation from spec §3.1:** the separate `Distributor` is folded in. With native-ETH income
it would only forward value and re-derive per-share accounting the vault already keeps — an
extra address to wire and fund for no benefit. `notifyReward()` takes ETH directly. Split it
back out if income ever becomes multi-asset.

`notifyReward()` **reverts when nobody is staked** rather than swallowing the ETH.

## Redeemer — the floor mechanism

```
requestRedeem(amount):   snapshot floor → burn now → enqueue
execute(id) after delay: pay amount × min(snapshot, current) × (1 − haircut)
```

**Snapshot before burn is load-bearing.** Burning shrinks `eligibleSupply` and raises
`floorPerToken`. If a redeemer's own burn counted before their snapshot they would be paid at
the floor their exit created, and early redeemers would drain more than their share. Snapshotting
first pays exactly `amount × nav / supply`, so redeeming the entire supply drains the corpus to
precisely zero — a test asserts this.

**The haircut is what makes it a floor rather than a run.** The 5% stays while the supply
leaves, so every redemption is accretive to everyone who stayed. Exits make the remaining
position stronger.

**The zero-supply exception.** Once the last holder redeems everything, `floorPerToken()`
reports 0 — a per-token price over zero tokens is undefined, not worthless. Taking
`min(snapshot, 0)` would pay the final redeemer nothing and strand the whole corpus, so
`_payFloor` falls back to the snapshot when `eligibleSupply == 0`. The min rule exists to
protect remaining holders; with none remaining there is nobody to protect. **A test caught
this — the first implementation confiscated the last redemption.**

**No cancel.** Tokens are destroyed at request time, which makes the benefit to holders
immediate and abandoning the queue non-free. Re-minting is impossible: AGORA's supply is fixed
by the Pons factory.

Bounded governance: haircut ≤ 20%, delay ≤ 30 days, and `setRequestsPaused` blocks **new**
requests but can never block `execute` — already-burned tokens must always be able to complete
their claim, or an emergency stop becomes confiscation.

## StakedSuits + Distributor — the 10% NFT slice

**10% of yield goes to staked Suits NFTs**, 90% to stAGORA stakers.

Suits (`0x3ac7beb099c560f5a09bd822621327d8768f0625`, chain 4663) is a SeaDrop ERC-721 clone,
fully minted at **1111/1111**, with **no staking functions of its own** — so `StakedSuits`
provides them. One staked Suit earns one share; no rarity weighting or lockup multipliers,
which on a fixed 1111-piece collection would only add governance surface and places for
accounting to drift.

**Custody is required, not chosen.** The collection is not `ERC721Enumerable`, so no contract
can enumerate what an address holds. Paying on `ownerOf` at claim time would pay *holders*
rather than *stakers*; letting users declare token IDs without custody would keep counting a
Suit after it was sold. Tokens therefore move into the vault and only the original staker can
withdraw them. Accrued rewards survive unstaking — the NFT leaves, the earned ETH does not.

**⚠ Transfer-validator risk.** Suits has a Limit Break creator-token transfer validator at
`0xA000027A9B2802E1ddf7000061001e5c005A0000`. Today's policy permits `transferFrom` into a
contract — verified by simulating against a live holder — so staking works. But the
**collection owner can tighten that policy at any time** and could block transfers *out* of the
vault, stranding staked NFTs. Nothing here can prevent it; the collection is not ours. `unstake`
uses plain `transferFrom` rather than `safeTransferFrom` so it does not additionally depend on
the receiver hook, and rewards are tracked independently of custody so accrued ETH stays
claimable even if an NFT were stuck. Anyone staking is trusting the Suits owner on this point.

**The Distributor comes back.** It was folded into `StakedAgora` when there was a single sink;
with two sinks a split has to live somewhere both sides can be reasoned about. `distribute()`
is permissionless, both destinations are `immutable`, there is no withdrawal function, and the
NFT slice is capped at **30%** so governance cannot redirect the income stream.

**Empty-sink rerouting.** Either vault reverts on `notifyReward` when nobody is staked, so the
Distributor checks first and sends the whole amount to whichever side has stakers. If neither
does it reverts and the caller keeps its ETH — parking an undistributable balance would create
a claim nobody could exercise in a contract with no exit.

## The income route — and why the floor doesn't sawtooth

```
tax ──► FeeSink ──► Treasury ──┬──► corpus  (raises the floor)
                               └──► pendingIncome ──► Distributor ──┬──► 10% StakedSuits
sleeve yield ──► realizeSurplus ──► pendingIncome ──────────────────┴──► 90% stAGORA
```

`pendingIncome` is **excluded from `nav()`**, and that single decision is what keeps the floor
well-behaved. If income counted as corpus, realizing yield would spike the floor and paying it
out would drop it straight back — firing `FloorRegression` on every distribution and turning
the floor chart into a sawtooth of false alarms. Worse, redemptions in between would be priced
against ETH that belongs to stakers. So `payout()` and `depositToAdapter()` both spend only
`liquidEth()` (balance − pendingIncome), and `ethBuffer()` reports that rather than the raw
balance.

**The sleeve is valued at `min(totalAssets, principal)`** for NAV purposes — the adapter's
high-water mark. This is symmetric and deliberate:

| Sleeve moves | Counted in NAV? | Why |
|---|---|---|
| Gains **above** principal | **No** — `unrealizedSurplus()` | Income owed to stakers, not corpus. Counting it would inflate the floor and deflate it on payout. |
| Losses **below** principal | **Yes** | A real loss of corpus. The floor must fall, and `FloorRegression` fires. |

Without this, realizing yield would *lower* the floor — the sawtooth relocated rather than
removed. A test caught exactly that.

`distributeIncome()` is permissionless. If neither staking side has stakers it reverts and the
income stays earmarked, never silently reclassified as corpus.

### The lever you need to decide on

`incomeShareBps` routes a share of incoming **tax** to stakers. It **defaults to 0**, which is
the specified behaviour — spec §9 says only *realized* surplus is distributable and tax belongs
to the corpus.

That specification has a consequence worth being deliberate about: **with no yield adapter
deployed there is no yield, so stakers and staked Suits earn exactly nothing.** Raising this
above zero pays them out of trade tax at the cost of slowing the floor. Capped at 50%. Only
tax is ever split — donations are unambiguously gifts to the corpus.

## Not written yet

`BeefyAdapter` is specified in spec §3.1 but does not exist; `sleeveBps` stays 0 until it does.

`StakedAgora` and `Redeemer` are deployed by **step 3** (`bind.ts`), not step 1, because both
take the token address as a constructor argument. Until `Redeemer` is set via `setRedeemer()`,
**no ETH can leave the Treasury at all** — `payout()` reverts with `NotRedeemer`.

**Do not add StakedAgora to the Treasury's exclusion list.** It custodies user AGORA rather
than owning it, so stakers must keep their floor backing.

## Layout

```
contracts/
  Treasury.sol              ETH corpus, NAV, floor, capped sleeve, timelocked adapters
  FeeSink.sol               logic-free 2300-gas-safe ETH receiver
  interfaces/IYieldAdapter.sol   the only external integration surface
  mocks/Mocks.sol           test doubles incl. a 2300-gas sender and a reverting adapter
scripts/
  deploy.ts                 Treasury → FeeSink → wire; prints multisig calldata if needed
  seed-local.ts             local-only mock AGORA for rehearsing deploy.ts
test/
  Treasury.test.ts          43 tests
```
