import { Contract, Interface } from "ethers";
import {
  readProvider, BEEFY_VAULTS, WETH_ADDR, USDG_ADDR, WETH_USDG_POOL, ZERO, beefyUrl,
} from "./chain";
import { aggregate3Strict, multiRead, asStr, asBig } from "./multicall";

/**
 * Reads the Beefy positions the operator wallet holds.
 *
 * ## Why this exists
 *
 * `Treasury.withdraw()` moves corpus ETH to the operator wallet so it can be
 * deployed on beefy.com — the only route available until the on-chain adapter
 * is activated. That ETH leaves `nav()`, so the dashboard reported it as a bare
 * "withdrawn" total and nothing else, which read as though the money had gone.
 *
 * It has not gone. It is in these vaults, and every figure below is read from
 * the chain, so the deployed capital can be shown as the asset it is.
 *
 * ## How a position is valued
 *
 * A Beefy CLM vault is a share over a two-token Uniswap v3 position:
 *
 * ```
 * shares  = rewardPool.balanceOf(holder) + clm.balanceOf(holder)
 * (a0,a1) = clm.previewWithdraw(shares)      ← the vault's own accounting
 * value   = a0 + a1 priced into the other token via the pool's sqrtPriceX96
 * ```
 *
 * `previewWithdraw` is used rather than a hand-rolled `balances × shares /
 * supply` because it is the vault's own answer to "what would I get out", fees
 * and all.
 *
 * ## Pricing, and its one honest limitation
 *
 * Where a pair has a WETH leg the conversion is direct. Where it does not — the
 * tokenized-stock vaults are USDG-paired — the non-WETH legs are valued in USDG
 * and then converted through the WETH/USDG pool. That is two hops, so a wrong
 * price in either shows up here.
 *
 * Everything is **spot**, not TWAP. That is deliberate: this is a portfolio
 * readout for the operator, not an input to a redemption price. Nothing here
 * feeds `nav()` — the adapter does its own conservative `min(spot, TWAP)`
 * valuation for that, precisely because a manipulable number must not set a
 * redemption price. This one just needs to be honest about what is out there.
 */

const CLM_ABI = [
  "function previewWithdraw(uint256) view returns (uint256,uint256)",
  "function balances() view returns (uint256,uint256)",
  "function wants() view returns (address,address)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function strategy() view returns (address)",
  "function isCalm() view returns (bool)",
];
const RP_ABI = ["function balanceOf(address) view returns (uint256)"];
const STRAT_ABI = ["function pool() view returns (address)"];
/**
 * Only `sqrtPriceX96` is decoded, deliberately.
 *
 * Beefy runs two different pool implementations on this chain. The `uniswap-`
 * vaults sit on Uniswap v3, whose `slot0` returns seven fields. The `up33-`
 * vaults sit on `CLPool` (verified on Blockscout), whose `slot0` returns six —
 * no `feeProtocol`. Declaring the full v3 tuple fails to decode against CLPool
 * with a buffer overrun, which is why the up33 position first read as
 * "unpriced". `sqrtPriceX96` is the first word in both, and a shorter
 * declaration simply ignores the rest.
 */
