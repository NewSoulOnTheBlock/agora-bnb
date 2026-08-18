# BeefyCLMAdapter — the yield sleeve

Deploying corpus ETH into Beefy **without the ETH leaving the Treasury's accounting**.

> **Chain:** Robinhood Chain (EVM, Arbitrum Orbit L2), chainId **4663**, gas in ETH.
> **Contract:** [`contracts/contracts/adapters/BeefyCLMAdapter.sol`](./contracts/contracts/adapters/BeefyCLMAdapter.sol)
> **Status:** written, compiled, 23 guard tests + a full-lifecycle fork rehearsal against the
> live vault. **Not deployed. Not activated.** `sleeveBps` is 0 and `adapters()` is empty.
> **Measurements in this document:** 2026-08-18, unless stated otherwise.

---

## 1. The problem this solves

Corpus ETH currently reaches Beefy by this route:

```
Treasury.withdraw(amount)  →  operator EOA  →  beefy.com zap  →  operator holds the position
```

That works, and it is how the two live positions were funded. But the ETH **leaves `nav()`
entirely**. The Treasury has no idea the position exists, so:

- `floorPerToken()` drops by the full amount deployed, every single time.
- Every withdrawal emits `FloorRegression`, because from the contract's point of view the
  corpus genuinely shrank.
- The Beefy position backs nothing on-chain. It is not in NAV, not redeemable against, and not
  visible to any holder reading the contracts.
- The position sits in a personal wallet rather than in protocol custody.

Measured on the live Treasury (`0x7A3B8322dd85C6e9F24D3A0a8D66514ad0E26C5c`):

| Reading | Value |
|---|---|
| `cumulativeTaxReceived` | 0.7806 ETH |
| `cumulativeIncomeDistributed` | 0.2342 ETH |
| `cumulativeWithdrawn` | **0.34 ETH** |
| `nav()` | **0.2064 ETH** |
| `incomeShareBps` | 3000 (30%) |
| `sleeveBps` | 0 |
| `adapters()` | `[]` |

The tax engine works. But 0.34 ETH of the 0.78 ETH it earned has been withdrawn to the
operator, and every wei of that is invisible to the floor. The adapter closes that gap: ETH
goes to Beefy and **stays inside `nav()` the whole time**.

---

## 2. What it does

```
Treasury.depositToAdapter(adapter, amount)
    │
    ├─ wrap ETH → WETH
    ├─ swap the correct fraction to the paired token, straight through the
    │  Uniswap v3 pool — no router, no path encoding, no off-chain route
    ├─ CLM.deposit(amount0, amount1, minShares)
    └─ RewardPool.stake(shares)
```

The split ratio is derived from the vault's live `balances()`, so the deposit lands in-ratio and
mints the shares it should rather than being diluted by a lopsided contribution.

Withdrawal runs the same path in reverse: unstake → `CLM.withdraw` → swap the paired leg back to
WETH → unwrap → send ETH to the Treasury.

### Why not just call Beefy's zap

The zap transactions used so far call `BeefyZapRouter.executeOrder` at
`0xA4Fa243F43D9B3f60664e9F11E377a49D322BD1a` (selector `0xf41b2db6`). That function takes an
**order plus a pre-encoded array of steps computed off-chain** — wrap, swap, deposit, stake,
each with its own calldata blob. A contract cannot produce that route for itself.

So the adapter does not wrap the zap router. It performs the equivalent work natively, which
has the side benefit of removing a dependency on a Beefy periphery contract that could be
migrated or deprecated.

---

## 3. `totalAssets()` — the number that had to be got right

`totalAssets()` feeds `Treasury.nav()`, which sets `floorPerToken()`, which sets the
**redemption price**. Get it wrong and it is not an accounting bug, it is a theft vector.

The STONKBROKER/WETH pool holds roughly **1.8 ETH in total**. Moving its spot price costs
almost nothing. A naive mark-to-market here is exactly what `docs/design.md` §6.3 warns about:

