# TORII — launch runbook

Ordered, with a verification gate after every step. **Do not skip the gates** — the
first launch died because a step's effect was assumed rather than checked.

The whole point of this order is that the token is created **last**, so it is born with
`creatorFeeRecipient` already pointing at the FeeSink. There is no post-launch transfer step
to get wrong. `transferCreatorFeeRecipient` executes **immediately** — there is no timelock on
it, whatever the factory's timelock constants suggest — and it reassigns the curve's `deployer`,
which is the only address allowed to call `sweepFees`. That is exactly how v1 died.

---

## 0 · Before you touch anything

```bash
cd contracts
cp .env.example .env
npm install
npm test          # expect 165 passing
npm run rehearse  # optional: full 3-step dry run vs. a local node
```

`npm run rehearse` needs `npx hardhat node` running in another terminal. It proves the whole
sequence — deploy → launch-with-recipient → bind → collect — before any real gas is spent.

### `.env`

```ini
RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com
RH_CHAIN_ID=4663

# Generate a FRESH key. Fund it with ~0.02 ETH. Treat it as disposable —
# nothing here requires the deployer to keep power afterwards.
#   cast wallet new
DEPLOYER_PRIVATE_KEY=

# SHOULD be a multisig. If blank, the deployer EOA owns the treasury.
TREASURY_OWNER=

TOKEN_NAME=Torii
TOKEN_SYMBOL=TORII
CREATOR_TAX_BPS=400
```

**Never paste a private key into a chat window or a shell command** — shell history persists it.

---

## 1 · Deploy Treasury + FeeSink

The token does not exist yet. That is intentional.

```bash
npm run deploy:robinhood
```

Record the two addresses it prints and put them in `.env`:

```ini
TREASURY=0x…
FEE_SINK=0x…
```

### Gate 1

```
Treasury.agora()    → 0x0    (bound in step 3)
Treasury.feeSink()  → the FeeSink
Treasury.redeemer() → 0x0    (no ETH can leave)
FeeSink.treasury()  → the Treasury, immutable
FeeSink.owner()     → you, until step 3 renounces it
```

If `Treasury.feeSink()` is zero, the wiring call failed — fix it before continuing.

---

## 2 · Launch the token

**Dry run first. It does not send anything.**

```bash
npm run launch:robinhood
```

This simulates and prints the exact params, including the predicted token address. It resolves
the undocumented `expectedEconomics` commitment by trying candidate encodings and keeping
whichever *simulates* successfully — if none do, it refuses to send rather than burning the
0.0005 ETH launch fee on a guess.

Check the output line by line. The one that matters:

```
creatorFeeRecipient   0x…   ← MUST be your FEE_SINK
```

Then, and only then:

```bash
LAUNCH_EXECUTE=1 npm run launch:robinhood
```

Put the token address in `.env` as `TOKEN=0x…`.

> If you want a reproducible address, keep the `LAUNCH_SALT` the dry run printed and pass it
> back in.

### Gate 2 — the one that killed v1

```bash
# curve.deployer() MUST equal FEE_SINK
```

`bind.ts` checks this for you and **aborts** if it is wrong. If it aborts: **do not trade into
the token.** Accrued tax would be unsweepable exactly as before. Relaunch instead — at this
point you have spent 0.0005 ETH and nothing else.

---

## 3 · Bind and deploy the rest

```bash
npm run bind:robinhood
```

This verifies Gate 2, then:

- `Treasury.setAgora(token)` — write-once
- `FeeSink.setCurve(curve)` — write-once, **and renounces the FeeSink's owner in the same call**
- deploys `StakedTorii`, `Redeemer`, `StakedSuits`, `Distributor`
- `Treasury.setRedeemer(...)` and `Treasury.setDistributor(...)`

If `TREASURY_OWNER` is a multisig, the two `set*` calls print calldata for governance to execute
instead of failing.

### Gate 3

```
Treasury.agora()       → the token
Treasury.redeemer()    → the Redeemer
Treasury.distributor() → the Distributor
FeeSink.curve()        → the curve
FeeSink.owner()        → 0x0   (renounced — no privileged caller remains)
```

---

## 4 · Wire the frontend

`bind.ts` prints this block. Paste it into `frontend/src/chain.ts`:

```ts
token:       "0x…",
curve:       "0x…",
feeSink:     "0x…",
treasury:    "0x…",
stakedAgora: "0x…",
redeemer:    "0x…",
stakedSuits: "0x…",
distributor: "0x…",
```

```bash
cd ../frontend
TORII_TOKEN=0x… TORII_CURVE=0x… npm run verify   # 31 checks incl. the trade path
npx vite build
npx vercel deploy --prod --yes
```

Confirm the served bundle hash matches your local `dist/` — that proves the build you tested is
the one on the edge.

---

## 5 · Prove the fee path with real money, small

Do this **before** announcing anything.

