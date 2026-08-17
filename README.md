# AGORA

A 4% trade-tax token on **Robinhood Chain** (EVM Arbitrum Orbit L2, chainId **4663**) whose tax
funds a permanent endowment. Holders can burn AGORA to redeem pro-rata reserve value at a 5%
haircut, which gives the token a **ratcheting price floor**.

Live token: [`0x6853618673D952Fe602616F6f896cC7be8e25fCc`](https://robinhoodchain.blockscout.com/address/0x6853618673D952Fe602616F6f896cC7be8e25fCc)
· launched via Pons v2 · still on the bonding curve (graduates into a locked Uniswap v4 pool at 4.2 ETH).

## Repo

| Path | What |
|---|---|
| [`docs/design.md`](docs/design.md) | The design spec. **§14 (Appendix A) holds every verified on-chain address** — read it instead of re-deriving. |
| [`frontend/`](frontend/) | Vite + React + ethers v6 dashboard and trade UI. See its [README](frontend/README.md). |

Contracts (`Treasury`, `FeeSink`, `stAGORA`, `Redeemer`) are **specified but not written**. The
frontend already reads for them and renders "not deployed" until they exist.

## Start here

```bash
cd frontend
npm install
npm run verify   # 31 checks against live chain state — run this first
npm run dev
```

`npm run verify` is the fastest way to confirm the chain assumptions still hold. It is a
deliberately independent reimplementation of the read path, so it also cross-checks the
`poolId` derivation rather than trusting `src/poolkey.ts`.

## Two things that are easy to get wrong

**Chain 4663 is full of contract-name clones** — 34 `PoolManager`, 36 `UniversalRouter`, 14
`PonsV2LaunchFactory`, some pointing at other chains. Never resolve a v4 address by name search;
use the verified set in `frontend/src/chain.ts`.

**Quote through `V4Quoter`, never `sqrtPriceX96`.** The pool's static fee is 0 — the Pons hook
applies the 4% tax dynamically in `beforeSwap`, so spot price is ~5% wrong before slippage.

## Naming

The spec says **TITHE** throughout; that was the working name. The live token is **AGORA**.
Same project. Note that "AGORA" is also used by an unrelated equity-reserve design in the
author's notes — this repo is the tax-funded endowment token.