> `getPricePerFullShare()` is not a safe redemption price on its own. LP/CLM share prices are
> manipulable within a block (donation and flash-loan vectors) and can legitimately fall. Feed
> redemption from a **lagged or per-block-capped NAV**, never a spot read.

Four layers answer this.

### 3.1 Valuation takes `min(spot, TWAP)`

The paired leg is valued twice — once at the live pool price, once at a `twapSeconds` TWAP read
from `pool.observe()` — and the **lower** result wins.

Which direction is "less favourable" flips depending on whether WETH is `token0` or `token1`,
so the contract computes both candidate valuations in full and takes the smaller. No reasoning
about pair ordering is required, and no ordering bug is possible.

| Attack | Result |
|---|---|
| Pump spot to inflate the position | TWAP wins the `min`. Reported assets do not move. |
| Crash spot to deflate the position | Spot wins the `min`. Assets understate — the safe direction. |

The pool's `observationCardinality` is **14400**, so the TWAP window is fully available and is
not a synthetic single-observation read.

### 3.2 The Treasury already caps corpus at principal

`Treasury.adapterCorpus()` values a sleeve position at `min(totalAssets, principal)`. Even if
layer 3.1 were defeated, no reading of the adapter can push NAV above the ETH actually
deployed. Upward manipulation has no payoff in the corpus path at all.

### 3.3 `realizeSurplus()` is gated twice over

This is the one function whose *payout* is a function of a price reading — it moves value out
of the corpus and into staker income. Without a guard the attack is: pump the pool, then call
the permissionless `Treasury.realizeSurplus()` and convert fictitious appreciation into real
ETH for stakers.

Two gates close it:

- **Beefy's own `isCalm()`** must return true. That is Beefy's TWAP-deviation check, enforced by
  their audited strategy, and it is the same gate that governs their own deposits.
- **A cooldown** (`realizeCooldown`, default 1 hour, max 7 days) between realizations.

### 3.4 `totalAssets()` can never revert

`Treasury.payout()` touches `nav()`, and `nav()` sums `totalAssets()`. An adapter that can
revert a NAV read would **brick redemption for everyone, permanently**.

So `totalAssets()` wraps the whole computation in `try/catch` and returns `0` on any failure —
a broken oracle, an unreadable vault, a reverting preview. A separate `healthy()` view reports
whether the reads are actually answering, so a zero is never silently mistaken for a real loss
of value. This mirrors the Treasury's own stance on unreadable adapters:

> A visibly wrong floor is recoverable; a frozen treasury is not.

---

## 4. Trading guards

Both the deposit swap and the unwind swap are protected the same way.

**The price limit is anchored to the TWAP, not to spot.** `sqrtPriceLimitX96` is set to
`TickMath.getSqrtRatioAtTick(twapTick ± maxTickDeviation)`, so a swap cannot push the pool
further than `maxTickDeviation` beyond the time-averaged price. A sandwich cannot use the
adapter's own trade to walk the pool somewhere it was never trading.

**Trading is refused entirely when spot has left the band.** Before any swap the contract
requires `|spotTick − twapTick| ≤ maxTickDeviation`, reverting with `PriceOutOfBand` otherwise.
That is the shape of a fresh manipulation, and the adapter simply declines to trade into it.

**`isCalm()` must pass before depositing.** Beefy's strategy would revert anyway; checking up
front makes the failure legible instead of an opaque inner revert.

**Capacity is capped.** `maxVaultShareBps` (default 2000 = 20%, hard limit 5000) bounds the
adapter's share of the CLM vault. This is `docs/design.md` §4.3's second cap, and on this chain
it is the binding constraint rather than APY — see §7.

---

## 5. Risk parameters

All owner-settable through a single bounded `setParams`, plus `setRealizeCooldown`.