1. Make one small buy.
2. `FeeSink.collectable()` → shows what is claimable in escrow and accrued on the curve.
3. `FeeSink.collect()` — permissionless, anyone can call it.
4. `Treasury.cumulativeTaxReceived()` should increase, and `floorPerToken()` with it.

If step 4 does not move, stop and diagnose. The `sweepFees` destination has never been proven —
the public RPC exposes no trace API, so where that ETH lands is inferred, not verified.

---

## 6 · Post-launch decisions

These are live levers, not deployment steps.

| Decision | Call | Notes |
|---|---|---|
| Move ownership to a multisig | `Treasury.transferOwnership` | Do this early. Cheap now, awkward later. |
| Pay stakers from tax | `Treasury.setIncomeShareBps(bps)` | **Defaults to 0.** With no yield adapter there is no yield, so stakers and staked Suits earn *nothing* until you set this or ship an adapter. Capped at 50%. |
| Change the Suits slice | `Distributor.setSuitsBps(bps)` | Default 1000 = 10%. Capped at 30%. |
| Redemption terms | `Redeemer.setHaircutBps` / `setRedeemDelay` / `setEpochPolicy` | Haircut ≤ 20%, delay ≤ 30 days. |

---

## Putting the corpus to work

`Treasury.withdraw(amount)` sends corpus ETH to the `operator` wallet (defaults to the owner;
change it with `setOperator`) so it can be deployed into yield off-contract. Send the proceeds
back with `Treasury.fund()` — inflow from anywhere other than the FeeSink counts as a donation
and raises the floor, or use `setIncomeShareBps` if some of it should reach stakers instead.

Two consequences to hold in mind:

- **`floorPerToken()` is advisory, not enforceable.** Corpus ETH can leave without a redemption.
  Do not market a guaranteed or hard floor. Every withdrawal emits `Withdrawn` with the
  resulting NAV and fires `FloorRegression`, so the record is public either way.
- **You cannot withdraw staker income.** Withdrawal is capped at `liquidEth()`, which excludes
  `pendingIncome`. That ETH is owed to stTORII and staked Suits holders.

**There is now an on-chain alternative to that manual route.** `BeefyCLMAdapter` deploys corpus
ETH into a WETH-paired Beefy cowcentrated vault **without the ETH leaving `nav()`**, so the
floor stops dropping by the full amount every time you put money to work. See
[`contracts/README.md`](./contracts/README.md#beefyclmadapter--the-yield-sleeve). It only
handles vaults with a WETH leg; the USDG/tokenized-stock vaults still need the operator route.

Beefy's capacity on this chain remains the binding constraint, not APY. Measured 2026-08-18:
**57 vaults, ~$138k TVL chain-wide, every one a two-asset LP, zero single-asset.** The largest
is `cashcat-weth-rp` at $87k; `weth-usdg-rp` — the only non-memecoin, non-stock pair — holds
$4.5k. A corpus taking 0.78 ETH of tax in its first days outgrows any single vault quickly,
which is what `maxVaultShareBps` on the adapter and `sleeveBps` on the Treasury are for.

## Treasury allocation is manual, by design

There is **no keeper, no automation and no scheduled job** that moves corpus funds. Every
allocation decision is an owner-only transaction:

| Action | Who |
|---|---|
| `queueAdapter` / `activateAdapter` | **owner only**, plus a 2-day timelock between them |
| `removeAdapter` | **owner only** (immediate — an exit must never be delayed) |
| `setSleeveBps` | **owner only**; defaults to 0, so no deposit is even possible |
| `depositToAdapter` / `withdrawFromAdapter` | **owner only** |

Only three calls are permissionless, and none of them chooses a venue or moves principal:

- `FeeSink.collect()` — pushes fees along one hard-coded path into the Treasury.
- `Treasury.realizeSurplus(adapter)` — pulls surplus *in* from an adapter the owner already
  approved. It cannot move principal and cannot pick a destination.
- `Treasury.distributeIncome()` — forwards already-earmarked income to the Distributor.

Say the word if you want `realizeSurplus` gated to the owner as well; it is a one-line change.
It is left open because it can only move value toward the protocol, and gating it would add a
liveness dependency for no security gain.

**Nothing is deployed against Beefy from the Treasury today.** On-chain, `sleeveBps` is 0 and
`adapters()` is empty, so 100% of the corpus sits as liquid ETH until you deliberately change
that. `BeefyCLMAdapter` exists in the repo but is not deployed or activated — that takes
`queueAdapter` → 2 days → `activateAdapter` → `setSleeveBps` → `depositToAdapter`.

Note this is separate from any position the **operator wallet** holds on beefy.com. Those were
funded by `Treasury.withdraw()`, so that ETH already left `nav()` and the adapter cannot adopt
them. To bring them under the Treasury's accounting they have to be withdrawn on beefy.com,
returned with `Treasury.fund()`, and redeployed through the adapter.
