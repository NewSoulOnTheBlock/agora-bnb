# AGORA — frontend

Dashboard + trade UI for the AGORA endowment token on **Robinhood Chain (chain 4663)**.
Design spec: [`../docs/design.md`](../docs/design.md).

> **Naming:** the spec still says **TITHE** throughout — that was the working name. The live
> token launched as **AGORA** (`0x6853618673D952Fe602616F6f896cC7be8e25fCc`) and the UI is
> branded accordingly. Same project; the spec rename is outstanding.

```bash
npm install
npm run verify     # prove every read against the live chain (31 checks)
npm run dev        # http://127.0.0.1:5175
npm run build
```

The read layer needs no wallet. Trade/stake/redeem need one on chain 4663.

## What is live vs. stubbed

| Area | Status | Source |
|---|---|---|
| Pool price, tick, liquidity | **live** | `StateView.getSlot0(poolId)` |
| PoolKey / poolId derivation | **live, verified** | matched against a real `Initialize` event |
| Bonding-curve buy/sell + quotes | **live** | `PonsV2Curve` (AGORA has not graduated) |
| Tax accrued in hook | **live** | `V2MemeHook.pendingCreatorTax(poolId, currency)` |
| Tax claimable in escrow | **live** | `V2FeeEscrow.balanceOf(feeSink)` |
| Cumulative tax history | **live** | `HookFeeCollected` log scan |
| Graduation state | **live** | `PonsToken.curve()` + pool init check |
| v4 swap path | **coded, dormant** | activates at graduation (4.2 ETH) |
| NAV, floor, corpus | **stubbed** | needs `Treasury` |
| Floor history / ratchet chart | **stubbed** | needs `Treasury.FloorUpdated` |
| Staking, redemption | **stubbed** | needs `stAGORA`, `Redeemer` |

Stubbed reads return `null` and render as **"not deployed"** — never `0`. On a page whose
entire purpose is verifiability, a fake zero is worse than an honest gap.

## Address wiring (`src/chain.ts`)

`AGORA.token` and `AGORA.curve` are live and verified. `AGORA.feeSink` and `AGORA.treasury`
both currently point at the **deployer EOA** `0x2Fb89C8…39d19`, which is already the on-chain
creator-fee recipient.

- As **`feeSink`** that is correct and functional — `V2FeeEscrow.balanceOf()` is a real read.
- As **`treasury`** it is a **placeholder**. An EOA implements none of `TREASURY_ABI`, so
  `readReserve()` clears the `deployed` guard but every inner read returns `null`: NAV, floor
  and corpus show `—` (unknown) rather than "not deployed". Swap in the real `Treasury`
  address when it ships.

`stakedAgora` and `redeemer` are still the zero address, so those pages honestly report
undeployed.

## Things that will bite you

**Use the public RPC, not Alchemy.** `rpc.mainnet.chain.robinhood.com` accepts ~450k-block
`eth_getLogs` spans. The Alchemy free tier caps them at **10 blocks**, which makes history
impossible. It also keeps a key out of the bundle — the Memebrokers key leaked exactly that way.

**Never resolve v4 addresses by name.** Chain 4663 hosts 34 contracts named `PoolManager`,
36 named `UniversalRouter`, and 14 named `PonsV2LaunchFactory`. Several clones point at *other
chains'* PoolManagers. The verified set is in `src/chain.ts`; the derivation is in spec §14.

**The hook emits `HookFeeCollected` for BOTH swap legs** — native ETH and the memecoin. Summing
across currencies adds ether to token units; it produced a nonsense ~8.8M "ETH" figure before
`readTaxHistory` grew a currency filter. Always filter. `readTaxByCurrency()` shows both legs.

**`poolFee` is 0.** The 4% tax and 1% fee are applied *dynamically by the hook*, so a price
derived from `sqrtPriceX96` is ~5% off before slippage. Always quote through `V4Quoter`
(`quoteExactInputSingle`, **`staticCall` only** — it is non-view by declaration), never spot price.

**The curve ABI was recovered from bytecode**, not from a verified source — no Blockscout
verification and no bytecode match against any verified `PonsV2Curve` template. Selectors were
scraped from PUSH4 immediates and resolved via openchain. `buy(quoteAmountIn, minTokensOut,
recipient)` param order was **pinned by simulation**; the other two orderings revert.

**`snipeTaxStartBps = 9900`** — a 99% tax for the first 3 seconds after any launch.

**Most Pons tokens are not graduated.** They sit on the bonding curve until 4.2 ETH, and
`getSlot0` correctly returns 0 for them. Handle both states.

## Known open items

- **No ETH/USD feed verified on 4663**, so `ETH_USD_FEED` is `null` and all figures are
  ETH-denominated. Inventing an address would silently produce wrong dollar values.
- **`sweepPoolFees` is gated on Pons's `feeSweepOperator`** — tax accrual into escrow is not
  something we can trigger. See spec §14.4.
- **`sweepFees` destination is unverified.** The public RPC exposes no trace API, so where the
  ETH actually lands has not been proven. Test with a small amount first.
- **Beefy on 4663 has ~$125k TVL, all two-asset LP, zero single-asset vaults** — the corpus
  outgrows the entire chain's yield capacity quickly. See spec §4.

## Layout

```
src/
  chain.ts       verified addresses, RPC, chain params, deployment flags
  abis.ts        minimal ABI fragments
  poolkey.ts     PoolKey build, poolId derivation, sqrtPriceX96 → price
  reads.ts       point reads; every one returns null instead of throwing
  history.ts     chunked backwards log scanner + floor-invariant checker
  curve.ts       Pons bonding curve: quotes, buy, sell, approvals
  swap.ts        Uniswap v4 UniversalRouter encoding + Permit2 (post-graduation)
  useReads.ts    polling snapshot hook; log scans fetched once, not polled
  eth.ts         minimal wallet hook (no wallet library)
  format.ts      significant-digit formatting for tiny ETH prices
  components.tsx glass panels, Stat that distinguishes 0 from unknown
  Floor.tsx      reserve / floor page
  Trade.tsx      buy + sell
  Stake.tsx      stAGORA vault (awaiting deployment)
  Redeem.tsx     burn-for-NAV (awaiting deployment)
scripts/
  verify-reads.mjs   standalone reimplementation — independently checks poolId math
```

## Deploy

Vercel project `ljiulguis-projects/tithe`:

```bash
npx vercel deploy --prod --yes
```

If `.vercel.app` URLs 302 to `vercel.com/sso-api`, deployment protection is on for *both*
preview and production. Disable with `npx vercel project protection disable --sso`.