| Parameter | Default | Bounds | Purpose |
|---|---|---|---|
| `twapSeconds` | 1800 | 60 … 86 400 | TWAP window for valuation and trade limits |
| `maxTickDeviation` | 200 (≈2%) | 1 … 2 000 | Max spot-vs-TWAP gap tolerated when trading |
| `slippageBps` | 100 (1%) | ≤ 1 000 | Tolerance on CLM mint/burn previews |
| `maxVaultShareBps` | 2 000 (20%) | 1 … 5 000 | Ceiling on this adapter's share of the vault |
| `realizeCooldown` | 1 hour | ≤ 7 days | Minimum spacing between surplus realizations |

---

## 6. Trust surface

Every venue address is `immutable`. The adapter **cannot be repointed** at a different vault or
pool after deployment — changing venue means deploying a new adapter and letting the Treasury's
2-day `queueAdapter` timelock run again.

The owner can tune bounded risk parameters and nothing else. There is:

- no arbitrary call, no `delegatecall`, no upgradeability;
- no withdrawal function that names a destination;
- no path that sends value anywhere except back to the immutable `treasury`.

`deposit`, `withdraw` and `realizeSurplus` are callable **only by the Treasury**. A test asserts
that the only non-view functions taking an `address` argument are `uniswapV3SwapCallback`
(the pool's callback), `sweepRewardToken` (names a token, sends to the treasury) and
`transferOwnership` (moves the parameter-tuning role and can send nothing).

The swap callback rejects any caller that is not the pool, and additionally rejects calls made
outside a swap the adapter itself initiated.

---

## 7. What the adapter does not fix

### Impermanent loss is real and is not hedged

A CLM position is a concentrated two-asset LP. If the paired token falls, the position converts
into that token and the ETH value of the corpus falls with it. `principal()` is a high-water
mark, so the loss is reported honestly — NAV drops, the floor drops, `FloorRegression` fires.
Only `sleeveBps` and `maxVaultShareBps` bound the exposure.

`docs/design.md` §4.3 is explicit:

> **Restrict to `weth-usdg` and stock/USDG pairs. Never a memecoin pair** — correlated,
> illiquid, and IL against a corpus whose entire job is to be reliable.

The live STONKBROKER/WETH position, measured 2026-08-18:

| | |
|---|---|
| Deposited | 0.080638 ETH |
| Current value | 0.076889 ETH (**−4.65%**) |
| Composition | 0.0169 ETH + 6 010 STONKBROKER — **78% of the position is now the memecoin** |
| Range | ticks 109 400 – 117 400; spot at 115 161, so still in range |
| Vault TVL | **1.78 ETH total** |

The adapter fixes the *accounting*, not the *exposure*. Choosing the venue is still a judgement
call, and it is the most consequential one here.

### Capacity is the binding constraint, not APY

Beefy on chain 4663, measured 2026-08-18: **57 vaults, ~$137,681 TVL chain-wide, every one a
two-asset LP, zero single-asset and zero stablecoin-only vaults.**

| Vault | TVL | Note |
|---|---|---|
| `uniswap-cow-robinhood-cashcat-weth-rp` | $86,587 | largest, memecoin pair |
| `uniswap-cow-robinhood-tendies-weth-rp` | $21,172 | memecoin pair |
| `uniswap-cow-robinhood-cashcat-usdg-rp` | $7,636 | no WETH leg |
| `uniswap-cow-robinhood-weth-usdg-rp` | **$4,518** | **the only non-memecoin, non-stock WETH pair** |
| `uniswap-cow-robinhood-stonkbroker-weth-rp` | $3,398 | current position |
| `uniswap-cow-robinhood-msft-usdg-rp` | $594 | no WETH leg; ERC-8056 stock leg |

A corpus that took 0.78 ETH of tax in its first days outgrows any one of these quickly. That is
what `maxVaultShareBps` exists for, and why the default is 20% rather than something permissive.

### Round-trip cost is 187 bps

Measured against the live STONKBROKER/WETH vault on a fork, for a 0.05 ETH round trip:

| Leg | Cost |
|---|---|
| Deposit (0.05 ETH → position) | 49 bps |
| Full round trip (in and back out) | **187 bps** |

Two swaps through a **1% fee pool** (`pool.fee() == 10000`) plus CLM fees. Yield has to clear
187 bps before a deployment was worth making, so this is for positions held for a while — not
for parking ETH overnight.

### WETH-paired vaults only

The pair must have WETH on one side, because the adapter converts ETH into the pair through a
**single** pool.

| Supported | Not supported |
|---|---|
| `weth-usdg`, `stonkbroker-weth`, `cashcat-weth`, `tendies-weth`, `frong-weth`, `weth-up`, `weth-pons` | `msft-usdg`, `aapl-usdg`, `cashcat-usdg`, `rddt-usdg`, and every other USDG/stock pair |

A vault with no WETH leg needs a two-hop route, which is out of scope for this contract.
`scripts/deploy-beefy-adapter.ts` **aborts** rather than deploying against one — verified
against the live MSFT-USDG vault.

There is a second reason to keep the stock pairs out. `MSFT`
(`0xe93237C50D904957Cf27E7B1133b510C669c2e74`) exposes `uiMultiplier()`, making it an ERC-8056
token — precisely the trap `docs/design.md` §6.2 flags:

> **Never value ERC-8056 assets off raw `balanceOf`.** Tokenized stocks hold `balanceOf`
> constant and move value via `uiMultiplier()`.

### Existing positions cannot be adopted

The two live Beefy positions are held by the operator EOA and were funded via
`Treasury.withdraw()` — that ETH already left `nav()`. The adapter cannot pull them in.

| Position | Share of vault |
|---|---|
| `uniswap-cow-robinhood-stonkbroker-weth-rp` | 4.31% |
| `uniswap-cow-robinhood-msft-usdg-rp` | **9.97%** |

To bring them under the Treasury's accounting they must be withdrawn on beefy.com, returned
with `Treasury.fund()`, and redeployed through the adapter. Note that ETH returned via `fund()`
from anywhere other than the FeeSink counts as a **donation**, not tax — it raises the floor and
is not split with stakers.

---

## 8. Testing

```bash
cd contracts
npm install
npm test                              # 165 tests, 23 of them the adapter's guards
```

The mocked suite (`test/BeefyAdapter.test.ts`) proves the properties that must hold regardless
of what the venue does:

- only the Treasury can move value; the callback rejects non-pool callers
- deposits are refused when `isCalm()` is false or spot has left the TWAP band
- the vault-share capacity cap binds
- a pumped spot price does not raise reported assets; a crashed one does lower them
- `totalAssets()` returns 0 and `healthy()` returns false when the oracle is unreadable,
  rather than reverting
- `realizeSurplus()` respects the cooldown and the calm gate, and leaves the high-water mark
  untouched
- a full exit clears the high-water mark, and governance parameters are bounded

The mocks deliberately do **not** model Beefy's economics. A mock that agreed with my own
assumptions about share minting would prove nothing. Those questions are answered against live
state instead:

```bash
# terminal 1
npm run fork                          # hardhat node --fork <RH_RPC_URL> --port 8546

# terminal 2
npm run rehearse:beefy                # full lifecycle vs. the REAL vault
```

The rehearsal deploys a Treasury and an adapter against a fork of chain 4663, funds the corpus,
runs the 2-day adapter timelock forward, deposits into the real Beefy CLM, takes a partial
withdrawal, fully exits, and then calls `Treasury.removeAdapter` — which refuses while the
adapter still reports assets, so it doubles as proof the exit was genuinely complete.

Point it at a different vault before committing to one:

```bash
CLM=0x1e8d576F71D5F416e7573b960fF59C4Fb77976ad \
REWARD_POOL=0x72cF42d5951e3F2F9Da265601a064A075600d036 \
DEPOSIT=0.02 npm run rehearse:beefy      # the weth-usdg vault
```

---

## 9. Deploying

Deploying the adapter is harmless on its own — it holds nothing, and the Treasury does not know
it exists. **Three owner actions, with a 2-day timelock in the middle, stand between deployment
and any corpus ETH moving.**

```bash
cd contracts
TREASURY=0x7A3B8322dd85C6e9F24D3A0a8D66514ad0E26C5c \
CLM=0x… REWARD_POOL=0x… npm run deploy:adapter
```

The script runs a preflight before it deploys anything: it reads the vault's `wants()`, confirms
one side is WETH (**aborting** if not), checks the reward pool actually stakes that CLM, prints
the vault's balances and `isCalm()` state, and reports the Treasury's owner, NAV and `sleeveBps`.
After deploying it prints the governance sequence and the raw calldata for a multisig.

Then, in order:

| # | Call | Note |
|---|---|---|
| 1 | `Treasury.queueAdapter(adapter)` | starts the 2-day `ADAPTER_TIMELOCK` |
| 2 | *wait 2 days* | gives holders time to exit at the current floor first |
| 3 | `Treasury.activateAdapter(adapter)` | adapter joins `adapters()` |
| 4 | `Treasury.setSleeveBps(bps)` | **0 today**, so no deposit is possible until this is set. Capped at 5000 |
| 5 | `Treasury.depositToAdapter(adapter, wei)` | the first real deployment |

Removal is immediate and needs no timelock — an exit must never be delayed. A funded adapter
cannot be removed, so unwind first with `Treasury.withdrawFromAdapter(adapter, type(uint256).max)`.

**Start small.** The first deposit should be a size you are willing to lose to a mistake.
`FeeSink.collect()` keeps printing tax meanwhile.

---

## 10. Operating it

| Action | Who can call it | Effect |
|---|---|---|
| `Treasury.depositToAdapter` | **owner only** | moves corpus ETH into the sleeve |
| `Treasury.withdrawFromAdapter` | **owner only** | pulls it back |
| `Treasury.realizeSurplus(adapter)` | permissionless | pulls appreciation *in*, earmarks it as income |
| `Treasury.distributeIncome()` | permissionless | forwards earmarked income to the Distributor |
| `adapter.redeploy()` | permissionless | pushes idle dust back into the position |
| `adapter.claimRewards()` | permissionless | pulls streamed reward tokens |
| `adapter.sweepRewardToken(token)` | permissionless | forwards a reward token to the Treasury |

The permissionless calls can only move value **toward** the protocol or along a hard-coded path.
None of them chooses a venue, and none of them moves principal.

### Monitoring

| Read | Watch for |
|---|---|
| `adapter.healthy()` | `false` means the oracle or vault is unreadable and NAV is understating |
| `adapter.ticks()` | `inBand == false` means trading is currently refused |
| `adapter.vaultShareBps()` | approaching `maxVaultShareBps` means capacity is running out |
| `adapter.surplus()` | unrealized appreciation waiting for `realizeSurplus()` |
| `Treasury.unhealthyAdapters()` | any adapter contributing zero to NAV |
| `FloorRegression` events | the floor fell — from IL, or from an operator withdrawal |

### Reward tokens

The reward pool currently streams **nothing** (`rewardsLength() == 0`), so `claimRewards()` is
forward-cover for Beefy turning incentives on later.

Reward tokens are **not auto-sold**. There is no reliable on-chain route for an arbitrary
incentive token, and inventing one is how adapters get drained. `sweepRewardToken` forwards them
to the Treasury — which marks unknown tokens at zero — parking them safely for a manual
decision. The pair tokens and the CLM share token are explicitly excluded from that path, since
they are the position rather than a reward.

---

## 11. Verified addresses

Every ABI this adapter calls was read from a **verified implementation on chain 4663**, not
inferred from bytecode and not copied from documentation. Guessing an ABI is how the first
deployment died.

### Beefy — STONKBROKER/WETH (the vault built against)

| Role | Address | How verified |
|---|---|---|
| CLM vault (EIP-1167 clone) | `0x9CcCE25f82f37ef777552E3BBB2A01BC5574AbE8` | clone target read from bytecode |
| ↳ implementation | `0xfd4017ad7c1092aafebc82621b4dee59f178d74c` | **verified** as `BeefyVaultConcLiq` |
| Reward pool (BeaconProxy) | `0xDAceb29D88ee1b5eFE8ac134523dC93A35548703` | beacon slot → `implementation()` |
| ↳ implementation | `0x7A6849A714D8014685310F20AEC07053FDbED442` | **verified** as `BeefyRewardPool` |
| CLM strategy | `0x76a2E8bC7Eb959A340c459B98b78c5bA8dBda032` | `clm.strategy()` |
| Uniswap v3 pool | `0x9cd74d5980A4BF60408B9bA2B0F6a3d368EBf594` | **verified** as `UniswapV3Pool`; `strategy.pool()` |
| Beefy zap router | `0xA4Fa243F43D9B3f60664e9F11E377a49D322BD1a` | destination of the manual zap txs |

Pool parameters: `fee = 10000` (1%), `tickSpacing = 200`, `observationCardinality = 14400`,
callback `uniswapV3SwapCallback(int256,int256,bytes)`.

### Tokens

| Token | Address | Decimals |
|---|---|---|
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 18 |
| STONKBROKER | `0xe934e36A439C94017B64a3FecE66AF12099aBF50` | 18 |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | **6** |
| MSFT (ERC-8056) | `0xe93237C50D904957Cf27E7B1133b510C669c2e74` | 18 |

### Other candidate vaults

| Vault | CLM | Reward pool |
|---|---|---|
| `weth-usdg` | `0x1e8d576F71D5F416e7573b960fF59C4Fb77976ad` | `0x72cF42d5951e3F2F9Da265601a064A075600d036` |
| `cashcat-weth` | `0x0BF46176b181D8bB5bbF57C5d200c79daF416221` | `0xA79fF9Ca6250A0ddEbc051dD898A4a892Caa4859` |
| `tendies-weth` | `0xAAa8C1e4F75Ec7DF802607D827Ea0efE8dCDDbDD` | `0xcD68b5A8850E5A10531bDE1BC657329575E40E2C` |
| `msft-usdg` *(unsupported)* | `0xE36274737D99273d353d8d9F0a51c1AeA7426C31` | `0xd9993b44E8d014F4ad979cb7706673386cd31520` |

### AGORA

| Contract | Address |
|---|---|
| Treasury | `0x7A3B8322dd85C6e9F24D3A0a8D66514ad0E26C5c` |
| Owner / operator | `0x2Fb89C8ce53E0527BC29e0861c4bEE1331d39d19` |

> The Treasury owner and the operator are the same **single EOA**. `docs/design.md` §11's
> "no discretionary management" lever argues against that, and `LAUNCH.md` §6 lists moving
> ownership to a multisig as the first post-launch decision. Adding a yield sleeve raises the
> stakes on that: the owner gains the power to move corpus ETH into an external venue.

---

## 12. Files

```
contracts/contracts/
  adapters/BeefyCLMAdapter.sol       the adapter
  interfaces/IBeefyCLM.sol           Beefy + Uniswap v3 ABIs, from verified sources
  interfaces/IYieldAdapter.sol       the Treasury's integration surface (unchanged)
  libraries/UniV3Math.sol            FullMath.mulDiv + TickMath.getSqrtRatioAtTick
  mocks/BeefyMocks.sol               test doubles incl. a breakable oracle
contracts/scripts/
  deploy-beefy-adapter.ts            deploy + preflight + governance sequence
  rehearse-beefy.ts                  full lifecycle against a fork of the live vault
contracts/test/
  BeefyAdapter.test.ts               23 guard tests
```

Related reading: [`contracts/README.md`](./contracts/README.md) for the Treasury and the floor
mechanism, [`LAUNCH.md`](./LAUNCH.md) for the launch runbook and post-launch levers,
[`docs/design.md`](./docs/design.md) §4 for the original corpus and capacity analysis.