const POOL_ABI = [
  "function slot0() view returns (uint160)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const Q96 = 2n ** 96n;

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** `amount0 × price`, price being token1 per token0, from sqrtPriceX96. */
function mulPrice(amount0: bigint, sqrtP: bigint): bigint {
  return ((amount0 * sqrtP) / Q96) * sqrtP / Q96;
}

/** `amount1 ÷ price`. */
function divPrice(amount1: bigint, sqrtP: bigint): bigint {
  if (sqrtP === 0n) return 0n;
  return ((amount1 * Q96) / sqrtP) * Q96 / sqrtP;
}


/**
 * A price for a token that has no WETH leg of its own.
 *
 * The `up33-cow-robinhood-up-stonkbroker` vault pairs two memecoins — neither
 * WETH nor USDG — so neither the direct nor the USDG route could value it, and
 * the position rendered as "unpriced" while holding most of the deployed
 * capital. The registry already knows where a WETH pair lives, so the route is
 * derived from it rather than hard-coded: find any vault that pairs the wanted
 * token with WETH, and read that pool's price.
 *
 * Four multicalls total, regardless of how many tokens need routing.
 */
type Route = { sqrt: bigint; wethIsToken0: boolean };

async function wethRoutes(needed: string[]): Promise<Map<string, Route>> {
  const out = new Map<string, Route>();
  if (!needed.length) return out;
  const want = new Set(needed.map((t) => t.toLowerCase()));

  const clms = BEEFY_VAULTS.map(([, , clm]) => clm);

  const pairs = await multiRead(
    clms.map((target) => ({ target, fragment: "function wants() view returns (address,address)" }))
  );

  // Pick one vault per wanted token whose other leg is WETH.
  const picked = new Map<string, number>();
  pairs.forEach((r, i) => {
    if (!r || r.length < 2) return;
    const a = String(r[0]).toLowerCase();
    const b = String(r[1]).toLowerCase();
    const w = WETH_ADDR.toLowerCase();
    const other = a === w ? b : b === w ? a : null;
    if (other && want.has(other) && !picked.has(other)) picked.set(other, i);
  });
  if (!picked.size) return out;

  const idx = [...picked.values()];
  const strats = await multiRead(
    idx.map((i) => ({ target: clms[i], fragment: "function strategy() view returns (address)" }))
  );
  const stratAddrs = strats.map(asStr);

  const pools = await multiRead(
    stratAddrs.map((a) => ({ target: a ?? ZERO, fragment: "function pool() view returns (address)" }))
  );
  const poolAddrs = pools.map(asStr);

  const [prices, token0s] = await Promise.all([
    multiRead(poolAddrs.map((a) => ({ target: a ?? ZERO, fragment: "function slot0() view returns (uint160)" }))),
    multiRead(poolAddrs.map((a) => ({ target: a ?? ZERO, fragment: "function token0() view returns (address)" }))),
  ]);

  [...picked.keys()].forEach((token, n) => {
    const sqrt = asBig(prices[n]);
    const t0 = asStr(token0s[n]);
    if (sqrt === null || sqrt === 0n || !t0) return;
    out.set(token, { sqrt, wethIsToken0: t0.toLowerCase() === WETH_ADDR.toLowerCase() });
  });

  return out;
}

/** Convert `amount` of `token` into wei using a derived route. */
function viaRoute(amount: bigint, token: string, routes: Map<string, Route>): bigint | null {
  const r = routes.get(token.toLowerCase());
  if (!r) return null;
  // wethIsToken0 → price is token/WETH, so token → WETH divides by it.
  return r.wethIsToken0 ? divPrice(amount, r.sqrt) : mulPrice(amount, r.sqrt);
}

export type BeefyPosition = {
  id: string;
  label: string;
  url: string;
  clm: string;
  rewardPool: string;
  /** CLM shares held, staked plus loose. */
  shares: bigint | null;
  /** This holder's slice of the whole vault, as a percentage. */
  sharePct: number | null;
  /** The two underlying amounts, in their own raw units. */
  amount0: bigint | null;
  amount1: bigint | null;
  symbol0: string | null;
  symbol1: string | null;
  decimals0: number | null;
  decimals1: number | null;
  /** Position value in wei. Null when it could not be priced. */
  valueWei: bigint | null;
  /** Total value of the whole vault, in wei — the capacity ceiling. */
  vaultValueWei: bigint | null;
  /** Beefy's own calm check, surfaced so a bad time to act is visible. */
  isCalm: boolean | null;
};

/** USDG per 1 WETH, in raw units, from the WETH/USDG pool. */
async function usdgPerWethSqrt(): Promise<bigint | null> {
  const pool = new Contract(WETH_USDG_POOL, POOL_ABI, readProvider);
  const [slot0, t0] = await Promise.all([
    safe(() => pool.slot0()),
    safe(() => pool.token0() as Promise<string>),
  ]);
  if (slot0 === null || !t0) return null;
  // Callers assume token0 = WETH. If Beefy ever redeploys the pool the other
  // way round, returning null is better than silently inverting the price.
  if (t0.toLowerCase() !== WETH_ADDR.toLowerCase()) return null;
  // A single unnamed return decodes to the value itself in ethers v6, not to a
  // one-element Result — indexing it yields undefined and BigInt() throws.
  return BigInt(slot0 as unknown as bigint);
}

async function readOne(
  v: (typeof BEEFY_VAULTS)[number],
  holder: string,
  usdgSqrt: bigint | null,
  routes: Map<string, Route>,
  knownShares?: { staked: bigint; loose: bigint }
): Promise<BeefyPosition> {
  const [vid, vlabel, vclm, vrp] = v;
  const base: BeefyPosition = {
    id: vid, label: vlabel, url: beefyUrl(vid), clm: vclm, rewardPool: vrp,
    shares: null, sharePct: null, amount0: null, amount1: null,
    symbol0: null, symbol1: null, decimals0: null, decimals1: null,
    valueWei: null, vaultValueWei: null, isCalm: null,
  };

  const clm = new Contract(vclm, CLM_ABI, readProvider);
  const rp = new Contract(vrp, RP_ABI, readProvider);

  const [staked, loose, supply, wants, strat, calm] = await Promise.all([
    knownShares ? Promise.resolve(knownShares.staked) : safe(async () => BigInt(await rp.balanceOf(holder))),
    knownShares ? Promise.resolve(knownShares.loose) : safe(async () => BigInt(await clm.balanceOf(holder))),
    safe(async () => BigInt(await clm.totalSupply())),
    safe(() => clm.wants() as Promise<[string, string]>),
    safe(() => clm.strategy() as Promise<string>),
    safe(() => clm.isCalm() as Promise<boolean>),
  ]);

  const shares = (staked ?? 0n) + (loose ?? 0n);
  base.shares = staked === null && loose === null ? null : shares;
  base.isCalm = calm;
  if (supply && supply > 0n && base.shares !== null) {
    base.sharePct = Number((base.shares * 1_000_000n) / supply) / 10_000;
  }

  if (!wants || !strat) return base;
  const [t0, t1] = wants;

  const [d0, d1, s0, s1] = await Promise.all([
    safe(async () => Number(await new Contract(t0, ERC20_ABI, readProvider).decimals())),
    safe(async () => Number(await new Contract(t1, ERC20_ABI, readProvider).decimals())),
    safe(() => new Contract(t0, ERC20_ABI, readProvider).symbol() as Promise<string>),
    safe(() => new Contract(t1, ERC20_ABI, readProvider).symbol() as Promise<string>),
  ]);
  base.decimals0 = d0; base.decimals1 = d1; base.symbol0 = s0; base.symbol1 = s1;

  const poolAddr = await safe(
    () => new Contract(strat, STRAT_ABI, readProvider).pool() as Promise<string>
  );
  if (!poolAddr) return base;

  const pool = new Contract(poolAddr, POOL_ABI, readProvider);
  const [slot0, preview, vaultBal] = await Promise.all([
    safe(() => pool.slot0()),
    shares > 0n ? safe(() => clm.previewWithdraw(shares) as Promise<[bigint, bigint]>) : Promise.resolve(null),
    safe(() => clm.balances() as Promise<[bigint, bigint]>),
  ]);
  if (slot0 === null) return base;
  const sqrtP = BigInt(slot0 as unknown as bigint);

  if (preview) {
    base.amount0 = BigInt(preview[0]);
    base.amount1 = BigInt(preview[1]);
  }

  /** Value a raw (a0, a1) pair in wei, given this pool's orientation. */
  const valueIn = (a0: bigint, a1: bigint): bigint | null => {
    const isWeth0 = t0.toLowerCase() === WETH_ADDR.toLowerCase();
    const isWeth1 = t1.toLowerCase() === WETH_ADDR.toLowerCase();

    // Direct: one leg is already WETH, so convert the other across this pool.
    if (isWeth0) return a0 + divPrice(a1, sqrtP);
    if (isWeth1) return a1 + mulPrice(a0, sqrtP);

    // No WETH leg. The USDG-paired stock vaults go through WETH/USDG.
    const isUsdg0 = t0.toLowerCase() === USDG_ADDR.toLowerCase();
    const isUsdg1 = t1.toLowerCase() === USDG_ADDR.toLowerCase();
    if (isUsdg0 || isUsdg1) {
      if (usdgSqrt === null) return null;
      const usdg = isUsdg0 ? a0 + divPrice(a1, sqrtP) : a1 + mulPrice(a0, sqrtP);
      // WETH/USDG has token0 = WETH, so USDG → WETH divides by that price.
      return divPrice(usdg, usdgSqrt);
    }

    // Neither leg is WETH or USDG — a memecoin/memecoin pair. Price each leg
    // through whichever registry vault pairs it with WETH.
    // Express the whole position in whichever leg has a WETH route, using this
    // pool's own price for the internal conversion, then take the single hop
    // out to WETH. Exact, and it needs only one of the two legs to be routable.
    if (routes.has(t0.toLowerCase())) return viaRoute(a0 + divPrice(a1, sqrtP), t0, routes);
    if (routes.has(t1.toLowerCase())) return viaRoute(a1 + mulPrice(a0, sqrtP), t1, routes);
    return null;
  };

  if (base.amount0 !== null && base.amount1 !== null) {
    base.valueWei = valueIn(base.amount0, base.amount1);
  } else if (shares === 0n) {
    base.valueWei = 0n;
  }
  if (vaultBal) base.vaultValueWei = valueIn(BigInt(vaultBal[0]), BigInt(vaultBal[1]));

  return base;
}

/**
 * Only the vaults the holder is actually in. An exited vault is dropped rather
 * than shown at zero: with 33 in the registry, listing every empty one buries
 * the two that matter.
 */
export async function readBeefyPositions(holder: string): Promise<BeefyPosition[]> {
  if (!holder || holder === ZERO) return [];

  // Two passes. The first sweeps the whole registry for a balance; only the
  // vaults that come back non-zero get the expensive second pass.
  //
  // That first sweep is 66 reads, and issuing them as parallel eth_calls earns
  // an HTTP 429 from the public endpoint — it rate-limits the JSON-RPC batch as
  // a batch. Multicall3 turns all 66 into a single eth_call, which it serves
  // without complaint.
  const iface = new Interface(["function balanceOf(address) view returns (uint256)"]);
  const callData = iface.encodeFunctionData("balanceOf", [holder]);

  const targets: string[] = [];
  for (const [, , clmAddr, rpAddr] of BEEFY_VAULTS) targets.push(rpAddr, clmAddr);

  // Strict: a failed sweep must not decode to 33 zero balances and be
  // reported as "no positions". Let it throw and surface as an error.
  const raw = await aggregate3Strict(targets.map((target) => ({ target, callData })));
  const num = (r: string | null): bigint => {
    if (r === null) return 0n;
    try {
      return BigInt(iface.decodeFunctionResult("balanceOf", r)[0]);
    } catch {
      return 0n;
    }
  };

  const held = BEEFY_VAULTS
    .map((v, i) => ({ v, bal: { staked: num(raw[i * 2]), loose: num(raw[i * 2 + 1]) } }))
    .filter(({ bal }) => bal.staked + bal.loose > 0n);

  if (!held.length) return [];

  // Which held pairs have neither a WETH nor a USDG leg? Those need a route.
  const pairInfo = await multiRead(
    held.map(({ v }) => ({ target: v[2], fragment: "function wants() view returns (address,address)" }))
  );
  const w = WETH_ADDR.toLowerCase();
  const u = USDG_ADDR.toLowerCase();
  const needRoute: string[] = [];
  pairInfo.forEach((r) => {
    if (!r || r.length < 2) return;
    const a = String(r[0]).toLowerCase();
    const b = String(r[1]).toLowerCase();
    if (a === w || b === w || a === u || b === u) return;
    needRoute.push(a, b);
  });

  const [usdgSqrt, routes] = await Promise.all([
    usdgPerWethSqrt(),
    wethRoutes(needRoute),
  ]);
  return Promise.all(held.map(({ v, bal }) => readOne(v, holder, usdgSqrt, routes, bal)));
}

/** Total deployed value across every vault, in wei. Null if nothing priced. */
export function totalDeployedWei(ps: BeefyPosition[]): bigint | null {
  const priced = ps.filter((p) => p.valueWei !== null);
  if (!priced.length) return null;
  return priced.reduce((acc, p) => acc + (p.valueWei ?? 0n), 0n);
}

/**
 * How much of the position list the total actually covers.
 *
 * `totalDeployedWei` returns null for two different facts — "there are no
 * positions" and "there are positions but none of them could be priced" — and
 * a caller that collapses both to `0` publishes the second one as a
 * measurement. It is not: the positions are visibly there, and saying they are
 * worth nothing is worse than saying nothing.
 *
 * Pricing is the fragile half of this read. Discovery is one multicall, but
 * valuation walks each vault's strategy to its pool, and a single slow response
 * anywhere in that chain drops a position to unpriced. So partial coverage is
 * normal and has to be sayable.
 */
export function pricedCoverage(ps: BeefyPosition[]): { priced: number; total: number } {
  return { priced: ps.filter((p) => p.valueWei !== null).length, total: ps.length };
}

export type OperatorHoldings = {
  eth: bigint | null;
  agora: bigint | null;
  /** AGORA valued at the live pool price, in wei. */
  agoraWei: bigint | null;
  /** stAGORA shares, raw — 21 decimals, not 18. See `ST_AGORA_DECIMALS`. */
  stAgora: bigint | null;
  /** Those shares expressed in AGORA (18dp), by the vault's own accounting. */
  stAgoraAssets: bigint | null;
  /** And that, valued at the pool price, in wei. */
  stAgoraWei: bigint | null;
};

/**
 * What the operator wallet itself holds.
 *
 * Beefy is only one of the places withdrawn ETH can be. Reconciling
 * `cumulativeWithdrawn` against Beefy alone leaves an unexplained hole — at the
 * time of writing 1.367 ETH withdrawn against 0.0013 ETH in vaults — which
 * invites exactly the wrong conclusion. Most of it is plainly visible as ETH
 * and AGORA sitting in the wallet; showing that turns an alarming gap into an
 * ordinary treasury position.
 *
 * `priceWad` is the AGORA/ETH price the caller already has, passed in rather
 * than re-read.
 */
export async function readOperatorHoldings(
  holder: string,
  agoraToken: string,
  stAgoraVault: string,
  priceWad: bigint | null
): Promise<OperatorHoldings> {
  const empty = {
    eth: null, agora: null, agoraWei: null,
    stAgora: null, stAgoraAssets: null, stAgoraWei: null,
  };
  if (!holder || holder === ZERO) return empty;

  const bal = "function balanceOf(address) view returns (uint256)";

  const [eth, tokens] = await Promise.all([
    safe(async () => BigInt(await readProvider.getBalance(holder))),
    multiRead([
      { target: agoraToken, fragment: bal, args: [holder] },
      { target: stAgoraVault, fragment: bal, args: [holder] },
    ]),
  ]);

  const agora = asBig(tokens[0]);
  const stAgora = asBig(tokens[1]);

  /**
   * Shares are NOT interchangeable with assets at the raw-integer level.
   *
   * They track one-to-one in *whole* units — rewards are ETH and stay outside
   * `totalAssets()`, so the share price never moves — but stAGORA carries a
   * decimals offset of 3, which makes a raw share number a thousand times
   * larger than the AGORA it represents. Pricing the raw number, as this used
   * to, inflated the operator's reported holdings 1000× and fed that straight
   * into the "visible holdings account for N%" reconciliation.
   *
   * `convertToAssets` is the vault's own answer, so this stays correct even if
   * the offset or the share price ever changes.
   */
  const stAgoraAssets =
    stAgora === null || stAgora === 0n
      ? stAgora
      : asBig(
          (
            await multiRead([
              {
                target: stAgoraVault,
                fragment: "function convertToAssets(uint256) view returns (uint256)",
                args: [stAgora],
              },
            ])
          )[0]
        );

  const wei = (v: bigint | null) =>
    v !== null && priceWad !== null ? (v * priceWad) / 10n ** 18n : null;

  return {
    eth,
    agora,
    agoraWei: wei(agora),
    stAgora,
    stAgoraAssets,
    stAgoraWei: wei(stAgoraAssets),
  };
}
