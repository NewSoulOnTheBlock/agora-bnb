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

## What the owner cannot do

There is **no** `execute(address,bytes)`, no arbitrary `call`, no `delegatecall`, and no
upgradeability. A treasury with an arbitrary-call escape hatch is trivially rug-able by its
owner, which would make the floor a promise rather than a property.

Owner powers are enumerated and bounded: set the fee sink and redeemer, manage an
allowlist of adapters behind a 2-day timelock, move ETH between the Treasury and those
adapters within a capped sleeve, and adjust the supply-exclusion list.

**The owner cannot withdraw ETH.** The only address that can move ETH out is `redeemer`,
and only via `payout()`. A test asserts the absence of every common escape-hatch name.

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

## Deploying

The signing key is read from `DEPLOYER_PRIVATE_KEY` in `.env` and nowhere else — never from
a command argument, since shell history persists those.

```bash
cp .env.example .env      # fill in; .env is gitignored at the repo root
npm run deploy:robinhood
```

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

## Not written yet

`BeefyAdapter`, `Distributor`, `StakedAgora` (ERC-4626) and `Redeemer` are specified in
spec §3.1 but do not exist. Until `Redeemer` ships and is set via `setRedeemer()`, **no ETH
can leave the Treasury at all** — `payout()` reverts with `NotRedeemer` because `redeemer`
is the zero address.

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
