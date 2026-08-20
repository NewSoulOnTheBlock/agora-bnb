# TORII keeper

Cranks the protocol's **permissionless** maintenance calls. Holds no privileged key.

```bash
cd keeper
npm install
cp .env.example .env      # fill in a fresh key, funded with gas only
npm run once              # single pass, dry run — sends nothing
npm start                 # loop, still dry
npm run live              # loop, KEEPER_EXECUTE=1, actually sends
```

---

## What it does

Three jobs, in this order, every `KEEPER_INTERVAL` seconds:

| Job | Call | Moves |
|---|---|---|
| `collect tax` | `FeeSink.collect()` | Pons escrow + bonding curve → Treasury |
| `distribute` | `Treasury.distributeIncome()` | earmarked income → 90% stTORII / 10% staked Suits |
| `realize surplus` | `Treasury.realizeSurplus(adapter)` | sleeve yield → earmarked income |

The order is deliberate: collecting can create income to distribute in the same
pass, and realizing surplus creates income for the next one.

## Why it needs no privileged key

**Every call above is permissionless.** Anyone can make them — they exist that
way on purpose, because none of them chooses a venue or moves principal out of
the protocol. They only push value *along* a path the contracts already fixed.

So the keeper's key pays gas and nothing else. If it leaks, the attacker's best
move is to call the same functions the keeper was going to call.

> **Do not reuse the Treasury owner key here.** That key can `withdraw()` the
> corpus, set the redeemer and set the operator. It has no business on a machine
> running unattended. Generate a fresh one (`cast wallet new`) and fund it with
> gas only.

## What it deliberately does not do

It does not allocate capital. `depositToAdapter`, `withdrawFromAdapter`,
`setSleeveBps` and `withdraw` are owner-only and stay that way — putting corpus
ETH into a yield venue is a decision, not a cron job. Automating *that* is a
separate design with real tradeoffs, laid out in
[`BEEFY-README.md`](../BEEFY-README.md#4-do-not-automate-the-deposit-step-yet).

## The three guards

Every job answers three questions and stops at the first "no":

1. **Is there anything to do?** A view read. Costs nothing.
2. **Does it simulate?** `staticCall` against live state. This is what stops the
   keeper broadcasting a transaction that was always going to revert —
   `distributeIncome()` reverts when neither staking side has stakers, and that
   is a normal state, not an error.
3. **Is it worth the gas?** The value moved must clear `KEEPER_MIN_RATIO` times
   the estimated cost. Without this the keeper happily burns 0.0002 ETH of gas
   to sweep 0.0001 ETH of tax, which is a net loss to the corpus it is meant to
   be filling.

Only then does it send, and only with `KEEPER_EXECUTE=1`.

**Dry run is the default.** Same idiom as `scripts/launch.ts` in `contracts/` —
nothing is broadcast until you say so explicitly.

## Measured, on a live pass

```
14:18:50  collect tax      would   moves 0.165126 ETH · gas ~0.0000061 ETH
14:18:50  distribute       skip    no income earmarked
14:18:50  realize surplus  skip    no adapters — sleeve is not deployed
```

Collecting 0.165 ETH of tax cost an estimated **0.0000061 ETH** of gas — roughly
27,000× the outlay. That figure is the argument for running this at all: at the
time of writing there was **0.16 ETH of tax sitting uncollected**, backing
nothing and paying nobody, because `collect()` only runs when somebody calls it.

## What it cannot fix

The first step of the Pons fee path, `sweepPoolFees`, is gated on **Pons's own**
`feeSweepOperator`. Tax can sit in `pendingCreatorTax` where nobody but Pons can
move it. `FeeSink.collectable()` reports that bucket separately, so the log
distinguishes "nothing to collect" from "plenty to collect, and not ours to
trigger".

`realize surplus` is dormant until an adapter is activated — `sleeveBps` is 0
and `adapters()` is empty today. It costs one view call per pass and is written
now so the keeper needs no changes on the day the sleeve goes live.

## Running it for real

Any process supervisor will do. It is a single Node process with no state:

```bash
# systemd, pm2, a container, or just tmux
KEEPER_EXECUTE=1 npm start
```

A job that throws is logged and the loop continues. A keeper that dies on a
transient RPC error is worse than no keeper, because the tax quietly stops
reaching the corpus and nothing announces it.

## Layout

```
src/
  config.ts        env, addresses, provider, the no-privilege note
  task.ts          the Job shape, simulate/price/log guards
  tasks/
    collect.ts     FeeSink.collect()
    distribute.ts  Treasury.distributeIncome()
    realize.ts     Treasury.realizeSurplus(adapter)
  run.ts           the loop
```
